import { Router } from 'express';
import { competitiveGamesSql } from './postseason.js';
// DATE_KEY from where it is defined, not from dashboard.ts: the dashboard is the
// natural next reader of probableStarters, and importing it here as well would
// make the two a cycle
import { DATE_KEY, db, hasColumns, tableExists } from './db.js';
import { currentGameDate } from './valuation.js';

export const scheduleRoutes = Router();

const HAND: Record<number, string> = { 1: 'R', 2: 'L', 3: 'S' };
const teamLabel = (alias: string) =>
  `CASE WHEN ${alias}.name = ${alias}.nickname THEN ${alias}.name
        ELSE ${alias}.name || ' ' || ${alias}.nickname END`;

/**
 * Games are grouped into series the way a schedule is actually read: consecutive
 * games against the same opponent at the same venue. OOTP does not store a
 * series id, so it is derived from the ordered game list.
 */
interface GameRow {
  game_id: number;
  date: string;
  dateKey: number;
  time: number;
  home_team: number;
  away_team: number;
  home_label: string;
  away_label: string;
  played: number;
  runs0: number | null; // away
  runs1: number | null; // home
  innings: number | null;
  starter0: number | null; // away starter
  starter1: number | null; // home starter
}

function pitcher(id: number | null) {
  if (!id) return null;
  const p = db
    .prepare(`SELECT player_id, first_name || ' ' || last_name AS name, throws FROM players WHERE player_id = ?`)
    .get(id) as { player_id: number; name: string; throws: number } | undefined;
  return p ? { player_id: p.player_id, name: p.name, throws: HAND[p.throws] ?? '?' } : null;
}

/**
 * Who starts which game: one reading of the projection, for every page that
 * names a probable starter — the Schedule, the Game Plan, the dashboard, and the
 * Pitching page's dates for each man's next start.
 *
 * `projected_starting_pitchers` is a list by GAME: starter_0 pitches the club's
 * next game, starter_1 the one after it, and so on down the schedule — not by
 * series, and not by day. The Schedule and the Game Plan used to start the count
 * again at zero in every series, so past the first one they could name a
 * different man from the Pitching page, which counts the whole schedule. On the
 * Dodgers' save the Schedule showed Snell on both the 15th and the 16th and
 * Sasaki on the 17th, where the projection reads Snell, Sasaki, Yamamoto on three
 * games running.
 *
 * The opposing club was worse off, because a club's rotation does not wait for
 * you. San Francisco play Cincinnati on the 15th, so by the 16th, when they meet
 * the Dodgers, they are already a turn in; counting from the top of the series
 * named the man who pitched the day before. The dashboard made the same mistake
 * from the other end, reading slot zero of the opponent's row for the next game.
 *
 * So a game's slot is the number of games its club has left to play ahead of it,
 * whoever they are against, and each club is counted on its own schedule. An off
 * day is simply not a game, so it moves nothing, and a doubleheader is two.
 */

/**
 * The newest day this league has played a game, as a sortable number.
 *
 * Not the same thing as today, and the bullpen needs both: today is the
 * league's own date, while the days a man has pitched in a row are counted
 * back from the last game that was actually played.
 */
export function lastPlayedKey(leagueId: number): number | null {
  if (!hasColumns('games', 'league_id', 'date', 'played')) return null;
  const row = db
    .prepare(
      `SELECT MAX(${DATE_KEY('date')}) AS k FROM games WHERE league_id = ? AND played = 1`
    )
    .get(leagueId) as { k: number | null } | undefined;
  return row?.k ?? null;
}

