import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * A third straight day, on the page that asks who can throw tonight.
 *
 * Nobody reported this one. It came out of reading the whole league instead of
 * one club: on the 15th of May 2028, eighteen relievers had pitched on both the
 * 13th and the 14th, and twelve of them read as a green "Available (N
 * yesterday)" — Jhoan Duran in Portland with 26 pitches over the two days,
 * Rowan Wick in San Francisco with 31, Spencer Schwellenbach in Atlanta with
 * 38, and nine more. The other six were flagged only because their pitch
 * counts tripped a rule that had nothing to do with it.
 *
 * The cause is the fix before this one. The page used to call the last game
 * played "today", a reader showed that every label was a day stale, and today
 * became the league's own date: the morning after the last game. That is right,
 * and it also means nobody can have pitched today, so the two rules that asked
 * ("Two straight" and "Would be back-to-back") could never fire again.
 * bullpenToday.test.ts checks that a man who threw yesterday is described as
 * having thrown yesterday, which he is; it never looked at the colour.
 *
 * Days in a row are counted back from the last game the league played. The
 * named relievers below are the real ones from that scan, with the pitch counts
 * it reported; where it gave only a total across the two days, the split is mine.
 *
 * Two neighbours are pinned here because they came out of the same change.
 * Back-to-back days are amber only from fifteen pitches up, since a six-pitch
 * appearance does not cost a reliever the next day; and "pitches in 3 days"
 * counts the three days before tonight's game, which the same fix had quietly
 * turned into two.
 */

/** The league has moved on to the fifteenth; the last games were the fourteenth. */
const LEAGUE_TODAY = '2028-5-15';

// Pitched on the 13th and the 14th
const TWO_STRAIGHT = 9800; // Duran: 14, then 12
// Two straight with the amber rules also in play, which must not hide the red
const TWO_STRAIGHT_HEAVY = 9801; // Liberatore: 13, then 36 — "36 pitches yesterday"
const TWO_STRAIGHT_BUSY = 9802; // Hess: 20, then 26 — "46 pitches in 3 days"
// Already red for his pitch count, which stays the reason given
const TWO_STRAIGHT_SPENT = 9803; // Keller: 35, then 37 — "72 pitches in 3 days"
// Two straight, with the last outing too light to be amber on its own
const TWO_STRAIGHT_LIGHT = 9804; // Ashby: 13, then 6
// The 12th, the 13th and the 14th: tonight would be the fourth
const THREE_STRAIGHT = 9805;
// Pitched on the 14th only: either side of the fifteen-pitch floor, and well over it
const YESTERDAY_ONLY = 9806; // 22
const AT_THE_FLOOR = 9807; // 15
const UNDER_THE_FLOOR = 9808; // 14
const YESTERDAY_LIGHT = 9809; // Munoz: 13
// Pitched on the 13th only
const DAY_BEFORE_ONLY = 9810; // Hodge: 27
// The 12th and the 14th, with a day off between them
const A_DAY_OFF_BETWEEN = 9811;
// The 12th and the 13th, and then rested through the last game
const BEFORE_THE_LAST_GAME = 9812;
// Pitched two straight, and is on the injured list now
const HURT_AND_WORKED = 9813;
// Three days before tonight, which is the oldest day "pitches in 3 days" counts
const THREE_DAYS_AGO = 9814; // the 12th only: 45
const THREE_DAYS_AGO_SPENT = 9815; // the 12th only: 55
const ADDS_UP_OVER_THREE_DAYS = 9816; // the 12th and the 14th: 30 and 12
// Four days before tonight, which it does not
const FOUR_DAYS_AGO = 9817; // the 11th only: 45
// Both ends of a doubleheader on the 14th, each light and together not
const DOUBLEHEADER = 9818; // 8, then 9

const GAME_11TH = 8799;
const GAME_12TH = 8800;
const GAME_13TH = 8801;
const GAME_14TH = 8802;
const GAME_14TH_LATE = 8803;

