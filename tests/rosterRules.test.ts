import { describe, expect, it } from 'vitest';
import { scaleGrade } from '../server/valuation.js';
import {
  MINOR_FA_MINIMUM_YEARS, OPTION_FREE_SERVICE_YEARS, OPTIONS_ALLOWED,
  minorLeagueFaAfterSeason, optionState, outOfOptions, rule5Eligible, rule5ProtectGate,
  serviceCapState, serviceYearsOf,
} from '../server/rosterRules.js';

/**
 * The roster rules, each written once in server/rosterRules.ts and read by the
 * 40-Man page, the player card and the planner.
 *
 * Two of them were wrong or scattered before. The Rule 5 column
 * `years_protected_from_rule_5` is the LENGTH of a man's protection (4, or 5
 * when signed at 18 or under) and the page read it as a countdown, flagging
 * one man on a farm with 115 eligible. And "out of options" was three
 * private copies: the page never looked at `options_used_this_year`, so a man
 * optioned this spring on his third option (Michael Petersen: 3 used, 1 this
 * year) read as out of options when the year was already spent and he could
 * go up and down freely until it ended. These pin the matrix.
 */

describe('serviceCapState', () => {
  it('is ok under the cap, last-season at it, over past it', () => {
    expect(serviceCapState(3, 4)).toBe('ok');
    expect(serviceCapState(4, 4)).toBe('last-season');
    expect(serviceCapState(5, 4)).toBe('over');
  });

  it('is ok at a level with no cap, whatever the years', () => {
    expect(serviceCapState(15, null)).toBe('ok');
    expect(serviceCapState(15, undefined)).toBe('ok');
  });

  it('reads missing years as none', () => {
    expect(serviceCapState(null, 4)).toBe('ok');
    expect(serviceCapState(undefined, 0)).toBe('last-season');
  });
});

describe('optionState', () => {
  const minors = { on40: true, on26: false, serviceYears: 2.4 };
  const majors = { on40: true, on26: true, serviceYears: 2 };

  it('is n/a off the 40-man, where options do not apply', () => {
    expect(optionState({ optionsUsed: 3, optionsUsedThisYear: 0, on40: false, on26: false, serviceYears: 1 }))
      .toBe('n/a');
  });

  it("reads Petersen's (3 used, 1 this year) in the minors as his last option year", () => {
    // Both counters go up the day he is optioned, so this season's is spent and he can go up and down until it ends
    expect(optionState({ ...minors, optionsUsed: 3, optionsUsedThisYear: 1 })).toBe('last-option-year');
  });

  it('reads (3, 0) as out of options', () => {
    expect(optionState({ ...minors, optionsUsed: 3, optionsUsedThisYear: 0 })).toBe('out-of-options');
    expect(optionState({ ...majors, optionsUsed: 3, optionsUsedThisYear: 0 })).toBe('out-of-options');
  });

  it('reads (2, 0) in the minors as a last option year, and (2, 1) as one option left', () => {
    expect(optionState({ ...minors, optionsUsed: 2, optionsUsedThisYear: 0 })).toBe('last-option-year');
    // Zazueta: 2 of 3 used, this year's among them, so next year is the last
    expect(optionState({ ...minors, optionsUsed: 2, optionsUsedThisYear: 1 })).toBe('sendable');
  });

  it('gives a man on the 26 no last-option warning at two used', () => {
    expect(optionState({ ...majors, optionsUsed: 2, optionsUsedThisYear: 0 })).toBe('sendable');
    expect(optionState({ ...majors, optionsUsed: 0, optionsUsedThisYear: 0 })).toBe('sendable');
  });

  it('reads (3, 1) on the 26 as a last option year, since the year is already spent', () => {
    expect(optionState({ ...majors, optionsUsed: 3, optionsUsedThisYear: 1 })).toBe('last-option-year');
  });

  it('never sends a man with five years of service down, whatever his count', () => {
    expect(optionState({ ...majors, serviceYears: OPTION_FREE_SERVICE_YEARS, optionsUsed: 3, optionsUsedThisYear: 0 }))
      .toBe('never-sendable');
    expect(optionState({ ...majors, serviceYears: 6, optionsUsed: 0, optionsUsedThisYear: 0 })).toBe('never-sendable');
    // A day short of it, the count still binds
    expect(optionState({ ...majors, serviceYears: 5 - 1 / 172, optionsUsed: 3, optionsUsedThisYear: 0 }))
      .toBe('out-of-options');
  });

  it('reads a missing count as nothing used', () => {
    expect(optionState({ ...minors, optionsUsed: null, optionsUsedThisYear: null })).toBe('sendable');
    expect(optionState({ ...minors, optionsUsed: undefined, optionsUsedThisYear: undefined })).toBe('sendable');
  });
});

