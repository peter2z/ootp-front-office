import { Router } from 'express';
import { db, hasColumns, tableExists, tableColumns } from './db.js';
import { LEVEL_NAMES, ratingScaleMax } from './valuation.js';
import { seasonFormByPlayer, type SeasonForm } from './form.js';
import { rosterCrunch } from './rosterops.js';
import { healthOf } from './health.js';
import { OPTIONS_ALLOWED, optionState, outOfOptions, serviceYearsOf } from './rosterRules.js';

/*
 * The option rules live in rosterRules.ts now, read by this file, the 40-Man
 * page and the planner alike; they are re-exported here so the player card
 * and anything else that learned them from this module keeps working.
 */
export { OPTIONS_ALLOWED, outOfOptions, serviceYearsOf };

export const orgRoutes = Router();


const avg = (vals: Array<number | null | undefined>): number | null => {
  const nums = vals.filter((v): v is number => typeof v === 'number');
  if (!nums.length) return null;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
};

/** MLB parent clubs, with the human-controlled org flagged and team colors. */
orgRoutes.get('/orgs', (_req, res) => {
  if (!tableExists('teams')) return res.json([]);
  /*
   * A club you can manage is one with nothing above it.
   *
   * "I have a save where the MLB and all the minor League are not affiliated
   * so I can't access those the same way as the MLB." He could not: this asked
   * for level 1, and in a universe where the lower leagues stand on their own
   * their clubs are level 2, 3, 4 — so the picker never offered them and every
   * page behind it was unreachable.
   *
   * Being top of your own tree is what actually makes a club an organisation:
   * no parent club above it, and no parent league above its league. On an
   * ordinary affiliated save that is the same thirty clubs to the man — the
   * affiliates are excluded by their parent, and the Arizona Fall League by
   * having no league row at all — so nothing changes for anybody else.
   */
  /*
   * The colours are optional. This endpoint is the way into everything else in
   * the app, so a save that does not carry them should lose its team colours
   * and nothing more — not every club in the picker.
   */
  const colours = hasColumns(
    'teams', 'background_color_id', 'text_color_id',
    'jersey_secondary_color_id', 'ballcaps_main_color_id'
  );
  const rows = db
    .prepare(
      `SELECT t.team_id, t.name, t.nickname, t.human_team, t.level,
              ${colours
                ? `t.background_color_id AS bg, t.text_color_id AS fg,
                   t.jersey_secondary_color_id AS secondary, t.ballcaps_main_color_id AS cap`
                : `NULL AS bg, NULL AS fg, NULL AS secondary, NULL AS cap`}
       FROM teams t
       JOIN leagues l ON l.league_id = t.league_id
       WHERE t.allstar_team = 0
         AND COALESCE(t.parent_team_id, 0) = 0
         AND COALESCE(l.parent_league_id, 0) = 0
       ORDER BY t.level, t.name`
    )
    .all() as Array<{
    team_id: number; name: string; nickname: string; human_team: number; level: number;
    bg: string | null; fg: string | null; secondary: string | null; cap: string | null;
  }>;
  /*
   * Say the level where it is not the top one. On an affiliated save nobody
   * ever sees this; on an unaffiliated one it is the only thing telling a
   * Double-A club apart from the major-league club it is not attached to.
   */
  const mixed = new Set(rows.map((r) => r.level)).size > 1;
  res.json(
    rows.map((r) => ({
      team_id: r.team_id,
      label: r.name === r.nickname ? r.name : `${r.name} ${r.nickname}`,
      levelName: mixed ? LEVEL_NAMES[r.level] ?? `L${r.level}` : null,
      isHuman: r.human_team === 1,
      colors: { bg: r.bg, fg: r.fg, secondary: r.secondary, cap: r.cap },
    }))
  );
});

/** The column signings nobody has assigned yet are gathered under. */
const UNASSIGNED_TEAM = -1;

export function orgTeams(orgId: number) {
  return db
    .prepare(
      `SELECT team_id, name, nickname, level FROM teams
       WHERE team_id = ? OR parent_team_id = ? ORDER BY level, team_id`
    )
    .all(orgId, orgId) as Array<{ team_id: number; name: string; nickname: string; level: number }>;
}

export interface OrgPlayer {
  player_id: number;
  team_id: number;
  first_name: string;
  last_name: string;
  age: number;
  position: number;
  role: number;
  /**
   * Hands, birth date and the league he is listed under, for the planner. Each
   * is null on a save whose export lacks the column, and the pages that do not
   * need them never read them.
   */
  bats: number | null;
  throws: number | null;
  date_of_birth: string | null;
  /** Negative for a man in the international complex, who belongs to no club. */
  league_id: number | null;
  /** 0 when the save has him on no roster — signed, not yet assigned. */
  rostered: number;
  con: number | null; gap: number | null; pow: number | null; eye: number | null; avk: number | null;
  conP: number | null; gapP: number | null; powP: number | null; eyeP: number | null; avkP: number | null;
  stu: number | null; mov: number | null; ctl: number | null;
  stuP: number | null; movP: number | null; ctlP: number | null;
  spd: number | null;
  /** OOTP's own Overall and Potential, when the export carries them. */
  oa: number | null;
  potOa: number | null;
}

/**
 * Prefer OOTP's exact grade; fall back when a save only carries the rounded one.
 *
 * Settled on first use rather than when the module loads. It was a constant,
 * decided once by whichever database was open at start-up — an empty one on a
 * first run, so the rounded grade stayed in use after the first import until
 * the app was restarted, and a save switch kept the last save's choice.
 */
let gradeColumnChoice: { oa: string; pot: string } | null = null;

