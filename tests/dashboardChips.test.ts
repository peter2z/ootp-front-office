import { describe, expect, it, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../server/db.js';
import { PLAN_DECISION_KINDS, farmSignalCounts, planHorizonFold } from '../server/dashboard.js';
import { historyDb } from '../server/history.js';
import type { Plan } from '../server/planTypes.js';
import { rosterCrunch } from '../server/rosterops.js';
import { farmBreakdownTitle } from '../src/pages/Dashboard.js';
import { DECISION_KINDS, defaultHorizon, kindCounts, readFilters, visibleMoves } from '../src/pages/Planner.js';
import type { Plan as PagePlan } from '../src/api.js';
import request, { post } from './request.js';
import { PLAN, seedPlannerOrg } from './plannerFixture.js';
import { IDS, SEASON } from './fixture.js';

/**
 * A chip on the dashboard counts what the page it opens shows.
 *
 * Two of them did not. "Roster issues" read 0 above a Roster Crunch page whose
 * Needs attention list held 6, because the dashboard ran a query of its own
 * that counted designations and waivers and nothing else, while the page also
 * raised options and Rule 5. And "46 promotion signals" opened a farm page with
 * no promotions on it: the Dodgers' 46 were 27 watch, 17 blocked and 2 demote,
 * since the chip counted every man carrying any signal at all and most of them
 * say only that a man is playing well.
 *
 * The roster chip now takes the length of the very list the page shows, from
 * the one function that builds it. The farm chip counts the signals that ask
 * for a decision — promote, blocked, demote — says so in its name, and carries
 * the breakdown for anyone who wants to know what the number is made of.
 */

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

/**
 * A planner that throws on demand, for the one test that needs the dashboard
 * to meet a planner that cannot run. Everything else gets the real one.
 */
const plannerDown = vi.hoisted(() => ({ on: false }));
vi.mock('../server/planner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../server/planner.js')>();
  return {
    ...real,
    computePlan: (...args: Parameters<typeof real.computePlan>) => {
      if (plannerDown.on) throw new Error('the planner is down for this test');
      return real.computePlan(...args);
    },
  };
});

interface Pending {
  crunchIssues: number;
  farmSignals: number;
  farmBreakdown: { promote: number; blocked: number; demote: number };
}
interface Crunch {
  counts: { issues: number };
  issues: Array<{ player_id: number; issues: string[] }>;
}
interface Prospect { player_id: number; signal: string | null }

const pending = async (): Promise<Pending> =>
  ((await request(`/api/dashboard/${IDS.mlbTeam}`)).pending ?? {}) as Pending;
const crunch = async (): Promise<Crunch> =>
  (await request(`/api/roster-crunch/${IDS.mlbTeam}`)) as Crunch;
const farm = async (): Promise<Prospect[]> => {
  const d = await request(`/api/prospects/${IDS.mlbTeam}`);
  return [...(d.batters ?? []), ...(d.pitchers ?? [])] as Prospect[];
};

describe('a save whose roster-status table lacks the option columns', () => {
  /*
   * Runs before anything is added. The base fixture's table is the short one,
   * and the dashboard now depends on the function that reads the option
   * columns: a save without them must lose that flag, not the morning report.
   */
  it('still gets a dashboard, with the count the page gives', async () => {
    const p = await pending();
    expect(typeof p.crunchIssues).toBe('number');
    expect(p.crunchIssues).toBe((await crunch()).counts.issues);
  });
});

const ACTIVE_YOUNG = 9600;
const FARM_LAST_YEAR = 9601;
const DESIGNATED = 9602;
const VETERAN = 9603;

