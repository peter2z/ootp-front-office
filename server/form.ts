import { db, tableExists } from './db.js';
import { computeBatting, computePitching, leagueBaseline } from './stats.js';
// org.ts imports this module too; the cycle is safe because neither reads the other at load
import { latestStatsYear } from './org.js';

/**
 * How a man is actually playing this season, in one league-relative number.
 *
 * Written because the contract advice had none. It ran on OOTP's Value figure
 * alone, which is value TO THE CLUB and therefore counts playing time: among
 * the 280 major-league relievers in the save this was found in, Value tracked
 * innings pitched at +0.37 and ERA at +0.19 — the wrong way round, worse ERA
 * reading as slightly more valuable — while barely tracking the stuff rating
 * at all, at +0.12. A converted starter soaking up long relief therefore came
 * out near the top of the reliever pool whatever he did with the ball, and the
 * app told its reader to extend him before somebody else did.
 *
 * So the index here is deliberately the plainest thing available: 100 is the
 * league, higher is better, and it is the same familiar number the rest of the
 * app already shows on every player — wRC+ for a bat, ERA+ for an arm.
 */

/**
 * Enough of a season for the number to carry an argument.
 *
 * The same thresholds the two-way test uses, for the same reason: twenty
 * innings and a hundred trips are where a line stops being an anecdote. Below
 * these the verdict is 'unknown' rather than 'poor' — a man with nine innings
 * has not shown anything, and treating that as evidence against him would be
 * the same error in the opposite direction.
 */
const MEANINGFUL_OUTS = 60;
const MEANINGFUL_PA = 100;
const MEANINGFUL_IP = MEANINGFUL_OUTS / 3;

/** Comfortably above the league, roughly it, and clearly below it. */
const GOOD = 115;
const FAIR = 90;

export interface SeasonForm {
  /** League-relative, 100 is average: wRC+ for a batter, ERA+ for a pitcher. */
  index: number | null;
  /** Whether enough has been played for the index to mean anything. */
  meaningful: boolean;
  /** The line itself, for the page to show and the assistants to quote. */
  line: string | null;
  verdict: 'good' | 'fair' | 'poor' | 'unknown';
  /**
   * How much of the season he has played, in the unit the line is written in:
   * plate appearances for a batter, innings for a pitcher. Carried so that a
   * rule can ask whether a sample is large enough, which the verdict alone
   * cannot say — 'poor' covers 100 plate appearances and 600 alike.
   */
  sample: number;
  unit: 'PA' | 'IP';
}

export const UNKNOWN_FORM: SeasonForm = {
  index: null, meaningful: false, line: null, verdict: 'unknown', sample: 0, unit: 'PA',
};

/** ".248/.343/.392", written the way a slash line is written. */
function slash(
  avg: number | null | undefined, obp: number | null | undefined, slg: number | null | undefined
): string | null {
  if (avg == null || obp == null || slg == null) return null;
  const three = (v: number) => v.toFixed(3).replace(/^0\./, '.');
  return `${three(avg)}/${three(obp)}/${three(slg)}`;
}

const verdictOf = (index: number | null, meaningful: boolean): SeasonForm['verdict'] => {
  if (!meaningful || index === null) return 'unknown';
  if (index >= GOOD) return 'good';
  if (index >= FAIR) return 'fair';
  return 'poor';
};

