import { Router, type Request } from 'express';
import { db, DATE_KEY, tableColumns, tableExists } from './db.js';
import { SERVICE_DAYS_PER_YEAR } from './contracts.js';
import { LEVEL_NAMES, rosterHoles, scaleGrade, seasonYear } from './valuation.js';

export const rosterOpsRoutes = Router();

const POSITION_NAMES: Record<number, string> = {
  1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF', 10: 'DH',
};
const teamLabel = `CASE WHEN t.name = t.nickname THEN t.name ELSE t.name || ' ' || t.nickname END`;

// ── Roster crunch (40-man / options / Rule 5 / DFA) ─────────────────────

/** Options a man is given. Use all three and he can no longer be sent down for free. */
const OPTIONS_ALLOWED = 3;

/**
 * Past this much major-league service a man cannot be sent down against his
 * will, so having no options left costs the club nothing with him. Under it,
 * it is exactly what forces a designation when the roster is full.
 */
const OPTION_FREE_SERVICE_YEARS = 5;

export interface CrunchPlayer {
  player_id: number;
  name: string;
  age: number;
  positionName: string;
  levelName: string;
  on26: boolean;
  on40: boolean;
  /** On the 60-day injured list: listed with the 40-man, but takes no place on it. */
  il60: boolean;
  /** Said beside him on the 40-man list when there is something to say. */
  note: string | null;
  optionsUsed: number;
  rule5Protected: number;
  issues: string[];
}

export interface RosterCrunch {
  counts: {
    active: number;
    /** Men who hold a place on the 40-man. The 60-day injured list does not. */
    fortyMan: number;
    /** On the 40-man list but not counted in `fortyMan`. */
    il60: number;
    /** Exactly the length of `issues`, which is what "Needs attention" shows. */
    issues: number;
  };
  issues: CrunchPlayer[];
  fortyMan: CrunchPlayer[];
}

/**
 * Everything the Roster Crunch page shows, worked out in one place.
 *
 * The dashboard's "Roster issues" chip used to run a query of its own that
 * counted a designation or a waiver claim and nothing else, while the page it
 * opens listed options and Rule 5 as well: the chip said 0 and the page said 6.
 * Both read this function now, so the chip is the length of the list it opens
 * and cannot drift from it.
 *
 * Null where the export has no roster-status table at all.
 */
export function rosterCrunch(orgId: number): RosterCrunch | null {
  if (!tableExists('players_roster_status')) return null;

  /*
   * Whichever of these columns this export carries. The dashboard depends on
   * this function now, and a save that lacks one of them should lose that one
   * flag, not the whole morning report.
   */
  const have = new Set(tableColumns('players_roster_status'));
  const status = [
    'is_active', 'is_on_secondary', 'is_on_dl', 'is_on_dl60', 'options_used',
    'years_protected_from_rule_5', 'pro_service_years', 'mlb_service_years', 'mlb_service_days',
    'designated_for_assignment', 'days_on_dfa_left', 'is_on_waivers', 'days_on_waivers_left',
  ].map((c) => (have.has(c) ? `rs.${c}` : `NULL AS ${c}`));

  const rows = db
    .prepare(
      `SELECT p.player_id, p.first_name || ' ' || p.last_name AS name, p.age, p.position,
              t.level, ${status.join(', ')}
       FROM players p
       JOIN players_roster_status rs ON rs.player_id = p.player_id
       JOIN teams t ON t.team_id = p.team_id
       WHERE p.organization_id = ? AND p.retired = 0`
    )
    .all(orgId) as Array<Record<string, number | string | null>>;

  const players: CrunchPlayer[] = rows.map((r) => {
    const on26 = r.is_active === 1;
    /*
     * A man on the 60-day list holds no place on the 40-man: the club may fill
     * his spot the day he goes down, which is what the list is for. Counting
     * him put eight of the thirty-two clubs in one save over the limit
     * (Baltimore at 42 of 40) when OOTP lets none of them go past it. He stays
     * on the list, marked, because he comes back to a roster that has to find
     * him a place.
     */
    const il60 = r.is_on_dl60 === 1;
    // Secondary roster = the 40-man; MLB-level IL players are on it as well
    const on40 =
      on26 || r.is_on_secondary === 1 ||
      ((r.is_on_dl === 1 || il60) && r.level === 1);
    const optionsUsed = (r.options_used as number) ?? 0;
    const usedAllOptions = optionsUsed >= OPTIONS_ALLOWED;
    // Days are exact; mlb_service_years is truncated to a whole year
    const service =
      typeof r.mlb_service_days === 'number'
        ? r.mlb_service_days / SERVICE_DAYS_PER_YEAR
        : (r.mlb_service_years as number | null) ?? 0;
    /*
     * A man on the 26 with every option used.
     *
     * This was only ever raised for men already in the minors (`!on26`), which
     * is backwards: the one it matters for is on the big club, because he
     * cannot be sent down without clearing waivers and so is the man a full
     * roster forces out. In one save 255 active players had all three options
     * used and not one carried a flag; on the Dodgers that was Phillips, Snell,
     * Okert and Anderson.
     *
     * Under five years of service only. Past that a man can refuse the
     * assignment, so of those four only Anderson, at 3.78 years, is a real
     * constraint. It is a heads-up and not a violation: it changes neither the
     * active nor the 40-man count.
     */
    const activeOutOfOptions = on26 && usedAllOptions && service < OPTION_FREE_SERVICE_YEARS;
    const outOfOptions = on40 && !on26 && usedAllOptions;
    const rule5Protected = (r.years_protected_from_rule_5 as number) ?? 0;
    const rule5Exposed = !on40 && rule5Protected <= 0 && ((r.pro_service_years as number) ?? 0) >= 4;
    const issues: string[] = [];
    if (r.designated_for_assignment === 1) issues.push(`DFA — ${r.days_on_dfa_left ?? '?'} days to resolve`);
    if (r.is_on_waivers === 1) issues.push(`on waivers — ${r.days_on_waivers_left ?? '?'} days left`);
    if (activeOutOfOptions) issues.push('Out of options: cannot be sent down without clearing waivers');
    else if (outOfOptions) issues.push('out of options');
    else if (on40 && !on26 && optionsUsed === 2) issues.push('last option year');
    if (rule5Exposed) issues.push('Rule 5 exposed');
    return {
      player_id: r.player_id as number,
      name: r.name as string,
      age: r.age as number,
      positionName: POSITION_NAMES[r.position as number] ?? '?',
      levelName: LEVEL_NAMES[r.level as number] ?? 'R',
      on26,
      on40,
      il60: on40 && il60,
      note: on40 && il60 ? 'IL-60, does not count' : null,
      optionsUsed,
      rule5Protected,
      issues,
    };
  });

  const listed = players.filter((p) => p.on40);
  const counted = listed.filter((p) => !p.il60);
  const withIssues = players.filter((p) => p.issues.length > 0);
  withIssues.sort((a, b) => b.issues.length - a.issues.length);
  // The men who count first, active ahead of the rest, then the ones who do not
  const place = (p: CrunchPlayer): number => (p.il60 ? 2 : p.on26 ? 0 : 1);

  return {
    counts: {
      active: players.filter((p) => p.on26).length,
      fortyMan: counted.length,
      il60: listed.length - counted.length,
      issues: withIssues.length,
    },
    issues: withIssues,
    fortyMan: listed.sort((a, b) => place(a) - place(b)),
  };
}