function addRosterTrouble(): void {
  for (const col of ['options_used', 'years_protected_from_rule_5', 'pro_service_years', 'days_on_waivers_left']) {
    const have = (db.prepare(`PRAGMA table_info(players_roster_status)`).all() as Array<{ name: string }>)
      .some((c) => c.name === col);
    if (!have) db.exec(`ALTER TABLE players_roster_status ADD COLUMN ${col} INTEGER DEFAULT 0`);
  }
  const man = (id: number, last: string, team: number, active: number, s: {
    options: number; days: number; dfa?: number;
  }) => {
    db.prepare(
      `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                            uniform_number, team_id, organization_id, retired, hidden,
                            draft_eligible, college)
       VALUES (?, 'Trouble', ?, 28, 1, 11, 1, 1, ?, ?, ?, 0, 0, 0, 0)`
    ).run(id, last, id - 9500, team, IDS.mlbTeam);
    db.prepare(
      `INSERT INTO players_roster_status
         (player_id, is_active, is_on_dl, is_on_dl60, is_on_secondary,
          mlb_service_years, mlb_service_days, mlb_service_days_this_year,
          designated_for_assignment, days_on_dfa_left, is_on_waivers, options_used)
       VALUES (?, ?, 0, 0, 1, ?, ?, 0, ?, 5, 0, ?)`
    ).run(id, active, Math.floor(s.days / 172), s.days, s.dfa ?? 0, s.options);
  };
  // On the 26 with all three options used and two years of service: the page flags him
  man(ACTIVE_YOUNG, 'Young', IDS.mlbTeam, 1, { options: 3, days: 2 * 172 + 100 });
  // In the minors in his last option year: the page flags him, the old chip never did
  man(FARM_LAST_YEAR, 'Lastyear', IDS.aaaTeam, 0, { options: 2, days: 0 });
  // Designated: the one thing the old chip did count
  man(DESIGNATED, 'Designated', IDS.aaaTeam, 0, { options: 0, days: 0, dfa: 1 });
  // A veteran with every option used is nobody's problem, and so nobody's flag
  man(VETERAN, 'Veteran', IDS.mlbTeam, 1, { options: 3, days: 7 * 172 });
}

const LOW_TEAM = 9699;
const PROMOTE = 9620;
const BLOCKED = 9621;
const OVERMATCHED = 9622;
const WATCHED = 9623;

function addFarm(): void {
  // A rung below Triple-A, or Triple-A is the bottom and nobody can be sent down
  db.prepare(
    `INSERT INTO teams (team_id, name, nickname, abbr, level, league_id,
                        sub_league_id, division_id, parent_team_id, allstar_team)
     VALUES (?, 'Low', 'Rungs', 'LOW', 4, ?, 0, 0, ?, 0)`
  ).run(LOW_TEAM, IDS.league, IDS.mlbTeam);

  const man = (id: number, last: string, age: number, oa: number) => {
    db.prepare(
      `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                            uniform_number, team_id, organization_id, retired, hidden,
                            draft_eligible, college)
       VALUES (?, 'Farm', ?, ?, 6, 0, 1, 1, ?, ?, ?, 0, 0, 0, 0)`
    ).run(id, last, age, id - 9500, IDS.aaaTeam, IDS.mlbTeam);
    db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(IDS.aaaTeam, id);
    db.prepare(
      `INSERT INTO players_batting VALUES (?, 40, 40, 40, 40, 40, 45, 45, 45, 45, 45, 45)`
    ).run(id);
    db.prepare(
      `INSERT INTO players_value
         (player_id, overall_value, talent_value, offensive_value, offensive_value_vsl,
          offensive_value_vsr, pitching_value, oa_rating, pot_rating, oa, pot)
       VALUES (?, 300, 400, 100, 100, 100, 0, ?, ?, ?, ?)`
    ).run(id, oa, oa, oa, oa);
  };
  const bat = db.prepare(
    `INSERT INTO players_career_batting_stats
       (player_id, year, team_id, league_id, level_id, split_id, pa, ab, h, d, t, hr,
        bb, ibb, hp, sf, k, sb, cs, r, rbi, war)
     VALUES (?, ?, ?, ?, 2, 1, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 60, 0, 0, 10, 12, 0)`
  );
  //                      pa   ab   h    2b  3b  hr  bb
  const average = [330, 300, 80, 15, 1, 10, 30] as const; // about .757 OPS
  const star = [330, 300, 100, 20, 2, 15, 30] as const;  // about .957
  const awful = [300, 280, 45, 2, 0, 1, 8] as const;     // about .363

  // A Triple-A field for the others to be measured against
  [9610, 9611, 9612].forEach((id, i) => {
    man(id, `Average${i}`, 24, 30);
    bat.run(id, SEASON, IDS.aaaTeam, IDS.league, ...average);
  });

  /*
   * The same line twice. The shortstops on the big club grade 60 and 55, so a
   * man graded 58 beats the weaker of them and is a promotion, and one graded
   * 30 is behind both and is blocked.
   */
  man(PROMOTE, 'Promote', 24, 58);
  bat.run(PROMOTE, SEASON, IDS.aaaTeam, IDS.league, ...star);
  man(BLOCKED, 'Blocked', 24, 30);
  bat.run(BLOCKED, SEASON, IDS.aaaTeam, IDS.league, ...star);

  // Old for the level and far below it
  man(OVERMATCHED, 'Overmatched', 26, 30);
  bat.run(OVERMATCHED, SEASON, IDS.aaaTeam, IDS.league, ...awful);

  // Young for the level on an ordinary line: worth a look and nothing more
  man(WATCHED, 'Watched', 20, 30);
  bat.run(WATCHED, SEASON, IDS.aaaTeam, IDS.league, ...average);
}

