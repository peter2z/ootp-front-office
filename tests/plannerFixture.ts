import { db } from '../server/db.js';
import { clearOrgCache } from '../server/org.js';
import { clearPlanCache } from '../server/planner.js';
import { clearStatCaches } from '../server/stats.js';
import { clearTradeCache } from '../server/trade.js';
import { clearScaleCache, clearValuationCaches } from '../server/valuation.js';

/**
 * A whole organisation for the planner to plan, laid over the shared fixture.
 *
 * The miniature league in fixture.ts has one farm club and a dozen men, which
 * is right for the pages it was built for and useless for an engine whose
 * subject is the shape of a farm: it needs a club at every rung, a league of
 * each reputation so High-A and Single-A can be told apart, two DSL clubs
 * sharing one rung, an international complex pool with no roster rows, men at
 * and over their service caps, a 40-man with options on it, three seasons of
 * lines for the production index, and an injured man or two. All of it is
 * generated from the row index rather than drawn at random, so the plan it
 * produces is the same plan every run, which is what the determinism tests
 * compare.
 *
 * Everything is in a range of its own — teams 9800-9807, leagues 9800-9806,
 * players 98000-98539, with 98540-98999 spare for a test that needs a man of
 * its own — so it cannot collide with the fixture or with another test's
 * club. `seedPlannerOrg()` writes only what is missing, so several describe
 * blocks can call it, and a test that has cleared the players table (the
 * cache-reset suite does) gets its men back without its clubs being written
 * twice.
 */

export const PLAN = {
  org: 9800,
  teams: {
    mlb: 9800, aaa: 9801, aa: 9802, highA: 9803, singleA: 9804, complex: 9805, dslA: 9806, dslB: 9807,
  },
  leagues: { mlb: 9800, aaa: 9801, aa: 9802, highA: 9803, singleA: 9804, complex: 9805, dsl: 9806 },
  /** The negative league id OOTP gives a man in the international complex. */
  icLeague: -9800,
  season: 2030,
  /** The big league's date, unpadded as OOTP writes it. */
  gameDate: '2030-6-1',
  dates: {
    openingDay: '2030-4-4', tradeDeadline: '2030-8-3', rosterExpand: '2030-9-1', rule5: '2030-12-20',
    /** The DSL opens after the game date, so no DSL man has a line this season. */
    dslStart: '2030-6-12',
  },
  /** The last regular-season game of each league, from the games table. */
  seasonEnd: {
    mlb: '2030-9-29', aaa: '2030-9-12', aa: '2030-9-17', highA: '2030-9-10', singleA: '2030-8-29',
    complex: '2030-7-5', dsl: '2030-8-18',
  },
  /** The first player id a test may use for a man of its own. */
  spareFrom: 98540,
  /** How many men the complex pool carries: the default icSize, so the room rule fires. */
  icSize: 50,
} as const;

/** OOTP's reputation per rung, which is how the ladder is read. */
const REPUTATION = { mlb: 10, aaa: 9, aa: 8, highA: 7, singleA: 6, complex: 5, dsl: 4 } as const;
/** OOTP's AVG equivalency per league, which translates production between rungs. */
export const MLE = { mlb: 1, aaa: 0.85, aa: 0.8, highA: 0.77, singleA: 0.75, complex: 0.6, dsl: 0.55 } as const;

export type ClubKey = keyof typeof PLAN.teams;

/** Where each club sits: its league, OOTP level, and the median man it is built around. */
export const CLUBS: Record<ClubKey, {
  league: number; level: number; name: string; nickname: string; abbr: string;
  /** The first player id of the club's block of sixty. */
  from: number;
  /** The grade and age the club's men are generated around. */
  oa: number; age: number;
  /** Heads per group: catchers, infielders, outfielders, starters, relievers. */
  shape: { C: number; IF: number; OF: number; SP: number; RP: number };
}> = {
  mlb: { league: 9800, level: 1, name: 'Planner', nickname: 'Nine', abbr: 'PLN', from: 98000, oa: 50, age: 29, shape: { C: 2, IF: 6, OF: 5, SP: 5, RP: 8 } },
  aaa: { league: 9801, level: 2, name: 'Planner', nickname: 'Triples', abbr: 'PLA', from: 98060, oa: 42, age: 25, shape: { C: 3, IF: 8, OF: 6, SP: 6, RP: 9 } },
  // Thirty-eight against a soft maximum of thirty-five, with three surplus men
  // among them (see surplusMen below): the balance test's own case
  aa: { league: 9802, level: 3, name: 'Planner', nickname: 'Doubles', abbr: 'PLD', from: 98120, oa: 38, age: 24, shape: { C: 4, IF: 10, OF: 8, SP: 6, RP: 10 } },
  highA: { league: 9803, level: 4, name: 'Planner', nickname: 'Highs', abbr: 'PLH', from: 98180, oa: 34, age: 23, shape: { C: 3, IF: 8, OF: 6, SP: 6, RP: 9 } },
  singleA: { league: 9804, level: 4, name: 'Planner', nickname: 'Singles', abbr: 'PLS', from: 98240, oa: 32, age: 22, shape: { C: 3, IF: 8, OF: 6, SP: 6, RP: 9 } },
  complex: { league: 9805, level: 6, name: 'ACL Planner', nickname: 'Nine', abbr: 'PLC', from: 98300, oa: 28, age: 21, shape: { C: 3, IF: 9, OF: 7, SP: 7, RP: 10 } },
  dslA: { league: 9806, level: 6, name: 'DSL Planner', nickname: 'Uno', abbr: 'PL1', from: 98360, oa: 24, age: 19, shape: { C: 3, IF: 8, OF: 6, SP: 6, RP: 9 } },
  dslB: { league: 9806, level: 6, name: 'DSL Planner', nickname: 'Dos', abbr: 'PL2', from: 98420, oa: 24, age: 19, shape: { C: 3, IF: 8, OF: 6, SP: 6, RP: 9 } },
};

