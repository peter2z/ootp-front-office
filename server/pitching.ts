import { Router } from 'express';
import { db, tableExists } from './db.js';
import { countsAsPitcherSql } from './twoway.js';
import { healthOf, type Health } from './health.js';
import { computePitching, leagueBaseline } from './stats.js';
import { ON_ROSTER } from './valuation.js';
import { DATE_KEY } from './dashboard.js';
import { lastPlayedKey, leagueDateKey, projectedRotation, remainingGames } from './schedule.js';

export const pitchingRoutes = Router();

/** OOTP roles for pitchers. */
const ROLE_STARTER = 11;
const ROLE_CLOSER = 13;

const HAND: Record<number, string> = { 1: 'R', 2: 'L', 3: 'S' };

/**
 * Rest and workload are the whole point of this page, so they are computed from
 * per-game appearances rather than season totals: a reliever with a tidy season
 * ERA can still be unusable tonight because he threw 38 pitches yesterday.
 */
interface Appearance {
  player_id: number;
  dateKey: number;
  date: string;
  pitches: number;
  outs: number;
  started: boolean;
}

const dayFromKey = (key: number): Date =>
  new Date(Math.floor(key / 10000), (Math.floor(key / 100) % 100) - 1, key % 100);

const daysBetween = (a: number, b: number): number =>
  Math.round((dayFromKey(a).getTime() - dayFromKey(b).getTime()) / 86_400_000);

/*
 * "Today" and "the last game played" are worked out in schedule.ts
 * (leagueDateKey and lastPlayedKey), which this page shares with the Schedule,
 * the Game Plan and the dashboard: what counts as a game still to come is
 * measured from the same day on all of them. They are not the same day, and the
 * bullpen below needs both.
 */

/**
 * The three days before tonight's game, as a test on an appearance.
 *
 * Pitches in three days is a count of the days that could still be on a man's
 * arm when he goes tonight, and tonight is the league's own date: the day of
 * the game that has not been played. That makes the window one to three days
 * back from today, not today and the two before it. It was the second, which
 * was right until the page learned today's date from the league — after that
 * no appearance can be dated today, and "three days" quietly counted two. A man
 * who threw on each of the last three days was credited with the last two.
 *
 * Without a league date "today" is the last game played, which is already one
 * of the three days, so the window starts there instead.
 */
function lastThreeDays(todayKey: number, lastGameKey: number | null): (a: Appearance) => boolean {
  const first = lastGameKey !== null && daysBetween(todayKey, lastGameKey) === 0 ? 0 : 1;
  return (a) => {
    const back = daysBetween(todayKey, a.dateKey);
    return back >= first && back < first + 3;
  };
}

/**
 * Fatigue is expressed the way a manager thinks about it — pitches in the last
 * three days and how many days running he has pitched — rather than as a single
 * opaque score. Thresholds follow common bullpen practice: a real outing
 * yesterday is worth a look, and three in a row or 50+ pitches in three days is
 * a red flag.
 */