describe('the farm page the chip is counted from', () => {
  beforeAll(addFarm);

  it('has one of each signal, or the counts below prove nothing', async () => {
    const by = new Map((await farm()).map((p) => [p.player_id, p.signal]));
    expect(by.get(PROMOTE)).toBe('promote');
    expect(by.get(BLOCKED)).toBe('blocked');
    expect(by.get(OVERMATCHED)).toBe('demote');
    expect(by.get(WATCHED)).toBe('watch');
  });
});

describe('the Roster issues chip', () => {
  beforeAll(addRosterTrouble);

  it('is the length of the list the page shows under Needs attention', async () => {
    const [chip, page] = [await pending(), await crunch()];
    expect(chip.crunchIssues).toBe(page.counts.issues);
    expect(chip.crunchIssues).toBe(page.issues.length);
    // And from the function itself, which is what both of them read
    expect(chip.crunchIssues).toBe(rosterCrunch(IDS.mlbTeam)!.counts.issues);
  });

  it('counts options as well as designations, which is what it missed', async () => {
    /*
     * Three men on the page: the young man on the 26 with no options left, the
     * minor leaguer in his last option year, and the designated one. The old
     * chip counted the last of them only, and read 1 above a page that read 3.
     */
    const page = await crunch();
    expect(page.issues.map((p) => p.player_id).sort())
      .toEqual([ACTIVE_YOUNG, FARM_LAST_YEAR, DESIGNATED].sort());
    expect((await pending()).crunchIssues).toBe(3);
  });

  it('leaves out the veteran with every option used, as the page does', async () => {
    const page = await crunch();
    expect(page.issues.some((p) => p.player_id === VETERAN)).toBe(false);
  });
});

describe('the Farm signals chip', () => {
  const DECISIONS = ['promote', 'blocked', 'demote'];

  it('counts the signals that ask for a decision, and not the ones that watch', async () => {
    const signals = (await farm()).map((p) => p.signal);
    const decisions = signals.filter((s) => s !== null && DECISIONS.includes(s)).length;
    const chip = await pending();
    expect(chip.farmSignals).toBe(decisions);
    expect(chip.farmSignals).toBe(3);
    // The old count, which this must not be: every man with any signal at all
    expect(signals.filter((s) => s !== null).length).toBeGreaterThan(chip.farmSignals);
  });

  it('says what the number is made of', async () => {
    expect((await pending()).farmBreakdown).toEqual({ promote: 1, blocked: 1, demote: 1 });
  });

  it('agrees with the farm page, kind by kind', async () => {
    const signals = (await farm()).map((p) => p.signal);
    const of = (kind: string) => signals.filter((s) => s === kind).length;
    expect((await pending()).farmBreakdown).toEqual({
      promote: of('promote'), blocked: of('blocked'), demote: of('demote'),
    });
  });

  it('is no longer offered as a promotion count', async () => {
    // The name said promote and the number was everything but; it is gone, not kept alongside
    expect(await pending()).not.toHaveProperty('promoteSignals');
  });
});

