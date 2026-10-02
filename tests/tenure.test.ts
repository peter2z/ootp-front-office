import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS, SEASON } from './fixture.js';

/**
 * Your tenure, and the season OOTP leaves blank.
 *
 * "2026 shows 0-0 .000 — Won it all; the season table shows 100-62. The 130-70
 * total omits it." Read off a real save, where the Franchise page's own
 * "Your Tenure" card contradicted the table beneath it: a title won in no
 * games, and a total that left the year out.
 *
 * The season was never missing from the rows the route reads. OOTP writes the
 * manager's first season with his playoff flags and his club's finances filled
 * in and his own record at zero — 0 games, 0-0, .000, a first-place finish —
 * while the club's history row for the same year holds the 162 games it played.
 * So these do not test which rows are read. They test what the page is given
 * when the manager's own line is empty, and that it is never given a record that
 * somebody else earned.
 *
 * The fixture carries no manager history, so each test lays out the one it
 * needs. The route returns every row in the table, which is why they clear it
 * first rather than adding to what an earlier test left.
 */

const LAST_YEAR = SEASON - 1;

interface Season {
  year: number; g: number; w: number; l: number; pct: number | null; finish: number;
  madePlayoffs: boolean; wonPlayoffs: boolean; clubRecord: boolean;
}
interface Tenure {
  seasons: Season[];
  totals: { seasons: number; w: number; l: number; playoffs: number; titles: number; pct: number | null };
}
const tenure = (): Promise<Tenure> => request(`/api/tenure/${IDS.mlbTeam}`);

/** One season of the manager's own history, in the columns OOTP exports. */
interface Line {
  year: number; g: number; w: number; l: number; pos: number;
  made: number; won: number;
}

function layOut(lines: Line[]): void {
  db.exec(`DELETE FROM human_manager_history_record; DELETE FROM human_manager_history;`);
  const record = db.prepare(
    `INSERT INTO human_manager_history_record
       (human_manager_id, team_id, year, g, w, l, pos, pct, gb)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, 0)`
  );
  const flags = db.prepare(
    `INSERT INTO human_manager_history
       (human_manager_id, team_id, year, best_hitter_id, best_pitcher_id, best_rookie_id,
        made_playoffs, won_playoffs, fired)
     VALUES (1, ?, ?, 0, 0, 0, ?, ?, 0)`
  );
  for (const x of lines) {
    record.run(IDS.mlbTeam, x.year, x.g, x.w, x.l, x.pos, x.w + x.l > 0 ? x.w / (x.w + x.l) : 0);
    flags.run(IDS.mlbTeam, x.year, x.made, x.won);
  }
}

/** The club's own row for a finished year, which the Franchise page reads. */
function clubPlayed(year: number, w: number, l: number): void {
  db.prepare(`DELETE FROM team_history_record WHERE team_id = ? AND year = ?`).run(IDS.mlbTeam, year);
  db.prepare(`INSERT INTO team_history_record VALUES (?, ?, ?, ?, ?, ?, 1, 0)`)
    .run(IDS.mlbTeam, year, w + l, w, l, w / (w + l));
}

