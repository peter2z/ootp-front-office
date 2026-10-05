import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db, tableColumns } from '../server/db.js';
import { importState, runImport } from '../server/api.js';
import { clearValuationCaches } from '../server/valuation.js';
import { clearTradeCache } from '../server/trade.js';
import { clearScoutingCache, scoutingReport } from '../server/playerfile.js';
import { clearBattedBallCache, contactLeague, contactProfiles } from '../server/battedball.js';
import { clearOrgCache, latestStatsYear } from '../server/org.js';
import { clearPlanCache } from '../server/planner.js';
import { setPlanLeagueSave } from '../server/plandecisions.js';
import request, { post } from './request.js';
import { IDS } from './fixture.js';
import { PLAN, PLAN_MEN, seedPlannerOrg } from './plannerFixture.js';

/**
 * What the server remembers must not outlive the league it was learned from.
 *
 * "Some caches survive a re-import or a save switch." Four did, and all four
 * fail the same quiet way: a figure measured on the old league goes on being
 * served for the new one until the app is restarted. The trade desk's idea of
 * the median major-league starter, the peer groups a scouting percentile is
 * ranked against, the batted-ball buckets and the farm pages' choice of grade
 * column were each held in memory, and the import cleared only the other caches.
 *
 * Two kinds of case. The first reads a figure, changes the data under it, and
 * checks the figure is still the old one until the reset is called and the new
 * one after — which is what makes the reset worth having, and stops the case
 * passing on a figure that was never cached at all. The second is the part that
 * was actually missing: a real re-import of a CSV export, with nobody clearing
 * anything by hand, after which every one of those figures has to have moved.
 *
 * The league date in /status rides along. It is read fresh on every request
 * rather than remembered, and the header would be worse than useless if it ever
 * began to be: a date that does not move after a sim is exactly the number a
 * manager checks the app against.
 */

const CLUB = 9501;
/** Where the league's other starters pitch, so that none of them joins CLUB's rotation. */
const ARMS_CLUB = 9502;
/** CLUB's seven starters: a rotation of five, and two the trade desk judges against the median. */
const STARTERS = Array.from({ length: 7 }, (_, i) => 9510 + i);
/** Sixty starters on the other club, which is what sets the median: they outnumber everybody else. */
const PITCHERS = Array.from({ length: 60 }, (_, i) => 9600 + i);
/** A hitter whose contact is ranked against forty others, on the fixture's other club. */
const SUBJECT = 9520;
const PEERS = Array.from({ length: 40 }, (_, i) => 9700 + i);

/** Where the arms sit before the league changes, and after: a weak league, then a strong one. */
const WEAK = 100;
const STRONG = 1500;

const clearEverything = (): void => {
  clearValuationCaches();
  clearTradeCache();
  clearScoutingCache();
  clearBattedBallCache();
  clearOrgCache();
  clearPlanCache();
};

/**
 * The league as it stands before anything is re-imported, with every cache cold.
 *
 * Clubs of their own, so the median is under the case's control rather than at
 * the mercy of however many men the fixture happens to carry: sixty starters
 * valued at 100 outweigh everybody else, so the median starter sits at 100
 * until they are moved.
 */