describe('counting a farm', () => {
  it('counts batters and pitchers together, by kind', () => {
    expect(farmSignalCounts({
      batters: [{ signal: 'promote' }, { signal: 'watch' }, { signal: null }, { signal: 'blocked' }],
      pitchers: [{ signal: 'blocked' }, { signal: 'demote' }, { signal: 'watch' }, { signal: 'watch' }],
    })).toEqual({ promote: 1, blocked: 2, demote: 1, total: 4 });
  });

  it('reads the Dodgers\' 46 as 19, and not one of them a promotion', () => {
    // 27 watch, 17 blocked, 2 demote — and 37 more men with no signal at all
    const some = (n: number, signal: string | null) => Array.from({ length: n }, () => ({ signal }));
    const counts = farmSignalCounts({
      batters: [...some(15, 'watch'), ...some(9, 'blocked'), ...some(1, 'demote'), ...some(20, null)],
      pitchers: [...some(12, 'watch'), ...some(8, 'blocked'), ...some(1, 'demote'), ...some(17, null)],
    });
    expect(counts).toEqual({ promote: 0, blocked: 17, demote: 2, total: 19 });
  });

  it('is zero for a farm that only has men to watch', () => {
    expect(farmSignalCounts({ batters: [{ signal: 'watch' }], pitchers: [] }).total).toBe(0);
  });
});

describe('what the chip says when hovered', () => {
  it('spells out the breakdown', () => {
    expect(farmBreakdownTitle({ promote: 2, blocked: 17, demote: 2 }))
      .toBe('2 promote · 17 blocked · 2 demote');
  });

  it('says "0 promote" rather than leaving it out', () => {
    // The Dodgers' case, and the one the old label got wrong
    expect(farmBreakdownTitle({ promote: 0, blocked: 17, demote: 2 }))
      .toBe('0 promote · 17 blocked · 2 demote');
  });

  it('says nothing for an answer that carries no breakdown', () => {
    expect(farmBreakdownTitle(undefined)).toBeUndefined();
  });
});

/**
 * Read from the source rather than rendered: there is no React renderer in
 * this suite, and what matters is structural — what the chip is called, that it
 * carries the breakdown, and that it opens the same page it always did.
 */
