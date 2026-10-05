import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import { rosterCrunch } from '../server/rosterops.js';
import { rule5Eligible } from '../server/rosterRules.js';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * Rule 5 on the 40-Man Roster page, read the right way round.
 *
 * `years_protected_from_rule_5` is the length of a man's protection — 5 when
 * he signed at 18 or under, 4 otherwise — and the page read it as a countdown
 * ("exposed once it reaches zero"). The column never reaches zero, so on the
 * Dodgers it flagged one man where 115 were eligible: not on the 40-man, with
 * pro service years at or past the protection.
 *
 * Flagging all 115 as issues would bury the chip, so the fact goes on every
 * row as a flag and the issue line is reserved for the men the protect gate
 * passes — a 50 ceiling, or a 40 with the production behind it (the page has
 * no production index, so here it is the ceiling alone). `counts.issues` stays
 * the length of the list the dashboard chip opens.
 */

const ORG = 72;
const FARM = 73;

const MAN = {
  /** 5 pro years against 4 of protection, 52 ceiling: eligible and worth a place. */
  fiveOfFour: 7201,
  /** 3 against 4 with a 60 ceiling: not eligible, so no line whatever the grade. */
  threeOfFour: 7202,
  /** 4 against 4, a 40 ceiling: eligible, not worth a place, empty issues. */
  fourOfFour: 7203,
  /** On the 40-man at 5 against 4: shielded. */
  onForty: 7204,
  /** The man the countdown reading flagged: protection 0, which says the export does not know. */
  countdown: 7205,
  /** Signed young: 5 against 5, a 40 now with a 45 ceiling — eligible, but the index is unreadable here. */
  fiveOfFive: 7206,
  /** 4 against 5: a year short. */
  fourOfFive: 7207,
  /** Eligible with no grade at all: nobody is recommended on a blank. */
  noGrade: 7208,
} as const;

const STATUS_COLUMNS = [
  'options_used', 'options_used_this_year', 'years_protected_from_rule_5', 'pro_service_years',
  'days_on_waivers_left',
];

function addStatusColumns(): void {
  const have = new Set(
    (db.prepare(`PRAGMA table_info(players_roster_status)`).all() as Array<{ name: string }>)
      .map((c) => c.name)
  );
  for (const col of STATUS_COLUMNS) {
    if (!have.has(col)) db.exec(`ALTER TABLE players_roster_status ADD COLUMN ${col} INTEGER DEFAULT 0`);
  }
}

interface Seed {
  secondary?: number; protectedYears: number; proYears: number;
  /** OOTP's grades; omitted for a man with no players_value row. */
  grade?: { oa: number; pot: number };
}

function addClub(): void {
  const team = db.prepare(
    `INSERT INTO teams (team_id, name, nickname, abbr, level, league_id, sub_league_id,
                        division_id, parent_team_id, allstar_team)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, 0)`
  );
  team.run(ORG, 'Rule', 'Five', 'RLF', 1, IDS.league, 0);
  team.run(FARM, 'Rule', 'Farm', 'RFM', 2, IDS.league, ORG);

  const man = (id: number, last: string, s: Seed) => {
    db.prepare(
      `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                            uniform_number, team_id, organization_id, retired, hidden,
                            draft_eligible, college)
       VALUES (?, 'Rule', ?, 23, 6, 0, 1, 1, ?, ?, ?, 0, 0, 0, 0)`
    ).run(id, last, id - 7200, FARM, ORG);
    db.prepare(
      `INSERT INTO players_roster_status
         (player_id, is_active, is_on_dl, is_on_dl60, is_on_secondary,
          mlb_service_years, mlb_service_days, mlb_service_days_this_year,
          designated_for_assignment, days_on_dfa_left, is_on_waivers,
          options_used, options_used_this_year, years_protected_from_rule_5, pro_service_years)
       VALUES (?, 0, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, ?, ?)`
    ).run(id, s.secondary ?? 0, s.protectedYears, s.proYears);
    if (s.grade) {
      db.prepare(
        `INSERT INTO players_value
           (player_id, overall_value, talent_value, offensive_value, offensive_value_vsl,
            offensive_value_vsr, pitching_value, oa_rating, pot_rating, oa, pot)
         VALUES (?, 100, 100, 100, 100, 100, 0, ?, ?, ?, ?)`
      ).run(id, Math.round(s.grade.oa / 5) * 5, Math.round(s.grade.pot / 5) * 5, s.grade.oa, s.grade.pot);
    }
  };

  man(MAN.fiveOfFour, 'Worth', { protectedYears: 4, proYears: 5, grade: { oa: 39, pot: 52 } });
  man(MAN.threeOfFour, 'Early', { protectedYears: 4, proYears: 3, grade: { oa: 45, pot: 60 } });
  man(MAN.fourOfFour, 'Depth', { protectedYears: 4, proYears: 4, grade: { oa: 38, pot: 40 } });
  man(MAN.onForty, 'Shielded', { secondary: 1, protectedYears: 4, proYears: 5, grade: { oa: 45, pot: 55 } });
  man(MAN.countdown, 'Countdown', { protectedYears: 0, proYears: 5, grade: { oa: 45, pot: 55 } });
  man(MAN.fiveOfFive, 'Young', { protectedYears: 5, proYears: 5, grade: { oa: 40, pot: 45 } });
  man(MAN.fourOfFive, 'Younger', { protectedYears: 5, proYears: 4, grade: { oa: 40, pot: 45 } });
  man(MAN.noGrade, 'Blank', { protectedYears: 4, proYears: 4 });
}

