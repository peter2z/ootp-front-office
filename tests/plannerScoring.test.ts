import { describe, expect, it } from 'vitest';
// The planner first: history.ts reaches dashboard.ts for DATE_KEY, dashboard.ts
// reaches the planner, and the planner's decision store reaches history.ts —
// a ring that only loads when it is entered here and not at history.ts
import {
  assetClassOf, blendProduction, ceilingTierOf, fitOf, formBlocksDemote, formBlocksPromote, lineWeight, mleTranslator,
  inSwingBand, pitchRole, productionReadable, ratedPitches, ratioLean, sentencesOf, specialistOf, utilityClassOf, type Translate,
} from '../server/planner.js';
import { db } from '../server/db.js';
import { computePitching, type LeagueBaseline } from '../server/stats.js';
import { clearScaleCache, ratingScaleMax, scaleGrade } from '../server/valuation.js';
import type { RungKey } from '../server/planTypes.js';
import type { SeasonForm } from '../server/form.js';

/**
 * The planner's arithmetic, each rule held to the number the design gives it.
 *
 * These are the pure functions the engine's closures delegate to, so a case
 * here is a case about every card: the weights of the three readiness terms
 * and where a missing one's weight goes, the recency and sample weights of a
 * line and the prior that pulls a thin one back to 100, the gate below which
 * no index is quoted, OOTP's level factors applied one rung at a time, the
 * starter / swing / reliever matrix, the utility and asset classes, and the
 * ceiling tiers — on 20-80, and again on a 1-to-5 save, since every cut-off
 * is written on 20-80 and carried onto the save's own scale.
 */

const same: Translate = (idx) => idx;

describe('production: weights, regression and the gate', () => {
  it('weights a line by recency, 1.0 / 0.6 / 0.3 for this season and the two before, and nothing older', () => {
    expect(lineWeight(2030, 2030, 450, 450)).toBe(1);
    expect(lineWeight(2029, 2030, 450, 450)).toBeCloseTo(0.6, 12);
    expect(lineWeight(2028, 2030, 450, 450)).toBeCloseTo(0.3, 12);
    expect(lineWeight(2027, 2030, 450, 450)).toBe(0);
  });

  it('scales the weight by the share of a full sample, capped at the full sample', () => {
    expect(lineWeight(2030, 2030, 225, 450)).toBe(0.5);
    expect(lineWeight(2030, 2030, 900, 450)).toBe(1);
    expect(lineWeight(2029, 2030, 60, 120)).toBeCloseTo(0.3, 12);
  });

  it('regresses to 100 on a prior worth a third of a full sample: nothing at all reads exactly 100', () => {
    expect(blendProduction([], 'aa', same)).toBeCloseTo(100, 12);
    // One full-recency, full-sample line at 130: (130 + 100/3) / (1 + 1/3) = 122.5
    expect(blendProduction([{ idx: 130, rung: 'aa', weight: 1 }], 'aa', same)).toBeCloseTo(122.5, 10);
    // A thin line barely moves it
    expect(blendProduction([{ idx: 130, rung: 'aa', weight: 0.05 }], 'aa', same)).toBeCloseTo((130 * 0.05 + 100 / 3) / (0.05 + 1 / 3), 10);
  });

  it('quotes an index only at 150 PA or 40 IP over the window: 149 is not enough', () => {
    expect(productionReadable(149, 0, false)).toBe(false);
    expect(productionReadable(150, 0, false)).toBe(true);
    expect(productionReadable(0, 39.9, true)).toBe(false);
    expect(productionReadable(0, 40, true)).toBe(true);
    // A pitcher is gated on innings, whatever his plate appearances
    expect(productionReadable(500, 0, true)).toBe(false);
  });
});