function bullpenStatus(
  recent: Appearance[],
  todayKey: number,
  lastGameKey: number | null,
  injury: Health | null
): { label: string; tone: 'ok' | 'warn' | 'bad' } {
  /*
   * Health outranks workload. A man on the injured list has not thrown in
   * weeks, so every test below would find him beautifully rested and this
   * column said so — a green "Rested 18d" beside a name tagged IL-60, which is
   * the opposite of the answer. Day-to-day men fall through, because OOTP lets
   * a manager use them and the season line is then the right thing to read.
   */
  if (injury && !injury.playable) {
    return {
      label: injury.daysLeft
        ? `Out about ${injury.daysLeft} more days`
        // Hurt with nothing in the export saying for how long. It used to read
        // "Out about 1000 more days", which is a placeholder, not a diagnosis
        : injury.durationUnknown
          ? 'Out — no return date given'
          : 'Out — on the injured list',
      tone: 'bad',
    };
  }
  const on = (d: number) => recent.find((a) => daysBetween(todayKey, a.dateKey) === d);
  const pitches3 = recent
    .filter(lastThreeDays(todayKey, lastGameKey))
    .reduce((sum, a) => sum + a.pitches, 0);

  const today = on(0);
  const yesterday = on(1);

  /*
   * Days in a row, counted back from the last game the league played.
   *
   * It is the question this page exists to answer — can he go a third day
   * running — and for a while nothing asked it. Once today became the league's
   * own date, which is the day after the last game, nobody could have pitched
   * today, so the two rules that looked at today ("Two straight" and "Would be
   * back-to-back") could never fire again. A man who had thrown on both of the
   * last two days read as a green "Available (12 yesterday)": twelve of the
   * eighteen relievers who pitched on both the 13th and the 14th of May in a
   * league-wide scan, Jhoan Duran among them with 26 pitches over the two days.
   *
   * So the run is counted back from the last game played, which for tonight's
   * game is yesterday. It is a run of calendar days, so an off day in the
   * middle is a day's rest, and the last game only counts when it really is the
   * day before tonight: after a break in the schedule nobody pitched yesterday.
   * Where the export has no league date, "today" here is the last game played,
   * and that game is the day before tonight all the same.
   */
  let run = 0;
  let lastGamePitches = 0;
  if (lastGameKey !== null && daysBetween(todayKey, lastGameKey) <= 1) {
    const back = new Set(recent.map((a) => daysBetween(lastGameKey, a.dateKey)));
    while (back.has(run)) run++;
    lastGamePitches = recent
      .filter((a) => daysBetween(lastGameKey, a.dateKey) === 0)
      .reduce((sum, a) => sum + a.pitches, 0);
  }

  // Everything is phrased as availability for the NEXT game, which is the only
  // question a manager is actually asking on this screen.
  if (pitches3 >= 50) return { label: `${pitches3} pitches in 3 days`, tone: 'bad' };
  if (today && today.pitches >= 30) return { label: `${today.pitches} pitches today`, tone: 'bad' };
  /*
   * Above the amber rules, because red outranks amber: a man with 36 pitches
   * yesterday and 13 the day before is on a third straight day, not simply a
   * man with "36 pitches yesterday". The red pitch-count rules stay ahead of it
   * and keep their wording. It is a count of the run rather than a test of two
   * days, so a fourth day running is not called a third.
   */
  if (run >= 2) {
    return { label: run === 2 ? 'Third straight day' : `${run + 1}th straight day`, tone: 'bad' };
  }
  if (yesterday && yesterday.pitches >= 30) {
    return { label: `${yesterday.pitches} pitches yesterday`, tone: 'warn' };
  }
  if (pitches3 >= 40) return { label: `${pitches3} pitches in 3 days`, tone: 'warn' };
  /*
   * He pitched yesterday, so going again tonight is back-to-back days. That is
   * amber from fifteen pitches up and green below it. A reliever who got a
   * batter or two out on six pitches has not been used in any way that costs
   * him the next day, and flagging every outing turned the column amber after
   * any night the pen was touched at all: forty-three relievers in the May 2028
   * save, fifteen of them on fewer than fifteen pitches. The red rule above has
   * no floor — a second day running is what it is about, however light the two
   * outings were.
   */
  if (run >= 1) {
    return lastGamePitches >= 15
      ? { label: `Pitched yesterday (${lastGamePitches} pitches)`, tone: 'warn' }
      : { label: `Available (${lastGamePitches} yesterday)`, tone: 'ok' };
  }
  const last = recent[0];
  if (!last) return { label: 'No appearances yet', tone: 'ok' };
  return { label: `Rested ${daysBetween(todayKey, last.dateKey)}d`, tone: 'ok' };
}

/** The arm to reach for in someone's place. */
export interface StandIn {
  player_id: number;
  name: string;
  /**
   * What the pen says about him: his own availability line ("Rested 2d"), so
   * the page can show why he is the one without a second lookup.
   */
  label: string;
}

/** The part of a bullpen row that choosing a stand-in reads. */
interface PenArm {
  player_id: number;
  name: string;
  throws: string;
  isCloser: boolean;
  status: string;
  tone: 'ok' | 'warn' | 'bad';
  injury: Health | null;
}

