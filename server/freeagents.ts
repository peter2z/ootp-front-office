import { Router } from 'express';
import { db, hasColumns, tableExists } from './db.js';
import { contractsByPlayer, leagueRules, mlbPercentiler, rosterHoles, teamFinances, valuesByPlayer } from './valuation.js';

export const freeAgentRoutes = Router();

const POSITION_NAMES: Record<number, string> = {
  1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF', 10: 'DH',
};

/** How many of the club's weakest spots count as holes. The page's "weakest positions" line shows the same three. */
const THIN_SPOTS = 3;

/**
 * The lowest value percentile at which a man can be said to fill a hole.
 *
 * The badge went to everybody who played a thin position: 471 players in the
 * save this was reviewed on, 470 of them below the 25th percentile of major-
 * league value, one of them (Matt Vierling) at the 1st. A spot is not patched
 * by somebody most of the league's regulars would beat.
 *
 * It is the percentile the Value column already shows, not a percentile of the
 * free-agent pool. Taken from the pool it would be no floor at all: 1,089 of
 * the 1,172 real free agents in that save sit at percentile 0, no better than
 * the weakest man on a major-league roster, so the pool's own 25th percentile
 * is zero and rules nobody out.
 */
const HOLE_FLOOR_PCT = 25;

/**
 * Whether signing him would patch one of the club's thin spots.
 *
 * Two tests. He has to clear the floor above, and he has to be at least as good
 * as the best man the club already has at the position (rosterHoles' bestValue,
 * the figure that made it a thin spot) — which is also how the Fit column is
 * defined. Playing the position is not enough: in that save not one of the real
 * free agents beat the club's best at SS, CF or 3B, and the right answer is that
 * nobody on the market fixes them.
 *
 * Where the club has nobody at the spot there is no one to beat, and the floor
 * is the whole test.
 */
function fillsHole(
  value: number | undefined,
  pct: number | null,
  hole: { bestValue: number | null } | undefined
): boolean {
  if (!hole || value === undefined || pct === null || pct < HOLE_FLOOR_PCT) return false;
  return hole.bestValue === null || value >= hole.bestValue;
}

/**
 * SQL, over a `players p` row, for a man who is still an amateur and so cannot
 * be a free agent.
 *
 * "Available now" was everybody OOTP marks as without a club, and OOTP marks
 * the whole draft class that way until it is drafted: 1,594 of the 2,766 listed
 * in the save this was reviewed on were in the 2,744-man draft pool, Chris
 * Berger (talent 100, number 12 on the Draft Board) among them, on the open
 * market and on the board at once.
 *
 * Two things mark one. The draft_eligible flag, wherever it is set: a man who
 * has already been picked, or who belongs to another league's draft, is not on
 * the market either, so this is wider than what the board lists. And the class
 * itself, read the way the board reads it. That is poolRule in the /draft route
 * of server/rosterops.ts, whose logic is copied here because it lives inside
 * the handler and cannot be imported. The flag decides where a save sets it; a
 * league that runs its own school competitions sets none, and there the school
 * year does (4 is a high-school senior, 9 and 10 the college upperclassmen).
 * If the rule changes there, change it here, or this page and the board will
 * disagree about who is a prospect. Exported so any other list of free agents
 * can leave the same men out.
 *
 * It reads columns an older export may not carry, so it asks for them: with
 * none of them there is nothing to rule out, and with only the flag the flag is
 * all there is.
 */
export function amateurRule(leagueId: number): string {
  if (!hasColumns('players', 'draft_eligible')) return '0';
  const flagged = 'COALESCE(p.draft_eligible, 0) = 1';
  if (!hasColumns('players', 'hidden', 'picked_in_draft', 'draft_league_id', 'hsc_status', 'injury_career_ending')) {
    return flagged;
  }

  const id = Number(leagueId);
  // The board's eligibleByFlag: does this save flag its class at all?
  const flaggedPool = (db
    .prepare(
      `SELECT COUNT(*) AS n FROM players
       WHERE draft_eligible = 1 AND retired = 0 AND hidden = 0
         AND COALESCE(picked_in_draft, 0) != 1
         AND COALESCE(draft_league_id, 0) IN (0, ?)`
    )
    .get(id) as { n: number }).n;
  if (flaggedPool > 0) return flagged;

  return `${flagged} OR (COALESCE(p.draft_league_id, 0) = ${id} AND p.hsc_status IN (4, 9, 10)
          AND COALESCE(p.injury_career_ending, 0) != 1)`;
}

