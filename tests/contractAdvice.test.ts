import { describe, expect, it, beforeAll } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { db } from '../server/db.js';
import { computeContracts, noActionReason, recommend, type Control } from '../server/contracts.js';
import { formDoubtsValue, type SeasonForm } from '../server/form.js';
import { ContractsView } from '../src/pages/Contracts.js';
import type { ContractsResponse } from '../src/api.js';
import request from './request.js';
import { IDS, SEASON } from './fixture.js';

/**
 * Advice that vetoes on a sample too small to veto on, and says two things at once.
 *
 * "Jackson Holliday (24, 96th-percentile value, 97th talent) gets Hold off on
 * 125 PA; Andres Munoz gets Extend now and, in the same cell, 'too little to
 * judge, this is the value figure alone'; Dillon Dingler (80/94, two arbitration
 * years) and Blake Snell get nothing at all."
 *
 * Three faults, one cause: the recommendation was written to answer only the
 * question it was asked. A line becomes readable at 100 plate appearances, and
 * "readable" was being taken for "evidence", though at that size a wRC+ carries a
 * standard error of about thirty points and an 82 is what a 100 hitter has every
 * other month. A man with no season to speak of was told to act now and in the
 * same breath that nothing could be judged. And a man with nothing to decide was
 * given an empty cell, which looks exactly like a page that failed to load.
 */

const poor = (sample: number, unit: 'PA' | 'IP' = 'PA'): SeasonForm => ({
  index: 82,
  meaningful: true,
  line: unit === 'PA' ? `${sample} PA, .227/.320/.327, 82 wRC+` : `${sample} IP, 5.84 ERA, 72 ERA+`,
  verdict: 'poor',
  sample,
  unit,
});
const good = (sample: number): SeasonForm => ({
  index: 141, meaningful: true, line: `${sample} PA, .298/.354/.534, 141 wRC+`, verdict: 'good', sample, unit: 'PA',
});
/** Eleven innings: a line, and too little of one to read. */
const unknown: SeasonForm = {
  index: 108, meaningful: false, line: '11.7 IP, 3.86 ERA, 108 ERA+', verdict: 'unknown', sample: 11.7, unit: 'IP',
};

describe('how much a poor line has to show before it overrules the value figure', () => {
  it('asks a young star for most of a season, so 125 plate appearances do not count', () => {
    const r = formDoubtsValue(poor(125), 24, 97);
    expect(r.needed).toBe(400);
    expect(r.doubts).toBe(false);
  });

  it('lets the same line count against an older man of modest talent', () => {
    // The floor: a line that is readable at all is enough, for a man the ratings do not vouch for
    expect(formDoubtsValue(poor(125), 33, 40)).toEqual({ doubts: true, needed: 100 });
    expect(formDoubtsValue(poor(125), 37, 73)).toEqual({ doubts: true, needed: 100 });
  });

  it('counts once the sample is as large as the profile asks', () => {
    expect(formDoubtsValue(poor(399), 24, 97).doubts).toBe(false);
    expect(formDoubtsValue(poor(400), 24, 97).doubts).toBe(true);
  });

  it('writes the same thresholds in innings for a pitcher', () => {
    expect(formDoubtsValue(poor(40, 'IP'), 24, 97)).toEqual({ doubts: false, needed: 80 });
    expect(formDoubtsValue(poor(80, 'IP'), 24, 97).doubts).toBe(true);
    expect(formDoubtsValue(poor(25, 'IP'), 33, 40)).toEqual({ doubts: true, needed: 20 });
  });

  it('never asks for less than a readable line, or for more than four times that', () => {
    for (let age = 19; age <= 42; age++) {
      for (const talent of [null, 0, 10, 24, 25, 49, 50, 74, 75, 89, 90, 100]) {
        const pa = formDoubtsValue(poor(1), age, talent).needed;
        const ip = formDoubtsValue(poor(1, 'IP'), age, talent).needed;
        expect(pa, `${age} / ${talent}`).toBeGreaterThanOrEqual(100);
        expect(pa, `${age} / ${talent}`).toBeLessThanOrEqual(400);
        expect(ip, `${age} / ${talent}`).toBeGreaterThanOrEqual(20);
        expect(ip, `${age} / ${talent}`).toBeLessThanOrEqual(80);
      }
    }
  });

  it('only ever grows with youth and with talent', () => {
    const needs = (age: number, talent: number) => formDoubtsValue(poor(1), age, talent).needed;
    for (let age = 20; age < 40; age++) {
      for (let talent = 0; talent < 100; talent += 5) {
        // A year older, or five points less talented, never needs more
        expect(needs(age + 1, talent), `${age} / ${talent}`).toBeLessThanOrEqual(needs(age, talent));
        expect(needs(age, talent), `${age} / ${talent}`).toBeLessThanOrEqual(needs(age, talent + 5));
      }
    }
  });

  it('treats a man with no talent figure as neutral rather than as protected or exposed', () => {
    expect(formDoubtsValue(poor(1), 30, null).needed).toBe(100);
    expect(formDoubtsValue(poor(1), 24, null).needed).toBe(200);
  });

  it('is only a veto against a poor line', () => {
    // However much he has played, a good, fair or unreadable line is not a reason to doubt
    for (const verdict of ['good', 'fair', 'unknown'] as const) {
      expect(formDoubtsValue({ ...poor(900), verdict }, 33, 40).doubts, verdict).toBe(false);
    }
  });
});

