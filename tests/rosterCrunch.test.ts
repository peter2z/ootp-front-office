import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import { rosterCrunch } from '../server/rosterops.js';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * Who holds a place on the 40-man, and who is in trouble on it.
 *
 * The Roster Crunch page counted every man on the sixty-day injured list
 * against the 40-man, which is wrong in the direction that matters: the club
 * may fill his spot the day he goes down, that being the point of the list.
 * Across the save this was checked on, 41 such men put eight of thirty-two
 * clubs over the limit — Baltimore at 42 of 40, Austin at 41 — when OOTP lets
 * none of them go past it.
 *
 * It was wrong the other way too. "Out of options" was raised only for men
 * already in the minors (`!on26`), so the four Dodgers pitchers who had used
 * all three options and were on the big club — Phillips, Snell, Okert and
 * Anderson — carried no flag, though they are the men a full roster has to
 * designate. Past five years of service a man can refuse the assignment and
 * the missing option costs the club nothing, so the flag stops there: of those
 * four only Anderson, at 3.78 years, was a real constraint.
 *
 * And the dashboard said 0 roster issues above a page that said 6, because it
 * counted designations and waivers with a query of its own. There is one
 * function now and these tests hold both readers to it.
 */

const ORG = 70;
const FARM = 71;

const MAN = {
  fresh: 7001,
  /** All three options used, and "2.100" of service: two years and a hundred days. */
  youngNoOptions: 7002,
  veteranNoOptions: 7003,
  lastYear: 7004,
  fiveExactly: 7005,
  dayShort: 7006,
  il60: 7007,
  il15: 7008,
  farmNoOptions: 7009,
  farmLastYear: 7010,
  designated: 7011,
  unprotected: 7012,
  depth: 7013,
} as const;

const DAYS = 172;

interface Status {
  active?: number; secondary?: number; dl?: number; dl60?: number;
  years: number; days: number; options?: number;
  dfa?: number; dfaLeft?: number; protectedYears?: number; proYears?: number;
}

/** The real export carries these; the base fixture's short table does not. */
const OPTION_COLUMNS = [
  'options_used', 'years_protected_from_rule_5', 'pro_service_years', 'days_on_waivers_left',
];

function addOptionColumns(): void {
  const have = new Set(
    (db.prepare(`PRAGMA table_info(players_roster_status)`).all() as Array<{ name: string }>)
      .map((c) => c.name)
  );
  for (const col of OPTION_COLUMNS) {
    if (!have.has(col)) db.exec(`ALTER TABLE players_roster_status ADD COLUMN ${col} INTEGER DEFAULT 0`);
  }
}

function addClub(): void {
  const team = db.prepare(
    `INSERT INTO teams (team_id, name, nickname, abbr, level, league_id, sub_league_id,
                        division_id, parent_team_id, allstar_team)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, 0)`
  );
  team.run(ORG, 'Crunch', 'Club', 'CRN', 1, IDS.league, 0);
  team.run(FARM, 'Crunch', 'Farm', 'CRF', 2, IDS.league, ORG);

  const man = (id: number, last: string, team: number, s: Status) => {
    db.prepare(
      `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                            uniform_number, team_id, organization_id, retired, hidden,
                            draft_eligible, college)
       VALUES (?, 'Crunch', ?, 29, 1, 11, 1, 1, ?, ?, ?, 0, 0, 0, 0)`
    ).run(id, last, id - 7000, team, ORG);
    db.prepare(
      `INSERT INTO players_roster_status
         (player_id, is_active, is_on_dl, is_on_dl60, is_on_secondary,
          mlb_service_years, mlb_service_days, mlb_service_days_this_year,
          designated_for_assignment, days_on_dfa_left, is_on_waivers,
          options_used, years_protected_from_rule_5, pro_service_years)
       VALUES (@id, @active, @dl, @dl60, @secondary, @years, @days, 0, @dfa, @dfaLeft, 0,
               @options, @protectedYears, @proYears)`
    ).run({
      id, active: s.active ?? 0, dl: s.dl ?? 0, dl60: s.dl60 ?? 0, secondary: s.secondary ?? 0,
      years: s.years, days: s.days, options: s.options ?? 0, dfa: s.dfa ?? 0,
      dfaLeft: s.dfaLeft ?? 0, protectedYears: s.protectedYears ?? 4, proYears: s.proYears ?? 1,
    });
  };

  // On the 26
  man(MAN.fresh, 'Fresh', ORG, { active: 1, years: 3, days: 3 * DAYS });
  man(MAN.youngNoOptions, 'Young', ORG, {
    active: 1, options: 3, years: 2, days: 2 * DAYS + 100,
  });
  man(MAN.veteranNoOptions, 'Veteran', ORG, { active: 1, options: 3, years: 6, days: 6 * DAYS });
  man(MAN.lastYear, 'Lastyear', ORG, { active: 1, options: 2, years: 3, days: 3 * DAYS });
  // Five years to the day is past the line; one day short of it is not
  man(MAN.fiveExactly, 'Five', ORG, { active: 1, options: 3, years: 5, days: 5 * DAYS });
  man(MAN.dayShort, 'Dayshort', ORG, { active: 1, options: 3, years: 4, days: 5 * DAYS - 1 });
  // Hurt: the sixty-day man is on no secondary list, which is how a real export has him
  man(MAN.il60, 'Sixty', ORG, { dl: 1, dl60: 1, years: 4, days: 4 * DAYS });
  man(MAN.il15, 'Fifteen', ORG, { dl: 1, secondary: 1, years: 4, days: 4 * DAYS });
  // In the minors, on the 40-man
  man(MAN.farmNoOptions, 'Noopt', FARM, { secondary: 1, options: 3, years: 2, days: 2 * DAYS });
  man(MAN.farmLastYear, 'Lastopt', FARM, { secondary: 1, options: 2, years: 0, days: 0 });
  man(MAN.designated, 'Designated', FARM, {
    secondary: 1, options: 3, dfa: 1, dfaLeft: 4, years: 1, days: DAYS,
  });
  // In the minors and off the 40-man
  man(MAN.unprotected, 'Exposed', FARM, { protectedYears: 0, proYears: 5, years: 0, days: 0 });
  man(MAN.depth, 'Depth', FARM, { years: 0, days: 0 });
}