function gradeColumns(): { oa: string; pot: string } {
  if (gradeColumnChoice) return gradeColumnChoice;
  // Empty when the table is not there, which falls back the same way
  const have = tableColumns('players_value');
  gradeColumnChoice = {
    oa: have.includes('oa') ? 'v.oa' : 'v.oa_rating',
    pot: have.includes('pot') ? 'v.pot' : 'v.pot_rating',
  };
  return gradeColumnChoice;
}

/** The latest season in each career stats table, once per import; see {@link latestStatsYear}. */
let statsYears: { batting: number | null; pitching: number | null } | null = null;

/**
 * The latest season with a line in each career stats table, null for a table
 * that is missing or empty.
 *
 * "This season" is read this way by the farm pages, the season form and the
 * planner, and on a save imported before the year indexes existed every read
 * was a scan of the whole table — 700,000 batting lines and 390,000 pitching
 * ones, about 155 ms each — paid once per club by the planner and the
 * contracts page. The answer only changes when an import replaces the
 * tables, so it is kept until clearOrgCache() runs after one.
 */
export function latestStatsYear(): { batting: number | null; pitching: number | null } {
  if (statsYears) return statsYears;
  const max = (t: string): number | null =>
    tableExists(t) ? (db.prepare(`SELECT MAX(year) AS y FROM "${t}"`).get() as { y: number | null }).y : null;
  statsYears = { batting: max('players_career_batting_stats'), pitching: max('players_career_pitching_stats') };
  return statsYears;
}

/** Called after an import, since a different save may carry different columns. */
export function clearOrgCache(): void {
  gradeColumnChoice = null;
  statsYears = null;
}

export function orgPlayers(orgId: number): OrgPlayer[] {
  const grade = gradeColumns();
  // Each guarded on its own: an older export may carry the hands and not the birth date
  const optional = ['bats', 'throws', 'date_of_birth', 'league_id']
    .map((c) => (hasColumns('players', c) ? `p.${c}` : `NULL AS ${c}`));
  return db
    .prepare(
      `SELECT p.player_id, p.team_id, p.first_name, p.last_name, p.age, p.position, p.role,
              ${optional.join(', ')},
              b.batting_ratings_overall_contact AS con, b.batting_ratings_overall_gap AS gap,
              b.batting_ratings_overall_power AS pow, b.batting_ratings_overall_eye AS eye,
              b.batting_ratings_overall_strikeouts AS avk,
              b.batting_ratings_talent_contact AS conP, b.batting_ratings_talent_gap AS gapP,
              b.batting_ratings_talent_power AS powP, b.batting_ratings_talent_eye AS eyeP,
              b.batting_ratings_talent_strikeouts AS avkP,
              b.running_ratings_speed AS spd,
              pi.pitching_ratings_overall_stuff AS stu, pi.pitching_ratings_overall_movement AS mov,
              pi.pitching_ratings_overall_control AS ctl,
              pi.pitching_ratings_talent_stuff AS stuP, pi.pitching_ratings_talent_movement AS movP,
              pi.pitching_ratings_talent_control AS ctlP,
              ${grade.oa} AS oa, ${grade.pot} AS potOa,
              /*
               * Whether he is on a roster anywhere.
               *
               * OOTP parks a signing nobody has assigned yet on the parent
               * club's team_id with no roster entry at all, which is how a
               * dozen sixteen-year-olds out of the international complex came
               * to be listed among the major-league pitchers. Every one of the
               * thirty clubs in this save carries a few. A man actually on the
               * club appears in team_roster; these do not.
               */
              EXISTS (SELECT 1 FROM team_roster r WHERE r.player_id = p.player_id) AS rostered
       FROM players p
       LEFT JOIN players_batting b ON b.player_id = p.player_id
       LEFT JOIN players_pitching pi ON pi.player_id = p.player_id
       LEFT JOIN players_value v ON v.player_id = p.player_id
       WHERE p.organization_id = ? AND p.team_id > 0 AND p.retired = 0`
    )
    .all(orgId) as OrgPlayer[];
}

/**
 * Current ability and ceiling, as OOTP itself grades them.
 *
 * These pages used to average a player's component ratings — stuff, movement
 * and control for a pitcher; contact, gap, power, eye and avoid-K for a hitter
 * — and print the result in the same "current → potential" style the player
 * card uses for OOTP's own Overall. The two disagreed constantly, because an
 * unweighted mean of five scouted tools is not the same thing as a weighted,
 * position-aware Overall, and a user cross-checking the farm page against the
 * game found numbers that varied wildly with no way to tell why.
 *
 * OOTP's own grades are now used everywhere they are available, so the depth
 * chart, the farm pages, the roster and the player card all quote one number.
 * The old average survives only as a fallback for an export without
 * players_value, where something is better than an empty column.
 */
export function composites(p: OrgPlayer): { cur: number | null; pot: number | null } {
  if (p.oa !== null && p.oa !== undefined) {
    return { cur: p.oa, pot: p.potOa ?? p.oa };
  }
  if (p.position === 1) {
    return { cur: avg([p.stu, p.mov, p.ctl]), pot: avg([p.stuP, p.movP, p.ctlP]) };
  }
  return {
    cur: avg([p.con, p.gap, p.pow, p.eye, p.avk]),
    pot: avg([p.conP, p.gapP, p.powP, p.eyeP, p.avkP]),
  };
}

