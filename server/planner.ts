import { Router } from 'express';
import { db, DATE_KEY, hasColumns, tableColumns, tableExists } from './db.js';
import {
  FORTY_MAN_LIMIT, composites, correspondingMoves, fortyManRoom, onScale, orgPlayers, statKey, type OrgPlayer,
} from './org.js';
import { rosterCrunch } from './rosterops.js';
import {
  POSITION_NAMES, ROLE_CLOSER, ROLE_STARTER, contractsByPlayer, currentGameDate, rosterHoles, scaleGrade,
  seasonYear, valuesByPlayer, type ContractInfo,
} from './valuation.js';
import { seasonFormByClubs, type SeasonForm } from './form.js';
import { healthOf } from './health.js';
import {
  computeBatting, computePitching, leagueBaseline, seedLeagueBaseline, type LeagueBaseline, type RawBatting,
  type RawPitching,
} from './stats.js';
import { REPLACEMENT_PCT, groupOf, mlbPools, valueAt, type Group } from './trade.js';
import {
  minorLeagueFaAfterSeason, optionState, rule5Eligible, rule5ProtectGate, serviceCapState, serviceYearsOf,
  type MinorFaTiming, type OptionState, type ServiceCapState,
} from './rosterRules.js';
import {
  RUNG_KEYS, type AssetClass, type AssetModifier, type CeilingTier, type Deadline, type DeadlineRow,
  type GroupCounts, type Horizon, type LeavingRow, type MoveDecision, type MoveFortyMan, type MoveKind, type Plan, type PlanCounts,
  type PlanLevel, type PlanLevelClub, type PlanMethod, type PlanMove, type PlanRosterRow, type Readiness, type ReleaseOrTradeRow,
  type RungKey, type RungStep, type StaffRow, type StructureGroup, type StructureRow, type Tone,
  type UtilityClass, type Verify,
} from './planTypes.js';
import { onPlannerSettingsChanged, plannerSettings, type PlannerSettings, type RungTargets } from './settings.js';
import {
  decidePlanMove, onPlanDecisionsChanged, planDecisions, reopenPlanMove, retireDismissals, verifyDecisions, type PlanDecision,
  type Standing,
} from './plandecisions.js';
import { currentSaveName, historyDb, leagueGameDate } from './history.js';

/**
 * The Organization Planner: every level of the farm sized and staffed, and
 * the moves that get there, with the reasons written as sentences.
 *
 * Rules first, then readiness. Service caps, the international complex age
 * limit, options, the 40-man and the injured list are checked before anyone
 * is scored, and nothing scored overrides them: a man the cap forces up goes
 * up whatever his line says, and a man who cannot be optioned is a hold card
 * and not a send-down. Readiness is one number per man per rung — scouting
 * against the rung's median man, production over three seasons translated
 * one rung at a time, age against the rung's median — and the balance moves
 * men between rungs by it under the size bands and structure minimums in
 * Settings.
 *
 * Deterministic on purpose: every list is sorted on a total order ending in
 * player_id, every query ends ORDER BY player_id, there is no random number
 * and no wall clock (the game date is the league's own). The same export and
 * the same settings give byte-identical JSON, which is what makes a decision
 * on a move worth remembering across imports — the key is still there next
 * time. The plan is cached per org until the next import or a settings
 * change; decisions are read per request so accepting a move never
 * recomputes the farm.
 */

// ── Constants ───────────────────────────────────────────────────────────

/** The rungs production is translated along; the complex pool has no lines. */
const LADDER: readonly RungKey[] = ['mlb', 'aaa', 'aa', 'high-a', 'single-a', 'complex', 'dsl'];
const FULL_SEASON: readonly RungKey[] = ['aaa', 'aa', 'high-a', 'single-a'];

/** The tag the page prints on a level. */
const LEVEL_TAG: Record<RungKey, string> = {
  mlb: 'MLB', aaa: 'AAA', aa: 'AA', 'high-a': 'High-A', 'single-a': 'Single-A', complex: 'Complex', dsl: 'DSL', ic: 'IC',
};
/** "at X": where a man plays, in a sentence. */
const LEVEL_AT: Record<RungKey, string> = {
  mlb: 'the majors', aaa: 'Triple-A', aa: 'Double-A', 'high-a': 'High-A', 'single-a': 'Single-A',
  complex: 'the Complex', dsl: 'the DSL', ic: 'the international complex',
};
/** "the X cap", "the X median": the level as an adjective. */
const LEVEL_ADJ: Record<RungKey, string> = {
  mlb: 'major-league', aaa: 'Triple-A', aa: 'Double-A', 'high-a': 'High-A', 'single-a': 'Single-A',
  complex: 'Complex', dsl: 'DSL', ic: 'complex-pool',
};

/** How readiness is blended, printed in `method` so the page's note cannot drift from the engine. */
const WEIGHTS = { S: 0.5, P: 0.3, A: 0.2 };
const RECENCY = [1, 0.6, 0.3];
/** The regression prior: 150 PA or 40 IP of league-average production at full recency. */
const PRIOR = { pa: 150, ip: 40 };
const PRIOR_WEIGHT = 1 / 3;
const GATES = { pa: 150, ip: 40, seasonPa: 60, seasonIp: 15, demotePa: 100, demoteIp: 30, formPa: 100, formIp: 20 };
/** A full sample for the recency weight: a season of plate appearances, a starter's or a reliever's innings. */
const SAMPLE = { pa: 450, ipStarter: 120, ipReliever: 60 };
const INDEX_CAP = 250;
/** One unit of each z: five grades of scouting, fifteen points of index, two years of age. */
const Z_GRADES = 5;
const Z_INDEX = 15;
const Z_YEARS = 2;

const PROMOTE_FIT = 0;
const STRONG_FIT = 0.5;
const OVERMATCHED_FIT = -1;
/** A production index that says a man is ready on its own, with the window it needs. */
const READY_INDEX = 115;
const READY_WINDOW = { pa: 250, ip: 60 };

/** A man covers a position at this (20-80) rating, today: the structure cover checks and the field check read it. */
const COVER_RATING = 40;
/** Where a glove counts toward the utility class when its ceiling is this high, whatever it is today. */
const COVER_CEILING = 50;

/** The asset-class cut-offs (20-80) and the age rules. */
const CORE_POT = 55;
const CORE_OA = 50;
const CORE_AGE = 30;
const PROSPECT_POT = 45;
const PROSPECT_UPSIDE = 8;
const DEPTH_MARGIN = 3;
const SURPLUS_YEARS_OLD = 6;
const SURPLUS_YEARS_OLD_COMPLEX = 3;
/** Ceiling tiers from POT (20-80). */
const TIER = { regular: 50, bench: 45, depth: 40 };

/** Pitching role classes from the ratings, never from `players.role`. */
const SP_STAMINA = 50;
const SWING_STAMINA = 45;
const PITCH_RATED = 40;
const SP_PITCHES = 3;
const SPECIALIST_GAP = 10;
/** A reliever within this many grades of the best one can be the closer; stuff and hold then decide. */
const CLOSER_WINDOW = 5;
const ROTATION_UPPER = 5;
const ROTATION_LOWER = 6;

/** A rung's group needs this many men for its own median; fewer borrows the nearest rung's. */
const BASELINE_SAMPLE = 30;
const SIXTY_DAY_IL = 60;
const BIRTHDAY_WINDOW_DAYS = 365;
const MAX_ROUNDS = 3;

/** The eight positions, hardest first, which the field check mans in this order. */
const FIELD: readonly number[] = [2, 6, 8, 5, 4, 9, 7, 3];
/**
 * The positions a need note can name when nobody covers them. Catcher,
 * shortstop and centre field are not among them: their structure groups
 * (C, SS cover, CF cover) already say whether the level has enough of them.
 */
const NOTED_POSITIONS: readonly number[] = [5, 4, 9, 7, 3];
/** The man who plays each noted position, for a note that asks for one: "Sign a second baseman". */
const POSITION_PLAYER: Record<number, string> = {
  3: 'first baseman', 4: 'second baseman', 5: 'third baseman', 7: 'left fielder', 9: 'right fielder',
};

type CountGroup = 'C' | 'IF' | 'OF' | 'SP' | 'RP';
const COUNT_GROUPS: readonly CountGroup[] = ['C', 'IF', 'OF', 'SP', 'RP'];
const STRUCTURE_GROUPS: readonly StructureGroup[] = ['C', 'IF', 'OF', 'SP', 'RP', 'SS cover', 'CF cover'];

interface StructureBand { min: Record<StructureGroup, number>; max: Record<CountGroup, number> }

/**
 * What a rung needs to play a season. Full-season clubs: two catchers, six
 * infielders with shortstop cover, five outfielders with centre-field cover,
 * five starters and seven relievers; the complex rungs carry more of
 * everything. Minimums are hard, maxima soft. Editable in a later release.
 */
const STRUCTURE: Record<'fullSeason' | 'complex', StructureBand> = {
  fullSeason: {
    min: { C: 2, IF: 6, OF: 5, SP: 5, RP: 7, 'SS cover': 1, 'CF cover': 1 },
    max: { C: 3, IF: 8, OF: 6, SP: 6, RP: 9 },
  },
  complex: {
    min: { C: 3, IF: 8, OF: 6, SP: 6, RP: 9, 'SS cover': 1, 'CF cover': 1 },
    max: { C: 4, IF: 10, OF: 8, SP: 8, RP: 14 },
  },
};

const GROUP_WORD: Record<StructureGroup, { one: string; many: string }> = {
  C: { one: 'catcher', many: 'catchers' },
  IF: { one: 'infielder', many: 'infielders' },
  OF: { one: 'outfielder', many: 'outfielders' },
  SP: { one: 'starter', many: 'starters' },
  RP: { one: 'reliever', many: 'relievers' },
  'SS cover': { one: 'man who can play shortstop', many: 'men who can play shortstop' },
  'CF cover': { one: 'man who can play centre field', many: 'men who can play centre field' },
};

/** The order kinds are listed in; forced moves come before all of them. */
const KIND_ORDER: readonly MoveKind[] = [
  'forced', 'callup', 'senddown', 'protect', 'promote', 'cover', 'demote', 'assign', 'il60', 'position', 'role',
  'trade', 'release', 'hold',
];

/** The team id the complex pool is planned under: it has no club. */
const IC_TEAM = -1;

// ── Dates ───────────────────────────────────────────────────────────────

interface Ymd { y: number; m: number; d: number }

/** OOTP writes dates unpadded; this reads either form and refuses anything else. */
function parseDate(raw: unknown): Ymd | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(raw ?? '').trim());
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}
const fmtDate = (d: Ymd): string => `${d.y}-${d.m}-${d.d}`;
const utc = (d: Ymd): number => Date.UTC(d.y, d.m - 1, d.d);
const fromUtc = (ms: number): Ymd => {
  const t = new Date(ms);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const daysBetween = (from: Ymd, to: Ymd): number => Math.round((utc(to) - utc(from)) / 86_400_000);
const addDays = (d: Ymd, n: number): Ymd => fromUtc(utc(d) + n * 86_400_000);
const addYears = (d: Ymd, n: number): Ymd => ({ ...d, y: d.y + n });
const dateKey = (d: Ymd): number => d.y * 10000 + d.m * 100 + d.d;

// ── Words ───────────────────────────────────────────────────────────────

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const word = (n: number): string => WORDS[Math.abs(Math.round(n))] ?? String(Math.abs(Math.round(n)));
const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);
/** "one step up", "two steps up": how far past the next rung the cap sends a man. */
const stepsUp = (n: number): string => `${word(n)} ${plural(n, 'step')} up`;
const ordinal = (n: number): string => {
  const names = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
  if (names[n]) return names[n];
  const lastTwo = n % 100;
  return `${n}${lastTwo >= 11 && lastTwo <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`;
};
const money = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;
/** A grade as the save shows it: whole on 20-80, one decimal on a scale that needs it. */
const grade = (v: number | null): string => (v === null ? '—' : Number.isInteger(v) ? String(v) : v.toFixed(1));
const fit2 = (v: number | null): number | null => (v === null ? null : Math.round(v * 100) / 100);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const listOf = (parts: string[]): string =>
  parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
const capitalise = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
/**
 * A full stop and a capital: the end of a sentence, but never an initial or
 * an abbreviation. A capital before the stop ends a sentence when something
 * other than a space or another stop comes before it: a level
 * ("Double-A."), a position ("2B.", "SS.") or a code ("IL."). A capital
 * standing alone is an initial, as in "A. J. Smith", "A.J. Smith" or "Luis
 * C. Gonzalez", so a lone "C." never splits; no card reason ends on the
 * catcher's code, so nothing is lost by it. "St.", "Jr." and the like never
 * end a sentence either: they sit inside club names ("St. Lucie Mets") and
 * players' names ("Austin St. Laurent", "Ken Griffey Jr.").
 */
const SENTENCE_END = /(?<=(?:[^\sA-Z]|[^\s.][A-Z])\.)(?<!\b(?:St|Ste|Mt|Ft|Jr|Sr)\.)\s+(?=[A-Z])/;
/** Stands in for the space after a stop inside a name while a reason is split. */
const HELD_SPACE = '\u0000';
/**
 * A reason split into its sentences, trimmed. `whole` names text never to
 * split, whatever its stops look like: the names on the card that carry a
 * stop the pattern cannot tell from a sentence end ("Luis Al. Pena").
 */
export const sentencesOf = (s: string, whole: readonly string[] = []): string[] => {
  let text = s;
  for (const w of whole) if (text.includes(w)) text = text.split(w).join(w.replace(/\.\s+/g, `.${HELD_SPACE}`));
  return text.split(SENTENCE_END).map((x) => x.split(HELD_SPACE).join(' ').trim()).filter(Boolean);
};
const article = (noun: string): string => (/^[aeiou]/i.test(noun) ? 'an' : 'a');

// ── Scoring, as pure functions ──────────────────────────────────────────
//
// The engine's arithmetic lives here, outside buildPlan, so a test can hold
// each rule to the design's numbers without seeding a league: the closures
// inside the engine delegate to these and add nothing of their own.

export type RoleClass = 'SP' | 'swing' | 'RP';

/** One line's weight: recency (1.0 / 0.6 / 0.3 for this season and the two before) times its share of a full sample. */
export function lineWeight(year: number, season: number, sample: number, full: number): number {
  return ((RECENCY[season - year] ?? 0) * Math.min(sample, full)) / full;
}

/** Whether the raw three-season window is big enough for the index to be quoted at all. */
export function productionReadable(windowPa: number, windowIp: number, isPitcher: boolean): boolean {
  return isPitcher ? windowIp >= GATES.ip : windowPa >= GATES.pa;
}

/** A line as the blend reads it: its index at its own level, where it was made, and its weight. */
export interface IndexLine { idx: number; rung: RungKey; weight: number }
/** An index at one rung, stated in another's terms. */
export type Translate = (idx: number, from: RungKey, to: RungKey) => number;

/**
 * The production index at a rung: every line translated there, weighted, and
 * regressed to 100 on a prior worth a third of a full sample — so a man with
 * no lines at all reads exactly 100, and a short one reads near it.
 */
export function blendProduction(lines: readonly IndexLine[], at: RungKey, translate: Translate): number {
  let sum = 100 * PRIOR_WEIGHT;
  let w = PRIOR_WEIGHT;
  for (const l of lines) {
    sum += l.weight * translate(l.idx, l.rung, at);
    w += l.weight;
  }
  return sum / w;
}

/**
 * The level translation from OOTP's own AVG equivalencies: each step up costs
 * `100 × (mle(lower) / mle(upper) − 1)` points of index (negative), applied
 * one rung at a time over the rungs the save knows a factor for, and the same
 * steps are given back going down. `rungStep` is what `method` prints.
 */
export function mleTranslator(mle: ReadonlyMap<RungKey, number>): { translate: Translate; rungStep: Record<string, RungStep> } {
  const present = LADDER.filter((k) => mle.has(k));
  const stepUp = (lower: RungKey, upper: RungKey): number => 100 * (mle.get(lower)! / mle.get(upper)! - 1);
  const translate: Translate = (idx, from, to) => {
    const a = present.indexOf(from);
    const b = present.indexOf(to);
    if (a === -1 || b === -1 || a === b) return idx;
    let out = idx;
    if (a > b) for (let i = a; i > b; i--) out += stepUp(present[i], present[i - 1]);
    else for (let i = a; i < b; i++) out -= stepUp(present[i + 1], present[i]);
    return out;
  };
  const rungStep: Record<string, RungStep> = {};
  for (let i = present.length - 1; i > 0; i--) {
    rungStep[`${present[i]}>${present[i - 1]}`] = { step: Math.round(stepUp(present[i], present[i - 1]) * 10) / 10, source: 'mle', pairs: null };
  }
  return { translate, rungStep };
}

/**
 * Readiness from its three terms: scouting against the rung's median (z_S),
 * the production index at the rung (as z_P, fifteen points to the unit) and
 * age against the rung's median (z_A). 0.5 / 0.3 / 0.2 with all three; the
 * weight of a missing term goes to the others (0.7 / 0.3 without production,
 * 0.6 / 0.4 without scouting); nothing to score on gives null, and a missing
 * age reads as the median.
 */
export function fitOf(zS: number | null, index: number | null, zA: number | null): number | null {
  const a = zA ?? 0;
  const zp = index === null ? null : clamp((index - 100) / Z_INDEX, -3, 3);
  if (zS !== null && zp !== null) return WEIGHTS.S * zS + WEIGHTS.P * zp + WEIGHTS.A * a;
  if (zS !== null) return 0.7 * zS + 0.3 * a;
  if (zp !== null) return 0.6 * zp + 0.4 * a;
  return null;
}

/** The season verdict that blocks a promotion: poor, on a sample worth reading. */
export const formBlocksPromote = (form: SeasonForm | null | undefined): boolean =>
  form?.verdict === 'poor' && form.meaningful;
/** The season verdict that blocks a demotion: good, on a sample worth reading. */
export const formBlocksDemote = (form: SeasonForm | null | undefined): boolean =>
  form?.verdict === 'good' && form.meaningful;

/** How many of the twelve pitches are rated 40 or better; null when the export has no pitch ratings. */
export function ratedPitches(ratings: ReadonlyArray<number | null | undefined>): number {
  return ratings.filter((r) => (r ?? 0) >= scaleGrade(PITCH_RATED)).length;
}

/**
 * The role class from the ratings, never from `players.role`: a starter has
 * the stamina (50) and three rated pitches; a swing man the stamina of a
 * starter short of that (45-49) with the pitches, or the stamina with exactly
 * two; a reliever is everything else. At the complex rungs stamina alone
 * makes a starter, since the third pitch is what the complex exists to
 * teach.
 *
 * The swing cell is the matrix's own boundary: stamina within the five points
 * between the swing cut and the starter's cut, or a starter's stamina one
 * pitch short of the three. Everywhere else the ratings decide.
 *
 * OOTP's SP and RP values never decide a class the ratings settle: every
 * pitcher's SP value exceeds his RP value because it bakes in innings. They
 * are a tie-break only, where the ratings cannot say. `lean` is which of the
 * org's starters and relievers his SP/RP ratio sits nearer (`ratioLean`): in
 * the swing cell it makes him a starter or a reliever outright, and a null
 * pitch count (no pitch ratings in the export) is taken as enough unless it
 * says he is a reliever. With no lean he stays a swing man.
 */
export function pitchRole(
  stamina: number | null, pitches: number | null, atComplex: boolean, lean: 'SP' | 'RP' | null = null
): RoleClass {
  const enough = atComplex ? true : pitches === null ? lean !== 'RP' : pitches >= SP_PITCHES;
  const two = pitches === 2;
  if (stamina !== null && stamina >= scaleGrade(SP_STAMINA) && enough) return 'SP';
  if (stamina !== null && stamina >= scaleGrade(SWING_STAMINA) && (enough || two)) return lean ?? 'swing';
  return 'RP';
}

/** Whether the ratings alone leave him in the swing cell, where the SP/RP value breaks the tie. */
export function inSwingBand(stamina: number | null, pitches: number | null, atComplex: boolean): boolean {
  return pitchRole(stamina, pitches, atComplex) === 'swing';
}

/**
 * The SP/RP value tie-break: whether his ratio of OOTP's SP value to its RP
 * value sits nearer the median ratio of the org's starters or of its
 * relievers, each median taken over the arms the ratings class without help.
 * Null when a figure is missing or he sits as near one as the other.
 */
export function ratioLean(ratio: number | null, spMedian: number | null, rpMedian: number | null): 'SP' | 'RP' | null {
  if (ratio === null || spMedian === null || rpMedian === null || !Number.isFinite(ratio)) return null;
  const toSp = Math.abs(ratio - spMedian);
  const toRp = Math.abs(ratio - rpMedian);
  return toSp < toRp ? 'SP' : toRp < toSp ? 'RP' : null;
}

/** The specialist tag: ten grades between his stuff against the two sides. */
export function specialistOf(vsl: number | null | undefined, vsr: number | null | undefined): 'vs L' | 'vs R' | null {
  if (typeof vsl !== 'number' || typeof vsr !== 'number' || Math.abs(vsl - vsr) < scaleGrade(SPECIALIST_GAP)) return null;
  return vsl > vsr ? 'vs L' : 'vs R';
}

/**
 * What jobs a position player can hold, from the positions he covers:
 * `super` covers two infield and two outfield spots, `C` catches, `IF` and
 * `OF` cover two of their own, `bat-only` covers first base and nothing else
 * (whatever he is listed at), `everyday` is one spot. A man who covers no
 * position at all is `bat-only` when he is listed at first or DH, the design's
 * "only 3 and/or 10" — the DH is no fielding position, so `covers` never holds
 * it — and `everyday` otherwise.
 */
export function utilityClassOf(covers: ReadonlySet<number>, position: number): UtilityClass {
  const ifs = [4, 5, 6].filter((x) => covers.has(x)).length;
  const ofs = [7, 8, 9].filter((x) => covers.has(x)).length;
  const batOnly = covers.size > 0 ? [...covers].every((x) => x === 3) : position === 3 || position === 10;
  return ifs >= 2 && ofs >= 2 ? 'super' : covers.has(2) ? 'C' : ifs >= 2 ? 'IF' : ofs >= 2 ? 'OF' : batOnly ? 'bat-only' : 'everyday';
}

/** The ceiling tier from POT: regular at 50, bench at 45, depth at 40, filler below, on the save's scale. */
export function ceilingTierOf(pot: number | null): CeilingTier | null {
  return pot === null ? null
    : pot >= scaleGrade(TIER.regular) ? 'regular'
    : pot >= scaleGrade(TIER.bench) ? 'bench'
    : pot >= scaleGrade(TIER.depth) ? 'depth'
    : 'filler';
}

export interface AssetFacts {
  oa: number;
  pot: number;
  age: number;
  /** Age against the rung's median, as fitOf reads it; null reads as the median. */
  zA: number | null;
  /** The rung's median grade for his group and its median age; null when unknown. */
  medOa: number | null;
  medAge: number | null;
  /** At the complex or the DSL, where three years over the median age is old. */
  atComplex: boolean;
  /** An SP-class arm at Double-A or above, which is depth whatever his grade. */
  spArmUpper: boolean;
}

/**
 * The release/trade class: `core` at a 55 ceiling or a 50 now by thirty,
 * `prospect` at a 45 ceiling with eight points of upside and not old for the
 * level, `surplus` when old for the level with no growth (six years over the
 * median age with a ceiling no better than the median grade; three years at
 * the complex), `depth` within three of the median grade or an upper-level
 * starter, `surplus` otherwise.
 */
export function assetClassOf(f: AssetFacts): AssetClass {
  const upside = f.pot - f.oa;
  const za = f.zA ?? 0;
  const oldForLevel = f.medAge !== null && (
    (f.age >= f.medAge + SURPLUS_YEARS_OLD && f.medOa !== null && f.pot <= f.medOa) ||
    (f.atComplex && f.age >= f.medAge + SURPLUS_YEARS_OLD_COMPLEX)
  );
  if (f.pot >= scaleGrade(CORE_POT) || (f.oa >= scaleGrade(CORE_OA) && f.age <= CORE_AGE)) return 'core';
  if (f.pot >= scaleGrade(PROSPECT_POT) && upside >= onScale(PROSPECT_UPSIDE) && za >= 0) return 'prospect';
  if (oldForLevel) return 'surplus';
  if ((f.medOa !== null && f.oa >= f.medOa - onScale(DEPTH_MARGIN)) || f.spArmUpper) return 'depth';
  return 'surplus';
}

// ── The ladder ──────────────────────────────────────────────────────────

interface LeagueRung {
  key: RungKey;
  name: string;
  level: number;
  reputation: number | null;
  /** OOTP's AVG equivalency, which translates production between rungs. */
  mle: number | null;
  startDate: string | null;
}

/**
 * Which rung every league in the save belongs to.
 *
 * `teams.level` cannot separate High-A from Single-A (both 4) or the complex
 * league from the DSL (both 6); `leagues.reputation` can — 10 for the majors
 * down to 4 for the DSL. Within each level the leagues are ranked by
 * reputation and the keys handed out from the top, so an org's clubs, the
 * league-wide medians and a man's old lines in some other org's affiliate
 * all read the same ladder. Without the reputation column the level alone
 * is used, what it cannot tell apart is merged, and the warning says so.
 */
function leagueRungMap(): { leagues: Map<number, LeagueRung>; warnings: string[] } {
  const warnings: string[] = [];
  const hasRep = hasColumns('leagues', 'reputation');
  const hasMle = hasColumns('leagues', 'ml_equivalencies_avg');
  const hasStart = hasColumns('leagues', 'start_date');
  const rows = db
    .prepare(
      `SELECT l.league_id, l.name, ${hasRep ? 'l.reputation' : 'NULL'} AS reputation,
              ${hasMle ? 'l.ml_equivalencies_avg' : 'NULL'} AS mle, ${hasStart ? 'l.start_date' : 'NULL'} AS start,
              MIN(t.level) AS level
       FROM leagues l JOIN teams t ON t.league_id = l.league_id
       WHERE ${hasColumns('teams', 'allstar_team') ? 't.allstar_team = 0' : '1 = 1'}
       GROUP BY l.league_id ORDER BY l.league_id`
    )
    .all() as Array<{ league_id: number; name: string; reputation: number | null; mle: number | null; start: string | null; level: number | null }>;
  if (!hasRep) {
    warnings.push(
      'leagues.reputation is not in this export, so the ladder is read from teams.level alone: High-A and Single-A, and the complex league and the DSL, cannot be told apart and are merged.'
    );
  }
  const leagues = new Map<number, LeagueRung>();
  const put = (r: (typeof rows)[number], key: RungKey) =>
    leagues.set(r.league_id, {
      key, name: r.name, level: r.level ?? 0, reputation: typeof r.reputation === 'number' ? r.reputation : null,
      mle: typeof r.mle === 'number' && r.mle > 0 ? r.mle : null, startDate: r.start,
    });
  const byRep = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
    (b.reputation ?? 0) - (a.reputation ?? 0) || (a.level ?? 0) - (b.level ?? 0) || a.league_id - b.league_id;
  const aBucket = rows.filter((r) => r.level === 4 || r.level === 5).sort(byRep);
  const complexBucket = rows.filter((r) => (r.level ?? 0) >= 6).sort(byRep);
  for (const r of rows) {
    if (r.level === 1 || r.level === 0) put(r, 'mlb');
    else if (r.level === 2) put(r, 'aaa');
    else if (r.level === 3) put(r, 'aa');
  }
  // Class A: the better-reputed league is High-A; with one league, or no
  // reputation to rank by, it is Single-A, which is what the cap table assumes
  const aReps = [...new Set(aBucket.map((r) => r.reputation))].filter((v): v is number => v !== null);
  for (const r of aBucket) {
    if (hasRep && aReps.length >= 2) put(r, r.reputation === aReps[0] ? 'high-a' : 'single-a');
    else if (!hasRep && aBucket.some((o) => o.level === 5)) put(r, r.level === 4 ? 'high-a' : 'single-a');
    else put(r, 'single-a');
  }
  const cReps = [...new Set(complexBucket.map((r) => r.reputation))].filter((v): v is number => v !== null);
  for (const r of complexBucket) {
    if (hasRep && cReps.length >= 2) put(r, r.reputation === cReps[0] ? 'complex' : 'dsl');
    else put(r, /dominican|dsl|venezuel/i.test(r.name) ? 'dsl' : 'complex');
  }
  return { leagues, warnings };
}