rosterOpsRoutes.get('/roster-crunch/:orgId', (req, res) => {
  const crunch = rosterCrunch(Number(req.params.orgId));
  if (!crunch) return res.status(400).json({ error: 'No roster data imported yet' });
  res.json(crunch);
});

// ── Leaderboards ────────────────────────────────────────────────────────

rosterOpsRoutes.get('/leaderboards/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  if (!tableExists('players_career_batting_stats')) return res.status(400).json({ error: 'No data imported yet' });
  const org = db.prepare(`SELECT league_id FROM teams WHERE team_id = ?`).get(orgId) as
    | { league_id: number }
    | undefined;
  if (!org) return res.status(404).json({ error: 'Unknown org' });
  const year = seasonYear(org.league_id);
  const games = ((db.prepare(`SELECT g FROM team_record WHERE team_id = ?`).get(orgId) as { g: number } | undefined)?.g ?? 20);
  const minPA = Math.round(games * 3.1);
  const minOuts = Math.round(games * 3); // 1 IP per team game

  const bat = db
    .prepare(
      `SELECT p.player_id, p.first_name || ' ' || p.last_name AS name, p.organization_id AS org,
              t.abbr AS team,
              SUM(s.pa) AS pa, SUM(s.ab) AS ab, SUM(s.h) AS h, SUM(s.d) AS d, SUM(s.t) AS t3,
              SUM(s.hr) AS hr, SUM(s.rbi) AS rbi, SUM(s.sb) AS sb, SUM(s.bb) AS bb,
              SUM(s.hp) AS hp, SUM(s.sf) AS sf, ROUND(SUM(s.war), 1) AS war
       FROM players_career_batting_stats s
       JOIN players p ON p.player_id = s.player_id
       JOIN teams t ON t.team_id = p.team_id
       WHERE s.year = ? AND s.split_id = 1 AND s.level_id = 1 AND t.league_id = ?
       GROUP BY s.player_id`
    )
    .all(year, org.league_id) as Array<Record<string, number | string>>;
  const withRates = bat.map((r): Record<string, number | string> => {
    const ab = r.ab as number;
    const h = r.h as number;
    const singles = h - (r.d as number) - (r.t3 as number) - (r.hr as number);
    const obpDen = ab + (r.bb as number) + (r.hp as number) + (r.sf as number);
    const obp = obpDen ? (h + (r.bb as number) + (r.hp as number)) / obpDen : 0;
    const slg = ab ? (singles + 2 * (r.d as number) + 3 * (r.t3 as number) + 4 * (r.hr as number)) / ab : 0;
    return { ...r, avg: ab ? h / ab : 0, ops: obp + slg };
  });
  const qualified = withRates.filter((r) => (r.pa as number) >= minPA);
  const top = (
    rows: Array<Record<string, number | string>>,
    key: string,
    dir: 1 | -1 = -1,
    format: (v: number) => string | number = (v) => v
  ) =>
    [...rows]
      .sort((a, b) => dir * ((a[key] as number) - (b[key] as number)))
      .slice(0, 10)
      .map((r) => ({
        player_id: r.player_id, name: r.name, team: r.team,
        value: format(r[key] as number), isOrg: r.org === orgId,
      }));

  const pitch = db
    .prepare(
      `SELECT p.player_id, p.first_name || ' ' || p.last_name AS name, p.organization_id AS org,
              t.abbr AS team,
              SUM(s.outs) AS outs, SUM(s.er) AS er, SUM(s.k) AS k, SUM(s.bb) AS bb,
              SUM(s.ha) AS ha, SUM(s.w) AS w, SUM(s.s) AS sv, ROUND(SUM(s.war), 1) AS war
       FROM players_career_pitching_stats s
       JOIN players p ON p.player_id = s.player_id
       JOIN teams t ON t.team_id = p.team_id
       WHERE s.year = ? AND s.split_id = 1 AND s.level_id = 1 AND t.league_id = ?
       GROUP BY s.player_id`
    )
    .all(year, org.league_id) as Array<Record<string, number | string>>;
  const withPitchRates = pitch.map((r): Record<string, number | string> => {
    const ip = (r.outs as number) / 3;
    return {
      ...r,
      ip,
      era: ip ? ((r.er as number) / ip) * 9 : 99,
      whip: ip ? ((r.bb as number) + (r.ha as number)) / ip : 99,
    };
  });
  const qualifiedP = withPitchRates.filter((r) => (r.outs as number) >= minOuts);

  const f3 = (v: number) => v.toFixed(3).replace(/^0\./, '.');
  const f2 = (v: number) => v.toFixed(2);
  res.json({
    seasonYear: year,
    minPA,
    minIP: Math.round(minOuts / 3),
    batting: {
      AVG: top(qualified, 'avg', -1, f3),
      OPS: top(qualified, 'ops', -1, f3),
      HR: top(withRates, 'hr'),
      RBI: top(withRates, 'rbi'),
      SB: top(withRates, 'sb'),
      WAR: top(withRates, 'war'),
    },
    pitching: {
      ERA: top(qualifiedP, 'era', 1, f2),
      WHIP: top(qualifiedP, 'whip', 1, f2),
      K: top(withPitchRates, 'k'),
      W: top(withPitchRates, 'w'),
      SV: top(withPitchRates, 'sv'),
      WAR: top(withPitchRates, 'war'),
    },
  });
});