orgRoutes.get('/depth-chart/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });
  const teams = orgTeams(orgId).map((t) => ({
    ...t,
    label: `${t.name} ${t.nickname}`,
    levelName: LEVEL_NAMES[t.level] ?? `L${t.level}`,
  }));
  const roster = orgPlayers(orgId);
  /*
   * A signing nobody has assigned yet sits on the parent club's team_id with
   * no roster entry, so the depth chart had a dozen sixteen-year-olds out of
   * the international complex standing among the major-league pitchers. They
   * belong to the organisation and not to that club, so they get a column of
   * their own rather than being hidden — every one of the thirty clubs in this
   * save has some, and quietly dropping them would lose real prospects.
   */
  const unassigned = roster.some((p) => !p.rostered);
  if (unassigned) {
    teams.push({
      team_id: UNASSIGNED_TEAM,
      name: 'Unassigned',
      nickname: '',
      level: 99,
      label: 'Unassigned',
      levelName: 'ORG',
    });
  }
  const players = roster.map((p) => {
    const { cur, pot } = composites(p);
    return {
      player_id: p.player_id,
      team_id: p.rostered ? p.team_id : UNASSIGNED_TEAM,
      name: `${p.first_name} ${p.last_name}`,
      age: p.age,
      position: p.position,
      role: p.role,
      cur,
      pot,
    };
  });
  res.json({ teams, players });
});

/** Aggregate latest-season stats per player (split 1 = overall). */
/**
 * OOTP keeps a drafted amateur's school season in career stats alongside his
 * professional one, under no league at all (`league_id = 0`, levels 10 and 11
 * for college and high school). Summing every row therefore credits a new
 * draftee with what he did to high schoolers — six WAR and a full season of
 * plate appearances — which sails past the promotion gates the moment he signs
 * and is assigned to an affiliate.
 *
 * Only professional lines count. In this save the two are cleanly separable:
 * every `league_id = 0` row is level 10 or 11, and no real league uses either.
 */
/**
 * One line per level, not one line per man.
 *
 * A reader wrote in about a prospect credited with "a 1.120 OPS and 21 HR in
 * just 181 PAs" at Triple-A, where he was in fact hitting .200 — all 21 home
 * runs were struck at Double-A, and the two seasons had been added together
 * and then labelled with whichever club he happened to be on. A promotion case
 * built on that is a promotion case for somebody who does not exist, and it
 * was compared against the Triple-A average as well, so the mismatch was
 * counted twice in his favour.
 *
 * Keying by level costs nothing and it is what the question means: how is he
 * doing where he is now.
 */
export const statKey = (playerId: number, level: number): string => `${playerId}:${level}`;

export function seasonBatting(): Map<string, Record<string, number>> {
  const t = 'players_career_batting_stats';
  const out = new Map<string, Record<string, number>>();
  if (!tableExists(t)) return out;
  const year = latestStatsYear().batting;
  const rows = db
    .prepare(
      `SELECT player_id, level_id, SUM(pa) AS pa, SUM(ab) AS ab, SUM(h) AS h, SUM(d) AS d,
              SUM(t) AS t, SUM(hr) AS hr, SUM(bb) AS bb, SUM(hp) AS hp, SUM(k) AS k,
              SUM(sf) AS sf, SUM(sb) AS sb, SUM(war) AS war
       FROM "${t}" WHERE year = ? AND split_id = 1 AND league_id != 0
       GROUP BY player_id, level_id`
    )
    .all(year) as Array<Record<string, number>>;
  for (const r of rows) out.set(statKey(r.player_id, r.level_id), r);
  return out;
}

/** Professional lines only, per level, for the same reasons as {@link seasonBatting}. */
export function seasonPitching(): Map<string, Record<string, number>> {
  const t = 'players_career_pitching_stats';
  const out = new Map<string, Record<string, number>>();
  if (!tableExists(t)) return out;
  const year = latestStatsYear().pitching;
  const rows = db
    .prepare(
      `SELECT player_id, level_id, SUM(outs) AS outs, SUM(er) AS er, SUM(bb) AS bb,
              SUM(k) AS k, SUM(bf) AS bf, SUM(ha) AS ha, SUM(g) AS g, SUM(gs) AS gs,
              SUM(war) AS war
       FROM "${t}" WHERE year = ? AND split_id = 1 AND league_id != 0
       GROUP BY player_id, level_id`
    )
    .all(year) as Array<Record<string, number>>;
  for (const r of rows) out.set(statKey(r.player_id, r.level_id), r);
  return out;
}

/** Average, on-base and slugging from a summed line; null with no at-bats. */
const slashOf = (s: Record<string, number>): { avg: number; obp: number; slg: number } | null => {
  const ab = s.ab ?? 0;
  if (!ab) return null;
  const singles = s.h - s.d - s.t - s.hr;
  const obpDen = ab + s.bb + s.hp + s.sf;
  return {
    avg: s.h / ab,
    obp: obpDen ? (s.h + s.bb + s.hp) / obpDen : 0,
    slg: (singles + 2 * s.d + 3 * s.t + 4 * s.hr) / ab,
  };
};

export const ops = (s: Record<string, number>): number | null => {
  const line = slashOf(s);
  return line === null ? null : line.obp + line.slg;
};

/** ".198/.301/.385", the way the Lineup page and the box score write it. */
export const slashLine = (s: Record<string, number>): string | null => {
  const line = slashOf(s);
  if (line === null) return null;
  const three = (v: number) => v.toFixed(3).replace(/^0\./, '.');
  return `${three(line.avg)}/${three(line.obp)}/${three(line.slg)}`;
};

/**
 * League-wide per-level baselines (avg age of rostered players; avg OPS / ERA / K%
 * of players with a meaningful sample), computed from THIS save's data so the
 * thresholds self-calibrate to the league environment.
 */