/**
 * Whether a poor season line is entitled to overrule the Value figure yet.
 *
 * "Poor" is a verdict about the line, and it arrives at 100 plate appearances or
 * 20 innings, which is where a line becomes readable at all. It does not arrive
 * with the evidence to doubt a man. At 125 plate appearances the standard error
 * of a wRC+ is about 30 points (a plate appearance is worth a standard deviation
 * of roughly .5 in wOBA), so an 82 is under one standard error below an average
 * hitter and about one and a half below a 130 one: a bad month, not a verdict.
 * At 400 plate appearances the error is about 18. Over 20 innings the standard
 * error of an ERA+ is nearly 50 points, and over 80 it is about 25.
 *
 * Jackson Holliday, 24 years old, 96th percentile in value and 97th in talent,
 * was told to "hold off" on 125 plate appearances of .227/.320/.327. Nothing
 * about that line separates him from the player his ratings describe.
 *
 * How much it takes depends on how much the ratings deserve to be believed over
 * the line, which is a matter of two things:
 *
 *   age       a young player's ratings are the best guide to where he is going and
 *             a cold spell is the likelier explanation; an old one is declining
 *             and the line is part of the evidence for that
 *   talent    the higher the talent percentile, the further the true level is
 *             from the poor line and the longer a bad stretch can run unexplained
 *
 * Each multiplies the meaningful sample (100 PA, 20 IP):
 *
 *   age     25 or under x2    26-28 x1.5    29-32 x1    33 or over x0.75
 *   talent  90th pct up x2    75th x1.5     50th x1.25  25th x1    below x0.75
 *
 * and the product is held between one and four: a poor line is never ignored
 * once it is readable, and nobody is protected for more than four times that —
 * 400 plate appearances, 80 innings — which is most of a season for a hitter and
 * more than most relievers throw in one. The worked cases:
 *
 *   24 years old, 97th pct talent    400 PA    80 IP
 *   27, 80th                         225       45
 *   30, 60th                         125       25
 *   33, 40th                         100       20
 *   37, 73rd                         100       20
 *
 * These are judgments, not a fit. They are here so that the judgment is made in
 * one place, in the open, and can be moved by changing numbers rather than logic.
 *
 * Returns what the line needed as well as whether it got there, in the unit the
 * line is written in, so the page can say "400 PA" and not just "more".
 */
export function formDoubtsValue(
  form: SeasonForm, age: number, talentPct: number | null
): { doubts: boolean; needed: number } {
  const youth = age <= 25 ? 2 : age <= 28 ? 1.5 : age <= 32 ? 1 : 0.75;
  const promise =
    talentPct === null ? 1
    : talentPct >= 90 ? 2
    : talentPct >= 75 ? 1.5
    : talentPct >= 50 ? 1.25
    : talentPct >= 25 ? 1
    : 0.75;
  const multiple = Math.min(Math.max(youth * promise, 1), 4);
  const needed = Math.round((form.unit === 'PA' ? MEANINGFUL_PA : MEANINGFUL_IP) * multiple);
  return { doubts: form.verdict === 'poor' && form.sample >= needed, needed };
}

/**
 * This season's form for everyone on a club, at that club's own level.
 *
 * Scoped to the level deliberately. A reliever who has shuttled to Triple-A
 * and back has two lines, and blending them produces a number that describes
 * nobody — the same fault that once made the staff page disagree with OOTP's
 * own pitching screen.
 */
export function seasonFormByPlayer(teamId: number): Map<number, SeasonForm> {
  return seasonFormByClubs([teamId]).get(teamId) ?? new Map();
}

/**
 * {@link seasonFormByPlayer} for several clubs at once, keyed by club: each
 * club's men at that club's own level, against that club's own league-season
 * baseline, exactly as one call per club would give them.
 *
 * The planner asks for every club in an organisation, eight of them, and one
 * call apiece walked the season's stats eight times over; this walks them
 * once, the club and its level riding along on each line. A club the teams
 * table does not know is left out, as the single call returns nothing for it.
 */