// ── Staff evaluation ────────────────────────────────────────────────────

const COACH_FIELDS: Record<string, Array<[string, string]>> = {
  manager: [
    ['handle_players', 'Handle Players'], ['handle_veterans', 'Handle Veterans'],
    ['handle_rookies', 'Handle Rookies'],
  ],
  general_manager: [],
  pitching_coach: [['teach_pitching', 'Teach Pitching'], ['handle_players', 'Handle Players']],
  hitting_coach: [['teach_hitting', 'Teach Hitting'], ['handle_players', 'Handle Players']],
  bench_coach: [['teach_hitting', 'Teach Hitting'], ['teach_pitching', 'Teach Pitching']],
  head_scout: [
    ['scout_major', 'Scout Majors'], ['scout_minor', 'Scout Minors'],
    ['scout_amateur', 'Scout Amateurs'], ['scout_international', 'Scout Intl'],
  ],
  doctor: [
    ['heal_arms', 'Heal Arms'], ['heal_legs', 'Heal Legs'], ['heal_back', 'Heal Back'],
    ['prevent_arms', 'Prevent Arm Inj.'], ['prevent_legs', 'Prevent Leg Inj.'],
  ],
};
const ROLE_LABELS: Record<string, string> = {
  manager: 'Manager', general_manager: 'General Manager', pitching_coach: 'Pitching Coach',
  hitting_coach: 'Hitting Coach', bench_coach: 'Bench Coach', head_scout: 'Head Scout', doctor: 'Team Doctor',
};

