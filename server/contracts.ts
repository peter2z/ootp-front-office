import { Router } from 'express';
import { db, tableExists } from './db.js';
import { formDoubtsValue, seasonFormByPlayer, type SeasonForm } from './form.js';
import {
  contractsByPlayer, currentGameDate, leagueRules, mlbPercentiler, ON_ROSTER, ROLE_STARTER,
  seasonYear, teamFinances, valuesByPlayer,
} from './valuation.js';

export const contractRoutes = Router();

/** Days of major-league service that make one service year. */
export const SERVICE_DAYS_PER_YEAR = 172;

/**
 * How much service a player still on the major-league roster can bank between
 * now and the end of the season, as a fraction of a service year.
 *
 * The export publishes `mlb_service_days_this_year`, so the season's progress
 * is whatever the most-tenured man on a major-league roster has banked: he has
 * been up since Opening Day, so his total is the season's own clock. In the
 * off-season that reaches 172 and nothing is left to earn; before Opening Day
 * it is 0 and a full year remains.
 */
export function serviceRemainingThisSeason(): number {
  if (!tableExists('players_roster_status') || !tableExists('teams')) return 1;
  const row = db
    .prepare(
      `SELECT MAX(rs.mlb_service_days_this_year) AS banked
       FROM players_roster_status rs
       JOIN players p ON p.player_id = rs.player_id
       JOIN teams t ON t.team_id = p.team_id
       WHERE t.level = 1`
    )
    .get() as { banked: number | null } | undefined;
  const banked = row?.banked;
  // An export without the column behaves as it always did, adding a full year
  if (typeof banked !== 'number' || !Number.isFinite(banked)) return 1;
  return Math.min(Math.max(SERVICE_DAYS_PER_YEAR - banked, 0), SERVICE_DAYS_PER_YEAR) / SERVICE_DAYS_PER_YEAR;
}

const POSITION_NAMES: Record<number, string> = {
  1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF', 10: 'DH',
};

/**
 * 43rd, not 43th. The suffix follows the last digit, except that 11, 12 and 13 take "th".
 * Written out here rather than imported: the same helper is ordinal() in src/stats.ts.
 */
function ordinal(n: number): string {
  const lastTwo = n % 100;
  return `${n}${lastTwo >= 11 && lastTwo <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`;
}

export interface Recommendation {
  action: string;
  reasons: string[];
}

/**
 * The recommendations that amount to "commit to this man".
 *
 * These are the ones that must not rest on the Value figure alone, because
 * that figure counts playing time: a long reliever with an earned run average
 * over six can sit in the top tenth of the reliever pool purely for the number
 * of innings he has soaked up, and the advice was telling its reader to extend
 * him before somebody else did.
 */
const COMMITTING = new Set([
  'Core keeper', 'Extension candidate', 'Extend now', 'Re-sign', 'Re-sign short-term',
]);

/**
 * What "Extend now" becomes when the season has had no say in it.
 *
 * "Now" is an urgency, and the only thing that can earn one is evidence. Andres
 * Munoz was told to extend now and, in the same cell, that eleven innings were
 * too little to judge: the two halves of that sentence cancel. Said this way it
 * is a claim about the value figure and not about the clock.
 */
export const EXTEND_VALUE_ONLY = 'Extend (value only)';

/** Every action that asks the club to put money on a man, and so gets suggested terms. */
const OFFERS = new Set([...COMMITTING, EXTEND_VALUE_ONLY]);

/**
 * Whether an action is a call to extend, for anything that counts them.
 *
 * The dashboard counts "extension candidates" by comparing the action word, and
 * a new word for the same call must not quietly fall out of its total.
 */
export const isExtensionAction = (action: string | null | undefined): boolean =>
  action === 'Extension candidate' || action === 'Extend now' || action === EXTEND_VALUE_ONLY;

/**
 * The line for buying out a man's arbitration years early: the top quarter by
 * value, and 28 or younger so that the years bought are prime ones.
 *
 * Named once because two things read it: the advice itself, and the sentence
 * explaining why a man below it was not advised. Written twice they drift.
 */
const BUYOUT_MIN_PCT = 75;
const BUYOUT_MAX_AGE = 28;

/**
 * The value-based reading, before the season is allowed to speak.
 *
 * Kept whole and separate so the two arguments stay legible: this is what a
 * man is worth on paper, and the gate below is what he has actually done.
 */
