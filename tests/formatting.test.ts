import { beforeAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { db } from '../server/db.js';
import { computeContracts, SERVICE_DAYS_PER_YEAR as SERVER_SERVICE_DAYS } from '../server/contracts.js';
import { Flags } from '../src/pages/Contracts.js';
import { daysCell, daysLong, daysShort, reportsIlDays } from '../src/injury.js';
import {
  describeService, formatMoney, formatService, ordinal, plural, SERVICE_DAYS_PER_YEAR,
} from '../src/stats.js';
import { IDS, SEASON } from './fixture.js';

/**
 * Small things the screens got wrong, each of them a single character or word
 * and each of them on a page people read for the numbers.
 *
 * A review of the Dodgers' save found them all in one pass: a club past its
 * trade cash showed "$-16.5M", a percentile read "43th pct", a man a day from
 * returning was "~1 days" out, two contract flags ran together as
 * "EXPIRINGNO-TRADE", and a service time of eleven years and twenty-seven days
 * was printed as 11.16 with no hint that it was not eleven years and sixteen.
 */

describe('money', () => {
  it('puts the sign before the dollar sign', () => {
    // The Dodgers' cash for trades
    expect(formatMoney(-16_462_105)).toBe('-$16.5M');
    expect(formatMoney(-16_500_000)).toBe('-$16.5M');
    expect(formatMoney(-850_000)).toBe('-$850K');
    expect(formatMoney(-1_200_000_000)).toBe('-$1.2B');
  });

  it('never prints a dollar sign and then a minus', () => {
    for (const n of [-1, -999, -1_000, -16_462_105, -2_500_000_000]) {
      expect(formatMoney(n), String(n)).not.toContain('$-');
    }
  });

  it('writes the usual sizes', () => {
    expect(formatMoney(1_200_000_000)).toBe('$1.2B');
    expect(formatMoney(329_424_482)).toBe('$329.4M');
    expect(formatMoney(850_000)).toBe('$850K');
    expect(formatMoney(800_000)).toBe('$800K');
    expect(formatMoney(500)).toBe('$500');
  });

  it('writes nothing as $0, with no sign', () => {
    expect(formatMoney(0)).toBe('$0');
    expect(formatMoney(-0)).toBe('$0');
    // Rounds to nothing, so a minus would be a claim about the wrong side of zero
    expect(formatMoney(-0.4)).toBe('$0');
  });

  it('rounds before it picks the unit', () => {
    // Choosing the unit first printed these as "$1000K" and "$1000.0M"
    expect(formatMoney(999_600)).toBe('$1.0M');
    expect(formatMoney(999_499)).toBe('$999K');
    expect(formatMoney(999_960_000)).toBe('$1.0B');
    expect(formatMoney(-999_600)).toBe('-$1.0M');
  });

  it('says nothing when there is no figure', () => {
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney(undefined)).toBe('—');
    expect(formatMoney(Number.NaN)).toBe('—');
  });
});