beforeAll(() => {
  db.prepare(`UPDATE leagues SET "current_date" = ? WHERE league_id = ?`).run(LEAGUE_TODAY, IDS.league);

  const game = db.prepare(
    `INSERT INTO games (game_id, home_team, away_team, date, played, league_id, game_type)
     VALUES (?, ?, ?, ?, 1, ?, 0)`
  );
  game.run(GAME_11TH, IDS.mlbTeam, IDS.otherMlbTeam, '2028-5-11', IDS.league);
  game.run(GAME_12TH, IDS.mlbTeam, IDS.otherMlbTeam, '2028-5-12', IDS.league);
  game.run(GAME_13TH, IDS.mlbTeam, IDS.otherMlbTeam, '2028-5-13', IDS.league);
  game.run(GAME_14TH, IDS.mlbTeam, IDS.otherMlbTeam, '2028-5-14', IDS.league);
  game.run(GAME_14TH_LATE, IDS.mlbTeam, IDS.otherMlbTeam, '2028-5-14', IDS.league);

  const arm = db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Relief', ?, 28, 1, 12, 1, 1, ?, ?, ?, 0, 0, 0, 0)`
  );
  const status = db.prepare(
    `INSERT INTO players_roster_status
       (player_id, is_active, is_on_dl, is_on_dl60, is_on_secondary,
        mlb_service_years, mlb_service_days, mlb_service_days_this_year)
     VALUES (?, ?, ?, ?, 0, 3.0, 516, 40)`
  );
  const threw = db.prepare(
    `INSERT INTO players_game_pitching_stats (player_id, game_id, pi, outs, gs) VALUES (?, ?, ?, 3, 0)`
  );

  /** One reliever on the club, and the games he worked: [game, pitches] pairs. */
  const pitcher = (id: number, last: string, outings: Array<[game: number, pitches: number]>, hurt = false) => {
    arm.run(id, last, id % 100, IDS.mlbTeam, IDS.mlbTeam);
    status.run(id, hurt ? 0 : 1, hurt ? 1 : 0, hurt ? 1 : 0);
    if (hurt) {
      db.prepare(`UPDATE players SET injury_is_injured = 1, injury_left = 30 WHERE player_id = ?`).run(id);
    }
    for (const [g, pitches] of outings) threw.run(id, g, pitches);
  };

  pitcher(TWO_STRAIGHT, 'TwoStraight', [[GAME_13TH, 14], [GAME_14TH, 12]]);
  pitcher(TWO_STRAIGHT_HEAVY, 'TwoStraightHeavy', [[GAME_13TH, 13], [GAME_14TH, 36]]);
  pitcher(TWO_STRAIGHT_BUSY, 'TwoStraightBusy', [[GAME_13TH, 20], [GAME_14TH, 26]]);
  pitcher(TWO_STRAIGHT_SPENT, 'TwoStraightSpent', [[GAME_13TH, 35], [GAME_14TH, 37]]);
  pitcher(TWO_STRAIGHT_LIGHT, 'TwoStraightLight', [[GAME_13TH, 13], [GAME_14TH, 6]]);
  pitcher(THREE_STRAIGHT, 'ThreeStraight', [[GAME_12TH, 10], [GAME_13TH, 11], [GAME_14TH, 12]]);
  pitcher(YESTERDAY_ONLY, 'YesterdayOnly', [[GAME_14TH, 22]]);
  pitcher(AT_THE_FLOOR, 'AtTheFloor', [[GAME_14TH, 15]]);
  pitcher(UNDER_THE_FLOOR, 'UnderTheFloor', [[GAME_14TH, 14]]);
  pitcher(YESTERDAY_LIGHT, 'YesterdayLight', [[GAME_14TH, 13]]);
  pitcher(DAY_BEFORE_ONLY, 'DayBeforeOnly', [[GAME_13TH, 27]]);
  pitcher(A_DAY_OFF_BETWEEN, 'DayOffBetween', [[GAME_12TH, 20], [GAME_14TH, 18]]);
  pitcher(BEFORE_THE_LAST_GAME, 'BeforeTheLastGame', [[GAME_12TH, 16], [GAME_13TH, 14]]);
  pitcher(HURT_AND_WORKED, 'HurtAndWorked', [[GAME_13TH, 14], [GAME_14TH, 12]], true);
  pitcher(THREE_DAYS_AGO, 'ThreeDaysAgo', [[GAME_12TH, 45]]);
  pitcher(THREE_DAYS_AGO_SPENT, 'ThreeDaysAgoSpent', [[GAME_12TH, 55]]);
  pitcher(ADDS_UP_OVER_THREE_DAYS, 'AddsUp', [[GAME_12TH, 30], [GAME_14TH, 12]]);
  pitcher(FOUR_DAYS_AGO, 'FourDaysAgo', [[GAME_11TH, 45]]);
  pitcher(DOUBLEHEADER, 'Doubleheader', [[GAME_14TH, 8], [GAME_14TH_LATE, 9]]);
});