function recommendOnValue(args: {
  age: number;
  yearsAfterThis: number;
  reachingFA: boolean;
  hasFreeAgency: boolean;
  overallPct: number | null;
  talentPct: number | null;
  salaryNow: number;
}): Recommendation | null {
  const { age, yearsAfterThis, reachingFA, hasFreeAgency, overallPct, talentPct, salaryNow } = args;
  if (overallPct === null) return null;
  const declining = talentPct !== null && overallPct - talentPct >= 15;
  // The best man in a pool is at the 100th percentile, and "top 0%" is not a thing to say of anybody
  const topPct = Math.max(100 - overallPct, 1);

  // Under the reserve clause there is no market to lose a player to, so the
  // question is never "extend before he walks" — it is whether he is worth
  // keeping and what he will hold out for.
  if (!hasFreeAgency) {
    if (overallPct >= 70 && age <= 29) {
      return { action: 'Core keeper', reasons: [`top ${topPct}% value, prime years ahead — renew`] };
    }
    if (declining && age >= 32) {
      return { action: 'Consider moving', reasons: ['talent slipping below production — sell while value holds'] };
    }
    if (overallPct < 30) {
      return { action: 'Release candidate', reasons: [`bottom ${overallPct}% value`] };
    }
    return null;
  }

  if (yearsAfterThis === 0 && !reachingFA) {
    // Deal ends but the player lacks the service time to leave — auto-renews
    if (overallPct >= BUYOUT_MIN_PCT && age <= BUYOUT_MAX_AGE) {
      return { action: 'Extension candidate', reasons: ['team-controlled — buy out arb/FA years while cheap'] };
    }
    return null;
  }

  if (yearsAfterThis === 0) {
    // Expiring after this season
    const reasons: string[] = [];
    if (declining) reasons.push('scouted talent below current production — decline risk');
    if (overallPct >= 70 && age <= 29) {
      return { action: 'Extend now', reasons: [`top ${topPct}% MLB value, prime years ahead`, ...reasons] };
    }
    if (overallPct >= 70 && age <= 33) {
      return { action: 'Re-sign', reasons: [`top ${topPct}% MLB value`, ...reasons] };
    }
    if (overallPct >= 70) {
      return { action: 'Re-sign short-term', reasons: [`still productive but age ${age} — limit years`, ...reasons] };
    }
    if (overallPct < 40) {
      return { action: 'Let walk', reasons: [`bottom ${overallPct}% MLB value`, ...reasons] };
    }
    return { action: 'Market-dependent', reasons: [`middling value (${ordinal(overallPct)} pct) — replaceable`, ...reasons] };
  }

  // Not expiring: surface extension candidates and decline warnings
  if (yearsAfterThis <= 2 && overallPct >= BUYOUT_MIN_PCT && age <= BUYOUT_MAX_AGE) {
    return {
      action: 'Extension candidate',
      reasons: [`${yearsAfterThis} yr${yearsAfterThis === 1 ? '' : 's'} left after this one — buy out prime early`],
    };
  }
  if (declining && age >= 32 && salaryNow >= 10_000_000) {
    return { action: 'Watch decline', reasons: ['expensive veteran with talent slipping below production'] };
  }
  return null;
}

/** The recommendation as it stands on the value figure alone, with the reason it does. */
function onValueOnly(rec: Recommendation, reason: string): Recommendation {
  return {
    action: rec.action === 'Extend now' ? EXTEND_VALUE_ONLY : rec.action,
    reasons: [...rec.reasons, reason],
  };
}

/**
 * The same reading, with this season's results given a veto.
 *
 * A man is not extended on his Value percentile alone. Where he has played
 * enough for the line to mean anything and it is clearly below the league, the
 * recommendation becomes "hold off" and says which two facts disagree — that
 * is a genuinely useful thing to be told, and far better than either advising
 * the extension or silently dropping him from the list.
 *
 * "Enough" is not the same for everybody. A poor line is readable at 100 plate
 * appearances but says very little about a 24-year-old whose talent is in the
 * 97th percentile, so the sample it takes to overrule the value figure grows
 * with youth and talent (see formDoubtsValue). Jackson Holliday was told to hold
 * off on 125 plate appearances; he is now told his line is poor and why that is
 * not yet a reason to doubt him.
 *
 * Where he has not played enough, the recommendation stands and says so. A man
 * with nine innings has shown nothing, and treating that as evidence against
 * him would be the same mistake pointing the other way. It stands as a claim
 * about the value figure only, in so many words, and never with a "now" on it.
 */