function arrange(): void {
  for (const table of ['players', 'players_value', 'players_batting', 'players_roster_status']) {
    db.prepare(`DELETE FROM ${table} WHERE player_id >= 9500`).run();
  }
  db.prepare(`DELETE FROM teams WHERE team_id IN (?, ?)`).run(CLUB, ARMS_CLUB);
  const team = db.prepare(
    `INSERT INTO teams (team_id, name, nickname, abbr, level, league_id, sub_league_id,
                        division_id, parent_team_id, allstar_team, human_team)
     VALUES (?, ?, 'Club', ?, 1, ?, 0, 0, 0, 0, 0)`
  );
  team.run(CLUB, 'Cache', 'CCH', IDS.league);
  team.run(ARMS_CLUB, 'Arms', 'ARM', IDS.league);

  const player = db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Cache', ?, 27, ?, 0, 1, 1, 0, ?, ?, 0, 0, 0, 0)`
  );
  // Named columns: the table is rebuilt from CSV by the last case, and a
  // positional insert would then depend on the order the dump happened to use
  const value = db.prepare(
    `INSERT INTO players_value (player_id, overall_value, talent_value, oa_rating, pot_rating)
     VALUES (?, ?, ?, 50, 50)`
  );
  const bat = db.prepare(
    `INSERT INTO players_batting (player_id, batting_ratings_overall_contact,
       batting_ratings_overall_gap, batting_ratings_overall_power, batting_ratings_overall_eye,
       batting_ratings_overall_strikeouts)
     VALUES (?, ?, 40, 40, 40, 40)`
  );

  // The trade desk reads only men with a roster place, and a starter is a
  // pitcher in the starter's role
  const starterRole = db.prepare(`UPDATE players SET role = 11 WHERE player_id = ?`);
  const rostered = db.prepare(
    `INSERT INTO players_roster_status
       (player_id, is_active, is_on_dl, is_on_dl60, is_on_secondary,
        mlb_service_years, mlb_service_days, mlb_service_days_this_year)
     VALUES (?, 1, 0, 0, 1, 3.0, 516, 40)`
  );
  const addStarter = (id: number, team: number, overall: number): void => {
    player.run(id, `Arm${id}`, 1, team, team);
    starterRole.run(id);
    rostered.run(id);
    value.run(id, overall, overall);
  };
  // 1,100 down to 1,040. The sixth and seventh are spare only while they are
  // better than the median starter, so whether the club has a starter to offer
  // turns on nothing but the median
  STARTERS.forEach((id, i) => addStarter(id, CLUB, 1100 - 10 * i));
  for (const id of PITCHERS) addStarter(id, ARMS_CLUB, WEAK);

  // A hitter at 60 among forty at 40, and the twelve fifties the fixture has
  player.run(SUBJECT, 'Subject', 7, IDS.otherMlbTeam, IDS.otherMlbTeam);
  bat.run(SUBJECT, 60);
  for (const id of PEERS) {
    player.run(id, `Peer${id}`, 7, IDS.otherMlbTeam, IDS.otherMlbTeam);
    bat.run(id, 40);
  }

  // Twenty batted balls at 90 mph, half of them falling in for a single. The
  // table is in a real export and not in the fixture
  db.exec(`DROP TABLE IF EXISTS players_at_bat_batting_stats`);
  db.exec(
    `CREATE TABLE players_at_bat_batting_stats (
       player_id INTEGER, team_id INTEGER, exit_velo REAL, launch_angle REAL,
       sprint_speed REAL, result INTEGER
     )`
  );
  const ball = db.prepare(`INSERT INTO players_at_bat_batting_stats VALUES (?, ?, 90, 15, 27, ?)`);
  // 6 is a single and 4 a ground out, in the codes battedball.ts reads
  for (let i = 0; i < 20; i += 1) ball.run(SUBJECT, IDS.otherMlbTeam, i % 2 === 0 ? 6 : 4);

  db.prepare(`UPDATE leagues SET "current_date" = '2030-06-01'`).run();
  db.prepare(`UPDATE teams SET human_team = 1 WHERE team_id = ?`).run(IDS.mlbTeam);
  clearEverything();
}

/** The league gets stronger: every starter on the other club is worth `value` now. */
const setArms = (value: number): void => {
  db.prepare(`UPDATE players_value SET overall_value = ? WHERE player_id IN (${PITCHERS.join(',')})`)
    .run(value);
};

/** Which positions the trade desk thinks the club has depth at. */
const surplus = async (): Promise<string[]> =>
  (await request(`/api/trade/fits/${CLUB}`)).mySurplus.map(
    (s: { positionName: string }) => s.positionName
  );

const contactTool = () => scoutingReport(SUBJECT, false).tools.find((t) => t.label === 'Contact');

const expectedAverage = () => contactProfiles([SUBJECT]).get(SUBJECT)?.xba;

/** What the depth chart quotes for the injured star: OOTP's own grade for him. */
const gradeOnChart = async (): Promise<number> => {
  const chart = await request(`/api/depth-chart/${IDS.mlbTeam}`);
  return chart.players.find((p: { player_id: number }) => p.player_id === IDS.injured).cur;
};

/** A save that carries only the rounded grades, which is every first run before an import. */
const dropExactGrades = (): void => {
  for (const column of ['oa', 'pot']) {
    if (tableColumns('players_value').includes(column)) {
      db.exec(`ALTER TABLE players_value DROP COLUMN ${column}`);
    }
  }
};

/** A re-export that now has them: 62 for the injured star, whom OOTP would round to 60. */
const addExactGrades = (): void => {
  db.exec(`ALTER TABLE players_value ADD COLUMN oa REAL`);
  db.exec(`ALTER TABLE players_value ADD COLUMN pot REAL`);
  db.exec(`UPDATE players_value SET oa = oa_rating, pot = pot_rating`);
  db.prepare(`UPDATE players_value SET oa = 62, pot = 62 WHERE player_id = ?`).run(IDS.injured);
};