interface Staff {
  today: number | null;
  bullpen: Array<{
    player_id: number;
    name: string;
    status: string;
    tone: 'ok' | 'warn' | 'bad';
    pitchesLast3: number;
    appearancesLast3: number;
  }>;
  tired: number;
}

const staff = (): Promise<Staff> => request(`/api/pitching/${IDS.mlbTeam}`);
const find = async (id: number) => {
  const s = await staff();
  const p = s.bullpen.find((b) => b.player_id === id);
  expect(p, `pitcher ${id} never reached the bullpen table`).toBeDefined();
  return p!;
};

/** Run something with the league on another date, and put it back afterwards. */
async function withLeagueDate<T>(date: string | null, work: () => Promise<T>): Promise<T> {
  db.prepare(`UPDATE leagues SET "current_date" = ? WHERE league_id = ?`).run(date, IDS.league);
  try {
    return await work();
  } finally {
    db.prepare(`UPDATE leagues SET "current_date" = ? WHERE league_id = ?`).run(LEAGUE_TODAY, IDS.league);
  }
}

describe('a reliever who pitched the last two days played', () => {
  it('is red: tonight would be his third straight day', async () => {
    // The shape of all twelve in the scan — small outings, nothing else to trip
    const him = await find(TWO_STRAIGHT);
    expect(him.tone, `read as "${him.status}"`).toBe('bad');
    expect(him.status).toMatch(/third straight day/i);
  });

  it('is red whatever his pitch count would have said on its own', async () => {
    /*
     * The amber rules sit further down the list, and a man must not be let off
     * by one of them. Thirty-six pitches yesterday is amber by itself, and so
     * is forty-six in three days; with a day before it, both are red.
     */
    const heavy = await find(TWO_STRAIGHT_HEAVY);
    expect(heavy.tone, `read as "${heavy.status}"`).toBe('bad');
    expect(heavy.status).toMatch(/third straight day/i);

    const busy = await find(TWO_STRAIGHT_BUSY);
    expect(busy.tone, `read as "${busy.status}"`).toBe('bad');
    expect(busy.status).toMatch(/third straight day/i);
  });

  it('is red however light the two outings were', async () => {
    /*
     * The fifteen-pitch floor is for the amber rule below, and this one has
     * none. Six of the eighteen in the scan threw fewer than fifteen pitches
     * on the 14th — Aaron Ashby threw six — and every one of them is on a
     * third day running.
     */
    const him = await find(TWO_STRAIGHT_LIGHT);
    expect(him.tone, `read as "${him.status}"`).toBe('bad');
    expect(him.status).toMatch(/third straight day/i);
  });

  it('keeps the pitch-count reason when he is already red for that', async () => {
    // Both are the same colour; the pitch-count rules are not ours to reword
    const him = await find(TWO_STRAIGHT_SPENT);
    expect(him.tone).toBe('bad');
    expect(him.status).toBe('72 pitches in 3 days');
  });

  it('is not called a third day when it would be the fourth', async () => {
    const him = await find(THREE_STRAIGHT);
    expect(him.tone).toBe('bad');
    expect(him.status).toMatch(/4th straight day/i);
  });

  it('is counted among the arms who are limited or unavailable', async () => {
    const s = await staff();
    expect(s.tired).toBe(s.bullpen.filter((b) => b.tone !== 'ok').length);
    expect(s.bullpen.find((b) => b.player_id === TWO_STRAIGHT)?.tone).not.toBe('ok');
  });
});