export function recommend(
  args: Parameters<typeof recommendOnValue>[0] & { form: SeasonForm | null }
): Recommendation | null {
  const rec = recommendOnValue(args);
  if (!rec || !COMMITTING.has(rec.action)) return rec;

  const form = args.form;
  if (form && (form.verdict === 'good' || form.verdict === 'fair')) {
    return { ...rec, reasons: [...rec.reasons, `${form.line} backs it`] };
  }
  if (form && form.verdict === 'poor') {
    const { doubts, needed } = formDoubtsValue(form, args.age, args.talentPct);
    if (doubts) {
      return {
        action: 'Hold off',
        reasons: [
          `${rec.reasons[0]} — but ${form.line}`,
          'the value figure counts playing time, not results; the season does not back an extension yet',
        ],
      };
    }
    return onValueOnly(
      rec,
      `${form.line} is poor, but it takes ${needed} ${form.unit} to doubt a ${args.age}-year-old ` +
        'with this talent — the value figure stands'
    );
  }
  return onValueOnly(
    rec,
    form?.line
      ? `only ${form.line} so far — the season has not weighed in, so this is the value figure alone`
      : 'no meaningful playing time yet — this is the value figure alone'
  );
}

/**
 * Why there is nothing to do about a man, in a line.
 *
 * A row with no recommendation was an empty cell, and an empty cell cannot be
 * told from a page that failed to load: Dillon Dingler (80th percentile value,
 * 94th in talent, two arbitration years left) and Blake Snell had nothing beside
 * them at all. A man scanning the page for what needs deciding cannot tell a
 * decision that does not exist from one the app missed, so every man is
 * accounted for — where he stands, and why that is not a decision.
 *
 * The cutoffs are the advice's own (BUYOUT_MIN_PCT, BUYOUT_MAX_AGE) so that the
 * reason cannot say something the rule does not.
 */
export function noActionReason(a: {
  age: number;
  overallPct: number | null;
  /** Last season the club holds him, extension included. */
  endYear: number;
  control: Control;
  /** How many arbitration trips come before he can leave: the gap between the two thresholds. */
  arbTrips: number;
  /** A last-year option on the deal, since it changes what "under contract" promises. */
  option: string | null;
}): string {
  const { control } = a;
  if (a.overallPct === null) return 'no Value figure for him in this export, so nothing to judge';

  const where =
    control.status === 'extended' ? `extended through ${a.endYear}`
    : control.status === 'signed' ? `under contract through ${a.endYear}${a.option ? ` (last year a ${a.option})` : ''}`
    : control.status === 'reserve clause' ? 'reserve clause, so the club keeps him'
    : control.status === 'arbitration' ? `arbitration year ${control.arbYear} of ${a.arbTrips}`
    : control.status === 'pre-arbitration' ? 'pre-arbitration, renewed near the minimum'
    // A man reaching free agency always has a recommendation; kept so that this can never come back empty
    : 'reaches free agency after this season';

  // Only where an early buy-out was a live question is it worth saying why it is not one
  const early = control.status === 'arbitration' || control.status === 'pre-arbitration';
  const why =
    !early ? null
    : a.overallPct < BUYOUT_MIN_PCT
      ? `value ${ordinal(a.overallPct)} pct is under the ${ordinal(BUYOUT_MIN_PCT)}-pct extension line`
    : a.age > BUYOUT_MAX_AGE
      ? `age ${a.age} is past the extension cutoff (${BUYOUT_MAX_AGE})`
    : null;

  const decided = control.status === 'extended' || control.status === 'reserve clause';
  return `${where} — ${why ? `${why}; ` : ''}nothing to decide${decided ? '' : ' yet'}`;
}

/**
 * What happens to a man when his deal runs out.
 *
 * "Expiring" and "leaving" are not the same thing, and the payroll page was
 * treating them as one: a player with arbitration years left was counted as
 * money coming off the books, when the club still holds him and his salary is
 * about to go up rather than away. A reader reported it, and he is right —
 * the two belong in different columns.
 *
 * Lives here because this is where the service-time reasoning already was.
 * Working out arbitration eligibility twice, in two files, is how the two
 * pages would come to disagree about the same player.
 */