freeAgentRoutes.get('/free-agents/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });
  const org = db.prepare(`SELECT league_id FROM teams WHERE team_id = ?`).get(orgId) as
    | { league_id: number }
    | undefined;
  if (!org) return res.status(404).json({ error: 'Unknown org' });

  const values = valuesByPlayer();
  const { overallPct, talentPct } = mlbPercentiler(values);
  const contracts = contractsByPlayer();
  const holes = rosterHoles(orgId);
  const thin = new Map(holes.slice(0, THIN_SPOTS).map((h) => [h.position, h] as const));
  const amateur = amateurRule(org.league_id);

  /*
   * What a man was last paid.
   *
   * A free agent's row in players_contract is empty — no club, no years, no
   * salary — so every one of the 2,766 read $0 here and the column said
   * nothing. What he earned is in the salary history, a row a season, with a
   * placeholder (year 0, salary 0) where there is no season on record. The
   * export carries no asking price, so the last salary is as near as it gets.
   */
  const lastPaid = hasColumns('players_salary_history', 'player_id', 'year', 'salary')
    ? db.prepare(
        `SELECT salary FROM players_salary_history
         WHERE player_id = ? AND salary > 0
         ORDER BY year DESC, salary DESC LIMIT 1`
      )
    : null;

  const decorate = (p: {
    player_id: number; first_name: string; last_name: string; age: number; position: number;
    team_label?: string;
  }) => {
    const c = contracts.get(p.player_id);
    const pct = overallPct(p.player_id);
    return {
      player_id: p.player_id,
      name: `${p.first_name} ${p.last_name}`,
      age: p.age,
      position: p.position,
      positionName: POSITION_NAMES[p.position] ?? '?',
      team: p.team_label ?? null,
      overallPct: pct,
      talentPct: talentPct(p.player_id),
      // Under contract, what he is paid now; on the market, what he was paid last
      lastSalary:
        c?.salaryNow || (lastPaid?.get(p.player_id) as { salary: number } | undefined)?.salary || null,
      fillsHole: fillsHole(values.get(p.player_id)?.overall, pct, thin.get(p.position)),
    };
  };

  // Players currently without a club in this org's league, amateurs aside
  const currentFAs = (
    db
      .prepare(
        `SELECT p.player_id, p.first_name, p.last_name, p.age, p.position FROM players p
         WHERE p.free_agent = 1 AND p.retired = 0 AND p.last_league_id = ?
           AND NOT (${amateur})`
      )
      .all(org.league_id) as Array<{
      player_id: number; first_name: string; last_name: string; age: number; position: number;
    }>
  ).map(decorate);

  /*
   * How many were left out, so a reader who sets this beside OOTP's own list can
   * tell a page that has set players aside from one that has lost them.
   */
  const amateursLeftOut = (db
    .prepare(
      `SELECT COUNT(*) AS n FROM players p
       WHERE p.free_agent = 1 AND p.retired = 0 AND p.last_league_id = ? AND (${amateur})`
    )
    .get(org.league_id) as { n: number }).n;

  // Contracts around the league that expire after this season — the offseason
  // market. Service-time filter matters: pre-arb/arb players on expiring 1-year
  // deals stay team-controlled and never reach the market.
  const rules = leagueRules(org.league_id);
  const upcoming = rules.hasFreeAgency
    ? db
      .prepare(
        `SELECT p.player_id, p.first_name, p.last_name, p.age, p.position,
                CASE WHEN t.name = t.nickname THEN t.name ELSE t.name || ' ' || t.nickname END AS team_label,
                rs.mlb_service_years AS service_years
         FROM players p
         JOIN teams t ON t.team_id = p.team_id
         LEFT JOIN players_roster_status rs ON rs.player_id = p.player_id
         WHERE t.allstar_team = 0 AND t.league_id = ?
           AND p.team_id != ? AND p.retired = 0`
      )
      .all(org.league_id, orgId) as Array<{
      player_id: number; first_name: string; last_name: string; age: number; position: number;
      team_label: string; service_years: number | null;
    }>
    : [];
  const upcomingFAs = upcoming
    .filter((p) => {
      const c = contracts.get(p.player_id);
      return (
        // A signed extension means he never reaches the market
        c && c.isMajor && c.yearsAfterThis === 0 && !c.extension &&
        !c.lastYearTeamOption && !c.lastYearPlayerOption &&
        (p.service_years ?? 0) >= rules.faMinYears - 1 // crosses the FA threshold during this season
      );
    })
    .map(decorate)
    .filter((p) => (p.overallPct ?? 0) >= 40);

  /*
   * Percentile first, then the value it was taken from. Most of the market sits
   * at percentile 0, no better than the weakest major leaguer, and ordering that
   * crowd by nothing put whoever the database returned first at the top of it.
   */
  type Row = ReturnType<typeof decorate>;
  const byValue = (a: Row, b: Row) =>
    (b.overallPct ?? -1) - (a.overallPct ?? -1) ||
    (values.get(b.player_id)?.overall ?? -1) - (values.get(a.player_id)?.overall ?? -1);
  currentFAs.sort(byValue);
  upcomingFAs.sort(byValue);

  res.json({
    finances: teamFinances(orgId),
    holes,
    currentFAs,
    upcomingFAs: upcomingFAs.slice(0, 80),
    amateursLeftOut,
    rulesNote: !rules.hasFreeAgency ? 'This league has no free agency: expiring deals renew under the reserve clause' : undefined,
  });
});