/**
 * What day it is in the save — the league's own date, not the last one played.
 *
 * These are not the same day and the difference is the whole of a bug a reader
 * caught. He exports after simming, so the newest games in the file are the
 * ones just played and the league has already moved on to the next morning;
 * this read the last played date and called it today, so a man who threw
 * yesterday was reported as having thrown today, one who threw the day before
 * as yesterday, and two days' rest as one. Every label on the page was a day
 * stale — while the availability underneath them, worked out from the same
 * pitch counts, was right. He said exactly that: the numbers are correct, the
 * days are not.
 *
 * The page is headed "availability tonight", and tonight's game is the one
 * that has not been played. Asking the games table when now is could only ever
 * answer with the past.
 *
 * The last played date stays as the fallback for an export with no league date
 * in it. It is a real day and it is close; it is simply not this one.
 *
 * The Pitching page, the Schedule, the Game Plan and the dashboard all read the
 * day from here. What counts as a game still to come is measured from it (see
 * remainingGames), and they have to agree about that. A caller that already has
 * the last played day passes it in, so the games table is asked once.
 */
export function leagueDateKey(
  leagueId: number,
  lastPlayed: number | null = lastPlayedKey(leagueId)
): number | null {
  const key = (raw: string | null): number | null => {
    const m = raw && /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw.trim());
    return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : null;
  };
  // An export with no league date, or no leagues table at all, falls back to
  // the last game played rather than failing the page that asked
  const league = tableExists('leagues') && hasColumns('leagues', 'current_date')
    ? key(currentGameDate(leagueId))
    : null;

  if (league === null) return lastPlayed;
  /*
   * The later of the two. A league date behind the last game played is not
   * something OOTP produces, but reading it would put appearances in the
   * future and turn every count negative, and there is a sane answer to hand.
   */
  return lastPlayed === null ? league : Math.max(league, lastPlayed);
}

/** One game a club has still to play. */
export interface RemainingGame {
  game_id: number;
  dateKey: number;
}

/**
 * The games a club has left to play, in the order it plays them.
 *
 * This is the list the projected rotation is indexed by: the club's nth game
 * still to come is the one starter_n pitches. The Pitching page walks this same
 * list to date each man's next start, so that a man it says starts on the 20th
 * is the man the Schedule names for the game on the 20th.
 *
 * Only unplayed games that count: the regular season and anything after it, and
 * not the exhibition slate or the All-Star game. A game dated before today that
 * was never played is not one coming up. An off day is not a game and so is not
 * in the list; a doubleheader is two games, told apart by first pitch and then by
 * id, so that two with the same time cannot trade places between requests.
 *
 * Null means there is no schedule to read for this club, which is not the same
 * as an empty list: a club with no games left has a finished schedule, and nobody
 * on it has a next start.
 */
export function remainingGames(
  teamId: number,
  leagueId: number,
  todayKey: number | null
): RemainingGame[] | null {
  if (
    !tableExists('games') ||
    !hasColumns('games', 'date', 'played', 'game_type', 'league_id', 'home_team', 'away_team')
  ) {
    return null;
  }
  const rows = db
    .prepare(
      `SELECT g.game_id, ${DATE_KEY('g.date')} AS k FROM games g
       WHERE g.played = 0 AND (g.home_team = ? OR g.away_team = ?)
         AND ${competitiveGamesSql('g', leagueId)}
       ORDER BY k${hasColumns('games', 'time') ? ', g.time' : ''}, g.game_id`
    )
    .all(teamId, teamId) as Array<{ game_id: number; k: number }>;
  const coming = rows
    .filter((r) => todayKey === null || r.k >= todayKey)
    .map((r) => ({ game_id: r.game_id, dateKey: r.k }));
  if (coming.length > 0) return coming;
  // Nothing left to play: a finished schedule if the club has games at all
  const hasGames = db.prepare(`SELECT 1 FROM games WHERE home_team = ? OR away_team = ? LIMIT 1`).get(teamId, teamId);
  return hasGames ? [] : null;
}

/** What OOTP projects for a club's starters, and the rotation that implies. */
export interface ProjectedRotation {
  /** The man OOTP names for each game in turn, or null where it names nobody. */
  slots: Array<number | null>;
  /** The distinct men in the row, in the order they first appear: the rotation. */
  men: number[];
  /** How many games the row speaks for: up to the last one that names somebody. */
  named: number;
}

