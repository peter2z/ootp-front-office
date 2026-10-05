/**
 * The shapes the Organization Planner speaks in: what `GET /api/plan/:orgId`
 * returns, what a move is, what a decision on it looks like, and the settings
 * block that steers it.
 *
 * They live in a file of their own, with no imports, because three modules
 * need them and none of them should have to load the others to get at a type:
 * the engine (`planner.ts`) builds a Plan, the decision store
 * (`plandecisions.ts`) persists a Move's predicate, and `settings.ts` holds the
 * PlannerSettings — and `settings.ts` is imported by nearly everything, so a
 * type that pulled the engine in behind it would drag the whole farm into the
 * settings page. Field names follow the JSON in the design's §7 exactly, snake
 * case where the pages already read `player_id` and camel case elsewhere, so a
 * page can be written against the document and compile against this.
 */

// ── The ladder ──────────────────────────────────────────────────────────

/**
 * One step of the organisation's ladder, top to bottom. Built from each
 * league's reputation rather than `teams.level`, which cannot tell High-A from
 * Single-A or the ACL from the DSL; two clubs sharing a reputation share a
 * rung (the two DSL clubs). The international complex pool (`ic`) hangs below
 * the DSL and only ever loses men.
 */
export type RungKey = 'mlb' | 'aaa' | 'aa' | 'high-a' | 'single-a' | 'complex' | 'dsl' | 'ic';

/** Every rung, highest first. The order is what "at or above" means for an offseason move. */
export const RUNG_KEYS: readonly RungKey[] = ['mlb', 'aaa', 'aa', 'high-a', 'single-a', 'complex', 'dsl', 'ic'];

/** Whether the string names a rung. */
export const isRungKey = (value: unknown): value is RungKey =>
  typeof value === 'string' && (RUNG_KEYS as readonly string[]).includes(value);

// ── Moves ───────────────────────────────────────────────────────────────

/**
 * What a card recommends. `forced` is a move a rule requires regardless of
 * merit; `hold` keeps a move a rule refused visible with its refusal; `cover`
 * is a promotion whose only reason is an injured man above. `position` and
 * `role` ship in 0.42.1 but are named now so the key format is fixed.
 */
export type MoveKind =
  | 'forced' | 'callup' | 'senddown' | 'promote' | 'demote' | 'cover' | 'assign'
  | 'position' | 'role' | 'protect' | 'il60' | 'trade' | 'release' | 'hold';

/** `now` is dated today; `offseason` is folded away until the season-end fold. */
export type Horizon = 'now' | 'offseason';

/**
 * Where a deadline comes from. Only the MLB league row carries live dates;
 * season ends come from the last regular-season game of the man's own league;
 * an IC man's deadline is his 20th birthday.
 */
export type DeadlineKind =
  | 'service-cap' | 'ic-age' | 'ic-room' | 'rule5' | 'trade-deadline'
  | 'season-end' | 'minor-fa' | 'roster-expand' | 'opening-day';

export interface Deadline {
  kind: DeadlineKind;
  /** OOTP's unpadded form, as the export writes it (2028-9-10). */
  date: string;
  /** The sentence the strip prints. */
  what: string;
  /** Counted from the game date, not the wall clock, so the plan is deterministic. */
  daysAway: number;
}

/**
 * What the next import checks to say whether an accepted move happened.
 * Kinds map to fields: rung moves → `rung`; release/trade → `org = 'gone'`;
 * assign → `rostered = true`; position → the position number; role → the role
 * class; protect → `on40 = true`; il60 → `il60 = true`; hold → none.
 */
export interface Verify {
  field: 'rung' | 'org' | 'position' | 'role' | 'on40' | 'il60' | 'rostered';
  /** A rung key, `gone`, a position number, a role class, or `true`. */
  expect: string | number | boolean;
}

/** What the user has said about a move. `open` is the default and is never stored. */
export type DecisionState = 'open' | 'accepted' | 'dismissed';