describe('the median the trade desk judges a spare starter against', () => {
  /*
   * A sixth or seventh starter is only offered if he is better than the median
   * major-league starter, so a median measured on the old league decides it
   * wrongly for the new one. Here the league gets stronger: two men who were
   * comfortably above the median are now merely ordinary.
   */
  it('is measured again once the import has reset it', async () => {
    arrange();
    expect(await surplus(), 'the sixth and seventh starters should be spare against a median of 100').toContain('SP');

    setArms(STRONG);
    // What an import already did before this was fixed: the player values themselves
    clearValuationCaches();
    expect(
      await surplus(),
      'the old median was not remembered, so there is nothing for the reset to do'
    ).toContain('SP');

    clearTradeCache();
    expect(await surplus()).not.toContain('SP');
  });
});

describe('the peers a scouting rank is taken against', () => {
  /*
   * "A grade of 50 came out 99th": the report ranks a man against the players
   * at his level, and the group is sorted once and kept. A save switch ranked
   * the new league's hitters against the old one's.
   */
  it('are gathered again once the import has reset them', () => {
    arrange();
    expect(contactTool()?.good, 'a 60 among 40s should read as a strength').toBe(true);
    expect(contactTool()?.rank).toBeGreaterThanOrEqual(75);

    // Everybody else's contact goes to 80, so the same 60 is now the worst in the league
    db.prepare(`UPDATE players_batting SET batting_ratings_overall_contact = 80 WHERE player_id != ?`)
      .run(SUBJECT);
    expect(
      contactTool()?.good,
      'the old peers were not remembered, so there is nothing for the reset to do'
    ).toBe(true);

    clearScoutingCache();
    expect(contactTool()?.good).toBe(false);
    expect(contactTool()?.rank).toBeLessThanOrEqual(25);
  });
});

describe('the batted-ball figures', () => {
  /*
   * Never called from anywhere: clearBattedBallCache existed, and nothing in
   * the import knew about it. Two things are kept — the league average that a
   * percentage is judged against, and the buckets that say what a ball struck
   * at a given speed and angle is usually worth — and both go with it.
   */
  it('forgets the league average once the import has reset it', () => {
    arrange();
    expect(contactLeague()?.avgExitVelo).toBe(90);

    db.prepare(`UPDATE players_at_bat_batting_stats SET exit_velo = 100`).run();
    expect(contactLeague()?.avgExitVelo, 'the old average was not remembered').toBe(90);

    clearBattedBallCache();
    expect(contactLeague()?.avgExitVelo).toBe(100);
  });

  it('forgets what a ball like his is worth once the import has reset it', () => {
    arrange();
    // Half of balls struck like his fall in
    expect(expectedAverage()).toBe(0.5);

    // The same balls, struck the same way, now all turn into outs
    db.prepare(`UPDATE players_at_bat_batting_stats SET result = 4`).run();
    expect(expectedAverage(), 'the old buckets were not remembered').toBe(0.5);

    clearBattedBallCache();
    expect(expectedAverage()).toBe(0);
  });
});

describe('the grade the farm pages read', () => {
  /*
   * "Prefer OOTP's exact grade; fall back when a save only carries the rounded
   * one" was decided when the module loaded. On a first run that is an empty
   * database, so the rounded grade was chosen and kept: after the first import
   * the depth chart quoted 60 for a man OOTP shows as 62, until the app was
   * restarted. A save switch kept the previous save's choice just the same.
   */
  it('is chosen again once the import has reset it', async () => {
    arrange();
    dropExactGrades();
    expect(await gradeOnChart(), 'with no exact grade to read, the rounded one is all there is').toBe(60);

    addExactGrades();
    expect(await gradeOnChart(), 'the old choice was not remembered').toBe(60);

    clearOrgCache();
    expect(await gradeOnChart()).toBe(62);
  });
});

describe('the latest season the stats tables carry', () => {
  /*
   * "This season" is MAX(year) over the career stats, and on a save without a
   * year index that was a scan of the whole table each time it was asked — once
   * per club by the planner. It is now read once and kept until the import
   * resets the org cache, so a re-export that opens a new season has to drop it.
   */
  it('is read again once the import has reset it', () => {
    arrange();
    const before = latestStatsYear();
    expect(before.batting, 'the fixture carries batting lines').not.toBeNull();
    const next = Math.max(before.batting!, before.pitching ?? 0) + 1;
    const add = db.prepare(
      `INSERT INTO players_career_batting_stats (player_id, year, team_id, league_id, level_id, split_id, pa)
       VALUES (?, ?, ?, ?, 1, 1, 1)`
    );
    try {
      add.run(SUBJECT, next, IDS.otherMlbTeam, IDS.league);
      expect(latestStatsYear(), 'the old answer was not remembered').toEqual(before);

      clearOrgCache();
      expect(latestStatsYear()).toEqual({ ...before, batting: next });
    } finally {
      db.prepare(`DELETE FROM players_career_batting_stats WHERE player_id = ? AND year = ?`).run(SUBJECT, next);
      clearOrgCache();
    }
  });
});