/**
 * A club's projected rotation, as the row of `projected_starting_pitchers` gives it.
 *
 * The row is eight games long and a rotation simply comes round again in it: the
 * Dodgers' is six names and then the first two again, and the other clubs in
 * that save read A B C D E A B C. So the rotation is the distinct names in it,
 * however many that is, which is how the Pitching page sizes the rotation and
 * finds each man's first start: it reads the row from here, and a man's first
 * start is the first slot he appears in (`slots.indexOf`). The table is not in
 * every export, and a club it does not name gets no rotation rather than a
 * made-up one.
 */
export function projectedRotation(teamId: number): ProjectedRotation | null {
  if (!tableExists('projected_starting_pitchers')) return null;
  const row = db.prepare(`SELECT * FROM projected_starting_pitchers WHERE team_id = ?`).get(teamId) as
    | Record<string, number | null>
    | undefined;
  if (!row) return null;

  const found: Array<number | null> = [];
  for (const column of Object.keys(row)) {
    const m = /^starter_(\d+)$/.exec(column);
    if (m) found[Number(m[1])] = row[column] || null;
  }
  const slots = Array.from(found, (id) => id ?? null);
  const men: number[] = [];
  for (const id of slots) if (id && !men.includes(id)) men.push(id);
  return { slots, men, named: slots.reduce<number>((n, id, i) => (id ? i + 1 : n), 0) };
}

/**
 * Who starts a club's nth game still to play.
 *
 * Inside the row it is OOTP's own word for that game, and a slot it left empty
 * stays empty. A schedule runs on for a hundred games and the row for eight, so
 * past the row the rotation comes round again: game n belongs to the (n mod
 * size)th man of it, which is where the row itself was heading. The Dodgers'
 * ninth game is their third man, and a club of five names has its sixth game back
 * at its first.
 *
 * The other choice was to name nobody beyond the row. This follows the Pitching
 * page instead, which reads the row as a cycle (the rotation is its distinct
 * names), so the two cannot disagree about who is next in the order. Nor about
 * when: the row is taken as it stands for as long as it names anybody, and the
 * wrap only begins once every man in the rotation has appeared, so the first game
 * a man is named for is the one the Pitching page dates his next start at.
 *
 * One name is not a rotation coming round. The only club in that save with a row
 * like that is Salt River, a Fall League side whose season ended the autumn
 * before: one reliever's name and seven empty slots, left over. A man starting
 * every game would be the table's padding and not a projection, so he keeps the
 * game OOTP named him for and the rest are left blank.
 */
export function starterInSlot(rotation: ProjectedRotation, slot: number): number | null {
  if (slot < rotation.named) return rotation.slots[slot];
  if (rotation.men.length < 2) return null;
  return rotation.men[slot % rotation.men.length];
}

/**
 * Who is probably starting a game, for either club in it.
 *
 * Ask with the club's own id and the game's id. A club's slot is its own count of
 * games left, so the opposing starter is asked for with the opposing club's id,
 * not ours. A game the club has already played, or one its schedule does not
 * carry, has no probable starter and answers null.
 *
 * One of these is made per request, so each club's schedule and rotation are read
 * once however many of its games are asked about.
 */
export function probableStarters(): (teamId: number, gameId: number) => number | null {
  const dates = new Map<number, number | null>();
  const dateIn = (leagueId: number): number | null => {
    let key = dates.get(leagueId);
    if (key === undefined) {
      key = leagueDateKey(leagueId);
      dates.set(leagueId, key);
    }
    return key;
  };

  const clubs = new Map<number, { slotOf: Map<number, number>; rotation: ProjectedRotation | null }>();
  const club = (teamId: number) => {
    let known = clubs.get(teamId);
    if (!known) {
      const leagueId =
        (db.prepare(`SELECT league_id FROM teams WHERE team_id = ?`).get(teamId) as
          | { league_id: number }
          | undefined)?.league_id ?? 0;
      const games = remainingGames(teamId, leagueId, dateIn(leagueId)) ?? [];
      known = {
        slotOf: new Map<number, number>(games.map((g, slot) => [g.game_id, slot] as [number, number])),
        rotation: projectedRotation(teamId),
      };
      clubs.set(teamId, known);
    }
    return known;
  };

  return (teamId, gameId) => {
    const { slotOf, rotation } = club(teamId);
    const slot = slotOf.get(gameId);
    return rotation === null || slot === undefined ? null : starterInSlot(rotation, slot);
  };
}