/**
 * Who to use instead of a reliever who is limited or out.
 *
 * The status column says a man cannot go and stops there, which leaves the
 * reader to scan the rest of the table for somebody who can. This does the scan,
 * in the order a manager would: the same hand first, since a left-hander who is
 * gassed is usually wanted for a left-handed batter; then the next man down the
 * pecking order, so the man who takes over is the one who was already behind
 * him. For the closer everybody is below him, which makes his cover the best
 * available arm that is not a closer himself.
 *
 * `pen` is the bullpen in the order the page shows it: closer first, then by
 * ERA+. That order is the pecking order, and "down" it is further from the
 * closer. A man with nobody below him who can go is covered from above instead,
 * nearest first, so the closer is the last arm anyone is sent to.
 *
 * Only green arms are offered, and only healthy ones. A day-to-day man reads
 * green when his workload is light, because OOTP lets a manager use him, but
 * telling the reader to use a man the same page tags as hurt would be two
 * answers on one screen. Null means nobody can take the innings.
 */
export function standInFor(man: PenArm, pen: PenArm[]): StandIn | null {
  const at = pen.findIndex((p) => p.player_id === man.player_id);
  const handKnown = man.throws !== '?';

  const free = pen.filter(
    (p) =>
      p.player_id !== man.player_id &&
      p.tone === 'ok' &&
      p.injury === null &&
      !(man.isCloser && p.isCloser)
  );

  // Same hand, then below him before above, then nearest before furthest
  const rank = (p: PenArm): [number, number, number] => {
    const place = pen.indexOf(p);
    const below = at < 0 || place > at;
    return [handKnown && p.throws === man.throws ? 0 : 1, below ? 0 : 1, Math.abs(place - at)];
  };
  const order = (a: PenArm, b: PenArm): number => {
    const [x, y] = [rank(a), rank(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  };

  const pick = [...free].sort(order)[0];
  return pick ? { player_id: pick.player_id, name: pick.name, label: pick.status } : null;
}

pitchingRoutes.get('/pitching/:teamId', (req, res) => {
  const teamId = Number(req.params.teamId);
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });

  const team = db.prepare(`SELECT league_id, level FROM teams WHERE team_id = ?`).get(teamId) as
    | { league_id: number; level: number }
    | undefined;
  if (!team) return res.status(404).json({ error: 'Unknown team' });

  const lastPlayed = lastPlayedKey(team.league_id);
  const todayKey = leagueDateKey(team.league_id, lastPlayed);

  const roster = db
    .prepare(
      `SELECT p.player_id, p.first_name, p.last_name, p.age, p.role, p.throws,
              pi.pitching_ratings_misc_stamina AS stamina,
              pi.pitching_ratings_overall_stuff AS stuff,
              pi.pitching_ratings_overall_control AS control,
              pi.pitching_ratings_overall_movement AS movement,
              pi.pitching_ratings_misc_velocity AS velocity,
              p.injury_is_injured, p.injury_dtd_injury, p.injury_left,
              rs.is_on_dl, rs.is_on_dl60, rs.is_active
       FROM players p
       LEFT JOIN players_pitching pi ON pi.player_id = p.player_id
       LEFT JOIN players_roster_status rs ON rs.player_id = p.player_id
       -- A two-way man's innings belong on the staff page as much as anyone's
       WHERE p.team_id = ? AND ${countsAsPitcherSql()} AND p.retired = 0 AND ${ON_ROSTER}`
    )
    .all(teamId) as Array<{
    player_id: number; first_name: string; last_name: string; age: number; role: number;
    throws: number; stamina: number | null; stuff: number | null; control: number | null;
    movement: number | null; velocity: number | null;
    injury_is_injured: number | null; injury_dtd_injury: number | null; injury_left: number | null;
    is_on_dl: number | null; is_on_dl60: number | null; is_active: number | null;
  }>;
  /*
   * A club with nobody on its staff still answers in the shape of any other.
   * This used to leave out starterDepth, tired and injured, and the page reads
   * starterDepth.length, which throws on undefined.
   */
  if (roster.length === 0) {
    return res.json({ today: null, rotation: [], starterDepth: [], bullpen: [], tired: 0, injured: 0 });
  }

  const ids = roster.map((r) => r.player_id);
  const holes = ids.map(() => '?').join(',');

  // Season stats
  const statYear = (db.prepare(`SELECT MAX(year) AS y FROM players_career_pitching_stats`).get() as
    | { y: number | null }
    | undefined)?.y ?? null;
  const statsById = new Map<number, Record<string, number | null>>();
  if (statYear !== null) {
    const base = leagueBaseline(team.league_id, statYear, team.level);
    const rows = db
      .prepare(
        `SELECT player_id, SUM(outs) AS outs, SUM(er) AS er, SUM(ha) AS ha, SUM(bb) AS bb,
                SUM(k) AS k, SUM(hra) AS hra, SUM(hp) AS hp, SUM(bf) AS bf, SUM(g) AS g, SUM(gs) AS gs,
                SUM(w) AS w, SUM(l) AS l, SUM(s) AS sv, SUM(hld) AS hld, SUM(war) AS war
         FROM players_career_pitching_stats
         WHERE year = ? AND split_id = 1 AND level_id = ? AND player_id IN (${holes})
         GROUP BY player_id`
      )
      .all(statYear, team.level, ...ids) as Array<Record<string, number>>;
    // Scoped to this club's level. Summing a pitcher's whole season across
    // levels blends AAA innings into a major-league line, which is why these
    // numbers disagreed with OOTP's own pitching screen — relievers shuttle,
    // so they were the worst affected.
    for (const row of rows) statsById.set(row.player_id, computePitching(row, base, teamId));
  }

  // Per-game appearances, for rest and recent workload
  const appearances = new Map<number, Appearance[]>();
  if (tableExists('players_game_pitching_stats')) {
    const rows = db
      .prepare(
        `SELECT s.player_id, g.date AS date, ${DATE_KEY('g.date')} AS dateKey,
                s.pi AS pitches, s.outs AS outs, s.gs AS gs
         FROM players_game_pitching_stats s
         JOIN games g ON g.game_id = s.game_id
         WHERE s.player_id IN (${holes}) AND g.played = 1
         ORDER BY dateKey DESC`
      )
      .all(...ids) as Array<{
      player_id: number; date: string; dateKey: number; pitches: number; outs: number; gs: number;
    }>;
    for (const r of rows) {
      const list = appearances.get(r.player_id) ?? [];
      list.push({
        player_id: r.player_id,
        dateKey: r.dateKey,
        date: r.date,
        pitches: r.pitches ?? 0,
        outs: r.outs ?? 0,
        started: (r.gs ?? 0) > 0,
      });
      appearances.set(r.player_id, list);
    }
  }

  /*
   * OOTP's own projected rotation, so the page agrees with the game's own plan.
   *
   * The list is one starter per upcoming game, and a rotation simply comes round
   * again in it: the Dodgers' row is six names and then the first two again. So
   * the rotation is the distinct names in it, however many that is, and the
   * first game a man appears at is his next start. Reading only the first five
   * slots made a six-man club's sixth starter "depth". The table is not in every
   * export either, so it is asked for only when it is there.
   *
   * The row is read in schedule.ts (projectedRotation), which the Schedule, the
   * Game Plan and the dashboard read it from as well: one reading of the row,
   * so all four name the same man for the same game.
   */
  const projected = projectedRotation(teamId);
  const projectedOrder = projected?.men ?? [];

  // The nth game of the list is the club's nth game still to play, and so a
  // date on its own schedule (remainingGames, the list the Schedule counts
  // along as well). With no schedule to read it is a game a day, which is all
  // the list itself can say.
  const remaining = projectedOrder.length > 0 ? remainingGames(teamId, team.league_id, todayKey) : null;
  const gameKeys = remaining === null ? null : remaining.map((g) => g.dateKey);
  const startsInDays = (game: number): number | null => {
    if (gameKeys === null || todayKey === null) return game;
    const key = gameKeys[game];
    return key === undefined ? null : daysBetween(key, todayKey);
  };

  // Shared with the injury report and the lineup card, so a man cannot be
  // available on one page and on the injured list on another
  // The whole record, playable included — the page filters on that flag rather
  // than reading the wording of the status
  const injuryOf = (p: (typeof roster)[number]): Health | null => healthOf(p);

  const describe = (p: (typeof roster)[number]) => {
    const apps = appearances.get(p.player_id) ?? [];
    const last = apps[0] ?? null;
    const stats = statsById.get(p.player_id) ?? null;
    return {
      injury: injuryOf(p),
      player_id: p.player_id,
      name: `${p.first_name} ${p.last_name}`,
      age: p.age,
      throws: HAND[p.throws] ?? '?',
      role: p.role,
      stamina: p.stamina,
      stuff: p.stuff,
      control: p.control,
      movement: p.movement,
      velocity: p.velocity,
      lastOuting: last ? { date: last.date, pitches: last.pitches, outs: last.outs } : null,
      daysRest: last && todayKey !== null ? daysBetween(todayKey, last.dateKey) : null,
      stats,
    };
  };

  const starters = roster.filter((p) => p.role === ROLE_STARTER);
  const relievers = roster.filter((p) => p.role !== ROLE_STARTER);

  // Rotation order: OOTP's projection first, then anyone else who starts
  const byId = new Map(starters.map((p) => [p.player_id, p]));
  const ordered = [
    ...projectedOrder.map((id) => byId.get(id)).filter((p): p is (typeof roster)[number] => !!p),
    ...starters.filter((p) => !projectedOrder.includes(p.player_id)),
  ];

  const rotation = ordered.map((p) => {
    const d = describe(p);
    const projectedSlot = projectedOrder.indexOf(p.player_id);
    // The first slot he appears in is the game he next starts
    const firstGame = projected ? projected.slots.indexOf(p.player_id) : -1;
    return {
      ...d,
      // Everyone OOTP projects to start gets a rotation slot, however many that
      // is. Everyone else is depth: long men, spot starters, and arms
      // currently on the IL.
      slot: projectedSlot >= 0 ? projectedSlot + 1 : null,
      projected: projectedSlot >= 0,
      nextStartInDays: firstGame < 0 ? null : startsInDays(firstGame),
    };
  });
  const starterDepth = rotation.filter((r) => !r.projected);
  const activeRotation = rotation.filter((r) => r.projected);

  const pen = relievers
    .map((p) => {
      const d = describe(p);
      const apps = appearances.get(p.player_id) ?? [];
      const status = todayKey !== null
        ? bullpenStatus(apps, todayKey, lastPlayed, d.injury)
        : { label: '—', tone: 'ok' as const };
      // Same window bullpenStatus uses: the three days before tonight's game
      const last3 = todayKey !== null ? apps.filter(lastThreeDays(todayKey, lastPlayed)) : [];
      return {
        ...d,
        isCloser: p.role === ROLE_CLOSER,
        status: status.label,
        tone: status.tone,
        pitchesLast3: last3.reduce((sum, a) => sum + a.pitches, 0),
        appearancesLast3: last3.length,
      };
    })
    // Closer first, then by ERA+ descending — the order a manager reaches for them
    .sort((a, b) => {
      if (a.isCloser !== b.isCloser) return a.isCloser ? -1 : 1;
      return (b.stats?.eraPlus ?? 0) - (a.stats?.eraPlus ?? 0);
    });

  /*
   * Who to use in place of anyone limited or out, read off the finished order:
   * the choice is made by where a man stands in it. A green arm needs no cover.
   */
  const bullpen = pen.map((p) => ({
    ...p,
    instead: p.tone === 'ok' ? null : standInFor(p, pen),
  }));

  res.json({
    today: todayKey,
    rotation: activeRotation,
    starterDepth,
    bullpen,
    tired: bullpen.filter((b) => b.tone !== 'ok').length,
    injured: [...activeRotation, ...starterDepth, ...bullpen].filter((p) => p.injury !== null).length,
  });
});