export interface RungClub {
  team_id: number;
  label: string;
  league_id: number;
  level: number;
}

export interface Rung {
  key: RungKey;
  rank: number;
  label: string;
  levelName: string;
  clubs: RungClub[];
  leagueId: number | null;
  level: number | null;
  mle: number | null;
  cap: number | null;
  target: RungTargets | null;
  structure: StructureBand | null;
}

/**
 * The org's ladder, top to bottom: one rung per reputation among its clubs,
 * two clubs sharing one where they share a league, and the complex pool
 * appended last. Null when the org has no major-league club of its own.
 */
export function rungs(
  orgId: number, settings: PlannerSettings = plannerSettings()
): { rungs: Rung[]; warnings: string[]; leagues: Map<number, LeagueRung> } | null {
  if (!tableExists('teams') || !tableExists('leagues')) return null;
  const { leagues, warnings } = leagueRungMap();
  const clubs = db
    .prepare(
      `SELECT team_id, name, nickname, level, league_id FROM teams
       WHERE (team_id = ? OR parent_team_id = ?)${hasColumns('teams', 'allstar_team') ? ' AND allstar_team = 0' : ''}
       ORDER BY level, team_id`
    )
    .all(orgId, orgId) as Array<{ team_id: number; name: string; nickname: string; level: number; league_id: number }>;
  const top = clubs.find((c) => c.team_id === orgId);
  if (!top) return null;

  const byKey = new Map<RungKey, RungClub[]>();
  for (const c of clubs) {
    const key: RungKey | undefined = c.team_id === orgId ? 'mlb' : leagues.get(c.league_id)?.key;
    const label = c.name === c.nickname ? c.name : `${c.name} ${c.nickname}`;
    if (!key || (key === 'mlb' && c.team_id !== orgId)) {
      warnings.push(`${label} (team ${c.team_id}) could not be placed on the ladder and is left out of the plan.`);
      continue;
    }
    byKey.set(key, [...(byKey.get(key) ?? []), { team_id: c.team_id, label, league_id: c.league_id, level: c.level }]);
  }
  const bandOf = (key: RungKey): RungTargets | null =>
    FULL_SEASON.includes(key) ? settings.targets.fullSeason
    : key === 'complex' ? settings.targets.complex
    : key === 'dsl' ? settings.targets.dsl
    : null;
  const out: Rung[] = [];
  for (const key of RUNG_KEYS) {
    const members = byKey.get(key);
    if (key === 'ic') {
      out.push({
        key, rank: out.length + 1, label: 'International complex', levelName: LEVEL_TAG.ic, clubs: [],
        leagueId: null, level: null, mle: null, cap: null, target: null, structure: null,
      });
      continue;
    }
    if (!members) continue;
    const league = leagues.get(members[0].league_id);
    out.push({
      key,
      rank: out.length + 1,
      label: members.map((m) => m.label).join(' / '),
      levelName: LEVEL_TAG[key],
      clubs: members,
      leagueId: members[0].league_id,
      level: members[0].level,
      mle: key === 'mlb' ? 1 : league?.mle ?? null,
      cap: key === 'mlb' ? null : settings.serviceCaps[key] ?? null,
      target: bandOf(key),
      structure: FULL_SEASON.includes(key) ? STRUCTURE.fullSeason : key === 'complex' || key === 'dsl' ? STRUCTURE.complex : null,
    });
  }
  return { rungs: out, warnings, leagues };
}

// ── Baselines ───────────────────────────────────────────────────────────

interface RungBaseline {
  medAge: number | null;
  medOa: Record<Group, number | null>;
  n: Record<Group, number>;
  /** The rung a group's median was borrowed from, when its own sample was thin. */
  borrowed: Partial<Record<Group, RungKey>>;
}

let rungBaselineCache: Record<RungKey, RungBaseline> | null = null;

/**
 * The median man at every rung, league-wide: his age, and OOTP's Overall by
 * group (position players, starters, relievers). Readiness is measured
 * against these rather than against fixed grades, so a save that grades
 * harder or softer than this one judges its men at the same share of its
 * own level. Healthy men only (list 2, or list 1 less list 4 where a club
 * exports no list 2), because the injured list is not the level's standard.
 * Cached per import.
 */
function rungBaselines(leagues: Map<number, LeagueRung>): Record<RungKey, RungBaseline> {
  if (rungBaselineCache) return rungBaselineCache;
  const empty = (): RungBaseline => ({
    medAge: null, medOa: { pos: null, sp: null, rp: null }, n: { pos: 0, sp: 0, rp: 0 }, borrowed: {},
  });
  const out = Object.fromEntries(RUNG_KEYS.map((k) => [k, empty()])) as Record<RungKey, RungBaseline>;
  const ages = Object.fromEntries(RUNG_KEYS.map((k) => [k, [] as number[]])) as unknown as Record<RungKey, number[]>;
  const grades = Object.fromEntries(
    RUNG_KEYS.map((k) => [k, { pos: [] as number[], sp: [] as number[], rp: [] as number[] }])
  ) as unknown as Record<RungKey, Record<Group, number[]>>;

  if (tableExists('team_roster') && tableExists('teams') && tableExists('players')) {
    const valueCols = tableColumns('players_value');
    const oa = valueCols.includes('oa') ? 'v.oa' : valueCols.includes('oa_rating') ? 'v.oa_rating' : 'NULL';
    const rows = db
      .prepare(
        `SELECT r.team_id, r.list_id, p.player_id, p.age, p.position, p.role, t.league_id, t.level, ${oa} AS oa
         FROM team_roster r
         JOIN players p ON p.player_id = r.player_id
         JOIN teams t ON t.team_id = r.team_id
         ${valueCols.length ? 'LEFT JOIN players_value v ON v.player_id = p.player_id' : ''}
         WHERE r.list_id IN (1, 2, 4) AND p.retired = 0
           ${hasColumns('teams', 'allstar_team') ? 'AND t.allstar_team = 0' : ''}
         ORDER BY r.team_id, p.player_id, r.list_id`
      )
      .all() as Array<{ team_id: number; list_id: number; player_id: number; age: number; position: number; role: number; league_id: number; level: number; oa: number | null }>;
    const byTeam = new Map<number, { hasList2: boolean; men: Map<number, { lists: Set<number>; row: (typeof rows)[number] }> }>();
    for (const r of rows) {
      const team = byTeam.get(r.team_id) ?? { hasList2: false, men: new Map() };
      if (r.list_id === 2) team.hasList2 = true;
      const man = team.men.get(r.player_id) ?? { lists: new Set<number>(), row: r };
      man.lists.add(r.list_id);
      team.men.set(r.player_id, man);
      byTeam.set(r.team_id, team);
    }
    for (const [, team] of byTeam) {
      for (const [, man] of team.men) {
        const healthy = team.hasList2 ? man.lists.has(2) : man.lists.has(1) && !man.lists.has(4);
        if (!healthy) continue;
        const key: RungKey | undefined = man.row.level === 1 ? 'mlb' : leagues.get(man.row.league_id)?.key;
        if (!key) continue;
        ages[key].push(man.row.age);
        if (typeof man.row.oa === 'number') grades[key][groupOf(man.row.position, man.row.role)].push(man.row.oa);
      }
    }
  }
  if (hasColumns('players', 'league_id')) {
    const valueCols = tableColumns('players_value');
    const oa = valueCols.includes('oa') ? 'v.oa' : valueCols.includes('oa_rating') ? 'v.oa_rating' : 'NULL';
    const pool = db
      .prepare(
        `SELECT p.age, p.position, p.role, ${oa} AS oa FROM players p
         ${valueCols.length ? 'LEFT JOIN players_value v ON v.player_id = p.player_id' : ''}
         WHERE p.league_id < 0 AND p.retired = 0 AND p.team_id > 0
           AND NOT EXISTS (SELECT 1 FROM team_roster r WHERE r.player_id = p.player_id)
         ORDER BY p.player_id`
      )
      .all() as Array<{ age: number; position: number; role: number; oa: number | null }>;
    for (const r of pool) {
      ages.ic.push(r.age);
      if (typeof r.oa === 'number') grades.ic[groupOf(r.position, r.role)].push(r.oa);
    }
  }
  for (const key of RUNG_KEYS) {
    out[key].medAge = median(ages[key]);
    for (const g of ['pos', 'sp', 'rp'] as const) {
      out[key].n[g] = grades[key][g].length;
      out[key].medOa[g] = grades[key][g].length >= BASELINE_SAMPLE ? median(grades[key][g]) : null;
    }
  }
  /*
   * A thin group borrows the neighbouring rung's median, the one above first.
   * Only a neighbour: a walk further would hand Triple-A the DSL's median on
   * a small league (every rung thin but the bottom one), and a Triple-A man
   * graded 44 then reads "20 above the median" — the thin median of his own
   * rung is nearer the truth than any far rung's.
   */
  for (const [i, key] of RUNG_KEYS.entries()) {
    for (const g of ['pos', 'sp', 'rp'] as const) {
      if (out[key].medOa[g] !== null) continue;
      const donor = [RUNG_KEYS[i - 1], RUNG_KEYS[i + 1]]
        .filter((k): k is RungKey => !!k)
        .find((k) => grades[k][g].length >= BASELINE_SAMPLE);
      if (donor) {
        out[key].medOa[g] = median(grades[donor][g]);
        out[key].borrowed[g] = donor;
      }
      // Nothing beside it reaches the sample: the thin median is better than none
      if (out[key].medOa[g] === null && grades[key][g].length > 0) out[key].medOa[g] = median(grades[key][g]);
    }
  }
  rungBaselineCache = out;
  return out;
}

// ── Loads ───────────────────────────────────────────────────────────────

interface StatusRow {
  player_id: number;
  is_active: number | null; is_on_secondary: number | null; is_on_dl: number | null; is_on_dl60: number | null;
  options_used: number | null; options_used_this_year: number | null;
  years_protected_from_rule_5: number | null; pro_service_years: number | null;
  mlb_service_years: number | null; mlb_service_days: number | null;
  designated_for_assignment: number | null; days_on_dfa_left: number | null;
  is_on_waivers: number | null; days_on_waivers_left: number | null;
  injury_is_injured: number | null; injury_dtd_injury: number | null; injury_left: number | null;
}

const STATUS_COLUMNS = [
  'is_active', 'is_on_secondary', 'is_on_dl', 'is_on_dl60', 'options_used', 'options_used_this_year',
  'years_protected_from_rule_5', 'pro_service_years', 'mlb_service_years', 'mlb_service_days',
  'designated_for_assignment', 'days_on_dfa_left', 'is_on_waivers', 'days_on_waivers_left',
];
const INJURY_COLUMNS = ['injury_is_injured', 'injury_dtd_injury', 'injury_left'];

/** Roster status and the injury fields for the org, each column guarded: an older export loses that reading only. */
/**
 * The org's men as an IN list. `players` carries no organization index on a
 * real save (135,602 rows, about 90 ms a scan), so every per-org read goes
 * through the ids orgPlayers() already paid for and the player_id index each
 * table has, at a few milliseconds instead of a scan apiece.
 */
const marks = (ids: number[]): string => ids.map(() => '?').join(', ');

function loadStatus(ids: number[]): Map<number, StatusRow> {
  if (ids.length === 0) return new Map();
  const have = new Set(tableColumns('players_roster_status'));
  const havePlayers = new Set(tableColumns('players'));
  const join = have.size ? 'LEFT JOIN players_roster_status rs ON rs.player_id = p.player_id' : '';
  const cols = [
    ...STATUS_COLUMNS.map((c) => (have.has(c) ? `rs.${c}` : `NULL AS ${c}`)),
    ...INJURY_COLUMNS.map((c) => (havePlayers.has(c) ? `p.${c}` : `NULL AS ${c}`)),
  ];
  const rows = db
    .prepare(
      `SELECT p.player_id, ${cols.join(', ')} FROM players p ${join}
       WHERE p.player_id IN (${marks(ids)}) ORDER BY p.player_id`
    )
    .all(...ids) as StatusRow[];
  return new Map(rows.map((r) => [r.player_id, r]));
}

/** Who is on which list of which club: 1 full, 2 active, 3 the 40-man, 4 the injured list. */
function loadLists(teamIds: number[]): { lists: Map<number, Map<number, Set<number>>>; hasList2: Set<number>; hasList4: Set<number> } {
  const lists = new Map<number, Map<number, Set<number>>>();
  const hasList2 = new Set<number>();
  const hasList4 = new Set<number>();
  if (!tableExists('team_roster') || teamIds.length === 0) return { lists, hasList2, hasList4 };
  const rows = db
    .prepare(
      `SELECT team_id, player_id, list_id FROM team_roster WHERE team_id IN (${teamIds.map(() => '?').join(', ')})
       ORDER BY player_id, team_id, list_id`
    )
    .all(...teamIds) as Array<{ team_id: number; player_id: number; list_id: number }>;
  for (const r of rows) {
    const byTeam = lists.get(r.player_id) ?? new Map<number, Set<number>>();
    const set = byTeam.get(r.team_id) ?? new Set<number>();
    set.add(r.list_id);
    byTeam.set(r.team_id, set);
    lists.set(r.player_id, byTeam);
    if (r.list_id === 2) hasList2.add(r.team_id);
    if (r.list_id === 4) hasList4.add(r.team_id);
  }
  return { lists, hasList2, hasList4 };
}

interface FieldingRow { player_id: number; [k: string]: number | null }

function loadFielding(ids: number[]): Map<number, FieldingRow> {
  if (!tableExists('players_fielding') || ids.length === 0) return new Map();
  const have = new Set(tableColumns('players_fielding'));
  const cols: string[] = [];
  for (let pos = 2; pos <= 9; pos++) {
    for (const c of [`fielding_rating_pos${pos}`, `fielding_rating_pos${pos}_pot`, `fielding_experience${pos}`]) {
      cols.push(have.has(c) ? `f.${c}` : `NULL AS ${c}`);
    }
  }
  const rows = db
    .prepare(
      `SELECT f.player_id, ${cols.join(', ')} FROM players_fielding f
       WHERE f.player_id IN (${marks(ids)}) ORDER BY f.player_id`
    )
    .all(...ids) as FieldingRow[];
  return new Map(rows.map((r) => [r.player_id, r]));
}

const PITCHES = [
  'fastball', 'slider', 'curveball', 'screwball', 'forkball', 'changeup', 'sinker', 'splitter', 'knuckleball',
  'cutter', 'circlechange', 'knucklecurve',
];

interface PitchingRow {
  player_id: number; stamina: number | null; hold: number | null; stuff: number | null; movement: number | null;
  vsl: number | null; vsr: number | null; hasPitches: boolean; [k: string]: number | null | boolean;
}

function loadPitching(ids: number[]): Map<number, PitchingRow> {
  if (!tableExists('players_pitching') || ids.length === 0) return new Map();
  const have = new Set(tableColumns('players_pitching'));
  const col = (c: string, as: string) => (have.has(c) ? `pi.${c} AS ${as}` : `NULL AS ${as}`);
  const hasPitches = PITCHES.every((p) => have.has(`pitching_ratings_pitches_${p}`));
  const rows = db
    .prepare(
      `SELECT pi.player_id, ${col('pitching_ratings_misc_stamina', 'stamina')}, ${col('pitching_ratings_misc_hold', 'hold')},
              ${col('pitching_ratings_overall_stuff', 'stuff')}, ${col('pitching_ratings_overall_movement', 'movement')},
              ${col('pitching_ratings_vsl_stuff', 'vsl')}, ${col('pitching_ratings_vsr_stuff', 'vsr')},
              ${PITCHES.map((p) => col(`pitching_ratings_pitches_${p}`, p)).join(', ')}
       FROM players_pitching pi WHERE pi.player_id IN (${marks(ids)}) ORDER BY pi.player_id`
    )
    .all(...ids) as PitchingRow[];
  return new Map(rows.map((r) => [r.player_id, { ...r, hasPitches }]));
}

const POSITION_VALUE_COLUMNS: Array<[position: number, column: string]> = [
  [2, 'overall_c'], [3, 'overall_1b'], [4, 'overall_2b'], [5, 'overall_3b'], [6, 'overall_ss'],
  [7, 'overall_lf'], [8, 'overall_cf'], [9, 'overall_rf'],
];

/** OOTP's own per-position value totals, which name a man's best spot. */
function loadPositionValues(ids: number[]): Map<number, Map<number, number>> {
  const out = new Map<number, Map<number, number>>();
  if (!tableExists('players_value') || ids.length === 0) return out;
  const have = new Set(tableColumns('players_value'));
  const cols = POSITION_VALUE_COLUMNS.filter(([, c]) => have.has(c));
  if (cols.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT v.player_id, ${cols.map(([, c]) => `v.${c}`).join(', ')} FROM players_value v
       WHERE v.player_id IN (${marks(ids)}) ORDER BY v.player_id`
    )
    .all(...ids) as Array<Record<string, number | null>>;
  for (const r of rows) {
    const m = new Map<number, number>();
    for (const [pos, c] of cols) if (typeof r[c] === 'number') m.set(pos, r[c] as number);
    out.set(r.player_id as number, m);
  }
  return out;
}

/** OOTP's SP value over its RP value per pitcher, the role tie-break; empty when the export lacks either column. */
function loadRoleRatios(ids: number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (ids.length === 0 || !hasColumns('players_value', 'overall_sp', 'overall_rp')) return out;
  const rows = db
    .prepare(
      `SELECT player_id, overall_sp AS sp, overall_rp AS rp FROM players_value
       WHERE player_id IN (${marks(ids)}) ORDER BY player_id`
    )
    .all(...ids) as Array<{ player_id: number; sp: number | null; rp: number | null }>;
  for (const r of rows) {
    if (typeof r.sp === 'number' && typeof r.rp === 'number' && r.rp > 0) out.set(r.player_id, r.sp / r.rp);
  }
  return out;
}

/** What a deal still pays: this season's salary and the sum of the seasons after it; null without a contract row. */
function remainingPay(playerId: number): { now: number; after: number } | null {
  if (!tableExists('players_contract')) return null;
  const c = db.prepare(`SELECT * FROM players_contract WHERE player_id = ?`).get(playerId) as Record<string, number | null> | undefined;
  if (!c) return null;
  const years = c.years ?? 0;
  const done = Math.max(c.current_year ?? 0, 0);
  const pay = (i: number): number => (i <= 14 && typeof c[`salary${i}`] === 'number' ? (c[`salary${i}`] as number) : 0);
  let after = 0;
  for (let i = done + 1; i < years; i++) after += pay(i);
  return { now: pay(Math.min(done, 14)), after };
}

/** One grouped line as SQL hands it back: the keys computeBatting / computePitching read, plus where it was made. */
interface RawLine extends Partial<RawBatting>, Partial<RawPitching> {
  player_id: number; year: number; league_id: number; level_id: number;
}

/**
 * The three-season lines of the org's men, one per (season, league, level),
 * professional lines only. `t` rides along with `t3` because the season maps
 * handed to correspondingMoves() are read by org.ts's slash line under the
 * export's own column name.
 */
function loadLines(ids: number[], fromYear: number): { bat: RawLine[]; pit: RawLine[] } {
  if (ids.length === 0) return { bat: [], pit: [] };
  const bat = tableExists('players_career_batting_stats')
    ? (db
        .prepare(
          `SELECT s.player_id, s.year, s.league_id, s.level_id,
                  SUM(s.pa) AS pa, SUM(s.ab) AS ab, SUM(s.h) AS h, SUM(s.d) AS d, SUM(s.t) AS t3, SUM(s.t) AS t,
                  SUM(s.hr) AS hr, SUM(s.bb) AS bb, SUM(s.ibb) AS ibb, SUM(s.hp) AS hp, SUM(s.sf) AS sf, SUM(s.k) AS k,
                  SUM(s.sb) AS sb, SUM(s.cs) AS cs, SUM(s.r) AS r, SUM(s.rbi) AS rbi, SUM(s.war) AS war
           FROM players_career_batting_stats s
           WHERE s.player_id IN (${marks(ids)}) AND s.year >= ? AND s.split_id = 1 AND s.league_id <> 0
           GROUP BY s.player_id, s.year, s.league_id, s.level_id
           ORDER BY s.player_id, s.year, s.league_id, s.level_id`
        )
        .all(...ids, fromYear) as RawLine[])
    : [];
  const pit = tableExists('players_career_pitching_stats')
    ? (db
        .prepare(
          `SELECT s.player_id, s.year, s.league_id, s.level_id,
                  SUM(s.outs) AS outs, SUM(s.er) AS er, SUM(s.ha) AS ha, SUM(s.bb) AS bb, SUM(s.k) AS k,
                  SUM(s.hra) AS hra, SUM(s.hp) AS hp, SUM(s.bf) AS bf, SUM(s.g) AS g, SUM(s.gs) AS gs,
                  SUM(s.w) AS w, SUM(s.l) AS l, SUM(s.s) AS sv, SUM(s.hld) AS hld, SUM(s.war) AS war
           FROM players_career_pitching_stats s
           WHERE s.player_id IN (${marks(ids)}) AND s.year >= ? AND s.split_id = 1 AND s.league_id <> 0
           GROUP BY s.player_id, s.year, s.league_id, s.level_id
           ORDER BY s.player_id, s.year, s.league_id, s.level_id`
        )
        .all(...ids, fromYear) as RawLine[])
    : [];
  return { bat, pit };
}

/**
 * The latest season with a line, the way form.ts and org.ts read "this
 * season" — but over the org's own men, through the player_id index. The
 * league's season year when nobody has a line yet.
 *
 * Not org.ts's latestStatsYear(), though that is now memoised and, with the
 * year index, free: the two can differ for a day or two at the start of a
 * season, when another org's club has played and none of this org's has, and
 * the plan is about this org's season. Over 324 men this costs about 5 ms.
 */
function statsYear(ids: number[], mlbLeagueId: number): number {
  const years: number[] = [];
  if (ids.length) {
    for (const t of ['players_career_batting_stats', 'players_career_pitching_stats']) {
      if (!tableExists(t)) continue;
      const y = (db.prepare(`SELECT MAX(year) AS y FROM "${t}" WHERE player_id IN (${marks(ids)})`).get(...ids) as { y: number | null }).y;
      if (typeof y === 'number') years.push(y);
    }
  }
  return years.length ? Math.max(...years) : seasonYear(mlbLeagueId);
}

let warnedAboutIndex = false;

/**
 * What warmBaselines() seeded, by pair. The stats cache hands back the very
 * object it was given until an import clears it, so one lookup tells whether
 * the seed is still standing; that keeps the grouped read to once per import
 * rather than once per plan, without a hook into stats.ts.
 */
let seeded = new Map<string, LeagueBaseline>();
const pairKey = (p: { league: number; year: number; level: number }): string => `${p.league}:${p.year}:${p.level}`;

/**
 * The league-season baselines the lines need, read the cheap way.
 *
 * With the (league_id, year) index the importer builds, leagueBaseline() is
 * an index range per pair and is simply called. Without it — a database
 * imported before the index existed — each pair measured about 97 ms on a
 * real save, so the sums are taken in one GROUP BY per table over the
 * leagues the org's men played in and seeded into stats.ts's cache. The
 * arithmetic mirrors leagueBaseline() exactly (a test holds the two equal),
 * and the log line says what to do about it.
 */
function warmBaselines(pairs: Array<{ league: number; year: number; level: number }>, fromYear: number): void {
  if (pairs.length === 0) return;
  const indexed = !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_players_career_batting_stats_league_year'`)
    .get();
  if (indexed) {
    for (const p of pairs) leagueBaseline(p.league, p.year, p.level);
    return;
  }
  const probe = pairs.find((p) => seeded.has(pairKey(p)));
  if (probe && leagueBaseline(probe.league, probe.year, probe.level) !== seeded.get(pairKey(probe))) seeded = new Map();
  const todo = pairs.filter((p) => !seeded.has(pairKey(p)));
  if (todo.length === 0) return;
  if (!warnedAboutIndex) {
    console.warn('[planner] the stats tables carry no (league_id, year) index; re-import to index the stats tables');
    warnedAboutIndex = true;
  }
  const leagueIds = [...new Set(todo.map((p) => p.league))];
  const marks = leagueIds.map(() => '?').join(', ');
  const n = (v: number | null | undefined) => v ?? 0;
  const bat = new Map<string, Record<string, number | null>>();
  const pit = new Map<string, Record<string, number | null>>();
  if (tableExists('players_career_batting_stats')) {
    for (const r of db
      .prepare(
        `SELECT league_id, year, level_id, SUM(pa) AS pa, SUM(ab) AS ab, SUM(h) AS h, SUM(d) AS d, SUM(t) AS t3,
                SUM(hr) AS hr, SUM(bb) AS bb, SUM(ibb) AS ibb, SUM(hp) AS hp, SUM(sf) AS sf, SUM(r) AS r
         FROM players_career_batting_stats
         WHERE league_id IN (${marks}) AND year >= ? AND split_id = 1
         GROUP BY league_id, year, level_id`
      )
      .all(...leagueIds, fromYear) as Array<Record<string, number | null>>) {
      bat.set(`${r.league_id}:${r.year}:${r.level_id}`, r);
    }
  }
  if (tableExists('players_career_pitching_stats')) {
    for (const r of db
      .prepare(
        `SELECT league_id, year, level_id, SUM(outs) AS outs, SUM(er) AS er, SUM(hra) AS hra, SUM(bb) AS bb,
                SUM(k) AS k, SUM(hp) AS hp
         FROM players_career_pitching_stats
         WHERE league_id IN (${marks}) AND year >= ? AND split_id = 1
         GROUP BY league_id, year, level_id`
      )
      .all(...leagueIds, fromYear) as Array<Record<string, number | null>>) {
      pit.set(`${r.league_id}:${r.year}:${r.level_id}`, r);
    }
  }
  // The wOBA weights stats.ts uses; the FIP constant and the park factors come from there
  const W = { bb: 0.69, hbp: 0.72, single: 0.88, double: 1.25, triple: 1.58, hr: 2.03 };
  for (const p of todo) {
    const key = pairKey(p);
    const b = bat.get(key) ?? {};
    const q = pit.get(key) ?? {};
    const ab = n(b.ab);
    const h = n(b.h);
    const singles = h - n(b.d) - n(b.t3) - n(b.hr);
    const obpDen = ab + n(b.bb) + n(b.hp) + n(b.sf);
    const wobaDen = ab + (n(b.bb) - n(b.ibb)) + n(b.sf) + n(b.hp);
    const lgInnings = n(q.outs) / 3;
    seeded.set(key, seedLeagueBaseline(p.league, p.year, p.level, {
      lgOBP: obpDen ? (h + n(b.bb) + n(b.hp)) / obpDen : 0,
      lgSLG: ab ? (singles + 2 * n(b.d) + 3 * n(b.t3) + 4 * n(b.hr)) / ab : 0,
      lgWOBA: wobaDen
        ? (W.bb * (n(b.bb) - n(b.ibb)) + W.hbp * n(b.hp) + W.single * singles + W.double * n(b.d) +
           W.triple * n(b.t3) + W.hr * n(b.hr)) / wobaDen
        : 0,
      lgRperPA: n(b.pa) ? n(b.r) / n(b.pa) : 0,
      lgERA: lgInnings ? (n(q.er) / lgInnings) * 9 : 0,
      lgFIPRaw: lgInnings ? (13 * n(q.hra) + 3 * (n(q.bb) + n(q.hp)) - 2 * n(q.k)) / lgInnings : 0,
    }));
  }
}

interface Calendar {
  today: Ymd;
  season: number;
  /** The last regular-season game of each league, by DATE_KEY, keyed by league id. */
  seasonEnd: Map<number, string>;
  rule5: string | null;
  tradeDeadline: string | null;
  rosterExpand: string | null;
  openingDay: string | null;
  dslStart: string | null;
  minorFaYears: number | null;
  activeLimit: number;
  expandedLimit: number;
  fortyLimit: number;
}

/**
 * The dates the plan is measured against. Season ends come from the games
 * table, the last `game_type = 0` game of each league by DATE_KEY, because
 * the dates are unpadded strings and a text MAX gives "9-9". Rule 5, the
 * trade deadline, roster expansion and Opening Day come from the MLB league
 * row only: the minor-league rows carry a stale Rule 5 date from two seasons
 * ago and a different deadline.
 */