describe('translation with the MLE table', () => {
  const mle = new Map<RungKey, number>([['mlb', 1], ['aaa', 0.85], ['aa', 0.8], ['high-a', 0.77]]);
  const { translate, rungStep } = mleTranslator(mle);

  it('reports each step as 100 × (mle(lower) / mle(upper) − 1), one decimal, sourced to the MLE table', () => {
    expect(rungStep['aaa>mlb']).toEqual({ step: -15, source: 'mle', pairs: null });
    expect(rungStep['aa>aaa']).toEqual({ step: -5.9, source: 'mle', pairs: null });
    // 100 × (0.77 / 0.80 − 1) is −3.75 exactly; Math.round takes the half up, to −3.7
    expect(rungStep['high-a>aa']).toEqual({ step: -3.7, source: 'mle', pairs: null });
    expect(Object.keys(rungStep)).toEqual(['high-a>aa', 'aa>aaa', 'aaa>mlb']);
  });

  it('translates one step at a time going up, and gives the steps back coming down', () => {
    const up = translate(100, 'aa', 'mlb');
    expect(up).toBeCloseTo(100 + 100 * (0.8 / 0.85 - 1) + 100 * (0.85 / 1 - 1), 10);
    expect(translate(up, 'mlb', 'aa')).toBeCloseTo(100, 10);
    expect(translate(100, 'aa', 'aa')).toBe(100);
  });

  it('leaves an index alone when either rung has no factor', () => {
    expect(translate(100, 'dsl', 'aa')).toBe(100);
    expect(translate(100, 'aa', 'ic')).toBe(100);
  });
});

describe('FIP+ beside ERA+', () => {
  const base: LeagueBaseline = {
    year: 2030, lgOBP: 0.32, lgSLG: 0.4, lgWOBA: 0.32, lgRperPA: 0.11, lgERA: 4.5, lgFIPRaw: 1.3, parkFactor: new Map(),
  };

  it('is 100 × lgERA × park factor / FIP, rounded like ERA+', () => {
    const s = computePitching({ outs: 180, er: 20, hra: 6, bb: 15, hp: 2, k: 60 }, base, null);
    const fip = (13 * 6 + 3 * (15 + 2) - 2 * 60) / 60 + (4.5 - 1.3);
    expect(s.fip).toBeCloseTo(fip, 2);
    expect(s.fipPlus).toBe(Math.round((100 * 4.5) / fip));
    expect(s.eraPlus).toBe(Math.round((100 * 4.5) / 3));
  });

  it('is null with no innings, and null when FIP is not positive', () => {
    expect(computePitching({ outs: 0 }, base, null).fipPlus).toBeNull();
    // Nothing but strikeouts drives the raw component below the constant
    expect(computePitching({ outs: 60, k: 300, hra: 0, bb: 0, hp: 0 }, base, null).fipPlus).toBeNull();
  });
});

describe('fit: the three terms and where a missing one goes', () => {
  it('blends 0.5 scouting, 0.3 production and 0.2 age', () => {
    expect(fitOf(1, 115, 1)).toBeCloseTo(0.5 + 0.3 + 0.2, 12);
    expect(fitOf(2, 130, -1)).toBeCloseTo(1 + 0.6 - 0.2, 12);
  });

  it('turns the index into z_P at fifteen points to the unit, clamped to ±3', () => {
    expect(fitOf(0, 115, 0)).toBeCloseTo(0.3, 12);
    expect(fitOf(0, 85, 0)).toBeCloseTo(-0.3, 12);
    expect(fitOf(0, 250, 0)).toBeCloseTo(0.9, 12);
    expect(fitOf(0, 0, 0)).toBeCloseTo(-0.9, 12);
  });

  it('gives a missing term\'s weight to the others: 0.7 / 0.3 without production, 0.6 / 0.4 without scouting', () => {
    expect(fitOf(1, null, 1)).toBeCloseTo(1, 12);
    expect(fitOf(1, null, 0.5)).toBeCloseTo(0.7 + 0.15, 12);
    expect(fitOf(null, 115, 1)).toBeCloseTo(0.6 + 0.4, 12);
    expect(fitOf(null, 130, 0.5)).toBeCloseTo(1.2 + 0.2, 12);
  });

  it('is null with nothing to score on, and reads a missing age as the median', () => {
    expect(fitOf(null, null, 1)).toBeNull();
    expect(fitOf(1, 115, null)).toBeCloseTo(0.8, 12);
  });
});

