import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setStaticSite, type Plan, type PlanLevel, type PlanMove } from '../src/api.js';
import {
  DECISION_KINDS, MODIFIERS_TIP, PlannerView, badgeClass, clubToday, daysBetween, decisionText, defaultHorizon, emptyMovesText,
  isSettled, kindCounts, levelHeaderText, levelNeeds, levelTone, levelValueText, liveDeadlines, liveReleaseRows, matchesKind,
  matchesShow, moveLineText, moveName, moveRowKey, planCopyText, readFilters, sizeLines, sizeTone, sortMoves, structureLabel, structureParts,
  todayStructureText, visibleMoves, type PlanFilters,
} from '../src/pages/Planner.js';
import { DecisionChip, PLANNER_FAILED } from '../src/pages/Dashboard.js';
import { PLANNER_PROTECT_HASH, Rule5Card, plannerProtects } from '../src/pages/RosterCrunch.js';
import { readNumberEntry } from '../src/pages/Settings.js';
import { historyDb } from '../server/history.js';
import request, { post } from './request.js';
import { PLAN as FIXTURE, seedPlannerOrg } from './plannerFixture.js';

/**
 * What the Org Planner page draws from a plan.
 *
 * The plan is a hand-built payload in the shape of the design's §7, so what
 * is checked here is the page and nothing behind it: that each kind of move
 * gets the badge the stylesheet has a rule for, that a level over its soft
 * maximum warns while one under its minimum is marked bad, that a reason
 * sentence reaches the row untouched, that the deadline and the staff line
 * print, that the copy text has the one-line format the design fixes, that
 * the Decide column is absent from a static export (which has no server to
 * tell), and that one `show=all` payload is filtered client-side the way the
 * address asks. The engine's own numbers are tested where it lives.
 */

