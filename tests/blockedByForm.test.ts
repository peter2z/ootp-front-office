import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import { seasonFormByPlayer } from '../server/form.js';
import { clearScaleCache, ratingScaleMax } from '../server/valuation.js';
import request from './request.js';
import { IDS, SEASON } from './fixture.js';

/**
 * A man graded above a call-up, who is not holding him off.
 *
 * Emil Morales — twenty-one, a 1.072 OPS at Double-A, ten home runs and 2.3
 * WAR in 147 trips, last year's MVP on his card — was "blocked at 3B — Max
 * Muncy grades 56 to his 41". The same Max Muncy was thirty-seven and hitting
 * .198/.301/.385, an 87 wRC+. The dashboard had him cold and the contracts page
 * told the reader to hold off on him because "the season does not back an
 * extension". The farm page read his scouting grade and nothing else, so the
 * app told the reader opposite things about one man on two pages.
 *
 * The season and the age now come in here as they do there: form.ts's reading
 * of the season, which is only "poor" on a sample worth reading, excuses a
 * lead of up to 20 points; being 33 or older excuses one of up to 10. Both are
 * 20-80 points, carried onto whatever scale the save shows.
 */

/** The club these cases are built on, kept apart from the base fixture's. */
const ORG = 80;
const AA = 81;
/** A Single-A rung of its own, so one level average can be set exactly. */
const LOW_A = 82;

/** Each position below is one case: an incumbent on the big club and a hot bat behind him. */
const CASE = {
  // Thirty-seven, graded 56, hitting .198/.301/.385 over 113 trips: the report
  cold: { pos: 5, incumbent: 8001, prospect: 8101, age: 37, grade: 56 },
  // The same man having a good year: the grade still stands
  warm: { pos: 3, incumbent: 8002, prospect: 8102, age: 37, grade: 56 },
  // A bad fortnight, forty trips, is not evidence of anything
  brief: { pos: 9, incumbent: 8003, prospect: 8103, age: 30, grade: 56 },
  // Cold and old, but twenty-three points better: past what a slump can make up
  far: { pos: 8, incumbent: 8004, prospect: 8104, age: 37, grade: 64 },
  // No line to speak of, thirty-four, and seven points better
  aging: { pos: 7, incumbent: 8005, prospect: 8106, age: 34, grade: 48 },
  // The same seven points from a man of thirty-two
  prime: { pos: 2, incumbent: 8006, prospect: 8107, age: 32, grade: 48 },
} as const;

/** A promotion made on an OPS gap between the old reason's threshold and the signal's. */
const QUIET = 8200;
const DH = 10;

interface Line {
  pa: number; ab: number; h: number; d: number; t: number; hr: number;
  bb: number; hp: number; sf: number; r: number;
}

// .198/.301/.385 in 113 trips, the reported line to the point
const COLD_LINE: Line = { pa: 113, ab: 96, h: 19, d: 6, t: 0, hr: 4, bb: 14, hp: 1, sf: 2, r: 10 };
// .308/.380/.585
const WARM_LINE: Line = { pa: 150, ab: 130, h: 40, d: 10, t: 1, hr: 8, bb: 15, hp: 2, sf: 3, r: 25 };
// Worse than the cold line, over forty trips
const BRIEF_LINE: Line = { pa: 40, ab: 36, h: 5, d: 1, t: 0, hr: 0, bb: 3, hp: 0, sf: 1, r: 2 };
// .259/.330/.423, a major-league average to measure the others by
const MLB_AVERAGE: Line = { pa: 400, ab: 355, h: 92, d: 18, t: 2, hr: 12, bb: 35, hp: 5, sf: 5, r: 50 };
// .360/.442/.696 in 147 trips, the shape of Morales's season
const HOT_LINE: Line = { pa: 147, ab: 125, h: 45, d: 10, t: 1, hr: 10, bb: 18, hp: 2, sf: 2, r: 30 };
// .252/.320/.374 at Double-A
const AA_AVERAGE: Line = { pa: 300, ab: 270, h: 68, d: 13, t: 1, hr: 6, bb: 25, hp: 3, sf: 2, r: 30 };
// .693 and .814 OPS: four of the first and one of the second make a gap of .097
const LOW_A_AVERAGE: Line = { pa: 400, ab: 360, h: 90, d: 18, t: 2, hr: 8, bb: 32, hp: 4, sf: 4, r: 40 };
const QUIET_LINE: Line = { pa: 400, ab: 360, h: 104, d: 20, t: 2, hr: 13, bb: 32, hp: 4, sf: 4, r: 55 };