describe('the organisation plan', () => {
  /*
   * The plan is the dearest thing the server works out, and it is kept whole
   * until the next import: the moves, the rung baselines they were judged
   * against and the OOTP steps. A plan drawn on the old export would go on
   * naming a man for a forced move after a re-import in which he is no longer
   * worth one, so the import has to drop it with the rest.
   */
  it('is drawn again once the import has reset it', async () => {
    arrange();
    seedPlannerOrg();
    const before = await forcedMoves();
    expect(before, 'the fixture org carries forced moves').toBeGreaterThan(0);

    // The man a service cap sends two steps up is now rated far below the
    // level that would take him, and a man like that is released instead
    regradeDown(PLAN_MEN.dslTwoStepsFit);
    clearValuationCaches();
    expect(await forcedMoves(), 'the old plan was not remembered, so there is nothing for the reset to do').toBe(before);

    clearPlanCache();
    expect(await forcedMoves()).toBe(before - 1);
  });

  /*
   * Choosing another save is not the end of an import but the start of one,
   * and the plan held in memory is the old save's from that moment: it must
   * not be served, decided on or retired against while the new save loads.
   */
  it('is dropped the moment another save is chosen, before its import has started', async () => {
    const configPath = path.join(process.env.OOTP_FO_DATA_DIR!, 'config.json');
    const savedConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null;
    try {
      arrange();
      seedPlannerOrg();
      const before = await forcedMoves();
      regradeDown(PLAN_MEN.dslTwoStepsFit);
      clearValuationCaches();
      expect(await forcedMoves(), 'the plan is held until something drops it').toBe(before);

      // A folder that is not there yet: the save is chosen and nothing is imported
      await post('/api/config', { csvDir: path.join(os.tmpdir(), 'ootp-fo-no-export-yet'), saveName: 'Another save' });
      expect(await forcedMoves()).toBe(before - 1);
    } finally {
      if (savedConfig === null) fs.rmSync(configPath, { force: true });
      else fs.writeFileSync(configPath, savedConfig);
      setPlanLeagueSave(null);
    }
  });
});

/** How many moves the plan forces on the fixture org. */
const forcedMoves = async (): Promise<number> => (await request(`/api/plan/${PLAN.org}`)).counts.forced;

/** OOTP's export of a man who has fallen apart: a 20 now, a 30 at best. */
const regradeDown = (id: number): void => {
  db.prepare(`UPDATE players_value SET oa = 20, pot = 30, oa_rating = 20, pot_rating = 30, overall_value = 400, talent_value = 600 WHERE player_id = ?`)
    .run(id);
};

describe('the league date in /status', () => {
  const dateNow = async (): Promise<string | null> => (await request('/api/status')).leagueDate;

  it('is the date inside the game, as yyyy-mm-dd', async () => {
    arrange();
    expect(await dateNow()).toBe('2030-06-01');
  });

  it('puts right the date OOTP writes unpadded, so it reads as a date', async () => {
    arrange();
    db.prepare(`UPDATE leagues SET "current_date" = '2030-7-4'`).run();
    expect(await dateNow()).toBe('2030-07-04');
  });

  it('is not remembered between requests, so it moves when the game does', async () => {
    arrange();
    expect(await dateNow()).toBe('2030-06-01');
    db.prepare(`UPDATE leagues SET "current_date" = '2030-06-02'`).run();
    expect(await dateNow()).toBe('2030-06-02');
  });

  it('is null, and not an error, for a league with no date', async () => {
    arrange();
    db.prepare(`UPDATE leagues SET "current_date" = NULL`).run();
    expect(await dateNow()).toBeNull();
  });

  it('is found without a managed club, from the first top-level one', async () => {
    arrange();
    db.prepare(`UPDATE teams SET human_team = 0`).run();
    expect(await dateNow()).toBe('2030-06-01');
  });
});

/**
 * The part that was missing. Nothing below calls a reset: the export is written
 * to disk, imported the way Refresh imports it, and every figure read before is
 * read again.
 *
 * It is a re-export of the same league a day on, so only the tables that matter
 * are written — the import replaces the tables it is given and leaves the rest.
 */
