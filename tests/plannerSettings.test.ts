import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// The planner first, so its settings hook is registered the way the server registers it
import '../server/planner.js';
import type { Plan } from '../server/planTypes.js';
import request, { post } from './request.js';
import { PLAN, PLAN_MEN, seedPlannerOrg } from './plannerFixture.js';

/**
 * The planner's settings block: the size band per club, the service cap per
 * level and the international complex rules.
 *
 * These matter more than a toggle because the engine plans against them. A
 * cap that failed to save would have the planner promote nobody out of a
 * level OOTP is about to call invalid; a band that saved half of itself would
 * have it fill to a minimum above its maximum. So a partial body must merge,
 * a bad body must change nothing at all, and every rule in the design's §9
 * is pinned here with the exact field it names.
 */

const DEFAULT_PLANNER = {
  targets: { fullSeason: { min: 28, max: 35 }, complex: { min: 32, max: 45 }, dsl: { min: 30, max: 45 } },
  serviceCaps: { aaa: null, aa: null, 'high-a': 5, 'single-a': 4, complex: 3, dsl: 4 },
  icMaxAge: 20,
  icSize: 50,
};

/** request.ts has no PUT, and the budget route it was written for takes none either. */
async function put(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${process.env.OOTP_FO_PORT}/api${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // A bare string is refused by express.json() itself, with an HTML page, before the route sees it
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch { /* not JSON: the status is the answer */ }
  return { status: res.status, body: parsed };
}

const planner = async () => (await request('/api/settings')).settings.planner;

beforeAll(async () => {
  await request('/api/status'); // starts the server so the port is known
});

afterAll(async () => {
  await put('/planner-settings', DEFAULT_PLANNER);
});

describe('GET /settings', () => {
  it('carries the planner block with the design defaults', async () => {
    expect(await planner()).toEqual(DEFAULT_PLANNER);
  });

  it('ships the full-season band at 28 to 35: the minimum hard, the maximum soft', async () => {
    expect((await planner()).targets.fullSeason).toEqual({ min: 28, max: 35 });
  });
});

describe('PUT /planner-settings', () => {
  // Put the defaults back after every case, however it ended: a case that
  // fails before its own restore would otherwise fail the later ones that
  // compare against the defaults, for a reason that is not theirs
  afterEach(async () => {
    await put('/planner-settings', DEFAULT_PLANNER);
  });

  it('round-trips a full block', async () => {
    const next = {
      targets: { fullSeason: { min: 30, max: 40 }, complex: { min: 33, max: 46 }, dsl: { min: 31, max: 47 } },
      serviceCaps: { aaa: 7, aa: null, 'high-a': 6, 'single-a': 5, complex: 4, dsl: 3 },
      icMaxAge: 19,
      icSize: 60,
    };
    const { status, body } = await put('/planner-settings', next);
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, planner: next });
    expect(await planner()).toEqual(next);
    await put('/planner-settings', DEFAULT_PLANNER);
  });

  it('merges a partial body into what is saved', async () => {
    const { status, body } = await put('/planner-settings', { targets: { fullSeason: { max: 32 } }, serviceCaps: { dsl: 3 } });
    expect(status).toBe(200);
    expect(body.planner.targets.fullSeason).toEqual({ min: 28, max: 32 });
    expect(body.planner.targets.complex).toEqual(DEFAULT_PLANNER.targets.complex);
    expect(body.planner.serviceCaps).toEqual({ ...DEFAULT_PLANNER.serviceCaps, dsl: 3 });
    expect(body.planner.icMaxAge).toBe(20);
    expect(body.planner.icSize).toBe(50);
    expect(await planner()).toEqual(body.planner);
    await put('/planner-settings', DEFAULT_PLANNER);
  });

  it('accepts null as uncapped', async () => {
    const { status, body } = await put('/planner-settings', { serviceCaps: { 'high-a': null } });
    expect(status).toBe(200);
    expect(body.planner.serviceCaps['high-a']).toBeNull();
    await put('/planner-settings', DEFAULT_PLANNER);
  });

  it('rejects a minimum above the maximum, and saves nothing', async () => {
    const before = await planner();
    const { status, body } = await put('/planner-settings', { targets: { fullSeason: { min: 40 } } });
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toContain('fullSeason');
    expect(await planner()).toEqual(before);
  });

  it('rejects a band outside 20 to 60', async () => {
    expect((await put('/planner-settings', { targets: { dsl: { min: 19 } } })).status).toBe(400);
    expect((await put('/planner-settings', { targets: { dsl: { max: 61 } } })).status).toBe(400);
    expect(await planner()).toEqual(DEFAULT_PLANNER);
  });

  it('rejects a cap of 0 and a cap above 10', async () => {
    const zero = await put('/planner-settings', { serviceCaps: { complex: 0 } });
    expect(zero.status).toBe(400);
    expect(zero.body.error).toContain('serviceCaps.complex');
    expect((await put('/planner-settings', { serviceCaps: { complex: 11 } })).status).toBe(400);
    expect((await planner()).serviceCaps.complex).toBe(3);
  });

  it('rejects an unknown rung key by name', async () => {
    const { status, body } = await put('/planner-settings', { serviceCaps: { 'triple-a': 5 } });
    expect(status).toBe(400);
    expect(body.error).toContain('"triple-a"');
    // The big club and the complex pool carry no service cap either
    expect((await put('/planner-settings', { serviceCaps: { mlb: 5 } })).body.error).toContain('"mlb"');
    expect((await put('/planner-settings', { serviceCaps: { ic: 5 } })).body.error).toContain('"ic"');
    expect(await planner()).toEqual(DEFAULT_PLANNER);
  });

  it('rejects an unknown target by name', async () => {
    const { status, body } = await put('/planner-settings', { targets: { rookie: { min: 30, max: 40 } } });
    expect(status).toBe(400);
    expect(body.error).toContain('"rookie"');
  });

  it('rejects anything that is not a whole number', async () => {
    const before = await planner();
    for (const bad of [
      { targets: { fullSeason: { min: 28.5 } } },
      { targets: { fullSeason: { max: '35' } } },
      { serviceCaps: { dsl: 3.5 } },
      { serviceCaps: { dsl: '4' } },
      { icMaxAge: 20.5 },
      { icMaxAge: '20' },
      { icSize: 50.1 },
    ]) {
      const { status } = await put('/planner-settings', bad);
      expect(status, JSON.stringify(bad)).toBe(400);
    }
    expect(await planner()).toEqual(before);
  });

  it('bounds the complex rules: age 17 to 25, pool 10 to 200', async () => {
    expect((await put('/planner-settings', { icMaxAge: 16 })).status).toBe(400);
    expect((await put('/planner-settings', { icMaxAge: 26 })).status).toBe(400);
    expect((await put('/planner-settings', { icSize: 9 })).status).toBe(400);
    expect((await put('/planner-settings', { icSize: 201 })).status).toBe(400);
    expect((await put('/planner-settings', { icMaxAge: 17, icSize: 200 })).status).toBe(200);
    await put('/planner-settings', DEFAULT_PLANNER);
  });

  it('changes nothing on a malformed body', async () => {
    const before = await planner();
    for (const bad of [[], 'planner', { targets: [] }, { targets: { fullSeason: 30 } }, { serviceCaps: 'none' }]) {
      const { status } = await put('/planner-settings', bad);
      expect(status, JSON.stringify(bad)).toBe(400);
    }
    expect(await planner()).toEqual(before);
  });

  it('rejects an unknown or misspelt setting by name, and saves nothing', async () => {
    const before = await planner();
    const typo = await put('/planner-settings', { icsize: 30 });
    expect(typo.status).toBe(400);
    expect(typo.body.ok).toBe(false);
    expect(typo.body.error).toContain('"icsize"');
    // One good field beside the slip is not saved either
    const mixed = await put('/planner-settings', { icSize: 60, serviceCap: { dsl: 3 } });
    expect(mixed.status).toBe(400);
    expect(mixed.body.error).toContain('"serviceCap"');
    expect(await planner()).toEqual(before);
  });

  it('is left alone by POST /settings', async () => {
    const before = await planner();
    const { settings } = await post('/api/settings', { planner: { icSize: 10 }, theme: 'system' });
    expect(settings.planner).toEqual(before);
    expect(await planner()).toEqual(before);
  });
});