function loadCalendar(mlbLeagueId: number, rungList: Rung[], leagues: Map<number, LeagueRung>, playerIds: number[]): Calendar {
  const col = (c: string) => (hasColumns('leagues', c) ? `"${c}"` : 'NULL');
  const row = db
    .prepare(
      `SELECT ${col('current_date')} AS today, ${col('rule_5_draft_date')} AS rule5, ${col('trade_deadline_date')} AS deadline,
              ${col('roster_expand_date')} AS expand, ${col('start_date')} AS start,
              ${col('rules_minor_league_fa_minimum_years')} AS minorFa, ${col('rules_active_roster_limit')} AS active,
              ${col('rules_expanded_roster_limit')} AS expanded, ${col('rules_secondary_roster_limit')} AS forty
       FROM leagues WHERE league_id = ?`
    )
    .get(mlbLeagueId) as Record<string, string | number | null> | undefined;
  const todayRaw = currentGameDate(mlbLeagueId) ?? leagueGameDate();
  const today = parseDate(todayRaw) ?? { y: seasonYear(mlbLeagueId), m: 1, d: 1 };
  const seasonEnd = new Map<number, string>();
  if (tableExists('games') && hasColumns('games', 'game_type', 'league_id', 'date')) {
    const leagueIds = [...new Set(rungList.flatMap((r) => r.clubs.map((c) => c.league_id)))];
    if (leagueIds.length) {
      // One aggregate per league; the key is turned back into a date here
      const rows = db
        .prepare(
          `SELECT league_id, MAX(${DATE_KEY('date')}) AS k FROM games
           WHERE game_type = 0 AND league_id IN (${leagueIds.map(() => '?').join(', ')})
           GROUP BY league_id ORDER BY league_id`
        )
        .all(...leagueIds) as Array<{ league_id: number; k: number | null }>;
      for (const r of rows) {
        if (typeof r.k !== 'number' || r.k <= 0) continue;
        seasonEnd.set(r.league_id, fmtDate({ y: Math.floor(r.k / 10000), m: Math.floor(r.k / 100) % 100, d: r.k % 100 }));
      }
    }
  }
  const clean = (v: unknown): string | null => (parseDate(v) ? fmtDate(parseDate(v)!) : null);
  const dsl = rungList.find((r) => r.key === 'dsl');
  const dslLeague = dsl?.leagueId !== null && dsl?.leagueId !== undefined ? leagues.get(dsl.leagueId) : undefined;
  const num = (v: unknown, fallback: number): number => (typeof v === 'number' && v > 0 ? v : fallback);
  return {
    today,
    season: statsYear(playerIds, mlbLeagueId),
    seasonEnd,
    rule5: clean(row?.rule5),
    tradeDeadline: clean(row?.deadline),
    rosterExpand: clean(row?.expand),
    openingDay: clean(row?.start),
    dslStart: clean(dslLeague?.startDate),
    minorFaYears: typeof row?.minorFa === 'number' && row.minorFa > 0 ? row.minorFa : null,
    activeLimit: num(row?.active, 26),
    expandedLimit: num(row?.expanded, 28),
    fortyLimit: num(row?.forty, FORTY_MAN_LIMIT),
  };
}

// ── The man ─────────────────────────────────────────────────────────────

interface Line {
  year: number;
  rung: RungKey;
  /** The index at its own level, 100 = league average, capped to [0, 250]. */
  idx: number;
  weight: number;
  pa: number;
  ip: number;
  /** The line in words, for the production sentence. */
  text: string;
  /** The line without its figures ("a 10-PA look at Triple-A this year"), for a season's line under the 60 PA / 15 IP gate. */
  short: string;
}

interface Draft {
  key: string;
  kind: MoveKind;
  horizon: Horizon;
  forced: boolean;
  man: Man;
  from: { rung: RungKey; teamId: number | null };
  to: { rung: RungKey | 'out' | '40man'; teamId: number | null; label: string };
  /** The rule that fired, first. */
  lead: string[];
  /** Said after the production and scouting sentences. */
  tail: string[];
  /** The rung the production and scouting sentences are quoted at. */
  judgedAt: RungKey;
  fit: number | null;
  deadline: Deadline | null;
  verify: Verify | null;
  fortyMan: MoveFortyMan | null;
  linked: string[];
  /**
   * The 40-man question for this man: his protection, or the hold that stands
   * in for it while no place is open. It keeps one key whichever of the two it
   * is, rides beside a move rather than folding into it, and takes in his other
   * holds.
   */
  fortyQuestion?: boolean;
  /** Where a protection claimed its place in the 40-man count, so the cards list in that order. */
  seq?: number;
  /**
   * The hold that says his club cannot cover his place from below, so a
   * trade is not made: among his holds it is the card the others fold into,
   * so its reason is the one said first.
   */
  leads?: boolean;
}

interface Man {
  id: number;
  name: string;
  age: number;
  position: number;
  role: number;
  isPitcher: boolean;
  p: OrgPlayer;
  /** His club today; the org's own id for a complex man. */
  teamId: number;
  rung: RungKey | null;
  ic: boolean;
  healthy: boolean;
  /** Listed, counted toward size, never moved: injured, designated or on waivers. */
  frozen: boolean;
  onIl: boolean;
  daysLeft: number | null;
  dfa: boolean;
  waivers: boolean;
  on26: boolean;
  on40: boolean;
  il60: boolean;
  oa: number | null;
  pot: number | null;
  group: Group;
  stamina: number | null;
  pitches: number | null;
  stuff: number | null;
  hold: number | null;
  /** His class at the rung he is planned at: re-read whenever the plan places him somewhere new. */
  roleClass: RoleClass | null;
  /** His class at the club he is on today, which the Today counts and his row there read: never re-read. */
  roleClassToday: RoleClass | null;
  /** The SP/RP value tie-break, for a man the ratings cannot class: on the line between the classes, or with no pitch ratings. */
  lean: 'SP' | 'RP' | null;
  specialist: 'vs L' | 'vs R' | null;
  fielding: Map<number, { cur: number; pot: number; exp: number }>;
  /** Positions he could hold a job at, the utility-class reading: rated 40 now, or revealed with a 50 ceiling. */
  covers: Set<number>;
  /** Positions he covers today, rated 40 or better: what the structure and the field check count. */
  coversNow: Set<number>;
  posValues: Map<number, number>;
  utility: UtilityClass | null;
  ceiling: CeilingTier | null;
  status: StatusRow | null;
  proYears: number | null;
  protectedYears: number | null;
  optionsUsed: number | null;
  optionsThisYear: number | null;
  serviceYears: number;
  optionState: OptionState;
  rule5: boolean;
  protect: boolean;
  minorFa: MinorFaTiming;
  capState: ServiceCapState;
  contract: ContractInfo | undefined;
  form: SeasonForm | null;
  lines: Line[];
  windowPa: number;
  windowIp: number;
  readable: boolean;
  /** This season at his current rung. */
  seasonPa: number;
  seasonIp: number;
  fits: Map<RungKey, number | null>;
  indexAt: Map<RungKey, number | null>;
  assetClass: AssetClass | null;
  modifiers: AssetModifier[];
  // ── planning state ──
  plannedTeam: number | 'out' | null;
  moved: boolean;
  target: 'above' | 'below' | 'stay';
  strong: boolean;
  overmatched: boolean;
  draft: Draft | null;
  extra: Draft[];
  flags: string[];
  /** The size sentence, when the balance pushed him out of the org. */
  pushedOut: string | null;
  /** The two-steps-up sentence, when the cap sends him to the release list. */
  capOut: string | null;
  /** His Rule 5 sentence's 40-man clause, with the count as it stands after the additions above him. */
  fortyLine: string | null;
}

const positionGroup = (position: number): CountGroup =>
  position === 2 ? 'C' : position >= 7 && position <= 9 ? 'OF' : 'IF';

const countGroup = (man: Man): CountGroup =>
  man.isPitcher ? (man.roleClass === 'RP' ? 'RP' : 'SP') : positionGroup(man.position);

/** His group at the club he is on today: a pitcher the plan moves keeps today's class here. */
const countGroupToday = (man: Man): CountGroup =>
  man.isPitcher ? (man.roleClassToday === 'RP' ? 'RP' : 'SP') : positionGroup(man.position);

/** Whether he belongs to a structure group: counted on healthy men only. */
function inGroup(man: Man, group: StructureGroup): boolean {
  if (group === 'SS cover') return !man.isPitcher && man.coversNow.has(6);
  if (group === 'CF cover') return !man.isPitcher && man.coversNow.has(8);
  return countGroup(man) === group;
}

/** The rungs where stamina alone makes a starter. */
const STAMINA_ONLY: readonly RungKey[] = ['complex', 'dsl', 'ic'];

/** His pitching class at a rung: the third rated pitch is asked for from Single-A up. */
function roleClassAt(man: Man, rung: RungKey | null): RoleClass | null {
  return man.isPitcher ? pitchRole(man.stamina, man.pitches, rung !== null && STAMINA_ONLY.includes(rung), man.lean) : null;
}

/** Whether he would belong to a structure group at a rung he is not at yet: a pitcher is re-classed there. */
function inGroupAt(man: Man, group: StructureGroup, rung: RungKey): boolean {
  if (!man.isPitcher || (group !== 'SP' && group !== 'RP')) return inGroup(man, group);
  return (roleClassAt(man, rung) === 'RP' ? 'RP' : 'SP') === group;
}

// ── The engine ──────────────────────────────────────────────────────────

/** Each org's plan, with the decisions it was computed under. */
const planCache = new Map<number, { plan: Plan; decisions: string }>();

/** Forgets every plan and the rung medians; called after an import and when the planner settings change. */
export function clearPlanCache(): void {
  planCache.clear();
  rungBaselineCache = null;
}
onPlannerSettingsChanged(clearPlanCache);
// The plan reads the 40-man decisions, so a decision written makes it stale
onPlanDecisionsChanged((orgId) => {
  if (orgId === null) planCache.clear();
  else planCache.delete(orgId);
});

/**
 * The decisions a plan is computed under, in one string: the ones on a 40-man
 * question, a call-up, a trade or a release that the engine still acts on. A plan
 * cached under other decisions is computed again, so a decision written
 * around the store (by hand, or by a test) cannot leave a stale count behind.
 */
function decisionsRead(orgId: number): string {
  return [...planDecisions(orgId).values()]
    .filter((d) => decisionLive(d) && (d.moveKey.startsWith('protect:') || d.kind === 'callup' || d.kind === 'trade' || d.kind === 'release'))
    .map((d) => `${d.moveKey}=${d.state}`)
    .join('|');
}

/** The plan for an org, computed once per import, settings change and decision on the 40-man; null for an unknown org. */
export function computePlan(orgId: number): Plan | null {
  const decisions = decisionsRead(orgId);
  const hit = planCache.get(orgId);
  if (hit && hit.decisions === decisions) return hit.plan;
  const plan = buildPlan(orgId);
  if (plan) planCache.set(orgId, { plan, decisions });
  return plan;
}