/** The first id of the complex pool's block. */
const IC_FROM = 98480;

/** The service cap each capped club is generated against (the planner's defaults). */
const CAP: Partial<Record<ClubKey, number>> = { highA: 5, singleA: 4, complex: 3, dslA: 4, dslB: 4 };

/**
 * The men a test can name. Each is a plain row of the generator with one
 * thing changed, and the comment says which.
 */
export const PLAN_MEN = {
  /** Triple-A, on the 40-man, 3 of 3 options used with this year's among them: last option year. */
  lastOptionYear: 98060,
  /** Triple-A, on the 40-man, 3 used and none this year: out of options in the minors. */
  farmOutOfOptions: 98061,
  /** On the 26 with every option used and two years of service: flagged, never moved. */
  mlbOutOfOptions: 98018,
  /** Triple-A outfielder on the injured list (list 4) for 45 days: frozen. */
  aaaInjured: 98071,
  /** Double-A reliever on the injured list with the stale is_on_dl60 flag OOTP leaves: frozen by list 4 only. */
  aaInjured: 98156,
  /** Double-A catcher, healthy on list 2, carrying is_on_dl60 = 1 like Jake Cousins: not frozen. */
  staleDl60: 98120,
  /** High-A infielder at 5 of 5 pro years: his last eligible season, forced up. */
  highACapped: 98183,
  /** Single-A infielder at 4 of 4: last season, forced to High-A. */
  singleACapped: 98243,
  /** Single-A infielder at 5 of 4: over the cap, an invalid roster today. */
  singleAOver: 98244,
  /** Single-A outfielder at 3 of 4: next season is his last, nothing forced. */
  singleAUnder: 98251,
  /** DSL infielder at 4 of 4 with a grade that fits High-A: forced two steps up. */
  dslTwoStepsFit: 98363,
  /** DSL infielder at 4 of 4 and a 25 grade: the release/trade list, two steps up being too far. */
  dslTwoStepsShort: 98364,
  /** Double-A, Rule 5 eligible (5 of 4) with a 52 ceiling: worth a 40-man place on grade. */
  rule5Grade: 98131,
  /** Double-A, Rule 5 eligible with a 40 ceiling and no readable sample: a reason line, no protect. */
  rule5Depth: 98132,
  /** The three Double-A surplus men: old for the level with no ceiling, lowest fits first. */
  surplus: [98134, 98135, 98136],
  /** Complex pool, 19 years old: forced to the DSL before his 20th birthday. */
  icNineteen: 98480,
  /** Complex pool, the best 18-year-old by ceiling: the man the full pool sends out. */
  icBestEighteen: 98481,
  /** The Triple-A catchers, in id order; the first two are the named option cases above. */
  aaaCatchers: [98060, 98061, 98062],
  /** The Double-A catchers, in id order; the first is the stale-flag case above. */
  aaCatchers: [98120, 98121, 98122, 98123],
  /** The Triple-A centre fielders: the injured one above and the healthy one, the only two who cover CF there. */
  aaaCentreFielders: [98071, 98074],
  /** The big club's two catchers. */
  mlbCatchers: [98000, 98001],
} as const;

/** Fielding, by listed position: the spot itself and the two beside it on the spectrum. */
const GLOVES: Record<number, Array<[position: number, rating: number]>> = {
  2: [[2, 55], [3, 30]],
  3: [[3, 50], [7, 30]],
  4: [[4, 55], [6, 45], [5, 40]],
  5: [[5, 55], [4, 40], [6, 35]],
  6: [[6, 55], [4, 50], [5, 45]],
  7: [[7, 50], [9, 45], [8, 30]],
  8: [[8, 55], [7, 45], [9, 45]],
  9: [[9, 50], [7, 45], [8, 35]],
};

const PITCHES = [
  'fastball', 'slider', 'curveball', 'screwball', 'forkball', 'changeup', 'sinker', 'splitter',
  'knuckleball', 'cutter', 'circlechange', 'knucklecurve',
];

interface Man {
  id: number;
  club: ClubKey;
  position: number;
  /** 11 starter, 12 reliever, 13 closer, 0 for a position player. */
  role: number;
  age: number;
  oa: number;
  pot: number;
  proYears: number;
  protectedYears: number;
  /** The club's index of the man, for anything that varies by row. */
  i: number;
}

/** What a man's status rows say beyond the generator's defaults. */
interface Status {
  on40: boolean;
  /** Days on the injured list (list 4), or 0 for a healthy man. */
  hurt: number;
  options: number;
  optionsThisYear: number;
  serviceDays: number;
  dl60: boolean;
}