/**
 * What an import saw of an accepted move: the predicate held (`done`), he is
 * where he was (`not-yet`), he went somewhere else (`changed`), or he left the
 * organisation on a move that was not a release (`moot`). A dismissal becomes
 * `moot` when the planner stops producing its key.
 */
export type DecisionOutcome = 'done' | 'not-yet' | 'changed' | 'moot';

export interface MoveDecision {
  state: DecisionState;
  /** The game date the decision was made on; null while open. */
  gameDate: string | null;
  outcome: DecisionOutcome | null;
  /** The game date of the export the outcome was read from. */
  verifiedGameDate: string | null;
  /**
   * Where that export found him: a club's label, or 'out of the organization'
   * for a release or trade seen through. Null until an import has looked, and
   * while the outcome is not-yet.
   */
  seenAt: string | null;
  /**
   * The deadline the move carried when it was decided, as stored with the
   * decision; null while open and for a move that had none. OOTP rolls the
   * Rule 5 date forward a year once the draft has passed, so the live card's
   * deadline may be a later one than the user accepted or dismissed under.
   */
  deadlineDate: string | null;
}

/** Readiness as the page prints it. `frozen` is an IL man; `unscored` has no grades. */
export type Readiness = 'ready' | 'hold' | 'overmatched' | 'frozen' | 'unscored';

/**
 * What jobs a man can hold, from revealed positions and pitching ratings:
 * `super` covers infield and outfield, `bat-only` is 1B/DH, `everyday` is one
 * spot; arms are starter, swing man, reliever or closer.
 */
export type UtilityClass = 'C' | 'IF' | 'OF' | 'super' | 'bat-only' | 'everyday' | 'SP' | 'swing' | 'RP' | 'CL';

/** The release/trade classification. */
export type AssetClass = 'core' | 'prospect' | 'depth' | 'surplus';

/** What sharpens an asset class into a kind of move. */
export type AssetModifier = 'on40-last-option' | 'on40-out-of-options' | 'rule5-exposed' | 'minor-fa-after-season';

/** Ceiling tier from POT on 20-80: regular ≥ 50, bench 45-49, depth 40-44, filler below. */
export type CeilingTier = 'regular' | 'bench' | 'depth' | 'filler';

/** A group the structure minimums count. `SS cover` and `CF cover` are the two cover checks. */
export type StructureGroup = 'C' | 'IF' | 'OF' | 'SP' | 'RP' | 'SS cover' | 'CF cover';

/** A card or level colour: `ok` inside every band, `warn` over a soft maximum, `bad` under a minimum or over a hard rule. */
export type Tone = 'ok' | 'warn' | 'bad';

export interface PlanMovePlayer {
  player_id: number;
  name: string;
  age: number;
  /** The listed position, as the pages print it (3B, RHP). */
  positionName: string;
  /** The listed pitching role, or null for a position player. */
  roleLabel: string | null;
  /** Overall and potential on the save's scale; the page formats them. */
  oa: number | null;
  pot: number | null;
  bats: string | null;
  throws: string | null;
  utility: UtilityClass | null;
  assetClass: AssetClass | null;
}

/** Where a move starts. */
export interface MoveFrom {
  rung: RungKey;
  /** The club's name from the save. */
  label: string;
  team_id: number | null;
}

/** Where a move ends; `out` for a release or trade, `40man` for a protection. */
export interface MoveTo {
  rung: RungKey | 'out' | '40man';
  label: string;
  team_id: number | null;
  /** The position number a `position` move proposes; null otherwise. */
  position: number | null;
  /** The role class a `role` move proposes; null otherwise. */
  role: string | null;
}

/** The 40-man place a call-up or protection needs, and who gives it up when the roster is full. */
export interface MoveFortyMan {
  count: number;
  limit: number;
  comesOff: { player_id: number; name: string; why: string } | null;
}