describe('the form gates', () => {
  const form = (verdict: SeasonForm['verdict'], meaningful: boolean): SeasonForm =>
    ({ verdict, meaningful, index: null, line: null, played: 0 } as unknown as SeasonForm);

  it('blocks a promotion on a poor verdict with a meaningful sample, and only then', () => {
    expect(formBlocksPromote(form('poor', true))).toBe(true);
    expect(formBlocksPromote(form('poor', false))).toBe(false);
    expect(formBlocksPromote(form('good', true))).toBe(false);
    expect(formBlocksPromote(form('fair', true))).toBe(false);
    expect(formBlocksPromote(null)).toBe(false);
  });

  it('blocks a demotion on a good verdict with a meaningful sample, and only then', () => {
    expect(formBlocksDemote(form('good', true))).toBe(true);
    expect(formBlocksDemote(form('good', false))).toBe(false);
    expect(formBlocksDemote(form('poor', true))).toBe(false);
    expect(formBlocksDemote(undefined)).toBe(false);
  });
});

describe('pitching roles from the ratings', () => {
  it('counts a pitch at 40 or better: 45 / 40 / 50 / 25 is three pitches', () => {
    expect(ratedPitches([45, 40, 50, 25])).toBe(3);
    expect(ratedPitches([45, 39, 50, 25])).toBe(2);
    expect(ratedPitches([null, undefined, 0])).toBe(0);
  });

  it('is SP at stamina 50 with three pitches, swing at 45-49 with three or at 45+ with exactly two, RP otherwise', () => {
    expect(pitchRole(55, 3, false)).toBe('SP');
    expect(pitchRole(50, 4, false)).toBe('SP');
    expect(pitchRole(47, 3, false)).toBe('swing');
    expect(pitchRole(55, 2, false)).toBe('swing');
    expect(pitchRole(45, 2, false)).toBe('swing');
    expect(pitchRole(55, 1, false)).toBe('RP');
    expect(pitchRole(44, 3, false)).toBe('RP');
    expect(pitchRole(30, 3, false)).toBe('RP');
    expect(pitchRole(null, 3, false)).toBe('RP');
  });

  it('asks for stamina alone at the complex rungs, and takes a missing pitch count as enough', () => {
    expect(pitchRole(55, 0, true)).toBe('SP');
    expect(pitchRole(47, 1, true)).toBe('swing');
    expect(pitchRole(30, 0, true)).toBe('RP');
    expect(pitchRole(55, null, false)).toBe('SP');
  });

  it('breaks the tie with the SP/RP value ratio in the swing cell only, where the ratings sit on the line', () => {
    // The swing cell, both ways in: stamina 45-49 with the pitches, a starter's stamina one pitch short
    expect(pitchRole(47, 3, false, 'SP')).toBe('SP');
    expect(pitchRole(47, 3, false, 'RP')).toBe('RP');
    expect(pitchRole(55, 2, false, 'SP')).toBe('SP');
    expect(pitchRole(55, 2, false, 'RP')).toBe('RP');
    expect(pitchRole(45, 2, false, 'RP')).toBe('RP');
    // No lean, from equal distances or a missing column: the matrix as before
    expect(pitchRole(47, 3, false, null)).toBe('swing');
    expect(pitchRole(55, 2, false, null)).toBe('swing');
    // At the complex rungs the cell is stamina alone
    expect(pitchRole(47, 0, true, 'RP')).toBe('RP');
    expect(pitchRole(47, 0, true, 'SP')).toBe('SP');
    // No pitch ratings above the complex: the count is taken as enough unless the ratio says reliever
    expect(pitchRole(55, null, false, 'RP')).toBe('RP');
    expect(pitchRole(47, null, false, 'RP')).toBe('RP');
    expect(pitchRole(55, null, false, 'SP')).toBe('SP');
    expect(pitchRole(55, null, false, null)).toBe('SP');
    // Decisive: the ratings settle it, and the ratio never moves him
    expect(pitchRole(55, 3, false, 'RP')).toBe('SP');
    expect(pitchRole(50, 4, false, 'RP')).toBe('SP');
    expect(pitchRole(65, 3, false, 'RP')).toBe('SP');
    expect(pitchRole(55, 1, false, 'SP')).toBe('RP');
    expect(pitchRole(44, 3, false, 'SP')).toBe('RP');
    expect(pitchRole(30, null, false, 'SP')).toBe('RP');
    expect(pitchRole(null, null, false, 'SP')).toBe('RP');
    expect(pitchRole(55, null, true, 'RP')).toBe('SP');
    expect(pitchRole(50, 0, true, 'RP')).toBe('SP');
    expect(pitchRole(30, 0, true, 'SP')).toBe('RP');
  });

  it('puts in the swing cell exactly the men the ratings alone class as swing', () => {
    expect(inSwingBand(45, 3, false)).toBe(true);
    expect(inSwingBand(49, 5, false)).toBe(true);
    expect(inSwingBand(60, 2, false)).toBe(true);
    expect(inSwingBand(47, null, false)).toBe(true);
    expect(inSwingBand(47, 0, true)).toBe(true);
    expect(inSwingBand(50, 3, false)).toBe(false);
    expect(inSwingBand(44, 3, false)).toBe(false);
    expect(inSwingBand(60, 1, false)).toBe(false);
    expect(inSwingBand(50, 0, true)).toBe(false);
    expect(inSwingBand(null, 3, false)).toBe(false);
  });

  it('leans to whichever of the org\'s starter and reliever median ratios his own sits nearer, and to neither on a tie or a gap', () => {
    expect(ratioLean(1.6, 1.55, 1.4)).toBe('SP');
    expect(ratioLean(1.42, 1.55, 1.4)).toBe('RP');
    expect(ratioLean(1.5, 1.75, 1.25)).toBeNull();
    expect(ratioLean(1.3, 1.3, 1.3)).toBeNull();
    expect(ratioLean(null, 1.55, 1.4)).toBeNull();
    expect(ratioLean(1.5, null, 1.4)).toBeNull();
    expect(ratioLean(Number.POSITIVE_INFINITY, 1.55, 1.4)).toBeNull();
  });

  it('tags a specialist at ten grades between his stuff against the two sides', () => {
    expect(specialistOf(65, 55)).toBe('vs L');
    expect(specialistOf(55, 65)).toBe('vs R');
    expect(specialistOf(60, 51)).toBeNull();
    expect(specialistOf(null, 55)).toBeNull();
  });
});