describe('a settings.json edited by hand', () => {
  const settingsPath = path.join(process.env.OOTP_FO_DATA_DIR!, 'settings.json');

  it('keeps every stored field the PUT would accept and puts each one it would refuse back to its default', async () => {
    const saved = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : null;
    try {
      const stored = saved ? JSON.parse(saved) : {};
      stored.planner = {
        targets: { fullSeason: { min: 30, max: 33 }, complex: { min: 50, max: 40 }, dsl: { min: 10, max: 45 } },
        serviceCaps: { aaa: null, aa: 6, 'high-a': 0, 'single-a': '4', complex: 3.5, dsl: 2, rookie: 3 },
        icMaxAge: 30,
        icSize: 75,
      };
      fs.writeFileSync(settingsPath, JSON.stringify(stored));
      expect(await planner()).toEqual({
        targets: { fullSeason: { min: 30, max: 33 }, complex: DEFAULT_PLANNER.targets.complex, dsl: DEFAULT_PLANNER.targets.dsl },
        serviceCaps: { ...DEFAULT_PLANNER.serviceCaps, aa: 6, dsl: 2 },
        icMaxAge: DEFAULT_PLANNER.icMaxAge,
        icSize: 75,
      });
    } finally {
      if (saved === null) fs.rmSync(settingsPath, { force: true });
      else fs.writeFileSync(settingsPath, saved);
    }
  });
});