/** Adds a column where the shared fixture lacks it; the planner reads every one through hasColumns. */
function ensureColumns(table: string, columns: Array<[name: string, type: string]>): void {
  const have = new Set(
    (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((c) => c.name)
  );
  for (const [name, type] of columns) {
    if (!have.has(name)) db.exec(`ALTER TABLE "${table}" ADD COLUMN "${name}" ${type}`);
  }
}

function addColumns(): void {
  ensureColumns('leagues', [
    ['reputation', 'REAL'], ['ml_equivalencies_avg', 'REAL'], ['rule_5_draft_date', 'TEXT'],
    ['roster_expand_date', 'TEXT'], ['start_date', 'TEXT'], ['rules_minor_league_fa_minimum_years', 'INTEGER'],
    ['rules_active_roster_limit', 'INTEGER'], ['rules_expanded_roster_limit', 'INTEGER'],
    ['rules_secondary_roster_limit', 'INTEGER'],
  ]);
  ensureColumns('players', [['league_id', 'INTEGER'], ['date_of_birth', 'TEXT']]);
  ensureColumns('players_roster_status', [
    ['pro_service_years', 'INTEGER DEFAULT 0'], ['years_protected_from_rule_5', 'INTEGER DEFAULT 0'],
    ['options_used', 'INTEGER DEFAULT 0'], ['options_used_this_year', 'INTEGER DEFAULT 0'],
    ['days_on_waivers_left', 'INTEGER DEFAULT 0'],
  ]);
  ensureColumns('players_value', [
    ['overall_c', 'REAL'], ['overall_1b', 'REAL'], ['overall_2b', 'REAL'], ['overall_3b', 'REAL'],
    ['overall_ss', 'REAL'], ['overall_lf', 'REAL'], ['overall_cf', 'REAL'], ['overall_rf', 'REAL'],
    ['overall_sp', 'REAL'], ['overall_rp', 'REAL'],
  ]);
  ensureColumns('players_pitching', [
    ...PITCHES.map((p): [string, string] => [`pitching_ratings_pitches_${p}`, 'INTEGER DEFAULT 0']),
    ['pitching_ratings_misc_hold', 'INTEGER'], ['pitching_ratings_vsl_stuff', 'INTEGER'],
    ['pitching_ratings_vsr_stuff', 'INTEGER'],
  ]);
}

/** The men of one club, generated from its shape; a few rows carry the cases named in PLAN_MEN. */
function clubMen(club: ClubKey): Man[] {
  const c = CLUBS[club];
  const spots: Array<[position: number, role: number]> = [];
  const push = (positions: number[], count: number, role = 0) => {
    for (let k = 0; k < count; k++) spots.push([positions[k % positions.length], role]);
  };
  push([2], c.shape.C);
  push([6, 4, 5, 3], c.shape.IF);
  push([8, 7, 9], c.shape.OF);
  push([1], c.shape.SP, 11);
  push([1], c.shape.RP, 12);
  // The last reliever of each club is its listed closer
  spots[spots.length - 1][1] = 13;

  return spots.map(([position, role], i) => {
    const id = c.from + i;
    // Spread around the club's median: eleven steps of grade, five of age,
    // each walked at a different stride so the two do not move together
    const oa = c.oa + ((i * 7) % 11) - 5;
    const age = c.age + ((i * 3) % 5) - 2;
    // Younger men have more left to grow: fifteen points at twenty, none past thirty
    const pot = oa + Math.max(0, Math.min(15, 35 - age));
    // A year of pro service for each year since twenty (eighteen for the
    // DSL, where men sign young), which puts the oldest men of a capped club
    // at its cap and nobody over it — except at the DSL, where only the two
    // named men reach 4 of 4, so the two-steps-up rule has exactly its cases.
    // The Triple-A and Double-A men signed out of college at twenty-three, so
    // only the oldest of them have caught up with their four years of Rule 5
    // protection: four men are worth a 40-man place against the five places
    // open, the named one among them, and a test that wants the places to run
    // out makes more (the 40-man tests' own cases)
    const signedAt = club === 'dslA' || club === 'dslB' ? 18 : club === 'aaa' || club === 'aa' ? 23 : 20;
    const cap = CAP[club];
    const proYears = Math.min(Math.max(0, age - signedAt), cap ?? 99);
    const protectedYears = signedAt <= 18 ? 5 : 4;
    return { id, club, position, role, age, oa, pot, proYears, protectedYears, i };
  });
}

/** The named cases, applied over the generated rows. */
function special(men: Man[]): Man[] {
  const by = new Map(men.map((m) => [m.id, m]));
  const set = (id: number, patch: Partial<Man>) => Object.assign(by.get(id)!, patch);
  set(PLAN_MEN.highACapped, { age: 25, proYears: 5, oa: 38, pot: 46 });
  set(PLAN_MEN.singleACapped, { age: 24, proYears: 4, oa: 33, pot: 40 });
  set(PLAN_MEN.singleAOver, { age: 25, proYears: 5, oa: 31, pot: 36 });
  set(PLAN_MEN.singleAUnder, { age: 23, proYears: 3 });
  set(PLAN_MEN.dslTwoStepsFit, { age: 21, proYears: 4, oa: 36, pot: 48 });
  set(PLAN_MEN.dslTwoStepsShort, { age: 21, proYears: 4, oa: 25, pot: 30 });
  set(PLAN_MEN.rule5Grade, { age: 25, proYears: 5, oa: 39, pot: 52 });
  set(PLAN_MEN.rule5Depth, { age: 25, proYears: 5, oa: 34, pot: 40 });
  for (const [k, id] of PLAN_MEN.surplus.entries()) set(id, { age: 31 + k, proYears: 11 + k, oa: 30 - k, pot: 30 - k });
  return men;
}

interface IcMan { id: number; age: number; position: number; pot: number }

/** Fifty men in the complex pool: seventeen of sixteen, thirty of seventeen, three of eighteen — and one of nineteen. */
function icMen(): IcMan[] {
  const out: IcMan[] = [];
  for (let i = 0; i < PLAN.icSize; i++) {
    const id = IC_FROM + i;
    const age = i === 0 ? 19 : i < 4 ? 18 : i < 34 ? 17 : 16;
    out.push({ id, age, position: [1, 6, 8, 2, 4, 9, 5, 7][i % 8], pot: 40 + ((i * 5) % 16) });
  }
  // The best eighteen-year-old by ceiling, which the full-pool rule sends out
  out[1].pot = 58;
  return out;
}

/** OOTP's unpadded date form, from a year, month and day. */
const date = (y: number, m: number, d: number): string => `${y}-${m}-${d}`;

/** A birthday in March, so the age on the June game date is the one written on the row. */
const birthday = (age: number, i: number): string => date(PLAN.season - age, 3, 1 + (i % 27));

/** A batting line scaled to the man's grade against his club's median: a 5-point edge is worth about 20 points of average. */
export function battingLine(oa: number, base: number, pa: number): Record<string, number> {
  const edge = (oa - base) / 5;
  const avg = 0.25 + edge * 0.02;
  const ab = Math.round(pa * 0.9);
  const h = Math.round(ab * avg);
  const hr = Math.max(0, Math.round(pa * (0.02 + edge * 0.006)));
  const d = Math.round(h * 0.2);
  const t = Math.round(h * 0.02);
  const bb = Math.round(pa * (0.08 + edge * 0.005));
  const k = Math.round(pa * 0.2);
  const r = Math.round(pa * 0.12);
  return { pa, ab, h, d, t, hr, bb, ibb: 0, hp: Math.round(pa * 0.01), sf: Math.round(pa * 0.01), k, sb: 2, cs: 1, r, rbi: r, war: edge };
}

/** A pitching line the same way: a 5-point edge is worth about a third of a run of ERA. */
export function pitchingLine(oa: number, base: number, outs: number, starter: boolean): Record<string, number> {
  const edge = (oa - base) / 5;
  const ip = outs / 3;
  const era = Math.max(1.5, 4.5 - edge * 0.35);
  const er = Math.round((era * ip) / 9);
  const g = starter ? Math.max(1, Math.round(ip / 5.5)) : Math.max(1, Math.round(ip));
  return {
    outs, er, ra: er + Math.round(ip * 0.05), ha: Math.round(ip * (0.95 - edge * 0.03)), bb: Math.round(ip * 0.33),
    k: Math.round(ip * (0.9 + edge * 0.05)), hra: Math.round(ip * 0.1), hp: Math.round(ip * 0.03), bf: Math.round(ip * 4.3),
    g, gs: starter ? g : 0, w: Math.round(g * 0.3), l: Math.round(g * 0.3), s: starter ? 0 : Math.round(g * 0.1),
    hld: starter ? 0 : Math.round(g * 0.1), war: edge * 0.5,
  };
}

/** The club a man played for the season before: one rung down the ladder, or the same club at the bottom. */
const LAST_SEASON: Record<ClubKey, ClubKey> = {
  mlb: 'aaa', aaa: 'aa', aa: 'highA', highA: 'singleA', singleA: 'complex', complex: 'dslA', dslA: 'dslA', dslB: 'dslB',
};

/** The leagues, the clubs and the season's games: written once, and never again while the clubs exist. */
function seedClubs(): void {
  const league = db.prepare(
    `INSERT INTO leagues
       (league_id, name, abbr, parent_league_id, league_level, season_year, "current_date",
        rules_fa_minimum_years, rules_salary_arbitration_minimum_years, rules_minimum_salary,
        financial_coefficient, rules_amateur_draft, show_draft_pool, draft_date, rules_amateur_draft_rounds,
        trade_deadline_date, rules_schedule_games_per_team, reputation, ml_equivalencies_avg,
        rule_5_draft_date, roster_expand_date, start_date, rules_minor_league_fa_minimum_years,
        rules_active_roster_limit, rules_expanded_roster_limit, rules_secondary_roster_limit)
     VALUES (@id, @name, @abbr, @parent, @level, @season, @today, 6, 3, 700000, 1, @draft, 0, '2030-7-10', 20,
             @deadline, 140, @reputation, @mle, @rule5, @expand, @start, @minorFa, @active, @expanded, @secondary)`
  );
  const leagues: Array<[key: keyof typeof PLAN.leagues, name: string, rep: number, mle: number, start: string]> = [
    ['mlb', 'Planner League', REPUTATION.mlb, MLE.mlb, PLAN.dates.openingDay],
    ['aaa', 'Planner Triple-A', REPUTATION.aaa, MLE.aaa, '2030-3-31'],
    ['aa', 'Planner Double-A', REPUTATION.aa, MLE.aa, '2030-4-6'],
    ['highA', 'Planner High-A', REPUTATION.highA, MLE.highA, '2030-4-6'],
    ['singleA', 'Planner Single-A', REPUTATION.singleA, MLE.singleA, '2030-4-6'],
    ['complex', 'Planner Complex League', REPUTATION.complex, MLE.complex, '2030-5-8'],
    ['dsl', 'Planner Dominican League', REPUTATION.dsl, MLE.dsl, PLAN.dates.dslStart],
  ];
  for (const [key, name, reputation, mle, start] of leagues) {
    const top = key === 'mlb';
    league.run({
      id: PLAN.leagues[key], name, abbr: key.toUpperCase(), parent: top ? 0 : PLAN.leagues.mlb,
      level: top ? 1 : 2, season: PLAN.season, today: PLAN.gameDate, draft: top ? 1 : 0,
      // Only the big league carries live dates; the farm rows carry the stale
      // Rule 5 date and the 7-31 deadline a real export has, which the planner must ignore
      deadline: top ? PLAN.dates.tradeDeadline : '2030-7-31', reputation, mle,
      rule5: top ? PLAN.dates.rule5 : '2028-12-1', expand: PLAN.dates.rosterExpand, start,
      minorFa: top ? 6 : 0, active: top ? 26 : 0, expanded: top ? 28 : 0, secondary: top ? 40 : 0,
    });
    db.prepare(`INSERT INTO sub_leagues VALUES (?, 0, 'Only', 1)`).run(PLAN.leagues[key]);
  }

  const team = db.prepare(
    `INSERT INTO teams (team_id, name, nickname, abbr, level, league_id, sub_league_id, division_id,
                        parent_team_id, allstar_team, human_team)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, 0, 0)`
  );
  for (const [key, c] of Object.entries(CLUBS) as Array<[ClubKey, (typeof CLUBS)[ClubKey]]>) {
    team.run(PLAN.teams[key], c.name, c.nickname, c.abbr, c.level, c.league, key === 'mlb' ? 0 : PLAN.org);
  }

  // The season's bookends per league, as game_type 0, plus a playoff game and
  // — where the season runs past it — a string-sorting decoy, so the season
  // end has to be found by DATE_KEY: "2030-9-9" sorts after "2030-9-29" as
  // text. A league whose season ends before the ninth of September gets no
  // decoy, since the decoy would then be its real last game.
  const game = db.prepare(
    `INSERT INTO games (game_id, home_team, away_team, date, played, league_id, game_type) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  let gameId = 980000;
  const ends: Array<[keyof typeof PLAN.seasonEnd, number, number]> = [
    ['mlb', PLAN.leagues.mlb, PLAN.teams.mlb], ['aaa', PLAN.leagues.aaa, PLAN.teams.aaa],
    ['aa', PLAN.leagues.aa, PLAN.teams.aa], ['highA', PLAN.leagues.highA, PLAN.teams.highA],
    ['singleA', PLAN.leagues.singleA, PLAN.teams.singleA], ['complex', PLAN.leagues.complex, PLAN.teams.complex],
    ['dsl', PLAN.leagues.dsl, PLAN.teams.dslA],
  ];
  const ordinal = (d: string): number => {
    const [y, m, day] = d.split('-').map(Number);
    return y * 10000 + m * 100 + day;
  };
  for (const [key, leagueId, teamId] of ends) {
    game.run(gameId++, teamId, teamId, '2030-4-6', 1, leagueId, 0);
    if (ordinal(PLAN.seasonEnd[key]) > ordinal('2030-9-9')) game.run(gameId++, teamId, teamId, '2030-9-9', 0, leagueId, 0);
    game.run(gameId++, teamId, teamId, PLAN.seasonEnd[key], 0, leagueId, 0);
    game.run(gameId++, teamId, teamId, '2030-10-5', 0, leagueId, 1);
  }
}

const INSERT_PLAYER = `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws, uniform_number,
                            team_id, organization_id, retired, hidden, draft_eligible, college, league_id,
                            date_of_birth, injury_is_injured, injury_left)
       VALUES (@id, @first, @last, @age, @position, @role, @bats, @throws, @number, @team, @org, 0, 0, 0, 0,
               @league, @born, @hurt, @daysOut)`;
const INSERT_STATUS = `INSERT INTO players_roster_status
         (player_id, is_active, is_on_dl, is_on_dl60, is_on_secondary, mlb_service_years, mlb_service_days,
          mlb_service_days_this_year, designated_for_assignment, days_on_dfa_left, is_on_waivers,
          pro_service_years, years_protected_from_rule_5, options_used, options_used_this_year)
       VALUES (@id, @active, @dl, @dl60, @secondary, @years, @days, @daysThisYear, 0, 0, 0,
               @proYears, @protectedYears, @options, @optionsThisYear)`;
const INSERT_VALUE = `INSERT INTO players_value
         (player_id, overall_value, talent_value, offensive_value, offensive_value_vsl, offensive_value_vsr,
          pitching_value, oa_rating, pot_rating, oa, pot, overall_c, overall_1b, overall_2b, overall_3b,
          overall_ss, overall_lf, overall_cf, overall_rf, overall_sp, overall_rp)
       VALUES (@id, @overall, @talent, @offense, @offense, @offense, @pitching, @oaRounded, @potRounded, @oa, @pot,
               @c, @b1, @b2, @b3, @ss, @lf, @cf, @rf, @sp, @rp)`;
const INSERT_CONTRACT = `INSERT INTO players_contract
         (player_id, team_id, contract_team_id, season_year, years, current_year, is_major, retained,
          no_trade, last_year_team_option, last_year_player_option, last_year_vesting_option,
          ${Array.from({ length: 15 }, (_, i) => `salary${i}`).join(', ')})
       VALUES (?, ?, ?, ?, ?, 0, ?, 0, 0, 0, 0, 0, ${Array.from({ length: 15 }, () => '?').join(', ')})`;
const INSERT_PITCHING = `INSERT INTO players_pitching
         (player_id, pitching_ratings_overall_stuff, pitching_ratings_overall_movement, pitching_ratings_overall_control,
          pitching_ratings_talent_stuff, pitching_ratings_talent_movement, pitching_ratings_talent_control,
          pitching_ratings_misc_stamina, pitching_ratings_misc_velocity, pitching_ratings_misc_hold,
          pitching_ratings_vsl_stuff, pitching_ratings_vsr_stuff,
          ${PITCHES.map((p) => `pitching_ratings_pitches_${p}`).join(', ')})
       VALUES (@id, @stuff, @movement, @control, @stuffP, @movementP, @controlP, @stamina, 92, @hold, @vsl, @vsr,
               ${PITCHES.map((p) => `@${p}`).join(', ')})`;
const INSERT_BAT_LINE = `INSERT INTO players_career_batting_stats
         (player_id, year, team_id, league_id, level_id, split_id, pa, ab, h, d, t, hr, bb, ibb, hp, sf, k, sb, cs, r, rbi, war)
       VALUES (@id, @year, @team, @league, @level, 1, @pa, @ab, @h, @d, @t, @hr, @bb, @ibb, @hp, @sf, @k, @sb, @cs, @r, @rbi, @war)`;
const INSERT_PITCH_LINE = `INSERT INTO players_career_pitching_stats
         (player_id, year, team_id, league_id, level_id, split_id, outs, er, ra, ha, bb, k, hra, hp, bf, g, gs, w, l, s, hld, war)
       VALUES (@id, @year, @team, @league, @level, 1, @outs, @er, @ra, @ha, @bb, @k, @hra, @hp, @bf, @g, @gs, @w, @l, @s, @hld, @war)`;

function fielding(row: Record<string, number>): void {
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO players_fielding (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})`).run(row);
}