rosterOpsRoutes.get('/staff/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  if (!tableExists('team_roster_staff') || !tableExists('coaches')) {
    return res.status(400).json({ error: 'No staff data imported yet' });
  }
  const staffRow = db.prepare(`SELECT * FROM team_roster_staff WHERE team_id = ?`).get(orgId) as
    | Record<string, number>
    | undefined;
  if (!staffRow) return res.status(404).json({ error: 'No staff found for this org' });

  const staff = Object.keys(ROLE_LABELS)
    .map((role) => {
      const coachId = staffRow[role];
      if (!coachId) return null;
      const c = db.prepare(`SELECT * FROM coaches WHERE coach_id = ?`).get(coachId) as
        | Record<string, number | string>
        | undefined;
      if (!c) return null;
      return {
        role: ROLE_LABELS[role],
        coach_id: coachId,
        name: `${c.first_name} ${c.last_name}`,
        age: c.age,
        experience: c.experience,
        salary: c.contract_salary,
        yearsLeft: c.contract_years,
        formerPlayer: !!c.former_player_id,
        ratings: COACH_FIELDS[role].map(([field, label]) => ({ label, value: c[field] as number })),
      };
    })
    .filter(Boolean);

  /*
   * The whole farm staff, not just the managers.
   *
   * Every affiliate carries a manager, a pitching coach and a hitting coach,
   * and only one of the three was being shown. The men teaching your prospects
   * to pitch and hit are arguably the ones who matter most down there.
   */
  const affiliates = db
    .prepare(
      `SELECT t.team_id, ${teamLabel} AS team_label, t.level,
              s.manager, s.pitching_coach, s.hitting_coach
       FROM teams t JOIN team_roster_staff s ON s.team_id = t.team_id
       WHERE t.parent_team_id = ? ORDER BY t.level`
    )
    .all(orgId) as Array<{
    team_id: number; team_label: string; level: number;
    manager: number; pitching_coach: number; hitting_coach: number;
  }>;

  const records = new Map(
    (db.prepare(`SELECT team_id, w, l, pct FROM team_record`).all() as Array<{
      team_id: number; w: number; l: number; pct: number;
    }>).map((r) => [r.team_id, r])
  );

  const coachById = (id: number): Record<string, number | string> | undefined =>
    id
      ? (db.prepare(`SELECT * FROM coaches WHERE coach_id = ?`).get(id) as
          | Record<string, number | string>
          | undefined)
      : undefined;

  const FARM_SEATS: Array<[key: 'manager' | 'pitching_coach' | 'hitting_coach', label: string]> = [
    ['manager', 'Manager'],
    ['pitching_coach', 'Pitching Coach'],
    ['hitting_coach', 'Hitting Coach'],
  ];

  const farmStaff = affiliates.map((a) => {
    const rec = records.get(a.team_id);
    return {
      team: a.team_label,
      team_id: a.team_id,
      levelName: LEVEL_NAMES[a.level] ?? 'R',
      record: rec && rec.w + rec.l > 0 ? { w: rec.w, l: rec.l, pct: rec.pct } : null,
      coaches: FARM_SEATS.map(([key, label]) => {
        const c = coachById(a[key]);
        if (!c) return null;
        return {
          role: label,
          coach_id: a[key],
          name: `${c.first_name} ${c.last_name}`,
          age: c.age as number,
          experience: c.experience as number,
          ratings: [
            { label: 'Teach Hitting', value: c.teach_hitting as number },
            { label: 'Teach Pitching', value: c.teach_pitching as number },
            { label: 'Handle Rookies', value: c.handle_rookies as number },
          ],
        };
      }).filter(Boolean),
    };
  });

  /*
   * Who down there is ready for a job up here.
   *
   * OOTP rates every coach for every seat, not only the one he occupies — a
   * hitting coach carries a manager rating too — so each farm man is measured
   * against the incumbent in each major-league seat rather than only against
   * his own. That is what turns this from a list into a decision: your A-ball
   * hitting coach out-rating the man managing your major-league club is worth
   * knowing, and it is not visible anywhere else.
   *
   * The club's record is reported alongside but deliberately not scored into
   * the ranking. A coach does not choose his roster, and a good man on a bad
   * affiliate should not be buried for it.
   */
  const MLB_SEATS: Array<[valueField: string, label: string, occupation: number]> = [
    ['manager_value', 'Manager', 2],
    ['pitching_coach_value', 'Pitching Coach', 4],
    ['hitting_coach_value', 'Hitting Coach', 5],
  ];
  /** Enough of a gap to be worth raising rather than noise in the ratings. */
  const PROMOTION_MARGIN = 10;

  const promotionCandidates = MLB_SEATS.flatMap(([field, label, occupation]) => {
    const incumbent = db
      .prepare(
        `SELECT first_name || ' ' || last_name AS name, "${field}" AS value
         FROM coaches WHERE team_id = ? AND occupation = ? LIMIT 1`
      )
      .get(orgId, occupation) as { name: string; value: number } | undefined;
    if (!incumbent) return [];

    return farmStaff
      .flatMap((club) =>
        (club.coaches as Array<Record<string, unknown>>).map((c) => {
          const full = coachById(c.coach_id as number);
          const value = Number(full?.[field] ?? 0);
          return {
            seat: label,
            incumbent: incumbent.name,
            incumbentValue: incumbent.value,
            coach_id: c.coach_id as number,
            name: c.name as string,
            currentRole: c.role as string,
            team: club.team,
            levelName: club.levelName,
            record: club.record,
            age: c.age as number,
            value,
            gap: value - incumbent.value,
          };
        })
      )
      .filter((c) => c.gap >= PROMOTION_MARGIN);
  }).sort((a, b) => b.gap - a.gap);

  res.json({ staff, farmStaff, promotionCandidates });
});

// ── Draft prep ──────────────────────────────────────────────────────────

/**
 * OOTP writes dates unpadded — "2026-4-12" — which sorts wrong as text. Padding
 * them makes plain string comparison a valid date comparison.
 */
export function padDate(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  // SQLite hands back whatever type the column holds, and a date OOTP left
  // blank arrives as a number. Anything unparseable becomes null rather than
  // throwing — a missing draft date should hide a line, not break the page.
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(raw).trim());
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
}

interface DraftLeague {
  league_id: number;
  leagueName: string;
  /** The league runs an amateur draft at all. Reserve-era and custom leagues may not. */
  hasDraft: boolean;
  /**
   * OOTP's own switch for whether the draft pool screen is visible. Gating on
   * this means the app shows a prospect exactly when the game does — before the
   * class is published these players exist in the export but appear on no screen
   * in OOTP, so listing them here invented a scouting report out of thin air.
   */
  poolVisible: boolean;
  gameDate: string | null;
  draftDate: string | null;
  poolDate: string | null;
  combineDate: string | null;
  rounds: number;
}

/**
 * The amateur draft belongs to the top-level league, so an affiliate org has to
 * walk up to its parent before any of these settings mean anything.
 */
