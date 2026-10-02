import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../server/db.js';
import { reconcile } from '../server/payroll.js';
import request from './request.js';
import { IDS, SEASON } from './fixture.js';

/**
 * Three payroll figures that did not agree on one page.
 *
 * The Dodgers' save showed Payroll now at $329.4M, a committed total for this
 * season of $368.8M in the chart beneath it, and nothing to say where the other
 * $39.4M had come from. $32.7M of it is money still owed to two players who
 * have left; the remaining $6.68M was a number with no name until it came out
 * as ten players, each of them $668,000.
 *
 * Those ten are in the minors on major-league minimum contracts, and OOTP's
 * payroll charges such a man at the minor-league wage, which is 16.5 per cent
 * of the minimum, instead of at the $800,000 on the deal. The same arithmetic
 * comes out to the dollar on 59 of the 92 clubs in three saves (2015, 2028 and
 * 2029), and to a whole number of such players on 90 of them.
 *
 * The server now works the line out and the page prints it. Nothing here
 * checks a figure against OOTP; it checks that what is printed adds up to what
 * the chart says, and that each term is the thing it claims to be.
 */

/** Ours, playing in the minors on the league minimum: OOTP charges these less. */
const FARM_MIN_A = 9970;
const FARM_MIN_B = 9971;
/** Ours, gone elsewhere, and we kept a fifth of him: money owed, not a contract held. */
const WE_KEPT_A_SHARE = 9972;
/** On our roster, his old club keeping a quarter: three quarters of him is ours to pay. */
const WE_PAY_THREE_QUARTERS = 9973;

const MINIMUM = (db.prepare(`SELECT rules_minimum_salary AS m FROM leagues`).get() as { m: number }).m;

/*
 * What OOTP would say this club's payroll is. Everything in the committed total
 * except the money owed to men who left ($7,000,000: the fixture's released
 * player and a fifth of the one we kept a share of) and the part of the two
 * minimum-salary men that it does not charge: 83.5 per cent of $1,400,000.
 */
const OOTP_PAYROLL = 54_131_000;

beforeAll(() => {
  const player = db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Pat', ?, 24, 7, 0, 1, 1, ?, ?, ?, 0, 0, 0, 0)`
  );
  const deal = db.prepare(
    `INSERT INTO players_contract
       (player_id, team_id, contract_team_id, season_year, years, current_year, is_major,
        retained, salary0, salary1, salary2)
     VALUES (?, ?, ?, ?, 1, 0, 1, ?, ?, 0, 0)`
  );

  // Two men in the minors on a major-league contract at the league minimum
  player.run(FARM_MIN_A, 'Farmer', 70, IDS.aaaTeam, IDS.mlbTeam);
  deal.run(FARM_MIN_A, IDS.aaaTeam, IDS.mlbTeam, SEASON, 0, MINIMUM);
  player.run(FARM_MIN_B, 'Plower', 71, IDS.aaaTeam, IDS.mlbTeam);
  deal.run(FARM_MIN_B, IDS.aaaTeam, IDS.mlbTeam, SEASON, 0, MINIMUM);

  // Ours by contract, playing elsewhere; we kept twenty per cent of $10M
  player.run(WE_KEPT_A_SHARE, 'Kept', 72, IDS.otherMlbTeam, IDS.otherMlbTeam);
  deal.run(WE_KEPT_A_SHARE, IDS.otherMlbTeam, IDS.mlbTeam, SEASON, 20, 10_000_000);

  // On our roster with the other club keeping a quarter of $4M
  player.run(WE_PAY_THREE_QUARTERS, 'Shared', 73, IDS.mlbTeam, IDS.mlbTeam);
  deal.run(WE_PAY_THREE_QUARTERS, IDS.mlbTeam, IDS.otherMlbTeam, SEASON, 25, 4_000_000);

  db.prepare(`UPDATE team_financials SET player_payroll = ? WHERE team_id = ?`)
    .run(OOTP_PAYROLL, IDS.mlbTeam);
});

interface Term { key: string; amount: number; players?: number; salary?: number }
interface Payroll {
  finances: { payroll: number } | null;
  reconciliation: { year: number; committed: number; terms: Term[] } | null;
  commitments: Array<{ total: number }>;
  deadMoney: { total: number; players: Array<{ name: string }> };
  players: Array<{
    name: string; byYear: Array<number | null>; deadMoney: boolean; inMinors: boolean; atMinimum: boolean;
  }>;
}

const payroll = (id: number = IDS.mlbTeam): Promise<Payroll> => request(`/api/payroll/${id}`);