function levelBaselines(batting: Map<string, Record<string, number>>, pitching: Map<string, Record<string, number>>) {
  const players = db
    .prepare(
      `SELECT p.player_id, p.age, p.position, t.level FROM players p
       JOIN teams t ON t.team_id = p.team_id
       WHERE p.retired = 0 AND t.level >= 1 AND t.allstar_team = 0`
    )
    .all() as Array<{ player_id: number; age: number; position: number; level: number }>;

  const acc = new Map<number, { ages: number[]; ops: number[]; era: number[]; kpct: number[] }>();
  for (const p of players) {
    if (!acc.has(p.level)) acc.set(p.level, { ages: [], ops: [], era: [], kpct: [] });
    const a = acc.get(p.level)!;
    a.ages.push(p.age);
    // The line he produced AT this level, so the level's own average is not
    // built partly out of what its players did somewhere else
    const b = batting.get(statKey(p.player_id, p.level));
    if (b && (b.pa ?? 0) >= 50) {
      const o = ops(b);
      if (o !== null) a.ops.push(o);
    }
    const pi = pitching.get(statKey(p.player_id, p.level));
    if (pi && (pi.outs ?? 0) >= 45) {
      a.era.push(((pi.er ?? 0) / (pi.outs / 3)) * 9);
      if (pi.bf > 0) a.kpct.push(pi.k / pi.bf);
    }
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : null);
  const out: Record<number, { avgAge: number | null; avgOps: number | null; avgEra: number | null; avgKpct: number | null }> = {};
  for (const [level, a] of acc) {
    out[level] = { avgAge: mean(a.ages), avgOps: mean(a.ops), avgEra: mean(a.era), avgKpct: mean(a.kpct) };
  }
  return out;
}


const POSITION_NAMES: Record<number, string> = {
  1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF', 10: 'DH',
};

/**
 * A grade gap chosen on the 20-80 scale, carried onto the scale this save shows.
 *
 * Every gap on this page was picked on 20-80 — five points from his ceiling,
 * fifteen of upside — and meant nothing on any other scale. On the 1-to-5
 * scale every man is within five points of his ceiling, so the whole farm read
 * "near ceiling — development mostly done", and nobody could ever show fifteen
 * points of upside. The top of the scale is read off the data (ratingScaleMax),
 * and a gap is the same share of it whichever scale writes it: 5 stays 5 on
 * 20-80 and is about 0.3 on 1-5, and 15 is about 0.9.
 */
export const onScale = (gapOn80: number): number => (gapOn80 * ratingScaleMax()) / 80;

/** Within this of his ceiling (20-80 points), he is close to what he will be. */
const NEAR_CEILING = 5;
/** This far under it (20-80 points), there is real development still to come. */
const HIGH_UPSIDE = 15;

/** What calling a man up would actually cost, and whether it is worth it. */
export interface CorrespondingMove {
  /** The weakest man at his spot on the big club — the one he would displace. */
  replaces: { player_id: number; name: string; cur: number | null } | null;
  /** How many men at his spot are graded above him. */
  ahead: number;
  /** The best of the men ahead of him, for the sentence the page prints. */
  bestAhead: { player_id: number; name: string; cur: number | null } | null;
  blocked: boolean;
  note: string;
  /**
   * Set when the move is a call-up of a man who is not on the 40-man and the
   * 40-man is full: a place on it has to be found first, and this names the
   * man who could most cheaply give his up, when anybody obviously can.
   */
  fortyMan: {
    count: number;
    limit: number;
    comesOff: { player_id: number; name: string; why: string } | null;
  } | null;
}

/** The 40-man limit, written the way the 40-Man Roster page writes it. */
export const FORTY_MAN_LIMIT = 40;

/** How long a man has to be out to go on the 60-day injured list. */
const SIXTY_DAY_IL = 60;

export interface FortyManRoom {
  /** Places taken, counted the way the 40-Man Roster page counts them. */
  count: number;
  /** Everyone on the 40-man list, the 60-day IL included. */
  on: Set<number>;
  /** The first of `offList`: the one man who could most cheaply give up his place. */
  comesOff: { player_id: number; name: string; why: string } | null;
  /**
   * Everyone who could cheaply give up a place, in the order to use them: the
   * men out long enough for the 60-day list, then the men out of options, each
   * lowest grade first. The planner takes one per place it needs, so two
   * additions never name the same man.
   */
  offList: Array<{ player_id: number; name: string; why: string }>;
}

/**
 * Whether the organisation's 40-man has a place for a call-up, and if not, who
 * could give his up.
 *
 * The farm page used to stop at the 26: it named the man a call-up would take
 * the place of and never asked whether the call-up could go on the 40-man at
 * all. A man who is not on it needs a place there as well, and on a full
 * roster that is a second decision the page was leaving out.
 *
 * The count and the list are the 40-Man Roster page's own (rosterCrunch), so
 * the two cannot disagree about whether the roster is full. Who could make way
 * is read in two steps. A man out long enough for the 60-day list costs
 * nothing to move there — that is what the list is for, and he stops counting
 * the day he goes on it — so he comes first. After him, the lowest-graded man
 * out of options: he cannot be sent down without clearing waivers anyway,
 * which makes him the one a full roster puts in play. Beyond those two, whom
 * the club values least is the reader's call and not a fact the save holds,
 * so the page says the roster is full and leaves it there.
 */
