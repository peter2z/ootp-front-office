import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../server/db.js';
import { projectedRotation, starterInSlot } from '../server/schedule.js';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * Who starts which game, counted down the whole schedule.
 *
 * On the Dodgers' save the Schedule page named Snell for both the 15th and the
 * 16th and Sasaki for the 17th, while the projected rotation in the same export
 * reads Snell, Sasaki, Yamamoto, Wrobleski, Ohtani, Glasnow: one man a game, the
 * next game's man first. The page had counted from the top of every series, so
 * each new series began again at Snell, and from the second series on it
 * disagreed with the Pitching page, which dates a man's next start by walking
 * the club's own schedule. The Game Plan had the same fault in a worse form: it
 * counted OUR games in the series and then read the OPPONENT's rotation with the
 * answer.
 *
 * `projected_starting_pitchers` is a list by game. starter_n pitches the club's
 * nth game still to play, so a game's slot is the number of games its club has
 * left ahead of it, whoever they are against, however many series that crosses,
 * and counted on that club's own schedule. San Francisco play Cincinnati on the
 * 15th, so when they meet the Dodgers on the 16th they are a turn in: the man
 * for that game is their second, not their first.
 *
 * The league below is small enough to count by hand. Us, and three clubs whose
 * schedules overlap ours at different points:
 *
 *   15         North host Other           (a turn in before they meet us)
 *   16 17 18   we host North              (and South host Other on all of these)
 *   19         we are off                 (South host Other again: their fourth)
 *   20 21 22   we are at South            (their fifth, sixth and seventh)
 *   20 21 22   North host Other
 *   23 24 25   we host Other              (their ninth, tenth and eleventh)
 *
 * Every test starts from it and bends one thing.
 */

const US = IDS.mlbTeam;
const OTHER = IDS.otherMlbTeam;
const NORTH = 9201;
const SOUTH = 9202;

/** The league has moved on to the fifteenth; the last game played was the fourteenth. */
const LEAGUE_TODAY = '2028-5-15';

const LABEL: Record<number, string> = { [US]: 'Ours', [NORTH]: 'North', [SOUTH]: 'South', [OTHER]: 'Other' };
const LETTERS = 'ABCDEF';
// A sixth man for us, for the tests that run a six-man rotation; five for everyone else
const MEN: Record<number, number[]> = {
  [US]: [9300, 9301, 9302, 9303, 9304, 9305],
  [NORTH]: [9310, 9311, 9312, 9313, 9314],
  [SOUTH]: [9320, 9321, 9322, 9323, 9324],
  [OTHER]: [9330, 9331, 9332, 9333, 9334],
};
const CLUBS = [US, NORTH, SOUTH, OTHER];

beforeAll(() => {
  db.prepare(`UPDATE leagues SET "current_date" = ? WHERE league_id = ?`).run(LEAGUE_TODAY, IDS.league);

  const team = db.prepare(
    `INSERT INTO teams (team_id, name, nickname, abbr, level, league_id, sub_league_id,
                        division_id, parent_team_id, allstar_team, human_team)
     VALUES (?, ?, ?, ?, 1, ?, 0, 0, 0, 0, 0)`
  );
  team.run(NORTH, 'North', 'Stars', 'NOR', IDS.league);
  team.run(SOUTH, 'South', 'Sox', 'SOU', IDS.league);

  const arm = db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, ?, ?, 27, 1, 11, 1, 1, ?, ?, ?, 0, 0, 0, 0)`
  );
  const status = db.prepare(
    `INSERT INTO players_roster_status
       (player_id, is_active, is_on_dl, is_on_dl60, is_on_secondary,
        mlb_service_years, mlb_service_days, mlb_service_days_this_year)
     VALUES (?, 1, 0, 0, 0, 3.0, 516, 40)`
  );
  for (const club of CLUBS) {
    MEN[club].forEach((id, i) => {
      arm.run(id, LABEL[club], LETTERS[i], id % 100, club, club);
      status.run(id);
    });
  }
});

interface Game { date: string; home: number; away: number; played?: boolean; time?: number; type?: number }

let nextGameId = 9500;
/** Replace every game in the league with these, in this order, which is also the order of their ids. */
function setSchedule(games: Game[]): void {
  db.prepare(`DELETE FROM games`).run();
  const put = db.prepare(
    `INSERT INTO games (game_id, home_team, away_team, date, played, league_id, time, game_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const g of games) {
    put.run(nextGameId++, g.home, g.away, g.date, g.played ? 1 : 0, IDS.league, g.time ?? 1905, g.type ?? 0);
  }
}