function draftLeague(orgId: number): DraftLeague | null {
  const team = db.prepare(`SELECT league_id FROM teams WHERE team_id = ?`).get(orgId) as
    | { league_id: number }
    | undefined;
  if (!team) return null;

  type Row = {
    league_id: number; name: string; parent_league_id: number | null;
    rules_amateur_draft: number | null; show_draft_pool: number | null;
    draft_date: string | null; rules_amateur_draft_rounds: number | null; today: string | null;
  };
  const fetch = (id: number): Row | undefined =>
    db
      .prepare(
        `SELECT league_id, name, parent_league_id, rules_amateur_draft, show_draft_pool,
                draft_date, rules_amateur_draft_rounds, "current_date" AS today
         FROM leagues WHERE league_id = ?`
      )
      .get(id) as Row | undefined;

  let row = fetch(team.league_id);
  // Affiliates carry rules_amateur_draft = 0; the parent MLB league owns the draft
  const seen = new Set<number>();
  while (row && row.rules_amateur_draft !== 1 && row.parent_league_id && !seen.has(row.league_id)) {
    seen.add(row.league_id);
    row = fetch(row.parent_league_id);
  }
  if (!row) return null;

  // The pool announcement and combine are calendar events rather than columns
  const eventDate = (type: number): string | null => {
    if (!tableExists('league_events')) return null;
    const e = db
      .prepare(
        // The earliest event of its kind, by date rather than by spelling. As
        // text "2006-10-1" sorts before "2006-6-9", so the draft day the board
        // counts down to could be the wrong one entirely
        `SELECT start_date FROM league_events
         WHERE league_id = ? AND type = ? AND deleted = 0
         ORDER BY ${DATE_KEY('start_date')} LIMIT 1`
      )
      .get(row!.league_id, type) as { start_date: string } | undefined;
    return padDate(e?.start_date);
  };

  return {
    league_id: row.league_id,
    leagueName: row.name,
    hasDraft: row.rules_amateur_draft === 1,
    poolVisible: row.rules_amateur_draft === 1 && row.show_draft_pool === 1,
    gameDate: padDate(row.today),
    draftDate: padDate(row.draft_date),
    poolDate: eventDate(3),
    combineDate: eventDate(43),
    rounds: row.rules_amateur_draft_rounds ?? 0,
  };
}

/**
 * The youngest a man can be and still be taken in the draft.
 *
 * The export does not say. Its `leagues` table has no draft-age setting (the
 * draft columns are the switch, the pool flag, the date and the round count)
 * and nothing else in the save carries one, so this is an assumption and not a
 * read. It is 17 because that save's own drafts say so: 2026 and 2027 took 39
 * seventeen-year-olds, counting age on draft day, and nobody younger. A first
 * guess of 18 would have told the 51 high-school seniors who are 17 on draft
 * day that they are a year away. A league that runs the draft differently would
 * need this to come from its own settings, and this is the one place to do it.
 *
 * OOTP's own flag does not help here. In that save it put 81 fourteen-year-olds
 * and 340 fifteen-year-olds in the pool, high-school freshmen and sophomores
 * with years of school left, and the board ranked them beside the seniors.
 */
export const MIN_DRAFT_AGE = 17;

/**
 * Years until he is old enough to be taken: 0 once he is, never negative.
 *
 * Years rather than a yes or no, so a man who is next year's class reads
 * differently from one who is three years away. An age the export left blank is
 * not a reason to hide anybody for seventeen years, so it counts as eligible.
 * The age it works from is his age on the export's date, not on draft day.
 */
export function yearsToEligibility(age: number, minAge = MIN_DRAFT_AGE): number {
  return age > 0 ? Math.max(0, minAge - age) : 0;
}

interface Prospect {
  age: number;
  positionName: string;
  school: string;
  isPitcher: boolean;
  cur: number | null;
  pot: number | null;
  upside: number | null;
}

/**
 * A read on a draft prospect, in the same shape the Contracts page uses.
 *
 * Everything here comes from scouted ratings, which for amateurs your staff has
 * barely seen are the noisiest numbers in the game — so the labels describe the
 * KIND of bet a player is rather than pretending to rank them precisely. The
 * roster-need flag is deliberately the weakest signal: a draft pick is years
 * from the majors, and today's thin position rarely predicts the one you will
 * actually be short of when he arrives.
 */
function advise(p: Prospect, thin: Set<string>): { label: string; reasons: string[] } | null {
  const pot = p.pot ?? 0;
  const cur = p.cur ?? 0;
  const upside = p.upside ?? 0;
  /*
   * Every cut-off here is a 20-80 grade, put through scaleGrade so it means the
   * same on the scale the save is set to. Written as bare numbers they were
   * wrong anywhere else: on the 1-to-5 scale no ceiling ever reached 45, so
   * the board gave every prospect no read at all, and a gap of 15 could not
   * occur, so nobody was ever a long wait.
   */
  if (pot < scaleGrade(45)) return null;

  const reasons: string[] = [];
  let label: string;

  if (pot >= scaleGrade(55) && upside >= scaleGrade(15)) {
    label = 'High ceiling, long wait';
    reasons.push(
      `${pot} ceiling, but ${upside} ${upside === 1 ? 'point' : 'points'} of it is still projection`
    );
  } else if (upside <= scaleGrade(8) && cur >= scaleGrade(45)) {
    label = 'Close to ready';
    reasons.push(`already at ${cur} of a ${pot} ceiling — least development left`);
  } else if (pot >= scaleGrade(52)) {
    label = 'Everyday-regular ceiling';
    reasons.push(`${pot} ceiling`);
  } else {
    label = 'Depth piece';
    reasons.push(`${pot} ceiling — organizational depth rather than a future regular`);
  }

  // Age is read against the class, not the calendar: the draft pool runs 16-25,
  // so the same ceiling at 18 is a much better bet than at 22
  if (p.age <= 18) reasons.push(`only ${p.age} — years of development still ahead`);
  else if (p.age >= 23) reasons.push(`already ${p.age}, old for the class`);

  if (p.school === 'HS') reasons.push('high schooler — further away, more variance');
  if (thin.has(p.positionName)) reasons.push(`${p.positionName} is among your thinnest spots today`);

  return { label, reasons };
}