function buildPlan(orgId: number): Plan | null {
  const settings = plannerSettings();
  const ladder = rungs(orgId, settings);
  if (!ladder) return null;
  const { rungs: rungList, leagues } = ladder;
  const warnings = [...ladder.warnings];
  const byKey = new Map(rungList.map((r) => [r.key, r]));
  const mlb = byKey.get('mlb')!;
  const mlbLeagueId = mlb.leagueId!;
  const players = orgPlayers(orgId).sort((a, b) => a.player_id - b.player_id);
  const playerIds = players.map((p) => p.player_id);
  const cal = loadCalendar(mlbLeagueId, rungList, leagues, playerIds);
  const rungAbove = (key: RungKey): Rung | null => {
    const r = byKey.get(key);
    return r && r.rank > 1 ? rungList[r.rank - 2] : null;
  };
  const rungBelow = (key: RungKey): Rung | null => {
    const r = byKey.get(key);
    const below = r ? rungList[r.rank] : undefined;
    return below && below.key !== 'ic' ? below : null;
  };
  const clubRung = new Map<number, Rung>();
  for (const r of rungList) for (const c of r.clubs) clubRung.set(c.team_id, r);
  const clubLabel = (teamId: number | null): string =>
    teamId === null || teamId === IC_TEAM ? 'the international complex'
    : rungList.flatMap((r) => r.clubs).find((c) => c.team_id === teamId)?.label ?? `team ${teamId}`;

  // ── Loads ──
  const statusPresent = tableExists('players_roster_status');
  if (!statusPresent) {
    warnings.push('roster status not exported; service-time, option and Rule 5 rules are off');
  }
  const teamIds = rungList.flatMap((r) => r.clubs.map((c) => c.team_id));
  const { lists, hasList2, hasList4 } = loadLists(teamIds);
  const status = loadStatus(playerIds);
  const crunch = rosterCrunch(orgId);
  const forty = new Map((crunch?.fortyMan ?? []).map((m) => [m.player_id, m]));
  const contracts = contractsByPlayer();
  const values = valuesByPlayer();
  const posValues = loadPositionValues(playerIds);
  const fieldingRows = loadFielding(playerIds);
  const pitchingRows = loadPitching(playerIds);
  const baselines = rungBaselines(leagues);
  const fromYear = cal.season - 2;
  const raw = loadLines(playerIds, fromYear);
  /*
   * This season's sums by (man, level), the shape correspondingMoves() quotes
   * from — the same columns org.ts's seasonBatting() and seasonPitching() sum,
   * but from the lines already in hand: each of those is a 430 ms scan of a
   * table with no index on year, and the only men it is asked about are these.
   */
  const seasonSums = (lines: RawLine[]): Map<string, Record<string, number>> => {
    const out = new Map<string, Record<string, number>>();
    for (const l of lines) {
      if (l.year !== cal.season) continue;
      const key = statKey(l.player_id, l.level_id);
      const sum = out.get(key) ?? {};
      for (const [k, v] of Object.entries(l)) {
        if (k === 'player_id' || k === 'year' || k === 'league_id' || k === 'level_id' || typeof v !== 'number') continue;
        sum[k] = (sum[k] ?? 0) + v;
      }
      out.set(key, sum);
    }
    return out;
  };
  const seasonBat = seasonSums(raw.bat);
  const seasonPit = seasonSums(raw.pit);
  const room = fortyManRoom(orgId, players);
  const pairs = new Map<string, { league: number; year: number; level: number }>();
  for (const l of [...raw.bat, ...raw.pit]) pairs.set(`${l.league_id}:${l.year}:${l.level_id}`, { league: l.league_id, year: l.year, level: l.level_id });
  // Each club's own league-season too: seasonFormByClubs() asks for it, and a
  // club that has not opened yet (the DSL in May) has no line to put it in the list
  for (const r of rungList) {
    for (const c of r.clubs) pairs.set(`${c.league_id}:${cal.season}:${c.level}`, { league: c.league_id, year: cal.season, level: c.level });
  }
  warmBaselines([...pairs.values()], fromYear);
  // Every club in one pass over the season's lines; one call per club walked them eight times
  const formsByClub = seasonFormByClubs(teamIds);
  const forms = new Map<number, Map<number, SeasonForm>>();
  for (const teamId of teamIds) forms.set(teamId, formsByClub.get(teamId) ?? new Map());
  const holes = rosterHoles(orgId);
  const thinnest = holes.length
    ? holes.filter((h) => h.bestValue === holes[0].bestValue).map((h) => h.positionName)
    : [];
  const pools = mlbPools(values);
  const cover40 = scaleGrade(COVER_RATING);

  for (const [teamId, rung] of clubRung) {
    if (rung.key !== 'mlb' && !hasList2.has(teamId) && !hasList4.has(teamId)) {
      warnings.push(`${clubLabel(teamId)} exports no active or injured list, so every man on it is read as healthy.`);
    }
  }

  // ── Translation steps ──
  const mleOf = new Map<RungKey, number>();
  for (const [, l] of leagues) if (l.mle !== null && !mleOf.has(l.key)) mleOf.set(l.key, l.mle);
  for (const r of rungList) if (r.mle !== null) mleOf.set(r.key, r.mle);
  mleOf.set('mlb', 1);
  const { translate, rungStep } = mleTranslator(mleOf);

  // ── Profiles ──
  const men: Man[] = [];
  const byId = new Map<number, Man>();
  const leaving: LeavingRow[] = [];
  let unplaced = 0;
  for (const p of players) {
    const st = status.get(p.player_id) ?? null;
    const name = `${p.first_name} ${p.last_name}`;
    const own = lists.get(p.player_id);
    const rostered = !!own && own.size > 0;
    const ic = !rostered && (p.league_id ?? 0) < 0;
    let teamId = p.team_id;
    let rung: RungKey | null = null;
    if (ic) rung = 'ic';
    else if (rostered) {
      // The club whose list he is on, which is his team_id except for a 40-man
      // man in the minors, who is on the big club's list 3 as well
      const on = [...own!.keys()].filter((t) => own!.get(t)!.has(1) || own!.get(t)!.has(2) || own!.get(t)!.has(4));
      teamId = on.includes(p.team_id) ? p.team_id : on[0] ?? p.team_id;
      rung = clubRung.get(teamId)?.key ?? null;
    }
    if (!rung) {
      unplaced++;
      continue;
    }
    const ownLists = own?.get(teamId) ?? new Set<number>();
    const fm = forty.get(p.player_id);
    const on26 = fm?.on26 ?? st?.is_active === 1;
    const on40 = fm?.on40 ?? false;
    const il60 = fm?.il60 ?? false;
    const health = st ? healthOf(st) : null;
    const dfa = st?.designated_for_assignment === 1;
    const waivers = st?.is_on_waivers === 1;
    let healthy: boolean;
    let onIl: boolean;
    if (rung === 'mlb') {
      healthy = !health || health.playable;
      onIl = !!health && !health.playable;
    } else if (rung === 'ic') {
      healthy = true;
      onIl = false;
    } else if (hasList2.has(teamId)) {
      healthy = ownLists.has(2);
      onIl = ownLists.has(4);
    } else {
      onIl = ownLists.has(4);
      healthy = !onIl;
    }
    if (dfa || waivers) {
      healthy = false;
      leaving.push({
        player_id: p.player_id, name,
        why: dfa ? `designated for assignment, ${st?.days_on_dfa_left ?? '?'} days to resolve` : `on waivers, ${st?.days_on_waivers_left ?? '?'} days left`,
      });
    }
    const { cur, pot } = composites(p);
    const isPitcher = p.position === 1;
    const pr = pitchingRows.get(p.player_id);
    let roleClass: RoleClass | null = null;
    let pitches: number | null = null;
    let specialist: 'vs L' | 'vs R' | null = null;
    if (isPitcher) {
      pitches = pr?.hasPitches ? ratedPitches(PITCHES.map((k) => pr[k] as number | null)) : null;
      /*
       * At the complex rungs stamina alone makes a starter. The three-pitch
       * test was calibrated on major-league starters (88 per cent pass); on
       * the save this was built against not one DSL arm and one in ten
       * Single-A arms had a third pitch rated 40, though eight to ten per club
       * had the stamina, so the rule as written found no starters below
       * Double-A and every plan asked the DSL to sign six. The third pitch is
       * what the complex exists to teach; it is asked for from Single-A up.
       */
      const atComplex = rung === 'complex' || rung === 'dsl' || rung === 'ic';
      roleClass = pitchRole(pr?.stamina ?? null, pitches, atComplex);
      specialist = specialistOf(pr?.vsl, pr?.vsr);
    }
    const fielding = new Map<number, { cur: number; pot: number; exp: number }>();
    const covers = new Set<number>();
    const coversNow = new Set<number>();
    const fr = fieldingRows.get(p.player_id);
    if (fr && !isPitcher) {
      for (let pos = 2; pos <= 9; pos++) {
        const c = fr[`fielding_rating_pos${pos}`] ?? 0;
        const q = fr[`fielding_rating_pos${pos}_pot`] ?? 0;
        if (c <= 0) continue; // the dash in OOTP: not revealed
        fielding.set(pos, { cur: c, pot: q, exp: fr[`fielding_experience${pos}`] ?? 0 });
        if (c >= cover40) coversNow.add(pos);
        if (c >= cover40 || q >= scaleGrade(COVER_CEILING)) covers.add(pos);
      }
    }
    const utility: UtilityClass | null = isPitcher ? roleClass : utilityClassOf(covers, p.position);
    const ceiling = ceilingTierOf(pot);
    const serviceYears = serviceYearsOf(st?.mlb_service_days, st?.mlb_service_years);
    const proYears = statusPresent ? st?.pro_service_years ?? null : null;
    const contract = contracts.get(p.player_id);
    const rungObj = byKey.get(rung)!;
    const man: Man = {
      id: p.player_id, name, age: p.age, position: p.position, role: p.role, isPitcher, p, teamId, rung, ic,
      healthy, frozen: !healthy, onIl, dfa, waivers, on26, on40, il60,
      daysLeft: health?.daysLeft ?? (typeof st?.injury_left === 'number' && st.injury_left > 0 && st.injury_left < 1000 ? st.injury_left : null),
      oa: cur, pot, group: groupOf(p.position, p.role),
      stamina: pr?.stamina ?? null, pitches, stuff: pr?.stuff ?? null, hold: pr?.hold ?? null, roleClass, roleClassToday: roleClass, lean: null, specialist,
      fielding, covers, coversNow, posValues: posValues.get(p.player_id) ?? new Map(), utility, ceiling,
      status: st, proYears, protectedYears: st?.years_protected_from_rule_5 ?? null,
      optionsUsed: st?.options_used ?? null, optionsThisYear: st?.options_used_this_year ?? null, serviceYears,
      optionState: statusPresent
        ? optionState({ optionsUsed: st?.options_used, optionsUsedThisYear: st?.options_used_this_year, on40, on26, serviceYears })
        : 'n/a',
      rule5: statusPresent && rule5Eligible({ on40, proServiceYears: proYears, protectedYears: st?.years_protected_from_rule_5 }),
      protect: false,
      minorFa: statusPresent && rung !== 'ic'
        ? minorLeagueFaAfterSeason({ majorContract: contract?.isMajor ?? false, on40, proServiceYears: proYears }, cal.minorFaYears)
        : null,
      capState: statusPresent && rung !== 'ic' ? serviceCapState(proYears, rungObj.cap) : 'ok',
      contract, form: forms.get(teamId)?.get(p.player_id) ?? null,
      lines: [], windowPa: 0, windowIp: 0, readable: false, seasonPa: 0, seasonIp: 0,
      fits: new Map(), indexAt: new Map(), assetClass: null, modifiers: [],
      plannedTeam: ic ? IC_TEAM : teamId, moved: false, target: 'stay', strong: false, overmatched: false,
      draft: null, extra: [], flags: [], pushedOut: null, capOut: null, fortyLine: null,
    };
    men.push(man);
    byId.set(man.id, man);
  }
  if (unplaced > 0) {
    warnings.push(`${unplaced} ${plural(unplaced, 'man is', 'men are')} on no roster list and not in the complex pool, so ${plural(unplaced, 'he is', 'they are')} left out of the plan.`);
  }
  /*
   * The SP/RP value tie-break, for the arms the ratings cannot class: a man
   * on the line between a starter and a reliever, or with no pitch ratings,
   * is read against the org's own starters and relievers, the ones the
   * ratings class without help, by whose median SP/RP ratio his own sits
   * nearer. Nobody the ratings settle moves, and every man keeps his lean, so
   * the rung he is planned at classes him the same way.
   */
  {
    const ratios = loadRoleRatios(men.filter((m) => m.isPitcher).map((m) => m.id));
    const decisive = men.filter((m) =>
      m.isPitcher && m.pitches !== null && m.stamina !== null && ratios.has(m.id) && !inSwingBand(m.stamina, m.pitches, false));
    const medianOf = (cls: RoleClass): number | null =>
      median(decisive.filter((m) => pitchRole(m.stamina, m.pitches, false) === cls).map((m) => ratios.get(m.id)!));
    const spMed = medianOf('SP');
    const rpMed = medianOf('RP');
    for (const man of men) {
      if (!man.isPitcher) continue;
      man.lean = ratioLean(ratios.get(man.id) ?? null, spMed, rpMed);
      man.roleClass = roleClassAt(man, man.rung);
      man.roleClassToday = man.roleClass;
      man.utility = man.roleClass;
    }
  }

  // ── Production lines ──
  const lineRung = (leagueId: number, level: number): RungKey | null =>
    level === 1 ? 'mlb' : leagues.get(leagueId)?.key ?? null;
  const when = (year: number): string => (year === cal.season ? 'this year' : year === cal.season - 1 ? 'last year' : `in ${year}`);
  for (const l of raw.bat) {
    const man = byId.get(l.player_id);
    if (!man || man.isPitcher) continue;
    const rung = lineRung(l.league_id, l.level_id);
    if (!rung) continue;
    const base = leagueBaseline(l.league_id, l.year, l.level_id);
    const stats = computeBatting(l, base, null);
    const idx = stats.wrcPlus ?? stats.opsPlus;
    if (idx === null || idx === undefined) continue;
    const pa = l.pa ?? 0;
    const slash = [stats.avg, stats.obp, stats.slg].every((v) => v !== null)
      ? [stats.avg, stats.obp, stats.slg].map((v) => (v as number).toFixed(3).replace(/^0\./, '.')).join('/')
      : null;
    const lgOps = (base.lgOBP + base.lgSLG).toFixed(3).replace(/^0\./, '.');
    man.lines.push({
      year: l.year, rung, idx: clamp(idx, 0, INDEX_CAP), weight: lineWeight(l.year, cal.season, pa, SAMPLE.pa), pa, ip: 0,
      text: `${slash ?? 'no line'} with ${l.hr ?? 0} HR in ${pa} PA at ${LEVEL_AT[rung]} ${when(l.year)} (league ${lgOps} OPS)`,
      short: `a ${pa}-PA look at ${LEVEL_AT[rung]} ${when(l.year)}`,
    });
    man.windowPa += pa;
    if (l.year === cal.season && rung === man.rung) man.seasonPa += pa;
  }
  for (const l of raw.pit) {
    const man = byId.get(l.player_id);
    if (!man || !man.isPitcher) continue;
    const rung = lineRung(l.league_id, l.level_id);
    if (!rung) continue;
    const base = leagueBaseline(l.league_id, l.year, l.level_id);
    const stats = computePitching(l, base, null);
    const parts = [stats.eraPlus, stats.fipPlus].filter((v): v is number => typeof v === 'number');
    if (parts.length === 0) continue;
    const idx = parts.reduce((a, b) => a + b, 0) / parts.length;
    const ip = (l.outs ?? 0) / 3;
    const full = man.roleClass === 'RP' ? SAMPLE.ipReliever : SAMPLE.ipStarter;
    const sv = l.sv ?? 0;
    const saves = sv > 0 ? ` and ${sv} ${plural(sv, 'save')}` : '';
    man.lines.push({
      year: l.year, rung, idx: clamp(idx, 0, INDEX_CAP), weight: lineWeight(l.year, cal.season, ip, full), pa: 0, ip,
      text: `${stats.ip ?? 0} IP, ${stats.era === null ? 'no runs' : `${(stats.era as number).toFixed(2)} ERA`}${saves} in ${l.g ?? 0} ${plural(l.g ?? 0, 'game')} at ${LEVEL_AT[rung]} ${when(l.year)} (league ${base.lgERA.toFixed(2)})`,
      short: `a ${stats.ip ?? 0}-IP look at ${LEVEL_AT[rung]} ${when(l.year)}`,
    });
    man.windowIp += ip;
    if (l.year === cal.season && rung === man.rung) man.seasonIp += ip;
  }
  for (const man of men) {
    man.readable = productionReadable(man.windowPa, man.windowIp, man.isPitcher);
    man.lines.sort((a, b) => b.year - a.year || RUNG_KEYS.indexOf(a.rung) - RUNG_KEYS.indexOf(b.rung));
  }

  /** The production index stated at a rung: the regressed blend of every line translated there. */
  const indexAt = (man: Man, rung: RungKey): number | null => {
    if (man.indexAt.has(rung)) return man.indexAt.get(rung)!;
    const out = man.readable && man.lines.length ? blendProduction(man.lines, rung, translate) : null;
    man.indexAt.set(rung, out);
    return out;
  };
  const zS = (man: Man, rung: RungKey): number | null => {
    const med = baselines[rung].medOa[man.group];
    return man.oa === null || med === null ? null : (man.oa - med) / scaleGrade(Z_GRADES);
  };
  const zA = (man: Man, rung: RungKey): number | null => {
    const med = baselines[rung].medAge;
    return med === null ? null : clamp((med - man.age) / Z_YEARS, -2, 2);
  };
  /** Readiness at a rung, or null when there is nothing to score him on. */
  const fitAt = (man: Man, rung: RungKey): number | null => {
    if (man.fits.has(rung)) return man.fits.get(rung)!;
    const out = rung === 'ic' ? null : fitOf(zS(man, rung), indexAt(man, rung), zA(man, rung));
    man.fits.set(rung, out);
    return out;
  };
  const coversThinnest = (man: Man): boolean =>
    !man.isPitcher && [...man.covers].some((pos) => thinnest.includes(POSITION_NAMES[pos] ?? ''));
  /** The one order every list is in: fit, the big club's need, ceiling, grade, youth, id. */
  const tieBreak = (rung: RungKey) => (a: Man, b: Man): number => {
    const fa = fitAt(a, rung);
    const fb = fitAt(b, rung);
    return (fb ?? -Infinity) - (fa ?? -Infinity) || Number(coversThinnest(b)) - Number(coversThinnest(a)) ||
      (b.pot ?? -1) - (a.pot ?? -1) || (b.oa ?? -1) - (a.oa ?? -1) || a.age - b.age || a.id - b.id;
  };
  const formPoor = (man: Man): boolean => formBlocksPromote(man.form);
  const formGood = (man: Man): boolean => formBlocksDemote(man.form);

  // ── Eligibility ──
  interface Eligibility { ok: boolean; why: string | null }
  /**
   * Whether he may be rostered at a rung: this season only, or this season and
   * next. Every move INTO a rung asks for both, since a rostered man gains a
   * year by Opening Day and the design never moves a man into a rung where
   * years + 1 > cap; only the forced move of a man already over his cap may
   * settle for this season when no rung above passes both.
   */
  const eligibleAt = (man: Man, rung: Rung, next: boolean): Eligibility => {
    if (rung.key === 'ic') return { ok: false, why: 'nothing is moved into the international complex' };
    if (rung.key === 'mlb' || rung.cap === null || !statusPresent) return { ok: true, why: null };
    const years = man.proYears ?? 0;
    if (years > rung.cap) {
      return { ok: false, why: `${years} pro service years against the ${LEVEL_ADJ[rung.key]} cap of ${rung.cap}` };
    }
    if (next && years + 1 > rung.cap) {
      return { ok: false, why: `${years + 1} pro service years by Opening Day ${cal.season + 1} against the ${LEVEL_ADJ[rung.key]} cap of ${rung.cap}` };
    }
    return { ok: true, why: null };
  };

  // ── Asset class ──
  for (const man of men) {
    if (man.rung === null || man.oa === null || man.pot === null) continue;
    const base = baselines[man.rung];
    man.assetClass = assetClassOf({
      oa: man.oa, pot: man.pot, age: man.age, zA: zA(man, man.rung), medOa: base.medOa[man.group], medAge: base.medAge,
      atComplex: man.rung === 'complex' || man.rung === 'dsl',
      spArmUpper: man.isPitcher && man.roleClass === 'SP' && ['mlb', 'aaa', 'aa'].includes(man.rung),
    });
    if (man.on40 && man.optionState === 'last-option-year') man.modifiers.push('on40-last-option');
    if (man.on40 && man.optionState === 'out-of-options') man.modifiers.push('on40-out-of-options');
    if (man.rule5) man.modifiers.push('rule5-exposed');
    if (man.minorFa === 'after-this-season') man.modifiers.push('minor-fa-after-season');
  }
  for (const man of men) {
    if (!man.rule5 || man.rung === null || man.assetClass === 'surplus') continue;
    man.protect = rule5ProtectGate({ oa: man.oa, pot: man.pot, productionIndex: indexAt(man, man.rung) });
  }

  // ── Planning state ──
  const planned = new Map<number, Set<number>>();
  planned.set(IC_TEAM, new Set());
  for (const t of teamIds) planned.set(t, new Set());
  for (const man of men) planned.get(man.plannedTeam as number)!.add(man.id);
  const place = (man: Man, teamId: number | 'out'): void => {
    if (typeof man.plannedTeam === 'number') planned.get(man.plannedTeam)?.delete(man.id);
    man.plannedTeam = teamId;
    if (typeof teamId === 'number') {
      planned.get(teamId)!.add(man.id);
      // A pitcher is classed at the rung he is planned at: a complex starter
      // on stamina alone is a reliever at Single-A without the third pitch
      if (man.isPitcher) {
        man.roleClass = roleClassAt(man, teamId === IC_TEAM ? 'ic' : clubRung.get(teamId)?.key ?? man.rung);
        man.utility = man.roleClass;
      }
    }
    man.moved = true;
  };
  const plannedRung = (man: Man): RungKey | null =>
    man.plannedTeam === 'out' || man.plannedTeam === null ? null
    : man.plannedTeam === IC_TEAM ? 'ic'
    : clubRung.get(man.plannedTeam)?.key ?? null;
  const menAt = (teamId: number): Man[] => [...planned.get(teamId) ?? []].map((id) => byId.get(id)!).sort((a, b) => a.id - b.id);
  const healthyAt = (teamId: number): Man[] => menAt(teamId).filter((m) => !m.frozen);
  /** The club of a rung a new arrival goes to: the emptier one, then the lower id. */
  const emptierClub = (rung: Rung): RungClub =>
    [...rung.clubs].sort((a, b) => (planned.get(a.team_id)?.size ?? 0) - (planned.get(b.team_id)?.size ?? 0) || a.team_id - b.team_id)[0];
  /**
   * The rung a man moves up to: the one above his planned rung, or, when its
   * cap closes it to him, the first rung above that admits him this season
   * and next (§4, "the first eligible rung above"). A DSL man at three years
   * is over the Complex cap by Opening Day, but Single-A takes four. Never
   * the big club, which only a call-up fills.
   */
  const stepUpOf = (man: Man): Rung | null => {
    const here = plannedRung(man);
    if (!here || here === 'ic' || here === 'mlb') return null;
    let r = rungAbove(here);
    while (r && r.key !== 'mlb' && !eligibleAt(man, r, true).ok) r = rungAbove(r.key);
    return r && r.key !== 'mlb' ? r : null;
  };
  /** The rungs above his own that their caps close to him, up to the one he may move to. */
  const closedAbove = (man: Man): Rung[] => {
    const out: Rung[] = [];
    if (man.rung === null || man.rung === 'ic' || man.rung === 'mlb') return out;
    for (let r = rungAbove(man.rung); r && r.key !== 'mlb' && !eligibleAt(man, r, true).ok; r = rungAbove(r.key)) out.push(r);
    return out;
  };
  /** "The Complex (capped at 3) is closed to him: he will have 4 pro service years by Opening Day 2031". */
  const closedWords = (man: Man, closed: readonly Rung[]): string =>
    `${capitalise(listOf(closed.map((r) => `${LEVEL_AT[r.key]} (capped at ${r.cap})`)))} ${closed.length === 1 ? 'is' : 'are'} closed to him: he will have ${(man.proYears ?? 0) + 1} pro service years by Opening Day ${cal.season + 1}`;
  const groupHave = (teamId: number, group: StructureGroup, without: Man | null = null): number =>
    healthyAt(teamId).filter((m) => m !== without && inGroup(m, group)).length;
  /** The structure minimum his removal would break, or null. */
  const breaksStructure = (man: Man, teamId: number): StructureGroup | null => {
    const rung = clubRung.get(teamId);
    if (!rung?.structure || man.frozen) return null;
    for (const g of STRUCTURE_GROUPS) {
      if (inGroup(man, g) && groupHave(teamId, g) - 1 < rung.structure.min[g]) return g;
    }
    return null;
  };
  /** Every structure minimum his removal would break, in the order the groups are filled. */
  const brokenGroups = (man: Man, teamId: number): StructureGroup[] => brokenBeside(man, teamId, []);
  /** The same, with other men of the club already counted as gone. */
  const brokenBeside = (man: Man, teamId: number, gone: readonly Man[]): StructureGroup[] => {
    const rung = clubRung.get(teamId);
    if (!rung?.structure || man.frozen) return [];
    const others = gone.filter((x) => x !== man && x.plannedTeam === teamId && !x.frozen);
    return STRUCTURE_GROUPS.filter((g) =>
      inGroup(man, g) && groupHave(teamId, g) - others.filter((x) => inGroup(x, g)).length - 1 < rung.structure!.min[g]);
  };
  const seasonEndOf = (man: Man): string | null => {
    const club = rungList.flatMap((r) => r.clubs).find((c) => c.team_id === man.teamId);
    return (club && cal.seasonEnd.get(club.league_id)) ?? cal.seasonEnd.get(mlbLeagueId) ?? null;
  };
  const deadlineOf = (kind: Deadline['kind'], date: string | null, what: string): Deadline | null => {
    const d = parseDate(date);
    return d ? { kind, date: fmtDate(d), what, daysAway: daysBetween(cal.today, d) } : null;
  };
  const keyOf = (kind: MoveKind, man: Man, from: string, to: string): string => `${kind}:${man.id}:${from}:${to}`;

  const drafts: Draft[] = [];
  /**
   * The one key a man's 40-man question carries, whether the card is his
   * protection or the hold that stands in for it. It names the man alone, not
   * the club he plays for: the question is the same after a promotion, so a
   * protection accepted at Double-A still attaches once he is at Triple-A.
   */
  const fortyKeyOf = (man: Man): string => `protect:${man.id}:40man`;
  const draft = (d: Omit<Draft, 'key' | 'tail' | 'linked'> & Partial<Pick<Draft, 'tail' | 'linked'>>): Draft => {
    const key = d.fortyQuestion ? fortyKeyOf(d.man) : keyOf(d.kind, d.man, d.from.rung, d.to.rung);
    const full: Draft = { ...d, key, tail: d.tail ?? [], linked: d.linked ?? [] };
    drafts.push(full);
    if (['forced', 'promote', 'demote', 'cover', 'assign', 'callup', 'senddown'].includes(d.kind)) d.man.draft = full;
    else d.man.extra.push(full);
    return full;
  };
  const holdOf = (
    man: Man, to: Draft['to'], lead: string[], judgedAt: RungKey,
    opts: { deadline?: Deadline | null; fortyQuestion?: boolean; leads?: boolean } = {}
  ): Draft =>
    draft({
      kind: 'hold', horizon: 'now', forced: false, man, from: { rung: man.rung!, teamId: man.ic ? null : man.teamId }, to, lead,
      judgedAt, fit: fitAt(man, judgedAt), deadline: opts.deadline ?? null, verify: null, fortyMan: null,
      ...(opts.fortyQuestion ? { fortyQuestion: true } : {}),
      ...(opts.leads ? { leads: true } : {}),
    });
  /**
   * A rung move. A `now` move places the man at the destination; an
   * offseason one leaves him where he is for this season's rosters and
   * records where he goes, since the level cards describe the clubs as they
   * should stand today and the winter's moves are folded under their own
   * horizon. Either way he is pinned: the balance never moves him again.
   * With `stay`, the card is made but he is planned where he is, pinned
   * there: a call-up the user dismissed keeps its card, so the dismissal
   * keeps a live key, but nobody plans him at the big club.
   */
  const moveTo = (
    man: Man, kind: MoveKind, rung: Rung, club: RungClub, lead: string[],
    opts: { horizon?: Horizon; forced?: boolean; deadline?: Deadline | null; tail?: string[]; stay?: boolean } = {}
  ): Draft => {
    // A promotion past a rung its cap closes to him says so, after the reason he moves
    const closed = kind === 'promote' || kind === 'cover' ? closedAbove(man).filter((r) => r.rank > rung.rank) : [];
    const tail = closed.length
      ? [`${closedWords(man, closed)}, so ${LEVEL_AT[rung.key]} is the first level above ${LEVEL_AT[man.rung!]} that admits him.`, ...(opts.tail ?? [])]
      : opts.tail;
    if ((opts.horizon ?? 'now') === 'now' && !opts.stay) place(man, club.team_id);
    else man.moved = true;
    return draft({
      kind, horizon: opts.horizon ?? 'now', forced: opts.forced ?? false, man,
      from: { rung: man.rung!, teamId: man.ic ? null : man.teamId },
      to: { rung: rung.key, teamId: club.team_id, label: club.label }, lead, tail,
      judgedAt: rung.key, fit: fitAt(man, rung.key), deadline: opts.deadline ?? null,
      verify: { field: 'rung', expect: rung.key }, fortyMan: null,
    });
  };

  // ── Step 4: forced moves ──
  /** Cap dates the strip prints for men whose card cannot carry them: frozen men, and a forced move that must be made again. */
  const capDeadlines: DeadlineRow[] = [];
  const capped = men.filter((m) => m.rung !== null && m.rung !== 'ic' && m.rung !== 'mlb' && byKey.get(m.rung)!.cap !== null);
  const levelBad = new Set<RungKey>();
  for (const man of capped) {
    if (man.frozen || man.capState === 'ok') continue;
    const here = byKey.get(man.rung!)!;
    const cap = here.cap!;
    const years = man.proYears ?? 0;
    if (man.capState === 'over') {
      levelBad.add(here.key);
      // The first rung above he may play at this season and next; a rung he
      // could play at only until Opening Day is passed over, and named, so the
      // move does not leave him in his last eligible season somewhere new
      let dest: Rung | null = rungAbove(here.key);
      const passed: Rung[] = [];
      while (dest && !eligibleAt(man, dest, true).ok) {
        if (eligibleAt(man, dest, false).ok) passed.push(dest);
        dest = rungAbove(dest.key);
      }
      // No rung above passes both: the first he may play at this season, and
      // the card says he must move again
      let again: Rung | null = null;
      if (!dest) {
        dest = passed[0] ?? null;
        again = dest;
        passed.length = 0;
      }
      if (!dest) continue;
      const club = emptierClub(dest);
      const next = cal.season + 1;
      const lead = passed.length
        ? `He is over the ${LEVEL_ADJ[here.key]} cap today: ${years} pro service years against a cap of ${cap}, so the roster is invalid until he moves, and the first level he may play at this season and next is ${LEVEL_AT[dest.key]}: ${listOf(passed.map((r) => `${LEVEL_AT[r.key]} is capped at ${r.cap}`))}, and he will have ${years + 1} by Opening Day ${next}.`
        : `He is over the ${LEVEL_ADJ[here.key]} cap today: ${years} pro service years against a cap of ${cap}, so the roster is invalid until he moves, and the first level he may play at is ${LEVEL_AT[dest.key]}.`;
      const tail: string[] = [];
      if (again) {
        const end = seasonEndOf(man);
        tail.push(`He will be over the ${LEVEL_ADJ[again.key]} cap of ${again.cap} too by Opening Day ${next}, with ${years + 1} pro service years, so he must move again before then${end ? ` (the season ends ${end})` : ''}.`);
        if (end) {
          capDeadlines.push({
            date: fmtDate(parseDate(end)!), what: `Over the ${LEVEL_ADJ[again.key]} cap next season — must move again before Opening Day ${next}`,
            player_id: man.id, name: man.name, moveKey: null,
          });
        }
      }
      moveTo(man, 'forced', dest, club, [lead], {
        forced: true, tail,
        deadline: deadlineOf('service-cap', fmtDate(cal.today), `Over the ${LEVEL_ADJ[here.key]} cap — must move to ${LEVEL_AT[dest.key]} or above now`),
      });
      continue;
    }
    // His last eligible season here: the first rung above he may open next year at
    let dest: Rung | null = rungAbove(here.key);
    const blockers: Rung[] = [];
    while (dest && !eligibleAt(man, dest, true).ok) {
      blockers.push(dest);
      dest = rungAbove(dest.key);
    }
    if (!dest) continue;
    const next = cal.season + 1;
    const fit = fitAt(man, dest.key);
    const horizon: Horizon = fit !== null && fit >= STRONG_FIT ? 'now' : 'offseason';
    const deadline = deadlineOf(
      'service-cap', seasonEndOf(man),
      `Last eligible season at ${LEVEL_AT[here.key]} — must be at ${LEVEL_AT[dest.key]} or above by Opening Day ${next}`
    );
    if (blockers.length === 0) {
      const lead = [
        `This is his last eligible season at ${LEVEL_AT[here.key]}: ${years} of ${cap} pro service years against the ${LEVEL_ADJ[here.key]} cap, so he must open ${next} at ${LEVEL_AT[dest.key]} or above.`,
      ];
      if (horizon === 'now') lead.push('He has earned the move now, so it is dated today rather than at the deadline.');
      moveTo(man, 'forced', dest, emptierClub(dest), lead, { forced: true, horizon, deadline });
      continue;
    }
    // "Two steps up" counts the rungs he has to skip past the next one
    const steps = blockers.length;
    const capsWord = listOf(blockers.map((b) => `${LEVEL_AT[b.key]} capped at ${b.cap}`));
    const sentence =
      `This is his last eligible season at ${LEVEL_AT[here.key]}: ${years} of ${cap} pro service years against the ${LEVEL_ADJ[here.key]} cap, and with ${capsWord} the first level he may open ${next} at is ${LEVEL_AT[dest.key]}, ${stepsUp(steps)}`;
    if (fit !== null && fit >= PROMOTE_FIT) {
      moveTo(man, 'forced', dest, emptierClub(dest), [`${sentence}.`], { forced: true, horizon, deadline });
    } else {
      // He plays out the season where he is — the cap binds from Opening Day —
      // and leaves through the release-or-trade list by then; pinned, so the
      // balance neither counts on moving him nor moves him
      man.capOut = `${sentence}, and at ${man.age} with a ${grade(man.oa)} grade he is not close to it.`;
      man.moved = true;
    }
  }

  // The complex pool: the age rule, then the room rule
  const icPool = men.filter((m) => m.ic).sort((a, b) => b.age - a.age || (b.pot ?? -1) - (a.pot ?? -1) || a.id - b.id);
  const dslRung = byKey.get('dsl') ?? null;
  const complexRung = byKey.get('complex') ?? null;
  const icDestination = (): { rung: Rung; club: RungClub } | null => {
    const rung = dslRung ?? complexRung;
    return rung && rung.clubs.length ? { rung, club: emptierClub(rung) } : null;
  };
  for (const man of icPool) {
    const born = parseDate(man.p.date_of_birth);
    const twentieth = born ? addYears(born, settings.icMaxAge) : null;
    const soon = twentieth !== null && daysBetween(cal.today, twentieth) <= BIRTHDAY_WINDOW_DAYS;
    if (man.age < settings.icMaxAge - 1 && !soon) continue;
    const dest = icDestination();
    if (!dest) break;
    const birthdayWord = twentieth ? fmtDate(twentieth) : 'a date the export does not carry';
    const d = moveTo(man, 'assign', dest.rung, dest.club, [
      `He turns ${settings.icMaxAge} on ${birthdayWord}, when OOTP moves him out of the international complex by itself, so he is placed now: at ${man.age} with a ${grade(man.oa)} grade and a ${grade(man.pot)} ceiling he goes to ${dest.club.label} (${LEVEL_TAG[dest.rung.key]}).`,
    ], {
      forced: true, deadline: deadlineOf('ic-age', twentieth ? fmtDate(twentieth) : null, `${settings.icMaxAge}th birthday — OOTP promotes him out of the complex`),
    });
    // OOTP may send a complex man straight to the ACL; any club counts
    d.verify = { field: 'rostered', expect: true };
  }
  const poolSize = icPool.length;
  if (poolSize >= settings.icSize) {
    const eighteen = icPool.filter((m) => !m.moved && m.age === settings.icMaxAge - 2).sort((a, b) => (b.pot ?? -1) - (a.pot ?? -1) || a.id - b.id)[0];
    const dest = icDestination();
    if (eighteen && dest && dest.rung.target && (planned.get(dest.club.team_id)?.size ?? 0) < dest.rung.target.max) {
      const d = moveTo(eighteen, 'assign', dest.rung, dest.club, [
        `The international complex is at capacity: the pool is full at ${poolSize} of ${settings.icSize}, so the scout finds nobody until a place opens; he is the best ${eighteen.age}-year-old in it by ceiling (${grade(eighteen.pot)}) and goes to ${dest.club.label} before the ${LEVEL_TAG[dest.rung.key]} season opens${cal.dslStart ? ` on ${cal.dslStart}` : ''}.`,
      ], { deadline: deadlineOf('ic-room', cal.dslStart ?? cal.openingDay, 'Complex pool full — a place opens when he is assigned') });
      d.verify = { field: 'rostered', expect: true };
    }
  }

  // The 60-day list, when the 40 is full and a man is out long enough
  const fortyCount = crunch?.counts.fortyMan ?? 0;
  const fortyFull = fortyCount >= cal.fortyLimit;
  const il60Candidates = men
    .filter((m) => m.on40 && !m.il60 && m.onIl && (m.daysLeft ?? 0) >= SIXTY_DAY_IL)
    .sort((a, b) => (b.daysLeft ?? 0) - (a.daysLeft ?? 0) || a.id - b.id);
  const il60For = (man: Man, why: string): void => {
    if (man.extra.some((d) => d.kind === 'il60')) return;
    draft({
      kind: 'il60', horizon: 'now', forced: true, man, from: { rung: man.rung!, teamId: man.teamId },
      to: { rung: man.rung!, teamId: man.teamId, label: '60-day injured list' },
      lead: [`${why} He is out for about ${man.daysLeft} more days, past the 60 the long list asks, so moving him there frees a 40-man place without losing him.`],
      judgedAt: man.rung!, fit: fitAt(man, man.rung!), deadline: null, verify: { field: 'il60', expect: true }, fortyMan: null,
    });
  };
  if (fortyFull) for (const man of il60Candidates) il60For(man, `The 40-man is full at ${fortyCount} of ${cal.fortyLimit}.`);

  /*
   * The 40-man as the plan fills it, kept in one ledger that every card reads
   * its count from. A call-up takes a place today. A protection takes one by
   * the Rule 5 draft, so it may also count a place the plan itself frees
   * before then: a man on the 40-man whom the plan trades or releases by an
   * earlier date, unless that move was dismissed. The count each card states
   * is the count after the cards above it, which are listed in the order they
   * claimed. Once the open places run out, a card takes the next man who can
   * cheaply give his up, each of them once, and never a man the plan already
   * lets go, whose place is counted as freed; when there is nobody left, the
   * card becomes a hold that says the 40-man would be full. A claim given back
   * opens its place again for the cards after it.
   */
  type ComesOff = { player_id: number; name: string; why: string };
  type FortyUse = 'callup' | 'protect';
  interface FortyClaim { before: number; above: string | null; freed: string; comesOff: ComesOff | null; full: boolean }
  const decided = planDecisions(orgId);
  /** What the user said about a move, while it still applies: a decision an import settled is used up. */
  const decisionOn = (key: string): 'accepted' | 'dismissed' | null => {
    const d = decided.get(key);
    return d && decisionLive(d) ? d.state : null;
  };
  /** A call-up the user dismissed: it puts nobody on the 40-man, so his 40-man question is still open. */
  const callupDismissed = (man: Man): boolean => man.draft?.kind === 'callup' && decisionOn(man.draft.key) === 'dismissed';
  const ledger = {
    taken: room?.count ?? fortyCount,
    offQueue: [...(room?.offList ?? [])] as ComesOff[],
    /** Men a claim has already put in play to come off, so the plan's own trade of one of them frees nothing more. */
    usedOff: new Set<number>(),
    added: { callup: 0, protect: 0 } as Record<FortyUse, number>,
    /** Men on the 40-man the plan lets go before the Rule 5 draft. */
    freed: [] as Array<{ man: Man; kind: 'trade' | 'release' }>,
    /**
     * Each claim, by the man who made it, so it can be given back. A cleared
     * claim is an accepted protection made with the 40-man full: it counts
     * among the protections above the cards after it, on a place the user
     * clears by hand, so it takes neither an open place nor a man in line.
     */
    claims: new Map<number, { use: FortyUse; comesOff: ComesOff | null; cleared?: boolean }>(),
  };
  /** "the two call-ups and the protection above", or null when nothing above took a place. */
  const addedAbove = (): string | null => {
    const parts: string[] = [];
    if (ledger.added.callup) parts.push(ledger.added.callup === 1 ? 'the call-up' : `the ${word(ledger.added.callup)} call-ups`);
    if (ledger.added.protect) parts.push(ledger.added.protect === 1 ? 'the protection' : `the ${word(ledger.added.protect)} protections`);
    return parts.length ? `${listOf(parts)} above` : null;
  };
  /** ", counting the place the trade of X frees", for a protection; empty when the plan frees none. */
  const freedWords = (use: FortyUse): string => {
    if (use !== 'protect' || ledger.freed.length === 0) return '';
    // "the trades of A and B and the release of C"
    const moves = (['trade', 'release'] as const).flatMap((kind) => {
      const names = ledger.freed.filter((f) => f.kind === kind).map((f) => f.man.name);
      return names.length ? [`the ${plural(names.length, kind)} of ${listOf(names)}`] : [];
    });
    return ledger.freed.length === 1 ? `, counting the place ${moves[0]} frees` : `, counting the places ${listOf(moves)} free`;
  };
  /** Where the count stands for one more addition, without taking anything. */
  const peekPlace = (use: FortyUse): FortyClaim => {
    const before = ledger.taken - (use === 'protect' ? ledger.freed.length : 0);
    const above = addedAbove();
    const freed = freedWords(use);
    if (before < cal.fortyLimit) return { before, above, freed, comesOff: null, full: false };
    const off = ledger.offQueue[0] ?? null;
    return { before, above, freed, comesOff: off, full: off === null };
  };
  /**
   * Takes a place for one addition: an open one, else the next man who can
   * give his up, else none. With `cleared` (an accepted protection) a full
   * 40-man still counts him, on a place to be cleared by hand, so the cards
   * after him count every protection listed above them.
   */
  const claimPlace = (man: Man, use: FortyUse, cleared = false): FortyClaim => {
    const c = peekPlace(use);
    if (c.full) {
      if (cleared) {
        ledger.added[use]++;
        ledger.claims.set(man.id, { use, comesOff: null, cleared: true });
      }
      return c;
    }
    if (c.comesOff) {
      ledger.offQueue.shift();
      ledger.usedOff.add(c.comesOff.player_id);
    } else {
      ledger.taken++;
    }
    ledger.added[use]++;
    ledger.claims.set(man.id, { use, comesOff: c.comesOff });
    return c;
  };
  /** Gives a claim back: its open place opens again, or the man who was to come off is first in line once more. */
  const releasePlace = (man: Man): void => {
    const c = ledger.claims.get(man.id);
    if (!c) return;
    ledger.claims.delete(man.id);
    if (c.comesOff) {
      ledger.offQueue.unshift(c.comesOff);
      ledger.usedOff.delete(c.comesOff.player_id);
    } else if (!c.cleared) {
      // A cleared claim took no open place and no man in line, so there is none to give back
      ledger.taken--;
    }
    ledger.added[c.use]--;
  };
  /**
   * Counts the place a trade or release of a 40-man man frees, when it is
   * made before the Rule 5 draft and was not dismissed; he no longer stands
   * in line to come off, since he is already going.
   */
  const freePlace = (d: Draft): void => {
    if ((d.kind !== 'trade' && d.kind !== 'release') || !d.man.on40 || d.man.il60 || ledger.usedOff.has(d.man.id)) return;
    if (decisionOn(d.key) === 'dismissed') return;
    const r5 = parseDate(cal.rule5);
    const by = d.deadline ? parseDate(d.deadline.date) : d.horizon === 'now' ? cal.today : null;
    if (!r5 || !by || dateKey(by) >= dateKey(r5)) return;
    ledger.freed.push({ man: d.man, kind: d.kind });
    ledger.offQueue = ledger.offQueue.filter((o) => o.player_id !== d.man.id);
  };
  /** "holds 36 of 40" / "would hold 37 of 40 after the protection above, counting the place the trade of X frees". */
  const holdsWords = (c: FortyClaim): string =>
    c.above || c.freed
      ? `would hold ${c.before} of ${cal.fortyLimit}${c.above ? ` after ${c.above}` : ''}${c.freed}`
      : `holds ${c.before} of ${cal.fortyLimit}`;
  /** "is full at 40 of 40" / "would be full: 40 of 40 after the five protections above". */
  const fullWords = (c: FortyClaim): string =>
    c.above || c.freed
      ? `would be full: ${c.before} of ${cal.fortyLimit}${c.above ? ` after ${c.above}` : ''}${c.freed}`
      : `is full at ${c.before} of ${cal.fortyLimit}`;

  // Out of options on the 26: a flag, never a move
  for (const man of men) {
    if (man.on26 && man.optionState === 'out-of-options') {
      man.flags.push('Out of options: cannot be sent down without clearing waivers');
    }
  }

  // ── Step 5: the 26 as it stands, swaps through correspondingMoves ──
  const aaa = rungBelow('mlb');
  if (aaa) {
    const verdicts = correspondingMoves(orgId, players, seasonBat, seasonPit);
    const takenSpots = new Set<number>();
    const candidates = men
      .filter((m) => m.rung !== null && m.rung !== 'mlb' && m.rung !== 'ic' && !m.frozen && !m.moved && !formPoor(m))
      .filter((m) => {
        const v = verdicts.get(m.id);
        const f = fitAt(m, 'mlb');
        return !!v && !v.blocked && f !== null && f >= PROMOTE_FIT;
      })
      .sort(tieBreak('mlb'));
    for (const man of candidates) {
      const spot = man.position === 1 ? 1 : man.position;
      if (takenSpots.has(spot)) continue;
      const v = verdicts.get(man.id)!;
      const displaced = v.replaces ? byId.get(v.replaces.player_id) ?? null : null;
      const lead = [`${capitalise(v.note.split(';')[0])}, with a fit of ${fit2(fitAt(man, 'mlb'))} at the big club.`];
      if (coversThinnest(man)) lead.push(`Ahead of the other candidates because the big club is thinnest at ${listOf(thinnest)}, and he covers it.`);
      const toMlb: Draft['to'] = { rung: 'mlb', teamId: orgId, label: mlb.clubs[0]?.label ?? 'the big club' };
      if (displaced && displaced.optionState !== 'sendable' && displaced.optionState !== 'last-option-year') {
        const why = displaced.optionState === 'never-sendable'
          ? `${displaced.serviceYears.toFixed(1)} years of major-league service let him refuse the assignment`
          : `${displaced.optionsUsed ?? 0} of 3 options used and none this year, so a send-down means waivers`;
        holdOf(man, toMlb, [`Would take ${displaced.name}'s place on the 26, but ${displaced.name} cannot be optioned: ${why}.`, ...lead], 'mlb');
        takenSpots.add(spot);
        continue;
      }
      let fortyMan: MoveFortyMan | null = null;
      // A call-up the user dismissed takes no place and moves nobody: its card
      // is still made, so the dismissal keeps its move, but the cards after it
      // count without it, he stays where he is, and nobody is sent down for him
      const dismissed = decisionOn(keyOf('callup', man, man.rung!, 'mlb')) === 'dismissed';
      if (!man.on40 && room) {
        const place = dismissed ? peekPlace('callup') : claimPlace(man, 'callup');
        // Dismissed, it stays a call-up card whatever the count, so the dismissal keeps its key
        if (place.full && !dismissed) {
          holdOf(man, toMlb, [`Would take a place on the 26, but the 40-man ${fullWords(place)} and nobody on it can cheaply give up his place.`, ...lead], 'mlb');
          takenSpots.add(spot);
          continue;
        }
        fortyMan = { count: place.before, limit: cal.fortyLimit, comesOff: place.comesOff };
        if (place.full) {
          lead.push(`He is not on the 40-man, which ${fullWords(place)}, and nobody on it can cheaply give up his place.`);
        } else if (place.comesOff) {
          lead.push(`He is not on the 40-man, which ${fullWords(place)}; ${place.comesOff.name} is the place (${place.comesOff.why}).`);
          const off = byId.get(place.comesOff.player_id);
          if (off && !dismissed && place.comesOff.why === 'to the 60-day IL') il60For(off, `${man.name}'s call-up needs his 40-man place.`);
        } else {
          lead.push(`He is not on the 40-man, which ${holdsWords(place)}, so a place is open.`);
        }
      }
      takenSpots.add(spot);
      const up = moveTo(man, 'callup', mlb, mlb.clubs[0], lead, { stay: dismissed });
      up.fortyMan = fortyMan;
      if (displaced && !dismissed) {
        const downClub = emptierClub(aaa);
        const options = displaced.optionState === 'last-option-year'
          ? `${displaced.optionsUsed ?? 0} of 3 options used${(displaced.optionsThisYear ?? 0) >= 1 ? ', this year\'s among them' : ''}, so this is his last option year`
          : `${displaced.optionsUsed ?? 0} of 3 options used, so he can be optioned`;
        const down = moveTo(displaced, 'senddown', aaa, downClub, [
          `Makes room for ${man.name} on the 26: ${capitalise(v.note.split(' — ')[0].replace(/^would take .*?'s spot at /, 'the weakest man at '))}, and ${options}.`,
        ]);
        up.linked.push(down.key);
        down.linked.push(up.key);
      }
    }
  }

  // ── Step 6: provisional targets ──
  for (const man of men) {
    if (man.rung === null || man.rung === 'mlb' || man.rung === 'ic' || man.frozen || man.moved) continue;
    // The first rung above that admits him, past any whose cap closes it to him
    const above = stepUpOf(man);
    const below = rungBelow(man.rung);
    const fitHere = fitAt(man, man.rung);
    if (above && !formPoor(man)) {
      const f = fitAt(man, above.key);
      if (f !== null && f >= PROMOTE_FIT) {
        man.target = 'above';
        man.strong = f >= STRONG_FIT;
      }
    }
    const sample = man.isPitcher ? man.seasonIp >= GATES.demoteIp : man.seasonPa >= GATES.demotePa;
    const canOption = !man.on40 || man.optionState === 'sendable' || man.optionState === 'last-option-year';
    if (man.target === 'stay' && below && fitHere !== null && fitHere <= OVERMATCHED_FIT && (zA(man, man.rung) ?? 0) <= 0 &&
      sample && !formGood(man) && eligibleAt(man, below, true).ok && canOption) {
      man.target = 'below';
      man.overmatched = true;
    }
  }

  // ── Step 7: balance ──
  const refused: Man[] = [];
  /** Strong candidates the club below could not spare: its minimum or a group of it stood on them. */
  const needed: Man[] = [];
  const needs = new Map<number, string[]>();
  const addNeed = (teamId: number, note: string) => needs.set(teamId, [...(needs.get(teamId) ?? []), note]);
  const minors = rungList.filter((r) => r.key !== 'mlb' && r.key !== 'ic');
  /**
   * Men free to come up to this rung, best first at it: the men planned at the
   * rung below who may play here this season and next, and a man further down
   * whose rungs between are closed to him by their caps, when his fit here is
   * at least the promotion bar.
   */
  const candidatesBelow = (rung: Rung, pred: (m: Man) => boolean = () => true): Man[] => {
    const below = rungBelow(rung.key);
    if (!below) return [];
    const top = LADDER.indexOf(rung.key);
    return men
      .filter((m) => {
        if (m.moved || m.frozen || m.overmatched || formPoor(m)) return false;
        const at = plannedRung(m);
        if (at === null || LADDER.indexOf(at) <= top || stepUpOf(m) !== rung) return false;
        if (at !== below.key && (fitAt(m, rung.key) ?? -Infinity) < PROMOTE_FIT) return false;
        return pred(m);
      })
      .sort(tieBreak(rung.key));
  };
  /**
   * Whether a man's club can let him go without dropping under its size
   * minimum or a structure minimum (§4: balancing never drops a group below
   * its minimum), with other men of his club already counted as gone: the
   * refills promised from it.
   */
  const freeBeside = (m: Man, gone: readonly Man[]): boolean => {
    const from = typeof m.plannedTeam === 'number' ? m.plannedTeam : null;
    const fromRung = from === null ? null : clubRung.get(from) ?? null;
    if (from === null || !fromRung?.target) return true;
    const others = gone.filter((x) => x !== m && x.plannedTeam === from && !x.frozen);
    if ((planned.get(from)?.size ?? 0) - others.length <= fromRung.target.min) return false;
    if (!fromRung.structure || m.frozen) return true;
    return !STRUCTURE_GROUPS.some((g) =>
      inGroup(m, g) && groupHave(from, g) - others.filter((x) => inGroup(x, g)).length - 1 < fromRung.structure!.min[g]);
  };
  /**
   * Men a pull has already counted on to refill the club it took from, with
   * that club and the groups he refills there (none when only its size stood
   * on the man taken): nobody is promised twice.
   */
  const promised = new Map<number, { club: number; groups: StructureGroup[] }>();
  /**
   * The promised men still owed: not yet moved, and the club they refill
   * still short of what they were promised for. A club is judged with the
   * men it is itself to send up as refills counted as gone, since they are
   * leaving: a club that reads whole only because a man owed elsewhere has
   * not left yet is still owed its refill. Once another man has brought that
   * club back to its minimum the promise is spent, and the man is free for
   * any pull again. Dropping a spent promise can leave another club whole, so
   * the reading is repeated until nothing more drops.
   */
  const owed = (): Man[] => {
    let live = [...promised.keys()].map((id) => byId.get(id)!).filter((x) => !x.moved);
    for (;;) {
      const still = live.filter((x) => {
        const p = promised.get(x.id)!;
        const r = clubRung.get(p.club);
        if (!r?.target) return false;
        const away = live.filter((y) => y.plannedTeam === p.club && !y.frozen);
        return p.groups.length
          ? p.groups.some((g) => groupHave(p.club, g) - away.filter((y) => inGroup(y, g)).length < r.structure!.min[g])
          : (planned.get(p.club)?.size ?? 0) - away.length < r.target.min;
      });
      if (still.length === live.length) return live;
      live = still;
    }
  };
  /** The club a man is still owed to as a refill, or null. */
  const owedTo = (m: Man, live: readonly Man[] = owed()): number | null =>
    live.includes(m) ? promised.get(m.id)!.club : null;
  /**
   * Whether a man may leave his club for the given club now that the men
   * owed as refills count as gone from theirs: a pull, a promotion on merit
   * or a trade fill never takes the free place a promise to another club
   * counted on. A man owed as a refill may go only to the club he is owed
   * to, and goes there freely, since his leaving was counted when he was
   * promised; null (a trade fill) is no club he is owed to.
   */
  const freeFor = (m: Man, club: number | null): boolean => {
    const live = owed();
    const to = owedTo(m, live);
    return to !== null ? to === club : freeBeside(m, live);
  };
  /**
   * The men below who would refill his club if a pull took him: none when
   * his club can let him go as it is, or when he is himself a refill whose
   * leaving was counted when he was promised; null when it cannot be
   * refilled. A club at its minimum may still give a man up when the rung
   * under it has someone free to fill the place in its own turn, one for
   * every group his leaving would break, each a man no other pull has counted
   * on; at the bottom of the ladder nothing refills a club, so the DSL is
   * never drained to fill the Complex.
   */
  const refillsFor = (m: Man): Man[] | null => {
    // The men still owed to other clubs count as gone from theirs
    const already = owed();
    if (already.includes(m) || freeBeside(m, already)) return [];
    const from = m.plannedTeam as number;
    const fromRung = clubRung.get(from)!;
    if (!rungBelow(fromRung.key)) return null;
    const broken = brokenBeside(m, from, already);
    // A refill must be free to go with the men already promised from his own club gone too,
    // and is never a man another pull already counts on
    const pool = candidatesBelow(fromRung).filter((x) => !already.includes(x));
    const free = (x: Man, picks: readonly Man[]): boolean => freeBeside(x, [...already, ...picks]);
    const fits = (x: Man, g: StructureGroup): boolean => inGroupAt(x, g, fromRung.key);
    // One man who fills every broken group, when there is one; else one for each
    const all = broken.length > 1 ? pool.find((x) => broken.every((g) => fits(x, g)) && free(x, [])) : undefined;
    if (all) return [all];
    const picks: Man[] = [];
    for (const g of broken) {
      if (picks.some((x) => fits(x, g))) continue;
      const x = pool.find((y) => !picks.includes(y) && fits(y, g) && free(y, picks));
      if (!x) return null;
      picks.push(x);
    }
    // Only the size minimum stood on him: any man free to come up refills it
    if (picks.length === 0) {
      const x = pool.find((y) => free(y, []));
      if (!x) return null;
      picks.push(x);
    }
    return picks;
  };
  /**
   * Whether a pull for the given club may take him. A man owed as a refill
   * is taken only by the club he is owed to; with no club named, never.
   */
  const canSpare = (m: Man, club: number | null = null): boolean => {
    const to = owedTo(m);
    return to !== null ? to === club : refillsFor(m) !== null;
  };
  /**
   * Takes him for a pull: the men his club counts on to refill it are
   * promised to it. A man already promised elsewhere is never among them
   * (refillsFor leaves out every promise still owed), so no promise is
   * written over while it is owed.
   */
  const spare = (m: Man): void => {
    const refills = refillsFor(m) ?? [];
    if (refills.length === 0) return;
    const from = m.plannedTeam as number;
    const rung = clubRung.get(from)!;
    const groups = brokenBeside(m, from, owed());
    for (const x of refills) promised.set(x.id, { club: from, groups: groups.filter((g) => inGroupAt(x, g, rung.key)) });
  };
  /** Injured men who already have their cover: one injury opens one cover, never more. */
  const covered = new Set<number>();
  const injuredOf = (teamId: number, which: (m: Man) => boolean): Man | null =>
    menAt(teamId).filter((m) => m.onIl && which(m) && !covered.has(m.id))
      .sort((a, b) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999) || a.id - b.id)[0] ?? null;
  const returnWords = (hurt: Man): string =>
    hurt.daysLeft !== null
      ? `for about ${hurt.daysLeft} more days (back around ${fmtDate(addDays(cal.today, hurt.daysLeft))})`
      : 'with no return date in the export';
  /**
   * Fills one place at a club from below, with the best man whose own club
   * can spare him: a cover when an injured man who would fill the place
   * opened it and nobody covers him yet, a promote otherwise. The first pull
   * for a group is the best man below, so the cover goes to him; a shortfall
   * bigger than the injuries is filled by ordinary promotions that say why,
   * and the cover's sentence says the injury is one place of several.
   */
  const pullFor = (
    rung: Rung, club: RungClub, lead: (m: Man) => string, pred: (m: Man) => boolean,
    hurtBy: (h: Man) => boolean, coverLead: (hurt: Man) => string
  ): boolean => {
    const man = candidatesBelow(rung, pred).find((m) => canSpare(m, club.team_id));
    if (!man) return false;
    spare(man);
    const hurt = injuredOf(club.team_id, hurtBy);
    if (hurt) {
      covered.add(hurt.id);
      moveTo(man, 'cover', rung, club, [coverLead(hurt)]);
    } else {
      moveTo(man, 'promote', rung, club, [lead(man)]);
    }
    return true;
  };
  /** The cover sentence for a group short of its minimum: the injury alone, or one place of a bigger shortfall. */
  const groupCoverLead = (club: RungClub, rung: Rung, g: StructureGroup) => (hurt: Man): string => {
    const have = groupHave(club.team_id, g);
    const need = rung.structure!.min[g];
    const words = (n: number) => plural(n, GROUP_WORD[g].one, GROUP_WORD[g].many);
    const out = `${hurt.name} is on the injured list at ${club.label} ${returnWords(hurt)}`;
    if (have + 1 >= need) {
      return `${out}, leaving ${word(have)} healthy ${words(have)} against the ${word(need)} the level needs, so he covers until ${hurt.name} returns.`;
    }
    const still = need - have - 1;
    return `${out}. ${club.label} has ${word(have)} healthy ${words(have)} against the ${word(need)} the level needs and would still be ${word(still)} short with him back, so one place is his to cover until ${hurt.name} returns; the other ${still === 1 ? 'is' : 'are'} filled by promotion.`;
  };
  const pushDown = (man: Man, lead: string): boolean => {
    const here = plannedRung(man);
    if (!here) return false;
    let dest: Rung | null = rungBelow(here);
    while (dest && !eligibleAt(man, dest, true).ok) dest = rungBelow(dest.key);
    if (!dest) {
      const tried = rungBelow(here);
      man.pushedOut = `${lead} He is eligible at no level below${tried ? ` (${eligibleAt(man, tried, true).why})` : ''}, so he leaves through the release-or-trade list.`;
      place(man, 'out');
      return true;
    }
    moveTo(man, 'demote', dest, emptierClub(dest), [`${lead} He is eligible at ${LEVEL_AT[dest.key]}, so he goes down rather than out.`]);
    return true;
  };

  const balanceRung = (rung: Rung): boolean => {
    let changed = false;
    const band = rung.target!;
    const structure = rung.structure!;
    // 1. Demotes out, where the structure can spare the man
    for (const club of rung.clubs) {
      for (const man of menAt(club.team_id).filter((m) => m.target === 'below' && !m.moved).sort((a, b) => (fitAt(a, rung.key) ?? 0) - (fitAt(b, rung.key) ?? 0) || a.id - b.id)) {
        // A man owed as a refill above stays for it, and the men owed away count as gone
        const live = owed();
        if (live.includes(man) || brokenBeside(man, club.team_id, live).length) continue;
        const base = baselines[rung.key];
        const sample = man.isPitcher ? `${Math.round(man.seasonIp)} IP` : `${man.seasonPa} PA`;
        changed = pushDown(man,
          `Overmatched at ${LEVEL_AT[rung.key]}: a fit of ${fit2(fitAt(man, rung.key))} on ${sample} this season, and at ${man.age} he is not young for the level (median ${base.medAge ?? '?'}).`
        ) || changed;
      }
    }
    /*
     * The rules first and readiness after, the order the design gives a rung:
     * the field, the groups and the hard minimum are filled before anyone is
     * promoted on merit. Run the other way round, the merit promotions took
     * the men the structure pulls then needed, and at the DSL, where nothing
     * below refills a club, both clubs ended under their minimum.
     */
    for (const club of rung.clubs) {
      const t = club.team_id;
      // 2. Cover the field: every position has a healthy man who covers it today
      for (const pos of FIELD) {
        if (healthyAt(t).some((m) => m.coversNow.has(pos))) continue;
        // A catcher is counted by his listing, not his rating: a club carrying
        // its catchers is covered even when they are teenagers rated under 40
        // behind the plate, and a pull here would contradict the C row beside it
        if (pos === 2 && groupHave(t, 'C') >= structure.min.C) continue;
        const posName = POSITION_NAMES[pos];
        changed = pullFor(rung, club,
          (m) => `Nobody healthy on the planned ${club.label} roster covers ${posName}; he is rated ${grade(m.fielding.get(pos)?.cur ?? null)} there, the best eligible man below (fit ${fit2(fitAt(m, rung.key))} at ${LEVEL_AT[rung.key]}).`,
          (m) => m.coversNow.has(pos),
          // Only an injured man who plays the position opened it
          (h) => h.coversNow.has(pos),
          pos === 2
            ? groupCoverLead(club, rung, 'C')
            : (hurt) => `${hurt.name} is on the injured list at ${club.label} ${returnWords(hurt)}, and nobody healthy on the planned roster covers ${posName} without him, so he covers until ${hurt.name} returns.`) || changed;
      }
      // 3. Each group to its minimum
      for (const g of STRUCTURE_GROUPS) {
        while (groupHave(t, g) < structure.min[g]) {
          const have = groupHave(t, g);
          const ok = pullFor(rung, club,
            (m) => `${club.label} is short of ${GROUP_WORD[g].many}: ${word(have)} against the ${word(structure.min[g])} the level needs, and he is the best eligible ${GROUP_WORD[g].one} below (fit ${fit2(fitAt(m, rung.key))} at ${LEVEL_AT[rung.key]}).`,
            (m) => inGroupAt(m, g, rung.key),
            (h) => inGroup(h, g),
            groupCoverLead(club, rung, g));
          if (!ok) {
            addNeed(t, `need:${g}:${structure.min[g] - have}`);
            break;
          }
          changed = true;
        }
      }
      // 4. Under the minimum, which is hard: pull by fit, cap-expiring men first
      while ((planned.get(t)?.size ?? 0) < band.min) {
        const size = planned.get(t)?.size ?? 0;
        const man = candidatesBelow(rung).sort((a, b) =>
          Number(b.capState === 'last-season') - Number(a.capState === 'last-season') || tieBreak(rung.key)(a, b)).find((m) => canSpare(m, t));
        if (!man) {
          addNeed(t, `size:${band.min - size}`);
          break;
        }
        spare(man);
        moveTo(man, 'promote', rung, club, [
          `${club.label} would open at ${size} against a minimum of ${band.min}, so he comes up to fill it: the best eligible man below by fit (${fit2(fitAt(man, rung.key))} at ${LEVEL_AT[rung.key]}).`,
        ]);
        changed = true;
      }
    }
    // 5. Promotes on merit, while the club has room under its soft maximum.
    // A strong candidate also counts as room the surplus men the size step
    // below moves out, so a club the structure pulls have just filled still
    // takes a man who has earned it in place of one who has no job there
    const surplusOut = (teamId: number): number =>
      healthyAt(teamId).filter((m) => !m.moved && m.assetClass === 'surplus' && !breaksStructure(m, teamId)).length;
    for (const man of candidatesBelow(rung, (m) => m.target === 'above')) {
      const club = emptierClub(rung);
      const size = planned.get(club.team_id)?.size ?? 0;
      if (size >= band.max && (!man.strong || size >= band.max + surplusOut(club.team_id))) {
        if (man.strong && !refused.includes(man)) refused.push(man);
        continue;
      }
      // A promotion on merit never leaves the club below under its minimum or
      // short of a group: the balance never breaks a minimum, and a readiness
      // move is the one kind that nothing requires. The pulls that fill a
      // short club above are the exception, and the rung below then fills
      // itself from below in its own turn.
      // Nor does it take the place a refill promised to another club counted on,
      // nor a man promised as a refill anywhere but this club
      if (!freeFor(man, club.team_id)) {
        if (man.strong && !needed.includes(man)) needed.push(man);
        continue;
      }
      moveTo(man, 'promote', rung, club, [
        `Ready for ${LEVEL_AT[rung.key]}: a fit of ${fit2(fitAt(man, rung.key))} there${man.strong ? ', a strong one' : ''}.`,
      ], {
        tail: [size < band.max
          ? `${club.label} carries ${size} against a band of ${band.min}-${band.max}, so there is room without sending anyone down.`
          : `${club.label} carries ${size} against a band of ${band.min}-${band.max}, so a surplus man there makes room for him.`],
      });
      changed = true;
    }
    // 6. Over the maximum, which is soft: only surplus men leave, lowest fit first
    for (const club of rung.clubs) {
      const t = club.team_id;
      while ((planned.get(t)?.size ?? 0) > band.max) {
        const size = planned.get(t)?.size ?? 0;
        // Never a man owed as a refill above, and the men owed away count as gone
        const live = owed();
        const man = healthyAt(t)
          .filter((m) => !m.moved && m.assetClass === 'surplus' && !live.includes(m) && !brokenBeside(m, t, live).length)
          .sort((a, b) => (fitAt(a, rung.key) ?? -Infinity) - (fitAt(b, rung.key) ?? -Infinity) || a.id - b.id)[0];
        if (!man) break;
        const base = baselines[rung.key];
        changed = pushDown(man,
          `${club.label} is ${size} against a soft maximum of ${band.max}, so only its surplus men leave for size; he is the lowest-fit of them (${fit2(fitAt(man, rung.key))} at ${LEVEL_AT[rung.key]}: ${man.age} against a ${LEVEL_ADJ[rung.key]} median age of ${base.medAge ?? '?'}, ceiling ${grade(man.pot)}).`
        ) || changed;
      }
    }
    return changed;
  };

  let round = 0;
  let changed = true;
  while (changed && round < MAX_ROUNDS) {
    round++;
    changed = false;
    const order = round % 2 === 1 ? minors : [...minors].reverse();
    for (const rung of order) changed = balanceRung(rung) || changed;
  }
  /** Why his own club cannot let him go as it stands: the group or the size minimum he stands on; null when it can. */
  const spareWhy = (man: Man): string | null => {
    if (typeof man.plannedTeam !== 'number') return null;
    const t = man.plannedTeam;
    const here = clubRung.get(t);
    if (!here?.target) return null;
    const group = breaksStructure(man, t);
    if (group) {
      const left = groupHave(t, group) - 1;
      return `would be left with ${word(left)} ${plural(left, GROUP_WORD[group].one, GROUP_WORD[group].many)} against the ${word(here.structure!.min[group])} the level needs`;
    }
    const size = planned.get(t)?.size ?? 0;
    return size <= here.target.min ? `would open at ${size - 1} against its minimum of ${here.target.min}` : null;
  };
  /**
   * What a club still lacks that he would bring: a group under its minimum
   * he would count in there, or a position nobody healthy covers that he
   * does. "short of infielders: two against the three the level needs".
   */
  /** The clause that closes a hold for a man his club cannot spare; at the bottom rung there is nobody below to speak of. */
  const nobodyBelow = (teamId: number): string =>
    rungBelow(clubRung.get(teamId)?.key ?? 'dsl') ? ', and nobody below can take his place there' : '';
  const lacksHim = (man: Man, rung: Rung, club: RungClub): string | null => {
    const t = club.team_id;
    for (const g of STRUCTURE_GROUPS) {
      const have = groupHave(t, g);
      if (have < rung.structure!.min[g] && inGroupAt(man, g, rung.key)) {
        return `is short of ${GROUP_WORD[g].many}: ${word(have)} against the ${word(rung.structure!.min[g])} the level needs`;
      }
    }
    // Catcher is said by its row, which counts listed men: a club at its
    // catcher minimum lacks nobody behind the plate, whatever the ratings
    const pos = FIELD.find((p) => (p !== 2 || groupHave(t, 'C') < rung.structure!.min.C)
      && man.coversNow.has(p) && !healthyAt(t).some((m) => m.coversNow.has(p)));
    return pos === undefined ? null : `has nobody healthy who covers ${POSITION_NAMES[pos]}, and he is rated ${grade(man.fielding.get(pos)?.cur ?? null)} there`;
  };
  /**
   * The same of a whole rung, said of the club that lacks him: "Planner
   * Singles is short of infielders: …". On a rung of two clubs both are
   * read, the one a new arrival goes to first, since the other club's
   * shortage is as much a reason to want him.
   */
  const lacksAbove = (man: Man, rung: Rung): string | null => {
    const first = emptierClub(rung);
    for (const club of [first, ...rung.clubs.filter((c) => c.team_id !== first.team_id)]) {
      const lacks = lacksHim(man, rung, club);
      if (lacks) return `${club.label} ${lacks}`;
    }
    return null;
  };
  /**
   * Why his own club cannot let him go, as the end of a clause about it: the
   * minimum he stands on ("would be left with six infielders against the
   * eight the level needs without him"), or the refill it is already counted
   * on to send up, which leaves no room to lose him as well. Null when
   * neither holds.
   */
  const keepsWhy = (man: Man): string | null => {
    const minimum = spareWhy(man);
    if (minimum) return `${minimum} without him`;
    const promisedFrom = owed().filter((x) => x !== man && x.plannedTeam === man.plannedTeam);
    if (promisedFrom.length === 0 || freeBeside(man, promisedFrom)) return null;
    const refilled = [...new Set(promisedFrom.map((x) => clubLabel(promised.get(x.id)!.club)))];
    return `is counted on to send ${listOf(promisedFrom.map((x) => x.name))} up to refill ${listOf(refilled)}, and cannot spare him as well`;
  };
  // A strong candidate the destination had no room for keeps a hold card. A
  // man the cap passes over a rung is left to the cap hold below, which names the caps
  const toldWhy = new Set<Man>();
  for (const man of refused) {
    if (man.moved || man.draft || closedAbove(man).length) continue;
    const above = rungAbove(man.rung!)!;
    const club = emptierClub(above);
    const room = `${club.label} is at ${planned.get(club.team_id)?.size ?? 0} against its maximum of ${above.target!.max}, and only surplus men are moved for size.`;
    // When the club above needs him and his own club cannot spare him, that
    // is the reason, and the size comes after: the minimum he stands on, or
    // the refill his club is already to send up
    const lacks = lacksAbove(man, above);
    const why = lacks && !canSpare(man) ? keepsWhy(man) : null;
    if (why) toldWhy.add(man);
    holdOf(man, { rung: above.key, teamId: club.team_id, label: club.label }, lacks && why
      ? [
        `${lacks}, and he is ready for ${LEVEL_AT[above.key]} at a fit of ${fit2(fitAt(man, above.key))}, but ${clubLabel(man.plannedTeam as number)} ${why}${nobodyBelow(man.plannedTeam as number)}.`,
        capitalise(room),
      ]
      : [`Ready for ${LEVEL_AT[above.key]} at a fit of ${fit2(fitAt(man, above.key))}, but ${room}`], above.key);
  }
  /*
   * And one his own club could not spare says which minimum stood on him.
   * When the club above also lacks something he would bring, that comes
   * first, as on the refused man's card: he is held because his club cannot
   * spare him while another club needs him, not only because a promotion on
   * merit never breaks a minimum.
   */
  for (const man of needed) {
    if (man.moved || man.draft || typeof man.plannedTeam !== 'number' || closedAbove(man).length || toldWhy.has(man)) continue;
    const above = rungAbove(man.rung!)!;
    const club = emptierClub(above);
    const here = clubRung.get(man.plannedTeam)!;
    // Why his club cannot let him go: the minimum he stands on, or a man it is to send up as a refill
    const why = keepsWhy(man)
      ?? `would open at ${(planned.get(man.plannedTeam)?.size ?? 0) - 1} against its minimum of ${here.target!.min} without him`;
    const lacks = lacksAbove(man, above);
    holdOf(man, { rung: above.key, teamId: club.team_id, label: club.label }, [
      lacks && !canSpare(man)
        ? `${lacks}, and he is ready for ${LEVEL_AT[above.key]} at a fit of ${fit2(fitAt(man, above.key))}, but ${clubLabel(man.plannedTeam)} ${why}${nobodyBelow(man.plannedTeam)}.`
        : `Ready for ${LEVEL_AT[above.key]} at a fit of ${fit2(fitAt(man, above.key))}, but ${clubLabel(man.plannedTeam)} ${why}, and a promotion on merit never breaks a minimum.`,
    ], above.key);
  }
  // A promotion blocked by a poor season — a man who would otherwise be a
  // candidate, or a 40-man man the club has a decision on: the Zazueta card
  for (const man of men) {
    if (man.rung === null || man.rung === 'mlb' || man.rung === 'ic' || man.frozen || man.moved || man.draft || !formPoor(man)) continue;
    const above = rungAbove(man.rung);
    if (!above || !eligibleAt(man, above, true).ok) continue;
    const f = fitAt(man, above.key);
    if (f === null || (f < PROMOTE_FIT && !man.on40)) continue;
    const p = indexAt(man, man.rung);
    holdOf(man, { rung: above.key, teamId: emptierClub(above).team_id, label: emptierClub(above).label }, [
      `Stays at ${clubLabel(man.teamId)}: the season verdict is poor on ${man.form?.line ?? 'a meaningful sample'}, which blocks a promotion whatever the grade${p !== null ? `; the index is ${Math.round(p)}, ${p >= READY_INDEX ? 'above' : 'below'} the ${READY_INDEX} a promotion on production alone asks for` : ''} (fit ${fit2(f)} at ${LEVEL_AT[above.key]}).`,
      ...[productionSentence(man, man.rung), scoutingSentence(man, man.rung)].filter((s): s is string => s !== null),
    ], above.key);
  }

  /**
   * When the rung that admits him this season closes to him next year, the
   * clause that says so: a move made next season must hold for the season
   * after too, so a 3-year DSL man can go to Single-A (capped at 4) only this
   * season. Next year, at the DSL cap of 4, the cap sends him two steps up to
   * High-A or off the club, and the card says that instead of promising he
   * moves up when his grade carries him. Null while the rung stays open.
   */
  const lastSeasonAt = (man: Man, dest: Rung): string | null => {
    const years = man.proYears ?? 0;
    if (dest.cap === null || years + 2 <= dest.cap || man.rung === null) return null;
    const here = byKey.get(man.rung)!;
    let later = rungAbove(dest.key);
    while (later && later.key !== 'mlb' && later.cap !== null && years + 2 > later.cap) later = rungAbove(later.key);
    const after = later && later.key !== 'mlb' ? later : null;
    const head = `and this is the last season ${LEVEL_AT[dest.key]} can take him`;
    if (here.cap !== null && years + 1 >= here.cap) {
      const atCap = `next year he is at the ${LEVEL_ADJ[here.key]} cap, ${years + 1} of ${here.cap} pro service years`;
      return after
        ? `${head}: ${atCap}, and must open ${cal.season + 2} at ${LEVEL_AT[after.key]} or above, or leave`
        : `${head}: ${atCap}, and no level short of the big club admits him for ${cal.season + 2}, so he must leave by then`;
    }
    return `${head}: after it, ${after ? `the first level above ${LEVEL_AT[man.rung]} that admits him is ${LEVEL_AT[after.key]}` : `no level above ${LEVEL_AT[man.rung]} short of the big club admits him`}`;
  };
  /*
   * A man whose next rung is closed to him by its cap, who would be a
   * candidate on his fit, and whom the plan does not move: a hold that says
   * which caps close to him and what would open a place at the first rung
   * that admits him, since a man the plan refuses is told why on a card of
   * his own. Without it a DSL man at three years, over the Complex cap by
   * Opening Day, would read as ready on his row with no card to say why he
   * stays.
   */
  for (const man of men) {
    if (man.rung === null || man.rung === 'mlb' || man.rung === 'ic' || man.frozen || man.moved || man.draft || man.extra.length) continue;
    if (man.capState !== 'ok' || typeof man.plannedTeam !== 'number') continue;
    const closed = closedAbove(man);
    if (closed.length === 0) continue;
    const dest = stepUpOf(man);
    const fitNext = fitAt(man, closed[0].key);
    const fitDest = dest ? fitAt(man, dest.key) : null;
    if ((fitNext ?? -Infinity) < PROMOTE_FIT && (fitDest ?? -Infinity) < PROMOTE_FIT) continue;
    const head = closedWords(man, closed);
    if (!dest) {
      holdOf(man, { rung: man.rung, teamId: man.plannedTeam, label: clubLabel(man.plannedTeam) }, [
        `${head}, and no level above ${LEVEL_AT[man.rung]} short of the big club admits him this season and next, so he stays where he is.`,
      ], man.rung);
      continue;
    }
    const club = emptierClub(dest);
    const size = planned.get(club.team_id)?.size ?? 0;
    const fitWords = `his fit there is ${fit2(fitDest)}`;
    const why = keepsWhy(man);
    // The level above that needs him, named before his own club's minimum, as on the refused man's card
    const lacks = why ? lacksAbove(man, dest) : null;
    const clause =
      fitDest === null ? `, but there is nothing to score him on there, ${lastSeasonAt(man, dest) ?? 'so he waits for a line or a grade to read'}`
      : fitDest < PROMOTE_FIT ? `, but ${fitWords}, short of the ${PROMOTE_FIT} a promotion asks, ${lastSeasonAt(man, dest) ?? 'so he moves up when his grade or his line carries him there'}`
      : formPoor(man) ? `, and ${fitWords}, but the season verdict is poor on ${man.form?.line ?? 'a meaningful sample'}, which blocks a promotion whatever the grade, so he moves up when the season turns`
      : why ? `, and ${fitWords}${lacks ? `; ${lacks}, but` : ', but'} ${clubLabel(man.plannedTeam)} ${why}, so he moves up when it can spare him`
      : size >= dest.target!.max ? `, and ${fitWords}, but ${club.label} is at ${size} against its maximum of ${dest.target!.max}, so he moves up when a place opens there`
      : `, and ${fitWords}, so he is next in line for a place there`;
    holdOf(man, { rung: dest.key, teamId: club.team_id, label: club.label }, [
      `${head}, so ${LEVEL_AT[dest.key]} is the first level above ${LEVEL_AT[man.rung]} that admits him${clause}.`,
    ], dest.key);
  }

  // ── Step 9: the release / trade list ──
  const releaseRows: Array<{ man: Man; draft: Draft }> = [];
  const replacement = (man: Man): number => valueAt(pools[man.group], REPLACEMENT_PCT);
  /** "nobody" for none, else the word: "leaves nobody against the one the level needs". */
  const countWord = (n: number): string => (n <= 0 ? 'nobody' : word(n));
  /**
   * Why the class says surplus, by the same tests assetClassOf applies and in
   * the same order: old for the level with no growth, old for a complex
   * level, or too far under the median grade to be depth and short of a
   * prospect's ceiling, upside or youth.
   */
  const surplusLead = (man: Man, rung: RungKey): string => {
    const base = baselines[rung];
    const medOa = base.medOa[man.group];
    const medAge = base.medAge;
    const head = `Surplus at ${LEVEL_AT[rung]}: `;
    const years = medAge !== null ? man.age - medAge : null;
    const yearsWord = (n: number): string => `${word(n)} ${plural(n, 'year')}`;
    if (years !== null && medOa !== null && years >= SURPLUS_YEARS_OLD && (man.pot ?? 0) <= medOa) {
      return `${head}at ${man.age} he is ${yearsWord(years)} older than the ${LEVEL_ADJ[rung]} median of ${medAge}, with a ${grade(man.pot)} ceiling no better than the median grade of ${grade(medOa)}.`;
    }
    if (years !== null && (rung === 'complex' || rung === 'dsl') && years >= SURPLUS_YEARS_OLD_COMPLEX) {
      return `${head}at ${man.age} he is ${yearsWord(years)} older than the ${LEVEL_ADJ[rung]} median of ${medAge}, and ${word(SURPLUS_YEARS_OLD_COMPLEX)} years over it is old for a complex level whatever the grade (${grade(man.oa)} with a ${grade(man.pot)} ceiling).`;
    }
    if (medOa === null) {
      return `${head}${grade(man.oa)} with a ${grade(man.pot)} ceiling, and the level has no median grade to call him depth against.`;
    }
    const gap = medOa - (man.oa ?? 0);
    const gapWord = Number.isInteger(gap) ? word(gap) : grade(gap);
    const upside = (man.pot ?? 0) - (man.oa ?? 0);
    const why = (man.pot ?? 0) < scaleGrade(PROSPECT_POT)
      ? `and his ${grade(man.pot)} ceiling is short of the ${grade(scaleGrade(PROSPECT_POT))} a prospect needs`
      : upside < onScale(PROSPECT_UPSIDE)
        ? `and ${grade(upside)} points between his grade and his ${grade(man.pot)} ceiling is short of the ${grade(onScale(PROSPECT_UPSIDE))} a prospect needs`
        : `and at ${man.age} he is older than the ${LEVEL_ADJ[rung]} median age of ${medAge ?? '?'}, which a prospect is not`;
    return `${head}${grade(man.oa)} with a ${grade(man.pot)} ceiling, ${gapWord} below the ${LEVEL_ADJ[rung]} median of ${grade(medOa)}, more than the ${word(onScale(DEPTH_MARGIN))} a depth man may be, ${why}.`;
  };
  /*
   * Lowest fit first, then the older man, then the lower id: when a club held
   * to its minimum can let only some of its surplus men go, the ones who go
   * are the ones it needs least, not the ones whose ids come first.
   */
  const fitHome = (m: Man): number => (m.rung !== null && m.rung !== 'ic' ? fitAt(m, m.rung) : null) ?? -Infinity;
  const releaseOrder = (a: Man, b: Man): number => fitHome(a) - fitHome(b) || b.age - a.age || a.id - b.id;
  for (const man of [...men].sort(releaseOrder)) {
    if (man.rung === null || man.ic || man.rung === 'mlb' || man.frozen || man.draft) continue;
    const noTrade = man.contract?.noTrade ?? false;
    // A no-trade clause keeps him off the trade list whatever his options say
    // (§5.7); a depth man so placed keeps the hold card below with the story
    const tradeable = man.on40 && !noTrade && (man.assetClass === 'surplus' || man.assetClass === 'depth') &&
      (man.optionState === 'last-option-year' || man.optionState === 'out-of-options');
    const surplus = man.assetClass === 'surplus' || man.pushedOut !== null || man.capOut !== null;
    if (!surplus && !tradeable) continue;
    if (man.assetClass === 'core') continue;
    const rungObj = byKey.get(man.rung)!;
    // A man the cap lets open next season nowhere but two steps up, and who
    // is not close to it, is on the list whatever his club's structure says:
    // he cannot be kept, only released or sold
    const at = typeof man.plannedTeam === 'number' && !man.capOut ? man.plannedTeam : null;
    const broken = at !== null ? brokenGroups(man, at) : [];
    const kept = broken[0] ?? null;
    // The band's minimum is hard: a man is not let go out of a club that
    // would then be under it, since "28 to cover injuries" means heads
    const band = rungObj.target;
    const size = at !== null ? planned.get(at)?.size ?? 0 : 0;
    const shortSize = !!band && !man.pushedOut && at !== null && size <= band.min;
    /*
     * A trade the club can make good from below goes ahead, with the man who
     * takes his place promoted beside it. The balance has run, so nothing
     * would refill the club he comes from: he must be free to go as it
     * stands, its size and every group minimum kept without him, and he must
     * fill every group the trade would break. One the club cannot make good
     * is a hold, whatever his options say: a man keeps a place whatever his
     * class when his removal breaks a minimum (§5.7).
     */
    const fillsHim = (m: Man): boolean => broken.every((g) => inGroupAt(m, g, rungObj.key));
    let fill: Man | null = null;
    if ((kept || shortSize) && tradeable && at !== null) {
      // Nor a man owed as a refill, nor the free place a refill owed elsewhere counted on
      fill = candidatesBelow(rungObj, fillsHim).find((m) => freeFor(m, null)) ?? null;
    }
    /*
     * Why nobody below can take his place: nobody is eligible, or every man
     * who is would leave his own club short, or is promised to refill
     * another club already (owed men are never the fill, so the sentence
     * says which of the two turned them away).
     */
    const noFill = (cands: Man[], every: string, none: string): string => {
      if (cands.length === 0) return none;
      const live = owed();
      const promisedAway = cands.filter((m) => owedTo(m, live) !== null).length;
      return `every ${every} below who could come up ${
        promisedAway === 0 ? 'would leave his own club short'
        : promisedAway === cands.length ? 'is promised to refill another club already'
        : 'would leave his own club short or is promised to refill another club already'}`;
    };
    if (kept && !fill) {
      const have = groupHave(at!, kept);
      const one = GROUP_WORD[kept].one;
      holdOf(man, { rung: man.rung, teamId: at!, label: clubLabel(at!) }, [
        tradeable
          ? `${clubLabel(at!)} cannot cover his place from below: he is the ${ordinal(have)} ${one} there, trading him would leave ${countWord(have - 1)} against the ${word(rungObj.structure!.min[kept])} the level needs, and ${noFill(candidatesBelow(rungObj, fillsHim), one, `no ${one} below is eligible to come up`)}.`
          : `Kept for structure: ${ordinal(have)} ${one} at ${clubLabel(at!)}, where releasing him would leave ${countWord(have - 1)} against the ${word(rungObj.structure!.min[kept])} the level needs.`,
        ...(tradeable ? [optionsSentence(man)!] : []),
      ], man.rung, { leads: tradeable });
      continue;
    }
    if (shortSize && !fill && !man.capOut) {
      holdOf(man, { rung: man.rung, teamId: at!, label: clubLabel(at!) }, [
        tradeable
          ? `${clubLabel(at!)} cannot cover his place from below: it stands at ${size} against a minimum of ${band!.min}, so trading him would put it under the band, and ${!rungBelow(rungObj.key) ? 'there is no level below to fill it from' : noFill(candidatesBelow(rungObj), 'man', 'nobody below is eligible to come up')}.`
          : `Kept for size: ${clubLabel(at!)} stands at ${size} against a minimum of ${band!.min}, and releasing him would put it under the band with ${!rungBelow(rungObj.key) ? 'no level below' : candidatesBelow(rungObj).length ? 'nobody below who can be spared' : 'nobody eligible below'} to fill it.`,
        ...(tradeable ? [optionsSentence(man)!] : []),
      ], man.rung, { leads: tradeable });
      continue;
    }
    const value = values.get(man.id)?.overall ?? 0;
    const moneyOwed = (man.contract?.yearsAfterThis ?? 0) > 0;
    // Off the 40-man, a buyer may pay for a man worth a replacement-level
    // place, and money owed beyond this season is shopped before it is
    // eaten, whatever kind of deal it is (§5.7)
    const kind: 'trade' | 'release' =
      tradeable ? 'trade'
      : noTrade ? 'release'
      : man.on40 ? 'trade'
      : value >= replacement(man) || moneyOwed ? 'trade'
      : 'release';
    const lead: string[] = [];
    if (man.capOut) lead.push(man.capOut);
    else if (man.pushedOut) lead.push(man.pushedOut);
    /*
     * The sentence names his club, and every man in it is counted in the
     * class he plays there in the plan: the count the structure check read
     * when it let him go. A starter arriving from the Complex who relieves at
     * Single-A is one of its relievers, so "leaves seven against the seven
     * the level needs" agrees with the plan. The man let go has no other
     * move, so the class he plays there is the one he has there today, the
     * one his row shows. A man the balance pushed out is off the planned
     * roster already, but he is one of the group the sentence counts.
     */
    const group = countGroup(man);
    const peers = healthyAt(man.teamId).filter((m) => countGroup(m) === group);
    if (!peers.includes(man)) peers.push(man);
    const better = peers.filter((m) => m !== man && (m.oa ?? -1) > (man.oa ?? -1)).length;
    if (man.assetClass === 'surplus') {
      lead.push(surplusLead(man, man.rung));
      if (peers.length > 1) {
        const need = rungObj.structure?.min[group] ?? 0;
        const others = peers.length - 1;
        const above = better === 0 ? 'none of the others'
          : better === others ? (others === 1 ? 'the other one' : 'every one of the others')
          : `${word(better)} of the others`;
        lead.push(
          `${capitalise(ordinal(better + 1))} of ${word(peers.length)} ${GROUP_WORD[group].many} at ${clubLabel(man.teamId)}, ${above} graded above him; ${kind === 'release' ? 'releasing' : 'moving'} him leaves ${countWord(others)} against the ${word(need)} the level needs.`
        );
      }
    }
    if (tradeable) lead.push(optionsSentence(man)!);
    if (noTrade && !man.on40 && (value >= replacement(man) || moneyOwed)) {
      lead.push('His contract carries a no-trade clause, so he cannot be shopped and a release is the way out.');
    }
    const tail: string[] = [];
    if (kind === 'trade' && !tradeable && !man.on40) {
      tail.push(moneyOwed
        ? `Money is owed beyond this season (${word(man.contract!.yearsAfterThis)} more ${plural(man.contract!.yearsAfterThis, 'year')}), so he is shopped rather than released.`
        : `OOTP values him at ${Math.round(value)}, above the ${Math.round(replacement(man))} replacement line for his group, so a buyer may pay for him: shop him rather than release him.`);
    }
    const tradeOpen = !!cal.tradeDeadline && !!parseDate(cal.tradeDeadline) && dateKey(parseDate(cal.tradeDeadline)!) >= dateKey(cal.today);
    let deadline = kind === 'trade'
      ? (tradeOpen
          ? deadlineOf('trade-deadline', cal.tradeDeadline, `Trade deadline — shop ${man.name}`)
          : deadlineOf('rule5', cal.rule5, `40-man is set — shop ${man.name} before the Rule 5 draft`))
      : null;
    /*
     * The cap binds from Opening Day, not today: a man it sends to the list is
     * eligible where he is for the rest of this season, so he plays it out,
     * stays on the club's count, and the card is dated at his league's last
     * game (or the trade deadline, while it is ahead, for a trade).
     */
    const next = cal.season + 1;
    if (man.capOut) {
      const end = seasonEndOf(man);
      if (kind === 'release' || !tradeOpen) {
        deadline = deadlineOf('service-cap', end, `Last eligible season at ${LEVEL_AT[man.rung]} — ${kind === 'trade' ? 'shop' : 'release'} ${man.name} before Opening Day ${next}`);
      }
      const ends = end ? ` on ${end}` : '';
      tail.push(kind === 'trade' && tradeOpen
        ? `He is eligible at ${clubLabel(man.teamId)} for the rest of this season: shop him before ${cal.tradeDeadline}, and if nobody bites, release him after the season ends${ends}, before Opening Day ${next}.`
        : `He is eligible at ${clubLabel(man.teamId)} for the rest of this season, so he plays it out there and ${kind === 'trade' ? 'is shopped' : 'is released'} after it ends${ends}, before Opening Day ${next}.`);
    } else if (kind === 'trade' && deadline) {
      tail.push(`Shop him before ${deadline.date}${cal.rule5 && deadline.kind === 'trade-deadline' ? `, otherwise before the 40-man is set on ${cal.rule5}` : ''}.`);
    }
    if (!man.capOut) place(man, 'out');
    if (fill && at !== null) {
      const club = rungObj.clubs.find((c) => c.team_id === at)!;
      const from = clubLabel(fill.teamId);
      const why = kept
        ? `${clubLabel(at)} trades ${man.name}, which would leave ${countWord(groupHave(at, kept))} ${plural(groupHave(at, kept), GROUP_WORD[kept].one, GROUP_WORD[kept].many)} against the ${word(rungObj.structure!.min[kept])} the level needs, so he comes up to take the place: the best eligible ${GROUP_WORD[kept].one} below (fit ${fit2(fitAt(fill, rungObj.key))} at ${LEVEL_AT[rungObj.key]}).`
        : `${clubLabel(at)} trades ${man.name}, which would leave it at ${planned.get(at)?.size ?? 0} against its minimum of ${band!.min}, so he comes up to take the place: the best eligible man below by fit (${fit2(fitAt(fill, rungObj.key))} at ${LEVEL_AT[rungObj.key]}).`;
      moveTo(fill, 'promote', rungObj, club, [why]);
      tail.push(`${fill.name} comes up from ${from} to take his place, so the trade leaves ${clubLabel(at)} no shorter.`);
    }
    const d = draft({
      kind, horizon: man.capOut ? 'offseason' : 'now', forced: false, man, from: { rung: man.rung, teamId: man.teamId },
      to: { rung: 'out', teamId: null, label: kind === 'trade' ? 'traded' : 'released' }, lead, tail,
      judgedAt: man.rung, fit: fitAt(man, man.rung), deadline, verify: { field: 'org', expect: 'gone' }, fortyMan: null,
    });
    releaseRows.push({ man, draft: d });
  }
  // On-40 men in the minors in their last option year, with no other card: a hold with the story
  for (const man of men) {
    if (man.rung === null || man.rung === 'mlb' || man.rung === 'ic' || man.frozen || man.draft || man.extra.length) continue;
    if (man.on40 && (man.optionState === 'last-option-year' || man.optionState === 'out-of-options')) {
      holdOf(man, { rung: man.rung, teamId: man.teamId, label: clubLabel(man.teamId) }, [
        optionsSentence(man)!,
        ...(man.contract?.noTrade ? ['His contract carries a no-trade clause, so he is kept off the trade list.'] : []),
      ], man.rung);
    }
  }

  // The places the plan's own trades and releases free before the Rule 5 draft
  for (const { draft: d } of releaseRows) freePlace(d);

  // ── Protect moves ──
  /*
   * By fit, the best man first (§5.4), the man the big club is thinnest at
   * first among equals, then the man whose deadline comes first, then the
   * lower id: a man who walks earlier as a minor-league free agent does not
   * jump a better one. A protection the user accepted takes its place before
   * any of them; one he dismissed takes none, so its place goes to the men
   * after it, and its card is still made so the dismissal keeps its move.
   * The cards are listed in the order they claimed, so the count each one
   * states is the count after the protections above it.
   */
  const protectBy = (man: Man): number => {
    const end = man.minorFa === 'after-this-season' ? parseDate(seasonEndOf(man)) : null;
    const r5 = parseDate(cal.rule5);
    return end ? dateKey(end) : r5 ? dateKey(r5) : Infinity;
  };
  const stanceOf = (man: Man): number => {
    const said = decisionOn(fortyKeyOf(man));
    return said === 'accepted' ? 0 : said === 'dismissed' ? 2 : 1;
  };
  const protectOrder = (a: Man, b: Man): number =>
    stanceOf(a) - stanceOf(b) ||
    (fitAt(b, 'mlb') ?? -Infinity) - (fitAt(a, 'mlb') ?? -Infinity) || Number(coversThinnest(b)) - Number(coversThinnest(a)) ||
    protectBy(a) - protectBy(b) || a.id - b.id;
  let claimed = 0;
  for (const man of men.filter((m) => m.protect && !m.frozen && m.rung !== null && m.rung !== 'ic').sort(protectOrder)) {
    // A call-up puts him on the 40-man already, unless the user dismissed it;
    // a man the plan lets go is not protected, and takes no place from the men after him
    if (man.draft?.kind === 'callup' && !callupDismissed(man)) continue;
    if (man.capOut || man.pushedOut || man.extra.some((d) => d.kind === 'trade' || d.kind === 'release')) {
      man.protect = false;
      continue;
    }
    const said = decisionOn(fortyKeyOf(man));
    const to: Draft['to'] = { rung: '40man', teamId: orgId, label: '40-man roster' };
    // A man who becomes a minor-league free agent at season end is gone before the Rule 5 draft
    const walks = man.minorFa === 'after-this-season';
    const before = walks ? 'before he becomes a minor-league free agent' : 'before the Rule 5 draft';
    const end = walks ? seasonEndOf(man) : null;
    const place = !room ? null : said === 'dismissed' ? peekPlace('protect') : claimPlace(man, 'protect', said === 'accepted');
    // An accepted protection stays a protection even when no place can be found for it
    if (place?.full && said !== 'accepted') {
      man.fortyLine = `The 40-man ${fullWords(place)}`;
      // The same question as the protection, so accepting it is checked the same way: is he on the 40-man
      const held = holdOf(man, to, [`Worth a 40-man place ${before}, but the 40-man ${fullWords(place)}${place.freed ? ',' : ''} and nobody on it can cheaply give up his place.`, rule5Sentence(man)!], man.rung!, {
        fortyQuestion: true,
        deadline: end
          ? deadlineOf('minor-fa', end, `Minor-league free agent after the season — ${man.name} can walk unless a 40-man place opens`)
          : deadlineOf('rule5', cal.rule5, `Rule 5 draft — ${man.name} is exposed unless a 40-man place opens`),
      });
      held.verify = { field: 'on40', expect: true };
      continue;
    }
    man.fortyLine = !place ? null
      : place.full ? `The 40-man ${fullWords(place)}, so a place has to be cleared for him`
      : place.comesOff ? `The 40-man ${fullWords(place)}, so ${place.comesOff.name} is the place (${place.comesOff.why})`
      : `The 40-man ${holdsWords(place)}, so a place is open`;
    if (place?.comesOff && said !== 'dismissed') {
      const off = byId.get(place.comesOff.player_id);
      if (off && place.comesOff.why === 'to the 60-day IL') il60For(off, `${man.name}'s protection needs his 40-man place.`);
    }
    const lead = [rule5Sentence(man)!];
    const d = draft({
      kind: 'protect', horizon: 'now', forced: false, man, from: { rung: man.rung!, teamId: man.teamId }, to, lead,
      judgedAt: man.rung!, fit: fitAt(man, 'mlb'),
      deadline: end
        ? deadlineOf('minor-fa', end, `Minor-league free agent after the season — add ${man.name} to the 40-man or re-sign him`)
        : deadlineOf('rule5', cal.rule5, `Rule 5 draft — add ${man.name} to the 40-man`),
      verify: { field: 'on40', expect: true },
      fortyMan: place ? { count: place.before, limit: cal.fortyLimit, comesOff: place.comesOff } : null,
      fortyQuestion: true, seq: claimed++,
    });
    if (coversThinnest(man)) d.lead.push(`Ahead of the other candidates because the big club is thinnest at ${listOf(thinnest)}, and he covers it.`);
    if (man.draft) {
      man.draft.linked.push(d.key);
      d.linked.push(man.draft.key);
    }
  }

  /*
   * One man, one card. The steps above each judge him once, and a man can
   * come out of two of them with two verdicts: a call-up held up on the 26
   * and then a trade, or a promotion to Triple-A beside the hold. The card
   * that comes first in the listing order wins and the others' sentences are
   * folded into its reasons, so the page and the dashboard count him once.
   * His 40-man question — a protection, or the hold that stands in for one
   * while no place is open — is the one card that rides beside a move,
   * linked to it, since the 40-man is a decision of its own (Morales:
   * promote, and protect). Beside a hold it is the card, so it keeps its one
   * key and its Rule 5 date whatever else holds him; beside a release or a
   * trade it is moot. The protection loop skips a man the plan lets go before
   * he claims anything, so a moot protection holds no place; giving the place
   * back here is only a guard, and would not change the counts the cards
   * after him already state.
   */
  {
    const order = (d: Draft): number => KIND_ORDER.indexOf(d.kind);
    const cardsOf = new Map<Man, Draft[]>();
    for (const d of drafts) cardsOf.set(d.man, [...(cardsOf.get(d.man) ?? []), d]);
    const gone = new Set<Draft>();
    const fold = (into: Draft, from: Draft): void => {
      for (const sentence of [...from.lead, ...from.tail]) {
        if (!into.lead.includes(sentence) && !into.tail.includes(sentence)) into.tail.push(sentence);
      }
      gone.add(from);
    };
    for (const [man, cards] of cardsOf) {
      const rungCards = cards.filter((d) => !d.fortyQuestion && d.kind !== 'il60');
      const protect = cards.find((d) => d.fortyQuestion) ?? null;
      // Among his holds, the one that says his club cannot cover his place
      // from below wins, since it is why the trade is not made; else (stable)
      // the one written first. "Kept for structure" and "Kept for size" do not
      // lead: the release loop runs last, so a hold written before it (the
      // cap, a refused or needed promotion) keeps the card and its key, and
      // the minimum that keeps him is folded in after it
      const winner = [...rungCards].sort((a, b) => order(a) - order(b) || Number(!!b.leads) - Number(!!a.leads))[0] ?? null;
      for (const d of rungCards) if (d !== winner) fold(winner!, d);
      if (winner && protect) {
        if (winner.kind === 'hold') fold(protect, winner);
        else if (winner.kind === 'trade' || winner.kind === 'release') {
          gone.add(protect);
          releasePlace(man);
        } else {
          if (!winner.linked.includes(protect.key)) winner.linked.push(protect.key);
          if (!protect.linked.includes(winner.key)) protect.linked.push(winner.key);
        }
      }
      if (gone.size === 0) continue;
      man.extra = man.extra.filter((d) => !gone.has(d));
      if (man.draft && gone.has(man.draft)) man.draft = null;
    }
    if (gone.size) {
      const goneKeys = new Set([...gone].map((d) => d.key));
      const kept = drafts.filter((d) => !gone.has(d));
      drafts.length = 0;
      drafts.push(...kept);
      for (const d of drafts) d.linked = d.linked.filter((k) => !goneKeys.has(k));
      for (let i = releaseRows.length - 1; i >= 0; i--) if (gone.has(releaseRows[i].draft)) releaseRows.splice(i, 1);
    }
  }

  // Needs are read once the balance and the release list have settled, not per round
  needs.clear();
  for (const rung of minors) {
    for (const club of rung.clubs) {
      const t = club.team_id;
      const shortGroups = STRUCTURE_GROUPS.map((g) => [g, rung.structure!.min[g] - groupHave(t, g)] as const).filter(([, n]) => n > 0);
      const size = planned.get(t)?.size ?? 0;
      const shortSize = rung.target!.min - size;
      if (shortSize > 0 || shortGroups.length) {
        const k = Math.max(shortSize, shortGroups.reduce((a, [, n]) => a + n, 0));
        const what = shortGroups.length
          ? listOf(shortGroups.map(([g, n]) => (n === 1 ? `${article(GROUP_WORD[g].one)} ${GROUP_WORD[g].one}` : `${word(n)} ${GROUP_WORD[g].many}`)))
          : `${word(k)} ${plural(k, 'man', 'men')} to reach the minimum of ${rung.target!.min}`;
        /*
         * Whether anyone below could have filled it: nobody eligible at all, or
         * eligible men whose own clubs cannot spare them. The note never says
         * nobody is there when somebody is.
         */
        const eligible = [
          ...shortGroups.flatMap(([g]) => candidatesBelow(rung, (m) => inGroupAt(m, g, rung.key))),
          ...(shortSize > 0 ? candidatesBelow(rung) : []),
        ];
        // At the bottom rung nothing promotes in, so the note does not speak of anyone below
        const why = !rungBelow(rung.key) ? 'no level below to fill it from'
          : eligible.length === 0 ? 'nobody eligible below can fill it'
          : eligible.some((m) => canSpare(m, t)) ? 'a man below is eligible, but the plan has no room to move him'
          : 'the men below who could fill it would leave their own clubs short';
        // On a rung of two clubs, the note names the one it is about
        const forClub = rung.clubs.length > 1 ? ` for ${club.label}` : '';
        addNeed(t, `Sign ${k} minor-league free ${plural(k, 'agent')}${forClub}: ${what} (${why}).`);
      }
      /*
       * A position nobody healthy covers, when the field pull found nobody
       * below to bring: the groups can all stand at their minimums with no
       * second baseman among them, so the note names the position. Catcher,
       * shortstop and centre field are left to their structure groups, which
       * count the men the level carries there; a club of three teenage
       * catchers none yet rated 40 behind the plate has its catchers, and its
       * C row says so. At the bottom of the ladder nobody is below, so the
       * note speaks of the roster alone.
       */
      for (const pos of NOTED_POSITIONS) {
        if (healthyAt(t).some((m) => m.coversNow.has(pos))) continue;
        const code = POSITION_NAMES[pos];
        const eligible = candidatesBelow(rung, (m) => m.coversNow.has(pos));
        const why = !rungBelow(rung.key) ? `nobody on the roster covers ${code}`
          : eligible.length === 0 ? `nobody eligible below covers ${code}`
          : eligible.some((m) => canSpare(m, t)) ? `a man below covers ${code}, but the plan has no room to move him`
          : `nobody below can cover ${code} without leaving his club short`;
        const forClub = rung.clubs.length > 1 ? ` for ${club.label}` : '';
        addNeed(t, `Sign ${article(POSITION_PLAYER[pos])} ${POSITION_PLAYER[pos]}${forClub}: ${why}.`);
      }
      if (size > rung.target!.max) {
        addNeed(t, `${size} on the planned${rung.clubs.length > 1 ? ` ${club.label}` : ''} roster, ${size - rung.target!.max} over the ${rung.target!.max} you set; only surplus men are moved for size.`);
      }
    }
  }
  // ── Sentences shared by every card ──
  /*
   * Every line he has, in words, then the index. A line from this season
   * under 60 PA / 15 IP is too small to make a claim with (§5.1), so it is
   * named as a look and its figures are left out; the index still counts it,
   * at the small weight its sample earns.
   */
  function productionSentence(man: Man, at: RungKey): string | null {
    if (man.lines.length === 0) return null;
    const small = (l: Line): boolean =>
      l.year === cal.season && (man.isPitcher ? l.ip < GATES.seasonIp : l.pa < GATES.seasonPa);
    const quoted = man.lines.filter((l) => !small(l));
    const looks = man.lines.filter(small).map((l) => l.short);
    const years = [...new Set(quoted.map((l) => l.year))].sort((a, b) => b - a);
    const parts = years.map((y) => listOf(quoted.filter((l) => l.year === y).map((l) => l.text)));
    const verb = man.isPitcher ? 'Pitching to' : 'Hitting';
    const gate = man.isPitcher ? `${GATES.seasonIp} IP` : `${GATES.seasonPa} PA`;
    const p = indexAt(man, at);
    const index = man.readable && p !== null
      ? ` — a production index of ${Math.round(p)} in ${LEVEL_ADJ[at]} terms, ${p >= 100 ? 'above' : 'below'} the 100 bar.`
      : ` — no readable sample (${man.isPitcher ? `${Math.round(man.windowIp)} IP` : `${man.windowPa} PA`} over three seasons, ${man.isPitcher ? GATES.ip + ' IP' : GATES.pa + ' PA'} needed).`;
    if (parts.length === 0) {
      return `Only ${listOf(looks)} so far, short of the ${gate} a line this season needs before its figures are quoted${index}`;
    }
    const look = looks.length ? `, and only ${listOf(looks)}, short of the ${gate} a line this season needs` : '';
    return `${verb} ${parts[0]}${parts.length > 1 ? `, after ${listOf(parts.slice(1))}` : ''}${look}${index}`;
  }
  function scoutingSentence(man: Man, at: RungKey): string | null {
    if (man.oa === null) return null;
    const base = baselines[at];
    const med = base.medOa[man.group];
    let s = `Grades ${grade(man.oa)} with a ${grade(man.pot)} ceiling`;
    if (med !== null) {
      const diff = Math.round(man.oa - med);
      s += diff === 0 ? `, level with the ${LEVEL_ADJ[at]} median of ${grade(med)}` : `, ${word(diff)} ${diff > 0 ? 'above' : 'below'} the ${LEVEL_ADJ[at]} median of ${grade(med)}`;
    }
    if (base.medAge !== null) {
      const d = Math.round(base.medAge - man.age);
      s += d === 0
        ? `, and at ${man.age} he is at the ${LEVEL_ADJ[at]} median age`
        : `, and at ${man.age} he is ${word(d)} ${plural(Math.abs(d), 'year')} ${d > 0 ? 'younger' : 'older'} than the ${LEVEL_ADJ[at]} median of ${base.medAge}`;
    }
    return `${s}.`;
  }
  /**
   * His Rule 5 line. On his 40-man card (the protection, or the hold that
   * stands in for it) it gives the count after the protections above that
   * card. On any other card of his — a forced move listed before every
   * protection, a promotion listed after them — that count would be read
   * against the wrong cards, so `elsewhere` (his 40-man card) turns it into
   * a pointer to the card that states it.
   */
  function rule5Sentence(man: Man, elsewhere: Draft | null = null, from: Draft | null = null): string | null {
    if (!man.rule5) return null;
    // A call-up puts him on the 40-man, which is the protection, unless the user dismissed it
    if (man.draft?.kind === 'callup' && !callupDismissed(man)) return null;
    const years = man.proYears ?? 0;
    const shield = man.protectedYears ?? 0;
    const date = cal.rule5 ?? 'this winter';
    if (man.protect) {
      const gateWhy = (man.pot ?? 0) >= scaleGrade(TIER.regular)
        ? `at a ${grade(man.pot)} ceiling the grade earns it`
        : `at a ${grade(man.pot)} ceiling the grade alone would not earn it — the index of ${Math.round(indexAt(man, man.rung!) ?? 0)} does`;
      const forty = elsewhere
        ? `His 40-man place is asked on a card of its own${from?.linked.includes(elsewhere.key) ? ', linked to this one' : ''}`
        : man.fortyLine ?? `The 40-man holds ${fortyCount} of ${cal.fortyLimit}, so ${fortyFull ? 'a place has to be cleared' : 'a place is open'}`;
      if (man.minorFa === 'after-this-season') {
        const end = seasonEndOf(man);
        return `A minor-league free agent after this season: ${years} pro ${plural(years, 'season')} on a minor-league deal, so he can walk when the ${LEVEL_ADJ[man.rung!]} season ends${end ? ` on ${end}` : ''}, before the Rule 5 draft on ${date}, unless he is added to the 40-man or re-signed. ${forty}; ${gateWhy}.`;
      }
      return `Rule 5 eligible on ${date}: ${years} pro ${plural(years, 'season')} against ${shield} years of protection, not on the 40-man. ${forty}; ${gateWhy}.`;
    }
    if ((man.capOut || man.pushedOut) && rule5ProtectGate({ oa: man.oa, pot: man.pot, productionIndex: indexAt(man, man.rung!) })) {
      return `Rule 5 eligible this winter (${years} pro ${plural(years, 'year')}, protected for ${shield}) and not on the 40-man; the grade would earn him a place, but the plan lets him go first.`;
    }
    return `Rule 5 eligible this winter (${years} pro ${plural(years, 'year')}, protected for ${shield}) and not on the 40-man; at ${grade(man.oa)} with a ${grade(man.pot)} ceiling he does not meet the gate of POT ${grade(scaleGrade(50))} or OA ${grade(scaleGrade(40))} with an index of 110, so no 40-man place is recommended — he is exposed on ${date} unless the grade moves.`;
  }
  function optionsSentence(man: Man): string | null {
    if (!man.on40 || man.rung === 'mlb' || man.rung === null) return null;
    const used = man.optionsUsed ?? 0;
    const thisYear = (man.optionsThisYear ?? 0) >= 1;
    const svc = `${man.serviceYears.toFixed(1)} years of major-league service`;
    switch (man.optionState) {
      case 'last-option-year':
        return used >= 3
          ? `Holds a 40-man place at ${LEVEL_AT[man.rung]} in his last option year: ${used} of 3 options used, the third this year, with ${svc} — next spring he either makes the 26 or has to clear waivers.`
          : `Holds a 40-man place at ${LEVEL_AT[man.rung]} in his last option year: ${used} of 3 options used and none this year, so the one that sends him down next is his last, with ${svc}.`;
      case 'out-of-options':
        return `Holds a 40-man place at ${LEVEL_AT[man.rung]} with no options left: ${used} of 3 used and none this year, so a send-down now means clearing waivers, with ${svc}.`;
      case 'never-sendable':
        return `Holds a 40-man place at ${LEVEL_AT[man.rung]} with ${svc}, past the five that let him refuse an assignment, so options no longer bind him.`;
      default:
        return used === 2 && thisYear
          ? `${used} of 3 options used, this year's among them, so ${cal.season + 1} is his last option year.`
          : `On the 40-man with ${used} of 3 options used.`;
    }
  }
  function contractSentence(man: Man, kind: MoveKind): string | null {
    const c = man.contract;
    if (!c) return null;
    if (c.isMajor && kind === 'release') {
      // A release ends the job, not the deal: the club pays what is left of it
      const pay = remainingPay(man.id);
      const owes = pay
        ? `the club still owes ${money(pay.now)} this season${pay.after > 0 ? ` and ${money(pay.after)} over the ${word(c.yearsAfterThis)} ${plural(c.yearsAfterThis, 'season')} after it` : ''}`
        : 'the club still owes what is left of it';
      return `His ${c.totalYears}-year ${money(c.salaryNow)} deal ${c.yearsAfterThis > 0 ? `runs through ${c.endYear}` : 'ends after the season'}, and a release does not end it: ${owes}.`;
    }
    if (c.isMajor) {
      const control = man.serviceYears < 6 ? ` and he stays under club control at ${man.serviceYears.toFixed(1)} years of service` : '';
      return `His ${c.totalYears}-year ${money(c.salaryNow)} deal ${c.yearsAfterThis > 0 ? `runs through ${c.endYear}` : 'ends after the season'}${control}.`;
    }
    if (man.on40) return null;
    const fa = man.minorFa === 'after-this-season'
      ? `; with ${man.proYears ?? 0} pro seasons he is a minor-league free agent after the season anyway.`
      : man.minorFa === 'after-next-season'
        ? `; at ${man.proYears ?? 0} pro seasons he is a minor-league free agent after next season.`
        : '.';
    return `Minor-league contract, not on the 40-man, so a release costs nothing${fa}`;
  }
  /** The shortstop and centre-field cover note on a promote card. */
  function coverNote(d: Draft): string | null {
    if (typeof d.to.teamId !== 'number' || d.to.rung === 'out' || d.to.rung === '40man') return null;
    const rung = byKey.get(d.to.rung);
    if (!rung?.structure || d.man.isPitcher) return null;
    for (const [pos, g, name] of [[6, 'SS cover', 'shortstop'], [8, 'CF cover', 'centre field']] as const) {
      if (!d.man.coversNow.has(pos) || d.man.position === pos) continue;
      const have = groupHave(d.to.teamId, g);
      if (have - 1 < rung.structure.min[g]) {
        return `${d.to.label} has ${word(have - 1)} other ${have - 1 === 1 ? 'man' : 'men'} rated ${COVER_RATING} or better at ${name} once he arrives, and he is rated ${grade(d.man.fielding.get(pos)?.cur ?? null)} there, so list him at ${POSITION_NAMES[pos]} as well.`;
      }
    }
    return null;
  }

  // ── OOTP steps ──
  const OOTP_STEPS: Record<MoveKind, (d: Draft) => { screen: string; steps: string[] }> = {
    forced: (d) => ({ screen: 'Player page → Transactions', steps: [open(d), `Transactions → Assign to ${d.to.label} (${d.to.rung === 'out' || d.to.rung === '40man' ? '' : LEVEL_TAG[d.to.rung]})`] }),
    promote: (d) => OOTP_STEPS.forced(d),
    cover: (d) => OOTP_STEPS.forced(d),
    demote: (d) => OOTP_STEPS.forced(d),
    assign: (d) => OOTP_STEPS.forced(d),
    callup: (d) => ({ screen: 'Player page → Transactions', steps: [open(d), `Transactions → Call up to ${d.to.label}`, ...(d.fortyMan?.comesOff ? [`Open ${d.fortyMan.comesOff.name} → Transactions → ${d.fortyMan.comesOff.why === 'to the 60-day IL' ? 'Place on 60-Day Injured List' : 'Designate for Assignment'}`] : [])] }),
    senddown: (d) => ({ screen: 'Player page → Transactions', steps: [open(d), `Transactions → Option to ${d.to.label} (${d.to.rung === 'out' || d.to.rung === '40man' ? '' : LEVEL_TAG[d.to.rung]})`] }),
    protect: (d) => ({ screen: 'Player page → Transactions', steps: [open(d), `Transactions → Add to 40-Man Roster${d.deadline ? `, before ${d.deadline.date}` : ''}`, ...(d.fortyMan?.comesOff ? [`Open ${d.fortyMan.comesOff.name} → Transactions → ${d.fortyMan.comesOff.why === 'to the 60-day IL' ? 'Place on 60-Day Injured List' : 'Designate for Assignment'}`] : [])] }),
    il60: (d) => ({ screen: 'Player page → Transactions', steps: [open(d), 'Transactions → Place on 60-Day Injured List'] }),
    trade: (d) => ({ screen: 'Trade Center', steps: [open(d), 'Transactions → Trading Block → add him', 'Trade Center → Shop player'] }),
    release: (d) => ({ screen: 'Player page → Transactions', steps: [open(d), 'Transactions → Release'] }),
    hold: (d) => ({ screen: 'Player page', steps: [open(d), 'No move: review him on the player page'] }),
    position: (d) => ({ screen: 'Depth Chart', steps: [open(d), `${d.to.label} → Depth Chart → add him at ${d.to.rung}`] }),
    role: (d) => ({ screen: 'Pitching Staff', steps: [open(d), `${d.to.label} → Pitching Staff → change his role`] }),
  };
  function open(d: Draft): string {
    return `Open ${d.man.name} (${d.man.ic ? 'International complex' : clubLabel(d.from.teamId)})`;
  }

  // ── Render the cards ──
  // The names of the org's men and clubs with a stop inside, longest first, which a card never splits
  const dottedNames = [...new Set([...men.map((m) => m.name), ...rungList.flatMap((r) => r.clubs.map((c) => c.label))])]
    .filter((n) => /\.\s/.test(n))
    .sort((a, b) => b.length - a.length);
  // Each man's 40-man card, once the fold has settled which cards stand
  const fortyCardOf = new Map(drafts.filter((d) => d.fortyQuestion).map((d) => [d.man, d] as const));
  const renderMove = (d: Draft): PlanMove => {
    const man = d.man;
    /*
     * A card says each sentence once. The sentences of a folded card ride in
     * the tail, and some of them are ones this card says anyway (his
     * production and grade, his Rule 5 line), so every reason is added less
     * the sentences already said, wherever on the card they were said first.
     */
    const reasons: string[] = [];
    const said = new Set<string>();
    const say = (text: string | null): void => {
      if (!text) return;
      const all = sentencesOf(text, dottedNames);
      const fresh: string[] = [];
      for (const x of all) {
        if (said.has(x)) continue;
        said.add(x);
        fresh.push(x);
      }
      if (fresh.length) reasons.push(fresh.length === all.length ? text : fresh.join(' '));
    };
    for (const s of d.lead) say(s);
    if (d.kind !== 'hold' && d.kind !== 'il60') {
      say(productionSentence(man, d.judgedAt));
      say(scoutingSentence(man, d.judgedAt));
    }
    if (d.kind !== 'protect') {
      // His 40-man count belongs to his 40-man card, which is listed among the protections, not beside this one
      const forty = fortyCardOf.get(man) ?? null;
      say(rule5Sentence(man, forty === d ? null : forty, d));
    }
    if (d.kind !== 'trade' && d.kind !== 'hold') say(optionsSentence(man));
    for (const s of d.tail) say(s);
    if (d.kind === 'promote' || d.kind === 'forced' || d.kind === 'cover') say(coverNote(d));
    if (d.kind === 'trade' || d.kind === 'release') say(contractSentence(man, d.kind));
    if (reasons.length === 0) reasons.push(`${man.name} is listed at ${LEVEL_AT[d.from.rung]} with nothing in the export to score him on.`);
    const { screen, steps } = OOTP_STEPS[d.kind](d);
    return {
      key: d.key,
      kind: d.kind,
      horizon: d.horizon,
      forced: d.forced,
      player: {
        player_id: man.id, name: man.name, age: man.age,
        positionName: man.isPitcher ? (man.p.throws === 2 ? 'LHP' : 'RHP') : POSITION_NAMES[man.position] ?? '?',
        roleLabel: man.isPitcher ? (man.role === ROLE_STARTER ? 'SP' : man.role === ROLE_CLOSER ? 'CL' : 'RP') : null,
        oa: man.oa, pot: man.pot,
        bats: hand(man.p.bats), throws: hand(man.p.throws), utility: man.utility, assetClass: man.assetClass,
      },
      from: { rung: d.from.rung, label: d.man.ic ? 'International complex' : clubLabel(d.from.teamId), team_id: d.from.teamId },
      to: { rung: d.to.rung, label: d.to.label, team_id: d.to.teamId, position: null, role: null },
      reasons,
      screen,
      ootpSteps: steps,
      deadline: d.deadline,
      verify: d.verify,
      fortyMan: d.fortyMan,
      linked: [...d.linked].sort(),
      decision: { state: 'open', gameDate: null, outcome: null, verifiedGameDate: null, seenAt: null, deadlineDate: null },
    };
  };
  const hand = (v: number | string | null): string | null =>
    v === 1 || v === '1' ? 'R' : v === 2 || v === '2' ? 'L' : v === 3 || v === '3' ? 'S' : null;

  // Forced first, then by kind, deadline and fit; equal fits break the one
  // way every list does, so a catcher the big club is thin at is listed
  // before the man beside him and not merely after a lower player_id. The
  // protections are listed in the order they took their places, so each
  // card's 40-man count is the count after the ones above it
  const sortedDrafts = [...drafts].sort((a, b) =>
    Number(b.forced) - Number(a.forced) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
    (a.seq !== undefined && b.seq !== undefined ? a.seq - b.seq : 0) ||
    (a.deadline ? dateKey(parseDate(a.deadline.date)!) : Infinity) - (b.deadline ? dateKey(parseDate(b.deadline.date)!) : Infinity) ||
    (b.fit ?? -Infinity) - (a.fit ?? -Infinity) || Number(coversThinnest(b.man)) - Number(coversThinnest(a.man)) ||
    (b.man.pot ?? -1) - (a.man.pot ?? -1) || (b.man.oa ?? -1) - (a.man.oa ?? -1) || a.man.age - b.man.age || a.man.id - b.man.id);
  const moves = sortedDrafts.map(renderMove);

  // ── Levels ──
  const groupCounts = (list: Man[], by: (m: Man) => CountGroup = countGroup): GroupCounts => {
    const out: GroupCounts = { C: 0, IF: 0, OF: 0, SP: 0, RP: 0 };
    for (const m of list) out[by(m)]++;
    return out;
  };
  const readiness = (man: Man, at: RungKey): Readiness => {
    if (man.frozen) return 'frozen';
    const f = fitAt(man, at);
    if (f === null) return 'unscored';
    if (man.overmatched) return 'overmatched';
    if (man.target === 'above' || man.draft?.kind === 'promote' || man.draft?.kind === 'callup' || man.draft?.kind === 'forced') return 'ready';
    if (at === 'mlb' && f >= PROMOTE_FIT) return 'ready';
    return 'hold';
  };
  const staffOf = (rung: Rung, list: Man[]): { rotation: StaffRow[]; bullpen: StaffRow[] } => {
    const arms = list.filter((m) => m.isPitcher && !m.frozen);
    const by = tieBreak(rung.key);
    const row = (m: Man, tag: string | null): StaffRow => ({ player_id: m.id, name: m.name, fit: fit2(fitAt(m, rung.key)), tag });
    const size = ['mlb', 'aaa', 'aa'].includes(rung.key) ? ROTATION_UPPER : ROTATION_LOWER;
    const starters = arms.filter((m) => m.roleClass === 'SP').sort(by);
    const swing = arms.filter((m) => m.roleClass === 'swing').sort(by);
    const rotation: StaffRow[] = starters.slice(0, size).map((m) => row(m, null));
    const usedSwing = swing.slice(0, Math.max(0, size - rotation.length));
    rotation.push(...usedSwing.map((m) => row(m, 'swing')));
    // The bullpen is the closer and the RP- and swing-class men (§5.6). An
    // SP-class arm with no rotation spot is a starter waiting for one, not a
    // reliever, and the level's roster lists him as SP
    const pen = arms.filter((m) => m.roleClass !== 'SP' && !rotation.some((r) => r.player_id === m.id));
    const relievers = pen.filter((m) => m.roleClass === 'RP');
    const bestOa = Math.max(...relievers.map((m) => m.oa ?? -Infinity));
    const closer = relievers
      .filter((m) => m.oa !== null && m.oa >= bestOa - scaleGrade(CLOSER_WINDOW))
      .sort((a, b) => ((b.stuff ?? 0) + 0.5 * (b.hold ?? 0)) - ((a.stuff ?? 0) + 0.5 * (a.hold ?? 0)) ||
        Number(b.role === ROLE_CLOSER) - Number(a.role === ROLE_CLOSER) || a.id - b.id)[0] ?? null;
    const bullpen: StaffRow[] = [];
    if (closer) bullpen.push(row(closer, 'CL'));
    for (const m of pen.filter((m) => m !== closer).sort(by)) bullpen.push(row(m, m.specialist ?? (m.roleClass === 'swing' ? 'swing' : null)));
    return { rotation, bullpen };
  };
  const levels: PlanLevel[] = rungList.map((rung) => {
    const clubIds = rung.key === 'ic' ? [IC_TEAM] : rung.clubs.map((c) => c.team_id);
    const nowMen = men.filter((m) => m.rung === rung.key).sort((a, b) => a.id - b.id);
    const plannedMen = clubIds.flatMap(menAt).sort((a, b) => a.id - b.id);
    const nowHealthy = nowMen.filter((m) => !m.frozen);
    const plannedHealthy = plannedMen.filter((m) => !m.frozen);
    const structure: StructureRow[] = [];
    let tone: Tone = 'ok';
    let clubs: PlanLevelClub[] | undefined;
    if (rung.structure && rung.target) {
      const band = rung.target;
      const min = rung.structure.min;
      const maxOf = (g: StructureGroup): number | null => (g in rung.structure!.max ? rung.structure!.max[g as CountGroup] : null);
      // "Once he arrives" is said only of a man the plan brings to the club
      // now; a man staying put, and one leaving in the offseason, is there today
      const arriving = (m: Man): boolean => typeof m.plannedTeam === 'number' && m.plannedTeam !== m.teamId;
      const coverNames = (list: Man[], g: StructureGroup): string =>
        list.filter((m) => inGroup(m, g)).sort(tieBreak(rung.key)).slice(0, 3)
          .map((m) => `${m.name} ${grade(m.fielding.get(g === 'SS cover' ? 6 : 8)?.cur ?? null)}${arriving(m) ? ' once he arrives' : ''}`).join(', ');
      /*
       * Structure is a per-club minimum. On a rung of one club the row counts
       * that club; on the DSL pair it shows the club with the fewest, so a
       * club with one catcher is not hidden behind its sister club's four, and
       * the note gives each club's count.
       */
      const perClub = rung.clubs.map((c) => ({ club: c, men: healthyAt(c.team_id) }));
      for (const g of STRUCTURE_GROUPS) {
        const max = maxOf(g);
        const counts = perClub.map((p) => ({ ...p, have: p.men.filter((m) => inGroup(m, g)).length }));
        const worst = [...counts].sort((a, b) => a.have - b.have || a.club.team_id - b.club.team_id)[0];
        const have = worst?.have ?? 0;
        const need = min[g];
        const over = max !== null && counts.some((c) => c.have > max);
        const t: Tone = have < need ? 'bad' : over ? 'warn' : 'ok';
        const cover = g === 'SS cover' || g === 'CF cover';
        let note: string | undefined;
        if (counts.length > 1) {
          note = counts.map((c) => {
            const names = cover ? coverNames(c.men, g) : '';
            return `${c.club.label} ${c.have}${names ? ` (${names})` : ''}`;
          }).join('; ');
        } else if (cover) {
          note = coverNames(plannedHealthy, g) || undefined;
        }
        structure.push(note ? { group: g, have, need, tone: t, note } : { group: g, have, need, tone: t });
      }
      for (const id of clubIds) {
        const size = planned.get(id)?.size ?? 0;
        if (size < band.min) tone = 'bad';
        else if (size > band.max && tone !== 'bad') tone = 'warn';
      }
      if (structure.some((s) => s.tone !== 'ok') && tone === 'ok') tone = 'warn';
      // Each club of a two-club rung against the per-club band, which the
      // level's own figures (both clubs added) cannot be read against
      if (rung.clubs.length > 1) {
        clubs = rung.clubs.map((c) => {
          const planned_ = planned.get(c.team_id)?.size ?? 0;
          return {
            team_id: c.team_id, label: c.label,
            now: nowMen.filter((m) => m.teamId === c.team_id).length,
            planned: planned_, min: band.min, max: band.max,
            tone: planned_ < band.min ? 'bad' : planned_ > band.max ? 'warn' : 'ok',
          };
        });
      }
    }
    if (levelBad.has(rung.key)) tone = 'bad';
    const rows: PlanRosterRow[] = [...new Set([...nowMen, ...plannedMen])]
      .map((m): PlanRosterRow => {
        const here = plannedMen.includes(m);
        const was = nowMen.includes(m);
        const cap = rung.cap;
        return {
          player_id: m.id, name: m.name, age: m.age,
          positionName: m.isPitcher ? (m.p.throws === 2 ? 'LHP' : 'RHP') : POSITION_NAMES[m.position] ?? '?',
          roleLabel: m.isPitcher ? (m.role === ROLE_STARTER ? 'SP' : m.role === ROLE_CLOSER ? 'CL' : 'RP') : null,
          oa: m.oa, pot: m.pot, fit: fit2(fitAt(m, rung.key)), verdict: readiness(m, rung.key),
          // A pitcher's row at the club he leaves keeps the class he has there today
          utility: !here && m.isPitcher ? m.roleClassToday : m.utility, assetClass: m.assetClass,
          status: here && was ? 'stays' : here ? 'arrives' : 'leaves',
          frozen: m.frozen,
          lastEligibleSeason: cap !== null && statusPresent && m.proYears !== null && m.proYears <= cap ? cal.season + (cap - m.proYears) : null,
          flags: [...m.flags],
        };
      })
      .sort((a, b) => a.positionName.localeCompare(b.positionName) || (b.fit ?? -Infinity) - (a.fit ?? -Infinity) || a.player_id - b.player_id);
    const base = baselines[rung.key];
    return {
      rung: rung.key, rank: rung.rank, label: rung.label, levelName: rung.levelName,
      teamIds: rung.clubs.map((c) => c.team_id), leagueId: rung.leagueId, serviceCap: rung.cap,
      now: { roster: nowMen.length, healthy: nowHealthy.length, il: nowMen.filter((m) => m.onIl).length, groups: groupCounts(nowHealthy, countGroupToday) },
      planned: { roster: plannedMen.length, healthy: plannedHealthy.length, groups: groupCounts(plannedHealthy) },
      target: rung.target ?? { min: 0, max: rung.key === 'ic' ? settings.icSize : cal.activeLimit },
      structure,
      staff: rung.key === 'ic' ? { rotation: [], bullpen: [] } : staffOf(rung, plannedMen),
      needs: clubIds.flatMap((id) => needs.get(id) ?? []).filter((n) => !n.startsWith('need:') && !n.startsWith('size:')),
      baseline: { medAge: base.medAge, medOa: { pos: base.medOa.pos, sp: base.medOa.sp, rp: base.medOa.rp } },
      tone,
      roster: rows,
      ...(clubs ? { clubs } : {}),
    };
  });

  // ── The release-or-trade list, the strip, the counts ──
  const classOrder: AssetClass[] = ['surplus', 'depth', 'prospect', 'core'];
  const releaseOrTrade: ReleaseOrTradeRow[] = releaseRows
    .sort((a, b) =>
      classOrder.indexOf(a.man.assetClass ?? 'depth') - classOrder.indexOf(b.man.assetClass ?? 'depth') ||
      (fitAt(a.man, a.man.rung!) ?? -Infinity) - (fitAt(b.man, b.man.rung!) ?? -Infinity) || a.man.id - b.man.id)
    .map(({ man, draft: d }, i) => ({
      player_id: man.id, name: man.name, assetClass: man.assetClass ?? 'depth', modifiers: [...man.modifiers],
      kind: d.kind as 'trade' | 'release', rank: i + 1, reasons: moves.find((m) => m.key === d.key)?.reasons ?? [],
    }));

  const deadlines: DeadlineRow[] = [];
  for (const m of moves) {
    if (m.deadline) deadlines.push({ date: m.deadline.date, what: m.deadline.what, player_id: m.player.player_id, name: m.player.name, moveKey: m.key });
  }
  deadlines.push(...capDeadlines);
  for (const man of men) {
    if (man.frozen && man.capState === 'last-season' && man.rung && man.rung !== 'ic') {
      // The same walk the forced move makes: the first rung he may open next
      // season at, past every rung whose cap he would be over on arrival
      let dest: Rung | null = rungAbove(man.rung);
      const blockers: Rung[] = [];
      while (dest && !eligibleAt(man, dest, true).ok) {
        blockers.push(dest);
        dest = rungAbove(dest.key);
      }
      const end = seasonEndOf(man);
      const where = dest && blockers.length
        ? `${LEVEL_AT[dest.key]} or above, ${stepsUp(blockers.length)} (${listOf(blockers.map((b) => `${LEVEL_AT[b.key]} capped at ${b.cap}`))})`
        : dest ? `${LEVEL_AT[dest.key]} or above` : null;
      if (where && end) deadlines.push({ date: end, what: `Last eligible season at ${LEVEL_AT[man.rung]} — on the injured list, must open ${cal.season + 1} at ${where}`, player_id: man.id, name: man.name, moveKey: null });
    }
    if (man.minorFa === 'after-this-season' && !man.draft && !man.extra.length && man.assetClass !== 'surplus') {
      const end = seasonEndOf(man);
      if (end) deadlines.push({ date: end, what: `Minor-league free agent after this season — re-sign only if the level still needs him`, player_id: man.id, name: man.name, moveKey: null });
    }
  }
  deadlines.sort((a, b) => dateKey(parseDate(a.date)!) - dateKey(parseDate(b.date)!) || a.player_id - b.player_id);

  const fullSeasonClubs = rungList.filter((r) => FULL_SEASON.includes(r.key)).flatMap((r) => r.clubs);
  const ages: Record<string, number> = {};
  for (const m of icPool) ages[String(m.age)] = (ages[String(m.age)] ?? 0) + 1;
  const methodBaselines: PlanMethod['baselines'] = {};
  for (const r of rungList) {
    const b = baselines[r.key];
    methodBaselines[r.key] = {
      pos: { medOa: b.medOa.pos, medAge: b.medAge, n: b.n.pos },
      sp: { medOa: b.medOa.sp, medAge: b.medAge, n: b.n.sp },
      rp: { medOa: b.medOa.rp, medAge: b.medAge, n: b.n.rp },
    };
  }

  return {
    orgId,
    gameDate: fmtDate(cal.today),
    season: cal.season,
    settings,
    warnings,
    org: {
      fullSeasonNow: men.filter((m) => m.rung !== null && FULL_SEASON.includes(m.rung)).length,
      fullSeasonMin: fullSeasonClubs.length * settings.targets.fullSeason.min,
      fullSeasonMax: fullSeasonClubs.length * settings.targets.fullSeason.max,
      fortyMan: { count: fortyCount, limit: cal.fortyLimit },
      ic: { size: poolSize, max: settings.icSize, ages },
      mlbThinnest: thinnest,
    },
    levels,
    moves,
    releaseOrTrade,
    leaving: leaving.sort((a, b) => a.player_id - b.player_id),
    deadlines,
    counts: countMoves(moves, men.filter((m) => m.rule5).length),
    method: {
      rungStep: { bat: rungStep, pit: rungStep },
      weights: WEIGHTS,
      recency: RECENCY,
      prior: PRIOR,
      gates: GATES,
      baselines: methodBaselines,
    },
  };
}