/** Writes one club man: his row, status, grades, roster lists, contract, ratings and lines. */
function writeMan(m: Man, s: Status, lines: boolean): void {
  const c = CLUBS[m.club];
  const teamId = PLAN.teams[m.club];
  const isMlb = m.club === 'mlb';
  const hurt = s.hurt > 0;
  db.prepare(INSERT_PLAYER).run({
    id: m.id, first: `${c.nickname}`, last: `Man${m.i + 1}`, age: m.age, position: m.position, role: m.role,
    bats: 1 + (m.i % 3), throws: 1 + (m.i % 2), number: m.i + 1, team: teamId, org: PLAN.org, league: c.league,
    born: birthday(m.age, m.i), hurt: hurt ? 1 : 0, daysOut: s.hurt,
  });
  db.prepare(INSERT_STATUS).run({
    id: m.id, active: isMlb ? 1 : 0, dl: hurt ? 1 : 0, dl60: s.dl60 ? 1 : 0,
    secondary: s.on40 ? 1 : 0, years: Math.floor(s.serviceDays / 172), days: s.serviceDays,
    daysThisYear: isMlb ? 40 : 0, proYears: m.proYears, protectedYears: m.protectedYears,
    options: s.options, optionsThisYear: s.optionsThisYear,
  });
  const isPitcher = m.position === 1;
  const base = m.oa * 20;
  db.prepare(INSERT_VALUE).run({
    id: m.id, overall: base, talent: m.pot * 20, offense: isPitcher ? 0 : base, pitching: isPitcher ? base : 0,
    oaRounded: Math.round(m.oa / 5) * 5, potRounded: Math.round(m.pot / 5) * 5, oa: m.oa, pot: m.pot,
    // OOTP's per-position totals: the listed spot highest, the spectrum neighbours below it
    c: m.position === 2 ? base : base * 0.3, b1: m.position === 3 ? base : base * 0.5,
    b2: m.position === 4 ? base : base * 0.6, b3: m.position === 5 ? base : base * 0.6,
    ss: m.position === 6 ? base : base * 0.5, lf: m.position === 7 ? base : base * 0.6,
    cf: m.position === 8 ? base : base * 0.5, rf: m.position === 9 ? base : base * 0.6,
    // Every pitcher's SP value exceeds his RP value, as in a real export
    sp: isPitcher ? base * 1.3 : base * 0.1, rp: isPitcher ? base : base * 0.08,
  });
  const roster = db.prepare(`INSERT INTO team_roster VALUES (?, ?, ?)`);
  roster.run(teamId, m.id, 1);
  roster.run(teamId, m.id, hurt ? 4 : 2);
  if (s.on40) roster.run(PLAN.teams.mlb, m.id, 3);
  const salary = isMlb ? 800_000 + m.i * 100_000 : s.on40 ? 720_000 : 0;
  const salaries = Array.from({ length: 15 }, (_, k) => (k < 1 ? salary : 0));
  db.prepare(INSERT_CONTRACT).run(m.id, teamId, PLAN.teams.mlb, PLAN.season, 1, s.on40 ? 1 : 0, ...salaries);

  const batting = db.prepare(`INSERT INTO players_batting VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  if (isPitcher) {
    const starter = m.role === 11;
    const stuff = m.oa + 5;
    db.prepare(INSERT_PITCHING).run({
      id: m.id, stuff, movement: m.oa, control: m.oa - 5, stuffP: m.pot + 5, movementP: m.pot, controlP: m.pot - 5,
      stamina: starter ? 55 : 30, hold: 50,
      // One reliever in ten is a specialist: twelve points better against lefties
      vsl: !starter && m.i % 10 === 9 ? stuff + 6 : stuff, vsr: !starter && m.i % 10 === 9 ? stuff - 6 : stuff,
      ...Object.fromEntries(PITCHES.map((p) => [p, 0])),
      fastball: 55, slider: 50, changeup: starter ? 45 : 0, curveball: starter ? 40 : 0,
    });
    batting.run(m.id, 20, 20, 20, 20, 20, 30, 20, 20, 20, 20, 30);
    fielding({ player_id: m.id, position: 1, fielding_rating_pos1: 40, fielding_experience1: 50 });
  } else {
    batting.run(m.id, m.oa, m.oa - 5, m.oa + 5, m.oa, m.oa, 50, m.pot, m.pot - 5, m.pot + 5, m.pot, m.pot);
    const row: Record<string, number> = { player_id: m.id, position: m.position };
    for (const [pos, rating] of GLOVES[m.position]) {
      row[`fielding_rating_pos${pos}`] = rating;
      row[`fielding_rating_pos${pos}_pot`] = rating + 5;
    }
    row[`fielding_experience${m.position}`] = 100 + m.i;
    fielding(row);
  }
  if (lines) writeLines(m);
}

/**
 * Three seasons of lines: this one at his club (a third of a season in), the
 * two before at the club one rung down. The DSL has not opened yet, so its
 * men have no line this year, and the complex pool has none at all.
 */
function writeLines(m: Man): void {
  const isPitcher = m.position === 1;
  const seasons: Array<[year: number, club: ClubKey, share: number]> = [
    [PLAN.season, m.club, 0.35], [PLAN.season - 1, LAST_SEASON[m.club], 1], [PLAN.season - 2, LAST_SEASON[LAST_SEASON[m.club]], 0.9],
  ];
  for (const [year, at, share] of seasons) {
    if (year === PLAN.season && (m.club === 'dslA' || m.club === 'dslB')) continue;
    const atClub = CLUBS[at];
    const common = { id: m.id, year, team: PLAN.teams[at], league: atClub.league, level: atClub.level };
    if (isPitcher) {
      const outs = Math.round((m.role === 11 ? 150 * 3 : 60 * 3) * share);
      db.prepare(INSERT_PITCH_LINE).run({ ...common, ...pitchingLine(m.oa, atClub.oa, outs, m.role === 11) });
    } else {
      db.prepare(INSERT_BAT_LINE).run({ ...common, ...battingLine(m.oa, atClub.oa, Math.round(450 * share)) });
    }
  }
}

/** The org's men and the complex pool, written when the first of them is missing. */
function seedMen(): void {
  const clubKeys = Object.keys(CLUBS) as ClubKey[];
  const all = special(clubKeys.flatMap(clubMen));
  /** The nine Triple-A men who hold 40-man places beside the 26: the first nine rows of the club. */
  const aaaOnForty = new Set(Array.from({ length: 9 }, (_, i) => CLUBS.aaa.from + i));

  for (const m of all) {
    const isMlb = m.club === 'mlb';
    // Options: the Triple-A 40-man men carry the counts the option tests read;
    // one man on the 26 has used all three
    let options = 0;
    let optionsThisYear = 0;
    if (m.id === PLAN_MEN.lastOptionYear) { options = 3; optionsThisYear = 1; }
    else if (m.id === PLAN_MEN.farmOutOfOptions) { options = 3; }
    else if (m.id === PLAN_MEN.mlbOutOfOptions) { options = 3; }
    else if (aaaOnForty.has(m.id)) { options = 1; optionsThisYear = 1; }
    writeMan(m, {
      on40: isMlb || aaaOnForty.has(m.id),
      hurt: m.id === PLAN_MEN.aaaInjured || m.id === PLAN_MEN.aaInjured ? 45 : 0,
      options, optionsThisYear,
      // Major-league service: the big club's men have some, a reliever on the
      // 26 is past five years so his options no longer bind, the rest none
      serviceDays: isMlb ? (m.i === 25 ? 6 * 172 : 2 * 172 + m.i * 7) : aaaOnForty.has(m.id) ? 60 : 0,
      // The stale flag OOTP leaves on a healthy man, and on a hurt one whose
      // export never cleared it: the planner must read list 2 and list 4 instead
      dl60: m.id === PLAN_MEN.staleDl60 || m.id === PLAN_MEN.aaInjured,
    }, true);
  }

  // The complex pool: on the parent club's id under a negative league, with
  // no roster row anywhere, which is how OOTP exports it
  for (const m of icMen()) {
    db.prepare(INSERT_PLAYER).run({
      id: m.id, first: 'Complex', last: `Pool${m.id - IC_FROM + 1}`, age: m.age, position: m.position,
      role: m.position === 1 ? 12 : 0, bats: 1, throws: 1, number: 0, team: PLAN.teams.mlb, org: PLAN.org,
      league: PLAN.icLeague, born: birthday(m.age, m.id), hurt: 0, daysOut: 0,
    });
    db.prepare(INSERT_STATUS).run({
      id: m.id, active: 0, dl: 0, dl60: 0, secondary: 0, years: 0, days: 0, daysThisYear: 0,
      proYears: 0, protectedYears: 5, options: 0, optionsThisYear: 0,
    });
    const oa = 20 + (m.pot - 40) / 2;
    db.prepare(INSERT_VALUE).run({
      id: m.id, overall: oa * 10, talent: m.pot * 10, offense: oa * 10, pitching: 0,
      oaRounded: Math.round(oa / 5) * 5, potRounded: Math.round(m.pot / 5) * 5, oa, pot: m.pot,
      c: 0, b1: 0, b2: 0, b3: 0, ss: 0, lf: 0, cf: 0, rf: 0, sp: 0, rp: 0,
    });
    db.prepare(`INSERT INTO players_batting VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(m.id, oa, oa, oa, oa, oa, 50, m.pot, m.pot, m.pot, m.pot, m.pot);
    if (m.position === 1) {
      db.prepare(INSERT_PITCHING).run({
        id: m.id, stuff: oa, movement: oa, control: oa, stuffP: m.pot, movementP: m.pot, controlP: m.pot,
        stamina: 30, hold: 40, vsl: oa, vsr: oa, ...Object.fromEntries(PITCHES.map((p) => [p, 0])), fastball: 45, slider: 40,
      });
    } else {
      const row: Record<string, number> = { player_id: m.id, position: m.position };
      for (const [pos, rating] of GLOVES[m.position]) row[`fielding_rating_pos${pos}`] = rating - 10;
      fielding(row);
    }
  }
}