describe('rule5Eligible', () => {
  const off40 = { on40: false, protectedYears: 4 };

  it('needs the pro service to have caught up with the protection', () => {
    expect(rule5Eligible({ ...off40, proServiceYears: 3 })).toBe(false);
    expect(rule5Eligible({ ...off40, proServiceYears: 4 })).toBe(true);
    expect(rule5Eligible({ ...off40, proServiceYears: 5 })).toBe(true);
  });

  it('is never true on the 40-man', () => {
    expect(rule5Eligible({ on40: true, protectedYears: 4, proServiceYears: 5 })).toBe(false);
  });

  it('does not read the column as a countdown: a zero protection says the export does not know', () => {
    expect(rule5Eligible({ on40: false, protectedYears: 0, proServiceYears: 5 })).toBe(false);
    expect(rule5Eligible({ on40: false, protectedYears: null, proServiceYears: 5 })).toBe(false);
    expect(rule5Eligible({ on40: false, protectedYears: 4, proServiceYears: null })).toBe(false);
  });
});

describe('rule5ProtectGate', () => {
  it('passes on a 50 ceiling alone', () => {
    expect(rule5ProtectGate({ oa: 30, pot: scaleGrade(50), productionIndex: null })).toBe(true);
    expect(rule5ProtectGate({ oa: 39, pot: scaleGrade(49), productionIndex: null })).toBe(false);
  });

  it('passes a 40 with an index of 110, which grade alone would miss', () => {
    expect(rule5ProtectGate({ oa: scaleGrade(40), pot: scaleGrade(43), productionIndex: 110 })).toBe(true);
    expect(rule5ProtectGate({ oa: scaleGrade(40), pot: scaleGrade(43), productionIndex: 109 })).toBe(false);
    expect(rule5ProtectGate({ oa: scaleGrade(39), pot: scaleGrade(43), productionIndex: 150 })).toBe(false);
  });

  it('needs a readable index for the second branch', () => {
    expect(rule5ProtectGate({ oa: scaleGrade(45), pot: scaleGrade(45), productionIndex: null })).toBe(false);
  });

  it('recommends nobody on a blank grade', () => {
    expect(rule5ProtectGate({ oa: null, pot: null, productionIndex: 150 })).toBe(false);
    expect(rule5ProtectGate({ oa: undefined, pot: undefined, productionIndex: null })).toBe(false);
  });
});

describe('minorLeagueFaAfterSeason', () => {
  const minorDeal = { majorContract: false, on40: false };

  it('is after this season at six years and after next at five', () => {
    expect(minorLeagueFaAfterSeason({ ...minorDeal, proServiceYears: 6 })).toBe('after-this-season');
    expect(minorLeagueFaAfterSeason({ ...minorDeal, proServiceYears: 5 })).toBe('after-next-season');
    expect(minorLeagueFaAfterSeason({ ...minorDeal, proServiceYears: 4 })).toBeNull();
  });

  it("takes the league's own minimum, and falls back to six without one", () => {
    expect(minorLeagueFaAfterSeason({ ...minorDeal, proServiceYears: 6 }, 7)).toBe('after-next-season');
    expect(minorLeagueFaAfterSeason({ ...minorDeal, proServiceYears: 6 }, null)).toBe('after-this-season');
    expect(MINOR_FA_MINIMUM_YEARS).toBe(6);
  });

  it('does not touch a man on the 40-man or on a major-league deal', () => {
    expect(minorLeagueFaAfterSeason({ majorContract: false, on40: true, proServiceYears: 8 })).toBeNull();
    expect(minorLeagueFaAfterSeason({ majorContract: true, on40: false, proServiceYears: 8 })).toBeNull();
  });
});

describe('the helpers the player card already read', () => {
  it('counts service in 172-day years, exact from the days', () => {
    expect(serviceYearsOf(860, 4)).toBe(5);
    expect(serviceYearsOf(null, 4)).toBe(4);
    expect(serviceYearsOf(undefined, undefined)).toBe(0);
  });

  it('binds the club only under five years and with all three used', () => {
    expect(OPTIONS_ALLOWED).toBe(3);
    expect(outOfOptions(3, 4.99)).toBe(true);
    expect(outOfOptions(3, 5)).toBe(false);
    expect(outOfOptions(2, 1)).toBe(false);
    expect(outOfOptions(null, 1)).toBe(false);
  });
});