/**
 * How many of the class the board itself carries.
 *
 * The class in the save this was written against is two thousand seven hundred
 * and forty-four men, and the board used to send every one of them with his
 * scouting read attached: an 860 KB answer, drawn from in the browser a hundred
 * rows at a time, to show a page that opens on the first five. The board is the
 * top of the list; the rest is the pool, and is asked for by the page.
 */
const BOARD_SIZE = 100;

/** The most a page of the pool may carry, whatever the caller asks for. */
const POOL_PAGE_MAX = 300;

/** Position groups, so "infield" does not mean typing four filters. */
const DRAFT_GROUPS: Record<string, string[]> = {
  C: ['C'],
  IF: ['1B', '2B', '3B', 'SS'],
  OF: ['LF', 'CF', 'RF'],
  P: ['P'],
};

interface ClassProspect extends Prospect {
  player_id: number;
  name: string;
  /** Years until he reaches the draft age, 0 once he has. */
  yearsToEligibility: number;
  bats: string;
  throws: string;
  speed: number | null;
}

/** A man with his place in the whole class, which a re-sorted table still reports. */
type RankedProspect = ClassProspect & { boardRank: number };

/**
 * The whole class, read in one pass and ranked best ceiling first.
 *
 * Everything the board and the pool both need, so that neither has to know how
 * a save marks its draft class — which is not the same in every save.
 *
 * A league whose amateurs are free-floating players — the ordinary case —
 * has them flagged draft_eligible, and that is what to read. A league that
 * runs its own high-school and college competitions does not: its amateurs
 * are rostered players on school clubs, OOTP works eligibility out from
 * their class when the draft comes round, and the flag stays at zero.
 *
 * A reader's export settled it. His pool players carried draft_eligible = 0
 * with hsc_status 4 and his own league in draft_league_id, while the 123 the
 * flag did pick out belonged, every one, to a second league's draft. So the
 * flag is used where it says something and the school class where it does
 * not — 4 is a high-school senior, 9 and 10 the college upperclassmen.
 *
 * The class rule reproduced his published pool exactly: 298 men in those
 * classes, two of them with a career-ending injury, and OOTP's own screen
 * said 296.
 *
 * One read of the players table does the work of three. It used to be asked
 * how many men the flag found, then for the men themselves, then how many it
 * had left out and why, and the table is a hundred and thirty-five thousand
 * rows long, so each of those took about a tenth of a second. The men either
 * rule could want now come back together, with the columns that tell the rules
 * apart, and are sorted out here.
 */