const root = join(fileURLToPath(import.meta.url), '..', '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

const open = { state: 'open', gameDate: null, outcome: null, verifiedGameDate: null, seenAt: null, deadlineDate: null } as const;

function move(over: Partial<PlanMove> & { key: string; kind: PlanMove['kind'] }): PlanMove {
  return {
    horizon: 'now',
    forced: over.kind === 'forced',
    player: {
      player_id: 1, name: 'Some Body', age: 24, positionName: 'SS', roleLabel: null, oa: 40, pot: 50,
      bats: 'R', throws: 'R', utility: 'IF', assetClass: 'prospect',
    },
    from: { rung: 'aa', label: 'Tulsa Drillers', team_id: 81 },
    to: { rung: 'aaa', label: 'Oklahoma City Comets', team_id: 52, position: null, role: null },
    reasons: ['A reason.'],
    screen: 'Player page → Transactions',
    ootpSteps: ['Open him', 'Transactions → Promote'],
    deadline: null,
    verify: { field: 'rung', expect: 'aaa' },
    fortyMan: null,
    linked: [],
    decision: open,
    ...over,
  };
}

function level(over: Partial<PlanLevel> & { rung: PlanLevel['rung']; rank: number }): PlanLevel {
  return {
    label: 'A Club', levelName: 'AA', teamIds: [1], leagueId: 1, serviceCap: null,
    now: { roster: 30, healthy: 29, il: 1, groups: { C: 3, IF: 7, OF: 5, SP: 5, RP: 9 } },
    planned: { roster: 30, healthy: 29, groups: { C: 3, IF: 7, OF: 5, SP: 5, RP: 9 } },
    target: { min: 28, max: 35 },
    structure: [],
    staff: { rotation: [], bullpen: [] },
    needs: [],
    baseline: { medAge: 24, medOa: { pos: 34, sp: 37, rp: 36 } },
    tone: 'ok',
    roster: [],
    ...over,
  };
}

const VARGAS: PlanMove = move({
  key: 'forced:127542:high-a:aa',
  kind: 'forced',
  player: {
    player_id: 127542, name: 'Joendry Vargas', age: 22, positionName: '3B', roleLabel: null, oa: 39, pot: 47,
    bats: 'R', throws: 'R', utility: 'IF', assetClass: 'prospect',
  },
  from: { rung: 'high-a', label: 'Great Lakes Loons', team_id: 198 },
  to: { rung: 'aa', label: 'Tulsa Drillers', team_id: 81, position: null, role: null },
  reasons: [
    'This is his last eligible season at High-A: 5 of 5 pro service years against the High-A cap, so he must open 2029 at Double-A or above. He has earned the move now, so it is dated today rather than at the deadline.',
    'Grades 39 with a 47 ceiling, five above the Double-A median of 34, and at 22 he is two years younger than the Double-A median of 24.',
  ],
  deadline: { kind: 'service-cap', date: '2028-9-10', what: 'Last eligible season at High-A — must be at Double-A or above by Opening Day 2029', daysAway: 118 },
});

const MORALES: PlanMove = move({
  key: 'promote:128396:aa:aaa',
  kind: 'promote',
  player: {
    player_id: 128396, name: 'Emil Morales', age: 21, positionName: '3B', roleLabel: null, oa: 41, pot: 43,
    bats: 'R', throws: 'R', utility: 'IF', assetClass: 'depth',
  },
  reasons: ['Hitting .344/.408/.664 with 10 HR in 147 PA at Double-A this year.'],
  deadline: { kind: 'rule5', date: '2028-12-20', what: 'Rule 5 draft', daysAway: 219 },
  linked: ['protect:128396:aa:40man'],
});

const PETERSEN: PlanMove = move({
  key: 'trade:849:aaa:out',
  kind: 'trade',
  player: {
    player_id: 849, name: 'Michael Petersen', age: 33, positionName: 'RHP', roleLabel: 'CL', oa: 49, pot: 49,
    bats: 'R', throws: 'R', utility: 'RP', assetClass: 'depth',
  },
  from: { rung: 'aaa', label: 'Oklahoma City Comets', team_id: 52 },
  to: { rung: 'out', label: 'Out of the organisation', team_id: null, position: null, role: null },
  reasons: ['Holds a 40-man place at Triple-A in his last option year.'],
  deadline: { kind: 'trade-deadline', date: '2028-8-3', what: 'Trade deadline — shop Michael Petersen', daysAway: 80 },
  verify: { field: 'org', expect: 'gone' },
});

/** The cap-forced offseason men, which the page folds away until August. */
const OFFSEASON: PlanMove[] = [1, 2, 3].map((n) => move({
  key: `forced:${9000 + n}:single-a:high-a`,
  kind: 'forced',
  horizon: 'offseason',
  player: { player_id: 9000 + n, name: `Capped Man ${n}`, age: 23, positionName: 'OF', roleLabel: null, oa: 30, pot: 38, bats: 'L', throws: 'L', utility: 'OF', assetClass: 'depth' },
  from: { rung: 'single-a', label: 'Ontario Tower Buzzers', team_id: 248 },
  to: { rung: 'high-a', label: 'Great Lakes Loons', team_id: 198, position: null, role: null },
  reasons: ['This is his last eligible season at Single-A: 4 of 4 pro service years against the Single-A cap, so he must open 2029 at High-A or above.'],
  deadline: { kind: 'service-cap', date: '2028-8-29', what: 'Last eligible season at Single-A', daysAway: 106 },
}));

const DISMISSED: PlanMove = move({
  key: 'release:32563:aa:out',
  kind: 'release',
  player: { player_id: 32563, name: 'Chadwick Tromp', age: 33, positionName: 'C', roleLabel: null, oa: 32, pot: 32, bats: 'R', throws: 'R', utility: 'C', assetClass: 'surplus' },
  to: { rung: 'out', label: 'Out of the organisation', team_id: null, position: null, role: null },
  reasons: ['Fifth of five catchers at Tulsa, every one of the other four graded above him.'],
  verify: { field: 'org', expect: 'gone' },
  decision: { state: 'dismissed', gameDate: '2028-5-15', outcome: null, verifiedGameDate: null, seenAt: null, deadlineDate: null },
});

const ACCEPTED_DONE: PlanMove = move({
  key: 'demote:777:aaa:aa',
  kind: 'demote',
  player: { player_id: 777, name: 'Sent Down', age: 27, positionName: '1B', roleLabel: null, oa: 30, pot: 31, bats: 'R', throws: 'R', utility: 'bat-only', assetClass: 'surplus' },
  from: { rung: 'aaa', label: 'Oklahoma City Comets', team_id: 52 },
  to: { rung: 'aa', label: 'Tulsa Drillers', team_id: 81, position: null, role: null },
  reasons: ['Overmatched at Triple-A.'],
  decision: { state: 'accepted', gameDate: '2028-5-15', outcome: 'done', verifiedGameDate: '2028-8-4', seenAt: 'Tulsa Drillers', deadlineDate: null },
});

const HOLD: PlanMove = move({
  key: 'hold:46356:aaa:aaa',
  kind: 'hold',
  player: { player_id: 46356, name: 'Christian Zazueta', age: 23, positionName: 'SP', roleLabel: 'SP', oa: 39, pot: 57, bats: 'R', throws: 'R', utility: 'SP', assetClass: 'prospect' },
  from: { rung: 'aaa', label: 'Oklahoma City Comets', team_id: 52 },
  to: { rung: 'aaa', label: 'Oklahoma City Comets', team_id: 52, position: null, role: null },
  reasons: ['Stays at Oklahoma City: an 8.27 ERA in 37 innings this year is the worst line of his career.'],
  verify: null,
});

const TULSA = level({
  rung: 'aa', rank: 3, label: 'Tulsa Drillers', levelName: 'AA', teamIds: [81], leagueId: 208, serviceCap: null,
  now: { roster: 41, healthy: 40, il: 1, groups: { C: 5, IF: 7, OF: 5, SP: 5, RP: 19 } },
  planned: { roster: 38, healthy: 37, groups: { C: 3, IF: 7, OF: 6, SP: 6, RP: 12 } },
  // The structure rows describe the planned roster, as the engine builds them
  structure: [
    { group: 'C', have: 3, need: 2, tone: 'ok' },
    { group: 'SS cover', have: 3, need: 1, tone: 'ok' },
    { group: 'CF cover', have: 2, need: 1, tone: 'ok' },
    { group: 'RP', have: 12, need: 7, tone: 'warn' },
  ],
  staff: {
    rotation: [
      { player_id: 11, name: 'Ace One', fit: 0.8, tag: null },
      { player_id: 12, name: 'Arm Two', fit: 0.4, tag: null },
      { player_id: 13, name: 'Swing Three', fit: 0.1, tag: 'swing' },
    ],
    bullpen: [
      { player_id: 21, name: 'Closer Man', fit: 0.5, tag: 'CL' },
      { player_id: 22, name: 'Lefty Spec', fit: 0.2, tag: 'vs L' },
    ],
  },
  tone: 'warn',
});

const LOONS = level({
  rung: 'high-a', rank: 4, label: 'Great Lakes Loons', levelName: 'High-A', teamIds: [198], leagueId: 211, serviceCap: 5,
  now: { roster: 35, healthy: 32, il: 3, groups: { C: 4, IF: 9, OF: 6, SP: 6, RP: 10 } },
  planned: { roster: 25, healthy: 24, groups: { C: 1, IF: 6, OF: 5, SP: 5, RP: 7 } },
  structure: [{ group: 'C', have: 1, need: 2, tone: 'bad' }],
  needs: ['sign 1 minor-league free agent: a catcher'],
  roster: [
    { player_id: 127542, name: 'Joendry Vargas', age: 22, positionName: '3B', roleLabel: null, oa: 39, pot: 47, fit: 1.0, verdict: 'ready', utility: 'IF', assetClass: 'prospect', status: 'leaves', frozen: false, lastEligibleSeason: 2028 },
    { player_id: 5, name: 'Stays Put', age: 20, positionName: 'C', roleLabel: null, oa: 30, pot: 40, fit: 0, verdict: 'hold', utility: 'C', assetClass: 'depth', status: 'stays', frozen: false, lastEligibleSeason: 2031 },
  ],
  tone: 'bad',
});

const PLAN: Plan = {
  orgId: 15,
  gameDate: '2028-5-15',
  season: 2028,
  settings: {
    targets: { fullSeason: { min: 28, max: 35 }, complex: { min: 32, max: 45 }, dsl: { min: 30, max: 45 } },
    serviceCaps: { aaa: null, aa: null, 'high-a': 5, 'single-a': 4, complex: 3, dsl: 4 },
    icMaxAge: 20, icSize: 50,
  },
  warnings: [],
  org: {
    fullSeasonNow: 142, fullSeasonMin: 112, fullSeasonMax: 140,
    fortyMan: { count: 35, limit: 40 },
    ic: { size: 50, max: 50, ages: { '16': 17, '17': 30, '18': 3 } },
    mlbThinnest: ['C'],
  },
  levels: [LOONS, TULSA],
  moves: [VARGAS, MORALES, PETERSEN, HOLD, ...OFFSEASON, DISMISSED, ACCEPTED_DONE],
  releaseOrTrade: [
    { player_id: 849, name: 'Michael Petersen', assetClass: 'depth', modifiers: ['on40-last-option'], kind: 'trade', rank: 1, reasons: ['Shop him before 2028-8-3.'] },
    { player_id: 32563, name: 'Chadwick Tromp', assetClass: 'surplus', modifiers: ['minor-fa-after-season'], kind: 'release', rank: 2, reasons: ['Fifth of five catchers at Tulsa.'] },
  ],
  leaving: [],
  deadlines: [
    { date: '2028-12-20', what: 'Rule 5 draft — protect Emil Morales', player_id: 128396, name: 'Emil Morales', moveKey: 'protect:128396:aa:40man' },
    { date: '2028-8-3', what: 'Trade deadline — shop Michael Petersen', player_id: 849, name: 'Michael Petersen', moveKey: 'trade:849:aaa:out' },
    { date: '2028-5-30', what: 'Something soon', player_id: 1, name: 'Soon Man', moveKey: null },
    { date: '2028-9-10', what: 'Last eligible season at High-A — Joendry Vargas', player_id: 127542, name: 'Joendry Vargas', moveKey: 'forced:127542:high-a:aa' },
  ],
  counts: {
    forced: 4, callup: 0, senddown: 0, protect: 0, promote: 1, cover: 0, demote: 1, assign: 0, position: 0, role: 0,
    trade: 1, release: 1, hold: 1, il60: 0, offseason: 3, open: 7, accepted: 1, dismissed: 1, done: 1,
  },
  method: {},
};

const FILTERS: PlanFilters = { level: null, kind: 'all', horizon: 'now', show: 'open', q: '' };

const render = (filters: Partial<PlanFilters> = {}, plan: Plan = PLAN) =>
  renderToStaticMarkup(
    createElement(PlannerView, {
      plan,
      filters: { ...FILTERS, ...filters },
      onFilter: () => {},
      onDecide: () => {},
    })
  );

const rows = (html: string): string[] => html.match(/<tr>[\s\S]*?<\/tr>/g) ?? [];
const rowOf = (html: string, name: string): string => rows(html).find((r) => r.includes(name)) ?? '';

afterEach(() => setStaticSite(false));

describe('the badges', () => {
  it('give each kind the class the stylesheet has a rule for', () => {
    const css = read('src/styles.css');
    const kinds = ['forced', 'callup', 'senddown', 'promote', 'demote', 'cover', 'assign', 'position', 'role', 'protect', 'il60', 'trade', 'release', 'hold'] as const;
    for (const kind of kinds) {
      const cls = badgeClass(kind);
      expect(cls, kind).toMatch(/^badge [a-z0-9]+$/);
      expect(css, `no rule for .${cls.replace(' ', '.')}`).toContain(`.${cls.replace(' ', '.')} {`);
    }
    expect(badgeClass('forced')).toBe('badge forced');
    expect(badgeClass('release')).toBe('badge release');
    expect(badgeClass('trade')).toBe('badge trade');
    expect(badgeClass('protect')).toBe('badge protect');
    expect(badgeClass('il60')).toBe('badge il60');
    // Reused from the farm page where the meaning is the same
    expect(badgeClass('callup')).toBe('badge promote');
    expect(badgeClass('senddown')).toBe('badge demote');
    expect(badgeClass('hold')).toBe('badge blocked');
  });

  it('are drawn without a fill, in the theme colours only', () => {
    const css = read('src/styles.css');
    for (const kind of ['forced', 'release', 'trade', 'protect', 'il60']) {
      const rule = new RegExp(String.raw`\.badge\.${kind} \{([^}]*)\}`).exec(css)?.[1] ?? '';
      expect(rule, kind).toContain('background: none');
      expect(rule, kind).toMatch(/color: var\(--(good|bad|warn|accent|muted)\)/);
      expect(rule, kind).not.toMatch(/#[0-9a-f]{3,6}|hsl\(|rgb\(/i);
    }
  });

  it('are on the rows', () => {
    const html = render({ horizon: 'all', show: 'all' });
    expect(rowOf(html, 'Joendry Vargas')).toContain('class="badge forced"');
    expect(rowOf(html, 'Emil Morales')).toContain('class="badge promote"');
    expect(rowOf(html, 'Michael Petersen')).toContain('class="badge trade"');
    expect(rowOf(html, 'Christian Zazueta')).toContain('class="badge blocked"');
    expect(rowOf(html, 'Chadwick Tromp')).toContain('class="badge release"');
  });
});

describe('the org line', () => {
  it('says the five figures in one line', () => {
    const html = render();
    expect(html).toContain('142 full-season men');
    expect(html).toContain('band 112-140');
    expect(html).toContain('40-man 35 of 40');
    expect(html).toContain('international complex 50 of 50');
    expect(html).toContain('big club thinnest at C');
  });

  it('warns over the soft band and marks bad under the hard one', () => {
    // 142 against 112-140: over the soft maximum, so amber
    expect(render()).toMatch(/class="card-value warn">142 full-season men/);
    const thin = { ...PLAN, org: { ...PLAN.org, fullSeasonNow: 100 } };
    expect(render({}, thin)).toMatch(/class="card-value bad">100 full-season men/);
    const full = { ...PLAN, org: { ...PLAN.org, fortyMan: { count: 41, limit: 40 } } };
    expect(render({}, full)).toMatch(/class="card-value bad">· 40-man 41 of 40/);
  });

  it('says how many moves the horizon folded away', () => {
    expect(render()).toContain('3 moves folded under offseason');
    expect(render({ horizon: 'all' })).not.toContain('folded under offseason');
  });
});

describe('a level card', () => {
  it('warns over its soft maximum and says what will be done about it', () => {
    const html = render();
    const tulsa = html.slice(html.indexOf('Tulsa Drillers'), html.indexOf('Tulsa Drillers') + 1200);
    expect(tulsa).toContain('class="card-value warn">41 on the roster (40 healthy, 1 IL) → planned 38 (target 28-35)');
    expect(tulsa).toContain('3 over the 35 you set; only surplus men are moved for size');
  });

  it('is bad under its minimum, which is the hard side of the band', () => {
    const html = render();
    const loons = html.slice(html.indexOf('Great Lakes Loons'), html.indexOf('Great Lakes Loons') + 1200);
    expect(loons).toContain('class="card-value bad">35 on the roster (32 healthy, 3 IL) → planned 25 (target 28-35)');
    expect(loons).toContain('3 under the 28 minimum');
    expect(sizeTone(25, { min: 28, max: 35 })).toBe('bad');
    expect(sizeTone(38, { min: 28, max: 35 })).toBe('warn');
    expect(sizeTone(30, { min: 28, max: 35 })).toBe('ok');
  });

  it('prints the structure line with each group in its tone', () => {
    const html = render();
    expect(html).toContain('Planned: <span>C 3</span> · <span>IF 7</span><span> (SS 3)</span> · <span>OF 6</span><span> (CF 2)</span> · <span>SP 6</span> · <span class="tone-warn">RP 12</span>');
    expect(html).toContain('<span class="tone-bad">C 1</span>');
  });

  it('prints the staff line, the closer first in the bullpen', () => {
    expect(render()).toContain('Rotation: Ace One, Arm Two, Swing Three (swing) · Bullpen: Closer Man (CL), Lefty Spec (vs L)');
  });

  it('prints the cap and how many are in their last eligible season', () => {
    const html = render();
    expect(html).toContain('cap 5 · 1 in their last eligible season');
    expect(html).toContain('no service cap');
  });

  it('prints its needs as reasons', () => {
    expect(render()).toContain('<span class="reasons">sign 1 minor-league free agent: a catcher</span>');
  });

  it('is a filter: pressed when the address names it', () => {
    expect(render({ level: 'aa' })).toMatch(/class="card plan-level active"[^>]*aria-pressed="true"/);
    expect(render()).not.toContain('plan-level active');
  });
});

describe('a move row', () => {
  it('carries the reason sentence exactly as the server wrote it', () => {
    const row = rowOf(render(), 'Joendry Vargas');
    expect(row).toContain(
      'This is his last eligible season at High-A: 5 of 5 pro service years against the High-A cap, so he must open 2029 at Double-A or above. He has earned the move now, so it is dated today rather than at the deadline.; Grades 39 with a 47 ceiling'
    );
  });

  it('prints the deadline, hot inside a month', () => {
    const html = render();
    expect(rowOf(html, 'Joendry Vargas')).toContain('class="flag" title="Last eligible season at High-A — must be at Double-A or above by Opening Day 2029">2028-9-10</span>');
    const soon = { ...PLAN, moves: [{ ...VARGAS, deadline: { ...VARGAS.deadline!, date: '2028-6-1' } }] };
    expect(rowOf(render({}, soon), 'Joendry Vargas')).toContain('class="flag flag-hot"');
    expect(daysBetween('2028-5-15', '2028-9-10')).toBe(118);
    expect(daysBetween('2028-5-15', '2028-6-1')).toBe(17);
  });

  it('prints the grades through the shared formatter and the from and to as level tags', () => {
    const row = rowOf(render(), 'Joendry Vargas');
    expect(row).toContain('<td class="num">39→47</td>');
    expect(row).toContain('<span class="level-tag">Great Lakes Loons</span> → <span class="level-tag">Tulsa Drillers</span>');
  });

  it('keeps the OOTP steps in the markup behind a button that controls them', () => {
    const row = rowOf(render(), 'Joendry Vargas');
    expect(row).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-controls="([^"]+)"[^>]*title="Player page → Transactions"/);
    expect(row).toMatch(/<ol id="[^"]+" class="plan-steps" hidden=""><li>Open him<\/li><li>Transactions → Promote<\/li><\/ol>/);
  });

  it('offers Accept and Dismiss on an open move, and says what was seen on a decided one', () => {
    const html = render({ show: 'all' });
    expect(rowOf(html, 'Joendry Vargas')).toMatch(/<button[^>]*class="link-button"[^>]*>Accept<\/button> · <button[^>]*>Dismiss<\/button>/);
    expect(rowOf(html, 'Sent Down')).toContain('Done — on Tulsa Drillers in the 2028-8-4 export');
    expect(rowOf(html, 'Chadwick Tromp')).toContain('Dismissed 2028-5-15');
    expect(rowOf(html, 'Chadwick Tromp')).toContain('>Restore</button>');
    expect(decisionText({ ...VARGAS, decision: { state: 'accepted', gameDate: '2028-5-15', outcome: null, verifiedGameDate: null, seenAt: null, deadlineDate: '2028-9-10' } }))
      .toBe('Accepted 2028-5-15 · not yet seen');
    expect(decisionText({ ...VARGAS, decision: { state: 'accepted', gameDate: '2028-5-15', outcome: 'not-yet', verifiedGameDate: '2028-8-4', seenAt: null, deadlineDate: '2028-9-10' } }))
      .toBe('Accepted 2028-5-15 · not yet seen in the 2028-8-4 export');
  });

  it('has no Decide column on a static site, which has no server to tell', () => {
    expect(render()).toContain('>Decide<');
    setStaticSite(true);
    const html = render();
    expect(html).not.toContain('>Decide<');
    expect(html).not.toContain('>Accept<');
    expect(html).not.toContain('>Dismiss<');
  });
});