/** Holliday on the day of the review: arbitration-eligible, 24, 96th in value and 97th in talent. */
const holliday = (over: Partial<Parameters<typeof recommend>[0]> = {}): Parameters<typeof recommend>[0] => ({
  age: 24, yearsAfterThis: 0, reachingFA: false, hasFreeAgency: true,
  overallPct: 96, talentPct: 97, salaryNow: 2_400_000, form: null, ...over,
});
/** A man whose deal ends and who can leave, so the advice is "extend now" or "re-sign". */
const expiring = (over: Partial<Parameters<typeof recommend>[0]> = {}) =>
  holliday({ age: 29, reachingFA: true, overallPct: 76, talentPct: 86, salaryNow: 10_000_000, ...over });

describe('a recommendation to commit, with the season given a veto', () => {
  it('keeps the extension for a young star on 125 poor plate appearances, and says why', () => {
    const rec = recommend(holliday({ form: poor(125) }))!;
    expect(rec.action, 'a 24-year-old at the 97th percentile was told to hold off on 125 PA').toBe('Extension candidate');
    const said = rec.reasons.join(' ');
    // The line is quoted, the sample it would take is named, and the reader is told the value figure stands
    expect(said).toContain('125 PA, .227/.320/.327, 82 wRC+');
    expect(said).toContain('400 PA');
    expect(said).toContain('value figure stands');
  });

  it('holds off an older man of modest talent on the very same line', () => {
    const rec = recommend(expiring({ age: 33, overallPct: 90, talentPct: 40, form: poor(125) }))!;
    expect(rec.action).toBe('Hold off');
    const said = rec.reasons.join(' ');
    expect(said).toContain('125 PA, .227/.320/.327, 82 wRC+');
    expect(said).toMatch(/playing time, not results/);
  });

  it('holds the young star off too once he has played the sample his profile asks for', () => {
    expect(recommend(holliday({ form: poor(399) }))!.action).toBe('Extension candidate');
    expect(recommend(holliday({ form: poor(400) }))!.action).toBe('Hold off');
  });

  it('reads a pitcher in innings', () => {
    const young = holliday({ form: poor(40, 'IP') });
    expect(recommend(young)!.action).toBe('Extension candidate');
    expect(recommend(young)!.reasons.join(' ')).toContain('80 IP');
    expect(recommend(holliday({ form: poor(80, 'IP') }))!.action).toBe('Hold off');
  });

  it('still says a good line backs the call', () => {
    const rec = recommend(expiring({ age: 27, overallPct: 85, form: good(300) }))!;
    expect(rec.action).toBe('Extend now');
    expect(rec.reasons.join(' ')).toContain('141 wRC+ backs it');
  });
});

