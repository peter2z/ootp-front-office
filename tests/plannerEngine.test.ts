import { beforeAll, describe, expect, it } from 'vitest';
// The planner first: history.ts reaches dashboard.ts for DATE_KEY, dashboard.ts
// reaches the planner, and the planner's decision store reaches history.ts —
// a ring that only loads when it is entered here and not at history.ts
import { clearPlanCache, computePlan, planStandingOf, sentencesOf } from '../server/planner.js';
import { db } from '../server/db.js';
import { currentSaveName, historyDb, leagueGameDate } from '../server/history.js';
import { rosterCrunch } from '../server/rosterops.js';
import { planMoveCounts } from '../server/dashboard.js';
import { clearStatCaches, leagueBaseline } from '../server/stats.js';
import type { Plan } from '../server/planTypes.js';
import request, { post } from './request.js';
import { CLUBS, PLAN, PLAN_MEN, battingLine, inScenario, seedPlannerOrg } from './plannerFixture.js';

/**
 * The engine's own contract, below the rule and balance tests: what every
 * plan must hold whatever the org looks like. It is deterministic (two runs
 * are byte-identical, and still after a decision), it is quick, no card
 * carries an empty reason, the ladder is read from the leagues' reputation,
 * the dates come from the right rows, and the two readers of Rule 5 — the
 * 40-man page and the planner — count the same men.
 */

const plan = async (show = 'all'): Promise<Plan> => (await request(`/api/plan/${PLAN.org}?show=${show}`)) as Plan;

beforeAll(async () => {
  await request('/api/status');
  seedPlannerOrg();
  historyDb.prepare(`DELETE FROM plan_decisions`).run();
});