export function fortyManRoom(orgId: number, players: OrgPlayer[]): FortyManRoom | null {
  const crunch = rosterCrunch(orgId);
  if (!crunch) return null;

  // Whichever of these the export carries; a missing one costs its own reading only
  const have = new Set(tableColumns('players_roster_status'));
  const col = (c: string) => `${have.has(c) ? `rs.${c}` : 'NULL'} AS ${c}`;
  const injury = tableColumns('players').includes('injury_left') ? 'p.injury_left' : 'NULL';
  const detail = new Map(
    (
      db
        .prepare(
          `SELECT rs.player_id,
                  ${['is_active', 'is_on_dl', 'is_on_dl60', 'options_used', 'options_used_this_year', 'mlb_service_days', 'mlb_service_years']
                    .map(col).join(', ')},
                  ${injury} AS injury_left
           FROM players_roster_status rs JOIN players p ON p.player_id = rs.player_id
           WHERE p.organization_id = ? AND p.retired = 0`
        )
        .all(orgId) as Array<Record<string, number | null>>
    ).map((r) => [r.player_id as number, r])
  );
  const grade = new Map(players.map((p) => [p.player_id, composites(p).cur]));

  type Candidate = { player_id: number; name: string; cur: number | null; why: string };
  const toTheSixty: Candidate[] = [];
  const noOptions: Candidate[] = [];
  for (const m of crunch.fortyMan) {
    if (m.il60) continue; // already off the count, so moving him frees nothing
    const d = detail.get(m.player_id);
    if (!d) continue;
    const him = { player_id: m.player_id, name: m.name, cur: grade.get(m.player_id) ?? null };
    const health = healthOf(d);
    if (health?.status === 'IL' && (health.daysLeft ?? 0) >= SIXTY_DAY_IL) {
      toTheSixty.push({ ...him, why: 'to the 60-day IL' });
    } else if (
      /*
       * Out of options the way optionState() reads it, the one reading the
       * planner and the 40-Man page share: (3 used, 1 this year) is a last
       * option year and he can still go up and down until it ends, so he is
       * not the man a full roster puts in play. A man on the 26 is not named
       * either: designating him changes the 26 as well, which the call-up
       * that needs the place already settles on its own.
       */
      !m.on26 &&
      optionState({
        optionsUsed: d.options_used, optionsUsedThisYear: d.options_used_this_year, on40: true, on26: false,
        serviceYears: serviceYearsOf(d.mlb_service_days, d.mlb_service_years),
      }) === 'out-of-options'
    ) {
      noOptions.push({ ...him, why: 'out of options' });
    }
  }
  const byGrade = (xs: Candidate[]): Candidate[] =>
    [...xs].sort((a, b) => (a.cur ?? Infinity) - (b.cur ?? Infinity) || a.player_id - b.player_id);
  const offList = [...byGrade(toTheSixty), ...byGrade(noOptions)]
    .map((c) => ({ player_id: c.player_id, name: c.name, why: c.why }));

  return {
    count: crunch.counts.fortyMan,
    on: new Set(crunch.fortyMan.map((m) => m.player_id)),
    comesOff: offList[0] ?? null,
    offList,
  };
}

/** A man holding a place at the spot, with what the move needs to say about him. */
interface Incumbent {
  player_id: number;
  name: string;
  cur: number;
  age: number;
  /** This season at the big club's level, as the contracts page reads it. */
  form: SeasonForm | null;
  /** That season in the words the move prints, for when it is the reason. */
  quote: string | null;
}

/**
 * When a man graded above the call-up does not hold him off.
 *
 * Emil Morales — twenty-one, a 1.072 OPS at Double-A, ten home runs and 2.3
 * WAR in 147 trips — was "blocked at 3B — Max Muncy grades 56 to his 41". The
 * same Max Muncy was thirty-seven and hitting .198/.301/.385, an 87 wRC+; the
 * dashboard had him cold, and the contracts page said "hold off" because the
 * season did not back an extension. Those pages judged him on his season, this
 * one on his scouting grade alone, and so they told the reader opposite things
 * about the same man.
 *
 * So the season and the age come in here as they do there. The season is
 * form.ts's reading, the one the contracts page uses, and it is only "poor" on
 * a hundred plate appearances or twenty innings — a bad fortnight is not
 * evidence. Either one excuses a grade lead, within limits (20-80 points):
 *
 *   a poor season   a lead of up to 20. A slump does not turn a 70 into a 40,
 *                   and past two full grades the scouting is still the better
 *                   guide: a hot Single-A bat graded 33 is not sent up to take
 *                   the place of a 56, however cold the 56 is.
 *   33 or older     a lead of up to 10. A veteran's small edge is not one he
 *                   is going to keep, and the young man's is still growing.
 *
 * The bar is still the weakest man at the spot. A slump by the best player
 * there does not open a place on the roster; the man who would come off is
 * the weakest one, and only his lead can be excused.
 */
const SLUMP_LEAD = 20;
const VETERAN_AGE = 33;
const VETERAN_LEAD = 10;

/** Why his grade lead does not hold the call-up off, or null when it does. */
function whyNotInTheWay(m: Incumbent, cur: number): string | null {
  const lead = m.cur - cur;
  const slumping = m.form?.verdict === 'poor';
  const veteran = m.age >= VETERAN_AGE;
  const excused =
    (slumping && lead <= onScale(SLUMP_LEAD)) || (veteran && lead <= onScale(VETERAN_LEAD));
  if (!excused) return null;
  return [
    slumping ? m.quote ?? 'is having a poor season' : null,
    veteran ? `is ${m.age}` : null,
  ].filter(Boolean).join(' and ');
}

/**
 * His season in the words the move prints: a slash line for a bat, an ERA for
 * an arm. From his professional line at the big club's level, which is the
 * line the Lineup and staff pages show, so the numbers match what the reader
 * saw there.
 */
function seasonQuote(
  m: OrgPlayer,
  level: number,
  batting: Map<string, Record<string, number>>,
  pitching: Map<string, Record<string, number>>,
  form: SeasonForm | null
): string | null {
  if (m.position === 1) {
    const s = pitching.get(statKey(m.player_id, level));
    if (s && (s.outs ?? 0) > 0) return `has a ${(((s.er ?? 0) / (s.outs / 3)) * 9).toFixed(2)} ERA this year`;
  } else {
    const s = batting.get(statKey(m.player_id, level));
    const line = s ? slashLine(s) : null;
    if (line) return `is hitting ${line} this year`;
  }
  return form?.line ? `is having a poor season (${form.line})` : null;
}