interface Man {
  player_id: number; name: string; on26: boolean; on40: boolean; il60: boolean;
  note: string | null; issues: string[];
}
interface Crunch {
  counts: { active: number; fortyMan: number; il60: number; issues: number };
  issues: Man[];
  fortyMan: Man[];
}

const crunch = async (): Promise<Crunch> => (await request(`/api/roster-crunch/${ORG}`)) as Crunch;
const find = (list: Man[], id: number): Man | undefined => list.find((p) => p.player_id === id);

const ACTIVE_NO_OPTIONS = /^Out of options: cannot be sent down without clearing waivers$/;

describe('an export that lacks the option columns', () => {
  /*
   * Runs before the columns are added. The dashboard reads this function now,
   * so a save without `options_used` has to lose that one flag and not the
   * whole page — the base fixture's roster-status table is exactly that shape.
   */
  it('still answers, with the flags it can raise', () => {
    const d = rosterCrunch(IDS.mlbTeam);
    expect(d, 'no answer at all from a table that exists').not.toBeNull();
    expect(d!.counts.issues).toBe(0);
    expect(d!.counts.fortyMan).toBeGreaterThan(0);
  });
});

describe('the 40-man count', () => {
  beforeAll(() => {
    addOptionColumns();
    addClub();
  });

  it('does not count a man on the 60-day injured list', async () => {
    /*
     * Ten hold a place: the six on the 26, the man on the ordinary injured
     * list, and three on the 40-man in the minors. The eleventh is the
     * sixty-day man, who is on the list and not in the count.
     */
    const d = await crunch();
    expect(d.counts.fortyMan).toBe(10);
  });

  it('still lists him, with the reason beside him', async () => {
    const d = await crunch();
    const him = find(d.fortyMan, MAN.il60);
    expect(him, 'the sixty-day man vanished from the list').toBeDefined();
    expect(him!.il60).toBe(true);
    expect(him!.note).toBe('IL-60, does not count');
    expect(d.fortyMan).toHaveLength(11);
    expect(d.counts.il60).toBe(1);
  });

  it('puts him after the men who count', async () => {
    const d = await crunch();
    expect(d.fortyMan[d.fortyMan.length - 1].player_id).toBe(MAN.il60);
    // And the active men still lead, as the page has always listed them
    expect(d.fortyMan.slice(0, 6).every((p) => p.on26)).toBe(true);
  });

  it('counts a man on the ordinary injured list, who keeps his place', async () => {
    const him = find((await crunch()).fortyMan, MAN.il15);
    expect(him, 'the ordinary injured list is not the sixty-day one').toBeDefined();
    expect(him!.il60).toBe(false);
    expect(him!.note).toBeNull();
  });

  it('leaves nobody else carrying the note', async () => {
    const noted = (await crunch()).fortyMan.filter((p) => p.note !== null);
    expect(noted.map((p) => p.player_id)).toEqual([MAN.il60]);
  });

  it('does not put a man off the 40-man on it', async () => {
    const d = await crunch();
    expect(find(d.fortyMan, MAN.depth)).toBeUndefined();
    expect(find(d.fortyMan, MAN.unprotected)).toBeUndefined();
  });
});