describe('utility class from the positions a man covers', () => {
  const covers = (...p: number[]) => new Set(p);

  it('reads C, IF at two infield spots, OF at two outfield spots, super at both', () => {
    expect(utilityClassOf(covers(2, 3), 2)).toBe('C');
    expect(utilityClassOf(covers(4, 6), 6)).toBe('IF');
    expect(utilityClassOf(covers(7, 8), 8)).toBe('OF');
    expect(utilityClassOf(covers(4, 6, 7, 8), 6)).toBe('super');
  });

  it('reads bat-only for a man who covers first base and nothing else, whatever he is listed at; everyday for one spot', () => {
    expect(utilityClassOf(covers(3), 3)).toBe('bat-only');
    // §5.5: "bat-only when only 3 and/or 10" reads the positions he covers, not his listing
    expect(utilityClassOf(covers(3), 5)).toBe('bat-only');
    expect(utilityClassOf(covers(3), 2)).toBe('bat-only');
    expect(utilityClassOf(covers(5), 5)).toBe('everyday');
    expect(utilityClassOf(covers(3, 7), 3)).toBe('everyday');
  });

  it('reads a man who covers nothing as bat-only only when he is listed at first or DH', () => {
    // The DH is no fielding position, so "10" can only come from the listing
    expect(utilityClassOf(covers(), 10)).toBe('bat-only');
    expect(utilityClassOf(covers(), 3)).toBe('bat-only');
    expect(utilityClassOf(covers(), 6)).toBe('everyday');
    expect(utilityClassOf(covers(), 2)).toBe('everyday');
  });
});