describe('"now" is only said when the season has had its say', () => {
  it('turns "extend now" into a claim about the value figure when there is nothing to read', () => {
    // Andres Munoz: expiring, 29, 76th percentile, eleven innings
    const rec = recommend(expiring({ form: unknown }))!;
    expect(rec.action).toBe('Extend (value only)');
    const said = rec.reasons.join(' ');
    expect(said).toContain('11.7 IP, 3.86 ERA, 108 ERA+');
    expect(said).toContain('has not weighed in');
    expect(said).toContain('value figure alone');
  });

  it('does the same with no line at all', () => {
    const rec = recommend(expiring({ form: null }))!;
    expect(rec.action).toBe('Extend (value only)');
    expect(rec.reasons.join(' ')).toMatch(/no meaningful playing time yet/);
  });

  it('does the same when a poor line is still too small to doubt him on', () => {
    const rec = recommend(expiring({ age: 25, talentPct: 95, form: poor(125) }))!;
    expect(rec.action).toBe('Extend (value only)');
    expect(rec.reasons.join(' ')).toContain('value figure stands');
  });

  it('never pairs "now" with a season that cannot be read, whoever the man is', () => {
    const forms: Array<SeasonForm | null> = [null, unknown, poor(100), poor(125), poor(399), good(120)];
    for (let age = 21; age <= 40; age++) {
      for (const talentPct of [null, 5, 30, 55, 80, 95]) {
        for (const overallPct of [40, 70, 76, 90, 99]) {
          for (const form of forms) {
            const rec = recommend(expiring({ age, talentPct, overallPct, form }));
            if (rec?.action !== 'Extend now') continue;
            const said = rec.reasons.join(' ');
            const who = `${age} / ${talentPct} / ${overallPct} / ${form?.line}`;
            expect(said, who).not.toMatch(/too little to judge|has not weighed in|value figure alone|value figure stands/);
            expect(said, who).toContain('backs it');
          }
        }
      }
    }
  });

  it('leaves the other words alone: only "now" needed the evidence', () => {
    // A re-signing is not an urgency, so it keeps its word and says the season has not weighed in
    const rec = recommend(expiring({ age: 31, form: unknown }))!;
    expect(rec.action).toBe('Re-sign');
    expect(rec.reasons.join(' ')).toContain('has not weighed in');
    const cand = recommend(holliday({ form: unknown }))!;
    expect(cand.action).toBe('Extension candidate');
  });
});

describe('a man with nothing to decide still gets a line', () => {
  const ask = (control: Control, over: Partial<Parameters<typeof noActionReason>[0]> = {}) =>
    noActionReason({ age: 29, overallPct: 80, endYear: 2031, control, arbTrips: 3, option: null, ...over });

  it('says where he stands and why that is not a decision', () => {
    // Dillon Dingler: 29, 80th percentile, in his second arbitration year
    expect(ask({ status: 'arbitration', arbYear: 2 })).toBe(
      'arbitration year 2 of 3 — age 29 is past the extension cutoff (28); nothing to decide yet'
    );
    // A man the extension line leaves out for value says that instead
    expect(ask({ status: 'arbitration', arbYear: 1 }, { age: 27, overallPct: 53 })).toBe(
      'arbitration year 1 of 3 — value 53rd pct is under the 75th-pct extension line; nothing to decide yet'
    );
    expect(ask({ status: 'pre-arbitration', arbYear: null }, { age: 23, overallPct: 14 })).toContain(
      'pre-arbitration, renewed near the minimum — value 14th pct'
    );
  });

  it('says how long a man is signed, and what is on the last year', () => {
    // Blake Snell: 35, signed through 2030 with a team option on the last year
    expect(ask({ status: 'signed', arbYear: null }, { age: 35, endYear: 2030, option: 'team option' })).toBe(
      'under contract through 2030 (last year a team option) — nothing to decide yet'
    );
    expect(ask({ status: 'signed', arbYear: null }, { endYear: 2031 })).toBe(
      'under contract through 2031 — nothing to decide yet'
    );
  });

  it('does not say "yet" about a man who is locked up or cannot leave', () => {
    expect(ask({ status: 'extended', arbYear: null }, { endYear: 2032 })).toBe(
      'extended through 2032 — nothing to decide'
    );
    expect(ask({ status: 'reserve clause', arbYear: null })).toBe(
      'reserve clause, so the club keeps him — nothing to decide'
    );
  });

  it('owns up to a man it has no value for', () => {
    expect(ask({ status: 'signed', arbYear: null }, { overallPct: null })).toMatch(/no Value figure/);
  });

  it('is never empty, whatever the status', () => {
    const statuses: Control['status'][] = [
      'signed', 'extended', 'leaving', 'arbitration', 'pre-arbitration', 'reserve clause',
    ];
    for (const status of statuses) {
      for (const overallPct of [null, 5, 50, 74, 75, 99]) {
        for (const age of [21, 28, 29, 38]) {
          const line = ask({ status, arbYear: status === 'arbitration' ? 1 : null }, { overallPct, age });
          expect(line.length, `${status} / ${overallPct} / ${age}`).toBeGreaterThan(10);
          expect(line, `${status} / ${overallPct} / ${age}`).not.toMatch(/undefined|null|NaN/);
        }
      }
    }
  });
});