export function seasonFormByClubs(teamIds: readonly number[]): Map<number, Map<number, SeasonForm>> {
  const result = new Map<number, Map<number, SeasonForm>>();
  if (!tableExists('players') || !tableExists('teams')) return result;
  const ids = [...new Set(teamIds)];
  if (ids.length === 0) return result;
  const marks = ids.map(() => '?').join(', ');

  const teams = db
    .prepare(`SELECT team_id, league_id, level FROM teams WHERE team_id IN (${marks})`)
    .all(...ids) as Array<{ team_id: number; league_id: number; level: number }>;
  if (teams.length === 0) return result;

  /*
   * The season, from whichever table has one. Reading it off the pitching
   * stats alone loses every batter in a save that has none — which is not the
   * hypothetical it sounds like: a league exported before its first game has
   * no pitching lines at all, and this would have quietly returned nothing for
   * the whole club rather than the batting it did have.
   */
  const latest = latestStatsYear();
  const years = [latest.pitching, latest.batting].filter((y): y is number => y !== null);
  if (years.length === 0) return result;
  const year = Math.max(...years);

  // In the order asked for, so each club's map is filled as its own call would fill it
  const known = new Map(teams.map((t) => [t.team_id, t]));
  const clubs = ids.filter((id) => known.has(id)).map((id) => known.get(id)!);
  const bases = new Map(clubs.map((c) => [c.team_id, leagueBaseline(c.league_id, year, c.level)]));
  const out = new Map(clubs.map((c) => [c.team_id, new Map<number, SeasonForm>()]));
  const clubMarks = clubs.map(() => '?').join(', ');
  const clubIds = clubs.map((c) => c.team_id);

  if (tableExists('players_career_pitching_stats')) {
    const rows = db
      .prepare(
        `SELECT p.team_id AS club, s.player_id, SUM(s.outs) AS outs, SUM(s.er) AS er, SUM(s.ha) AS ha,
                SUM(s.bb) AS bb, SUM(s.k) AS k, SUM(s.hra) AS hra, SUM(s.hp) AS hp,
                SUM(s.bf) AS bf, SUM(s.g) AS g, SUM(s.gs) AS gs, SUM(s.w) AS w,
                SUM(s.l) AS l, SUM(s.s) AS sv, SUM(s.hld) AS hld, SUM(s.war) AS war
         FROM players_career_pitching_stats s
         JOIN players p ON p.player_id = s.player_id
         JOIN teams t ON t.team_id = p.team_id
         WHERE s.year = ? AND s.split_id = 1 AND s.level_id = t.level AND p.team_id IN (${clubMarks})
         GROUP BY s.player_id
         ORDER BY s.player_id`
      )
      .all(year, ...clubIds) as Array<Record<string, number>>;
    for (const row of rows) {
      const teamId = row.club;
      const stats = computePitching(row, bases.get(teamId)!, teamId);
      const meaningful = (row.outs ?? 0) >= MEANINGFUL_OUTS;
      const index = stats.eraPlus ?? null;
      const innings = Math.round(((row.outs ?? 0) / 3) * 10) / 10;
      // A scoreless spell has no ERA+ to report — the division has no bottom.
      // Better to leave it out than to print a dash in the middle of a line
      // somebody is going to read aloud.
      const era = stats.era !== null && stats.era !== undefined ? stats.era.toFixed(2) : null;
      out.get(teamId)!.set(row.player_id, {
        index,
        meaningful,
        line: [
          `${stats.ip ?? 0} IP`,
          era !== null ? `${era} ERA` : null,
          index !== null ? `${index} ERA+` : null,
        ].filter(Boolean).join(', '),
        verdict: verdictOf(index, meaningful),
        sample: innings,
        unit: 'IP',
      });
    }
  }

  if (tableExists('players_career_batting_stats')) {
    const rows = db
      .prepare(
        `SELECT p.team_id AS club, s.player_id, SUM(s.pa) AS pa, SUM(s.ab) AS ab, SUM(s.h) AS h, SUM(s.d) AS d,
                SUM(s.t) AS t3, SUM(s.hr) AS hr, SUM(s.bb) AS bb, SUM(s.ibb) AS ibb,
                SUM(s.hp) AS hp, SUM(s.sf) AS sf, SUM(s.k) AS k, SUM(s.r) AS r,
                SUM(s.rbi) AS rbi, SUM(s.sb) AS sb, SUM(s.cs) AS cs, SUM(s.war) AS war
         FROM players_career_batting_stats s
         JOIN players p ON p.player_id = s.player_id
         JOIN teams t ON t.team_id = p.team_id
         WHERE s.year = ? AND s.split_id = 1 AND s.level_id = t.level AND p.team_id IN (${clubMarks})
           AND p.position <> 1
         GROUP BY s.player_id
         ORDER BY s.player_id`
      )
      .all(year, ...clubIds) as Array<Record<string, number>>;
    for (const row of rows) {
      const teamId = row.club;
      const stats = computeBatting(row, bases.get(teamId)!, teamId);
      const meaningful = (row.pa ?? 0) >= MEANINGFUL_PA;
      const index = stats.wrcPlus ?? null;
      out.get(teamId)!.set(row.player_id, {
        index,
        meaningful,
        line: [
          `${row.pa ?? 0} PA`,
          slash(stats.avg, stats.obp, stats.slg),
          index !== null ? `${index} wRC+` : null,
        ].filter(Boolean).join(', '),
        verdict: verdictOf(index, meaningful),
        sample: row.pa ?? 0,
        unit: 'PA',
      });
    }
  }

  for (const [teamId, forms] of out) result.set(teamId, forms);
  return result;
}