export interface PlanMove {
  /**
   * `kind:player_id:from:to`, stable across imports while the recommendation
   * is the same. The one exception is a man's 40-man question, `protect:player_id:40man`
   * whether its card is a protection or the hold that stands in for one: it
   * is about the man, so it keeps its key when he changes clubs.
   */
  key: string;
  kind: MoveKind;
  horizon: Horizon;
  /** A rule required it; placed first and pinned during balancing. */
  forced: boolean;
  player: PlanMovePlayer;
  from: MoveFrom;
  to: MoveTo;
  /** Sentences written on the server; the rule that fired is the first one. Never empty. */
  reasons: string[];
  /** The OOTP screen the move is made on. */
  screen: string;
  /** The clicks, in order. */
  ootpSteps: string[];
  deadline: Deadline | null;
  /** What the next import checks; null for a hold. */
  verify: Verify | null;
  fortyMan: MoveFortyMan | null;
  /** Keys of moves this one carries with it (a promotion with its protection). */
  linked: string[];
  decision: MoveDecision;
}

// ── Levels ──────────────────────────────────────────────────────────────

/** Heads per group on a roster. */
export type GroupCounts = Record<'C' | 'IF' | 'OF' | 'SP' | 'RP', number>;

/** The roster as the export has it: sizes on the full list, minimums on healthy men. */
export interface LevelNow {
  /** Everyone on list 1, injured men included — a hurt man holds a place. */
  roster: number;
  /** List 2 for a minor-league club; `healthOf()` for the 26. */
  healthy: number;
  il: number;
  groups: GroupCounts;
}

/** The roster once the plan's moves are made. */
export interface LevelPlanned {
  roster: number;
  healthy: number;
  groups: GroupCounts;
}

export interface StructureRow {
  group: StructureGroup;
  /** Healthy men who qualify. */
  have: number;
  /** The minimum the level needs to play a season. */
  need: number;
  tone: Tone;
  /** Who provides it, when that is worth saying ("Guerrero 40, Herrera 40 once Morales goes up"). */
  note?: string;
}

export interface StaffRow {
  player_id: number;
  name: string;
  fit: number | null;
  /** `CL` for the derived closer, `vs L` / `vs R` for a specialist, `swing` for a swing man filling the rotation. */
  tag: string | null;
}

/** The pitching staff as the engine classes it: the rotation in order, the bullpen with the closer first. */
export interface LevelStaff {
  rotation: StaffRow[];
  bullpen: StaffRow[];
}

/** The level's median man, which readiness is measured against. */
export interface LevelBaseline {
  medAge: number | null;
  medOa: { pos: number | null; sp: number | null; rp: number | null };
}

/** Where a man ends up relative to this level once the plan is applied. */
export type RosterStatus = 'stays' | 'arrives' | 'leaves';

export interface PlanRosterRow {
  player_id: number;
  name: string;
  age: number;
  positionName: string;
  roleLabel: string | null;
  oa: number | null;
  pot: number | null;
  /** Readiness at this rung; null when unscored. */
  fit: number | null;
  verdict: Readiness;
  utility: UtilityClass | null;
  assetClass: AssetClass | null;
  status: RosterStatus;
  /** On the injured list: listed, counted toward size, never moved. */
  frozen: boolean;
  /** The season he is last eligible at this rung under its cap, or null when uncapped. */
  lastEligibleSeason: number | null;
  /**
   * Facts that are never moves: a man on the 26 out of options is the one a
   * full roster forces through waivers, and the page prints that beside him
   * rather than recommending anything.
   */
  flags: string[];
}