/*
 * The same cases through the payload, which is what the page and the assistants
 * read. Everybody here is a position player on the club under test, and the
 * league's pool is widened with forty men on the other club so that a top
 * value is a top percentile and not a rank out of eleven.
 */
const YOUNG_STAR = 8801;
const OLD_BAT = 8802;
const BACKED_STAR = 8803;
const BARE_STAR = 8804;
const DINGLER_LIKE = 8805;
const SNELL_LIKE = 8806;
const FILLER = 8900;

/** 125 plate appearances at .186/.232/.237 — a line anybody would call poor. */
const POOR_LINE = { pa: 125, ab: 118, h: 22, d: 3, hr: 1, bb: 7, k: 35 };
/** The reverse: .352/.439/.617 over 150. */
const GOOD_LINE = { pa: 150, ab: 128, h: 45, d: 10, hr: 8, bb: 20, k: 25 };
/** Forty plate appearances, which is a start and not a season. */
const BARE_LINE = { pa: 40, ab: 36, h: 9, d: 2, hr: 1, bb: 4, k: 9 };

interface Man {
  id: number;
  last: string;
  age: number;
  position?: number;
  value: number;
  talent: number;
  /** Years of major-league service. */
  service: number;
  years?: number;
  done?: number;
  salary?: number;
  teamOption?: boolean;
  line?: { pa: number; ab: number; h: number; d: number; hr: number; bb: number; k: number };
  team?: number;
}

function addMan(m: Man): void {
  const team = m.team ?? IDS.mlbTeam;
  const years = m.years ?? 1;
  const done = m.done ?? 0;
  db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Advice', ?, ?, ?, 0, 1, 1, ?, ?, ?, 0, 0, 0, 0)`
  ).run(m.id, m.last, m.age, m.position ?? 4, m.id - 8000, team, team);
  db.prepare(
    `INSERT INTO players_roster_status
       (player_id, is_active, is_on_dl, is_on_dl60, is_on_secondary,
        mlb_service_years, mlb_service_days, mlb_service_days_this_year)
     VALUES (?, 1, 0, 0, 0, ?, ?, 40)`
  ).run(m.id, Math.floor(m.service), Math.round(m.service * 172));
  db.prepare(
    `INSERT INTO players_value
       (player_id, overall_value, talent_value, offensive_value, offensive_value_vsl,
        offensive_value_vsr, pitching_value, oa_rating, pot_rating, oa, pot)
     VALUES (?, ?, ?, 100, 100, 100, 0, 60, 60, 60, 60)`
  ).run(m.id, m.value, m.talent);
  db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(team, m.id);
  const salaries = Array.from({ length: 15 }, (_, i) => (i < years ? (m.salary ?? 1_000_000) : 0));
  db.prepare(
    `INSERT INTO players_contract
       (player_id, team_id, contract_team_id, season_year, years, current_year, is_major,
        retained, no_trade, last_year_team_option, last_year_player_option,
        last_year_vesting_option, ${salaries.map((_, i) => `salary${i}`).join(', ')})
     VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0, ?, 0, 0, ${salaries.map(() => '?').join(', ')})`
  ).run(m.id, team, team, SEASON - done, years, done, m.teamOption ? 1 : 0, ...salaries);
  if (m.line) {
    const l = m.line;
    db.prepare(
      `INSERT INTO players_career_batting_stats
       VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?, 0, ?, ?, 0, 0, 0, ?, 0, 0, ?, 0, 0.0)`
    ).run(m.id, SEASON, team, IDS.league, l.pa, l.ab, l.h, l.d, l.hr, l.bb, l.k, Math.round(l.pa / 10));
  }
}