/**
 * Who would have to come off the big club to make room, and whether the swap
 * is an improvement.
 *
 * The farm page ranked minor leaguers against their own level and stopped
 * there, so it recommended three call-ups without once looking at the men
 * already in the majors — and a reader with a better man at every one of those
 * spots was being told to make his club worse. A promotion is a swap; naming
 * only half of it is naming none of it.
 *
 * The comparison runs on OOTP's Overall grade rather than on the season lines,
 * and that is the whole reason it can be made at all: a .900 OPS in Double-A
 * and a .900 OPS in the majors are not the same achievement, and putting them
 * in the same column would be the exact mistake this exists to prevent. The
 * grade is scouted current ability, level-independent by construction, and it
 * is the number the rest of the app already quotes.
 *
 * The bar is beating the WEAKEST man at the spot, which is the least he can be
 * asked: he is not being made a starter, he is being given a place on the
 * roster. Where the grade is missing for either man no verdict is offered at
 * all, since the alternative is a recommendation resting on a blank.
 *
 * The incumbent's own season and age are the exception, and only his: the
 * prospect's line has already earned him the look at his own level, but a
 * veteran's grade lead can be undone by what he is doing in the majors this
 * year, which the grade does not see. See {@link whyNotInTheWay}.
 */
export function correspondingMoves(
  orgId: number,
  players: OrgPlayer[],
  batting: Map<string, Record<string, number>>,
  pitching: Map<string, Record<string, number>>
): Map<number, CorrespondingMove> {
  const out = new Map<number, CorrespondingMove>();

  /*
   * The big club, and only the men genuinely holding a place on it.
   *
   * A reader was told to promote four Triple-A pitchers, every one of them
   * measured against Chad Russell — a first-rounder from the draft just
   * finished, signed the day before, sitting on the DFA list because he had
   * not been assigned to a farm club yet, and who "hasn't thrown a single
   * professional pitch". He is not somebody a call-up displaces. He is
   * somebody already on his way out of the organisation.
   *
   * "On a roster somewhere" was too weak a test for that, and it did not even
   * ask WHICH club's roster. The question is who is on the major-league active
   * roster and staying there, so it asks for exactly that: this club's active
   * list, active, and neither designated for assignment nor on waivers.
   *
   * Where the export has no roster-status table the old test is all there is,
   * which is better than offering no verdict at all — but it is the weaker
   * one, and this is the case it gets wrong.
   */
  const statuses = tableExists('players_roster_status')
    ? new Map(
        (
          db
            .prepare(
              `SELECT player_id, is_active,
                      COALESCE(designated_for_assignment, 0) AS dfa,
                      COALESCE(is_on_waivers, 0) AS waivers
               FROM players_roster_status`
            )
            .all() as Array<{ player_id: number; is_active: number; dfa: number; waivers: number }>
        ).map((r) => [r.player_id, r])
      )
    : null;
  const onTheActiveList = new Set(
    (
      db
        .prepare(`SELECT player_id FROM team_roster WHERE team_id = ? AND list_id = 1`)
        .all(orgId) as Array<{ player_id: number }>
    ).map((r) => r.player_id)
  );
  const holdsAPlace = (p: OrgPlayer): boolean => {
    if (p.team_id !== orgId) return false;
    if (!onTheActiveList.has(p.player_id)) return false;
    /*
     * Being on the club's active list is the evidence; the status row can only
     * overturn it. A man there with no row at all is counted, because the
     * wrong way to be wrong here is to empty the roster and start recommending
     * call-ups over men who are in fact standing on it.
     */
    const s = statuses?.get(p.player_id);
    if (!s) return true;
    return s.is_active === 1 && s.dfa === 0 && s.waivers === 0;
  };

  const majors = players.filter(holdsAPlace);
  // This season at the big club's own level, read the way the contracts page reads it
  const form = seasonFormByPlayer(orgId);
  const bigLevel =
    (db.prepare(`SELECT level FROM teams WHERE team_id = ?`).get(orgId) as { level: number } | undefined)
      ?.level ?? 1;
  const byPosition = new Map<number, Incumbent[]>();
  for (const m of majors) {
    const { cur } = composites(m);
    if (cur === null) continue;
    /*
     * Pitchers are grouped as pitchers rather than by rotation slot. A starter
     * and a reliever hold the same kind of place on a twenty-six-man roster,
     * and OOTP's role flag moves around often enough that splitting on it
     * would have men blocked one week and clear the next.
     */
    const spot = m.position === 1 ? 1 : m.position;
    const list = byPosition.get(spot) ?? [];
    const season = form.get(m.player_id) ?? null;
    list.push({
      player_id: m.player_id,
      name: `${m.first_name} ${m.last_name}`,
      cur,
      age: m.age,
      form: season,
      quote: seasonQuote(m, bigLevel, batting, pitching, season),
    });
    byPosition.set(spot, list);
  }
  // Only who and how good go out with the move; the rest is for the sentence
  const named = (m: Incumbent) => ({ player_id: m.player_id, name: m.name, cur: m.cur });

  /*
   * A call-up of a man who is not on the 40-man needs a place there too. Said
   * after the move rather than instead of it: the swap is still the right one
   * or not on its merits, and the roster space is the next thing to sort out.
   */
  const room = fortyManRoom(orgId, players);
  const withRoom = (playerId: number, move: CorrespondingMove): CorrespondingMove => {
    if (move.blocked || !room || room.on.has(playerId) || room.count < FORTY_MAN_LIMIT) return move;
    const off = room.comesOff;
    return {
      ...move,
      note: `${move.note}; ${off ? `needs a 40-man spot: ${off.name} (${off.why})` : '40-man is full'}`,
      fortyMan: { count: room.count, limit: FORTY_MAN_LIMIT, comesOff: off },
    };
  };

  for (const p of players) {
    if (p.team_id === orgId) continue; // already there
    const { cur } = composites(p);
    if (cur === null) continue;
    const spot = p.position === 1 ? 1 : p.position;
    const incumbents = byPosition.get(spot);
    const where = POSITION_NAMES[spot] ?? `position ${spot}`;
    if (!incumbents || incumbents.length === 0) {
      out.set(p.player_id, withRoom(p.player_id, {
        replaces: null, ahead: 0, bestAhead: null, blocked: false,
        note: `nobody at ${where} on the big club`,
        fortyMan: null,
      }));
      continue;
    }
    const sorted = [...incumbents].sort((a, b) => a.cur - b.cur);
    const weakest = sorted[0];
    const ahead = sorted.filter((m) => m.cur >= cur);
    const best = sorted[sorted.length - 1];
    /*
     * A grade equal to the man in the way is not a reason to move anybody, so
     * it counts as blocked — the tie goes to the roster you already have.
     * Unless the weakest man's season or age says his grade is not the whole
     * story, in which case his lead, a tie included, does not hold anyone off.
     */
    const excuse = weakest.cur >= cur ? whyNotInTheWay(weakest, cur) : null;
    const blocked = weakest.cur >= cur && excuse === null;
    out.set(p.player_id, withRoom(p.player_id, {
      replaces: blocked ? null : named(weakest),
      ahead: ahead.length,
      bestAhead: ahead.length > 0 ? named(best) : null,
      blocked,
      note: blocked
        ? incumbents.length === 1
          ? `blocked at ${where} — ${best.name} grades ${best.cur} to his ${cur}`
          : `blocked at ${where} — all ${incumbents.length} graded above him, best ${best.name} at ${best.cur} to his ${cur}`
        : excuse !== null
          ? `would take ${weakest.name}'s spot at ${where} — ${weakest.name} grades ${weakest.cur} to his ${cur}, but ${excuse}`
          : `would take ${weakest.name}'s spot at ${where} — ${cur} to his ${weakest.cur}`,
      fortyMan: null,
    }));
  }
  return out;
}