describe('asset class', () => {
  const at = { zA: 0, medOa: 38, medAge: 24, atComplex: false, spArmUpper: false };

  it('is core at a 55 ceiling, or a 50 now by thirty', () => {
    expect(assetClassOf({ ...at, oa: 40, pot: 55, age: 24 })).toBe('core');
    expect(assetClassOf({ ...at, oa: 50, pot: 50, age: 30 })).toBe('core');
    expect(assetClassOf({ ...at, oa: 50, pot: 50, age: 31 })).toBe('depth');
  });

  it('is prospect at a 45 ceiling with eight points of upside and not old for the level', () => {
    expect(assetClassOf({ ...at, oa: 37, pot: 45, age: 22, zA: 0.5 })).toBe('prospect');
    expect(assetClassOf({ ...at, oa: 38, pot: 45, age: 22, zA: 0.5 })).toBe('depth');
    expect(assetClassOf({ ...at, oa: 37, pot: 45, age: 26, zA: -1 })).toBe('depth');
    expect(assetClassOf({ ...at, oa: 37, pot: 44, age: 22, zA: 0.5 })).toBe('depth');
  });

  it('is surplus when six years over the median age with a ceiling no better than the median grade', () => {
    expect(assetClassOf({ ...at, oa: 36, pot: 38, age: 30 })).toBe('surplus');
    expect(assetClassOf({ ...at, oa: 36, pot: 38, age: 29 })).toBe('depth');
    expect(assetClassOf({ ...at, oa: 36, pot: 39, age: 30 })).toBe('depth');
  });

  it('is surplus three years over the median age at the complex, and never when the median age is unknown', () => {
    expect(assetClassOf({ ...at, oa: 36, pot: 44, age: 27, atComplex: true })).toBe('surplus');
    expect(assetClassOf({ ...at, oa: 36, pot: 44, age: 26, atComplex: true })).toBe('depth');
    expect(assetClassOf({ ...at, oa: 36, pot: 44, age: 27, atComplex: true, medAge: null })).toBe('depth');
  });

  it('is depth within three of the median grade or as an upper-level starter, surplus otherwise', () => {
    expect(assetClassOf({ ...at, oa: 35, pot: 40, age: 24 })).toBe('depth');
    expect(assetClassOf({ ...at, oa: 34, pot: 40, age: 24 })).toBe('surplus');
    expect(assetClassOf({ ...at, oa: 30, pot: 40, age: 24, spArmUpper: true })).toBe('depth');
    expect(assetClassOf({ ...at, oa: 30, pot: 40, age: 24, medOa: null })).toBe('surplus');
  });
});

describe('ceiling tiers', () => {
  it('cuts at 50 / 45 / 40 on 20-80', () => {
    expect(ratingScaleMax()).toBe(80);
    expect(ceilingTierOf(50)).toBe('regular');
    expect(ceilingTierOf(49)).toBe('bench');
    expect(ceilingTierOf(45)).toBe('bench');
    expect(ceilingTierOf(44)).toBe('depth');
    expect(ceilingTierOf(40)).toBe('depth');
    expect(ceilingTierOf(39)).toBe('filler');
    expect(ceilingTierOf(null)).toBeNull();
  });

  it('carries the cuts onto a 1-to-5 save: a 4 is a regular, a 3 a bench man, a 2 filler', () => {
    /*
     * The scale is read off the ratings themselves, so the save is moved onto
     * 1-to-5 inside a savepoint and put back, with the remembered scale
     * cleared both ways. The expected tiers are written out rather than
     * converted, so the helper under test cannot agree with itself.
     */
    db.exec('SAVEPOINT scale');
    try {
      db.exec(`UPDATE players_batting SET batting_ratings_overall_contact = 3, batting_ratings_overall_power = 3`);
      db.exec(`UPDATE players_pitching SET pitching_ratings_overall_stuff = 3`);
      try {
        db.exec(`UPDATE players_fielding SET fielding_ratings_infield_range = 3`);
      } catch { /* the fixture may not carry the column */ }
      clearScaleCache();
      expect(ratingScaleMax()).toBe(5);
      expect(scaleGrade(50)).toBeCloseTo(3.125, 12);
      expect(ceilingTierOf(4)).toBe('regular');
      expect(ceilingTierOf(3)).toBe('bench');
      expect(ceilingTierOf(2)).toBe('filler');
      // The pitch count and the role matrix move with it: a 3 is a rated pitch, a 3 of stamina a starter's
      expect(ratedPitches([3, 3, 3, 1])).toBe(3);
      expect(pitchRole(3.2, 3, false)).toBe('SP');
      expect(pitchRole(2, 3, false)).toBe('RP');
    } finally {
      db.exec('ROLLBACK TO scale');
      db.exec('RELEASE scale');
      clearScaleCache();
    }
    expect(ratingScaleMax()).toBe(80);
  });
});