scheduleRoutes.get('/schedule/:teamId', (req, res) => {
  const teamId = Number(req.params.teamId);
  if (!tableExists('games')) return res.status(400).json({ error: 'No data imported yet' });

  // The named starters are not in every version of games.csv, and asking for a
  // column that is not there costs the whole schedule rather than the probables
  const named = hasColumns('games', 'starter0', 'starter1');
  // What counts as a game depends on when this league's regular season ends
  const leagueId = (db.prepare(`SELECT league_id FROM teams WHERE team_id = ?`).get(teamId) as
    { league_id: number } | undefined)?.league_id ?? 0;
  const rows = db
    .prepare(
      `SELECT g.game_id, g.date, ${DATE_KEY('g.date')} AS dateKey, g.time,
              g.home_team, g.away_team, g.played, g.runs0, g.runs1, g.innings,
              ${named ? 'g.starter0, g.starter1' : 'NULL AS starter0, NULL AS starter1'},
              ${teamLabel('ht')} AS home_label, ${teamLabel('at2')} AS away_label
       FROM games g
       JOIN teams ht ON ht.team_id = g.home_team
       JOIN teams at2 ON at2.team_id = g.away_team
       WHERE (g.home_team = ? OR g.away_team = ?)
         AND ${competitiveGamesSql('g', leagueId)}
       -- The id last, so two games with the same first pitch keep the order
       -- remainingGames counts them in
       ORDER BY ${DATE_KEY('g.date')}, g.time, g.game_id`
    )
    .all(teamId, teamId) as GameRow[];

  if (rows.length === 0) return res.json({ series: [], record: null });

  // Opponent records, so a series can be judged before it starts
  const records = new Map<number, { w: number; l: number; pct: number }>();
  if (tableExists('team_record')) {
    for (const r of db.prepare(`SELECT team_id, w, l, pct FROM team_record`).all() as Array<{
      team_id: number; w: number; l: number; pct: number;
    }>) {
      records.set(r.team_id, { w: r.w, l: r.l, pct: r.pct });
    }
  }

  /*
   * Probable starters for the games still to come, from each club's projected
   * rotation counted along that club's own remaining schedule: the nth game it
   * has left is the nth man in its rotation, in this series or the one after.
   * The opposing club is asked in its own right, since its count has nothing to
   * do with ours.
   */
  const probable = probableStarters();

  const games = rows.map((g) => {
    const isHome = g.home_team === teamId;
    const oppId = isHome ? g.away_team : g.home_team;
    // runs0 is the away score and runs1 the home score — verified against
    // team_record: recomputing W-L from these matches the official standings.
    const us = g.played ? (isHome ? g.runs1 : g.runs0) : null;
    const them = g.played ? (isHome ? g.runs0 : g.runs1) : null;
    return {
      game_id: g.game_id,
      date: g.date,
      dateKey: g.dateKey,
      isHome,
      oppId,
      opponent: isHome ? g.away_label : g.home_label,
      opponentRecord: records.get(oppId) ?? null,
      played: g.played === 1,
      us,
      them,
      won: us !== null && them !== null ? us > them : null,
      extraInnings: (g.innings ?? 9) > 9,
      ourStarter: pitcher(g.played ? (isHome ? g.starter1 : g.starter0) : probable(teamId, g.game_id)),
      theirStarter: pitcher(g.played ? (isHome ? g.starter0 : g.starter1) : probable(oppId, g.game_id)),
    };
  });

  // Group consecutive same-opponent, same-venue games into series
  type Game = (typeof games)[number];
  const series: Array<{
    opponent: string;
    oppId: number;
    isHome: boolean;
    opponentRecord: { w: number; l: number; pct: number } | null;
    startDate: string;
    endDate: string;
    games: Game[];
    played: boolean;
    inProgress: boolean;
    wins: number;
    losses: number;
  }> = [];

  for (const g of games) {
    const last = series[series.length - 1];
    if (last && last.oppId === g.oppId && last.isHome === g.isHome) {
      last.games.push(g);
    } else {
      series.push({
        opponent: g.opponent,
        oppId: g.oppId,
        isHome: g.isHome,
        opponentRecord: g.opponentRecord,
        startDate: g.date,
        endDate: g.date,
        games: [g],
        played: false,
        inProgress: false,
        wins: 0,
        losses: 0,
      });
    }
  }

  for (const s of series) {
    s.endDate = s.games[s.games.length - 1].date;
    s.wins = s.games.filter((g) => g.won === true).length;
    s.losses = s.games.filter((g) => g.won === false).length;
    const playedCount = s.games.filter((g) => g.played).length;
    s.played = playedCount === s.games.length;
    s.inProgress = playedCount > 0 && playedCount < s.games.length;
  }

  const wins = games.filter((g) => g.won === true).length;
  const losses = games.filter((g) => g.won === false).length;
  const home = games.filter((g) => g.played && g.isHome);
  const away = games.filter((g) => g.played && !g.isHome);
  const nextIndex = series.findIndex((s) => !s.played);

  /**
   * Record against each opponent, and the line score of every game played.
   *
   * A season record says how the club is doing; a head-to-head record says who
   * it is doing it against, which is the thing a manager actually asks before a
   * series. games_score carries the runs scored in each inning and had never
   * been read.
   */
  const headToHead = [...
    games
      .filter((g) => g.played)
      .reduce((acc, g) => {
        const cur = acc.get(g.oppId) ?? { opponentId: g.oppId, opponent: g.opponent, w: 0, l: 0, rf: 0, ra: 0 };
        if (g.won === true) cur.w += 1;
        else if (g.won === false) cur.l += 1;
        cur.rf += g.us ?? 0;
        cur.ra += g.them ?? 0;
        acc.set(g.oppId, cur);
        return acc;
      }, new Map<number, { opponentId: number; opponent: string; w: number; l: number; rf: number; ra: number }>())
      .values(),
  ].sort((a, b) => b.w + b.l - (a.w + a.l) || b.w - a.w);

  // Only the games already played, and only the recent ones — a full season of
  // line scores is a lot of payload for a page that shows a window
  const lineScores: Record<number, { away: number[]; home: number[] }> = {};
  if (tableExists('games_score')) {
    const recent = games.filter((g) => g.played).slice(-24).map((g) => g.game_id);
    if (recent.length > 0) {
      const holes = recent.map(() => '?').join(',');
      for (const r of db
        .prepare(
          `SELECT game_id, team, inning, score FROM games_score
           WHERE game_id IN (${holes}) ORDER BY inning`
        )
        .all(...recent) as Array<{ game_id: number; team: number; inning: number; score: number }>) {
        const entry = (lineScores[r.game_id] ??= { away: [], home: [] });
        (r.team === 0 ? entry.away : entry.home).push(r.score ?? 0);
      }
    }
  }

  res.json({
    headToHead,
    lineScores,
    record: {
      w: wins,
      l: losses,
      home: `${home.filter((g) => g.won).length}-${home.filter((g) => g.won === false).length}`,
      away: `${away.filter((g) => g.won).length}-${away.filter((g) => g.won === false).length}`,
      runsFor: games.reduce((sum, g) => sum + (g.us ?? 0), 0),
      runsAgainst: games.reduce((sum, g) => sum + (g.them ?? 0), 0),
    },
    nextSeriesIndex: nextIndex,
    series,
  });
});