function readClass(league: DraftLeague): {
  ranked: RankedProspect[];
  poolRule: 'flag' | 'class';
  excluded: { alreadyPicked: number; otherDraft: number; unrated: number };
} {
  // A save that predates these two columns loses the class rule, not the board
  const have = new Set(tableColumns('players'));
  const bySchool = have.has('hsc_status');
  const rows = db
    .prepare(
      `SELECT p.player_id, p.first_name || ' ' || p.last_name AS name, p.age, p.position, p.role,
              p.bats, p.throws, p.college,
              p.draft_eligible AS flagged, COALESCE(p.picked_in_draft, 0) AS picked,
              COALESCE(p.draft_league_id, 0) AS dleague,
              ${bySchool ? 'p.hsc_status' : 'NULL'} AS hsc,
              ${have.has('injury_career_ending') ? 'COALESCE(p.injury_career_ending, 0)' : '0'} AS ended,
              b.batting_ratings_overall_contact AS con, b.batting_ratings_overall_gap AS gap,
              b.batting_ratings_overall_power AS pow, b.batting_ratings_overall_eye AS eye,
              b.batting_ratings_overall_strikeouts AS avk, b.running_ratings_speed AS spd,
              b.batting_ratings_talent_contact AS conP, b.batting_ratings_talent_gap AS gapP,
              b.batting_ratings_talent_power AS powP, b.batting_ratings_talent_eye AS eyeP,
              b.batting_ratings_talent_strikeouts AS avkP,
              pi.pitching_ratings_overall_stuff AS stu, pi.pitching_ratings_overall_movement AS mov,
              pi.pitching_ratings_overall_control AS ctl,
              pi.pitching_ratings_talent_stuff AS stuP, pi.pitching_ratings_talent_movement AS movP,
              pi.pitching_ratings_talent_control AS ctlP
       FROM players p
       LEFT JOIN players_batting b ON b.player_id = p.player_id
       LEFT JOIN players_pitching pi ON pi.player_id = p.player_id
       WHERE p.retired = 0 AND p.hidden = 0
         AND (p.draft_eligible = 1${
           bySchool ? ' OR (COALESCE(p.draft_league_id, 0) = ? AND p.hsc_status IN (4, 9, 10))' : ''
         })`
    )
    .all(...(bySchool ? [league.league_id] : [])) as Array<Record<string, number | string | null>>;

  /*
   * Still on the board, and for THIS league's draft, by whichever rule this
   * save answers to. The eligibility flag also stays set after a man has been
   * taken — 185 players in one save carried both it and picked_in_draft, every
   * one stamped with this year as his draft year — so the board went on
   * offering men who were already gone.
   */
  const flagged = rows.filter((r) => r.flagged === 1);
  const notTaken = (r: Record<string, number | string | null>) => r.picked !== 1;
  const inThisDraft = (r: Record<string, number | string | null>) =>
    r.dleague === 0 || r.dleague === league.league_id;
  const byFlag = flagged.filter((r) => notTaken(r) && inThisDraft(r));
  const poolRule = byFlag.length > 0 ? 'flag' : 'class';
  const pool =
    poolRule === 'flag'
      ? byFlag
      : rows.filter(
          (r) =>
            r.dleague === league.league_id && [4, 9, 10].includes(r.hsc as number) &&
            r.ended !== 1 && notTaken(r)
        );

  const avg = (vals: Array<number | string | null>): number | null => {
    const nums = vals.filter((v): v is number => typeof v === 'number' && v > 0);
    return nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
  };
  const HANDS: Record<number, string> = { 1: 'R', 2: 'L', 3: 'S' };
  const prospects: ClassProspect[] = pool.map((r) => {
    const isPitcher = r.position === 1;
    const cur = isPitcher ? avg([r.stu, r.mov, r.ctl]) : avg([r.con, r.gap, r.pow, r.eye, r.avk]);
    const pot = isPitcher
      ? avg([r.stuP, r.movP, r.ctlP])
      : avg([r.conP, r.gapP, r.powP, r.eyeP, r.avkP]);
    return {
      player_id: Number(r.player_id),
      name: String(r.name),
      age: Number(r.age ?? 0),
      // Shown beside his age, and deliberately not part of the ranking below
      yearsToEligibility: yearsToEligibility(Number(r.age ?? 0)),
      positionName: POSITION_NAMES[r.position as number] ?? '?',
      bats: HANDS[r.bats as number] ?? '?',
      throws: HANDS[r.throws as number] ?? '?',
      // hsc_status is a fine-grained class code (4 = high school, 8-10 =
      // college years) that the export ships no lookup table for. The college
      // flag is the part that survives translation.
      school: r.college === 1 ? 'College' : 'HS',
      isPitcher,
      cur,
      pot,
      // How much of the ceiling is still projection rather than present
      // ability. A big gap is upside; it is also risk.
      upside: cur !== null && pot !== null ? pot - cur : null,
      speed: r.spd as number | null,
    };
  });
  const ranked = prospects
    .filter((p) => p.pot !== null)
    /*
     * Ceiling, then present ability, then his id. The last is only there so
     * that the order is total: pages of the pool are cut from this list on
     * separate requests, and two men who tie on both ratings would otherwise be
     * free to change places between one page and the next.
     */
    .sort((a, b) => (b.pot ?? 0) - (a.pot ?? 0) || (b.cur ?? 0) - (a.cur ?? 0) || a.player_id - b.player_id)
    // Board rank within the whole class, kept through re-sorting so a re-sorted
    // table can still say where a player stood on ceiling
    .map((p, i) => ({ ...p, boardRank: i + 1 }));

  return {
    ranked,
    poolRule,
    /*
     * What was left out, and why.
     *
     * A reader reported a board with the wrong 123 men on it and had no way to
     * tell whether the app had never seen his draft class or had seen it and
     * ruled it out. These counts answer that from the page itself. They are
     * shown only when they are not zero, so a save where none of this applies
     * reads exactly as before.
     */
    excluded: {
      alreadyPicked: flagged.filter((r) => !notTaken(r)).length,
      /*
       * Only meaningful while the flag is what the board reads. Once it has
       * fallen back to the school class, the men the flag picked out belong to
       * another league's draft by definition, and saying so on this page would
       * be reporting a fact about somebody else's club.
       */
      otherDraft:
        poolRule === 'flag' ? flagged.filter((r) => notTaken(r) && !inThisDraft(r)).length : 0,
      // Eligible, unpicked, in this draft, but carrying no scouted ceiling —
      // there is nothing to rank him on
      unrated: pool.length - ranked.length,
    },
  };
}

/** What a page of the pool is asked for: who, in what order. Paging is read separately. */
interface PoolQuery {
  q: string;
  group: string | null;
  school: 'HS' | 'College' | null;
  maxAge: number | null;
  minPot: number | null;
  sort: string;
  dir: 'asc' | 'desc';
}

/** What each column of the table orders by. A key outside this list is not a column. */
const POOL_SORTS: Record<string, (p: RankedProspect) => number | string> = {
  name: (p) => p.name,
  age: (p) => p.age,
  pos: (p) => p.positionName,
  school: (p) => p.school,
  cur: (p) => p.cur ?? 0,
  upside: (p) => p.upside ?? 0,
  boardRank: (p) => p.boardRank,
  pot: (p) => p.pot ?? 0,
};

function readPoolQuery(query: Request['query']): PoolQuery {
  const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const number = (v: unknown): number | null => {
    const s = text(v);
    return s !== '' && Number.isFinite(Number(s)) ? Number(s) : null;
  };
  const sort = Object.hasOwn(POOL_SORTS, text(query.sort)) ? text(query.sort) : 'pot';
  // Ratings read best high-first; name, age and rank read best low-first
  const natural = sort === 'name' || sort === 'age' || sort === 'boardRank' ? 'asc' : 'desc';
  const dir = text(query.dir);
  return {
    q: text(query.q),
    group: Object.hasOwn(DRAFT_GROUPS, text(query.group)) ? text(query.group) : null,
    school: text(query.school) === 'HS' || text(query.school) === 'College'
      ? (text(query.school) as 'HS' | 'College')
      : null,
    maxAge: number(query.maxAge),
    minPot: number(query.minPot),
    sort,
    dir: dir === 'asc' || dir === 'desc' ? dir : natural,
  };
}

