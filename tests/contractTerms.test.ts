import { describe, expect, it, beforeAll } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { db } from '../server/db.js';
import {
  byUrgency, computeContracts, controlAfterThisSeason, decisionDeadline, suggestTerms, urgencyTier,
  type Control, type RecentDeal,
} from '../server/contracts.js';
import { ContractsView } from '../src/pages/Contracts.js';
import type { ContractsResponse } from '../src/api.js';
import request from './request.js';
import { IDS, SEASON } from './fixture.js';

/**
 * Contract advice that stops at a verb.
 *
 * "No suggested years or dollars, no deadline, no ordering beyond salary, many
 * blank cells. The payroll page already knows the headroom by season; put the
 * two together."
 *
 * "Extend now" is the start of a negotiation and the page left the whole of it
 * to the reader: for how long, for how much, by when, and whether there is room.
 * The league has signed hundreds of deals in the last three seasons and a save
 * carries every one, so the answer to the first two is what men like him were
 * actually given. The third is a fact about his service time, which the file
 * already works out. And the list ran by years left and then salary, so the five
 * men whose deals end were in pay order and not in order of whom the club could
 * least afford to lose.
 */

/** A deal somebody signed lately; everything but the figures is the ordinary case. */
const deal = (over: Partial<RecentDeal> = {}): RecentDeal => ({
  playerId: 1, age: 25, pool: 'pos', pct: 95, years: 6, aav: 20_000_000, startYear: 2029, ...over,
});
const YOUNG = { playerId: 999, age: 24, pct: 96, pool: 'pos' as const };
const M = 1_000_000;

describe('suggested terms, from what players like him were given', () => {
  // Five deals in the window, none of them the subject's own
  const five = [
    deal({ playerId: 1, years: 8, aav: 26 * M }),
    deal({ playerId: 2, years: 5, aav: 20 * M }),
    deal({ playerId: 3, years: 7, aav: 30 * M }),
    deal({ playerId: 4, years: 5, aav: 18 * M }),
    deal({ playerId: 5, years: 6, aav: 24 * M }),
  ];

  it('takes the median of the years and of the dollars', () => {
    const t = suggestTerms(five, YOUNG);
    // 5, 5, 6, 7, 8 and 18, 20, 24, 26, 30: a mean would say 6.2 and $23.6M
    expect(t.years).toBe(6);
    expect(t.aav).toBe(24 * M);
    expect(t.comparables).toBe(5);
  });

  it('is not led off by one enormous deal', () => {
    const t = suggestTerms([...five, deal({ playerId: 6, years: 14, aav: 70 * M })], YOUNG);
    // Six deals now: the middle two are 6 and 7 years, $24M and $26M
    expect(t.years).toBe(7);
    expect(t.aav).toBe(25 * M);
  });

  it('rounds to the nearest hundred thousand, since nobody offers the median of dollars', () => {
    const odd = [20_040_000, 20_120_000, 20_260_000].map((aav, i) => deal({ playerId: 10 + i, aav }));
    expect(suggestTerms(odd, YOUNG).aav).toBe(20_100_000);
  });

  it('says there are no comparables rather than guessing, under three', () => {
    for (const n of [0, 1, 2]) {
      const t = suggestTerms(five.slice(0, n), YOUNG);
      expect(t.years, `${n} deals`).toBeNull();
      expect(t.aav, `${n} deals`).toBeNull();
      expect(t.comparables).toBe(n);
      expect(t.basis).toContain('fewer than three');
    }
    // Three is enough
    expect(suggestTerms(five.slice(0, 3), YOUNG).years).not.toBeNull();
  });

  it('counts only deals within 10 percentile points and 3 years of age', () => {
    const edge = [
      deal({ playerId: 1, pct: 86, age: 21 }), // both exactly at the edge: in
      deal({ playerId: 2, pct: 100, age: 27 }), // in
      deal({ playerId: 3, pct: 96, age: 24 }), // in
      deal({ playerId: 4, pct: 85, age: 24 }), // 11 points off: out
      deal({ playerId: 5, pct: 96, age: 28 }), // 4 years off: out
      deal({ playerId: 6, pct: 96, age: 20 }), // 4 years off: out
    ];
    expect(suggestTerms(edge, YOUNG).comparables).toBe(3);
  });

  it('compares like with like: a reliever is not priced off shortstops', () => {
    // Munoz, a reliever, was priced at five years and $15.8M against every pool at once
    // and is three years and $10.9M against relievers
    const pools = [
      ...five.map((d, i) => ({ ...d, playerId: 20 + i, pool: 'rp' as const, years: 3, aav: 11 * M })),
      ...five.map((d, i) => ({ ...d, playerId: 30 + i, pool: 'pos' as const, years: 8, aav: 28 * M })),
    ];
    const t = suggestTerms(pools, { ...YOUNG, pool: 'rp' });
    expect(t.years).toBe(3);
    expect(t.aav).toBe(11 * M);
    expect(t.comparables).toBe(5);
  });

  it('never prices a man off his own deal', () => {
    const t = suggestTerms([...five.slice(0, 2), deal({ playerId: YOUNG.playerId, years: 10, aav: 90 * M })], YOUNG);
    expect(t.comparables).toBe(2);
    expect(t.years).toBeNull();
  });

  it('has nothing to compare for a man with no value figure', () => {
    const t = suggestTerms(five, { ...YOUNG, pct: null });
    expect(t).toMatchObject({ years: null, aav: null, comparables: 0 });
  });

  it('can be held to a few years where the advice is to keep it short', () => {
    // The comparables would say 6 years; "re-sign short-term" cannot
    const t = suggestTerms(five, YOUNG, 2);
    expect(t.years).toBe(2);
    expect(t.aav).toBe(24 * M);
    expect(t.basis).toContain('years held to 2');
  });

  it('says who the comparables were', () => {
    const t = suggestTerms(five, YOUNG);
    expect(t.basis).toBe(
      'median of 5 deals of two years or more that began in 2029, for position players at the 86th-100th percentile, aged 21-27'
    );
  });
});

