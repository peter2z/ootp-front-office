import { SERVICE_DAYS_PER_YEAR } from './contracts.js';
import { scaleGrade } from './valuation.js';

/**
 * The roster rules every page and the planner read, each written once.
 *
 * The 40-Man Roster page, the player card and the farm pages each kept their
 * own copy of what "out of options" meant, and the page read the Rule 5
 * protection column backwards (see {@link rule5Eligible}), so two screens could
 * say opposite things about the same man. These are the predicates, with the
 * column semantics they rest on written beside them, and nothing else holds a
 * copy. Thresholds chosen on the 20-80 scale go through scaleGrade() so a save
 * on another scale is judged at the same share of its own top.
 */

/** Options a man is given. Use all three and he can no longer be sent down for free. */
export const OPTIONS_ALLOWED = 3;

/**
 * Past this much major-league service a man cannot be sent down against his
 * will, so having no options left costs the club nothing with him. Under it,
 * it is exactly what forces a designation when the roster is full.
 */
export const OPTION_FREE_SERVICE_YEARS = 5;

/**
 * Pro service years at which a man on a minor-league deal becomes a
 * minor-league free agent after the season, when the save does not say
 * (`leagues.rules_minor_league_fa_minimum_years` on the MLB row carries it).
 */
export const MINOR_FA_MINIMUM_YEARS = 6;

/** Major-league service in years: exact from the days where the export has them. */
export const serviceYearsOf = (
  days: number | null | undefined, years: number | null | undefined
): number => (typeof days === 'number' ? days / SERVICE_DAYS_PER_YEAR : years ?? 0);

/** Out of options in the sense that binds the club. No count at all means the export does not say. */
export function outOfOptions(optionsUsed: number | null | undefined, serviceYears: number): boolean {
  return typeof optionsUsed === 'number' && optionsUsed >= OPTIONS_ALLOWED &&
    serviceYears < OPTION_FREE_SERVICE_YEARS;
}

/**
 * What the option rules let the club do with a man on the 40-man.
 *
 *   sendable          he can be optioned, and this is not his last year of it
 *   last-option-year  his third option year: next spring he makes the 26 or
 *                     has to clear waivers
 *   out-of-options    all three used and none this year, so a send-down means
 *                     waivers
 *   never-sendable    five or more years of service: he can refuse the
 *                     assignment, so options do not bind him either way
 *   n/a               not on the 40-man, where options do not apply
 */
export type OptionState = 'sendable' | 'last-option-year' | 'out-of-options' | 'never-sendable' | 'n/a';

export interface OptionFacts {
  /** `players_roster_status.options_used`; null where the export lacks it. */
  optionsUsed: number | null | undefined;
  /** `options_used_this_year`: 1 when this season's option is already among the used. */
  optionsUsedThisYear: number | null | undefined;
  on40: boolean;
  on26: boolean;
  /** Major-league service in years, from {@link serviceYearsOf}. */
  serviceYears: number;
}

/**
 * The option state, read the way OOTP keeps the two counters.
 *
 * `options_used` and `options_used_this_year` are both incremented the day a
 * man is optioned (Michael Petersen: 3 used, 1 this year, in the minors), so
 * this season's option is already counted. That makes (3 used, 1 this year)
 * his LAST option year and not "out of options": the year is spent, he can be
 * sent down and recalled freely until it ends, and only next spring does the
 * missing option bite. (3, 0) is out of options now. A 40-man man in the
 * minors at (2, 0) is in his last option year too, because the next option
 * taken is his third; at (2, 1) he has one left and next year is the last.
 *
 * A man on the 26 at two used gets no warning: that is a minor leaguer's
 * reading, and the page has never raised it on the big club.
 *
 * Five years of service come first, since past them a man can refuse the
 * assignment whatever his count says; off the 40 the question does not arise.
 */
export function optionState(f: OptionFacts): OptionState {
  if (!f.on40) return 'n/a';
  if (f.serviceYears >= OPTION_FREE_SERVICE_YEARS) return 'never-sendable';
  const used = typeof f.optionsUsed === 'number' ? f.optionsUsed : 0;
  const thisYear = (f.optionsUsedThisYear ?? 0) >= 1;
  if (used >= OPTIONS_ALLOWED) return thisYear ? 'last-option-year' : 'out-of-options';
  if (used === OPTIONS_ALLOWED - 1 && !thisYear && !f.on26) return 'last-option-year';
  return 'sendable';
}