/**
 * The men a query leaves, in the order it asks for.
 *
 * What the page did to the class in the browser, now done where the class
 * is. Sorting what had been loaded would have ordered a page and not the
 * class — the best arm in the draft could sit on a page nobody had asked
 * for — so the whole pool is filtered and ordered here and only then cut.
 * A tie keeps his place on the board, as it always has.
 */
function searchPool(ranked: RankedProspect[], q: PoolQuery): RankedProspect[] {
  const needle = q.q.toLowerCase();
  const wanted = q.group ? DRAFT_GROUPS[q.group] : null;
  const found = ranked.filter((p) => {
    if (needle && !p.name.toLowerCase().includes(needle)) return false;
    if (wanted && !wanted.includes(p.positionName)) return false;
    if (q.school && p.school !== q.school) return false;
    if (q.maxAge !== null && p.age > q.maxAge) return false;
    if (q.minPot !== null && (p.pot ?? 0) < q.minPot) return false;
    return true;
  });
  const key = POOL_SORTS[q.sort];
  const sign = q.dir === 'asc' ? 1 : -1;
  return found.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (typeof x === 'string' || typeof y === 'string') return sign * String(x).localeCompare(String(y));
    return sign * (x - y);
  });
}

/** A whole number from the URL, or the fallback: the page size and place are the caller's to ask for. */
function wholeNumber(v: unknown, fallback: number): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Math.floor(Number(v)) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The draft class: a ranked board by default, and the pool behind it on request.
 *
 * Without parameters this is the board — the best hundred, the shortlist, and
 * counts that describe the whole class — and it is small enough to paint at
 * once. `?pool=1` is the class itself, a page at a time: `limit` men from
 * `offset`, narrowed by `q` (a name), `group`, `school`, `maxAge` and `minPot`
 * and ordered by `sort` and `dir`, with `matched` for how many the narrowing
 * left and `total` for how many there are. The page asks for it only when its
 * reader goes beyond the board.
 */
rosterOpsRoutes.get('/draft/:orgId', (req, res) => {
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });

  const league = draftLeague(Number(req.params.orgId));
  if (!league) return res.status(404).json({ error: 'Unknown team' });

  const asPool = req.query.pool === '1';
  const limit = Math.min(Math.max(wholeNumber(req.query.limit, 100), 0), POOL_PAGE_MAX);
  const offset = Math.max(wholeNumber(req.query.offset, 0), 0);

  /*
   * Nothing is read from the players table until OOTP itself publishes the
   * class — but the shape of the answer does not change with it.
   *
   * This used to hand back `batters` and `pitchers`, names the page stopped
   * using a long time ago, and no `prospects` or `needs` at all. The board
   * filters and sorts the class as it renders, before it gets as far as the
   * line that would have said the class is not published, so it read `filter`
   * off nothing and threw — and with no boundary above it, the throw took the
   * whole window down: blank screen, no navigation, no way back. Between
   * drafts, which is most of the year, that was every visit to the page.
   */
  if (!league.poolVisible) {
    return res.json(
      asPool
        ? { ...league, total: 0, matched: 0, offset, limit, prospects: [] }
        : { ...league, total: 0, prospects: [], fits: [], needs: [] }
    );
  }

  const { ranked, poolRule, excluded } = readClass(league);
  const needs = rosterHoles(Number(req.params.orgId));
  const thin = new Set(needs.slice(0, 3).map((h): string => h.positionName));
  // The read is worked out for the men who are sent, not for the whole class
  const withAdvice = (p: RankedProspect) => ({ ...p, recommendation: advise(p, thin) });

  if (asPool) {
    const query = readPoolQuery(req.query);
    const found = searchPool(ranked, query);
    return res.json({
      ...league,
      total: ranked.length,
      matched: found.length,
      offset,
      limit,
      sort: query.sort,
      dir: query.dir,
      prospects: found.slice(offset, offset + limit).map(withAdvice),
    });
  }

  /*
   * The best at the spots the club is thinnest, read from the whole class and
   * not from the board. The second idea on the shortlist is a fit and not the
   * best available, so it can sit well below the hundredth man — and a board
   * that only looked down to a hundred would have run out of catchers.
   */
  const taken = new Set(ranked.slice(0, 5).map((p) => p.player_id));
  const fits = ranked.filter((p) => thin.has(p.positionName) && !taken.has(p.player_id)).slice(0, 3);

  // What is in the pool, said before it is fetched, so the filters can say what is behind them
  const summary = {
    school: { HS: 0, College: 0 },
    positions: { C: 0, IF: 0, OF: 0, P: 0 } as Record<string, number>,
  };
  for (const p of ranked) {
    summary.school[p.school === 'College' ? 'College' : 'HS'] += 1;
    for (const [name, spots] of Object.entries(DRAFT_GROUPS)) {
      if (spots.includes(p.positionName)) summary.positions[name] += 1;
    }
  }

  res.json({
    ...league,
    // The whole class, though `prospects` below is only its best hundred
    total: ranked.length,
    boardSize: BOARD_SIZE,
    // The age the years-to-eligibility figures count to, and how many of the
    // class are below it
    minDraftAge: MIN_DRAFT_AGE,
    tooYoung: ranked.filter((p) => p.yearsToEligibility > 0).length,
    pool: summary,
    needs,
    excluded,
    /** Which rule found this class, so the page can say when it is the class. */
    poolRule,
    fits: fits.map(withAdvice),
    prospects: ranked.slice(0, BOARD_SIZE).map(withAdvice),
  });
});