describe('the dashboard page', () => {
  const page = read('src/pages/Dashboard.tsx');

  it('names the chip for what it counts', () => {
    expect(page).toMatch(/label="Farm signals"/);
    expect(page, 'the old label is still on the page').not.toMatch(/Promotion signals/);
    expect(page).toMatch(/count=\{data\.pending\.farmSignals\}/);
  });

  it('gives the chip its breakdown as hover text', () => {
    expect(page).toMatch(/title=\{farmBreakdownTitle\(/);
  });

  it('opens the same pages as before, each on the filter that matches its count', () => {
    // The farm chip counts the decision signals, so it opens the page on them;
    // the roster chip counts the whole "needs attention" list, so it carries nothing
    expect(page).toMatch(/label="Farm signals"[\s\S]*?onNavigate\('prospects', \{ signal: 'decision' \}\)/);
    expect(page).toMatch(/label="Roster issues"[^\n]*onNavigate\('crunch'\)/);
  });
});

/**
 * The "Org moves" chip counts what the Org Planner lists when it opens: the
 * open moves of the decision kinds, folded to the horizon the page opens on.
 * Asked of the planner fixture's whole organisation, with one move of each
 * state the overlay knows, so a count that forgot the decisions or the fold
 * would come out different.
 */
describe('the Org moves chip', () => {
  const planOf = async (show = 'open'): Promise<Plan> =>
    (await request(`/api/plan/${PLAN.org}?show=${show}`)) as Plan;
  const chip = async (): Promise<{ planMoves?: number; planBreakdown?: Record<string, number> }> =>
    ((await request(`/api/dashboard/${PLAN.org}`)).pending ?? {});

  /**
   * What the page lists when the chip opens it: the one payload the page
   * fetches, through the page's own filters, on the address the chip builds.
   * Its Decisions button and its table must say the same.
   */
  const page = async (): Promise<number> => {
    const plan = (await request(`/api/plan/${PLAN.org}?show=all`)) as PagePlan;
    const view = visibleMoves(plan, readFilters({ kind: 'decision' }, plan.gameDate, plan.levels.map((l) => l.rung)));
    expect(kindCounts(view.beforeKind).decision).toBe(view.moves.length);
    return view.moves.length;
  };

  beforeAll(async () => {
    seedPlannerOrg();
    historyDb.prepare(`DELETE FROM plan_decisions WHERE org_id = ?`).run(PLAN.org);
  });

  it('counts the same kinds and opens on the same horizon as the page', () => {
    expect([...PLAN_DECISION_KINDS]).toEqual([...DECISION_KINDS]);
    for (const date of ['2030-3-1', '2030-6-1', '2030-7-31', '2030-8-1', '2030-11-15']) {
      expect(planHorizonFold(date), date).toBe(defaultHorizon(date));
    }
  });

  it('equals the open decision moves of the plan under the default horizon fold', async () => {
    const expected = (p: Plan): number => {
      const fold = defaultHorizon(p.gameDate);
      return p.moves.filter((m) =>
        DECISION_KINDS.includes(m.kind) &&
        (fold === 'all' || m.horizon === 'now') &&
        m.decision.state === 'open'
      ).length;
    };
    const before = await planOf();
    const counted = expected(before);
    // Something to count, or the equality below proves nothing
    expect(counted).toBeGreaterThan(0);
    expect((await chip()).planMoves).toBe(counted);
    expect(await page()).toBe(counted);

    // One decided either way: both leave the chip, and the count still matches the page
    const fold = defaultHorizon(before.gameDate);
    const countable = before.moves.filter((m) =>
      DECISION_KINDS.includes(m.kind) && (fold === 'all' || m.horizon === 'now'));
    expect(countable.length).toBeGreaterThanOrEqual(2);
    try {
      await post(`/api/plan/${PLAN.org}/decisions`, { moveKey: countable[0].key, decision: 'accepted' });
      await post(`/api/plan/${PLAN.org}/decisions`, { moveKey: countable[1].key, decision: 'dismissed' });
      const after = await planOf();
      expect(expected(after)).toBe(counted - 2);
      const p = await chip();
      expect(p.planMoves).toBe(counted - 2);
      expect(Object.values(p.planBreakdown ?? {}).reduce((a, b) => a + b, 0)).toBe(counted - 2);
      // The accepted move has left the page's Open view as it left the chip:
      // it waits under Accepted until an import sees it done
      expect(await page()).toBe(counted - 2);
    } finally {
      historyDb.prepare(`DELETE FROM plan_decisions WHERE org_id = ?`).run(PLAN.org);
    }
  });

  it('is null, not 0, when the planner could not run, and the report still comes', async () => {
    plannerDown.on = true;
    try {
      const res = await request(`/api/dashboard/${PLAN.org}`);
      expect(res.pending.planMoves).toBeNull();
      expect(res.pending.planBreakdown).toBeNull();
      // The rest of the morning report is not lost with it
      expect(typeof res.pending.crunchIssues).toBe('number');
    } finally {
      plannerDown.on = false;
    }
    expect(typeof (await chip()).planMoves).toBe('number');
  });
});