describe('the deadlines strip', () => {
  it('lists the dated items soonest first, coloured by how close they are', () => {
    const html = render();
    const strip = /<ul class="plan-deadlines"[\s\S]*?<\/ul>/.exec(html)?.[0] ?? '';
    const dates = [...strip.matchAll(/plan-deadline-date">([^<]+)</g)].map((m) => m[1]);
    expect(dates).toEqual(['2028-5-30', '2028-8-3', '2028-9-10', '2028-12-20']);
    expect(strip).toMatch(/class="plan-deadline avail-bad"><span class="plan-deadline-date">2028-5-30/);
    expect(strip).toMatch(/class="plan-deadline avail-warn"><span class="plan-deadline-date">2028-8-3/);
    expect(strip).toMatch(/class="plan-deadline avail-ok"><span class="plan-deadline-date">2028-12-20/);
    expect(strip).toContain('Trade deadline — shop Michael Petersen');
  });
});

describe('the copy text', () => {
  it('writes one line per visible move in the fixed format', () => {
    expect(moveLineText(MORALES)).toBe(
      'PROMOTE  Emil Morales (3B, 21)  Tulsa Drillers → Oklahoma City Comets  — by 2028-12-20 — Hitting .344/.408/.664 with 10 HR in 147 PA at Double-A this year.'
    );
    // No deadline: no "by" clause
    expect(moveLineText(HOLD)).toBe(
      'HOLD  Christian Zazueta (SP, 23)  Oklahoma City Comets → Oklahoma City Comets — Stays at Oklahoma City: an 8.27 ERA in 37 innings this year is the worst line of his career.'
    );
  });

  it('groups the lines by level, with the level\'s figures on its header', () => {
    const text = planCopyText(PLAN, visibleMoves(PLAN, FILTERS).moves);
    expect(text).toContain('AA — Tulsa Drillers (41 now → 38; target 28-35)\nPROMOTE  Emil Morales');
    expect(text).toContain('High-A — Great Lakes Loons (35 now → 25; target 28-35)\nFORCED  Joendry Vargas');
    // Folded under the offseason, so not on the page and not in the copy
    expect(text).not.toContain('Capped Man');
  });
});

describe('the client-side filters on one show=all payload', () => {
  it('open on the moves dated now until August, and on everything from then', () => {
    expect(defaultHorizon('2028-5-15')).toBe('now');
    expect(defaultHorizon('2028-7-31')).toBe('now');
    expect(defaultHorizon('2028-8-1')).toBe('all');
    expect(readFilters({}, '2028-5-15').horizon).toBe('now');
    expect(readFilters({}, '2028-8-4').horizon).toBe('all');
    expect(readFilters({ horizon: 'offseason' }, '2028-5-15').horizon).toBe('offseason');
  });

  it('fold the offseason moves until asked for', () => {
    const names = (f: Partial<PlanFilters>) => visibleMoves(PLAN, { ...FILTERS, ...f }).moves.map((m) => m.player.name);
    expect(names({})).toEqual(['Joendry Vargas', 'Emil Morales', 'Michael Petersen', 'Christian Zazueta']);
    expect(names({ horizon: 'offseason' })).toEqual(['Capped Man 1', 'Capped Man 2', 'Capped Man 3']);
    expect(names({ horizon: 'all' })).toHaveLength(7);
    expect(visibleMoves(PLAN, FILTERS).folded).toBe(3);
  });

  it('show open, accepted or dismissed moves as the address asks', () => {
    const names = (f: Partial<PlanFilters>) => visibleMoves(PLAN, { ...FILTERS, horizon: 'all', ...f }).moves.map((m) => m.player.name);
    // Open leaves out the dismissed man and the accepted move an import has seen done
    expect(names({})).not.toContain('Chadwick Tromp');
    expect(names({})).not.toContain('Sent Down');
    expect(names({ show: 'dismissed' })).toEqual(['Chadwick Tromp']);
    expect(names({ show: 'accepted' })).toEqual(['Sent Down']);
    expect(names({ show: 'all' })).toHaveLength(9);
  });

  it('mean by "decision" the kinds the dashboard chip counts', () => {
    for (const k of ['forced', 'callup', 'protect', 'demote', 'trade', 'release', 'hold'] as const) expect(matchesKind('decision', k), k).toBe(true);
    for (const k of ['promote', 'senddown', 'cover', 'assign', 'position', 'role', 'il60'] as const) expect(matchesKind('decision', k), k).toBe(false);
    const names = visibleMoves(PLAN, { ...FILTERS, kind: 'decision' }).moves.map((m) => m.player.name);
    expect(names).toEqual(['Joendry Vargas', 'Michael Petersen', 'Christian Zazueta']);
  });

  it('narrow to a level, by either end of the move, and to a name', () => {
    const names = (f: Partial<PlanFilters>) => visibleMoves(PLAN, { ...FILTERS, ...f }).moves.map((m) => m.player.name);
    expect(names({ level: 'aa' })).toEqual(['Joendry Vargas', 'Emil Morales']);
    expect(names({ level: 'aaa' })).toEqual(['Emil Morales', 'Michael Petersen', 'Christian Zazueta']);
    expect(names({ q: 'peter' })).toEqual(['Michael Petersen']);
  });

  it('say how many moves each kind button would show', () => {
    const counts = kindCounts(visibleMoves(PLAN, FILTERS).beforeKind);
    expect(counts.all).toBe(4);
    expect(counts.decision).toBe(3);
    expect(counts.forced).toBe(1);
    expect(counts.promote).toBe(1);
    const html = render();
    expect(html).toMatch(/Decisions <span class="muted">3<\/span>/);
  });

  it('are read from the address and written back in place', () => {
    const source = read('src/pages/Planner.tsx');
    expect(source).toMatch(/const \{ params \} = useRoute\(\)/);
    expect(source).toMatch(/navigate\('planner', \{\s*\.\.\.params,/);
    expect(source).toMatch(/\{ replace: true \}\)/);
  });
});

describe('the release-or-trade list', () => {
  it('is ranked, with the asset class and the modifiers as flags', () => {
    const html = render();
    const row = rowOf(html, 'on40-last-option');
    expect(row).toContain('Michael Petersen');
    expect(row).toContain('<td class="num">1</td>');
    expect(row).toContain('<td>depth</td>');
    expect(row).toContain('<span class="flag">on40-last-option</span>');
  });
});

describe('the wiring', () => {
  it('is crawled into the static export at the one address the page reads', () => {
    expect(read('server/exporter.ts')).toMatch(/`plan\/\$\{orgId\}\?show=all`/);
    expect(read('src/api.ts')).toMatch(/`\/api\/plan\/\$\{orgId\}\?show=all`/);
  });

  it('is a page, in the Farm System menu, with its branch', () => {
    const app = read('src/App.tsx');
    expect(app).toContain("{ page: 'planner', label: 'Org Planner', hint: 'Every level sized and staffed, with the moves to get there' }");
    expect(app).toMatch(/page === 'planner' && <Planner orgId=\{orgId\} onNavigate=\{go\} \/>/);
  });

  it('is counted on the dashboard from the same plan, after the overlay and the fold', () => {
    const server = read('server/dashboard.ts');
    expect(server).toMatch(/computePlan\(orgId\)/);
    expect(server).toMatch(/planMoves: plan \? plan\.total : null,\s*planBreakdown: plan \? plan\.byKind : null/);
    expect(server).toMatch(/try \{[\s\S]*?computePlan[\s\S]*?\} catch/);
    expect(read('src/pages/Dashboard.tsx')).toMatch(/label="Org moves"[\s\S]*?onNavigate\('planner', \{ kind: 'decision' \}\)/);
  });

  it('mounts the routes, clears the plan with the other caches and verifies decisions after the snapshot', () => {
    const api = read('server/api.ts');
    expect(api).toMatch(/api\.use\(plannerRoutes\)/);
    expect(api).toMatch(/function clearImportCaches\(\): void \{[\s\S]*?clearPlanCache\(\);[\s\S]*?\n\}/);
    expect(api).toMatch(/takeSnapshot\(\);[\s\S]*?verifyPlanDecisions\(\);/);
  });
});

// ── What the review of 0.42.0 found on this page ────────────────────────
//
// Each case below is a scenario the review drew from the real Dodgers plan,
// rebuilt on the hand-made payload: what a man would have read, and what he
// reads now.

const accepted = (over: Partial<PlanMove['decision']>): PlanMove['decision'] =>
  ({ state: 'accepted', gameDate: '2028-5-15', outcome: null, verifiedGameDate: null, seenAt: null, deadlineDate: null, ...over });

describe('the Open filter and the dashboard chip', () => {
  /** Vargas accepted and not yet seen: the chip stops counting him, so the page must too. */
  const withAccepted: Plan = {
    ...PLAN,
    moves: PLAN.moves.map((m) => (m.key === VARGAS.key ? { ...m, decision: accepted({ outcome: 'not-yet', verifiedGameDate: '2028-5-22' }) } : m)),
  };

  it('means moves nobody has decided on, and nothing else', () => {
    const names = (f: Partial<PlanFilters>) => visibleMoves(withAccepted, { ...FILTERS, ...f }).moves.map((m) => m.player.name);
    expect(names({})).not.toContain('Joendry Vargas');
    expect(names({ show: 'accepted' })).toContain('Joendry Vargas');
    expect(matchesShow('open', withAccepted.moves[0])).toBe(false);
  });

  it('counts on the Decisions button what the chip counts: open decision kinds under the default fold', () => {
    // The chip's rule, written out: open, a decision kind, inside the fold
    const chip = (p: Plan) => p.moves.filter((m) =>
      m.decision.state === 'open' && DECISION_KINDS.includes(m.kind) &&
      (defaultHorizon(p.gameDate) === 'all' || m.horizon === 'now')).length;
    for (const p of [PLAN, withAccepted]) {
      const filters = readFilters({ kind: 'decision' }, p.gameDate);
      const view = visibleMoves(p, filters);
      expect(kindCounts(view.beforeKind).decision).toBe(chip(p));
      expect(view.moves).toHaveLength(chip(p));
    }
    expect(chip(withAccepted)).toBe(chip(PLAN) - 1);
  });

  it('is where the chip lands: the decision kinds, with the page\'s own horizon and Open filter', () => {
    const dash = read('src/pages/Dashboard.tsx');
    expect(dash).toMatch(/label="Org moves"[\s\S]*?onNavigate\('planner', \{ kind: 'decision' \}\)/);
    expect(readFilters({ kind: 'decision' }, PLAN.gameDate)).toEqual({ level: null, kind: 'decision', horizon: 'now', show: 'open', q: '' });
  });
});

describe('the Org moves chip when the planner could not run', () => {
  const chip = (count: number | null, title?: string) =>
    renderToStaticMarkup(createElement(DecisionChip, { label: 'Org moves', count, title, onClick: () => {} }));

  it('reads a dash and says why, never 0', () => {
    const html = chip(null, PLANNER_FAILED);
    expect(html).toContain('<span class="decision-count">—</span>');
    expect(html).not.toContain('>0<');
    expect(html).not.toContain('has-items');
    expect(html).toContain('title="The planner could not run on this save');
  });

  it('still reads 0 when the planner ran and found nothing', () => {
    expect(chip(0)).toContain('<span class="decision-count">0</span>');
    expect(chip(3)).toContain('decision-chip has-items');
  });

  it('is fed the failure as null, with the title chosen from it', () => {
    const dash = read('src/pages/Dashboard.tsx');
    expect(dash).toMatch(/label="Org moves"\s*count=\{data\.pending\.planMoves \?\? null\}/);
    expect(dash).toMatch(/title=\{data\.pending\.planMoves == null \? PLANNER_FAILED/);
  });
});

describe('an accepted move, as the next import saw it', () => {
  it('says where he was seen when it is done', () => {
    expect(decisionText({ ...MORALES, decision: accepted({ outcome: 'done', verifiedGameDate: '2028-8-4', seenAt: 'Oklahoma City Comets' }) }))
      .toBe('Done — on Oklahoma City Comets in the 2028-8-4 export');
    expect(decisionText({ ...PETERSEN, decision: accepted({ outcome: 'done', verifiedGameDate: '2028-8-4', seenAt: 'out of the organization' }) }))
      .toBe('Done — out of the organization in the 2028-8-4 export');
    // A decision stored before the club was recorded
    expect(decisionText({ ...MORALES, decision: accepted({ outcome: 'done', verifiedGameDate: '2028-8-4' }) }))
      .toBe('Done — seen in the 2028-8-4 export');
  });

  it('says where he went and where he did not when he went somewhere else', () => {
    expect(decisionText({ ...MORALES, decision: accepted({ outcome: 'changed', verifiedGameDate: '2028-8-4', seenAt: 'Great Lakes Loons' }) }))
      .toBe('Changed — on Great Lakes Loons, not Oklahoma City Comets, in the 2028-8-4 export');
  });

  it('does not call a man who has not moved "somewhere else" once the deadline passes', () => {
    // Accepted on 2028-5-15, still at Great Lakes after his 2028-9-10 deadline
    const vargas = decisionText({ ...VARGAS, decision: accepted({ outcome: 'changed', verifiedGameDate: '2028-9-15', seenAt: 'Great Lakes Loons' }) });
    expect(vargas).toBe('Not done by the 2028-9-10 deadline — still on Great Lakes Loons in the 2028-9-15 export');
    // A trade that did not happen by the deadline: he is still in the organisation
    const petersen = decisionText({ ...PETERSEN, decision: accepted({ outcome: 'changed', verifiedGameDate: '2028-8-11', seenAt: 'Oklahoma City Comets' }) });
    expect(petersen).toBe('Not done by the 2028-8-3 deadline — still on Oklahoma City Comets in the 2028-8-11 export');
    expect(decisionText({ ...PETERSEN, decision: accepted({ outcome: 'changed', verifiedGameDate: '2028-8-11' }) }))
      .toBe('Not done by the 2028-8-3 deadline — still in the organisation in the 2028-8-11 export');
    // Where nothing was recorded, only what is certain: he is not where the move named
    const unknown = decisionText({ ...VARGAS, decision: accepted({ outcome: 'changed', verifiedGameDate: '2028-9-15' }) });
    expect(unknown).toBe('Changed — not on Tulsa Drillers in the 2028-9-15 export');
    for (const text of [vargas, petersen, unknown]) expect(text).not.toContain('somewhere else');
  });
});

/** The Dodgers' DSL rung as the real plan gave it: two clubs, 53 planned against a per-club band of 30-45. */
const DSL = level({
  rung: 'dsl', rank: 7, levelName: 'DSL', label: 'DSL Mega / DSL Bautista', teamIds: [159, 176], serviceCap: 4,
  now: { roster: 67, healthy: 66, il: 1, groups: { C: 6, IF: 15, OF: 9, SP: 19, RP: 17 } },
  planned: { roster: 53, healthy: 52, groups: { C: 5, IF: 10, OF: 8, SP: 15, RP: 14 } },
  target: { min: 30, max: 45 },
  needs: ['Sign 11 minor-league free agents: two catchers (nobody eligible below can fill it).'],
  tone: 'bad',
});
const DSL_CLUBS: NonNullable<PlanLevel['clubs']> = [
  { team_id: 159, label: 'DSL Mega', now: 31, planned: 24, min: 30, max: 45, tone: 'bad' },
  { team_id: 176, label: 'DSL Bautista', now: 36, planned: 29, min: 30, max: 45, tone: 'bad' },
];
const cardOf = (html: string, label: string): string => {
  const at = html.indexOf(`</span> ${label}</span>`);
  const start = html.lastIndexOf('<div class="card plan-level', at);
  return html.slice(start, html.indexOf('</div>', at));
};

describe('a level of two clubs', () => {
  const withClubs: Plan = { ...PLAN, levels: [...PLAN.levels, { ...DSL, clubs: DSL_CLUBS }] };
  const without: Plan = { ...PLAN, levels: [...PLAN.levels, DSL] };

  it('reads each club against its own band, so an under-staffed DSL is not called over', () => {
    const card = cardOf(render({}, withClubs), 'DSL Mega / DSL Bautista');
    expect(card).toContain('class="card-value bad">67 on the roster across 2 clubs (66 healthy, 1 IL) → planned 53 (target 30-45 a club)');
    expect(card).toContain('<span class="plan-level-line tone-bad">DSL Mega: 31 → planned 24, 6 under the 30 minimum</span>');
    expect(card).toContain('<span class="plan-level-line tone-bad">DSL Bautista: 36 → planned 29, 1 under the 30 minimum</span>');
    expect(card).not.toContain('8 over the 45');
    expect(card).not.toContain('only surplus men are moved for size');
  });

  it('gives each club its own figures in the copy text', () => {
    expect(levelHeaderText({ ...DSL, clubs: DSL_CLUBS }))
      .toBe('DSL — DSL Mega (31 now → 24; target 30-45) · DSL Bautista (36 now → 29; target 30-45)');
  });

  it('without the clubs in the payload, takes the engine\'s tone and never sets the total against one club\'s band', () => {
    const card = cardOf(render({}, without), 'DSL Mega / DSL Bautista');
    expect(card).toContain('class="card-value bad">67 on the roster across 2 clubs');
    expect(card).not.toContain('8 over the 45');
    expect(levelTone(DSL)).toBe('bad');
    expect(levelHeaderText(DSL)).toBe('DSL — DSL Mega / DSL Bautista (67 now → 53 across 2 clubs; target 30-45 a club)');
    expect(planCopyText(without, [])).not.toContain('(67 now → 53; target 30-45)');
  });
});

/** Morales's protection: a place on the 40-man, which asks him to go to no club. */
const PROTECT: PlanMove = move({
  key: 'protect:128396:aa:40man',
  kind: 'protect',
  player: MORALES.player,
  to: { rung: '40man', label: '40-man roster', team_id: 15, position: null, role: null },
  reasons: ['Rule 5 eligible this winter, and worth a 40-man place before the draft.'],
  deadline: { kind: 'rule5', date: '2028-12-20', what: 'Rule 5 draft — add Emil Morales to the 40-man', daysAway: 219 },
  verify: { field: 'on40', expect: true },
});

/** A roster row for a man at a level, as the engine lists him. */
const rowFor = (player_id: number, status: 'stays' | 'arrives' | 'leaves'): PlanLevel['roster'][number] => ({
  player_id, name: 'Emil Morales', age: 21, positionName: '3B', roleLabel: null, oa: 41, pot: 43, fit: 0.4,
  verdict: 'hold', utility: 'IF', assetClass: 'depth', status, frozen: false, lastEligibleSeason: null,
});

/** Oklahoma City with Morales on it today: promoted since his protection was accepted at Tulsa. */
const OKC = level({
  rung: 'aaa', rank: 2, label: 'Oklahoma City Comets', levelName: 'AAA', teamIds: [52], roster: [rowFor(128396, 'stays')],
});

describe('an accepted protection, which is about a list and not a club', () => {
  it('reads "not done" by its deadline, never "changed", when he is still off the 40-man after it', () => {
    // Promoted to Oklahoma City in the meantime, and never added to the 40-man
    const promoted = decisionText({ ...PROTECT, decision: accepted({ outcome: 'changed', verifiedGameDate: '2028-12-21', seenAt: 'Oklahoma City Comets' }) });
    expect(promoted).toBe('Not done by the 2028-12-20 deadline — on Oklahoma City Comets, not the 40-man roster, in the 2028-12-21 export');
    expect(promoted).not.toContain('Changed');
    // Still on the club he was on
    expect(decisionText({ ...PROTECT, decision: accepted({ outcome: 'changed', verifiedGameDate: '2028-12-21', seenAt: 'Tulsa Drillers' }) }))
      .toBe('Not done by the 2028-12-20 deadline — on Tulsa Drillers, not the 40-man roster, in the 2028-12-21 export');
    // A decision stored before the club was recorded says only what is certain
    expect(decisionText({ ...PROTECT, decision: accepted({ outcome: 'changed', verifiedGameDate: '2028-12-21' }) }))
      .toBe('Not done by the 2028-12-20 deadline — not on the 40-man roster in the 2028-12-21 export');
  });

  it('reads "not yet" before its deadline, with the club he is on', () => {
    const waiting: PlanMove = { ...PROTECT, decision: accepted({ outcome: 'not-yet', verifiedGameDate: '2028-8-4' }) };
    expect(decisionText(waiting, 'Oklahoma City Comets'))
      .toBe('Not yet — on Oklahoma City Comets, not the 40-man roster, in the 2028-8-4 export');
    // Without the club, only that he is not on the list
    expect(decisionText(waiting)).toBe('Not yet — not on the 40-man roster in the 2028-8-4 export');
    // Before any import has looked there is nothing seen to say
    expect(decisionText({ ...PROTECT, decision: accepted({}) })).toBe('Accepted 2028-5-15 · not yet seen');
  });

  it('names the club the plan has him on, not the one the move started from', () => {
    const plan: Plan = {
      ...PLAN, levels: [OKC, LOONS, TULSA],
      moves: [{ ...PROTECT, decision: accepted({ outcome: 'not-yet', verifiedGameDate: '2028-8-4' }) }],
    };
    const row = rowOf(render({ show: 'accepted' }, plan), 'Emil Morales');
    expect(row).toContain('Not yet — on Oklahoma City Comets, not the 40-man roster, in the 2028-8-4 export');
    expect(row).not.toContain('on Tulsa Drillers, not');
  });

  it('does not call a deadline that has not come the one he missed', () => {
    // The plan would protect him again before next winter's draft; the 2028 deadline is the one that passed
    const again: PlanMove = {
      ...PROTECT, deadline: { ...PROTECT.deadline!, date: '2029-12-20' },
      decision: accepted({ outcome: 'changed', verifiedGameDate: '2029-1-5', seenAt: 'Oklahoma City Comets' }),
    };
    expect(decisionText(again)).toBe('Not done by its deadline — on Oklahoma City Comets, not the 40-man roster, in the 2029-1-5 export');
  });

  it('names the deadline it was accepted under, though the card has moved on to next winter\'s', () => {
    // OOTP rolled the Rule 5 date forward once the draft was held, and the plan
    // would protect him again by 2029-12-20; the decision keeps the 2028 date
    const rolled: PlanMove = {
      ...PROTECT, deadline: { ...PROTECT.deadline!, date: '2029-12-20' },
      decision: accepted({ outcome: 'changed', verifiedGameDate: '2028-12-21', seenAt: 'Tulsa Drillers', deadlineDate: '2028-12-20' }),
    };
    const said = 'Not done by the 2028-12-20 deadline — on Tulsa Drillers, not the 40-man roster, in the 2028-12-21 export';
    expect(decisionText(rolled)).toBe(said);
    // On the row, beside the Deadline column, which shows the card's own date
    const plan: Plan = { ...PLAN, gameDate: '2028-12-21', moves: [rolled] };
    const row = rowOf(render({ show: 'accepted', horizon: 'all' }, plan), 'Emil Morales');
    expect(row).toContain(said);
    expect(row).toContain('<span class="flag" title="Rule 5 draft — add Emil Morales to the 40-man">2029-12-20</span>');
  });

  it('reads a move to the 60-day list the same way', () => {
    const il60 = move({
      key: 'il60:128396:aaa:aaa', kind: 'il60', player: MORALES.player,
      from: { rung: 'aaa', label: 'Oklahoma City Comets', team_id: 52 },
      to: { rung: 'aaa', label: '60-day injured list', team_id: 52, position: null, role: null },
      verify: { field: 'il60', expect: true },
      decision: accepted({ outcome: 'not-yet', verifiedGameDate: '2028-8-4' }),
    });
    expect(decisionText(il60, clubToday({ levels: [OKC] }, il60)))
      .toBe('Not yet — on Oklahoma City Comets, not the 60-day injured list, in the 2028-8-4 export');
  });

  it('finds his club on a rung of two only where the move says which of the two', () => {
    const dsl: PlanLevel = { ...DSL, clubs: DSL_CLUBS, roster: [rowFor(128396, 'stays')] };
    const atMega: PlanMove = { ...PROTECT, from: { rung: 'dsl', label: 'DSL Mega', team_id: 159 } };
    expect(clubToday({ levels: [dsl] }, atMega)).toBe('DSL Mega');
    // Accepted at Tulsa and sent down since: the plan cannot say which DSL club he is on
    expect(clubToday({ levels: [dsl] }, PROTECT)).toBeNull();
    // A row he arrives at is where the plan sends him, not where he is
    expect(clubToday({ levels: [{ ...OKC, roster: [rowFor(128396, 'arrives')] }] }, PROTECT)).toBeNull();
    expect(clubToday({ levels: [OKC] }, PROTECT)).toBe('Oklahoma City Comets');
  });
});

/**
 * Accepted moves the imports have settled, beside the ones still to make, on
 * the plan's 2028-5-15. A settled move carries the deadline it was accepted
 * against, which has usually passed: the page must not call it coming up.
 */
describe('a settled move\'s deadline', () => {
  const dated = (date: string, what: string): PlanMove['deadline'] =>
    ({ kind: 'season-end', date, what, daysAway: daysBetween('2028-5-15', date) });
  const done: PlanMove = {
    ...ACCEPTED_DONE, deadline: dated('2028-5-1', 'The deadline the move was accepted against — Sent Down'),
    decision: accepted({ outcome: 'done', verifiedGameDate: '2028-5-14', seenAt: 'Tulsa Drillers', deadlineDate: '2028-5-1' }),
  };
  const changed: PlanMove = {
    ...VARGAS, deadline: dated('2028-5-10', 'Last eligible season at High-A'),
    decision: accepted({ outcome: 'changed', verifiedGameDate: '2028-5-14', seenAt: 'Great Lakes Loons', deadlineDate: '2028-5-10' }),
  };
  const moot: PlanMove = {
    ...PETERSEN, deadline: dated('2028-5-12', 'Trade deadline — shop Michael Petersen'),
    decision: accepted({ outcome: 'moot', verifiedGameDate: '2028-5-14', seenAt: 'out of the organization', deadlineDate: '2028-5-12' }),
  };
  // Rebuilt by the server from the stored decision, as it does for a move the plan no longer makes
  const noLonger: PlanMove = move({
    key: 'promote:4242:aa:aaa', kind: 'promote',
    player: { ...MORALES.player, player_id: 4242, name: 'Gone Quiet' },
    reasons: ['Accepted on 2028-5-1; the plan no longer recommends this move.'],
    screen: 'Player page',
    ootpSteps: ['Open Gone Quiet (Tulsa Drillers)', 'No move: the plan no longer lists it'],
    deadline: dated('2028-6-1', 'The deadline the move was accepted against — Gone Quiet'),
    decision: accepted({ gameDate: '2028-5-1', deadlineDate: '2028-6-1' }),
  });
  // Accepted and not seen done yet: still a move to make
  const waiting: PlanMove = {
    ...MORALES, deadline: { ...MORALES.deadline!, date: '2028-6-1', daysAway: 17 },
    decision: accepted({ outcome: 'not-yet', verifiedGameDate: '2028-5-14', deadlineDate: '2028-6-1' }),
  };
  const soon: PlanMove = { ...HOLD, deadline: dated('2028-6-10', 'Something soon') };
  const plan: Plan = { ...PLAN, moves: [soon, waiting, done, changed, moot, noLonger] };

  it('knows a settled move from one still to make', () => {
    expect(plan.moves.filter(isSettled).map((m) => m.player.name))
      .toEqual(['Sent Down', 'Joendry Vargas', 'Michael Petersen', 'Gone Quiet']);
    // A dismissed move is not an accepted one the imports have settled
    expect(isSettled(DISMISSED)).toBe(false);
  });

  it('is muted, never hot, and says "was due" once its date has passed', () => {
    for (const show of ['accepted', 'all'] as const) {
      const html = render({ show, horizon: 'all' }, plan);
      for (const [name, date] of [['Sent Down', '2028-5-1'], ['Joendry Vargas', '2028-5-10'], ['Michael Petersen', '2028-5-12']]) {
        const row = rowOf(html, name);
        expect(row, `${name} under ${show}`).toMatch(new RegExp(`<span class="muted" title="[^"]*">was due ${date}</span>`));
        expect(row, `${name} under ${show}`).not.toContain('flag-hot');
      }
      // Not due yet, but the plan no longer recommends it: a plain flag
      expect(rowOf(html, 'Gone Quiet')).toContain('<span class="flag" title="The deadline the move was accepted against — Gone Quiet">2028-6-1</span>');
      // Accepted and not seen done is still to make, so it is hot inside a month
      expect(rowOf(html, 'Emil Morales')).toContain('<span class="flag flag-hot" title="Rule 5 draft">2028-6-1</span>');
    }
    expect(rowOf(render({ horizon: 'all' }, plan), 'Christian Zazueta')).toContain('<span class="flag flag-hot" title="Something soon">2028-6-10</span>');
  });

  it('says "was due" in the copy text once its date has passed, and no date before it', () => {
    expect(moveLineText(done, plan.gameDate))
      .toBe('DEMOTE  Sent Down (1B, 27)  Oklahoma City Comets → Tulsa Drillers  — was due 2028-5-1 — Overmatched at Triple-A.');
    expect(moveLineText(noLonger, plan.gameDate))
      .toBe('PROMOTE  Gone Quiet (3B, 21)  Tulsa Drillers → Oklahoma City Comets — Accepted on 2028-5-1; the plan no longer recommends this move.');
    expect(moveLineText(waiting, plan.gameDate)).toContain('Oklahoma City Comets  — by 2028-6-1 — ');
    const text = planCopyText(plan, plan.moves);
    expect(text).toContain('Great Lakes Loons → Tulsa Drillers  — was due 2028-5-10 — ');
    expect(text).not.toMatch(/— by 2028-5-(1|10|12) —/);
  });

  it('sorts after every move still to make, whichever way the dates run', () => {
    const order = (dir: 1 | -1) => sortMoves(plan.moves, 'deadline', dir).map((m) => m.player.name);
    expect(order(1)).toEqual(['Emil Morales', 'Christian Zazueta', 'Sent Down', 'Joendry Vargas', 'Michael Petersen', 'Gone Quiet']);
    expect(order(-1)).toEqual(['Christian Zazueta', 'Emil Morales', 'Gone Quiet', 'Michael Petersen', 'Joendry Vargas', 'Sent Down']);
  });
});

/**
 * Next winter's 40-man question beside last winter's protection that was not
 * made, as the server sends them: the same move key, the card open with its
 * own deadline, the old acceptance on a row of its own with the deadline it
 * was made against.
 */
describe('a fresh 40-man question beside the protection not made last winter', () => {
  const key = 'protect:128396:40man';
  const card: PlanMove = { ...PROTECT, key, deadline: { ...PROTECT.deadline!, date: '2029-12-20', daysAway: 19 } };
  const old: PlanMove = {
    ...PROTECT, key,
    reasons: ['Accepted on 2028-5-15; the 2028-12-21 export found him on Tulsa Drillers, not on the 40-man roster.'],
    ootpSteps: ['Open Emil Morales (Tulsa Drillers)', 'No move: the plan no longer lists it'],
    deadline: { kind: 'rule5', date: '2028-12-20', what: 'The deadline the move was accepted against — Emil Morales', daysAway: -346 },
    decision: accepted({ outcome: 'changed', verifiedGameDate: '2028-12-21', seenAt: 'Tulsa Drillers', deadlineDate: '2028-12-20' }),
  };
  const plan: Plan = { ...PLAN, gameDate: '2029-12-1', moves: [card, old] };

  it('draws both rows, the card still to make and hot, the old one settled and muted', () => {
    expect(isSettled(card)).toBe(false);
    expect(isSettled(old)).toBe(true);
    // One move key, two rows: the table keys each row apart
    expect(moveRowKey(card)).not.toBe(moveRowKey(old));
    const html = render({ show: 'all', horizon: 'all' }, plan);
    const both = rows(html).filter((r) => r.includes('Emil Morales'));
    expect(both).toHaveLength(2);
    const fresh = both.find((r) => r.includes('2029-12-20'))!;
    expect(fresh).toContain('<span class="flag flag-hot" title="Rule 5 draft — add Emil Morales to the 40-man">2029-12-20</span>');
    expect(fresh).toContain('>Accept</button>');
    const settled = both.find((r) => r.includes('2028-12-20'))!;
    expect(settled).toMatch(/<span class="muted" title="[^"]*">was due 2028-12-20<\/span>/);
    expect(settled).not.toContain('flag-hot');
    expect(settled).toContain('Not done by the 2028-12-20 deadline — on Tulsa Drillers, not the 40-man roster, in the 2028-12-21 export');
    // Open lists the card alone; accepted lists the old row alone
    const under = (show: PlanFilters['show']) => rows(render({ show, horizon: 'all' }, plan)).filter((r) => r.includes('Emil Morales'));
    expect(under('open').map((r) => [r.includes('2029-12-20'), r.includes('2028-12-20')])).toEqual([[true, false]]);
    expect(under('accepted').map((r) => [r.includes('2029-12-20'), r.includes('2028-12-20')])).toEqual([[false, true]]);
  });
});

describe('the structure line', () => {
  /** The ACL as the real plan had it: 4 healthy infielders today, 8 once the plan's moves are made. */
  const complex = level({
    rung: 'complex', rank: 6, levelName: 'Complex', label: 'ACL Dodgers', serviceCap: 3,
    now: { roster: 39, healthy: 38, il: 1, groups: { C: 3, IF: 4, OF: 6, SP: 13, RP: 12 } },
    planned: { roster: 44, healthy: 43, groups: { C: 4, IF: 8, OF: 6, SP: 16, RP: 9 } },
    target: { min: 32, max: 45 },
    structure: [
      { group: 'C', have: 4, need: 3, tone: 'ok' }, { group: 'IF', have: 8, need: 8, tone: 'ok' },
      { group: 'OF', have: 6, need: 6, tone: 'ok' }, { group: 'SP', have: 16, need: 6, tone: 'warn' },
      { group: 'RP', have: 9, need: 9, tone: 'ok' },
      { group: 'SS cover', have: 6, need: 1, tone: 'ok' }, { group: 'CF cover', have: 2, need: 1, tone: 'ok' },
    ],
  });
  /** Triple-A: 3 healthy relievers today, 6 after the plan against a need of 7. */
  const aaa = level({
    rung: 'aaa', rank: 2, levelName: 'AAA', label: 'Oklahoma City Comets',
    now: { roster: 32, healthy: 31, il: 1, groups: { C: 4, IF: 7, OF: 6, SP: 11, RP: 3 } },
    planned: { roster: 32, healthy: 31, groups: { C: 2, IF: 7, OF: 5, SP: 11, RP: 6 } },
    structure: [{ group: 'RP', have: 6, need: 7, tone: 'bad' }, { group: 'C', have: 2, need: 2, tone: 'ok' }],
  });

  it('prints the planned figure each tone was worked out on', () => {
    const text = (l: PlanLevel) => structureParts(l).map((p) => p.text).join('|');
    expect(text(complex)).toBe('C 4|IF 8| (SS 6)|OF 6| (CF 2)|SP 16|RP 9');
    expect(structureParts(aaa).find((p) => p.text.startsWith('RP'))).toEqual({ text: 'RP 6', tone: 'bad' });
    const html = render({}, { ...PLAN, levels: [aaa, complex] });
    expect(html).toContain('<span class="tone-bad">RP 6</span>');
    expect(html).not.toContain('<span class="tone-bad">RP 3</span>');
    // No cover count bigger than the infield it belongs to
    expect(html).toContain('<span>IF 8</span><span> (SS 6)</span>');
  });

  it('says "today" where it shows today\'s figures, and only there', () => {
    expect(todayStructureText(complex)).toBe('Today: C 3 · IF 4 · OF 6 · SP 13 · RP 12');
    expect(todayStructureText(aaa)).toBe('Today: C 4 · IF 7 · OF 6 · SP 11 · RP 3');
    const html = render({}, { ...PLAN, levels: [complex] });
    expect(html).toContain('<span class="plan-level-line muted">Today: C 3 · IF 4 · OF 6 · SP 13 · RP 12</span>');
    // The same figures twice say nothing: a level the plan does not touch has no today line
    const still = { ...complex, now: { ...complex.now, groups: { C: 4, IF: 8, OF: 6, SP: 16, RP: 9 } } };
    expect(todayStructureText(still)).toBeNull();
  });

  /*
   * The two DSL clubs, as the org-15 plan gives them: each group row is the
   * club with the fewest men (Mega's one catcher), while now.groups adds the
   * clubs together (six catchers). The line must not set the two side by side.
   */
  const dsl = level({
    rung: 'dsl', rank: 7, levelName: 'DSL', label: 'DSL Dodgers', teamIds: [159, 176],
    now: { roster: 67, healthy: 66, il: 1, groups: { C: 6, IF: 15, OF: 9, SP: 19, RP: 17 } },
    planned: { roster: 62, healthy: 61, groups: { C: 5, IF: 15, OF: 9, SP: 16, RP: 16 } },
    target: { min: 30, max: 45 },
    structure: [
      { group: 'C', have: 1, need: 3, tone: 'bad', note: 'DSL Mega 1; DSL Bautista 4' },
      { group: 'IF', have: 7, need: 8, tone: 'bad', note: 'DSL Mega 7; DSL Bautista 8' },
      { group: 'OF', have: 3, need: 6, tone: 'bad', note: 'DSL Mega 3; DSL Bautista 6' },
      { group: 'SP', have: 7, need: 6, tone: 'warn', note: 'DSL Mega 9; DSL Bautista 7' },
      { group: 'RP', have: 6, need: 9, tone: 'bad', note: 'DSL Mega 10; DSL Bautista 6' },
    ],
    clubs: [
      { team_id: 159, label: 'DSL Mega', now: 31, planned: 30, min: 30, max: 45, tone: 'ok' },
      { team_id: 176, label: 'DSL Bautista', now: 36, planned: 32, min: 30, max: 45, tone: 'ok' },
    ],
  });

  it('says a two-club line is the thinner club in each group, and names both clubs on hover', () => {
    expect(structureLabel(dsl)).toBe('Planned, the thinner of the 2 clubs in each group:');
    expect(structureLabel(complex)).toBe('Planned:');
    expect(structureParts(dsl)[0]).toEqual({ text: 'C 1', tone: 'bad', title: 'DSL Mega 1; DSL Bautista 4' });
    const html = render({}, { ...PLAN, levels: [dsl] });
    expect(html).toContain('Planned, the thinner of the 2 clubs in each group: <span class="tone-bad" title="DSL Mega 1; DSL Bautista 4">C 1</span>');
  });

  it('prints no today line under a two-club rung, where today adds the clubs together', () => {
    expect(todayStructureText(dsl)).toBeNull();
    const html = render({}, { ...PLAN, levels: [dsl] });
    expect(html).not.toContain('Today: C 6');
  });
});

describe('an empty moves table', () => {
  const allDecided: Plan = {
    ...PLAN,
    moves: PLAN.moves.map((m) => (m.horizon === 'now' && m.decision.state === 'open' ? { ...m, decision: accepted({}) } : m)),
  };

  it('does not give the all-clear when the horizon folded the moves away', () => {
    const html = render({}, allDecided);
    expect(html).toContain('No moves dated now; 3 moves are folded under offseason.');
    expect(html).not.toContain('Nothing to do');
  });

  it('says what is missing under the show filter rather than that every level passes', () => {
    const none = { ...PLAN, moves: PLAN.moves.filter((m) => m.decision.state !== 'accepted') };
    expect(render({ show: 'accepted', horizon: 'all' }, none)).toContain('No accepted moves.');
    expect(render({ show: 'dismissed', horizon: 'all' }, { ...PLAN, moves: [VARGAS] })).toContain('No dismissed moves.');
    expect(render({ show: 'accepted', horizon: 'all' }, none)).not.toContain('Nothing to do');
  });

  it('names a level that is still out of its band', () => {
    // Every move decided and nothing folded, but High-A is under its minimum
    const decided = { ...allDecided, moves: allDecided.moves.filter((m) => m.horizon === 'now') };
    expect(emptyMovesText(decided, FILTERS, 0))
      .toBe('No moves left to make, but 2 levels are still short or over their band; the level cards say what is missing.');
  });

  it('gives the all-clear only when nothing is hidden and every level passes', () => {
    const calm = level({ rung: 'aa', rank: 3, label: 'Tulsa Drillers' });
    expect(emptyMovesText({ ...PLAN, levels: [calm], moves: [] }, FILTERS, 0))
      .toBe('Nothing to do: every level passes its rules and sits inside its band.');
    expect(emptyMovesText({ ...PLAN, levels: [calm], moves: [DISMISSED] }, FILTERS, 0))
      .toBe('Nothing left open: every move is accepted or dismissed.');
    expect(emptyMovesText(PLAN, { ...FILTERS, kind: 'callup' }, 0)).toBe('No moves under that filter.');
  });
});

describe('a level the address names', () => {
  const rungs = PLAN.levels.map((l) => l.rung);

  it('is every level when the plan has no card for it', () => {
    expect(readFilters({ level: 'AA' }, PLAN.gameDate, rungs).level).toBeNull();
    expect(readFilters({ level: 'bogus' }, PLAN.gameDate, rungs).level).toBeNull();
    // A real rung this save does not have
    expect(readFilters({ level: 'dsl' }, PLAN.gameDate, rungs).level).toBeNull();
    expect(readFilters({ level: 'aa' }, PLAN.gameDate, rungs).level).toBe('aa');
    expect(readFilters({ level: 'Tulsa' }, PLAN.gameDate).level).toBeNull();
  });

  it('so a mistyped link lists the moves instead of an empty table', () => {
    const html = render(readFilters({ level: 'AA' }, PLAN.gameDate, rungs));
    expect(html).not.toContain('No moves under that filter.');
    expect(rowOf(html, 'Joendry Vargas')).not.toBe('');
  });
});

describe('a dismissed move', () => {
  /** Petersen's trade set aside: the review saw his pill and his release-list row stay. */
  const dismissedTrade: Plan = {
    ...PLAN,
    moves: PLAN.moves.map((m) => (m.key === PETERSEN.key ? { ...m, decision: { ...DISMISSED.decision } } : m)),
  };

  it('leaves the deadlines strip', () => {
    expect(liveDeadlines(dismissedTrade).map((d) => d.moveKey)).not.toContain(PETERSEN.key);
    const html = render({}, dismissedTrade);
    const strip = /<ul class="plan-deadlines"[\s\S]*?<\/ul>/.exec(html)?.[0] ?? '';
    expect(strip).not.toContain('Michael Petersen');
    expect(strip).toContain('Emil Morales');
  });

  it('leaves the release-or-trade list', () => {
    expect(liveReleaseRows(dismissedTrade).map((r) => r.name)).not.toContain('Michael Petersen');
    // Tromp's release is dismissed in the base payload
    expect(liveReleaseRows(PLAN).map((r) => r.name)).toEqual(['Michael Petersen']);
    const html = render({}, dismissedTrade);
    expect(html).not.toContain('on40-last-option');
    expect(html).toContain('Nobody to move out.');
  });
});

describe('the decision buttons', () => {
  it('each name the player and the move they act on', () => {
    const html = render({ show: 'all', horizon: 'all' });
    const buttons = [...html.matchAll(/<button[^>]*>(Accept|Dismiss|Reopen|Restore|Steps ▸)<\/button>/g)];
    expect(buttons.length).toBeGreaterThan(10);
    for (const [tag, text] of buttons) {
      const name = /aria-label="([^"]+)"/.exec(tag)?.[1] ?? '';
      // The visible word first, so speech input can still say it
      expect(name, tag).toMatch(new RegExp(`^${text.replace(' ▸', '')} `));
      expect(name, tag).toMatch(/(&#x27;|')s [a-z0-9 -]+ move$/);
    }
    expect(rowOf(html, 'Joendry Vargas')).toContain('aria-label="Accept Joendry Vargas&#x27;s forced move"');
    expect(rowOf(html, 'Michael Petersen')).toContain('aria-label="Dismiss Michael Petersen&#x27;s trade move"');
    expect(rowOf(html, 'Chadwick Tromp')).toContain('aria-label="Restore Chadwick Tromp&#x27;s release move"');
    expect(rowOf(html, 'Sent Down')).toContain('aria-label="Reopen Sent Down&#x27;s demote move"');
    expect(rowOf(html, 'Joendry Vargas')).toContain('aria-label="Steps for Joendry Vargas&#x27;s forced move"');
    expect(moveName(HOLD)).toBe("Christian Zazueta's hold move");
  });
});

describe('the Flags column of the release-or-trade list', () => {
  it('explains the roster facts it holds, not contract clauses', () => {
    const html = render();
    const at = html.indexOf('>Flags</span>');
    expect(at).toBeGreaterThan(-1);
    const head = html.slice(at, html.indexOf('</th>', at));
    expect(head).toContain('Rule 5');
    expect(head).toContain('minor-league free agent');
    expect(head).not.toContain('contract markers');
    expect(MODIFIERS_TIP).toMatch(/last option year/);
  });
});

describe('the kind buttons', () => {
  it('keep the pressed one when nothing is behind it', () => {
    const html = render({ kind: 'callup' });
    expect(html).toContain('No moves under that filter.');
    expect(html).toMatch(/<button[^>]*class="active"[^>]*aria-pressed="true"[^>]*>Call-up <span class="muted">0<\/span><\/button>/);
    // A kind that is neither pressed nor present stays off the bar
    expect(html).not.toContain('>Send down <');
  });
});

describe('a decision the server refused', () => {
  it('is said on its row, and the plan stays on the page', () => {
    const html = renderToStaticMarkup(createElement(PlannerView, {
      plan: PLAN, filters: FILTERS, onFilter: () => {}, onDecide: () => {},
      decideErrors: { [VARGAS.key]: { name: 'Joendry Vargas', message: 'Not saved: moveKey is not in the current plan.' } },
    }));
    expect(rowOf(html, 'Joendry Vargas')).toContain('role="alert">Not saved: moveKey is not in the current plan.</span>');
    expect(rowOf(html, 'Michael Petersen')).not.toContain('role="alert"');
    expect(html).toContain('<h2>Moves</h2>');
    expect(html).not.toContain('banner error');
  });

  it('is said above the table when the plan read again no longer has the move', () => {
    const html = renderToStaticMarkup(createElement(PlannerView, {
      plan: PLAN, filters: FILTERS, onFilter: () => {}, onDecide: () => {},
      decideErrors: { 'forced:1:aa:aaa': { name: 'Gone Man', message: 'Not saved: moveKey is not in the current plan.' } },
    }));
    expect(html).toContain('Gone Man: Not saved: moveKey is not in the current plan. The plan has been read again and no longer has that move.');
  });

  it('does not take the whole page down', () => {
    const source = read('src/pages/Planner.tsx');
    const onDecide = /const onDecide = async[\s\S]*?\n {2}\};/.exec(source)?.[0] ?? '';
    expect(onDecide).not.toBe('');
    expect(onDecide).not.toContain('setError');
    expect(onDecide).toContain('setDecideErrors');
  });
});

describe('the level card\'s own wording', () => {
  it('says the over-maximum sentence once, not again among the needs', () => {
    const engine = '38 on the planned roster, 3 over the 35 you set; only surplus men are moved for size.';
    const tulsa = { ...TULSA, needs: [engine, 'Sign 1 minor-league free agent: a reliever.'] };
    const html = render({}, { ...PLAN, levels: [tulsa] });
    expect(html.match(/over the 35 you set; only surplus men are moved for size/g)).toHaveLength(1);
    expect(html).toContain('<span class="reasons">Sign 1 minor-league free agent: a reliever.</span>');
    expect(levelNeeds(tulsa)).toEqual(['Sign 1 minor-league free agent: a reliever.']);
  });

  it('gives the big club its active places, not a band nobody set', () => {
    const mlb = level({
      rung: 'mlb', rank: 1, levelName: 'MLB', label: 'Los Angeles Dodgers', target: { min: 0, max: 26 },
      now: { roster: 26, healthy: 26, il: 0, groups: { C: 2, IF: 6, OF: 4, SP: 6, RP: 8 } },
      planned: { roster: 26, healthy: 26, groups: { C: 2, IF: 6, OF: 4, SP: 6, RP: 8 } },
    });
    const html = render({}, { ...PLAN, levels: [mlb] });
    expect(html).toContain('26 of 26 active places (26 healthy, 0 IL) → planned 26');
    expect(html).not.toContain('target 0-26');
    expect(levelValueText(mlb)).not.toContain('target');
    expect(levelHeaderText(mlb)).toBe('MLB — Los Angeles Dodgers (26 now → 26; 26 active places)');
  });

  it('does not tell the complex pool that surplus men are moved', () => {
    const ic = level({ rung: 'ic', rank: 8, levelName: 'IC', label: 'International complex', target: { min: 0, max: 50 }, planned: { roster: 52, healthy: 52, groups: { C: 2, IF: 6, OF: 11, SP: 25, RP: 8 } } });
    expect(sizeLines(ic)).toEqual([{ text: '2 over the 50 places the pool holds', tone: 'warn' }]);
    const card = cardOf(render({}, { ...PLAN, levels: [ic] }), 'International complex');
    expect(card).toContain('2 over the 50 places the pool holds');
    expect(card).not.toContain('surplus');
  });
});

describe('the deadlines strip, to a screen reader', () => {
  it('is a named list whose items say how close they are in words', () => {
    const html = render();
    expect(html).toMatch(/<ul class="plan-deadlines" aria-label="Deadlines"><li class="plan-deadline avail-bad">/);
    expect(html).not.toMatch(/<div class="plan-deadlines"/);
    expect(html).toContain('2028-5-30</span><span class="visually-hidden">(within a month)</span>');
    expect(html).toContain('2028-8-3</span><span class="visually-hidden">(within three months)</span>');
    expect(read('src/styles.css')).toMatch(/\.visually-hidden \{[^}]*clip: rect\(0 0 0 0\)/);
  });
});

describe('the 40-man page beside the planner', () => {
  it('says the planner\'s protections next to its own grade-only count, with a link to them', () => {
    const html = renderToStaticMarkup(createElement(Rule5Card, { eligible: 115, worth: 1, protects: 8 }));
    expect(html).toContain('115 eligible · 1 worth a place on grade alone');
    expect(html).toContain('<a href="#/planner?horizon=all&amp;kind=protect">the planner recommends protecting 8</a>');
    expect(PLANNER_PROTECT_HASH).toBe('#/planner?horizon=all&kind=protect');
  });

  it('says only its own figures when the plan could not be had', () => {
    const html = renderToStaticMarkup(createElement(Rule5Card, { eligible: 115, worth: 1, protects: null }));
    expect(html).toContain('115 eligible · 1 worth a place on grade alone');
    expect(html).not.toContain('planner');
  });

  it('counts the protections still open, the ones the link lists', () => {
    const protect = (key: string, decision: PlanMove['decision']) => move({ key, kind: 'protect', decision });
    expect(plannerProtects({ moves: [
      protect('protect:1:aa:40man', open), protect('protect:2:aa:40man', open),
      protect('protect:3:aa:40man', accepted({})), protect('protect:4:aa:40man', DISMISSED.decision), VARGAS,
    ] })).toBe(2);
    // Read from the one address the static export crawls
    expect(read('src/pages/RosterCrunch.tsx')).toMatch(/getPlan\(orgId\)\.then\(\(plan\) => setProtects\(plannerProtects\(plan\)\)\)\.catch\(\(\) => setProtects\(null\)\)/);
  });
});

describe('a planner setting typed out of range', () => {
  it('is refused with the bound in the sentence, and not saved', () => {
    expect(readNumberEntry('18', 30, 20, 60)).toEqual({ kind: 'refuse', message: '18 is not saved: this takes a whole number from 20 to 60.' });
    expect(readNumberEntry('61', 45, 20, 60)).toEqual({ kind: 'refuse', message: '61 is not saved: this takes a whole number from 20 to 60.' });
    expect(readNumberEntry('0', 4, 1, 10, true)).toEqual({ kind: 'refuse', message: '0 is not saved: this takes a whole number from 1 to 10, or blank for none.' });
    expect(readNumberEntry('3.5', 4, 1, 10, true).kind).toBe('refuse');
    expect(readNumberEntry('', 30, 20, 60)).toEqual({ kind: 'refuse', message: 'Not saved: this needs a whole number from 20 to 60.' });
  });

  it('is saved when it is inside the bounds, and left alone when it has not changed', () => {
    expect(readNumberEntry('32', 30, 20, 60)).toEqual({ kind: 'save', next: 32 });
    expect(readNumberEntry('', 4, 1, 10, true)).toEqual({ kind: 'save', next: null });
    expect(readNumberEntry('', null, 1, 10, true)).toEqual({ kind: 'keep' });
    expect(readNumberEntry('30', 30, 20, 60)).toEqual({ kind: 'keep' });
  });

  it('shows the refusal beside the field', () => {
    const source = read('src/pages/Settings.tsx');
    expect(source).toMatch(/if \(entry\.kind === 'refuse'\) \{\s*setRefused\(entry\.message\);/);
    expect(source).toMatch(/\{refused && <span id=\{noteId\} className="field-note tone-bad" role="alert">\{refused\}<\/span>\}/);
    expect(source).toMatch(/aria-describedby=\{refused \? noteId : undefined\}/);
  });
});

/**
 * The engine leaves a dismissed move's deadline and release-or-trade row out
 * of the plan it sends, so the page has nothing to hide. Asked of the planner
 * fixture over HTTP, at the one address the page fetches.
 */
describe('the payload the page reads, after a dismissal', () => {
  const planOf = async (): Promise<Plan> => (await request(`/api/plan/${FIXTURE.org}?show=all`)) as Plan;
  const clear = () => historyDb.prepare(`DELETE FROM plan_decisions WHERE org_id = ?`).run(FIXTURE.org);

  beforeAll(() => {
    seedPlannerOrg();
    clear();
  });

  it('carries no deadline and no release-or-trade row for a dismissed release or trade', async () => {
    const before = await planOf();
    const out = before.moves.filter((m) => (m.kind === 'release' || m.kind === 'trade') && m.decision.state === 'open');
    const target = out.find((m) => before.deadlines.some((d) => d.moveKey === m.key)) ?? out[0];
    // Something to dismiss, or the absence below proves nothing
    expect(target).toBeDefined();
    expect(before.releaseOrTrade.map((r) => r.player_id)).toContain(target.player.player_id);
    try {
      await post(`/api/plan/${FIXTURE.org}/decisions`, { moveKey: target.key, decision: 'dismissed' });
      const after = await planOf();
      expect(after.deadlines.map((d) => d.moveKey)).not.toContain(target.key);
      expect(after.releaseOrTrade.map((r) => r.player_id)).not.toContain(target.player.player_id);
      // Still there to be restored
      expect(after.moves.find((m) => m.key === target.key)?.decision.state).toBe('dismissed');
    } finally {
      clear();
    }
  });

  it('carries no deadline for any other dismissed move', async () => {
    const before = await planOf();
    const dated = before.moves.find((m) => m.decision.state === 'open' && before.deadlines.some((d) => d.moveKey === m.key));
    expect(dated).toBeDefined();
    try {
      await post(`/api/plan/${FIXTURE.org}/decisions`, { moveKey: dated!.key, decision: 'dismissed' });
      expect((await planOf()).deadlines.map((d) => d.moveKey)).not.toContain(dated!.key);
    } finally {
      clear();
    }
  });
});

/**
 * An accepted move the plan no longer makes is rebuilt by the server from the
 * stored decision. The page tells it for settled from what the server sends,
 * so this is asked of the planner fixture over HTTP rather than built by hand:
 * the decision is moved to a key the plan does not make, with a deadline
 * twelve days before the fixture's 2030-6-1.
 */
describe('an accepted move the plan no longer makes, as the server sends it', () => {
  const planOf = async (): Promise<Plan> => (await request(`/api/plan/${FIXTURE.org}?show=all`)) as Plan;
  const clear = () => historyDb.prepare(`DELETE FROM plan_decisions WHERE org_id = ?`).run(FIXTURE.org);

  beforeAll(() => {
    seedPlannerOrg();
    clear();
  });

  it('is settled: its passed deadline is muted, said as "was due", and sorted after the moves still to make', async () => {
    const before = await planOf();
    // A kind whose decisions the engine does not read, so the plan itself stays as it was
    const target = before.moves.find((m) => m.decision.state === 'open' && m.deadline && !['protect', 'callup', 'trade', 'release'].includes(m.kind));
    expect(target).toBeDefined();
    const gone = `${target!.key}:elsewhere`;
    try {
      await post(`/api/plan/${FIXTURE.org}/decisions`, { moveKey: target!.key, decision: 'accepted' });
      historyDb.prepare(`UPDATE plan_decisions SET move_key = ?, deadline_date = '2030-5-20' WHERE org_id = ? AND move_key = ?`)
        .run(gone, FIXTURE.org, target!.key);
      const plan = await planOf();
      const rebuilt = plan.moves.find((m) => m.key === gone);
      expect(rebuilt?.decision.state).toBe('accepted');
      expect(rebuilt!.decision.deadlineDate).toBe('2030-5-20');
      expect(rebuilt!.deadline?.date).toBe('2030-5-20');
      expect(isSettled(rebuilt!)).toBe(true);
      const row = rowOf(render({ show: 'accepted', horizon: 'all' }, plan), rebuilt!.player.name);
      expect(row).toContain('was due 2030-5-20</span>');
      expect(row).not.toContain('flag-hot');
      expect(moveLineText(rebuilt!, plan.gameDate)).toContain('  — was due 2030-5-20 — ');
      const sorted = sortMoves(plan.moves, 'deadline', 1);
      const at = sorted.indexOf(rebuilt!);
      expect(sorted.slice(at).every(isSettled)).toBe(true);
      expect(sorted.slice(0, at).some((m) => m.deadline)).toBe(true);
    } finally {
      clear();
    }
  });
});