/** Forgets everything a page or the engine remembered about a league without these men. */
export function clearPlannerCaches(): void {
  clearValuationCaches();
  clearTradeCache();
  clearStatCaches();
  clearOrgCache();
  clearScaleCache();
  clearPlanCache();
}

export function seedPlannerOrg(): void {
  addColumns();
  const haveClubs = !!db.prepare(`SELECT 1 FROM teams WHERE team_id = ?`).get(PLAN.org);
  const haveMen = !!db.prepare(`SELECT 1 FROM players WHERE player_id = ?`).get(CLUBS.mlb.from);
  if (haveClubs && haveMen) return;
  db.transaction(() => {
    if (!haveClubs) seedClubs();
    if (!haveMen) { purgeMen(); seedMen(); }
  })();
  clearPlannerCaches();
}

/** Every table a man of the org has rows in; the order removePlannerMan deletes them in. */
const MAN_TABLES = [
  'players', 'players_roster_status', 'players_value', 'team_roster', 'players_contract', 'players_batting',
  'players_pitching', 'players_fielding', 'players_career_batting_stats', 'players_career_pitching_stats',
];

/**
 * Clears whatever is left of the org's men before they are written again: a
 * case that emptied `players` but not the other tables (cacheReset's arrange
 * does) would otherwise seed a second set of lines and roster rows beside them.
 */