function man(
  id: number, first: string, last: string, age: number, pos: number, team: number, grade: [number, number]
): void {
  db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, ?, ?, ?, ?, 0, 1, 1, ?, ?, ?, 0, 0, 0, 0)`
  ).run(id, first, last, age, pos, id % 100, team, team === IDS.otherMlbTeam ? team : ORG);
  db.prepare(
    `INSERT INTO players_value
       (player_id, overall_value, talent_value, offensive_value, offensive_value_vsl,
        offensive_value_vsr, pitching_value, oa_rating, pot_rating, oa, pot)
     VALUES (?, 500, 500, 100, 100, 100, 0, ?, ?, ?, ?)`
  ).run(id, grade[0], grade[1], grade[0], grade[1]);
  db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(team, id);
}

function line(id: number, team: number, level: number, s: Line): void {
  db.prepare(
    `INSERT INTO players_career_batting_stats
       (player_id, year, team_id, league_id, level_id, split_id, pa, ab, h, d, t, hr,
        bb, ibb, hp, sf, k, sb, cs, r, rbi, war)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 30, 0, 0, ?, 20, 0.5)`
  ).run(id, SEASON, team, IDS.league, level, s.pa, s.ab, s.h, s.d, s.t, s.hr, s.bb, s.hp, s.sf, s.r);
}

beforeAll(() => {
  const team = db.prepare(
    `INSERT INTO teams (team_id, name, nickname, abbr, level, league_id, sub_league_id,
                        division_id, parent_team_id, allstar_team)
     VALUES (?, 'Form', ?, ?, ?, ?, 0, 0, ?, 0)`
  );
  team.run(ORG, 'Club', 'FRM', 1, IDS.league, 0);
  team.run(AA, 'Doubles', 'FDA', 3, IDS.league, ORG);
  team.run(LOW_A, 'Singles', 'FSA', 4, IDS.league, ORG);

  /*
   * A league for the big club's lines to be read against. wRC+ is measured
   * against every major-league line in the league that season, so without a
   * field of ordinary hitters the incumbents would make up most of the average
   * they are being judged by.
   */
  for (let i = 0; i < 6; i++) {
    const id = 8300 + i;
    man(id, 'League', `Average${i}`, 28, 4, IDS.otherMlbTeam, [50, 50]);
    line(id, IDS.otherMlbTeam, 1, MLB_AVERAGE);
  }

  // The big club, every man on its active list and active
  const status = db.prepare(
    `INSERT INTO players_roster_status
       (player_id, is_active, is_on_dl, is_on_dl60, is_on_secondary,
        mlb_service_years, mlb_service_days, mlb_service_days_this_year)
     VALUES (?, 1, 0, 0, 1, 6, ?, 40)`
  );
  const incumbents: Array<[keyof typeof CASE, string, Line | null]> = [
    ['cold', 'Veteran', COLD_LINE],
    ['warm', 'Warmveteran', WARM_LINE],
    ['brief', 'Briefslump', BRIEF_LINE],
    ['far', 'Coldstar', COLD_LINE],
    ['aging', 'Agingregular', null],
    ['prime', 'Primeregular', null],
  ];
  for (const [key, last, season] of incumbents) {
    const c = CASE[key];
    man(c.incumbent, 'Big', last, c.age, c.pos, ORG, [c.grade, c.grade]);
    status.run(c.incumbent, 6 * 172);
    if (season) line(c.incumbent, ORG, 1, season);
  }

  // Double-A: an ordinary field, and a hot bat at each of the six spots
  for (let i = 0; i < 6; i++) {
    const id = 8400 + i;
    man(id, 'Doubles', `Average${i}`, 24, 4, AA, [35, 40]);
    line(id, AA, 3, AA_AVERAGE);
  }
  for (const [key, c] of Object.entries(CASE)) {
    man(c.prospect, 'Hot', key[0].toUpperCase() + key.slice(1), 21, c.pos, AA, [41, 43]);
    line(c.prospect, AA, 3, HOT_LINE);
  }

  /*
   * Single-A: four men at a .693 OPS and one at .814, so the level average is
   * .717 and his edge is .097 — past the .075 the promotion signal asks for,
   * short of the .100 the reason used to wait for. Everyone is the same age,
   * and his grade is ten points under his ceiling, so nothing else is said.
   */
  for (let i = 0; i < 4; i++) {
    const id = 8500 + i;
    man(id, 'Singles', `Average${i}`, 24, 4, LOW_A, [35, 40]);
    line(id, LOW_A, 4, LOW_A_AVERAGE);
  }
  // The big club has no designated hitter, so nobody stands in his way
  man(QUIET, 'Quiet', 'Case', 24, DH, LOW_A, [40, 50]);
  line(QUIET, LOW_A, 4, QUIET_LINE);
});

interface Row {
  player_id: number;
  name: string;
  signal: string | null;
  reasons: string[];
  move: {
    replaces: { name: string } | null;
    blocked: boolean;
    note: string;
  } | null;
}

const farm = async (): Promise<Row[]> => {
  const d = await request(`/api/prospects/${ORG}`);
  return [...(d.batters ?? []), ...(d.pitchers ?? [])] as Row[];
};

const find = async (id: number): Promise<Row> => {
  const row = (await farm()).find((r) => r.player_id === id);
  expect(row, `player ${id} never reached the farm page`).toBeDefined();
  return row!;
};

describe('the fixture', () => {
  it('reads the incumbents\' seasons the way the contracts page does', () => {
    // If these do not hold, the cases below are testing something else
    const form = seasonFormByPlayer(ORG);
    expect(form.get(CASE.cold.incumbent)?.verdict, 'the reported line was not read as poor').toBe('poor');
    expect(form.get(CASE.warm.incumbent)?.verdict).toBe('good');
    expect(form.get(CASE.brief.incumbent)?.verdict, 'forty trips were treated as a sample').toBe('unknown');
    expect(form.get(CASE.far.incumbent)?.verdict).toBe('poor');
  });
});

describe('an old incumbent having a poor season', () => {
  it('does not block a hot bat graded fifteen points under him', async () => {
    const him = await find(CASE.cold.prospect);
    expect(him.signal, 'blocked by a man the rest of the app calls cold').toBe('promote');
    expect(him.move?.blocked).toBe(false);
    expect(him.move?.replaces?.name).toBe('Big Veteran');
  });

  it('says why, with the line and the age', async () => {
    /*
     * Two pages that disagree about a man are only reconciled by saying what
     * this one now knows: the grade is still printed, and so is the season
     * that overrules it.
     */
    const him = await find(CASE.cold.prospect);
    expect(him.move?.note).toBe(
      "would take Big Veteran's spot at 3B — Big Veteran grades 56 to his 41, " +
      'but is hitting .198/.301/.385 this year and is 37'
    );
  });
});

describe('the same incumbent having a good season', () => {
  it('still blocks him, on the grade', async () => {
    const him = await find(CASE.warm.prospect);
    expect(him.signal).toBe('blocked');
    expect(him.move?.note).toBe('blocked at 1B — Big Warmveteran grades 56 to his 41');
  });
});

describe('a bad fortnight', () => {
  it('is not a season, so the grade still stands', async () => {
    // Forty trips of .139 would be a slump on any card; it is not evidence yet
    const him = await find(CASE.brief.prospect);
    expect(him.signal).toBe('blocked');
  });
});

describe('a cold incumbent far ahead on the grade', () => {
  it('still blocks him: a slump does not make up twenty-three points', async () => {
    /*
     * Juan Macero, a Single-A third baseman graded 33 with a .924 OPS, sat
     * behind the same cold Max Muncy. A slump says something about a 56; it
     * does not say a 33 is ready to take his place.
     */
    const him = await find(CASE.far.prospect);
    expect(him.signal).toBe('blocked');
    expect(him.move?.note).toMatch(/^blocked at CF/);
  });
});

describe('an incumbent of thirty-three or more', () => {
  it('does not block a man within ten points of him', async () => {
    const him = await find(CASE.aging.prospect);
    expect(him.signal).toBe('promote');
    expect(him.move?.note).toBe(
      "would take Big Agingregular's spot at LF — Big Agingregular grades 48 to his 41, but is 34"
    );
  });

  it('is where the line is drawn: the same gap from a man of thirty-two blocks', async () => {
    const him = await find(CASE.prime.prospect);
    expect(him.signal).toBe('blocked');
  });
});

describe('a promotion', () => {
  it('always says why', async () => {
    /*
     * The signal fired at .075 of OPS over the level and the reason was only
     * written from .100, so a man in between carried PROMOTE beside an empty
     * Why — the app asserting something and showing nothing for it.
     */
    const him = await find(QUIET);
    expect(him.signal).toBe('promote');
    expect(him.reasons, 'promoted with no reason given').not.toHaveLength(0);
    expect(him.reasons.join('; ')).toMatch(/^OPS 0\.814 vs level avg 0\.717/);
  });

  it('leaves no badge of any kind beside an empty Why', async () => {
    for (const row of await farm()) {
      if (row.signal === null) continue;
      expect(row.reasons.length, `${row.name} carried ${row.signal} with nothing in Why`).toBeGreaterThan(0);
    }
  });
});

describe('a save on the 1-to-5 scale', () => {
  /*
   * Last in the file, because it moves the whole save onto another scale. The
   * cut-offs on this page were 20-80 points, so on 1-to-5 every man sat within
   * five of his ceiling and read "near ceiling — development mostly done", and
   * no gap could ever reach the fifteen that "high remaining upside" asked.
   */
  beforeAll(() => {
    db.exec(`UPDATE players_batting SET batting_ratings_overall_contact = 3,
                                        batting_ratings_overall_power = 3`);
    db.exec(`UPDATE players_pitching SET pitching_ratings_overall_stuff = 3`);
    clearScaleCache();
    const grade = db.prepare(`UPDATE players_value SET oa = ?, pot = ? WHERE player_id = ?`);
    // A whole grade of growth left: sixteen points on 20-80
    grade.run(3, 4, CASE.warm.prospect);
    // None left at all
    grade.run(3, 3, CASE.brief.prospect);
    // One grade apart, and two, behind the same cold veterans as before
    grade.run(3, 3, CASE.cold.prospect);
    grade.run(4, 4, CASE.cold.incumbent);
    grade.run(3, 3, CASE.far.prospect);
    grade.run(5, 5, CASE.far.incumbent);
  });

  it('is read as one', () => {
    expect(ratingScaleMax()).toBe(5);
  });

  it('keeps "near ceiling" for a man who is at it, and only for him', async () => {
    expect((await find(CASE.brief.prospect)).reasons).toContain('near ceiling — development mostly done');
    expect((await find(CASE.warm.prospect)).reasons).not.toContain('near ceiling — development mostly done');
  });

  it('can see upside again', async () => {
    expect((await find(CASE.warm.prospect)).reasons).toContain('high remaining upside');
  });

  it('measures a slump\'s reach on the same scale', async () => {
    // One grade on 1-to-5 is sixteen points on 20-80, inside twenty; two is thirty-two
    expect((await find(CASE.cold.prospect)).signal).toBe('promote');
    expect((await find(CASE.far.prospect)).signal).toBe('blocked');
  });
});