const RULES = { faMinYears: 6, arbMinYears: 3, hasFreeAgency: true, hasArbitration: true };
const when = (over: Partial<Parameters<typeof decisionDeadline>[0]> = {}) =>
  decisionDeadline({
    season: 2028, yearsAfterThis: 0, hasExtension: false, projectedService: 6.2, rules: RULES, ...over,
  });

describe('the deadline', () => {
  it('is free agency, after this season, for a man whose deal ends and who has the service', () => {
    expect(when()).toEqual({
      kind: 'free-agency',
      afterSeason: 2028,
      label: 'Before free agency, after the 2028 season',
    });
  });

  it('is the arbitration filing for a man who has not got there', () => {
    expect(when({ projectedService: 4.4 })).toEqual({
      kind: 'arbitration',
      afterSeason: 2028,
      label: 'Before the arbitration filing, after the 2028 season',
    });
  });

  it('is the first winter he qualifies for arbitration, when he is not there yet', () => {
    // 1.5 years of service at the end of this season: 2.5 at the end of the next, 3.5 the one after
    expect(when({ projectedService: 1.5 })).toMatchObject({ kind: 'arbitration', afterSeason: 2030 });
    // Exactly three at the end of next season is enough
    expect(when({ projectedService: 2 })).toMatchObject({ kind: 'arbitration', afterSeason: 2029 });
  });

  it('is when the deal ends, for a man signed beyond this year', () => {
    // Two years left and 4.3 of service now: 6.3 when it runs out, so free agency after 2030
    expect(when({ yearsAfterThis: 2, projectedService: 4.3 })).toMatchObject({
      kind: 'free-agency', afterSeason: 2030,
    });
    // Two years left and 1.0 now: 3.0 when it runs out, which is arbitration
    expect(when({ yearsAfterThis: 2, projectedService: 1 })).toMatchObject({
      kind: 'arbitration', afterSeason: 2030,
    });
  });

  it('is none for a man already extended', () => {
    expect(when({ hasExtension: true, yearsAfterThis: 4 })).toEqual({
      kind: 'none', afterSeason: null, label: 'none',
    });
  });

  it('is none where the league has no free agency', () => {
    expect(when({ rules: { ...RULES, hasFreeAgency: false, faMinYears: 0 } }).kind).toBe('none');
  });

  it('goes to free agency, not arbitration, in a league that has none', () => {
    const noArb = { ...RULES, hasArbitration: false };
    expect(when({ rules: noArb, projectedService: 4.4 })).toMatchObject({ kind: 'free-agency', afterSeason: 2030 });
  });

  it('agrees with controlAfterThisSeason about who is leaving this winter', () => {
    // The two answer the same question in two ways, and the page shows both
    for (let service = 0; service <= 9; service += 0.25) {
      const control = controlAfterThisSeason({
        yearsAfterThis: 0, hasExtension: false, serviceDays: null, serviceYears: service, serviceLeft: 0, rules: RULES,
      });
      const d = when({ projectedService: service });
      expect(d.kind === 'free-agency' && d.afterSeason === 2028, `${service} years`).toBe(control.status === 'leaving');
      expect(d.kind === 'arbitration' && d.afterSeason === 2028, `${service} years`).toBe(control.status === 'arbitration');
    }
  });
});