interface Man {
  player_id: number; name: string; on40: boolean; issues: string[];
  rule5: { eligible: boolean; protectRecommended: boolean };
}
interface Crunch {
  counts: { active: number; fortyMan: number; il60: number; issues: number; rule5Eligible: number };
  issues: Man[];
  fortyMan: Man[];
  rule5Eligible: Man[];
}

const crunch = async (): Promise<Crunch> => (await request(`/api/roster-crunch/${ORG}`)) as Crunch;
const find = (list: Man[], id: number): Man | undefined => list.find((p) => p.player_id === id);

const WORTH_A_PLACE = 'Rule 5: worth a 40-man place';

beforeAll(() => {
  addStatusColumns();
  addClub();
});

describe('who is eligible', () => {
  it('flags a five-year man protected for four, and not a three-year man', async () => {
    const d = await crunch();
    expect(find(d.rule5Eligible, MAN.fiveOfFour)?.rule5).toEqual({ eligible: true, protectRecommended: true });
    expect(find(d.rule5Eligible, MAN.threeOfFour), 'three years against four is a year short').toBeUndefined();
  });

  it('no longer reads the protection as a countdown', async () => {
    const d = await crunch();
    expect(find(d.rule5Eligible, MAN.countdown), 'a zero protection was read as "exposed"').toBeUndefined();
    expect(find(d.issues, MAN.countdown)).toBeUndefined();
  });

  it('shields a man on the 40-man', async () => {
    const d = await crunch();
    expect(find(d.rule5Eligible, MAN.onForty)).toBeUndefined();
    expect(find(d.fortyMan, MAN.onForty)?.rule5).toEqual({ eligible: false, protectRecommended: false });
  });

  it('reads a five-year protection for a man signed young', async () => {
    const d = await crunch();
    expect(find(d.rule5Eligible, MAN.fiveOfFive)?.rule5.eligible).toBe(true);
    expect(find(d.rule5Eligible, MAN.fourOfFive)).toBeUndefined();
  });

  it('lists exactly the eligible men, and the count is their number', async () => {
    const d = await crunch();
    expect(d.rule5Eligible.map((p) => p.player_id).sort()).toEqual(
      [MAN.fiveOfFour, MAN.fourOfFour, MAN.fiveOfFive, MAN.noGrade].sort()
    );
    expect(d.counts.rule5Eligible).toBe(d.rule5Eligible.length);
    expect(d.rule5Eligible.every((p) => p.rule5.eligible)).toBe(true);
  });

  it('agrees with the rule read straight off the status rows', async () => {
    // The page and the planner read one function; this holds the page to it
    const rows = db
      .prepare(
        `SELECT rs.is_active, rs.is_on_secondary, rs.pro_service_years, rs.years_protected_from_rule_5
         FROM players_roster_status rs JOIN players p ON p.player_id = rs.player_id
         WHERE p.organization_id = ?`
      )
      .all(ORG) as Array<Record<string, number>>;
    const direct = rows.filter((r) => rule5Eligible({
      on40: r.is_active === 1 || r.is_on_secondary === 1,
      proServiceYears: r.pro_service_years,
      protectedYears: r.years_protected_from_rule_5,
    })).length;
    expect((await crunch()).counts.rule5Eligible).toBe(direct);
  });
});

describe('who is worth a place', () => {
  it('gives the gate-passer the line, in those words', async () => {
    const him = find((await crunch()).issues, MAN.fiveOfFour);
    expect(him?.issues).toEqual([WORTH_A_PLACE]);
  });

  it('gives an eligible man under the gate the flag and no line', async () => {
    const d = await crunch();
    expect(find(d.issues, MAN.fourOfFour), 'a 40 ceiling is not worth a 40-man place').toBeUndefined();
    expect(find(d.rule5Eligible, MAN.fourOfFour)?.rule5).toEqual({ eligible: true, protectRecommended: false });
    expect(find(d.rule5Eligible, MAN.fourOfFour)?.issues).toEqual([]);
  });

  it('does not take a 40 on grade alone: the page has no production index to back it', async () => {
    const d = await crunch();
    expect(find(d.rule5Eligible, MAN.fiveOfFive)?.rule5.protectRecommended).toBe(false);
    expect(find(d.issues, MAN.fiveOfFive)).toBeUndefined();
  });

  it('recommends nobody on a blank grade', async () => {
    const d = await crunch();
    expect(find(d.rule5Eligible, MAN.noGrade)?.rule5).toEqual({ eligible: true, protectRecommended: false });
  });

  it('gives no line to a high ceiling that is not eligible', async () => {
    expect(find((await crunch()).issues, MAN.threeOfFour)).toBeUndefined();
  });

  it('puts the men worth a place first in the list', async () => {
    const d = await crunch();
    expect(d.rule5Eligible[0].player_id).toBe(MAN.fiveOfFour);
    const flags = d.rule5Eligible.map((p) => p.rule5.protectRecommended);
    expect(flags.lastIndexOf(true)).toBeLessThan(flags.indexOf(false));
  });
});

describe('what the chip counts', () => {
  it('counts the issues list and only the gate-passers from Rule 5', async () => {
    const d = await crunch();
    expect(d.counts.issues).toBe(d.issues.length);
    const withLine = d.issues.filter((p) => p.issues.includes(WORTH_A_PLACE)).map((p) => p.player_id);
    expect(withLine).toEqual([MAN.fiveOfFour]);
    expect(d.counts.issues).toBe(1);
    expect(d.counts.rule5Eligible).toBe(4);
  });

  it('is one function, so the dashboard cannot count something else', async () => {
    expect(rosterCrunch(ORG)).toEqual(await crunch());
  });
});