export type ControlStatus =
  | 'signed'          // still under contract next season
  | 'extended'        // an extension already picks him up
  | 'leaving'         // reaches free agency — the money genuinely comes off
  | 'arbitration'     // still controlled, and about to cost more
  | 'pre-arbitration' // still controlled, renewed near the minimum
  | 'reserve clause'; // no free agency in this league; he simply stays

export interface Control {
  status: ControlStatus;
  /** Which arbitration trip this would be, when that is where he lands. */
  arbYear: number | null;
}

export function controlAfterThisSeason(opts: {
  yearsAfterThis: number;
  hasExtension: boolean;
  serviceDays: number | null;
  serviceYears: number | null;
  serviceLeft: number;
  rules: { faMinYears: number; arbMinYears: number; hasFreeAgency: boolean; hasArbitration: boolean };
}): Control {
  const { yearsAfterThis, hasExtension, serviceDays, serviceYears, serviceLeft, rules } = opts;
  if (hasExtension) return { status: 'extended', arbYear: null };
  if (yearsAfterThis > 0) return { status: 'signed', arbYear: null };

  /*
   * Service days are exact where mlb_service_years is truncated to whole
   * years, and only the part of the season still to be played can be added:
   * the banked days already count what he has earned so far.
   */
  const service = serviceDays != null ? serviceDays / SERVICE_DAYS_PER_YEAR : serviceYears ?? 0;
  const projected = service + serviceLeft;

  if (!rules.hasFreeAgency) return { status: 'reserve clause', arbYear: null };
  if (projected >= rules.faMinYears) return { status: 'leaving', arbYear: null };
  if (rules.hasArbitration && projected >= rules.arbMinYears) {
    return { status: 'arbitration', arbYear: Math.floor(projected - rules.arbMinYears) + 1 };
  }
  return { status: 'pre-arbitration', arbYear: null };
}

/** When a decision about a man stops being free to make; see decisionDeadline. */
export interface Deadline {
  kind: 'free-agency' | 'arbitration' | 'none';
  /** The season after which it falls: "after the 2028 season". Null when there is no deadline. */
  afterSeason: number | null;
  /** Ready to print. */
  label: string;
}

export const NO_DEADLINE: Deadline = { kind: 'none', afterSeason: null, label: 'none' };

const freeAgencyAfter = (season: number): Deadline => ({
  kind: 'free-agency', afterSeason: season, label: `Before free agency, after the ${season} season`,
});
const arbitrationAfter = (season: number): Deadline => ({
  kind: 'arbitration', afterSeason: season, label: `Before the arbitration filing, after the ${season} season`,
});

/**
 * The date a decision about a man stops being free to make.
 *
 * Advice that stops at a verb leaves the reader to work out when it matters. For
 * a man whose deal ends it is the winter his contract runs out: free agency if
 * he has the service time, and the arbitration filing if he does not. For a man
 * signed beyond this year it is the winter his deal ends, projected forward by
 * a service year a season. Where he is extended, or the league has no free
 * agency, nothing is time-boxed and the answer is "none".
 *
 * The date is given as a season rather than a day because the save carries no
 * date for either event: OOTP runs both after the playoffs, and a calendar date
 * here would be invented.
 *
 * The service-time reasoning is controlAfterThisSeason's own, asked as of the
 * day his deal runs out, so the two cannot disagree about who is leaving.
 */
export function decisionDeadline(opts: {
  season: number;
  yearsAfterThis: number;
  hasExtension: boolean;
  /** Service, in years, he will have banked when this season ends. */
  projectedService: number;
  rules: { faMinYears: number; arbMinYears: number; hasFreeAgency: boolean; hasArbitration: boolean };
}): Deadline {
  const { season, yearsAfterThis, hasExtension, projectedService, rules } = opts;
  if (hasExtension || !rules.hasFreeAgency) return NO_DEADLINE;

  const lastSeason = season + yearsAfterThis;
  // Where he stands when the deal runs out: a season of service for every year left on it
  const atEnd = projectedService + yearsAfterThis;
  const control = controlAfterThisSeason({
    yearsAfterThis: 0, hasExtension: false, serviceDays: null, serviceYears: atEnd, serviceLeft: 0, rules,
  });
  if (control.status === 'leaving') return freeAgencyAfter(lastSeason);
  if (control.status === 'arbitration') return arbitrationAfter(lastSeason);

  // Neither yet: the next wall is the first winter he qualifies for arbitration,
  // or for free agency where the league has no arbitration to stop at
  const wall = rules.hasArbitration ? rules.arbMinYears : rules.faMinYears;
  const wait = Math.max(Math.ceil(wall - atEnd), 1);
  return rules.hasArbitration ? arbitrationAfter(lastSeason + wait) : freeAgencyAfter(lastSeason + wait);
}