describe('the order', () => {
  const control = (status: Control['status']): Control => ({ status, arbYear: status === 'arbitration' ? 1 : null });

  it('puts a man who can leave first, then arbitration, then a call to make, then the rest', () => {
    expect(urgencyTier(control('leaving'), true)).toBe(1);
    expect(urgencyTier(control('arbitration'), true)).toBe(2);
    expect(urgencyTier(control('pre-arbitration'), true)).toBe(3);
    expect(urgencyTier(control('signed'), true)).toBe(3);
    expect(urgencyTier(control('signed'), false)).toBe(4);
  });

  it('keeps an arbitration man in his tier whether or not there is anything to decide', () => {
    // Dillon Dingler has no action and is still an arbitration case
    expect(urgencyTier(control('arbitration'), false)).toBe(2);
    expect(urgencyTier(control('leaving'), false)).toBe(1);
  });

  it('runs by value within a tier, and by pay after that, with the unrated last', () => {
    const row = (name: string, tier: number, overallPct: number | null, salaryNow: number) => ({
      name, urgencyTier: tier, overallPct, salaryNow,
    });
    const sorted = [
      row('d', 3, 99, 1), row('b', 1, 40, 1), row('e', 1, null, 99), row('a', 1, 90, 1),
      row('c', 1, 40, 5), row('f', 2, 10, 1),
    ].sort(byUrgency).map((r) => r.name);
    // Tier 1 by value (90, then the two 40s by pay, then the unrated), then tier 2, then tier 3
    expect(sorted).toEqual(['a', 'c', 'b', 'e', 'f', 'd']);
  });
});

/*
 * The same thing through the save. Everybody is a position player unless said
 * otherwise, and the pool is widened with two hundred men on the other club so
 * that a rank is a fraction of a percentile point: fifteen men can then sit at
 * the top of it and all be within ten points of one another.
 *
 * Five deals sit where the subject's comparables should be, and eight sit just
 * outside them for one reason each — all of them for ten years and sixty million
 * dollars, so that a single one leaking in moves the median and the test says so.
 * Each is inside the percentile window, or in the pool's own, so that the one
 * thing wrong with it is the only thing keeping it out.
 */
const SUBJECT = 8801;
const ARB_SUBJECT = 8802;
const VETERAN = 8803;
const MIDDLING = 8804;
const FILLER = 9000;
const RELIEVER = 9300;
const COMPARABLE = 8820;
const OUTSIDE = 8840;

interface Man {
  id: number;
  last: string;
  age: number;
  position?: number;
  role?: number;
  value: number;
  talent: number;
  service: number;
  years?: number;
  /** Completed contract years, which fixes when the deal began. */
  done?: number;
  salary?: number;
  team?: number;
  major?: boolean;
  retired?: boolean;
}

