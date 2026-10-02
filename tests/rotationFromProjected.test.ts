import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * The rotation as the save projects it, and the day each man next starts.
 *
 * The Dodgers run six. The page took the first five slots of OOTP's projected
 * rotation and called that the rotation, so Tyler Glasnow — the sixth man, who
 * started on the 14th — was filed under "Starting depth: spot starters, long
 * men". "Next start" was worse: five days minus the days of rest, floored at
 * zero, which read Snell (seven days' rest), Sasaki (six) and Yamamoto (five)
 * all as "today". Three men cannot start the same game.
 *
 * `projected_starting_pitchers` already holds the answer, and it is a list by
 * GAME rather than by day: starter_0 is whoever pitches the club's next game,
 * starter_1 the one after, and a rotation simply comes round again. The
 * Dodgers' real row is Snell, Sasaki, Yamamoto, Wrobleski, Ohtani, Glasnow,
 * Snell, Sasaki; the thirty-one other major-league clubs in that save read
 * A B C D E A B C. So the rotation is the distinct names in it, and a man's
 * next start is the date of the game his first slot falls on — which is the
 * club's schedule, off days and all, rather than a count of days.
 *
 * Rest and the pitch counts below are the real ones from that save.
 */

/** The league has moved on to the fifteenth; the last game played was the fourteenth. */
const LEAGUE_TODAY = '2028-5-15';

// Deliberately not in id order, so an order that came from anywhere but the
// projection would show
const FIRST = 9104;
const SECOND = 9101;
const THIRD = 9105;
const FOURTH = 9100;
const FIFTH = 9103;
const SIXTH = 9102;
const ROTATION = [FIRST, SECOND, THIRD, FOURTH, FIFTH, SIXTH];

/** Eight games on eight straight days, the first of them today. */
const EVERY_DAY = [
  '2028-5-15', '2028-5-16', '2028-5-17', '2028-5-18',
  '2028-5-19', '2028-5-20', '2028-5-21', '2028-5-22',
];

beforeAll(() => {
  db.prepare(`UPDATE leagues SET "current_date" = ? WHERE league_id = ?`).run(LEAGUE_TODAY, IDS.league);

  const arm = db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Rotation', ?, 27, 1, 11, 1, 1, ?, ?, ?, 0, 0, 0, 0)`
  );
  const status = db.prepare(
    `INSERT INTO players_roster_status
       (player_id, is_active, is_on_dl, is_on_dl60, is_on_secondary,
        mlb_service_years, mlb_service_days, mlb_service_days_this_year)
     VALUES (?, 1, 0, 0, 0, 3.0, 516, 40)`
  );
  const game = db.prepare(
    `INSERT INTO games (game_id, home_team, away_team, date, played, league_id, game_type)
     VALUES (?, ?, ?, ?, 1, ?, 0)`
  );
  const started = db.prepare(
    `INSERT INTO players_game_pitching_stats (player_id, game_id, pi, outs, gs) VALUES (?, ?, ?, ?, 1)`
  );

  // The last turn through the rotation, with the club's day off on the 12th.
  // Snell, Sasaki and Yamamoto have seven, six and five days of rest today.
  const turn: Array<[game: number, date: string, man: number, last: string, pitches: number, outs: number]> = [
    [8700, '2028-5-8', FIRST, 'First', 101, 17],
    [8701, '2028-5-9', SECOND, 'Second', 95, 19],
    [8702, '2028-5-10', THIRD, 'Third', 74, 10],
    [8703, '2028-5-11', FOURTH, 'Fourth', 60, 12],
    [8704, '2028-5-13', FIFTH, 'Fifth', 98, 20],
    [8705, '2028-5-14', SIXTH, 'Sixth', 94, 14],
  ];
  for (const [id, date, man, last, pitches, outs] of turn) {
    arm.run(man, last, man % 100, IDS.mlbTeam, IDS.mlbTeam);
    status.run(man);
    game.run(id, IDS.mlbTeam, IDS.otherMlbTeam, date, IDS.league);
    started.run(man, id, pitches, outs);
  }
});