beforeAll(() => {
  for (let i = 0; i < 40; i++) {
    addMan({ id: FILLER + i, last: `Pool${i}`, age: 27, value: 100 + 20 * i, talent: 100 + 20 * i,
             service: 3, team: IDS.otherMlbTeam });
  }
  // Holliday: 24, arbitration year one, the top of the pool in value and talent, and a poor start
  addMan({ id: YOUNG_STAR, last: 'Young Star', age: 24, value: 9100, talent: 9100, service: 3.22,
           salary: 2_400_000, line: POOR_LINE });
  // The same start from a man of 33 whose deal is ending and whose ratings are at the floor
  addMan({ id: OLD_BAT, last: 'Old Bat', age: 33, position: 3, value: 8950, talent: 150, service: 8,
           salary: 10_000_000, line: POOR_LINE });
  // Expiring, prime, and a season that says so
  addMan({ id: BACKED_STAR, last: 'Backed Star', age: 27, value: 9050, talent: 9050, service: 6.5,
           salary: 9_000_000, line: GOOD_LINE });
  // Expiring, prime, and forty plate appearances
  addMan({ id: BARE_STAR, last: 'Bare Star', age: 28, value: 9000, talent: 9000, service: 7,
           salary: 10_000_000, line: BARE_LINE });
  // Dingler: 29, second arbitration year, good, and past the age the extension advice allows
  addMan({ id: DINGLER_LIKE, last: 'Dingler Like', age: 29, position: 2, value: 7000, talent: 7000,
           service: 3.6, salary: 4_860_000 });
  // Snell: 35, signed two more years after this one, with a team option on the last
  addMan({ id: SNELL_LIKE, last: 'Snell Like', age: 35, position: 3, value: 6500, talent: 6500,
           service: 11.66, years: 6, done: 3, salary: 31_300_000, teamOption: true });
});

interface Row {
  player_id: number;
  name: string;
  recommendation: { action: string; reasons: string[] } | null;
  noActionReason: string | null;
  seasonForm: SeasonForm | null;
  terms: { years: number | null; aav: number | null; comparables: number } | null;
}
const rows = async (): Promise<Row[]> =>
  (await request(`/api/contracts/${IDS.mlbTeam}`)).players as Row[];
const named = async (last: string): Promise<Row> => {
  const row = (await rows()).find((r) => r.name === `Advice ${last}`);
  expect(row, `${last} never reached the contracts payload`).toBeDefined();
  return row!;
};