export interface PlanLevel {
  rung: RungKey;
  /** 1 at the top; the page orders by it. */
  rank: number;
  /** The club's name from the save (the two DSL clubs are joined with " / "). */
  label: string;
  /** The short level name the tag prints (AA, High-A). */
  levelName: string;
  teamIds: number[];
  leagueId: number | null;
  /** The pro-service cap at this rung from Settings; null when uncapped. */
  serviceCap: number | null;
  now: LevelNow;
  planned: LevelPlanned;
  /** The size band from Settings: minimum hard, maximum soft. */
  target: RungTargets;
  structure: StructureRow[];
  staff: LevelStaff;
  /** Shortfalls nobody eligible can fill ("sign 2 minor-league free agents: a catcher and a reliever"). */
  needs: string[];
  baseline: LevelBaseline;
  tone: Tone;
  roster: PlanRosterRow[];
  /**
   * One row per club on a rung that has more than one (the DSL pair), each
   * judged against the per-club size band; left out on a one-club rung. The
   * level's own `now` and `planned` figures add the clubs together, which no
   * band speaks to.
   */
  clubs?: PlanLevelClub[];
}

/** One club of a multi-club rung, against the per-club band. */
export interface PlanLevelClub {
  team_id: number;
  label: string;
  /** His club's full roster today. */
  now: number;
  /** The planned roster: today's men, plus the moves dated now. */
  planned: number;
  min: number;
  max: number;
  /** `bad` under the minimum, `warn` over the soft maximum, `ok` inside the band. */
  tone: Tone;
}

// ── The plan ────────────────────────────────────────────────────────────

export interface PlanOrg {
  /** Men on the four full-season clubs' full rosters today. */
  fullSeasonNow: number;
  /** Four times the full-season minimum. */
  fullSeasonMin: number;
  /** Four times the full-season soft maximum. */
  fullSeasonMax: number;
  fortyMan: { count: number; limit: number };
  /** The international complex pool: how full it is and the ages in it. */
  ic: { size: number; max: number; ages: Record<string, number> };
  /** Positions the big club is thinnest at, as `rosterHoles()` names them; the call-up tie-break. */
  mlbThinnest: string[];
}

/** Moves by kind, then the decision roll-up after the overlay. */
export type PlanCounts = Record<MoveKind, number> & {
  /** Folded under the offseason horizon. */
  offseason: number;
  open: number;
  accepted: number;
  dismissed: number;
  /** Accepted and seen done by an import. */
  done: number;
  /**
   * Men the Rule 5 draft could take: `rule5Eligible()` over the same status
   * rows and 40-man the 40-man page reads, so the two pages count the same men.
   */
  rule5Eligible: number;
};

/** One step of the level translation and where the figure came from. */
export interface RungStep {
  /** Points of index lost going up this step (negative). */
  step: number;
  /** OOTP's AVG equivalency in 0.42.0; the save's own pairs from 0.42.1. */
  source: 'mle' | 'save';
  /** Consecutive-season pairs the save step was measured on; null for the MLE table. */
  pairs: number | null;
}

/** The constants the plan was computed with, printed so the MethodNote never drifts from the engine. */
export interface PlanMethod {
  rungStep: { bat: Record<string, RungStep>; pit: Record<string, RungStep> };
  weights: { S: number; P: number; A: number };
  recency: number[];
  prior: { pa: number; ip: number };
  gates: {
    pa: number; ip: number; seasonPa: number; seasonIp: number;
    demotePa: number; demoteIp: number; formPa: number; formIp: number;
  };
  baselines: Record<string, Partial<Record<'pos' | 'sp' | 'rp', { medOa: number | null; medAge: number | null; n: number }>>>;
}

export interface ReleaseOrTradeRow {
  player_id: number;
  name: string;
  assetClass: AssetClass;
  modifiers: AssetModifier[];
  kind: 'trade' | 'release';
  /** 1 is the most actionable: ranked by fit ascending within class. */
  rank: number;
  reasons: string[];
}

/** A man already on his way out: designated for assignment or on waivers. */
export interface LeavingRow {
  player_id: number;
  name: string;
  /** The sentence that says what the export shows ("designated for assignment"). */
  why: string;
}

/** One line of the deadlines strip. */
export interface DeadlineRow {
  date: string;
  what: string;
  player_id: number;
  name: string;
  /** The move it belongs to, when there is one. */
  moveKey: string | null;
}