/** `home` hosts `away` on each of the dates. */
const series = (home: number, away: number, ...dates: string[]): Game[] =>
  dates.map((date) => ({ date, home, away }));

const BASE: Game[] = [
  { date: '2028-5-14', home: OTHER, away: US, played: true },
  ...series(NORTH, OTHER, '2028-5-15'),
  ...series(US, NORTH, '2028-5-16', '2028-5-17', '2028-5-18'),
  ...series(SOUTH, OTHER, '2028-5-16', '2028-5-17', '2028-5-18', '2028-5-19'),
  ...series(SOUTH, US, '2028-5-20', '2028-5-21', '2028-5-22'),
  ...series(NORTH, OTHER, '2028-5-20', '2028-5-21', '2028-5-22'),
  ...series(US, OTHER, '2028-5-23', '2028-5-24', '2028-5-25'),
];

/** The projection, padded with the empty slots OOTP writes. */
function project(club: number, ids: number[]): void {
  db.prepare(`DELETE FROM projected_starting_pitchers WHERE team_id = ?`).run(club);
  db.prepare(`INSERT INTO projected_starting_pitchers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(club, ...ids, ...Array(8 - ids.length).fill(0));
}

/** A full row as OOTP writes it: the same men round again until the eight slots are full. */
const cycle = (men: number[]): number[] => Array.from({ length: 8 }, (_, i) => men[i % men.length]);

beforeEach(() => {
  setSchedule(BASE);
  // Every club on five men: A B C D E A B C
  for (const club of CLUBS) project(club, cycle(MEN[club].slice(0, 5)));
});

interface Probable { player_id: number; name: string; throws: string }
interface ScheduledGame {
  game_id: number;
  date: string;
  oppId: number;
  played: boolean;
  ourStarter: Probable | null;
  theirStarter: Probable | null;
}
interface Schedule { series: Array<{ opponent: string; games: ScheduledGame[] }> }
interface Plan {
  game: { game_id: number; played: boolean };
  starter: { player_id: number; name: string; confirmed: boolean } | null;
}
interface Starter { player_id: number; name: string; nextStartInDays: number | null }

const schedule = (): Promise<Schedule> => request(`/api/schedule/${US}`);
const upcoming = async (): Promise<ScheduledGame[]> =>
  (await schedule()).series.flatMap((s) => s.games).filter((g) => !g.played);
const plan = (gameId: number): Promise<Plan> => request(`/api/game-plan/${US}/${gameId}`);
const rotation = async (club: number): Promise<Starter[]> => (await request(`/api/pitching/${club}`)).rotation;

const ours = (games: ScheduledGame[]) => games.map((g) => g.ourStarter?.name ?? null);
const theirs = (games: ScheduledGame[]) => games.map((g) => g.theirStarter?.name ?? null);
const dates = (games: ScheduledGame[]) => games.map((g) => g.date);

/** The date n days after the league's today, written the way OOTP writes it. */
function onDay(n: number): string {
  const [y, m, d] = LEAGUE_TODAY.split('-').map(Number);
  const then = new Date(Date.UTC(y, m - 1, d) + n * 86_400_000);
  return `${then.getUTCFullYear()}-${then.getUTCMonth() + 1}-${then.getUTCDate()}`;
}

const UPCOMING_DATES = [
  '2028-5-16', '2028-5-17', '2028-5-18',
  '2028-5-20', '2028-5-21', '2028-5-22',
  '2028-5-23', '2028-5-24', '2028-5-25',
];

describe('our own starters', () => {
  it('carry on across the series boundary instead of starting again', async () => {
    /*
     * Three games at home and then three on the road. The old count began again
     * at the top of the second series, so it read A B C, A B C where the
     * rotation says A B C, D E A: all five men once, and then round to the
     * first again.
     */
    const [, home, road] = (await schedule()).series;
    expect(home.opponent).toBe('North Stars');
    expect(ours(home.games)).toEqual(['Ours A', 'Ours B', 'Ours C']);
    expect(road.opponent).toBe('South Sox');
    expect(ours(road.games)).toEqual(['Ours D', 'Ours E', 'Ours A']);
  });

  it('run the whole way down the schedule, round the rotation more than once', async () => {
    /*
     * Nine games, and the row holds eight. The ninth is past the end of it, so
     * the rotation comes round again: five men, so the ninth game is the
     * fourth man, which is where the row itself (A B C D E A B C) was heading.
     */
    const games = await upcoming();
    expect(dates(games)).toEqual(UPCOMING_DATES);
    expect(ours(games)).toEqual([
      'Ours A', 'Ours B', 'Ours C',
      'Ours D', 'Ours E', 'Ours A',
      'Ours B', 'Ours C', 'Ours D',
    ]);
  });

  it('wrap round a six-man rotation the same way', async () => {
    // The Dodgers' own shape: six names and then the first two again
    project(US, cycle(MEN[US]));
    expect(ours(await upcoming())).toEqual([
      'Ours A', 'Ours B', 'Ours C',
      'Ours D', 'Ours E', 'Ours F',
      'Ours A', 'Ours B', 'Ours C',
    ]);
  });

  it('come round again where the row simply stops naming anybody', async () => {
    /*
     * Five names and three empty slots. The sixth game is past what OOTP has
     * named, and the answer for it is the first man again, not nobody: the
     * rotation is the distinct names in the row, however long the row is.
     */
    project(US, MEN[US].slice(0, 5));
    expect(ours(await upcoming())).toEqual([
      'Ours A', 'Ours B', 'Ours C',
      'Ours D', 'Ours E', 'Ours A',
      'Ours B', 'Ours C', 'Ours D',
    ]);
  });
});

describe('a turn in the rotation', () => {
  it('is not used by a day off, which moves the dates and nobody in the rotation', async () => {
    /*
     * The club is off on the 19th: the 18th is the third man's and the 20th the
     * fourth's, with no turn spent in between. Move every game from the 20th on
     * a day later and it is off on the 20th as well. Nothing about the order of
     * games has changed, so nobody's turn has: the same man starts the same
     * game. Only the date the Pitching page gives for the fourth and fifth men
     * moves, by the day.
     */
    const later = (date: string) => {
      const [y, m, d] = date.split('-').map(Number);
      return `${y}-${m}-${d + 1}`;
    };
    const dayOf = (date: string) => Number(date.split('-')[2]);
    const before = await upcoming();
    expect(dates(before)).not.toContain('2028-5-19');
    expect(ours(before).slice(2, 4)).toEqual(['Ours C', 'Ours D']);
    const beforeDays = Object.fromEntries((await rotation(US)).map((r) => [r.name, r.nextStartInDays]));

    setSchedule(BASE.map((g) => (dayOf(g.date) >= 20 ? { ...g, date: later(g.date) } : g)));

    const after = await upcoming();
    expect(ours(after)).toEqual(ours(before));
    expect(theirs(after)).toEqual(theirs(before));
    expect(dates(after)).not.toEqual(dates(before));
    const afterDays = Object.fromEntries((await rotation(US)).map((r) => [r.name, r.nextStartInDays]));
    expect(beforeDays).toEqual({ 'Ours A': 1, 'Ours B': 2, 'Ours C': 3, 'Ours D': 5, 'Ours E': 6 });
    expect(afterDays).toEqual({ 'Ours A': 1, 'Ours B': 2, 'Ours C': 3, 'Ours D': 6, 'Ours E': 7 });
  });

  it('is used twice by a doubleheader, the early game first', async () => {
    /*
     * Two games on the 16th. The night game is written first, so it has the
     * lower id, and that is the trap: the order is first pitch and not id, or
     * the matinee, which the page shows first, would carry the second man. North
     * play both as well, so their turns move on by two.
     */
    setSchedule([
      { date: '2028-5-14', home: OTHER, away: US, played: true },
      ...series(NORTH, OTHER, '2028-5-15'),
      { date: '2028-5-16', home: US, away: NORTH, time: 1905 },
      { date: '2028-5-16', home: US, away: NORTH, time: 1305 },
      ...series(US, NORTH, '2028-5-17', '2028-5-18'),
      ...series(SOUTH, OTHER, '2028-5-16', '2028-5-17', '2028-5-18', '2028-5-19'),
      ...series(SOUTH, US, '2028-5-20', '2028-5-21', '2028-5-22'),
      ...series(NORTH, OTHER, '2028-5-20', '2028-5-21', '2028-5-22'),
      ...series(US, OTHER, '2028-5-23', '2028-5-24', '2028-5-25'),
    ]);
    const games = await upcoming();
    expect(dates(games).slice(0, 4)).toEqual(['2028-5-16', '2028-5-16', '2028-5-17', '2028-5-18']);
    expect(ours(games)).toEqual([
      'Ours A', 'Ours B', 'Ours C', 'Ours D',
      'Ours E', 'Ours A', 'Ours B',
      'Ours C', 'Ours D', 'Ours E',
    ]);
    // North: one game on the 15th, then these four
    expect(theirs(games).slice(0, 4)).toEqual(['North B', 'North C', 'North D', 'North E']);

    // The Pitching page puts both men of the doubleheader on the same day
    const days = Object.fromEntries((await rotation(US)).map((r) => [r.name, r.nextStartInDays]));
    expect(days).toEqual({ 'Ours A': 1, 'Ours B': 1, 'Ours C': 2, 'Ours D': 3, 'Ours E': 5 });
  });

  it('is not used by a game that does not count', async () => {
    /*
     * An exhibition in the middle of South's week is not a game of theirs to
     * pitch, any more than it is one of the club's own: only the regular season
     * and what follows it takes a turn. Counted, it would have moved South's man
     * for the 20th from E to A, and Other's three for the 23rd along with it.
     */
    setSchedule([...BASE, { date: '2028-5-19', home: SOUTH, away: OTHER, type: 2 }]);
    expect(theirs(await upcoming())).toEqual([
      'North B', 'North C', 'North D',
      'South E', 'South A', 'South B',
      'Other D', 'Other E', 'Other A',
    ]);
  });

  it('is not used by a game already played', async () => {
    /*
     * The fourteenth is behind the league. Whoever pitched it, the first game
     * still to come is the first slot of the projection, because OOTP rewrites
     * the row every time it exports and slot zero is whoever is up next.
     */
    const games = await upcoming();
    expect(games).toHaveLength(9);
    expect(ours(games)[0]).toBe('Ours A');
    expect(theirs(games)[0]).toBe('North B');
  });

  it('is not used by a game that was never played and is already behind the league', async () => {
    /*
     * A game dated before today that is still marked unplayed is not one coming
     * up, and the Pitching page leaves it out of the count. So does this, or
     * every man after it would be a turn off from the one that page names.
     */
    setSchedule([{ date: '2028-5-10', home: OTHER, away: US }, ...BASE]);
    const games = await upcoming();
    expect(games).toHaveLength(10);
    expect(ours(games)).toEqual([
      null,
      'Ours A', 'Ours B', 'Ours C', 'Ours D', 'Ours E', 'Ours A', 'Ours B', 'Ours C', 'Ours D',
    ]);
    // And it is not in Other's count either: their tenth game is still their ninth
    expect(theirs(games).slice(-3)).toEqual(['Other D', 'Other E', 'Other A']);
    const days = Object.fromEntries((await rotation(US)).map((r) => [r.name, r.nextStartInDays]));
    expect(days['Ours A']).toBe(1);
  });

  it('counts from the last game played where the league has no date of its own', async () => {
    // The same cut as above, for an export whose leagues table carries no date
    db.prepare(`UPDATE leagues SET "current_date" = NULL WHERE league_id = ?`).run(IDS.league);
    try {
      setSchedule([{ date: '2028-5-10', home: OTHER, away: US }, ...BASE]);
      expect(ours(await upcoming())).toEqual([
        null,
        'Ours A', 'Ours B', 'Ours C', 'Ours D', 'Ours E', 'Ours A', 'Ours B', 'Ours C', 'Ours D',
      ]);
    } finally {
      db.prepare(`UPDATE leagues SET "current_date" = ? WHERE league_id = ?`).run(LEAGUE_TODAY, IDS.league);
    }
  });
});

describe('the opposing starter', () => {
  it('is counted on the opponent\'s own schedule, not from the top of our series', async () => {
    /*
     * North have a game on the 15th that is not against us, so the first game
     * of ours they are in is their second and their man is B. South have four
     * at home against Other first, so ours is their fifth and the man is E. A
     * count from the top of the series gave North A, B, C and South A, B, C.
     * Other have eight behind them by the 23rd: past the row, so the rotation
     * comes round to D, E, A.
     */
    expect(theirs(await upcoming())).toEqual([
      'North B', 'North C', 'North D',
      'South E', 'South A', 'South B',
      'Other D', 'Other E', 'Other A',
    ]);
  });

  it('is not read from our count, which is a different number', async () => {
    /*
     * Our first game at South is our fourth, so our man is D. South have four
     * games at home against Other before it, so for them it is the fifth and
     * their man is E. The Plan used to read the opponent's row at OUR slot,
     * counted from the top of our series: South A. Counted down our whole
     * schedule it would still be wrong, South D, because the number belongs to
     * the club whose row it indexes.
     */
    const [, , road] = (await schedule()).series;
    const opener = road.games[0];
    expect(opener.date).toBe('2028-5-20');
    expect(opener.ourStarter?.name).toBe('Ours D');
    expect(opener.theirStarter?.name).toBe('South E');
    const p = await plan(opener.game_id);
    expect(p.starter?.name).toBe('South E');
    expect(p.starter?.confirmed, 'a projected starter was presented as confirmed').toBe(false);
  });

  it('is nobody for a club the projection does not name', async () => {
    db.prepare(`DELETE FROM projected_starting_pitchers WHERE team_id = ?`).run(NORTH);
    const games = await upcoming();
    expect(theirs(games)).toEqual([
      null, null, null,
      'South E', 'South A', 'South B',
      'Other D', 'Other E', 'Other A',
    ]);
    // Ours are untouched, and the Plan says the same thing the page does
    expect(ours(games)[0]).toBe('Ours A');
    expect((await plan(games[0].game_id)).starter).toBeNull();
  });
});

describe('the Schedule, the Game Plan and the Pitching page', () => {
  it('name the same man for the same game', async () => {
    /*
     * The three read the one projection and have to say the same thing. The
     * Pitching page gives each man a date for his next start; the game on that
     * date, in the Schedule's own rows, is the one the Schedule must name him
     * for, and the Game Plan for it as well. Both sides of the game are held
     * to it, ours by the Pitching page for our club and theirs by the Pitching
     * page for the club across.
     */
    const games = await upcoming();
    const on = (date: string) => games.find((g) => g.date === date);

    // Ours: all five men, each on the game his date points at
    const mine = await rotation(US);
    expect(mine.map((r) => r.name)).toEqual(['Ours A', 'Ours B', 'Ours C', 'Ours D', 'Ours E']);
    for (const man of mine) {
      const game = on(onDay(man.nextStartInDays!));
      expect(game?.ourStarter?.player_id, `${man.name} is not on the game his next start points at`).toBe(man.player_id);
    }

    // Theirs: wherever one of our games falls on the day a club's man is due
    const checked: string[] = [];
    for (const club of [NORTH, SOUTH, OTHER]) {
      for (const man of await rotation(club)) {
        const game = games.find((g) => g.date === onDay(man.nextStartInDays!) && g.oppId === club);
        if (!game) continue; // that club is playing somebody else that day
        expect(game.theirStarter?.player_id, `${man.name}: the Schedule`).toBe(man.player_id);
        expect((await plan(game.game_id)).starter?.player_id, `${man.name}: the Game Plan`).toBe(man.player_id);
        checked.push(`${game.date} ${man.name}`);
      }
    }
    // So that the loop above cannot pass by finding nothing to compare
    expect(checked).toEqual(['2028-5-16 North B', '2028-5-17 North C', '2028-5-18 North D', '2028-5-20 South E']);
  });

  it('agree with each other on every game to come, including the ones Pitching cannot date', async () => {
    // Past each club's first turn the Pitching page has nothing to say; these two still must agree
    for (const game of await upcoming()) {
      const p = await plan(game.game_id);
      expect(p.starter?.name ?? null, `the plan for ${game.date}`).toBe(game.theirStarter?.name ?? null);
    }
  });
});

describe('the dashboard', () => {
  /*
   * The dashboard's "up next" and the lineup page's "build against tonight's
   * man" read the next game. They used to take slot zero of BOTH rows, on the
   * reasoning that slot zero is whoever pitches the next game. That holds for
   * our club, whose next game this is by construction. It holds for the
   * opponent only when they have nothing in front of it, and on a day we are off
   * while they play they do: slot zero is tonight's game against somebody else.
   * (tests/probableStarter.test.ts pins slot zero for the case where the next
   * game is theirs too; this is the case where it is not.)
   *
   * Today is the 15th. We are idle, and North host Other: North's first man, A,
   * pitches tonight, and the game of ours that is next is the 16th, their second.
   */
  const next = (): Promise<{
    date: string;
    ourStarter: Probable | null;
    theirStarter: Probable | null;
  }> => request(`/api/next-game/${US}`);

  it('names the opposing man for OUR game on a day we are off and they play', async () => {
    const game = await next();
    expect(game.date).toBe('2028-5-16');
    expect(game.ourStarter?.name).toBe('Ours A');
    expect(game.theirStarter?.name, 'the man pitching their game the night before').toBe('North B');
  });

  it('is the top of their row when our game is the next one they play', async () => {
    // Take North's game on the 15th away: ours is now their first as well
    setSchedule(BASE.filter((g) => !(g.date === '2028-5-15' && g.home === NORTH)));
    expect((await next()).theirStarter?.name).toBe('North A');
  });

  it('says the same in the upcoming list, with our own men running on down it', async () => {
    const { upcoming } = (await request(`/api/dashboard/${US}`)) as {
      upcoming: Array<{ date: string; ourStarter: Probable | null; theirStarter: Probable | null }>;
    };
    expect(upcoming.map((g) => g.date)).toEqual(UPCOMING_DATES.slice(0, 5));
    expect(upcoming.map((g) => g.ourStarter?.name)).toEqual(['Ours A', 'Ours B', 'Ours C', 'Ours D', 'Ours E']);
    expect(upcoming[0].theirStarter?.name).toBe('North B');
    // The opposing man is named for the next game only
    expect(upcoming.slice(1).every((g) => g.theirStarter === null)).toBe(true);
  });

  it('names the man the Schedule names for the same game', async () => {
    const [first] = await upcoming();
    const game = await next();
    expect(game.ourStarter?.player_id).toBe(first.ourStarter?.player_id);
    expect(game.theirStarter?.player_id).toBe(first.theirStarter?.player_id);
  });
});

describe('where there is nothing to name', () => {
  it('names no starter in a game already played, rather than the man due next', async () => {
    /*
     * The fixture's games table, like an older export's, names no starters, so
     * a game that is over has nothing to say about who pitched it. It used to
     * be answered with the opponent's next man, labelled a projection, for a
     * game that was already in the books.
     */
    const played = (await schedule()).series.flatMap((s) => s.games).find((g) => g.played)!;
    expect(played.ourStarter).toBeNull();
    expect(played.theirStarter).toBeNull();
    const p = await plan(played.game_id);
    expect(p.game.played).toBe(true);
    expect(p.starter).toBeNull();
  });

  it('does not turn a row with one man in it into a rotation', async () => {
    /*
     * The Fall League's Salt River row in the Dodgers' save is one name and
     * seven empty slots, left over from a season that ended the autumn before.
     * He keeps the game OOTP gave him; he does not start every game after it.
     */
    project(US, [MEN[US][0]]);
    expect(ours(await upcoming())).toEqual(['Ours A', null, null, null, null, null, null, null, null]);
  });

  it('still answers when the export has no projection at all', async () => {
    db.exec('ALTER TABLE projected_starting_pitchers RENAME TO projected_starting_pitchers_aside');
    try {
      const games = await upcoming();
      expect(games).toHaveLength(9);
      expect(ours(games).every((name) => name === null)).toBe(true);
      expect(theirs(games).every((name) => name === null)).toBe(true);
      expect((await plan(games[0].game_id)).starter).toBeNull();
    } finally {
      db.exec('ALTER TABLE projected_starting_pitchers_aside RENAME TO projected_starting_pitchers');
    }
  });
});

describe('the rule that turns a slot into a starter', () => {
  const [A, B, C, D, E, F] = [1, 2, 3, 4, 5, 6];
  const read = (...ids: number[]) => {
    project(US, ids);
    return projectedRotation(US)!;
  };
  /** Who the rule names for each of the first n games, given a row. */
  const first = (ids: number[], games: number) => {
    const row = read(...ids);
    return Array.from({ length: games }, (_, slot) => starterInSlot(row, slot));
  };

  it('takes the row as it stands and then comes round to the first man', () => {
    // The Dodgers' row, and the six games after it
    expect(first([A, B, C, D, E, F, A, B], 14)).toEqual([A, B, C, D, E, F, A, B, C, D, E, F, A, B]);
  });

  it('comes round again where the row is padded with empty slots', () => {
    expect(first([A, B, C, D, E], 12)).toEqual([A, B, C, D, E, A, B, C, D, E, A, B]);
  });

  it('leaves a gap inside the row a gap', () => {
    // Nothing in the export looks like this; the point is that nobody is invented to fill it
    const rotation = read(A, B, 0, D, E, A, B, C);
    expect(starterInSlot(rotation, 2)).toBeNull();
    expect(starterInSlot(rotation, 3)).toBe(D);
  });

  it('does not make a rotation out of one man', () => {
    expect(first([A], 4)).toEqual([A, null, null, null]);
  });

  it('names nobody out of an empty row', () => {
    expect(first([], 10)).toEqual(Array(10).fill(null));
  });

  it('first names every man at the slot the Pitching page dates his next start by', () => {
    /*
     * The Pitching page takes a man's next start from the first slot he
     * appears in. For the two never to disagree, nothing here may name him
     * earlier than that, whatever shape the row is in, and nothing may leave him
     * unnamed once the rotation has come round.
     */
    const rows = [
      [A, B, C, D, E, A, B, C],
      [A, B, C, D, E, F, A, B],
      [A, B, C, D, E],
      [A, B, 0, D, E, A, B, C],
      [A, B, C, A, B, C, A, B],
      [A, B],
    ];
    for (const ids of rows) {
      const named = first(ids, 40);
      for (const man of new Set(ids.filter(Boolean))) {
        expect(named.indexOf(man), `${man} in ${ids.join(' ')}`).toBe(ids.indexOf(man));
      }
    }
  });
});