describe('the line under the payroll cards', () => {
  it('adds up to the committed total in the chart', async () => {
    const { reconciliation, commitments, players } = await payroll();
    expect(reconciliation, 'no reconciliation came back').not.toBeNull();
    const r = reconciliation!;

    expect(r.terms.reduce((sum, t) => sum + t.amount, 0)).toBe(r.committed);
    expect(r.year).toBe(SEASON);
    // The same figure as the first row of the chart, which is itself the sum of
    // the contracts listed below it. Retained shares are inside it already
    expect(r.committed).toBe(commitments[0].total);
    expect(commitments[0].total).toBe(players.reduce((sum, p) => sum + (p.byYear[0] ?? 0), 0));
  });

  it('starts from the figure OOTP gives', async () => {
    const { reconciliation, finances } = await payroll();
    const first = reconciliation!.terms[0];
    expect(first.key).toBe('payroll');
    expect(first.amount).toBe(OOTP_PAYROLL);
    expect(first.amount).toBe(finances!.payroll);
  });

  it('names the money owed to men who have gone, retained shares included', async () => {
    const { reconciliation, deadMoney } = await payroll();
    const dead = reconciliation!.terms.find((t) => t.key === 'deadMoney');
    // The released man's $5M and a fifth of the other's $10M
    expect(dead?.amount).toBe(7_000_000);
    expect(dead?.players).toBe(2);
    expect(dead?.amount).toBe(deadMoney.total);
  });

  it('puts the rest on the minimum-salary players in the minors', async () => {
    const { reconciliation } = await payroll();
    const minors = reconciliation!.terms.find((t) => t.key === 'minors');
    // They cost $1.4M here; OOTP charges 16.5 per cent of that, so the rest of it is the gap
    expect(minors?.salary).toBe(2 * MINIMUM);
    expect(minors?.players).toBe(2);
    expect(minors?.amount).toBe(1_169_000);
  });

  it('has no term of its own for a share that somebody else is paying', async () => {
    const { reconciliation, players } = await payroll();
    // He is in the committed total at three quarters of his deal ...
    expect(players.find((p) => p.name === 'Pat Shared')?.byYear[0]).toBe(3_000_000);
    // ... and that is all there is to say about him
    expect(reconciliation!.terms.map((t) => t.key)).toEqual(['payroll', 'deadMoney', 'minors']);
  });

  it('counts only a man who is in the minors AND on the minimum', async () => {
    const { players } = await payroll();
    const by = (name: string) => players.find((p) => p.name === name)!;

    expect(by('Pat Farmer')).toMatchObject({ inMinors: true, atMinimum: true });
    // In the minors, but on more than the minimum
    expect(by('Op Tioned')).toMatchObject({ inMinors: true, atMinimum: false });
    // On the minimum, but with the major-league club
    expect(by('No Spot')).toMatchObject({ inMinors: false, atMinimum: false });
    // A man who has left is nobody's farmhand
    expect(by('Paid Off')).toMatchObject({ inMinors: false, atMinimum: false });
  });

  it('is left out when OOTP gave this club no payroll figure', async () => {
    // The fixture has finances for one club only
    expect((await payroll(IDS.otherMlbTeam)).reconciliation).toBeNull();
  });
});

describe('the line when the figures do not tell the whole story', () => {
  const noDead = { total: 0, players: 0 };
  const noMinors = { players: 0, salary: 0 };
  const line = (over: Partial<Parameters<typeof reconcile>[0]>) =>
    reconcile({
      year: 2030, committed: 100, payroll: 100, deadMoney: noDead, minors: noMinors, ...over,
    });

  it('has nothing to start from without a payroll figure', () => {
    expect(line({ payroll: null })).toBeNull();
    expect(line({ payroll: undefined })).toBeNull();
    expect(line({ payroll: 0 })).toBeNull();
    expect(line({ payroll: Number.NaN })).toBeNull();
  });

  it('is the payroll alone when the two agree', () => {
    expect(line({})?.terms).toEqual([{ key: 'payroll', amount: 100 }]);
  });

  it('calls a remainder nobody can account for what it is', () => {
    const r = line({ committed: 130 });
    expect(r?.terms).toEqual([{ key: 'payroll', amount: 100 }, { key: 'other', amount: 30 }]);
  });

  it('does not blame the minors for more than those players cost', () => {
    // Fifty cannot be the difference on a pair of men who cost forty between them
    const r = line({ committed: 150, minors: { players: 2, salary: 40 } });
    expect(r?.terms.map((t) => t.key)).toEqual(['payroll', 'other']);
  });

  it('blames them when they can account for it', () => {
    const r = line({ committed: 130, minors: { players: 2, salary: 40 } });
    expect(r?.terms[1]).toEqual({ key: 'minors', amount: 30, players: 2, salary: 40 });
  });

  it('still adds up when OOTP says more than the contracts do', () => {
    // A negative remainder is never put on the minors, whoever is down there
    const r = line({ committed: 90, minors: { players: 2, salary: 40 } });
    expect(r?.terms).toEqual([{ key: 'payroll', amount: 100 }, { key: 'other', amount: -10 }]);
    expect(r!.terms.reduce((sum, t) => sum + t.amount, 0)).toBe(r!.committed);
  });

  it('adds up to the dollar when OOTP gives a fractional payroll', () => {
    const r = line({ committed: 1_000_000, payroll: 999_999.6, deadMoney: { total: 5, players: 1 } });
    expect(r!.terms.reduce((sum, t) => sum + t.amount, 0)).toBe(1_000_000);
  });
});