/**
 * Which of four kinds of problem a man is, in the order they have to be solved.
 *
 *   1  his deal ends and he can leave: the club loses him if it does nothing
 *   2  his deal ends and he goes to arbitration: the club keeps him, at a price
 *      the process sets, and an early deal is cheaper than a hearing
 *   3  a call to make about him that is not tied to this winter: an extension to
 *      buy early, a decline to watch
 *   4  nothing to decide
 *
 * Within each, the better player first. The list used to run by years left and
 * then salary, so the men whose deals end came out in pay order: Okert, a
 * 65th-percentile reliever on $13.5 million, stood above Muncy at the 80th
 * because he is paid more.
 */
export type UrgencyTier = 1 | 2 | 3 | 4;

export function urgencyTier(control: Control, hasAction: boolean): UrgencyTier {
  if (control.status === 'leaving') return 1;
  if (control.status === 'arbitration') return 2;
  return hasAction ? 3 : 4;
}

/** Most urgent first; within a tier, highest value percentile first, then the bigger salary. */
export function byUrgency(
  a: { urgencyTier: number; overallPct: number | null; salaryNow: number; name: string },
  b: { urgencyTier: number; overallPct: number | null; salaryNow: number; name: string }
): number {
  return (
    a.urgencyTier - b.urgencyTier ||
    (b.overallPct ?? -1) - (a.overallPct ?? -1) ||
    b.salaryNow - a.salaryNow ||
    a.name.localeCompare(b.name)
  );
}

/** The three pools a Value percentile is ranked in; see mlbPercentiler. */
type Pool = 'pos' | 'sp' | 'rp';

const POOL_NAMES: Record<Pool, string> = { pos: 'position players', sp: 'starters', rp: 'relievers' };

const poolOf = (position: number, role: number): Pool =>
  position !== 1 ? 'pos' : role === ROLE_STARTER ? 'sp' : 'rp';

/** A multi-year deal somebody in the league signed lately. */
export interface RecentDeal {
  playerId: number;
  age: number;
  pool: Pool;
  /** His Value percentile now, which is what a subject's is set against. */
  pct: number;
  years: number;
  /** The whole deal over its length. */
  aav: number;
  /** First season of the deal. */
  startYear: number;
}

const PCT_WINDOW = 10;
const AGE_WINDOW = 3;
const MIN_COMPARABLES = 3;
const RECENT_SEASONS = 3;
/** What "short-term" means when the advice is to keep it short. */
const SHORT_TERM_YEARS = 2;