describe('the contracts payload', () => {
  it('keeps the extension for the young star on his poor start', async () => {
    const him = await named('Young Star');
    expect(him.seasonForm?.verdict, 'the fixture line should read as poor').toBe('poor');
    expect(him.seasonForm?.sample).toBe(125);
    expect(him.recommendation?.action).toBe('Extension candidate');
    expect(him.recommendation?.reasons.join(' ')).toContain('400 PA');
  });

  it('holds off the older man on the same 125 plate appearances', async () => {
    const him = await named('Old Bat');
    expect(him.seasonForm?.verdict).toBe('poor');
    expect(him.seasonForm?.sample).toBe(125);
    expect(him.recommendation?.action).toBe('Hold off');
  });

  it('says "extend now" only for the man whose season backs it', async () => {
    const backed = await named('Backed Star');
    expect(backed.seasonForm?.verdict).toBe('good');
    expect(backed.recommendation?.action).toBe('Extend now');
    expect(backed.recommendation?.reasons.join(' ')).toContain('backs it');

    // Forty plate appearances: the call stands on the value figure, and says so
    const bare = await named('Bare Star');
    expect(bare.seasonForm?.verdict).toBe('unknown');
    expect(bare.recommendation?.action).toBe('Extend (value only)');
    expect(bare.recommendation?.reasons.join(' ')).toContain('has not weighed in');
  });

  it('never pairs "now" with a season that has not been read, for anybody on the club', async () => {
    for (const r of await rows()) {
      if (r.recommendation?.action !== 'Extend now') continue;
      expect(r.recommendation.reasons.join(' '), r.name).not.toMatch(
        /too little to judge|has not weighed in|value figure alone|value figure stands/
      );
    }
  });

  it('gives a man with nothing to decide a reason, in place of a blank', async () => {
    const dingler = await named('Dingler Like');
    expect(dingler.recommendation).toBeNull();
    expect(dingler.noActionReason).toMatch(/^arbitration year 2 of 3 — age 29 is past the extension cutoff/);

    const snell = await named('Snell Like');
    expect(snell.recommendation).toBeNull();
    expect(snell.noActionReason).toBe(
      `under contract through ${SEASON + 2} (last year a team option) — nothing to decide yet`
    );
  });

  it('accounts for every man on the club: an action with reasons, or a reason for none', async () => {
    const all = await rows();
    expect(all.length).toBeGreaterThan(10);
    for (const r of all) {
      if (r.recommendation) {
        expect(r.recommendation.reasons.length, `${r.name}: ${r.recommendation.action} gave no reason`).toBeGreaterThan(0);
        expect(r.noActionReason, `${r.name} has an action and a reason for having none`).toBeNull();
      } else {
        expect(typeof r.noActionReason, `${r.name} has neither an action nor a reason`).toBe('string');
        expect((r.noActionReason as string).trim().length, `${r.name}'s reason is blank`).toBeGreaterThan(0);
      }
    }
  });
});

describe('the page', () => {
  /** The cells of each body row, as text. */
  const cellsOf = (html: string): string[][] =>
    (html.match(/<tbody>.*<\/tbody>/s)?.[0].match(/<tr>.*?<\/tr>/gs) ?? []).map((tr) =>
      (tr.match(/<td[^>]*>.*?<\/td>/gs) ?? []).map((td) => td.replace(/<[^>]*>/g, '').trim())
    );
  const render = () =>
    renderToStaticMarkup(
      createElement(ContractsView, {
        data: computeContracts(IDS.mlbTeam) as unknown as ContractsResponse,
        only: null,
        onOnly: () => {},
      })
    );
  const RECOMMENDATION = 10;

  it('has no empty recommendation cell', () => {
    const table = cellsOf(render());
    expect(table.length).toBeGreaterThan(10);
    for (const cells of table) {
      expect(cells[RECOMMENDATION]?.length, `${cells[0]} has a blank recommendation cell`).toBeGreaterThan(0);
    }
  });

  it('prints the reason where there is no action, and the action where there is one', () => {
    const byName = new Map(cellsOf(render()).map((cells) => [cells[0], cells[RECOMMENDATION]]));
    expect(byName.get('Advice Dingler Like')).toMatch(/^arbitration year 2 of 3/);
    expect(byName.get('Advice Young Star')).toMatch(/^Extension candidate/);
    expect(byName.get('Advice Bare Star')).toMatch(/^Extend \(value only\)/);
    expect(byName.get('Advice Old Bat')).toMatch(/^Hold off/);
  });
});