describe('a reliever who pitched in the last game only', () => {
  it('is amber from fifteen pitches up: going again tonight is back-to-back', async () => {
    /*
     * The thing the old "Would be back-to-back" rule was for. He used to read
     * as a green "Available (22 yesterday)", which is a different answer to a
     * different question — he is available, and he is also on consecutive days.
     * Fifteen itself is amber; the floor is "from", not "over".
     */
    const him = await find(YESTERDAY_ONLY);
    expect(him.tone, `read as "${him.status}"`).toBe('warn');
    expect(him.status).toBe('Pitched yesterday (22 pitches)');
    expect(him.status, 'the last game played was called today').not.toMatch(/today/);

    const edge = await find(AT_THE_FLOOR);
    expect(edge.tone, `read as "${edge.status}"`).toBe('warn');
    expect(edge.status).toBe('Pitched yesterday (15 pitches)');
  });

  it('is green below it: a light outing does not cost him the next day', async () => {
    /*
     * A reliever who got a batter or two out on six pitches has not been used
     * in any way that matters tomorrow, and an amber for every outing turned
     * the column amber after any night the pen was touched. Fourteen is the
     * other side of the floor; thirteen is Andres Munoz, who read "Available
     * (13 yesterday)" in green before any of this and does again.
     */
    const under = await find(UNDER_THE_FLOOR);
    expect(under.tone, `read as "${under.status}"`).toBe('ok');
    expect(under.status).toBe('Available (14 yesterday)');

    const light = await find(YESTERDAY_LIGHT);
    expect(light.tone, `read as "${light.status}"`).toBe('ok');
    expect(light.status).toBe('Available (13 yesterday)');
  });

  it('is judged on the whole day when he pitched in both ends of a doubleheader', async () => {
    // Eight and nine are each under the floor; seventeen on one day is not
    const him = await find(DOUBLEHEADER);
    expect(him.tone, `read as "${him.status}"`).toBe('warn');
    expect(him.status).toBe('Pitched yesterday (17 pitches)');
  });

  it('is not a third straight day when there was a day off in between', async () => {
    // The 12th and the 14th: tonight would be back-to-back, not a third day
    const him = await find(A_DAY_OFF_BETWEEN);
    expect(him.tone).toBe('warn');
    expect(him.status).toBe('Pitched yesterday (18 pitches)');
  });
});

describe('a reliever who pitched the day before the last game only', () => {
  it('is rested, and green', async () => {
    const him = await find(DAY_BEFORE_ONLY);
    expect(him.tone, `read as "${him.status}"`).toBe('ok');
    expect(him.status).toMatch(/2d/);
  });

  it('is not flagged for the two days before that', async () => {
    // Worked the 12th and the 13th and sat out the 14th: a day of rest
    const him = await find(BEFORE_THE_LAST_GAME);
    expect(him.tone, `read as "${him.status}"`).toBe('ok');
    expect(him.status).not.toMatch(/straight/i);
  });
});

describe('a reliever on the injured list who pitched the last two days', () => {
  it('is out, which outranks anything his workload says', async () => {
    // Injury is read first, as it was before any of this
    const him = await find(HURT_AND_WORKED);
    expect(him.tone).toBe('bad');
    expect(him.status).toMatch(/^Out/);
    expect(him.status).not.toMatch(/straight/i);
  });
});