/**
 * The gaps a promotion case is made on, each read by the signal and by the Why
 * column alike. They were two numbers apiece and had drifted apart: a hitter
 * was flagged for promotion at .075 of OPS over his level and his reason was
 * only written from .100, so a man between the two carried PROMOTE beside an
 * empty Why.
 */
const OPS_CALL_UP = 0.075;
const ERA_CALL_UP = 1.0;

export function computeProspects(orgId: number): { batters: unknown[]; pitchers: unknown[]; baselines: unknown } {
  const batting = seasonBatting();
  const pitching = seasonPitching();
  const baselines = levelBaselines(batting, pitching);
  const teams = new Map(orgTeams(orgId).map((t) => [t.team_id, t]));

  const batters: unknown[] = [];
  const pitchers: unknown[] = [];
  const roster = orgPlayers(orgId);
  const moves = correspondingMoves(orgId, roster, batting, pitching);

  /*
   * The bottom of the organisation, so nobody is told to send a man below it.
   * Read rather than assumed: an org may have two rookie clubs and no Single-A,
   * or a level this app has never seen, and "demote" only means something if
   * there is somewhere for him to go.
   */
  const lowestLevel = Math.max(...[...teams.values()].map((t) => t.level));

  for (const p of roster) {
    const team = teams.get(p.team_id);
    if (!team || team.level <= 1) continue; // only minor leaguers
    const base = baselines[team.level];
    if (!base) continue;
    const { cur, pot } = composites(p);
    const ageDiff = base.avgAge !== null ? base.avgAge - p.age : null;
    const common = {
      player_id: p.player_id,
      name: `${p.first_name} ${p.last_name}`,
      age: p.age,
      // The position, named here as every other endpoint names it. A farm page
      // is read looking for a catcher or an arm, the same as the development
      // one is.
      positionName: POSITION_NAMES[p.position] ?? '',
      team: `${team.name} ${team.nickname}`,
      level: team.level,
      levelName: LEVEL_NAMES[team.level] ?? `L${team.level}`,
      cur,
      pot,
      ageDiff,
      move: moves.get(p.player_id) ?? null,
    };

    if (p.position === 1) {
      const s = pitching.get(statKey(p.player_id, team.level));
      // ~15 IP minimum, at the level he is actually pitching at. A man who has
      // just moved up has to earn the case again there rather than carry the
      // one he made below.
      if (!s || (s.outs ?? 0) < 45) continue;
      const ip = s.outs / 3;
      const era = ((s.er ?? 0) / ip) * 9;
      const kpct = s.bf > 0 ? s.k / s.bf : 0;
      const eraDiff = base.avgEra !== null ? base.avgEra - era : 0;
      const kDiff = base.avgKpct !== null ? kpct - base.avgKpct : 0;
      const reasons: string[] = [];
      if (eraDiff >= ERA_CALL_UP) reasons.push(`ERA ${era.toFixed(2)} vs level avg ${base.avgEra!.toFixed(2)}`);
      /*
       * The case against him, said out loud. Without this a man carried a
       * DEMOTE badge beside an empty column: the app asserting something and
       * showing nothing for it, which is the one thing every other
       * recommendation in here is careful not to do.
       */
      if (eraDiff <= -1.25) {
        reasons.push(`ERA ${era.toFixed(2)} against a level average of ${base.avgEra!.toFixed(2)}`);
        if (ageDiff !== null && ageDiff < 0) {
          reasons.push(`and ${Math.abs(ageDiff).toFixed(1)} years older than the level`);
        }
      }
      if (kDiff >= 0.05) reasons.push(`K% ${(kpct * 100).toFixed(0)} vs level avg ${(base.avgKpct! * 100).toFixed(0)}`);
      if (ageDiff !== null && ageDiff >= 1.5) reasons.push(`young for level (${p.age} vs avg ${base.avgAge!.toFixed(1)})`);
      if (cur !== null && pot !== null && pot - cur <= onScale(NEAR_CEILING)) reasons.push('near ceiling — development mostly done');
      const score = eraDiff * 12 + kDiff * 200 + (ageDiff ?? 0) * 8;
      /*
       * Demotion asks more than promotion does, on purpose. Sending a man
       * down is the more consequential call and the easier one to get wrong,
       * so it wants a bigger gap, a longer look, and — the part that matters
       * most — a man who is not young for where he is. A nineteen-year-old
       * struggling at Double-A is on schedule; a twenty-six-year-old
       * struggling at Single-A is not the same sentence.
       */
      const signal =
        eraDiff >= ERA_CALL_UP && ip >= 30 ? callUp(p.player_id)
        : overmatched(eraDiff <= -1.25, ip >= 30, ageDiff, team.level) ? 'demote'
        : score > 5 ? 'watch'
        : null;
      if (signal !== null && reasons.length === 0) {
        reasons.push(biggestEdge([
          [eraDiff * 12, `ERA ${era.toFixed(2)} vs level avg ${base.avgEra?.toFixed(2)}`],
          [kDiff * 200, `K% ${(kpct * 100).toFixed(0)} vs level avg ${((base.avgKpct ?? 0) * 100).toFixed(0)}`],
          [(ageDiff ?? 0) * 8, `young for level (${p.age} vs avg ${base.avgAge?.toFixed(1)})`],
        ]));
      }
      pitchers.push({
        ...common, role: p.role, ip: Number(ip.toFixed(1)), era: Number(era.toFixed(2)),
        kpct: Number((kpct * 100).toFixed(1)), war: s.war ?? 0,
        score: Number(score.toFixed(1)), reasons, signal,
      });
    } else {
      const s = batting.get(statKey(p.player_id, team.level));
      if (!s || (s.pa ?? 0) < 60) continue;
      const o = ops(s);
      if (o === null) continue;
      const opsDiff = base.avgOps !== null ? o - base.avgOps : 0;
      const reasons: string[] = [];
      if (opsDiff >= OPS_CALL_UP) reasons.push(`OPS ${o.toFixed(3)} vs level avg ${base.avgOps!.toFixed(3)}`);
      // The case against him, for the same reason as the pitchers above
      if (opsDiff <= -0.1) {
        reasons.push(`OPS ${o.toFixed(3)} against a level average of ${base.avgOps!.toFixed(3)}`);
        if (ageDiff !== null && ageDiff < 0) {
          reasons.push(`and ${Math.abs(ageDiff).toFixed(1)} years older than the level`);
        }
      }
      if (ageDiff !== null && ageDiff >= 1.5) reasons.push(`young for level (${p.age} vs avg ${base.avgAge!.toFixed(1)})`);
      if (cur !== null && pot !== null && pot - cur <= onScale(NEAR_CEILING)) reasons.push('near ceiling — development mostly done');
      if (cur !== null && pot !== null && pot - cur >= onScale(HIGH_UPSIDE)) reasons.push('high remaining upside');
      const score = opsDiff * 300 + (ageDiff ?? 0) * 8;
      const signal =
        opsDiff >= OPS_CALL_UP && s.pa >= 100 ? callUp(p.player_id)
        : overmatched(opsDiff <= -0.100, s.pa >= 100, ageDiff, team.level) ? 'demote'
        : score > 5 ? 'watch'
        : null;
      if (signal !== null && reasons.length === 0) {
        reasons.push(biggestEdge([
          [opsDiff * 300, `OPS ${o.toFixed(3)} vs level avg ${base.avgOps?.toFixed(3)}`],
          [(ageDiff ?? 0) * 8, `young for level (${p.age} vs avg ${base.avgAge?.toFixed(1)})`],
        ]));
      }
      batters.push({
        ...common, pa: s.pa, opsVal: Number(o.toFixed(3)), hr: s.hr, sb: s.sb, war: s.war ?? 0,
        score: Number(score.toFixed(1)), reasons, signal,
      });
    }
  }

  /**
   * Whichever part of the score carried a man over the line, in words.
   *
   * Only reached when nothing else was said: a watch built out of two small
   * edges, neither big enough for a reason of its own, would otherwise wear its
   * badge beside an empty Why — the same fault the gap constants above fixed
   * for promote.
   */
  function biggestEdge(edges: Array<[number, string]>): string {
    return [...edges].sort((a, b) => b[0] - a[0])[0][1];
  }

  /**
   * A man who has earned a promotion, and what the big club has to say about it.
   *
   * Earning it at his level is the whole of what the signal used to mean, and
   * a reader with a better man at the same spot in the majors was being told
   * to make his club worse. Where every man at his position is graded above
   * him the verdict becomes `blocked` — he is still on the page, still worth
   * knowing about for an injury or a trade, but the app stops calling for a
   * move that costs the club something.
   */
  function callUp(playerId: number): 'promote' | 'blocked' {
    return moves.get(playerId)?.blocked ? 'blocked' : 'promote';
  }

  /**
   * Clearly below his level, with enough season behind it, and not young for it.
   *
   * The sample it asks for is the same one promote asks for; the asymmetry sits
   * entirely in how big the gap has to be. That is the honest place for it —
   * the claim is what differs, not the evidence needed to look. Demanding more
   * innings as well simply hid the men the feature exists to find: a
   * twenty-six-year-old carrying a 6.95 earned run average in Single-A missed
   * the first version of this by six innings and showed no badge at all.
   */
  function overmatched(
    belowLevel: boolean, enoughPlayed: boolean, ageDiff: number | null, level: number
  ): boolean {
    if (!belowLevel || !enoughPlayed) return false;
    // Being young for the level excuses the numbers; being old for it does not
    if (ageDiff === null || ageDiff > 0) return false;
    // Nowhere below to send him
    return level < lowestLevel;
  }

  const byScore = (a: unknown, b: unknown) => (b as { score: number }).score - (a as { score: number }).score;
  batters.sort(byScore);
  pitchers.sort(byScore);
  return { batters, pitchers, baselines };
}

orgRoutes.get('/prospects/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });
  res.json(computeProspects(orgId));
});