/** The projection, padded with the empty slots OOTP writes. */
function project(...ids: number[]): void {
  db.prepare(`DELETE FROM projected_starting_pitchers WHERE team_id = ?`).run(IDS.mlbTeam);
  const slots = [...ids, ...Array(8 - ids.length).fill(0)];
  db.prepare(`INSERT INTO projected_starting_pitchers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(IDS.mlbTeam, ...slots);
}

let gameId = 8800;
/** The club's games still to play, one per date given; anything already played stays. */
function schedule(dates: string[]): void {
  db.prepare(`DELETE FROM games WHERE played = 0 AND (home_team = ? OR away_team = ?)`)
    .run(IDS.mlbTeam, IDS.mlbTeam);
  const upcoming = db.prepare(
    `INSERT INTO games (game_id, home_team, away_team, date, played, league_id, game_type)
     VALUES (?, ?, ?, ?, 0, ?, 0)`
  );
  for (const date of dates) upcoming.run(gameId++, IDS.mlbTeam, IDS.otherMlbTeam, date, IDS.league);
}

// Every test starts from the Dodgers' own shape and bends one thing
beforeEach(() => {
  // Snell, Sasaki, Yamamoto, Wrobleski, Ohtani, Glasnow, and round again
  project(FIRST, SECOND, THIRD, FOURTH, FIFTH, SIXTH, FIRST, SECOND);
  schedule(EVERY_DAY);
});

interface Starter {
  player_id: number;
  name: string;
  slot: number | null;
  projected: boolean;
  daysRest: number | null;
  nextStartInDays: number | null;
}
interface Staff {
  rotation: Starter[];
  starterDepth: Starter[];
}

const staff = (): Promise<Staff> => request(`/api/pitching/${IDS.mlbTeam}`);
const nextStarts = async () => (await staff()).rotation.map((r) => r.nextStartInDays);

describe('a club that runs six starters', () => {
  it('keeps all six in the rotation, in the order the save gives them', async () => {
    const { rotation } = await staff();
    expect(rotation.map((r) => r.player_id)).toEqual(ROTATION);
    expect(rotation.map((r) => r.slot)).toEqual([1, 2, 3, 4, 5, 6]);
    // Eight slots in the list, six men in it: the cycle is not a bigger rotation
    expect(rotation.every((r) => r.projected)).toBe(true);
  });

  it('does not file the sixth man under depth', async () => {
    /*
     * Depth is for the starter who is in nobody's plan. The fixture has one
     * (Locked Up, a role-11 pitcher left out of the projection), and he is
     * the only man the page should be calling a spot starter.
     */
    const { starterDepth } = await staff();
    expect(starterDepth.map((r) => r.player_id)).toEqual([IDS.extended]);
    expect(starterDepth.map((r) => r.player_id)).not.toContain(SIXTH);
  });

  it('is still five when the save projects five', async () => {
    // The ordinary case, and the one the page used to be written for
    project(FIRST, SECOND, THIRD, FOURTH, FIFTH, FIRST, SECOND, THIRD);
    const { rotation, starterDepth } = await staff();
    expect(rotation.map((r) => r.player_id)).toEqual([FIRST, SECOND, THIRD, FOURTH, FIFTH]);
    expect(starterDepth.map((r) => r.player_id)).toContain(SIXTH);
    expect(await nextStarts()).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('the day each man next starts', () => {
  it('counts games from the first one tonight, not days of rest', async () => {
    /*
     * The same rest the report saw. Five days minus seven, six and five all
     * floor at zero, so the first three men read "today" — and the sixth man,
     * on one day of rest, was not in the rotation to be asked.
     */
    const { rotation } = await staff();
    expect(rotation.map((r) => r.daysRest)).toEqual([7, 6, 5, 4, 2, 1]);
    expect(rotation.map((r) => r.nextStartInDays)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('is his first slot in the list, not the one where it comes round to him again', async () => {
    // Slots six and seven are the first two men again, which is not a later start
    const { rotation } = await staff();
    expect(rotation[0].nextStartInDays).toBe(0);
    expect(rotation[1].nextStartInDays).toBe(1);
  });

  it('skips an off day instead of counting it', async () => {
    /*
     * The club is idle on the 18th. The next game after the third man's is on
     * the 19th, so the fourth man starts four days out and not three, and
     * everyone behind him moves with him.
     */
    schedule([
      '2028-5-15', '2028-5-16', '2028-5-17',
      '2028-5-19', '2028-5-20', '2028-5-21', '2028-5-22', '2028-5-23',
    ]);
    expect(await nextStarts()).toEqual([0, 1, 2, 4, 5, 6]);
  });

  it('starts everyone a day later when the club is off today', async () => {
    // The league is on the 15th and the next game is the 16th: nobody is "today"
    schedule([
      '2028-5-16', '2028-5-17', '2028-5-18', '2028-5-19',
      '2028-5-20', '2028-5-21', '2028-5-22', '2028-5-23',
    ]);
    expect(await nextStarts()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('puts both halves of a doubleheader on the same day', async () => {
    schedule([
      '2028-5-15', '2028-5-15', '2028-5-16', '2028-5-17',
      '2028-5-18', '2028-5-19', '2028-5-20', '2028-5-21',
    ]);
    expect(await nextStarts()).toEqual([0, 0, 1, 2, 3, 4]);
  });

  it('is blank for a man whose turn comes after the last game on the schedule', async () => {
    // Three games left in the year; the last three men do not start again
    schedule(['2028-5-15', '2028-5-16', '2028-5-17']);
    expect(await nextStarts()).toEqual([0, 1, 2, null, null, null]);
  });

  it('is blank for everyone once the club has no games left', async () => {
    // The schedule is there and it is finished, which is not the same as no schedule
    schedule([]);
    expect(await nextStarts()).toEqual([null, null, null, null, null, null]);
  });

  it('falls back to a game a day when the export has no schedule for the club', async () => {
    const rows = db.prepare(`SELECT * FROM games`).all() as Array<Record<string, unknown>>;
    db.prepare(`DELETE FROM games WHERE home_team = ? OR away_team = ?`).run(IDS.mlbTeam, IDS.mlbTeam);
    try {
      expect(await nextStarts()).toEqual([0, 1, 2, 3, 4, 5]);
    } finally {
      const cols = Object.keys(rows[0]);
      const restore = db.prepare(
        `INSERT INTO games (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`
      );
      db.prepare(`DELETE FROM games`).run();
      for (const row of rows) restore.run(row);
    }
  });
});

describe('an export with no projected starters in it', () => {
  it('still answers, with no rotation to name', async () => {
    /*
     * The table is not in every export. The page asked for it unguarded, so a
     * save without it was a 500 and not a rotation page with nothing on it.
     */
    db.exec('ALTER TABLE projected_starting_pitchers RENAME TO projected_starting_pitchers_aside');
    try {
      const { rotation, starterDepth } = await staff();
      expect(rotation).toEqual([]);
      // Nobody is projected, so everybody who starts is depth, and nobody has a date
      expect(starterDepth.map((r) => r.player_id).sort()).toEqual([...ROTATION, IDS.extended].sort());
      expect(starterDepth.every((r) => r.nextStartInDays === null && r.slot === null)).toBe(true);
    } finally {
      db.exec('ALTER TABLE projected_starting_pitchers_aside RENAME TO projected_starting_pitchers');
    }
  });
});

describe('a club with nobody on its staff', () => {
  it('answers in the same shape as a club with one', async () => {
    /*
     * The answer for a club with no pitchers left out starterDepth, tired and
     * injured, and the page reads starterDepth.length, which throws on
     * undefined. Comparing the keys rather than naming them means a field
     * added to the full answer has to be added to the empty one as well.
     * Tired and injured are counts in both.
     */
    const full = await request(`/api/pitching/${IDS.mlbTeam}`);
    const empty = await request(`/api/pitching/${IDS.aaaTeam}`);
    expect(Object.keys(empty).sort()).toEqual(Object.keys(full).sort());
    expect(empty.rotation).toEqual([]);
    expect(empty.starterDepth).toEqual([]);
    expect(empty.bullpen).toEqual([]);
    expect(empty.tired).toBe(0);
    expect(empty.injured).toBe(0);
  });
});