describe('ordinals', () => {
  it('follows the last digit', () => {
    const cases: Array<[number, string]> = [
      [1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'], [5, '5th'], [9, '9th'], [10, '10th'],
      [21, '21st'], [22, '22nd'], [23, '23rd'], [24, '24th'], [43, '43rd'], [100, '100th'],
      [101, '101st'], [102, '102nd'], [103, '103rd'],
    ];
    for (const [n, text] of cases) expect(ordinal(n)).toBe(text);
  });

  it('gives eleven, twelve and thirteen a "th" of their own', () => {
    for (const [n, text] of [[11, '11th'], [12, '12th'], [13, '13th'], [111, '111th'], [112, '112th'], [113, '113th']] as const) {
      expect(ordinal(n)).toBe(text);
    }
  });

  it('is the sentence the Contracts page prints', () => {
    // "(43th pct)" is what the page said before
    expect(`middling value (${ordinal(43)} pct)`).toBe('middling value (43rd pct)');
  });
});

describe('one day, two days', () => {
  it('pluralises a count', () => {
    expect(plural(1, 'day')).toBe('1 day');
    expect(plural(2, 'day')).toBe('2 days');
    expect(plural(0, 'day')).toBe('0 days');
    expect(plural(1, 'yr')).toBe('1 yr');
    expect(plural(12, 'yr')).toBe('12 yrs');
    expect(plural(2, 'inning', 'innings')).toBe('2 innings');
  });

  it('does not tell the trainer a man is "~1 days" from back', () => {
    const one = { daysLeft: 1, durationUnknown: false };
    expect(daysCell(one)).toBe('~1 day');
    expect(daysLong(one)).toBe('about 1 day remaining');
    // The short form is "1d" either way, which was never wrong
    expect(daysShort(one)).toBe('~1d');
  });

  it('keeps the plural for everyone else', () => {
    const two = { daysLeft: 2, durationUnknown: false };
    expect(daysCell(two)).toBe('~2 days');
    expect(daysLong(two)).toBe('about 2 days remaining');
    expect(daysCell({ daysLeft: 204, durationUnknown: false })).toBe('~204 days');
  });
});

describe('days on the injured list', () => {
  const row = (dlDaysThisYear: number | null) => ({ dlDaysThisYear });

  /*
   * Sixteen injured players in the Dodgers' organization, an IL-60 pitcher
   * among them, and not one of them with a day on the list. The export writes
   * the column and leaves it at zero.
   */
  it('has nothing to show when every row is zero', () => {
    expect(reportsIlDays(Array.from({ length: 16 }, () => row(0)))).toBe(false);
  });

  it('has nothing to show when every row is empty, or there are no rows', () => {
    expect(reportsIlDays([row(null), row(null)])).toBe(false);
    expect(reportsIlDays([])).toBe(false);
  });

  it('shows it as soon as a save fills it in', () => {
    expect(reportsIlDays([row(0), row(0), row(14)])).toBe(true);
  });
});

describe('service time', () => {
  it('is years.days, not a decimal', () => {
    // 1,919 days, which the Contracts page printed as 11.16
    expect(formatService(null, 1919)).toBe('11.027');
    expect(formatService(11.16)).not.toBe('11.16');
  });

  it('runs its days from 000 to 171', () => {
    expect(formatService(null, 0)).toBe('0.000');
    expect(formatService(null, 5)).toBe('0.005');
    expect(formatService(null, 6 * 172 - 1)).toBe('5.171');
    // The next day is a new year, not day 172
    expect(formatService(null, 6 * 172)).toBe('6.000');
  });

  it('can still be written from the decimal the server sends today', () => {
    // 11.16 x 172 = 1,919.5, which is a day out from the truth; exact days are better
    expect(formatService(11.16)).toBe('11.028');
    expect(formatService(3.6)).toBe('3.103');
    expect(formatService(0.07)).toBe('0.012');
  });

  it('prefers exact days to a decimal when it has both', () => {
    expect(formatService(11.16, 1919)).toBe('11.027');
  });

  it('says nothing for a man with no service', () => {
    expect(formatService(null)).toBe('—');
    expect(formatService(undefined, undefined)).toBe('—');
    expect(formatService(Number.NaN)).toBe('—');
    expect(formatService(-1)).toBe('—');
    expect(describeService(null)).toBe('');
  });

  it('explains itself in a tooltip', () => {
    expect(describeService(null, 1919)).toBe('11 years, 27 days of major-league service. A service year is 172 days.');
    expect(describeService(null, 173)).toBe('1 year, 1 day of major-league service. A service year is 172 days.');
  });

  it('says "about" when the days were worked back from a decimal', () => {
    // 1,919 days is 11.16 to two places, and 11.16 comes back as 1,920
    expect(describeService(11.16)).toBe('About 11 years, 28 days of major-league service. A service year is 172 days.');
  });

  it('counts a service year as the server does', () => {
    expect(SERVICE_DAYS_PER_YEAR).toBe(SERVER_SERVICE_DAYS);
    expect(SERVICE_DAYS_PER_YEAR).toBe(172);
  });
});

describe('contract flags', () => {
  const text = (flags: string[]) =>
    renderToStaticMarkup(createElement(Flags, { flags })).replace(/<[^>]*>/g, '');

  it('do not run together when the page is read as text', () => {
    // innerText, a screen reader and a copy all see this, not the margin between the chips
    expect(text(['expiring', 'no-trade'])).toBe('expiring no-trade');
    expect(text(['arbitration 2', 'team option', 'no-trade'])).toBe('arbitration 2 team option no-trade');
  });

  it('are still one chip each', () => {
    const html = renderToStaticMarkup(createElement(Flags, { flags: ['expiring', 'no-trade'] }));
    expect(html.match(/class="flag/g)).toHaveLength(2);
    expect(html).toContain('flag-hot');
  });

  it('are nothing at all for a man with none', () => {
    expect(text([])).toBe('');
  });
});

/**
 * The server writes its own ordinal, into the sentence the Contracts page shows
 * under Recommendation, and it cannot import the one the pages use: the two
 * halves of the app share no module. So what it prints is checked here, against
 * a man who lands on a percentile that takes a suffix other than "th".
 */
describe('the percentile in a recommendation', () => {
  const MID = 9980;
  const LOW = 9981;

  beforeAll(() => {
    const player = db.prepare(
      `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                            uniform_number, team_id, organization_id, retired, hidden,
                            draft_eligible, college)
       VALUES (?, 'Mid', ?, 30, 7, 0, 1, 1, ?, ?, ?, 0, 0, 0, 0)`
    );
    const status = db.prepare(
      `INSERT INTO players_roster_status
         (player_id, is_active, is_on_dl, is_on_dl60, is_on_secondary,
          mlb_service_years, mlb_service_days, mlb_service_days_this_year)
       VALUES (?, 1, 0, 0, 1, ?, ?, 40)`
    );
    const value = db.prepare(
      `INSERT INTO players_value
         (player_id, overall_value, talent_value, offensive_value, offensive_value_vsl,
          offensive_value_vsr, pitching_value, oa_rating, pot_rating, oa, pot)
       VALUES (?, ?, ?, 100, 100, 100, ?, ?, ?, ?, ?)`
    );

    // Out of contract with seven years of service, so he is reaching free agency
    player.run(MID, 'Value', 80, IDS.mlbTeam, IDS.mlbTeam);
    status.run(MID, 7, 7 * 172);
    value.run(MID, 875, 875, 875, 50, 50, 50, 50);
    db.prepare(
      `INSERT INTO players_contract
         (player_id, team_id, contract_team_id, season_year, years, current_year, is_major,
          retained, salary0)
       VALUES (?, ?, ?, ?, 1, 0, 1, 0, 3000000)`
    ).run(MID, IDS.mlbTeam, IDS.mlbTeam, SEASON);

    // One man below everybody, so six of the fourteen position players sit under him
    player.run(LOW, 'Floor', 81, IDS.mlbTeam, IDS.mlbTeam);
    status.run(LOW, 1, 172);
    value.run(LOW, 100, 100, 100, 20, 20, 20, 20);
  });

  it('reads 43rd, not 43th', () => {
    const rows = computeContracts(IDS.mlbTeam).players as unknown as Array<{
      name: string; overallPct: number | null;
      recommendation: { action: string; reasons: string[] } | null;
    }>;
    const him = rows.find((p) => p.name === 'Mid Value');
    expect(him, 'the man never reached the Contracts page').toBeDefined();

    // Six of fourteen below him: the 43rd percentile, which is the figure in the review
    expect(him!.overallPct).toBe(43);
    expect(him!.recommendation?.action).toBe('Market-dependent');
    expect(him!.recommendation?.reasons[0]).toBe('middling value (43rd pct) — replaceable');
    // And it is the same sentence the pages would build from their own helper
    expect(him!.recommendation?.reasons[0]).toContain(`(${ordinal(him!.overallPct!)} pct)`);
  });
});