describe('pitches in the last three days', () => {
  /*
   * "N pitches in 3 days" counted two. The window was today and the two days
   * before it, which was three days until today became the league's own date:
   * the day of the game that has not been played, on which nobody has pitched.
   * The three days that count are the ones before tonight — one, two and three
   * days back — so a man who threw on the 12th is still carrying it on the
   * night of the 15th.
   */
  it('counts a man who threw three days before tonight', async () => {
    const him = await find(THREE_DAYS_AGO);
    expect(him.tone, `read as "${him.status}"`).toBe('warn');
    expect(him.status).toBe('45 pitches in 3 days');

    const spent = await find(THREE_DAYS_AGO_SPENT);
    expect(spent.tone, `read as "${spent.status}"`).toBe('bad');
    expect(spent.status).toBe('55 pitches in 3 days');
  });

  it('adds that day to the other two', async () => {
    // Twelve pitches yesterday read as "Available (12 yesterday)" with the 12th left out
    const him = await find(ADDS_UP_OVER_THREE_DAYS);
    expect(him.tone, `read as "${him.status}"`).toBe('warn');
    expect(him.status).toBe('42 pitches in 3 days');
  });

  it('does not count the fourth day back', async () => {
    const him = await find(FOUR_DAYS_AGO);
    expect(him.tone, `read as "${him.status}"`).toBe('ok');
    expect(him.status).toBe('Rested 4d');
  });

  it('is the same window in the P/3d and App columns', async () => {
    // Those read the pitches and appearances the status does, and must agree with it
    const adds = await find(ADDS_UP_OVER_THREE_DAYS);
    expect([adds.pitchesLast3, adds.appearancesLast3]).toEqual([42, 2]);
    const old = await find(THREE_DAYS_AGO);
    expect([old.pitchesLast3, old.appearancesLast3]).toEqual([45, 1]);
    const run = await find(THREE_STRAIGHT);
    expect([run.pitchesLast3, run.appearancesLast3]).toEqual([33, 3]);
    const gone = await find(FOUR_DAYS_AGO);
    expect([gone.pitchesLast3, gone.appearancesLast3]).toEqual([0, 0]);
  });
});

describe('days in a row, when the league date is not the day after the last game', () => {
  /*
   * Nobody pitched yesterday, so nobody is on a second day in a row, whatever
   * he did on the 13th and the 14th. A day with no games at all is the
   * smallest break there is; the All-Star days are a longer one.
   */
  for (const [date, rested, why] of [
    ['2028-5-16', 2, 'a day with no games'],
    ['2028-5-18', 4, 'the All-Star days'],
  ] as const) {
    it(`is not a third straight day after ${why}`, async () => {
      await withLeagueDate(date, async () => {
        const him = await find(TWO_STRAIGHT);
        expect(him.tone, `read as "${him.status}"`).toBe('ok');
        expect(him.status).toBe(`Rested ${rested}d`);
        expect((await find(YESTERDAY_ONLY)).tone).toBe('ok');
      });
    });
  }

  it('counts from the last game played when the export has no league date', async () => {
    /*
     * The fallback is the last day played. The next game is the day after
     * that, so the last game is the day before it — the same thing as above.
     */
    await withLeagueDate(null, async () => {
      expect((await staff()).today).toBe(20280514);
      const him = await find(TWO_STRAIGHT);
      expect(him.tone, `read as "${him.status}"`).toBe('bad');
      expect(him.status).toMatch(/third straight day/i);
      expect((await find(YESTERDAY_ONLY)).tone).toBe('warn');
      // The floor is where it is in every mode
      expect((await find(UNDER_THE_FLOOR)).tone).toBe('ok');
    });
  });

  it('does not reach back a day further than that to find a run', async () => {
    /*
     * Without a league date the page's "today" is the last game played, so a
     * run read from the day before today and the day before that would be the
     * 13th and the 12th — a man who then rested through the 14th.
     */
    await withLeagueDate(null, async () => {
      const him = await find(BEFORE_THE_LAST_GAME);
      expect(him.tone, `read as "${him.status}"`).toBe('ok');
      expect(him.status).not.toMatch(/straight/i);
    });
  });

  it('still counts the three days before tonight in the last-three-days window', async () => {
    /*
     * With no league date "today" is the 14th, so the three days before
     * tonight are the 14th, the 13th and the 12th: the window starts a day
     * earlier than it does when the league's date is tonight's.
     */
    await withLeagueDate(null, async () => {
      const him = await find(THREE_DAYS_AGO);
      expect(him.status).toBe('45 pitches in 3 days');
      expect((await find(ADDS_UP_OVER_THREE_DAYS)).status).toBe('42 pitches in 3 days');
      const gone = await find(FOUR_DAYS_AGO);
      expect(gone.tone).toBe('ok');
      expect(gone.pitchesLast3).toBe(0);
    });
  });
});