function addMan(m: Man): void {
  const team = m.team ?? IDS.mlbTeam;
  const years = m.years ?? 1;
  const done = m.done ?? 0;
  db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Terms', ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, 0, 0, 0)`
  ).run(m.id, m.last, m.age, m.position ?? 4, m.role ?? 0, m.id - 8000, team, team, m.retired ? 1 : 0);
  db.prepare(
    `INSERT INTO players_roster_status
       (player_id, is_active, is_on_dl, is_on_dl60, is_on_secondary,
        mlb_service_years, mlb_service_days, mlb_service_days_this_year)
     VALUES (?, 1, 0, 0, 0, ?, ?, 40)`
  ).run(m.id, Math.floor(m.service), Math.round(m.service * 172));
  db.prepare(
    `INSERT INTO players_value
       (player_id, overall_value, talent_value, offensive_value, offensive_value_vsl,
        offensive_value_vsr, pitching_value, oa_rating, pot_rating, oa, pot)
     VALUES (?, ?, ?, 100, 100, 100, 0, 60, 60, 60, 60)`
  ).run(m.id, m.value, m.talent);
  db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(team, m.id);
  const salaries = Array.from({ length: 15 }, (_, i) => (i < years ? (m.salary ?? 1_000_000) : 0));
  db.prepare(
    `INSERT INTO players_contract
       (player_id, team_id, contract_team_id, season_year, years, current_year, is_major,
        retained, no_trade, last_year_team_option, last_year_player_option,
        last_year_vesting_option, ${salaries.map((_, i) => `salary${i}`).join(', ')})
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ${salaries.map(() => '?').join(', ')})`
  ).run(m.id, team, team, SEASON - done, years, done, m.major === false ? 0 : 1, ...salaries);
}

/** A deal on the other club, which is where comparables live. */
const rival = (id: number, last: string, age: number, value: number, years: number, aav: number,
               over: Partial<Man> = {}): void =>
  addMan({ id, last, age, value, talent: value, service: 4, years, done: 1, salary: aav,
           team: IDS.otherMlbTeam, ...over });

beforeAll(() => {
  for (let i = 0; i < 200; i++) {
    addMan({ id: FILLER + i, last: `Pool${i}`, age: 27, value: 100 + 4 * i, talent: 100 + 4 * i,
             service: 3, team: IDS.otherMlbTeam });
  }
  // Relievers of their own, so that the pitcher below is near the top of his pool and not alone in it
  for (let i = 0; i < 30; i++) {
    addMan({ id: RELIEVER + i, last: `Arm${i}`, age: 27, position: 1, role: 12, value: 100 + 20 * i,
             talent: 100 + 20 * i, service: 3, team: IDS.otherMlbTeam });
  }
  // The subject: 21, the top of the pool, and his deal ends with the service to leave. Young
  // enough that the base fixture's own men, who are 26 and over, are nobody's comparables
  addMan({ id: SUBJECT, last: 'Subject', age: 21, value: 9500, talent: 9500, service: 7, salary: 5_000_000 });

  // Five comparables in the window: 19 to 24, in the next five places, signed last winter
  rival(COMPARABLE, 'Comp1', 19, 9400, 5, 20_000_000);
  rival(COMPARABLE + 1, 'Comp2', 20, 9300, 7, 30_000_000);
  rival(COMPARABLE + 2, 'Comp3', 22, 9200, 6, 24_000_000);
  rival(COMPARABLE + 3, 'Comp4', 23, 9100, 5, 18_000_000);
  rival(COMPARABLE + 4, 'Comp5', 24, 9000, 8, 26_000_000);

  // Each of these is wrong in exactly one way, and each would drag the median to ten years and $60M
  const TEN = [10, 60_000_000] as const;
  rival(OUTSIDE, 'TooOld', 28, 8900, ...TEN);                          // seven years older
  rival(OUTSIDE + 1, 'TooLow', 22, 500, ...TEN);                       // nowhere near his percentile
  rival(OUTSIDE + 2, 'Pitcher', 22, 8800, ...TEN, { position: 1, role: 12 }); // a different pool
  rival(OUTSIDE + 3, 'OneYear', 22, 8700, 1, 60_000_000);              // a renewal, not a price
  rival(OUTSIDE + 4, 'LongAgo', 22, 8600, ...TEN, { done: 5 });        // signed five winters ago
  rival(OUTSIDE + 5, 'Minors', 22, 8500, ...TEN, { major: false });    // not a major-league deal
  rival(OUTSIDE + 6, 'Farm', 22, 8400, ...TEN, { team: IDS.aaaTeam }); // not on a major-league roster
  rival(OUTSIDE + 7, 'Retired', 22, 8300, ...TEN, { retired: true });  // gone

  // A veteran with nobody his age to compare with, and a man in the middle with nothing to commit to
  addMan({ id: VETERAN, last: 'Veteran', age: 36, value: 8000, talent: 8000, service: 12, salary: 12_000_000 });
  addMan({ id: MIDDLING, last: 'Middling', age: 27, value: 500, talent: 500, service: 7, salary: 3_000_000 });
  // Arbitration year one, top of the pool among the young: an extension to buy, not a departure to prevent
  addMan({ id: ARB_SUBJECT, last: 'Arb', age: 22, value: 9450, talent: 9450, service: 3.2, salary: 1_000_000 });

  // Next season's payroll as OOTP estimates it, so the room line has a figure to quote
  db.prepare(`UPDATE team_financials SET player_payroll_next_season = 150000000 WHERE team_id = ?`).run(IDS.mlbTeam);
});