/** Moves by kind and by decision state; the Rule 5 count rides along unchanged. */
function countMoves(moves: PlanMove[], rule5Eligible: number): PlanCounts {
  const counts = Object.fromEntries(KIND_ORDER.map((k) => [k, 0])) as Record<MoveKind, number>;
  const out: PlanCounts = { ...counts, offseason: 0, open: 0, accepted: 0, dismissed: 0, done: 0, rule5Eligible };
  for (const m of moves) {
    out[m.kind]++;
    if (m.horizon === 'offseason') out.offseason++;
    if (m.decision.state === 'open') out.open++;
    else if (m.decision.state === 'dismissed') out.dismissed++;
    else if (m.decision.outcome === 'done') out.done++;
    else out.accepted++;
  }
  return out;
}

// ── Decisions ───────────────────────────────────────────────────────────

export type ShowFilter = 'open' | 'accepted' | 'dismissed' | 'all';

const OPEN: MoveDecision = { state: 'open', gameDate: null, outcome: null, verifiedGameDate: null, seenAt: null, deadlineDate: null };

/**
 * Whether an import has settled a decision for good: an acceptance seen done,
 * or a dismissal (or an acceptance) gone moot. Such a decision has been used
 * up, so it no longer applies to the same key: a man promoted, seen there and
 * then sent back, regenerates the old key, and the move is a fresh
 * recommendation, not the one he was accepted on. A `not-yet` acceptance
 * is still shown on the card, and so is a `changed` one while the card asks
 * the same question (decisionOnCard), so the page can say what was not done;
 * the engine stops acting on a changed one (decisionLive).
 */