export interface Plan {
  orgId: number;
  gameDate: string;
  season: number;
  settings: PlannerSettings;
  /** What the export could not support, said plainly. */
  warnings: string[];
  org: PlanOrg;
  levels: PlanLevel[];
  /** After the decision overlay: forced first, then by deadline, then fit. */
  moves: PlanMove[];
  releaseOrTrade: ReleaseOrTradeRow[];
  leaving: LeavingRow[];
  deadlines: DeadlineRow[];
  counts: PlanCounts;
  method: PlanMethod;
  /** Every org man's path, keyed by `player_id`, when asked for with `include=paths` (0.42.1). */
  paths?: Record<string, PlayerPath>;
}

// ── The per-player path (0.42.1) ────────────────────────────────────────

/** One line of production, at its own level and translated to the rung it is judged at. */
export interface ProductionLine {
  year: number;
  rung: RungKey;
  pa: number | null;
  ip: number | null;
  /** The index at its own level, 100 = league average. */
  index: number;
  /** The same line translated to the rung the path is judged at. */
  adjusted: number;
  /** Recency times sample share. */
  weight: number;
}

export interface PathProduction {
  /** The regressed, translated index; null below the readable gate. */
  index: number | null;
  readable: boolean;
  /** The raw three-season window, which the gate reads. */
  windowPa: number;
  windowIp: number;
  lines: ProductionLine[];
  /** This season's verdict and line, as the Prospects page prints them. */
  form: { verdict: string; line: string | null };
}

export interface PathPosition {
  position: number;
  positionName: string;
  /** Whether a change from the listed position is recommended. */
  change: boolean;
  /** The sentence quoting both ratings, both OOTP values and the experience counter. */
  why: string;
}

export interface PathRole {
  /** What `players.role` says ("listed as"). */
  listed: string;
  /** What the ratings say. */
  derived: 'SP' | 'swing' | 'RP' | 'CL';
  change: boolean;
  why: string;
}

/** One season of the rung timeline, past or planned. */
export interface TimelineRow {
  season: number;
  rung: RungKey;
  why: string;
  /** False for a season already played, true for one the plan projects. */
  planned: boolean;
  /** The first MLB season. */
  eta?: boolean;
}

export interface PlayerPath {
  player_id: number;
  name: string;
  age: number;
  positionName: string;
  now: RungKey;
  ceiling: { tier: CeilingTier; label: string; pot: number | null; oa: number | null };
  utility: UtilityClass | null;
  assetClass: AssetClass | null;
  readiness: Readiness;
  production: PathProduction;
  bestPosition: PathPosition | null;
  role: PathRole | null;
  timeline: TimelineRow[];
  /** The first MLB season, or null when the ceiling is below it. */
  eta: number | null;
  /** The season he is last eligible at his rung under its cap. */
  lastEligible: { rung: RungKey; season: number } | null;
  deadlines: Array<{ kind: DeadlineKind; date: string; what: string }>;
  /** Revealed positions with the experience counter read from the position's own column. */
  positions: Array<{ positionName: string; current: number; potential: number; experience: number }>;
  /** The moves in the plan that touch him. */
  moveKeys: string[];
}

// ── Settings ────────────────────────────────────────────────────────────

/** A size band for one club: the minimum is enforced, the maximum only warns. */
export interface RungTargets {
  min: number;
  max: number;
}

export interface PlannerSettings {
  /** Per club: the four full-season clubs share one band; the complex and the DSL have their own. */
  targets: { fullSeason: RungTargets; complex: RungTargets; dsl: RungTargets };
  /**
   * The pro-service ceiling per rung key below MLB; null means uncapped. OOTP
   * does not export its per-league limit, so these ship as its standard table.
   */
  serviceCaps: Record<string, number | null>;
  /** The age OOTP promotes a complex man at; the planner moves him a year earlier. */
  icMaxAge: number;
  /** How many men the international complex pool holds. */
  icSize: number;
}