export interface Rule5Facts {
  on40: boolean;
  /** `players_roster_status.pro_service_years`. */
  proServiceYears: number | null | undefined;
  /** `players_roster_status.years_protected_from_rule_5`. */
  protectedYears: number | null | undefined;
}

/**
 * Whether the Rule 5 draft can take him this winter.
 *
 * `years_protected_from_rule_5` is the LENGTH of his protection — 5 for a man
 * signed at 18 or under, 4 otherwise — and not a countdown. The 40-Man page
 * read it as a countdown ("protected <= 0 means exposed") and on one save
 * flagged one man where 115 were eligible: everyone carries a 4 or a 5 for
 * the whole of his career, so the column never reaches zero. Eligible means
 * his pro service has caught up with his protection, and he is not on the
 * 40-man, which is the one thing that shields him. A zero or missing
 * protection says the export does not know, so nobody is called eligible on
 * it.
 */
export function rule5Eligible(f: Rule5Facts): boolean {
  const years = f.proServiceYears ?? 0;
  const shield = f.protectedYears ?? 0;
  return !f.on40 && shield > 0 && years >= shield;
}

export interface ProtectFacts {
  /** OOTP's Overall and Potential, on the save's scale; null when the export lacks them. */
  oa: number | null | undefined;
  pot: number | null | undefined;
  /** The planner's production index, 100 = average; null where no readable sample. */
  productionIndex: number | null;
}

/** The ceiling that earns a 40-man place on grade alone (20-80). */
export const PROTECT_POT = 50;
/** The present grade that earns one with the production behind it (20-80). */
export const PROTECT_OA = 40;
/** The production index that stands in for the ceiling. */
export const PROTECT_INDEX = 110;

/**
 * Whether an eligible man is worth a 40-man place: a ceiling of 50, or a 40
 * now with an index of 110 at his level to show he is already producing
 * past it. Grade alone would miss a man like Emil Morales (41 with a 43
 * ceiling and a 1.072 OPS at Double-A), which is why the second branch is
 * there; the page, which carries no production index, passes null and judges
 * on the first branch only. Missing grades fail both branches: nobody is
 * recommended for a place on a blank.
 */
export function rule5ProtectGate(f: ProtectFacts): boolean {
  const pot = typeof f.pot === 'number' ? f.pot : null;
  const oa = typeof f.oa === 'number' ? f.oa : null;
  if (pot !== null && pot >= scaleGrade(PROTECT_POT)) return true;
  return oa !== null && oa >= scaleGrade(PROTECT_OA) &&
    f.productionIndex !== null && f.productionIndex >= PROTECT_INDEX;
}

export interface MinorFaFacts {
  /** `players_contract.is_major = 1`: a major-league deal, which the rule does not touch. */
  majorContract: boolean;
  on40: boolean;
  proServiceYears: number | null | undefined;
}

/** When a man reaches minor-league free agency, or null when he is not close. */
export type MinorFaTiming = 'after-this-season' | 'after-next-season' | null;

/**
 * Minor-league free agency, from pro service years against the league's
 * minimum (six on an ordinary save). A man at the minimum walks after this
 * season; one year short walks after next. Only a man on a minor-league deal
 * and off the 40-man is subject to it: the 40-man and a major-league contract
 * are both forms of control that outrank the rule.
 */
export function minorLeagueFaAfterSeason(
  f: MinorFaFacts, minimumYears: number | null | undefined = MINOR_FA_MINIMUM_YEARS
): MinorFaTiming {
  if (f.majorContract || f.on40) return null;
  const min = typeof minimumYears === 'number' && minimumYears > 0 ? minimumYears : MINOR_FA_MINIMUM_YEARS;
  const years = f.proServiceYears ?? 0;
  if (years >= min) return 'after-this-season';
  if (years === min - 1) return 'after-next-season';
  return null;
}

/**
 * Where a man stands against his level's pro-service cap.
 *
 *   ok           under the cap, or no cap at this level
 *   last-season  at the cap: a rostered man gains a year per season, so this
 *                is the last he may open here and he must be a level up by
 *                next Opening Day
 *   over         past the cap, which OOTP would not allow: the roster is
 *                invalid today
 *
 * OOTP enforces the limit without exporting it; the caps come from Settings
 * (OOTP's standard table by default). A null cap means the level has none.
 */
export type ServiceCapState = 'ok' | 'last-season' | 'over';

export function serviceCapState(years: number | null | undefined, cap: number | null | undefined): ServiceCapState {
  if (typeof cap !== 'number') return 'ok';
  const y = years ?? 0;
  if (y > cap) return 'over';
  if (y === cap) return 'last-season';
  return 'ok';
}