describe('sentences: where one ends', () => {
  it('ends a sentence after a level, a position code or any capital that follows something other than a space', () => {
    expect(sentencesOf('Ready for Double-A. Grades 40.')).toEqual(['Ready for Double-A.', 'Grades 40.']);
    for (const level of ['Single-A', 'High-A', 'Triple-A']) {
      expect(sentencesOf(`He is eligible at ${level}. He goes down rather than out.`)).toEqual([`He is eligible at ${level}.`, 'He goes down rather than out.']);
    }
    for (const code of ['1B', '2B', '3B', 'SS', 'CF']) {
      expect(sentencesOf(`Nobody else covers ${code}. He stays.`)).toEqual([`Nobody else covers ${code}.`, 'He stays.']);
    }
    expect(sentencesOf('Back off the IL. Grades 40.')).toEqual(['Back off the IL.', 'Grades 40.']);
  });

  it('never splits at an initial, a middle initial or inside a figure', () => {
    // Names as the save writes them: "A.J.", "J. Smith", and a middle initial, "Luis C. Gonzalez"
    expect(sentencesOf('Trade A.J. Vanegas first. Then A. J. Smith.')).toEqual(['Trade A.J. Vanegas first.', 'Then A. J. Smith.']);
    expect(sentencesOf('Luis C. Gonzalez comes off the 40-man. Tyler C. Moore stays.')).toEqual([
      'Luis C. Gonzalez comes off the 40-man.', 'Tyler C. Moore stays.',
    ]);
    expect(sentencesOf('A fit of 0.86 at Single-A. Hitting .250.')).toEqual(['A fit of 0.86 at Single-A.', 'Hitting .250.']);
  });

  it('never splits after an abbreviation in a club or a name', () => {
    // Clubs of the save: St. Lucie Mets, St. Paul Saints, St. Louis (FCL) Cardinals
    expect(sentencesOf('St. Lucie Mets is short of starters. He goes.')).toEqual(['St. Lucie Mets is short of starters.', 'He goes.']);
    expect(sentencesOf('On the injured list at St. Paul Saints with no return date.')).toHaveLength(1);
    expect(sentencesOf('The trade of Austin St. Laurent frees a place. Ray Smith Jr. Moore stays.')).toEqual([
      'The trade of Austin St. Laurent frees a place.', 'Ray Smith Jr. Moore stays.',
    ]);
  });

  it('keeps whole the names it is given, whatever their stops look like', () => {
    const text = 'Luis Al. Pena comes up. He stays.';
    // "Al." reads like the end of a short sentence to the pattern alone
    expect(sentencesOf(text)).toEqual(['Luis Al.', 'Pena comes up.', 'He stays.']);
    expect(sentencesOf(text, ['Luis Al. Pena'])).toEqual(['Luis Al. Pena comes up.', 'He stays.']);
    expect(sentencesOf('Al. Planner Singles is short. Al. Planner Singles is full.', ['Al. Planner Singles'])).toEqual([
      'Al. Planner Singles is short.', 'Al. Planner Singles is full.',
    ]);
  });
});