function purgeMen(): void {
  for (const table of MAN_TABLES) {
    db.prepare(`DELETE FROM ${table} WHERE player_id BETWEEN ? AND 99999`).run(CLUBS.mlb.from);
  }
}

/** A man a test adds to a club of the org, beyond the generated rows; ids from PLAN.spareFrom. */
export interface ExtraMan {
  id: number;
  club: ClubKey;
  position: number;
  /** 11 starter, 12 reliever, 13 closer; 0 (the default) for a position player. */
  role?: number;
  age: number;
  oa: number;
  pot: number;
  proYears?: number;
  protectedYears?: number;
  on40?: boolean;
  /** Days on the injured list; 0 (the default) for a healthy man. */
  hurt?: number;
  options?: number;
  optionsThisYear?: number;
  serviceDays?: number;
  /** Whether he gets the three seasons of lines the generator writes; true by default. */
  lines?: boolean;
}

/**
 * Adds one man to a club. His name is `{nickname} Extra{n}` from his id, so a
 * test can find him by id and a sentence can name him. Written with the same
 * statements as the generated men, so he carries everything the engine reads.
 */
export function addPlannerMan(m: ExtraMan): void {
  const i = m.id - PLAN.spareFrom + 1000; // past every generated index, so his name and number cannot collide
  const man: Man = {
    id: m.id, club: m.club, position: m.position, role: m.role ?? (m.position === 1 ? 12 : 0), age: m.age,
    oa: m.oa, pot: m.pot, proYears: m.proYears ?? Math.max(0, m.age - 20), protectedYears: m.protectedYears ?? 4, i,
  };
  writeMan(man, {
    on40: m.on40 ?? false, hurt: m.hurt ?? 0, options: m.options ?? 0, optionsThisYear: m.optionsThisYear ?? 0,
    serviceDays: m.serviceDays ?? 0, dl60: false,
  }, m.lines ?? true);
}

/** Takes a man out of the save altogether: a trade to another org as far as the planner can see. */
export function removePlannerMan(id: number): void {
  for (const table of MAN_TABLES) {
    db.prepare(`DELETE FROM ${table} WHERE player_id = ?`).run(id);
  }
}

/**
 * Runs one case against a changed save and puts the save back, however the
 * case ends. The change is made inside a savepoint and rolled back, so a case
 * may delete men, drop a table or rewrite a cap without the next case
 * knowing; every cache the engine reads through is cleared on the way in and
 * on the way out, since a figure remembered from the unchanged save would
 * make the change invisible.
 */
export async function inScenario<T>(change: () => void, run: () => Promise<T> | T): Promise<T> {
  db.exec('SAVEPOINT planner_scenario');
  try {
    change();
    clearPlannerCaches();
    return await run();
  } finally {
    db.exec('ROLLBACK TO planner_scenario');
    db.exec('RELEASE planner_scenario');
    clearPlannerCaches();
  }
}