export interface SuggestedTerms {
  /** Null, with `aav`, when there were too few comparables to say. */
  years: number | null;
  /** Average annual value in dollars. */
  aav: number | null;
  /** How many deals the figures rest on. */
  comparables: number;
  /** Who the comparables were, in words, for a tooltip. */
  basis: string;
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * What a deal would run to, from deals that were actually signed.
 *
 * "Extend now" with nothing after it leaves the reader to guess how many years
 * and how many dollars, which is the whole of the negotiation. The league's own
 * recent contracts are the evidence the save carries, so the suggestion is what
 * players like him were given:
 *
 *  - two years or more. Over nine in ten of the contracts that began in 2028 in
 *    the Dodgers' save are one-year renewals and arbitration awards, which are
 *    nobody's price, and a median over them is the minimum salary.
 *  - begun in the last three seasons, this one and the two before.
 *  - by a man now on a major-league roster, ranked in the same pool of
 *    position players, starters or relievers. A percentile is a rank within its
 *    pool and the pools are not paid alike: set against all three together,
 *    Andres Munoz, a reliever, was priced at five years and $15.8 million;
 *    against relievers alone it is three years and $10.9 million.
 *  - within 10 percentile points of his Value and 3 years of his age.
 *  - a signed extension that has not begun is in a table of its own until it
 *    does, and is the most direct evidence there is of what keeping a man whose
 *    deal is ending costs, so one that takes effect next season stands in for
 *    that man's current deal. Ones that begin later are add-ons to long deals
 *    (Bobby Witt's four years from 2034 on the end of a ten-year contract) and
 *    price nothing about this winter. players_salary_history was looked at and
 *    left out: it records what was paid each year with no contract length, so it
 *    cannot tell a two-year deal from two one-year ones.
 *
 * The median, not the mean: these run from the minimum to $70 million a year and
 * a mean follows the outlier. Under three comparables there is no suggestion,
 * because a median of two is a guess with a number on it.
 */
export function suggestTerms(
  deals: RecentDeal[],
  who: { playerId: number; age: number; pct: number | null; pool: Pool },
  /** A ceiling on the years, for advice that says to keep it short. */
  maxYears?: number
): SuggestedTerms {
  if (who.pct === null) {
    return { years: null, aav: null, comparables: 0, basis: 'no Value figure to compare on' };
  }
  const pct = who.pct;
  // Never his own deal: a man recently signed would otherwise be priced at what he already earns
  const like = deals.filter(
    (d) =>
      d.playerId !== who.playerId &&
      d.pool === who.pool &&
      Math.abs(d.pct - pct) <= PCT_WINDOW &&
      Math.abs(d.age - who.age) <= AGE_WINDOW
  );
  const group =
    `${POOL_NAMES[who.pool]} at the ${ordinal(Math.max(pct - PCT_WINDOW, 0))}-` +
    `${ordinal(Math.min(pct + PCT_WINDOW, 100))} percentile, ` +
    `aged ${who.age - AGE_WINDOW}-${who.age + AGE_WINDOW}`;

  if (like.length < MIN_COMPARABLES) {
    return {
      years: null,
      aav: null,
      comparables: like.length,
      basis: `fewer than three recent deals of two years or more for ${group} (found ${like.length})`,
    };
  }

  const first = Math.min(...like.map((d) => d.startYear));
  const last = Math.max(...like.map((d) => d.startYear));
  const wanted = Math.round(median(like.map((d) => d.years)));
  const years = maxYears !== undefined ? Math.min(wanted, maxYears) : wanted;
  return {
    years,
    // To the nearest hundred thousand: the median of dollars is not a number anyone offers
    aav: Math.round(median(like.map((d) => d.aav)) / 100_000) * 100_000,
    comparables: like.length,
    basis:
      `median of ${like.length} deals of two years or more that began in ` +
      `${first === last ? first : `${first}-${last}`}, for ${group}` +
      (years < wanted ? `; years held to ${years} because the advice is to keep it short` : ''),
  };
}

/**
 * Multi-year deals signed lately, for the comparison above.
 *
 * Reads players_contract for the deals in force and players_contract_extension
 * for the ones signed and starting next season, one deal per man and the newer
 * wins.
 * Read with `SELECT *` and the salary columns by name, as valuation.ts reads
 * them, because a fixture and a real export carry different sets of the rest.
 */
function recentDeals(year: number, overallPct: (id: number) => number | null): RecentDeal[] {
  if (!tableExists('players_contract')) return [];

  const sql = (table: string, also: string) =>
    `SELECT c.*, p.age AS p_age, p.position AS p_position, p.role AS p_role
     FROM ${table} c
     JOIN players p ON p.player_id = c.player_id
     JOIN players_roster_status rs ON rs.player_id = p.player_id
     JOIN teams t ON t.team_id = p.team_id
     WHERE p.retired = 0 AND t.level = 1 AND ${ON_ROSTER} AND c.years >= 2 ${also}`;
  const rows = [
    ...(db
      .prepare(sql('players_contract', 'AND c.is_major = 1 AND c.season_year >= ?'))
      .all(year - RECENT_SEASONS + 1) as Array<Record<string, number>>),
    ...(tableExists('players_contract_extension')
      ? (db
          .prepare(sql('players_contract_extension', 'AND c.season_year <= ?'))
          .all(year + 1) as Array<Record<string, number>>)
      : []),
  ];

  const out = new Map<number, RecentDeal>();
  for (const r of rows) {
    const pct = overallPct(r.player_id);
    const spanned = Math.min(r.years, 15);
    let total = 0;
    for (let i = 0; i < spanned; i++) total += r[`salary${i}`] ?? 0;
    if (pct === null || total <= 0) continue;
    out.set(r.player_id, {
      playerId: r.player_id,
      age: r.p_age,
      pool: poolOf(r.p_position, r.p_role),
      pct,
      years: r.years,
      aav: total / spanned,
      startYear: r.season_year,
    });
  }
  return [...out.values()];
}

/**
 * The actions that are about his deal running out, and so have a date. The
 * others — watch a decline, move him, release him — are discretionary.
 */
const DATED = new Set([...OFFERS, 'Hold off', 'Let walk', 'Market-dependent']);

export interface ContractAdviceRow {
  /** 1 to 4, most urgent first; see UrgencyTier. */
  urgencyTier: UrgencyTier;
  /** Position in the order the page lists them: 1 is the first thing to deal with. */
  urgencyRank: number;
  player_id: number;
  name: string;
  age: number;
  positionName: string;
  salaryNow: number;
  totalYears: number;
  yearsAfterThis: number;
  endYear: number;
  extension: { years: number; startYear: number; endYear: number; firstSalary: number } | null;
  serviceYears: number;
  serviceDays: number | null;
  arbYear: number | null;
  overallPct: number | null;
  talentPct: number | null;
  seasonForm: SeasonForm | null;
  flags: string[];
  recommendation: Recommendation | null;
  /** Why there is nothing to do; set exactly when `recommendation` is null. */
  noActionReason: string | null;
  /** Set for a recommendation that asks the club to commit; null otherwise. */
  terms: SuggestedTerms | null;
  deadline: Deadline;
}

export function computeContracts(orgId: number) {
  const org = db.prepare(`SELECT league_id FROM teams WHERE team_id = ?`).get(orgId) as
    | { league_id: number }
    | undefined;
  if (!org) throw new Error('Unknown org');
  const year = seasonYear(org.league_id);

  const contracts = contractsByPlayer();
  const values = valuesByPlayer();
  const { overallPct, talentPct } = mlbPercentiler(values);
  // What each man has actually done this season, so a percentile built out of
  // playing time cannot recommend an extension by itself
  const formByPlayer = seasonFormByPlayer(orgId);
  const rules = leagueRules(org.league_id);
  const { faMinYears, arbMinYears, hasFreeAgency, hasArbitration } = rules;
  // Arbitration trips a man makes before he can leave: the gap between the two thresholds
  const arbTrips = hasArbitration && hasFreeAgency ? Math.max(faMinYears - arbMinYears, 1) : 1;

  const players = db
    .prepare(
      `SELECT p.player_id, p.first_name, p.last_name, p.age, p.position, p.role,
              rs.mlb_service_years AS service_years,
              rs.mlb_service_days AS service_days
       FROM players p
       LEFT JOIN players_roster_status rs ON rs.player_id = p.player_id
       WHERE p.team_id = ? AND p.retired = 0 AND ${ON_ROSTER}`
    )
    .all(orgId) as Array<{
    player_id: number; first_name: string; last_name: string; age: number; position: number;
    role: number; service_years: number | null; service_days: number | null;
  }>;

  const serviceLeft = serviceRemainingThisSeason();
  // Read once, and only if somebody turns out to need a price
  let deals: RecentDeal[] | null = null;

  const rows: ContractAdviceRow[] = [];
  for (const p of players) {
    const c = contracts.get(p.player_id);
    // Placeholder rows: zero-year deals or ones with no valid end year
    if (!c || c.totalYears < 1 || c.controlledThrough < year) continue;
    // A signed extension is the club's real commitment, so it drives both the
    // years-left column and the recommendation
    const endYear = c.controlledThrough;
    const yearsAfterThis = c.extension
      ? Math.max(c.controlledThrough - year, 0)
      : c.yearsAfterThis;
    // mlb_service_years is truncated to whole years, so it cannot tell a
    // player a week past a threshold from one most of a year past it. Service
    // days are exact — 172 of them make an MLB service year.
    const service =
      p.service_days != null ? p.service_days / SERVICE_DAYS_PER_YEAR : p.service_years ?? 0;
    // Where he lands next winter. Only the part of the season still to be
    // played can be added: mlb_service_days already counts the days banked
    // so far this year, so adding a whole year on top of it pushed players
    // over the free-agency line months before they actually get there, and
    // they were flagged "expiring" while still holding an arbitration year.
    const projected = service + serviceLeft;
    // One reading of what happens to him, from the function the payroll page
    // uses, so that the flags, the deadline, the order and the advice all agree.
    // With no free agency the reserve clause binds him regardless of service,
    // so nobody is ever "reaching" a market.
    const control = controlAfterThisSeason({
      yearsAfterThis,
      hasExtension: !!c.extension,
      serviceDays: p.service_days,
      serviceYears: p.service_years,
      serviceLeft,
      rules,
    });
    const oPct = overallPct(p.player_id);
    const tPct = talentPct(p.player_id);
    const form = formByPlayer.get(p.player_id) ?? null;
    const rec = recommend({
      age: p.age,
      yearsAfterThis,
      reachingFA: control.status === 'leaving',
      hasFreeAgency,
      overallPct: oPct,
      talentPct: tPct,
      salaryNow: c.salaryNow,
      form,
    });

    const flags: string[] = [];
    if (control.status === 'extended') {
      // Already locked up beyond the current deal — not a decision to make
      flags.push(`extended thru ${c.extension!.endYear}`);
    } else if (control.status === 'reserve clause') {
      // The deal ends but he cannot leave — the club simply renews him
      flags.push('reserve clause');
    } else if (control.status === 'leaving') {
      flags.push('expiring');
    } else if (control.status === 'arbitration') {
      // Saying "team control" for an arbitration-eligible player hid the fact
      // that he still has arbitration years left, which read as "expiring"
      flags.push(`arbitration ${control.arbYear}`);
    } else if (control.status === 'pre-arbitration') {
      flags.push('pre-arbitration');
    }
    const option = c.lastYearTeamOption ? 'team option'
      : c.lastYearPlayerOption ? 'player option'
      : c.lastYearVestingOption ? 'vesting option'
      : null;
    if (option) flags.push(option);
    if (c.noTrade) flags.push('no-trade');

    // A price only for a recommendation that asks the club to commit; the deals
    // are read on the first one that does
    let terms: SuggestedTerms | null = null;
    if (rec && OFFERS.has(rec.action)) {
      deals ??= recentDeals(year, overallPct);
      terms = suggestTerms(
        deals,
        { playerId: p.player_id, age: p.age, pct: oPct, pool: poolOf(p.position, p.role) },
        rec.action === 'Re-sign short-term' ? SHORT_TERM_YEARS : undefined
      );
    }

    rows.push({
      urgencyTier: urgencyTier(control, rec !== null),
      urgencyRank: 0, // numbered once they are in order
      player_id: p.player_id,
      name: `${p.first_name} ${p.last_name}`,
      age: p.age,
      positionName: POSITION_NAMES[p.position] ?? '?',
      salaryNow: c.salaryNow,
      totalYears: c.totalYears,
      yearsAfterThis,
      endYear,
      extension: c.extension,
      serviceYears: Number(service.toFixed(2)),
      // Exact days too, so the page can write service as years.days rather than a rounded decimal
      serviceDays: p.service_days ?? null,
      arbYear: control.arbYear,
      overallPct: oPct,
      talentPct: tPct,
      /*
       * Sent whether or not it changed the recommendation, because this is
       * also what the assistants read. Handed a percentile and nothing else,
       * the GM briefing described a 93rd-percentile Value as a man
       * "performing at a 93rd-percentile MLB value" — a claim that figure
       * never made, and one it had nothing in front of it to doubt.
       */
      seasonForm: form,
      flags,
      recommendation: rec,
      noActionReason: rec
        ? null
        : noActionReason({ age: p.age, overallPct: oPct, endYear, control, arbTrips, option }),
      terms,
      deadline:
        rec && DATED.has(rec.action)
          ? decisionDeadline({
              season: year,
              yearsAfterThis,
              hasExtension: !!c.extension,
              projectedService: projected,
              rules,
            })
          : NO_DEADLINE,
    });
  }

  rows.sort(byUrgency);
  rows.forEach((r, i) => { r.urgencyRank = i + 1; });

  return {
    seasonYear: year,
    gameDate: currentGameDate(org.league_id),
    // Surfaced so the page can explain why it is talking about a reserve
    // clause instead of free agency
    rules,
    finances: teamFinances(orgId),
    players: rows,
  };
}

contractRoutes.get('/contracts/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  if (!tableExists('players') || !tableExists('players_contract')) {
    return res.status(400).json({ error: 'No contract data imported yet' });
  }
  try {
    res.json(computeContracts(Number(req.params.orgId)));
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});