describe('a man on the 26 with every option used', () => {
  it('is flagged under five years of service', async () => {
    // "2.100": two years and a hundred days, which is nowhere near the line
    const d = await crunch();
    const him = find(d.issues, MAN.youngNoOptions);
    expect(him, 'an active man with no options left carried no flag').toBeDefined();
    expect(him!.issues).toHaveLength(1);
    expect(him!.issues[0]).toMatch(ACTIVE_NO_OPTIONS);
  });

  it('is not flagged at six years, when he could refuse the assignment anyway', async () => {
    const d = await crunch();
    expect(find(d.issues, MAN.veteranNoOptions), 'a six-year man was flagged').toBeUndefined();
    // He is still on the roster and still counted, which is all that changes
    expect(find(d.fortyMan, MAN.veteranNoOptions)?.on26).toBe(true);
  });

  it('is flagged a day short of five years and not at five', async () => {
    // A service year is 172 days, so the line is 860 of them
    const d = await crunch();
    expect(find(d.issues, MAN.dayShort), 'one day under five years was missed').toBeDefined();
    expect(find(d.issues, MAN.fiveExactly), 'five years exactly was flagged').toBeUndefined();
  });

  it('falls back to whole years where an export carries no service days', async () => {
    db.prepare(`UPDATE players_roster_status SET mlb_service_days = NULL WHERE player_id IN (?, ?)`)
      .run(MAN.youngNoOptions, MAN.veteranNoOptions);
    try {
      const d = await crunch();
      expect(find(d.issues, MAN.youngNoOptions), 'two years of service went unflagged').toBeDefined();
      expect(find(d.issues, MAN.veteranNoOptions), 'six years of service was flagged').toBeUndefined();
    } finally {
      const put = db.prepare(`UPDATE players_roster_status SET mlb_service_days = ? WHERE player_id = ?`);
      put.run(2 * DAYS + 100, MAN.youngNoOptions);
      put.run(6 * DAYS, MAN.veteranNoOptions);
    }
  });

  it('is not flagged for having used two, since that is a minor leaguer\'s warning', async () => {
    const d = await crunch();
    expect(find(d.issues, MAN.lastYear)).toBeUndefined();
    expect(find(d.issues, MAN.fresh)).toBeUndefined();
  });

  it('is a heads-up, not a roster violation', async () => {
    /*
     * Being out of options says something about a man; it does not change who
     * is on the roster. Giving him back an option takes the flag away and moves
     * nothing else.
     */
    const before = await crunch();
    db.prepare(`UPDATE players_roster_status SET options_used = 0 WHERE player_id = ?`)
      .run(MAN.youngNoOptions);
    try {
      const after = await crunch();
      expect(after.counts.issues).toBe(before.counts.issues - 1);
      expect(after.counts.active).toBe(before.counts.active);
      expect(after.counts.fortyMan).toBe(before.counts.fortyMan);
    } finally {
      db.prepare(`UPDATE players_roster_status SET options_used = 3 WHERE player_id = ?`)
        .run(MAN.youngNoOptions);
    }
  });
});

describe('the flags that were already there', () => {
  it('still tells a minor leaguer on the 40-man that he is out of options', async () => {
    const him = find((await crunch()).issues, MAN.farmNoOptions);
    expect(him?.issues).toEqual(['out of options']);
  });

  it('still warns of a last option year', async () => {
    const him = find((await crunch()).issues, MAN.farmLastYear);
    expect(him?.issues).toEqual(['last option year']);
  });

  it('still raises Rule 5 exposure for an unprotected man off the 40-man', async () => {
    const him = find((await crunch()).issues, MAN.unprotected);
    expect(him?.issues).toEqual(['Rule 5 exposed']);
  });

  it('keeps the order: most trouble first, and each man\'s own list as it was', async () => {
    const d = await crunch();
    // Two flags outrank one, so the designated man leads the page
    expect(d.issues[0].player_id).toBe(MAN.designated);
    // The clock before the options, as the page has always printed them
    expect(d.issues[0].issues).toEqual(['DFA — 4 days to resolve', 'out of options']);
  });
});

describe('what the page and the dashboard are given', () => {
  it('counts exactly the list under Needs attention', async () => {
    const d = await crunch();
    expect(d.counts.issues).toBe(d.issues.length);
    expect(d.issues.every((p) => p.issues.length > 0)).toBe(true);
    // Nobody on the 40-man list carries a flag and is missing from it
    const flagged = d.fortyMan.filter((p) => p.issues.length > 0).map((p) => p.player_id);
    const listed = new Set(d.issues.map((p) => p.player_id));
    expect(flagged.every((id) => listed.has(id))).toBe(true);
  });

  it('is six men: the two active, the three in the minors, and the unprotected one', async () => {
    const ids = (await crunch()).issues.map((p) => p.player_id).sort();
    expect(ids).toEqual([
      MAN.youngNoOptions, MAN.dayShort, MAN.farmNoOptions, MAN.farmLastYear,
      MAN.designated, MAN.unprotected,
    ].sort());
  });

  it('is one function, so the dashboard cannot count something else', async () => {
    // The route is a thin wrapper over the function the dashboard calls
    expect(rosterCrunch(ORG)).toEqual(await crunch());
  });
});