interface Row {
  player_id: number;
  name: string;
  flags: string[];
  overallPct: number | null;
  urgencyTier: number;
  urgencyRank: number;
  recommendation: { action: string; reasons: string[] } | null;
  terms: { years: number | null; aav: number | null; comparables: number; basis: string } | null;
  deadline: { kind: string; afterSeason: number | null; label: string };
}
const rows = async (): Promise<Row[]> =>
  (await request(`/api/contracts/${IDS.mlbTeam}`)).players as Row[];
const named = async (last: string): Promise<Row> => {
  const row = (await rows()).find((r) => r.name === `Terms ${last}`);
  expect(row, `${last} never reached the contracts payload`).toBeDefined();
  return row!;
};

describe('the terms in the contracts payload', () => {
  it('are the median of the five deals in the window and of nothing outside it', async () => {
    const him = await named('Subject');
    expect(him.recommendation?.action).toBe('Extend (value only)');
    // 5, 5, 6, 7, 8 years and $18M, $20M, $24M, $26M, $30M. Any of the eight outside deals
    // is ten years at $60M, and one of them in the sample would have moved both medians
    expect(him.terms).toMatchObject({ years: 6, aav: 24_000_000, comparables: 5 });
    expect(him.terms?.basis).toMatch(/^median of 5 deals of two years or more/);
  });

  it('say "no comparables" for a man nobody his age has been signed like', async () => {
    const vet = await named('Veteran');
    expect(vet.recommendation?.action).toBe('Re-sign short-term');
    expect(vet.terms?.years).toBeNull();
    expect(vet.terms?.aav).toBeNull();
    expect(vet.terms?.comparables).toBe(0);
  });

  it('are only given where the advice is to commit', async () => {
    const middling = await named('Middling');
    expect(middling.recommendation?.action).toBe('Market-dependent');
    expect(middling.terms).toBeNull();
    for (const r of await rows()) {
      const commits = ['Core keeper', 'Extension candidate', 'Extend now', 'Extend (value only)', 'Re-sign', 'Re-sign short-term'];
      expect(r.terms !== null, `${r.name}: ${r.recommendation?.action}`).toBe(
        r.recommendation !== null && commits.includes(r.recommendation.action)
      );
    }
  });
});

describe('the deadline in the contracts payload', () => {
  it('is free agency after this season for a man whose deal ends and who can leave', async () => {
    const him = await named('Subject');
    expect(him.flags).toContain('expiring');
    expect(him.deadline).toEqual({
      kind: 'free-agency',
      afterSeason: SEASON,
      label: `Before free agency, after the ${SEASON} season`,
    });
  });

  it('is the arbitration filing for an arbitration case with an extension to buy', async () => {
    const him = await named('Arb');
    expect(him.recommendation?.action).toBe('Extension candidate');
    expect(him.deadline).toMatchObject({ kind: 'arbitration', afterSeason: SEASON });
  });

  it('is none for a man with nothing to decide, and says so rather than going blank', async () => {
    const quiet = (await rows()).find((r) => r.recommendation === null)!;
    expect(quiet.deadline).toEqual({ kind: 'none', afterSeason: null, label: 'none' });
  });
});