beforeAll(() => {
  // The columns OOTP's own schema lists for these two tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS human_manager_history_record (
      human_manager_id INTEGER, team_id INTEGER, year INTEGER, league_id INTEGER,
      sub_league_id INTEGER, division_id INTEGER, g INTEGER, w INTEGER, l INTEGER, pos INTEGER,
      pct REAL, gb REAL, streak INTEGER, magic_number INTEGER
    );
    CREATE TABLE IF NOT EXISTS human_manager_history (
      human_manager_id INTEGER, team_id INTEGER, year INTEGER, league_id INTEGER,
      sub_league_id INTEGER, division_id INTEGER, best_hitter_id INTEGER, best_pitcher_id INTEGER,
      best_rookie_id INTEGER, manager_id INTEGER, made_playoffs INTEGER, won_playoffs INTEGER,
      fired INTEGER, position_in_division INTEGER
    );
  `);
});

describe('a tenure whose first season OOTP left blank', () => {
  beforeAll(() => {
    // The shape of the save: a blank first year that won the title, then a
    // season in progress. The club's history row holds the first year's games.
    layOut([
      { year: LAST_YEAR, g: 0, w: 0, l: 0, pos: 1, made: 1, won: 1 },
      { year: SEASON, g: 38, w: 21, l: 17, pos: 1, made: 0, won: 0 },
    ]);
    clubPlayed(LAST_YEAR, 100, 62);
  });

  it('lists both seasons', async () => {
    const t = await tenure();
    expect(t.seasons.map((s) => s.year)).toEqual([LAST_YEAR, SEASON]);
  });

  it('gives the first season the record the club played', async () => {
    const first = (await tenure()).seasons[0];
    // 0-0 .000 beside "Won it all" was the fault
    expect(first.w).toBe(100);
    expect(first.l).toBe(62);
    expect(first.g).toBe(162);
    expect(first.pct).toBeCloseTo(100 / 162, 3);
    expect(first.finish).toBe(1);
  });

  it('keeps the season in progress exactly as his own row has it', async () => {
    const now = (await tenure()).seasons[1];
    expect([now.g, now.w, now.l]).toEqual([38, 21, 17]);
  });

  it('counts the first season in the total', async () => {
    /*
     * 100-62 and 21-17. The total was 21-17 plus an empty year, which is how a
     * three-season tenure read as a 130-70 that was missing a hundred wins.
     */
    const { totals } = await tenure();
    expect(totals.seasons).toBe(2);
    expect(totals.w).toBe(121);
    expect(totals.l).toBe(79);
    expect(totals.pct).toBeCloseTo(121 / 200, 3);
  });

  it('still carries the title and the playoff trip', async () => {
    const t = await tenure();
    expect(t.seasons[0]).toMatchObject({ madePlayoffs: true, wonPlayoffs: true });
    expect(t.totals.titles).toBe(1);
    expect(t.totals.playoffs).toBe(1);
  });

  it('says it is the club record, so the page can say whose it is', async () => {
    // His own row has no games in it; the line is borrowed, and a borrowed line
    // that does not say so is a record he is being credited with in silence
    const t = await tenure();
    expect(t.seasons[0].clubRecord).toBe(true);
    expect(t.seasons[1].clubRecord).toBe(false);
  });
});

describe('a season the manager only part-ran', () => {
  it("keeps his own record rather than the club's whole year", async () => {
    /*
     * Hired in July: 40-30 in 70 games, on a club that went 90-72 over the
     * year. Only a season with no games under his name is blank, so this one
     * is his as recorded. Borrowing the club's year would credit him with the
     * 92 games somebody else managed.
     */
    layOut([{ year: LAST_YEAR, g: 70, w: 40, l: 30, pos: 2, made: 1, won: 0 }]);
    clubPlayed(LAST_YEAR, 90, 72);
    const s = (await tenure()).seasons[0];
    expect([s.g, s.w, s.l]).toEqual([70, 40, 30]);
    expect(s.clubRecord).toBe(false);
  });
});

describe('a season nobody has played', () => {
  it('stays 0-0 rather than borrowing a record that does not exist', async () => {
    /*
     * The first day of a new year: his row is there and empty, and the club has
     * no history row for it yet because the year is not over. There is nothing
     * to fill it from, and it must not be filled from anything else.
     */
    layOut([{ year: SEASON, g: 0, w: 0, l: 0, pos: 0, made: 0, won: 0 }]);
    db.prepare(`DELETE FROM team_history_record WHERE team_id = ? AND year = ?`).run(IDS.mlbTeam, SEASON);
    const t = await tenure();
    expect([t.seasons[0].w, t.seasons[0].l]).toEqual([0, 0]);
    expect(t.seasons[0].clubRecord).toBe(false);
    expect(t.totals.pct).toBeNull();
  });

  it('is not filled from a club row that has not played a game either', async () => {
    // Some exports carry a placeholder row for the year in progress
    clubPlayed(SEASON, 1, 1);
    db.prepare(`UPDATE team_history_record SET g = 0, w = 0, l = 0, pct = 0 WHERE team_id = ? AND year = ?`)
      .run(IDS.mlbTeam, SEASON);
    const s = (await tenure()).seasons[0];
    expect([s.g, s.w, s.l]).toEqual([0, 0, 0]);
    expect(s.clubRecord).toBe(false);
  });
});

describe('an export with no club history to fill from', () => {
  it('leaves a blank season blank and still answers', async () => {
    /*
     * The fill is a courtesy: where team_history_record is absent the page
     * gets what the manager's own table says, as it did before, and not a 500.
     */
    layOut([{ year: LAST_YEAR, g: 0, w: 0, l: 0, pos: 1, made: 1, won: 1 }]);
    db.exec(`ALTER TABLE team_history_record RENAME TO team_history_record_away`);
    try {
      const t = await tenure();
      expect(t.seasons).toHaveLength(1);
      expect([t.seasons[0].w, t.seasons[0].l]).toEqual([0, 0]);
      expect(t.seasons[0].clubRecord).toBe(false);
    } finally {
      db.exec(`ALTER TABLE team_history_record_away RENAME TO team_history_record`);
    }
  });

  it('has no tenure at all where OOTP kept no manager history', async () => {
    db.exec(`ALTER TABLE human_manager_history_record RENAME TO human_manager_history_record_away`);
    try {
      expect((await tenure()).seasons).toEqual([]);
    } finally {
      db.exec(`ALTER TABLE human_manager_history_record_away RENAME TO human_manager_history_record`);
    }
  });
});