describe('a re-import', () => {
  let dir: string | undefined;
  /** What every figure read before the import, so each case can say what it moved from. */
  const before = {
    surplus: [] as string[],
    contactIsStrength: undefined as boolean | undefined,
    averageExitVelo: undefined as number | undefined,
    expectedAverage: undefined as number | null | undefined,
    grade: 0,
    date: null as string | null,
    forcedMoves: 0,
    pitchingYear: null as number | null,
  };

  /** A table as OOTP's export writes it: a header row, then a line per row. */
  const exportTable = (table: string, rows: Array<Record<string, unknown>>): void => {
    const columns = Object.keys(rows[0]);
    const cell = (v: unknown): string => {
      if (v === null || v === undefined) return '';
      const text = String(v);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [columns.join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))];
    fs.writeFileSync(path.join(dir!, `${table}.csv`), lines.join('\n'));
  };
  const rowsOf = (table: string) => db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;

  beforeAll(async () => {
    arrange();
    seedPlannerOrg();
    dropExactGrades();

    // Read everything once, so every cache holds the old league's answer — as
    // each does by the time anybody presses Refresh
    before.surplus = await surplus();
    before.contactIsStrength = contactTool()?.good;
    before.averageExitVelo = contactLeague()?.avgExitVelo;
    before.expectedAverage = expectedAverage();
    before.grade = await gradeOnChart();
    before.date = (await request('/api/status')).leagueDate;
    before.forcedMoves = await forcedMoves();
    before.pitchingYear = latestStatsYear().pitching;

    // The next day's export: stronger arms, harder contact, the exact grades
    // present, every other hitter in the league a good deal better than him,
    // and the man a cap sends two steps up now rated far below the level that would take him
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ootp-fo-reimport-'));
    const fallen = PLAN_MEN.dslTwoStepsFit;
    exportTable('players_value', rowsOf('players_value').map((r) => ({
      ...r,
      overall_value: PITCHERS.includes(r.player_id as number) ? STRONG : r.player_id === fallen ? 400 : r.overall_value,
      talent_value: r.player_id === fallen ? 600 : r.talent_value,
      oa_rating: r.player_id === fallen ? 20 : r.oa_rating,
      pot_rating: r.player_id === fallen ? 30 : r.pot_rating,
      oa: r.player_id === IDS.injured ? 62 : r.player_id === fallen ? 20 : r.oa_rating,
      pot: r.player_id === IDS.injured ? 62 : r.player_id === fallen ? 30 : r.pot_rating,
    })));
    exportTable('players_batting', rowsOf('players_batting').map((r) => ({
      ...r,
      batting_ratings_overall_contact: r.player_id === SUBJECT ? 60 : 80,
    })));
    exportTable('players_at_bat_batting_stats', rowsOf('players_at_bat_batting_stats').map((r) => ({
      ...r,
      exit_velo: 100,
      result: 4,
    })));
    exportTable('leagues', rowsOf('leagues').map((r) => ({ ...r, current_date: '2030-6-2' })));
    // One pitching line in the season after, thrown by a man outside the planner's org
    const pitching = rowsOf('players_career_pitching_stats');
    exportTable('players_career_pitching_stats', [
      ...pitching,
      { ...pitching[0], player_id: SUBJECT, team_id: IDS.otherMlbTeam, year: before.pitchingYear! + 1 },
    ]);

    await runImport(dir);
    expect(importState.lastError, 'the import itself failed').toBeNull();
  });

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("measures the trade desk's median again", async () => {
    expect(before.surplus).toContain('SP');
    expect(await surplus()).not.toContain('SP');
  });

  it("ranks a hitter against the new league's peers", () => {
    expect(before.contactIsStrength).toBe(true);
    expect(contactTool()?.good).toBe(false);
  });

  it('reads the new batted balls', () => {
    expect(before.averageExitVelo).toBe(90);
    expect(contactLeague()?.avgExitVelo).toBe(100);
    expect(before.expectedAverage).toBe(0.5);
    expect(expectedAverage()).toBe(0);
  });

  it('reads the exact grades the new export carries', async () => {
    expect(before.grade).toBe(60);
    expect(await gradeOnChart()).toBe(62);
  });

  it('shows the new league date', async () => {
    expect(before.date).toBe('2030-06-01');
    expect((await request('/api/status')).leagueDate).toBe('2030-06-02');
  });

  it('reads the latest season again', () => {
    expect(before.pitchingYear).not.toBeNull();
    expect(latestStatsYear().pitching).toBe(before.pitchingYear! + 1);
  });

  it('draws the organisation plan again', async () => {
    expect(before.forcedMoves).toBeGreaterThan(0);
    expect(await forcedMoves()).toBe(before.forcedMoves - 1);
  });
});