describe('the list, in the order of the winter', () => {
  it('numbers the rows in the order they are sent', async () => {
    (await rows()).forEach((r, i) => expect(r.urgencyRank, r.name).toBe(i + 1));
  });

  it('puts a man who can leave before an arbitration case before a call before the rest', async () => {
    const all = await rows();
    const tiers = all.map((r) => r.urgencyTier);
    expect(tiers, 'the tiers go backwards somewhere').toEqual([...tiers].sort((a, b) => a - b));
    for (const r of all) {
      if (r.flags.includes('expiring')) expect(r.urgencyTier, r.name).toBe(1);
      else if (r.flags.some((f) => f.startsWith('arbitration'))) expect(r.urgencyTier, r.name).toBe(2);
      else expect(r.urgencyTier, r.name).toBe(r.recommendation ? 3 : 4);
    }
    expect(tiers[0], 'the club has men who can leave and they are not first').toBe(1);
  });

  it('puts the better player first within a tier, whatever he is paid', async () => {
    const all = await rows();
    for (let tier = 1; tier <= 4; tier++) {
      const pcts = all.filter((r) => r.urgencyTier === tier).map((r) => r.overallPct ?? -1);
      expect(pcts, `tier ${tier}`).toEqual([...pcts].sort((a, b) => b - a));
    }
    // The old order put the man on $12M ahead of the top of the pool on $5M
    const names = all.map((r) => r.name);
    expect(names.indexOf('Terms Subject')).toBeLessThan(names.indexOf('Terms Veteran'));
  });
});

describe('the page', () => {
  const html = () =>
    renderToStaticMarkup(
      createElement(ContractsView, {
        data: computeContracts(IDS.mlbTeam) as unknown as ContractsResponse,
        only: null,
        onOnly: () => {},
      })
    );
  /** The cells of each body row, as text. */
  const cellsOf = (markup: string): string[][] =>
    (markup.match(/<tbody>.*<\/tbody>/s)?.[0].match(/<tr>.*?<\/tr>/gs) ?? []).map((tr) =>
      (tr.match(/<td[^>]*>.*?<\/td>/gs) ?? []).map((td) => td.replace(/<[^>]*>/g, '').trim())
    );
  const TERMS = 11;
  const DEADLINE = 12;

  it('has columns for the terms and the deadline', () => {
    const head = html().match(/<thead>.*<\/thead>/s)?.[0].replace(/<span class="tip-pop"[^>]*>.*?<\/span>/gs, '') ?? '';
    expect(head).toContain('Terms');
    expect(head).toContain('Deadline');
  });

  it('writes the terms as a length and a yearly figure, and says who they come from', () => {
    const row = cellsOf(html()).find((cells) => cells[0] === 'Terms Subject')!;
    expect(row[TERMS]).toBe('6 yrs, $24.0M a yearmedian of 5 similar deals');
    expect(html()).toContain('title="median of 5 deals of two years or more');
  });

  it('says "no comparables" where there are none, and nothing at all where there is no advice to price', () => {
    const table = cellsOf(html());
    expect(table.find((cells) => cells[0] === 'Terms Veteran')![TERMS]).toBe('no comparables');
    expect(table.find((cells) => cells[0] === 'Terms Middling')![TERMS]).toBe('—');
  });

  it('prints the deadline, or "none"', () => {
    const table = cellsOf(html());
    expect(table.find((cells) => cells[0] === 'Terms Subject')![DEADLINE]).toBe(
      `Before free agency, after the ${SEASON} season`
    );
    expect(table.find((cells) => cells[0] === 'Terms Arb')![DEADLINE]).toBe(
      `Before the arbitration filing, after the ${SEASON} season`
    );
    // Somebody with nothing to decide has no date to put on it
    const quiet = computeContracts(IDS.mlbTeam).players.find((p) => p.recommendation === null)!;
    expect(table.find((cells) => cells[0] === quiet.name)![DEADLINE], quiet.name).toBe('none');
  });

  it('lists them in the order the server numbered them', async () => {
    const shown = cellsOf(html()).map((cells) => cells[0]);
    const sent = (await rows()).map((r) => r.name);
    expect(shown).toEqual(sent);
  });

  it('quotes next season\'s room, from the same figure as the card, beside the cost of the deals', () => {
    const markup = html();
    const text = markup.replace(/<[^>]*>/g, '');
    // $200M of budget less OOTP's $150M estimate for next year
    const card = text.match(/Room next yr \(OOTP est\.\)(-?\$[\d.]+[KMB])/)?.[1];
    expect(card).toBe('$50.0M');
    const line = text.match(/Room next season: (-?\$[\d.]+[KMB])/)?.[1];
    expect(line, 'the line and the card must be the same number').toBe(card);
    // The one man who can leave and has terms: $24.0M a year of the room
    expect(text).toContain('Re-signing the 1 player reaching free agency who has suggested terms would take $24.0M a year of it.');
  });
});