export function decisionRetired(d: Pick<PlanDecision, 'outcome'>): boolean {
  return d.outcome === 'done' || d.outcome === 'moot';
}

/**
 * Whether the engine still acts on a decision: only while no import has
 * settled it, its outcome null or not-yet. A protection accepted and not
 * made by its deadline (changed) no longer reserves the first place, and a
 * dismissal that lapsed at its deadline (moot) no longer gives one up, so
 * next winter's question about the same man is judged on its merits.
 */
export function decisionLive(d: Pick<PlanDecision, 'outcome'>): boolean {
  return d.outcome === null || d.outcome === 'not-yet';
}

/**
 * Whether a stored decision is about the question a card asks today: the
 * card's deadline is the one the decision was made against. The 40-man
 * question keeps one key from winter to winter, so a protection accepted
 * for the 2028-12-20 deadline and not made shares its key with next
 * winter's question, which is a new one. A decision stored without a
 * deadline (an older row, or an undated move) is taken to be about the card.
 */
function sameQuestion(m: Pick<PlanMove, 'deadline'>, d: Pick<PlanDecision, 'deadlineDate'>): boolean {
  const then = parseDate(d.deadlineDate);
  if (!then) return true;
  const now = parseDate(m.deadline?.date ?? null);
  return now !== null && dateKey(now) === dateKey(then);
}