describe('the ladder', () => {
  it('reads every rung from the leagues\' reputation, the two DSL clubs sharing one, the complex pool last', async () => {
    const p = await plan();
    expect(p.levels.map((l) => l.rung)).toEqual(['mlb', 'aaa', 'aa', 'high-a', 'single-a', 'complex', 'dsl', 'ic']);
    expect(p.levels.map((l) => l.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const dsl = p.levels.find((l) => l.rung === 'dsl')!;
    expect(dsl.teamIds).toEqual([PLAN.teams.dslA, PLAN.teams.dslB]);
    expect(dsl.label).toBe('DSL Planner Uno / DSL Planner Dos');
    expect(p.levels.find((l) => l.rung === 'high-a')!.teamIds).toEqual([PLAN.teams.highA]);
    expect(p.levels.find((l) => l.rung === 'single-a')!.teamIds).toEqual([PLAN.teams.singleA]);
    expect(p.levels.find((l) => l.rung === 'ic')!.now.roster).toBe(PLAN.icSize);
    expect(p.warnings).toEqual([]);
  });

  it('carries the caps and bands from Settings by rung key', async () => {
    const p = await plan();
    expect(p.levels.map((l) => [l.rung, l.serviceCap])).toEqual([
      ['mlb', null], ['aaa', null], ['aa', null], ['high-a', 5], ['single-a', 4], ['complex', 3], ['dsl', 4], ['ic', null],
    ]);
    expect(p.levels.find((l) => l.rung === 'aa')!.target).toEqual({ min: 28, max: 35 });
    expect(p.levels.find((l) => l.rung === 'dsl')!.target).toEqual({ min: 30, max: 45 });
  });

  it('dates the plan from the big league and the season ends from the games table by DATE_KEY', async () => {
    const p = await plan();
    expect(p.gameDate).toBe(PLAN.gameDate);
    expect(p.season).toBe(PLAN.season);
    const forced = p.moves.find((m) => m.player.player_id === PLAN_MEN.highACapped)!;
    // "2030-9-9" sorts after "2030-9-10" as text; the engine must not fall for it
    expect(forced.deadline?.date).toBe(PLAN.seasonEnd.highA);
    expect(forced.deadline?.daysAway).toBe(101);
    const protect = p.moves.find((m) => m.kind === 'protect')!;
    // The minor-league rows carry a stale 2028 Rule 5 date; only the MLB row counts
    expect(protect.deadline?.date).toBe(PLAN.dates.rule5);
  });
});

describe('determinism and cost', () => {
  it('gives byte-identical JSON twice, and again after a decision overlay', async () => {
    const a = JSON.stringify(await plan());
    clearPlanCache();
    const b = JSON.stringify(await plan());
    expect(a).toBe(b);
    const key = (await plan()).moves[0].key;
    await post(`/api/plan/${PLAN.org}/decisions`, { moveKey: key, decision: 'accepted' });
    const c = JSON.stringify(await plan());
    clearPlanCache();
    const d = JSON.stringify(await plan());
    expect(c).toBe(d);
    expect(c).not.toBe(a);
    historyDb.prepare(`DELETE FROM plan_decisions`).run();
  });

  it('computes cold under a second and warm under a millisecond or so', () => {
    clearPlanCache();
    const t0 = performance.now();
    computePlan(PLAN.org);
    const cold = performance.now() - t0;
    const t1 = performance.now();
    computePlan(PLAN.org);
    const warm = performance.now() - t1;
    expect(cold).toBeLessThan(1000);
    expect(warm).toBeLessThan(50);
  });

  it('never prints a card with an empty reasons list, and keys are kind:player:from:to', async () => {
    const p = await plan();
    expect(p.moves.length).toBeGreaterThan(0);
    for (const m of p.moves) {
      expect(m.reasons.length, m.key).toBeGreaterThan(0);
      // The 40-man question is about the man, whatever club he is on, and keeps the
      // protection's key while a hold stands in for it
      expect(m.key).toBe(m.to.rung === '40man'
        ? `protect:${m.player.player_id}:40man`
        : `${m.kind}:${m.player.player_id}:${m.from.rung}:${m.to.rung}`);
      expect(m.ootpSteps.length).toBeGreaterThan(0);
    }
    expect(new Set(p.moves.map((m) => m.key)).size).toBe(p.moves.length);
  });
});

describe('what the two Rule 5 readers agree on', () => {
  it('counts the same eligible men as the 40-man page', async () => {
    const crunch = rosterCrunch(PLAN.org)!;
    const p = await plan();
    const eligible = p.releaseOrTrade.filter((r) => r.modifiers.includes('rule5-exposed')).length;
    expect(eligible).toBeLessThanOrEqual(crunch.counts.rule5Eligible);
    // §11: the planner's own eligible count, read with rule5Eligible() over the
    // same status rows and 40-man, equals the page's — not merely bounds it
    expect(crunch.counts.rule5Eligible).toBeGreaterThan(0);
    expect(p.counts.rule5Eligible).toBe(crunch.counts.rule5Eligible);
    // And every man the page lists is a man the planner has on a level
    const planned = new Set(p.levels.flatMap((l) => l.roster.map((r) => r.player_id)));
    for (const c of crunch.rule5Eligible) expect(planned.has(c.player_id), c.name).toBe(true);
    // Every man the planner protects is one the page lists as eligible
    for (const m of p.moves.filter((x) => x.kind === 'protect')) {
      expect(crunch.rule5Eligible.some((c) => c.player_id === m.player.player_id), m.player.name).toBe(true);
    }
    // The grade-only gate passer on the page is protected by the planner too
    expect(p.moves.some((m) => m.kind === 'protect' && m.player.player_id === PLAN_MEN.rule5Grade)).toBe(true);
    expect(p.moves.some((m) => m.kind === 'protect' && m.player.player_id === PLAN_MEN.rule5Depth)).toBe(false);
  });
});

describe('the baseline seed', () => {
  it('seeds exactly what leagueBaseline() would compute, so the fallback cannot drift', async () => {
    // The fixture has no (league_id, year) index, so the plan took the grouped path
    clearStatCaches();
    clearPlanCache();
    computePlan(PLAN.org);
    const seeded = leagueBaseline(PLAN.leagues.aa, PLAN.season - 1, 3);
    clearStatCaches();
    const fresh = leagueBaseline(PLAN.leagues.aa, PLAN.season - 1, 3);
    expect(seeded).not.toBe(fresh);
    for (const k of ['lgOBP', 'lgSLG', 'lgWOBA', 'lgRperPA', 'lgERA', 'lgFIPRaw'] as const) {
      expect(seeded[k], k).toBeCloseTo(fresh[k], 12);
    }
  });
});

describe('the routes', () => {
  it('404s an unknown org and 400s a key outside the plan', async () => {
    const missing = await fetch(`http://127.0.0.1:${process.env.OOTP_FO_PORT}/api/plan/424242`);
    expect(missing.status).toBe(404);
    const bad = await fetch(`http://127.0.0.1:${process.env.OOTP_FO_PORT}/api/plan/${PLAN.org}/decisions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ moveKey: 'promote:1:aa:aaa', decision: 'accepted' }),
    });
    expect(bad.status).toBe(400);
  });

  it('accepts, lists, hides a dismissal under show=open and reopens', async () => {
    const p = await plan();
    const key = p.moves[1].key;
    const { decision } = await post(`/api/plan/${PLAN.org}/decisions`, { moveKey: key, decision: 'dismissed' });
    expect(decision.state).toBe('dismissed');
    expect((await plan('open')).moves.some((m) => m.key === key)).toBe(false);
    expect((await plan('dismissed')).moves.map((m) => m.key)).toEqual([key]);
    expect((await plan('all')).counts.dismissed).toBe(1);
    const listed = await request(`/api/plan/${PLAN.org}/decisions`);
    expect(listed.decisions.map((d: { moveKey: string }) => d.moveKey)).toEqual([key]);
    const res = await fetch(`http://127.0.0.1:${process.env.OOTP_FO_PORT}/api/plan/${PLAN.org}/decisions/${encodeURIComponent(key)}`, { method: 'DELETE' });
    expect((await res.json()).ok).toBe(true);
    expect((await plan('open')).moves.some((m) => m.key === key)).toBe(true);
  });

  it('reads where a man stands for the verifier', async () => {
    const s = planStandingOf(PLAN.org, PLAN_MEN.highACapped)!;
    // The club in the words the plan's own moves use, so "still on X" can be told from "went elsewhere"
    const highA = computePlan(PLAN.org).levels.find((l) => l.rung === 'high-a')!.label;
    expect(s).toEqual({
      rung: 'high-a', inOrg: true, position: 6, roleClass: null, on40: false, il60: false, rostered: true, teamId: PLAN.teams.highA,
      teamLabel: highA,
    });
    const capped = computePlan(PLAN.org).moves.find((m) => m.player.player_id === PLAN_MEN.highACapped)!;
    expect(capped.from.label).toBe(s.teamLabel);
    const ic = planStandingOf(PLAN.org, PLAN_MEN.icNineteen)!;
    expect(ic.rung).toBe('ic');
    const icMove = computePlan(PLAN.org).moves.find((m) => m.player.player_id === PLAN_MEN.icNineteen);
    expect(ic.teamLabel).toBe(icMove?.from.label ?? 'International complex');
    // Inside a scenario, so a failed expectation cannot leave him outside the org for a later case
    await inScenario(() => {
      db.prepare(`UPDATE players SET organization_id = 1 WHERE player_id = ?`).run(PLAN_MEN.surplus[0]);
    }, () => {
      expect(planStandingOf(PLAN.org, PLAN_MEN.surplus[0])?.inOrg).toBe(false);
    });
    expect(planStandingOf(PLAN.org, PLAN_MEN.surplus[0])?.inOrg).toBe(true);
  });
});

describe('the decisions laid over the plan', () => {
  /** Writes what an import would have stamped on a stored decision. */
  const stamp = (key: string, set: { outcome: string; verified: string; seen?: string | null; moveKey?: string; fromRung?: string }) =>
    historyDb
      .prepare(
        `UPDATE plan_decisions SET outcome = ?, verified_game_date = ?, seen_label = ?, move_key = ?, from_rung = COALESCE(?, from_rung)
         WHERE save_name = ? AND org_id = ? AND move_key = ?`
      )
      .run(set.outcome, set.verified, set.seen ?? null, set.moveKey ?? key, set.fromRung ?? null, currentSaveName(), PLAN.org, key);
  const clear = () => historyDb.prepare(`DELETE FROM plan_decisions`).run();

  it('takes a dismissed trade off the release-or-trade list and the deadlines strip under every filter', async () => {
    clear();
    const before = await plan();
    const trade = before.moves.find((m) => m.kind === 'trade' && before.deadlines.some((d) => d.moveKey === m.key))!;
    expect(trade, 'a trade with a deadline').toBeDefined();
    expect(before.releaseOrTrade.map((r) => r.player_id)).toContain(trade.player.player_id);
    await post(`/api/plan/${PLAN.org}/decisions`, { moveKey: trade.key, decision: 'dismissed' });
    for (const show of ['open', 'all', 'dismissed', 'accepted']) {
      const p = await plan(show);
      expect(p.releaseOrTrade.map((r) => r.player_id), show).not.toContain(trade.player.player_id);
      expect(p.releaseOrTrade.map((r) => r.rank), show).toEqual(p.releaseOrTrade.map((_, i) => i + 1));
      expect(p.deadlines.map((d) => d.moveKey), show).not.toContain(trade.key);
      expect(p.moves.some((m) => m.key === trade.key), show).toBe(show === 'dismissed' || show === 'all');
    }
    clear();
  });

  it('shows an accepted move under accepted only, never under open, with where the import found him', async () => {
    clear();
    const p = await plan();
    const promote = p.moves.find((m) => m.kind === 'promote')!;
    await post(`/api/plan/${PLAN.org}/decisions`, { moveKey: promote.key, decision: 'accepted' });
    expect((await plan('open')).moves.some((m) => m.key === promote.key)).toBe(false);
    stamp(promote.key, { outcome: 'changed', verified: '2030-8-4', seen: 'Planner Highs' });
    const accepted = (await plan('accepted')).moves.find((m) => m.key === promote.key)!;
    expect(accepted.decision).toEqual({
      state: 'accepted', gameDate: leagueGameDate(), outcome: 'changed', verifiedGameDate: '2030-8-4', seenAt: 'Planner Highs',
      deadlineDate: promote.deadline?.date ?? null,
    });
    // An open move has nowhere to have been seen
    expect((await plan('open')).moves.every((m) => m.decision.seenAt === null && m.decision.state === 'open')).toBe(true);
    clear();
  });

  it('keeps showing an accepted move the plan no longer produces, with the outcome the import saw', async () => {
    clear();
    const p = await plan();
    const promote = p.moves.find((m) => m.kind === 'promote' && m.from.rung === 'aa')!;
    await post(`/api/plan/${PLAN.org}/decisions`, { moveKey: promote.key, decision: 'accepted' });
    // As if the import had seen him at the target club: a plan drawn from there
    // no longer produces the key, since the move starts where he stands
    const gone = `promote:${promote.player.player_id}:high-a:aa`;
    stamp(promote.key, { outcome: 'done', verified: '2030-8-4', seen: promote.to.label, moveKey: gone, fromRung: 'high-a' });
    expect(p.moves.some((m) => m.key === gone)).toBe(false);
    for (const show of ['accepted', 'all']) {
      const shown = await plan(show);
      const m = shown.moves.find((x) => x.key === gone)!;
      expect(m, show).toBeDefined();
      expect(m.decision).toEqual({
        state: 'accepted', gameDate: leagueGameDate(), outcome: 'done', verifiedGameDate: '2030-8-4', seenAt: promote.to.label,
        deadlineDate: promote.deadline?.date ?? null,
      });
      expect(m.player).toMatchObject({ player_id: promote.player.player_id, name: promote.player.name });
      expect(m.reasons).toEqual([`Accepted on ${leagueGameDate()} and seen done in the 2030-8-4 export, on ${promote.to.label}.`]);
      expect(shown.counts.done, show).toBe(1);
      // A settled move is history: it never reaches the strip or the list
      expect(shown.deadlines.map((d) => d.moveKey)).not.toContain(gone);
    }
    expect((await plan('open')).moves.some((m) => m.key === gone)).toBe(false);
    clear();
  });

  it('shows a recommendation again as open when its earlier acceptance was done or its dismissal went moot', async () => {
    clear();
    const p = await plan();
    const [first, second] = p.moves.filter((m) => m.kind === 'promote');
    await post(`/api/plan/${PLAN.org}/decisions`, { moveKey: first.key, decision: 'accepted' });
    await post(`/api/plan/${PLAN.org}/decisions`, { moveKey: second.key, decision: 'dismissed' });
    // He was promoted and seen there, then sent back; the other's dismissal lapsed when the plan stopped listing it
    stamp(first.key, { outcome: 'done', verified: '2030-8-4', seen: first.to.label });
    stamp(second.key, { outcome: 'moot', verified: '2030-7-1' });
    const open = await plan('open');
    const again = open.moves.find((m) => m.key === first.key)!;
    expect(again, 'the done move, produced again').toBeDefined();
    expect(again.decision.state).toBe('open');
    expect(again.reasons.at(-1)).toBe('Recommended again after it was done on 2030-8-4: he is back where the move started.');
    const back = open.moves.find((m) => m.key === second.key)!;
    expect(back, 'the moot dismissal, produced again').toBeDefined();
    expect(back.decision.state).toBe('open');
    expect(back.reasons.at(-1)).toBe(`Recommended again: it was dismissed on ${leagueGameDate()}, and the plan stopped listing it by the 2030-7-1 export.`);
    expect(open.counts.open).toBe(open.moves.length);
    expect((await plan('dismissed')).moves).toEqual([]);
    clear();
  });

  it('counts a recommendation made again on the dashboard chip too', async () => {
    clear();
    const p = await plan();
    const protect = p.moves.find((m) => m.kind === 'protect' && m.horizon === 'now')!;
    const before = planMoveCounts(PLAN.org)!.total;
    await post(`/api/plan/${PLAN.org}/decisions`, { moveKey: protect.key, decision: 'accepted' });
    expect(planMoveCounts(PLAN.org)!.total).toBe(before - 1);
    stamp(protect.key, { outcome: 'done', verified: '2030-8-4', seen: 'Planner Nine' });
    expect(planMoveCounts(PLAN.org)!.total).toBe(before);
    clear();
  });
});

describe('the production sentence', () => {
  it('names a line under 60 PA this season as a look, without its figures', async () => {
    const id = PLAN_MEN.highACapped;
    await inScenario(() => {
      db.prepare(
        `UPDATE players_career_batting_stats SET pa = 30, ab = 27, h = 9, d = 2, t = 0, hr = 1, bb = 3, k = 6
         WHERE player_id = ? AND year = ?`
      ).run(id, PLAN.season);
    }, async () => {
      const card = (await plan()).moves.find((m) => m.player.player_id === id && m.kind === 'forced')!;
      const sentence = card.reasons.find((r) => r.startsWith('Hitting'))!;
      expect(sentence).toBeDefined();
      expect(sentence).not.toMatch(/in 30 PA at High-A this year/);
      expect(sentence).toContain('and only a 30-PA look at High-A this year, short of the 60 PA a line this season needs');
      // The seasons before are quoted in full
      expect(sentence).toMatch(/^Hitting \.\d{3}\/\.\d{3}\/\.\d{3} with \d+ HR in \d+ PA at Single-A last year/);
    });
  });

  it('still quotes a line of 60 PA or more this season', async () => {
    const card = (await plan()).moves.find((m) => m.player.player_id === PLAN_MEN.highACapped && m.kind === 'forced')!;
    expect(card.reasons.find((r) => r.startsWith('Hitting'))).toMatch(/^Hitting \.\d{3}\/\.\d{3}\/\.\d{3} with \d+ HR in 158 PA at High-A this year/);
  });
});

describe('each sentence once', () => {
  /** Every card's sentences that it says more than once, as "key: sentence". */
  const repeats = (p: Plan): string[] => p.moves.flatMap((m) => {
    const seen = new Set<string>();
    const twice: string[] = [];
    for (const r of m.reasons) {
      for (const s of sentencesOf(r)) {
        if (seen.has(s)) twice.push(`${m.key}: ${s}`);
        seen.add(s);
      }
    }
    return twice;
  });

  it('splits a reason at its full stops, never at an initial or inside a figure', () => {
    expect(sentencesOf('Hitting .250 in 158 PA at the DSL. Grades 40 with a 45 ceiling (fit 0.86).  Next IL. On to A. J. Smith.')).toEqual([
      'Hitting .250 in 158 PA at the DSL.', 'Grades 40 with a 45 ceiling (fit 0.86).', 'Next IL.', 'On to A. J. Smith.',
    ]);
  });

  it('prints no card that says the same sentence twice', async () => {
    const p = await plan();
    expect(p.moves.length).toBeGreaterThan(0);
    expect(repeats(p)).toEqual([]);
  });

  it('folds a poor-season hold into the protection without saying his line and his grade twice', async () => {
    // The Double-A man worth a 40-man place, graded up so Triple-A fits him, with a season so bad it blocks the promotion
    const id = PLAN_MEN.rule5Grade;
    await inScenario(() => {
      db.prepare(`UPDATE players_value SET oa = 50, pot = 55, oa_rating = 50, pot_rating = 55 WHERE player_id = ?`).run(id);
      const line = battingLine(20, CLUBS.aa.oa, 158);
      db.prepare(
        `UPDATE players_career_batting_stats SET pa = @pa, ab = @ab, h = @h, d = @d, t = @t, hr = @hr, bb = @bb, k = @k, hp = @hp, sf = @sf
         WHERE player_id = @id AND year = @year`
      ).run({ ...line, id, year: PLAN.season });
    }, async () => {
      const p = await plan();
      const cards = p.moves.filter((m) => m.player.player_id === id);
      expect(cards.map((m) => m.key)).toEqual([`protect:${id}:40man`]);
      const [card] = cards;
      expect(card.kind).toBe('protect');
      // The hold's sentences rode in, and his line and grade, which the protection says too, are said once
      expect(card.reasons.some((r) => r.startsWith('Stays at Planner Doubles: the season verdict is poor'))).toBe(true);
      expect(card.reasons.filter((r) => r.startsWith('Hitting')).length).toBe(1);
      expect(card.reasons.filter((r) => r.startsWith('Grades 50 with a 55 ceiling')).length).toBe(1);
      expect(repeats(p)).toEqual([]);
    });
  });
});

describe('the SP/RP value tie-break, on the org', () => {
  /** The org's relievers and closers: the arms the ratings class RP without help. */
  const relievers = (): number[] =>
    (db.prepare(`SELECT player_id FROM players WHERE organization_id = ? AND position = 1 AND role IN (12, 13) AND player_id < ?`)
      .all(PLAN.org, PLAN.spareFrom) as Array<{ player_id: number }>).map((r) => r.player_id);
  /** Sets his OOTP SP value over his RP value to a ratio, keeping the SP value. */
  const ratio = (id: number, r: number): void => {
    db.prepare(`UPDATE players_value SET overall_rp = overall_sp / ? WHERE player_id = ?`).run(r, id);
  };
  const stamina = (id: number, v: number): void => {
    db.prepare(`UPDATE players_pitching SET pitching_ratings_misc_stamina = ? WHERE player_id = ?`).run(v, id);
  };
  /** His class where the plan has him: the row at the level he stays at or arrives at. */
  const classOf = (p: Plan, id: number): string | null => {
    for (const l of p.levels) {
      const r = l.roster.find((x) => x.player_id === id && x.status !== 'leaves');
      if (r) return r.utility;
    }
    return null;
  };
  // Double-A starters: two put on the line between the classes (stamina 47 with four pitches), one left a starter
  const [lineSp, lineRp, starter] = [98143, 98144, 98145];
  const reliever = 98148;
  // Relievers at 1.1 against the starters' 1.3: the two medians the lean is read against
  const leaning = (): void => {
    for (const id of relievers()) ratio(id, 1.1);
    stamina(lineSp, 47);
    stamina(lineRp, 47);
    ratio(lineRp, 1.12);
    ratio(starter, 1.1);
    ratio(reliever, 1.3);
  };

  it('classes a man on the line by the median his ratio sits nearer, and nobody the ratings settle', async () => {
    await inScenario(leaning, async () => {
      const p = await plan();
      expect(classOf(p, lineSp)).toBe('SP');
      expect(classOf(p, lineRp)).toBe('RP');
      // A starter's ratings with a reliever's ratio, and the other way round: the ratio never moves them
      expect(classOf(p, starter)).toBe('SP');
      expect(classOf(p, reliever)).toBe('RP');
    });
  });

  it('leaves a man on the line a swing man when the ratio cannot lean: the same ratio everywhere, or no figures', async () => {
    // The fixture's own values: every arm at 1.3, so the two medians are equal
    await inScenario(() => { stamina(lineSp, 47); stamina(lineRp, 47); }, async () => {
      const p = await plan();
      expect(classOf(p, lineSp)).toBe('swing');
      expect(classOf(p, lineRp)).toBe('swing');
    });
    // The leaning save with the SP and RP values gone from the export
    await inScenario(() => {
      leaning();
      db.prepare(`UPDATE players_value SET overall_sp = NULL, overall_rp = NULL`).run();
    }, async () => {
      const p = await plan();
      expect(classOf(p, lineSp)).toBe('swing');
      expect(classOf(p, lineRp)).toBe('swing');
      expect(classOf(p, starter)).toBe('SP');
      expect(classOf(p, reliever)).toBe('RP');
    });
  });
});

describe('the Today counts', () => {
  it('counts a pitcher in the class he has at his club today, and in the class he will have where the plan sends him', async () => {
    // A Complex starter on stamina alone, one rated pitch: SP at the Complex, RP from Single-A up.
    // Graded well past the Single-A median so the plan promotes him
    const id = 98319;
    await inScenario(() => {
      db.prepare(
        `UPDATE players_pitching SET pitching_ratings_pitches_slider = 0, pitching_ratings_pitches_changeup = 0,
                pitching_ratings_pitches_curveball = 0 WHERE player_id = ?`
      ).run(id);
      db.prepare(`UPDATE players_value SET oa = 45, pot = 60, oa_rating = 45, pot_rating = 60 WHERE player_id = ?`).run(id);
    }, async () => {
      const p = await plan();
      const [card] = p.moves.filter((m) => m.player.player_id === id);
      expect(card.to.rung).toBe('single-a');
      expect(card.horizon).toBe('now');
      const complex = p.levels.find((l) => l.rung === 'complex')!;
      const singleA = p.levels.find((l) => l.rung === 'single-a')!;
      // Today he is one of the Complex's seven starters, and his row there says so
      expect(complex.roster.find((r) => r.player_id === id)).toMatchObject({ status: 'leaves', utility: 'SP' });
      expect(complex.now.groups).toMatchObject({ SP: 7, RP: 10 });
      // At Single-A, without a third pitch, he is a reliever: in its planned groups and on his row there
      expect(singleA.roster.find((r) => r.player_id === id)).toMatchObject({ status: 'arrives', utility: 'RP' });
      const arms = singleA.roster.filter((r) => r.status !== 'leaves' && !r.frozen && (r.positionName === 'LHP' || r.positionName === 'RHP'));
      expect(singleA.planned.groups.RP).toBe(arms.filter((r) => r.utility === 'RP').length);
      expect(singleA.planned.groups.SP).toBe(arms.filter((r) => r.utility !== 'RP').length);
    });
  });
});