describe('the plan after a PUT', () => {
  const plan = async (): Promise<Plan> => (await request(`/api/plan/${PLAN.org}?show=all`)) as Plan;
  const level = (p: Plan, rung: string) => p.levels.find((l) => l.rung === rung)!;

  beforeAll(() => {
    seedPlannerOrg();
  });

  it('uses the new band and cap at once, without an import', async () => {
    const capKey = `forced:${PLAN_MEN.highACapped}:high-a:aa`;
    try {
      const before = await plan();
      expect(level(before, 'aa').target).toEqual({ min: 28, max: 35 });
      expect(level(before, 'high-a').serviceCap).toBe(5);
      // His fifth year at High-A is his last under a cap of 5
      expect(before.moves.some((m) => m.key === capKey)).toBe(true);

      const { status } = await put('/planner-settings', { targets: { fullSeason: { min: 30, max: 32 } }, serviceCaps: { 'high-a': 6 } });
      expect(status).toBe(200);

      // The cached plan was dropped: the next one is drawn against the new settings
      const after = await plan();
      for (const rung of ['aaa', 'aa', 'high-a', 'single-a']) expect(level(after, rung).target, rung).toEqual({ min: 30, max: 32 });
      expect(level(after, 'high-a').serviceCap).toBe(6);
      // Under a cap of 6 his fifth year is not his last, so the cap no longer moves him
      expect(after.moves.some((m) => m.key === capKey)).toBe(false);
      expect(after.moves.map((m) => m.key)).not.toEqual(before.moves.map((m) => m.key));
    } finally {
      await put('/planner-settings', DEFAULT_PLANNER);
    }
    // And back: the defaults give the first plan again
    const restored = await plan();
    expect(level(restored, 'aa').target).toEqual({ min: 28, max: 35 });
    expect(restored.moves.some((m) => m.key === capKey)).toBe(true);
  });
});