/**
 * The decision a live card carries, or null when the card is open. A
 * decision still in play stays on its card. One an import settled for good
 * (done, or moot) is used up, and the card is open again. One settled as not
 * done (changed) stays on its card while the card asks the same question, so
 * the page can say what was not done; once the card asks about a later
 * deadline, the card is open and the old decision is listed on its own row.
 * The page and the dashboard's count both read openness from here.
 */
export function decisionOnCard(m: Pick<PlanMove, 'deadline'>, d: PlanDecision | null | undefined): PlanDecision | null {
  if (!d || decisionRetired(d)) return null;
  if (!decisionLive(d) && !sameQuestion(m, d)) return null;
  return d;
}

/** The sentence a fresh move carries when the same key was decided and settled before. */
function againSentence(d: PlanDecision): string {
  const seen = d.verifiedGameDate ?? 'an earlier';
  if (d.state === 'accepted' && d.outcome === 'changed') {
    return `Asked again: it was accepted on ${d.gameDate ?? 'an earlier date'} for the ${d.deadlineDate ?? 'earlier'} deadline, and the ${seen} export found it not done.`;
  }
  if (d.state === 'dismissed') {
    // A dismissal that lapsed at its deadline, rather than one the plan stopped listing
    const due = parseDate(d.deadlineDate);
    const looked = parseDate(d.verifiedGameDate);
    if (due && looked && dateKey(looked) > dateKey(due)) {
      return `Asked again: it was dismissed on ${d.gameDate ?? 'an earlier date'} for the ${d.deadlineDate} deadline, which had passed by the ${seen} export.`;
    }
    return `Recommended again: it was dismissed on ${d.gameDate ?? 'an earlier date'}, and the plan stopped listing it by the ${seen} export.`;
  }
  if (d.outcome === 'moot') return `Recommended again: it was accepted on ${d.gameDate ?? 'an earlier date'}, and the ${seen} export found him out of the organization.`;
  return `Recommended again after it was done on ${seen}: he is back where the move started.`;
}

/** The stored decision as a move's `decision` field. */
const decisionOf = (d: PlanDecision): MoveDecision => ({
  state: d.state, gameDate: d.gameDate, outcome: d.outcome, verifiedGameDate: d.verifiedGameDate,
  seenAt: d.seenAt ?? null, deadlineDate: d.deadlineDate ?? null,
});

/**
 * The list a move asks a place on, for a move about a list rather than a
 * club: a protection (the 40-man) or the 60-day list. Null for every other move.
 */
const listOfDecision = (d: Pick<PlanDecision, 'verify' | 'toRung'>): string | null =>
  d.verify?.field === 'on40' || d.toRung === '40man' ? 'the 40-man roster'
  : d.verify?.field === 'il60' ? 'the 60-day injured list'
  : null;

/** The first sentence of an accepted move the plan no longer produces: what the import saw, never what happened. */
function settledSentence(d: PlanDecision): string {
  const on = d.gameDate ?? 'an earlier date';
  const seen = d.verifiedGameDate;
  const at = d.seenAt ? (/^out of /i.test(d.seenAt) ? d.seenAt : `on ${d.seenAt}`) : null;
  // A move about a list did not send him anywhere: what the import saw is that he is not on the list
  const list = listOfDecision(d);
  switch (d.outcome) {
    case 'done': return `Accepted on ${on} and seen done in the ${seen} export${at ? `, ${at}` : ''}.`;
    case 'changed':
      if (list) return `Accepted on ${on}; the ${seen} export found him ${at ? `${at}, not on ${list}` : `not on ${list}`}.`;
      return `Accepted on ${on}; the ${seen} export found him ${at ? `${at}, not where the move sent him` : 'somewhere other than where the move sent him'}.`;
    case 'moot': return `Accepted on ${on}; the ${seen} export found him out of the organization, so the move no longer applies.`;
    default: return `Accepted on ${on}; the plan no longer recommends this move${seen ? `, and the ${seen} export has not seen it made` : ''}.`;
  }
}

/**
 * An accepted move the engine no longer produces, rebuilt from its stored
 * row so the page can still show what the import saw ("Done — on Tulsa in
 * the 2028-8-4 export"). He is read from the plan's own rows while he is in
 * the organisation, and from the players table once he has left it.
 */
function settledMove(plan: Plan, d: PlanDecision, rows: Map<number, PlanRosterRow>, clubLabels: Map<number, string>): PlanMove {
  const r = rows.get(d.player_id);
  const p = !r && tableExists('players')
    ? (db.prepare(`SELECT age, position, role, bats, throws FROM players WHERE player_id = ?`).get(d.player_id) as
        { age: number; position: number; role: number; bats: number | null; throws: number | null } | undefined)
    : undefined;
  const hand = (v: number | null | undefined): string | null => (v === 1 ? 'R' : v === 2 ? 'L' : v === 3 ? 'S' : null);
  const name = r?.name ?? d.playerName ?? `Player ${d.player_id}`;
  const label = (rung: string | null, teamId: number | null): string =>
    rung === 'ic' ? 'International complex' : rung === 'out' ? (d.kind === 'trade' ? 'traded' : 'released')
    : rung === '40man' ? '40-man roster'
    : (teamId !== null ? clubLabels.get(teamId) : undefined) ?? plan.levels.find((l) => l.rung === rung)?.label ?? String(rung ?? '');
  const fromLabel = label(d.fromRung, d.fromTeamId);
  // The deadline it was accepted against, so the card can say which one passed
  const due = parseDate(d.deadlineDate);
  const today = parseDate(plan.gameDate);
  const deadline: Deadline | null = due && d.deadlineDate ? {
    kind: listOfDecision(d) === 'the 40-man roster' ? 'rule5'
      : d.kind === 'trade' ? 'trade-deadline'
      : d.kind === 'forced' ? 'service-cap'
      : 'season-end',
    date: d.deadlineDate,
    what: `The deadline the move was accepted against — ${name}`,
    daysAway: today ? daysBetween(today, due) : 0,
  } : null;
  return {
    key: d.moveKey,
    kind: d.kind,
    horizon: d.horizon ?? 'now',
    forced: false,
    player: {
      player_id: d.player_id, name, age: r?.age ?? p?.age ?? 0,
      positionName: r?.positionName ?? (p ? (p.position === 1 ? (p.throws === 2 ? 'LHP' : 'RHP') : POSITION_NAMES[p.position] ?? '?') : '?'),
      roleLabel: r?.roleLabel ?? (p && p.position === 1 ? (p.role === ROLE_STARTER ? 'SP' : p.role === ROLE_CLOSER ? 'CL' : 'RP') : null),
      oa: r?.oa ?? null, pot: r?.pot ?? null, bats: hand(p?.bats), throws: hand(p?.throws),
      utility: r?.utility ?? null, assetClass: r?.assetClass ?? null,
    },
    from: { rung: (d.fromRung ?? 'mlb') as RungKey, label: fromLabel, team_id: d.fromTeamId },
    to: { rung: (d.toRung ?? 'out') as PlanMove['to']['rung'], label: label(d.toRung, d.toTeamId), team_id: d.toTeamId, position: d.target, role: null },
    reasons: [settledSentence(d)],
    screen: 'Player page',
    ootpSteps: [`Open ${name} (${fromLabel})`, 'No move: the plan no longer lists it'],
    deadline,
    verify: d.verify,
    fortyMan: null,
    linked: [],
    decision: decisionOf(d),
  };
}

/**
 * The plan with the user's decisions laid over it, and the counts taken
 * after. The cached plan is never mutated — a decision is a view of it, not
 * a change to it.
 *
 * - A dismissed move is removed (kept under `show=dismissed`), and so are its
 *   line on the deadlines strip and its row on the release-or-trade list,
 *   whatever the filter: those are lists of things still to do.
 * - An accepted move carries its outcome and where the import found him
 *   (`seenAt`). One the plan no longer produces — done, changed, gone, or
 *   simply no longer recommended — is rebuilt from its stored row, so the
 *   page can show every outcome under `show=accepted` and `show=all`.
 * - A decision an import settled for good (done, or moot) is used up: when
 *   the plan produces the same key again, the move is shown open, with a
 *   sentence saying it is recommended again.
 * - A settled decision whose card now asks about a later deadline (next
 *   winter's 40-man question, under the same key) is not that card's: the
 *   card is open, to be decided afresh, and an accepted decision is listed
 *   beside it on a row of its own with the deadline it was made against.
 */
export function overlayDecisions(plan: Plan, decisions: Map<string, PlanDecision>, show: ShowFilter): Plan {
  const live = new Set(plan.moves.map((m) => m.key));
  // Accepted decisions settled under an earlier deadline than their card's
  const apart: PlanDecision[] = [];
  const moves = plan.moves.map((m): PlanMove => {
    const d = decisions.get(m.key);
    if (!d) return { ...m, decision: OPEN };
    const on = decisionOnCard(m, d);
    if (on) return { ...m, decision: decisionOf(on) };
    if (d.state === 'accepted' && !decisionLive(d) && !sameQuestion(m, d)) apart.push(d);
    return { ...m, reasons: [...m.reasons, againSentence(d)], decision: OPEN };
  });
  const rows = new Map<number, PlanRosterRow>();
  const clubLabels = new Map<number, string>();
  for (const l of plan.levels) {
    for (const r of l.roster) if (!rows.has(r.player_id)) rows.set(r.player_id, r);
    if (l.teamIds.length === 1) clubLabels.set(l.teamIds[0], l.label);
    for (const c of l.clubs ?? []) clubLabels.set(c.team_id, c.label);
  }
  const settled = [...[...decisions.values()].filter((d) => d.state === 'accepted' && !live.has(d.moveKey)), ...apart]
    .sort((a, b) => a.moveKey.localeCompare(b.moveKey))
    .map((d) => settledMove(plan, d, rows, clubLabels));
  const all = [...moves, ...settled];
  const shown = all.filter((m) => {
    const s = m.decision.state;
    switch (show) {
      case 'all': return true;
      case 'accepted': return s === 'accepted';
      case 'dismissed': return s === 'dismissed';
      default: return s === 'open';
    }
  });
  const rule5 = plan.counts.rule5Eligible;
  const counts = countMoves(all, rule5);
  const byKind = countMoves(shown, rule5);
  for (const k of KIND_ORDER) counts[k] = byKind[k];
  counts.offseason = byKind.offseason;
  const dismissed = moves.filter((m) => m.decision.state === 'dismissed');
  if (dismissed.length === 0) return { ...plan, moves: shown, counts };
  const dismissedKeys = new Set(dismissed.map((m) => m.key));
  const dismissedOut = new Set(dismissed.filter((m) => m.kind === 'release' || m.kind === 'trade').map((m) => `${m.kind}:${m.player.player_id}`));
  return {
    ...plan,
    moves: shown,
    counts,
    releaseOrTrade: plan.releaseOrTrade
      .filter((r) => !dismissedOut.has(`${r.kind}:${r.player_id}`))
      .map((r, i) => ({ ...r, rank: i + 1 })),
    deadlines: plan.deadlines.filter((d) => d.moveKey === null || !dismissedKeys.has(d.moveKey)),
  };
}

/**
 * Where a man stands in the current export, for the verifier: his rung on
 * the org's ladder, whether he is still in the org, on the 40-man, on the
 * 60-day list, on a roster at all, and which club.
 */
export function planStandingOf(orgId: number, playerId: number): Standing | null {
  if (!tableExists('players')) return null;
  const ladder = rungs(orgId);
  if (!ladder) return null;
  const clubRung = new Map<number, RungKey>();
  const clubName = new Map<number, string>();
  for (const r of ladder.rungs) for (const c of r.clubs) { clubRung.set(c.team_id, r.key); clubName.set(c.team_id, c.label); }
  const row = db
    .prepare(
      `SELECT player_id, team_id, organization_id, position, role, retired,
              ${hasColumns('players', 'league_id') ? 'league_id' : 'NULL AS league_id'}
       FROM players WHERE player_id = ?`
    )
    .get(playerId) as { player_id: number; team_id: number; organization_id: number; position: number; role: number; retired: number; league_id: number | null } | undefined;
  if (!row) return null;
  const inOrg = row.organization_id === orgId && row.retired === 0;
  const listed = tableExists('team_roster')
    ? (db.prepare(`SELECT team_id, list_id FROM team_roster WHERE player_id = ? ORDER BY team_id, list_id`).all(playerId) as Array<{ team_id: number; list_id: number }>)
    : [];
  const rosterTeams = listed.filter((l) => l.list_id !== 3).map((l) => l.team_id);
  const teamId = rosterTeams.includes(row.team_id) ? row.team_id : rosterTeams[0] ?? null;
  const st = tableExists('players_roster_status')
    ? (db.prepare(`SELECT ${['is_active', 'is_on_secondary', 'is_on_dl', 'is_on_dl60'].map((c) => (hasColumns('players_roster_status', c) ? c : `NULL AS ${c}`)).join(', ')} FROM players_roster_status WHERE player_id = ?`).get(playerId) as Record<string, number | null> | undefined)
    : undefined;
  const rostered = rosterTeams.length > 0;
  const rung: RungKey | null = !inOrg ? null : rostered && teamId !== null ? clubRung.get(teamId) ?? null : (row.league_id ?? 0) < 0 ? 'ic' : null;
  const on40 = listed.some((l) => l.team_id === orgId && l.list_id === 3) || st?.is_active === 1 || st?.is_on_secondary === 1;
  return {
    rung, inOrg, position: row.position,
    roleClass: row.position === 1 ? (row.role === ROLE_STARTER ? 'SP' : row.role === ROLE_CLOSER ? 'CL' : 'RP') : null,
    on40, il60: st?.is_on_dl60 === 1, rostered, teamId,
    /*
     * The same words the plan's moves use for the club (move.from.label and
     * move.to.label), so the page can tell "still on Tulsa" from "went
     * somewhere else" by comparing the two.
     */
    teamLabel: !inOrg ? null : rung === 'ic' ? 'International complex' : teamId !== null ? clubName.get(teamId) ?? null : null,
  };
}

/** Checks every accepted move against the export just imported; called from the import right after the snapshot. */
export function verifyPlanDecisions(): PlanDecision[] {
  const gameDate = leagueGameDate();
  if (!gameDate) return [];
  return verifyDecisions(planStandingOf, gameDate);
}

// ── Routes ──────────────────────────────────────────────────────────────

export const plannerRoutes = Router();

const readShow = (v: unknown): ShowFilter =>
  v === 'accepted' || v === 'dismissed' || v === 'all' ? v : 'open';

plannerRoutes.get('/plan/:orgId', (req, res) => {
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });
  const orgId = Number(req.params.orgId);
  const plan = computePlan(orgId);
  if (!plan) return res.status(404).json({ error: 'Unknown org' });
  // A dismissal the planner no longer produces is retired, so it is not shown forever
  retireDismissals(orgId, plan.moves.map((m) => m.key));
  res.json(overlayDecisions(plan, planDecisions(orgId), readShow(req.query.show)));
});

/**
 * The brief's own check beside the verifier's: did his level change between
 * the last two snapshots? Null until two have been taken. Read from
 * history.db's rating_snapshots, which the import writes before the verifier
 * runs, so the two always describe the same export.
 */
function levelChangedOf(playerId: number): boolean | null {
  const rows = historyDb
    .prepare(
      `SELECT level FROM rating_snapshots WHERE save_name = ? AND player_id = ?
       ORDER BY ${DATE_KEY('game_date')} DESC LIMIT 2`
    )
    .all(currentSaveName(), playerId) as Array<{ level: number | null }>;
  return rows.length < 2 ? null : rows[0].level !== rows[1].level;
}

plannerRoutes.get('/plan/:orgId/decisions', (req, res) => {
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });
  const orgId = Number(req.params.orgId);
  res.json({ decisions: [...planDecisions(orgId).values()].map((d) => ({ ...d, levelChanged: levelChangedOf(d.player_id) })) });
});

plannerRoutes.post('/plan/:orgId/decisions', (req, res) => {
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });
  const orgId = Number(req.params.orgId);
  const { moveKey, decision } = (req.body ?? {}) as { moveKey?: unknown; decision?: unknown };
  if (decision !== 'accepted' && decision !== 'dismissed') {
    return res.status(400).json({ ok: false, error: 'decision must be "accepted" or "dismissed".' });
  }
  const plan = computePlan(orgId);
  if (!plan) return res.status(404).json({ error: 'Unknown org' });
  const move = typeof moveKey === 'string' ? plan.moves.find((m) => m.key === moveKey) : undefined;
  if (!move) return res.status(400).json({ ok: false, error: 'moveKey is not in the current plan.' });
  res.json({ ok: true, decision: decidePlanMove(orgId, move, decision) });
});

plannerRoutes.delete('/plan/:orgId/decisions/:moveKey', (req, res) => {
  const orgId = Number(req.params.orgId);
  res.json({ ok: reopenPlanMove(orgId, String(req.params.moveKey)) });
});
