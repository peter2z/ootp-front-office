import { beforeAll, describe, expect, it } from 'vitest';
// The planner first: history.ts reaches dashboard.ts for DATE_KEY, dashboard.ts
// reaches the planner, and the planner's decision store reaches history.ts —
// a ring that only loads when it is entered here and not at history.ts
import '../server/planner.js';
import { db } from '../server/db.js';
import { historyDb } from '../server/history.js';
import type { Plan, PlanMove } from '../server/planTypes.js';
import request, { post } from './request.js';
import {
  CLUBS, PLAN, PLAN_MEN, addPlannerMan, battingLine, inScenario, removePlannerMan, seedPlannerOrg,
} from './plannerFixture.js';

/**
 * The lines the rule tests leave loose: each case here sits on one side of a
 * boundary the engine draws, close enough that moving the boundary, or
 * dropping the condition that draws it, changes what the plan says. The 0.5
 * fit that dates a last-season move today, the SP/RP lean in the Today
 * counts, the two conditions under which a trade frees a 40-man place, the
 * room half of "room or a need" for a man the cap passes over a level, and
 * the age that decides between surplus men of the same fit.
 */

const plan = async (): Promise<Plan> => (await request(`/api/plan/${PLAN.org}?show=all`)) as Plan;
const movesOf = (p: Plan, id: number): PlanMove[] => p.moves.filter((m) => m.player.player_id === id);
const level = (p: Plan, rung: string) => p.levels.find((l) => l.rung === rung)!;
const row = (p: Plan, rung: string, id: number) => level(p, rung).roster.find((r) => r.player_id === id)!;
const decide = (moveKey: string, decision: string) => post(`/api/plan/${PLAN.org}/decisions`, { moveKey, decision });

/** Regrades a man: OOTP's exact and rounded grades and his overall value together. */
function regrade(id: number, oa: number, pot: number): void {
  db.prepare(
    `UPDATE players_value SET oa = ?, pot = ?, oa_rating = ?, pot_rating = ?, overall_value = ?, talent_value = ? WHERE player_id = ?`
  ).run(oa, pot, Math.round(oa / 5) * 5, Math.round(pot / 5) * 5, oa * 20, pot * 20, id);
}

/** Replaces a position player's seasons with lines at the given grade against each club's median. */
function rewriteBatting(id: number, oa: number, clubs: Array<[year: number, club: keyof typeof CLUBS, pa: number]>): void {
  db.prepare(`DELETE FROM players_career_batting_stats WHERE player_id = ?`).run(id);
  const insert = db.prepare(
    `INSERT INTO players_career_batting_stats
       (player_id, year, team_id, league_id, level_id, split_id, pa, ab, h, d, t, hr, bb, ibb, hp, sf, k, sb, cs, r, rbi, war)
     VALUES (@id, @year, @team, @league, @level, 1, @pa, @ab, @h, @d, @t, @hr, @bb, @ibb, @hp, @sf, @k, @sb, @cs, @r, @rbi, @war)`
  );
  for (const [year, club, pa] of clubs) {
    const c = CLUBS[club];
    insert.run({ id, year, team: PLAN.teams[club], league: c.league, level: c.level, ...battingLine(oa, c.oa, pa) });
  }
}

/** Gives a man a 40-man place: the flag and the big club's list 3. */
function onForty(id: number): void {
  db.prepare(`UPDATE players_roster_status SET is_on_secondary = 1 WHERE player_id = ?`).run(id);
  db.prepare(`INSERT OR IGNORE INTO team_roster VALUES (?, ?, 3)`).run(PLAN.teams.mlb, id);
}

beforeAll(async () => {
  await request('/api/status');
  seedPlannerOrg();
  historyDb.prepare(`DELETE FROM plan_decisions`).run();
});

describe('the 0.5 line of the last-season move', () => {
  const id = PLAN_MEN.singleACapped;
  const earned = 'He has earned the move now, so it is dated today rather than at the deadline.';
  /**
   * His grade, with his lines held at those of a 38.5 so that only the grade
   * moves his fit at High-A: a tenth of a point of fit for each point of
   * grade, so a grade a few hundredths apart lands on either side of 0.5.
   */
  const graded = (oa: number) => (): void => {
    regrade(id, oa, 40);
    rewriteBatting(id, 38.5, [[PLAN.season, 'singleA', 158], [PLAN.season - 1, 'singleA', 450], [PLAN.season - 2, 'complex', 400]]);
  };
  /**
   * The same man a year short of the cap, with two more Single-A arms so his
   * club can let him go: he is promoted on merit and arrives on the High-A
   * roster, whose row gives the fit a move that waits for the winter never
   * shows. Nothing here touches the High-A medians the fit is read against.
   */
  const yearShort = (oa: number) => (): void => {
    graded(oa)();
    db.prepare(`UPDATE players_roster_status SET pro_service_years = 3 WHERE player_id = ?`).run(id);
    for (const k of [0, 1]) addPlannerMan({ id: PLAN.spareFrom + k, club: 'singleA', position: 1, role: 12, age: 22, oa: 32, pot: 45, proYears: 1 });
  };
  const forcedOf = (p: Plan): PlanMove => movesOf(p, id).find((m) => m.kind === 'forced')!;

  it('waits for the deadline at a fit just under 0.5', async () => {
    // A 38.24: a fit of 0.49 at High-A, so a line drawn at 0.49 would date the move today
    await inScenario(yearShort(38.24), async () => {
      const p = await plan();
      expect(movesOf(p, id).map((m) => m.key)).toContain(`promote:${id}:single-a:high-a`);
      const fit = row(p, 'high-a', id).fit!;
      expect(fit).toBeGreaterThanOrEqual(0.49);
      expect(fit).toBeLessThan(0.5);
    });
    await inScenario(graded(38.24), async () => {
      const p = await plan();
      const m = forcedOf(p);
      expect(m.horizon).toBe('offseason');
      expect(m.reasons).not.toContain(earned);
      expect(m.deadline).toMatchObject({ kind: 'service-cap', date: PLAN.seasonEnd.singleA });
      // He plays the season out at Single-A
      expect(row(p, 'single-a', id).status).toBe('stays');
      expect(level(p, 'high-a').roster.some((r) => r.player_id === id)).toBe(false);
    });
  });

  it('moves him today at a fit just over 0.5', async () => {
    // A 38.5: a fit of 0.52 at High-A, so a line drawn anywhere above 0.52 would make him wait
    await inScenario(graded(38.5), async () => {
      const p = await plan();
      const m = forcedOf(p);
      expect(m.horizon).toBe('now');
      expect(m.reasons[1]).toBe(earned);
      expect(row(p, 'high-a', id).status).toBe('arrives');
      const fit = row(p, 'high-a', id).fit!;
      expect(fit).toBeGreaterThanOrEqual(0.5);
      expect(fit).toBeLessThanOrEqual(0.55);
    });
  });
});

describe('the SP/RP lean in the Today counts', () => {
  /** A Complex starter: four rated pitches and a starter's stamina as generated. */
  const arm = 98320;
  /** The org's relievers and closers, the arms the ratings class RP without help. */
  const relievers = (): number[] =>
    (db.prepare(`SELECT player_id FROM players WHERE organization_id = ? AND position = 1 AND role IN (12, 13) AND player_id < ?`)
      .all(PLAN.org, PLAN.spareFrom) as Array<{ player_id: number }>).map((r) => r.player_id);
  /** Sets his OOTP SP value over his RP value to a ratio, keeping the SP value. */
  const ratio = (id: number, r: number): void => {
    db.prepare(`UPDATE players_value SET overall_rp = overall_sp / ? WHERE player_id = ?`).run(r, id);
  };
  /** Stamina 47 with the pitches: in the swing cell, where the ratings alone cannot class him. */
  const onTheLine = (): void => {
    db.prepare(`UPDATE players_pitching SET pitching_ratings_misc_stamina = 47 WHERE player_id = ?`).run(arm);
  };

  it('counts a Complex arm in the swing cell who leans RP as a reliever at the Complex today, and his row says RP', async () => {
    // With every arm at the same ratio there is no lean: he stays a swing man, who counts with the starters
    await inScenario(onTheLine, async () => {
      const p = await plan();
      expect(level(p, 'complex').now.groups).toMatchObject({ SP: 7, RP: 10 });
      expect(row(p, 'complex', arm).utility).toBe('swing');
    });
    // The relievers at 1.1 against the starters' 1.3, and his own ratio at 1.12: he leans RP
    await inScenario(() => {
      onTheLine();
      for (const id of relievers()) ratio(id, 1.1);
      ratio(arm, 1.12);
    }, async () => {
      const p = await plan();
      const complex = level(p, 'complex');
      expect(complex.now.groups).toMatchObject({ SP: 6, RP: 11 });
      const r = row(p, 'complex', arm);
      expect(r.status).toBe('stays');
      expect(r.utility).toBe('RP');
    });
  });
});

describe('the places a trade frees on the 40-man', () => {
  /** The 40-man full, and the plan trading only the man out of options (Triples Man2) off it. */
  const fullWithOneTrade = (): void => {
    for (const id of [98080, 98081, 98082, 98083, 98084]) onForty(id);
    regrade(98068, 44, 47);
  };
  const tradeKey = `trade:${PLAN_MEN.farmOutOfOptions}:aaa:out`;
  const comesOff = { player_id: PLAN_MEN.farmOutOfOptions, name: 'Triples Man2', why: 'out of options' };

  it('counts no place for a trade dated on the Rule 5 date once the trade deadline has passed', async () => {
    await inScenario(() => {
      fullWithOneTrade();
      // The deadline a month before the game date: a trade can only be made in the winter now
      db.prepare(`UPDATE leagues SET trade_deadline_date = '2030-5-1' WHERE league_id = ?`).run(PLAN.leagues.mlb);
    }, async () => {
      const p = await plan();
      expect(p.org.fortyMan).toEqual({ count: 40, limit: 40 });
      const trade = movesOf(p, PLAN_MEN.farmOutOfOptions).find((m) => m.kind === 'trade')!;
      expect(trade.key).toBe(tradeKey);
      expect(trade.deadline).toMatchObject({ kind: 'rule5', date: PLAN.dates.rule5 });
      // The trade is not made before the draft, so his place is not counted as free: he is the man who comes off
      const [first] = p.moves.filter((m) => m.kind === 'protect');
      expect(first.fortyMan).toEqual({ count: 40, limit: 40, comesOff });
      expect(first.reasons[0]).toContain('The 40-man is full at 40 of 40, so Triples Man2 is the place (out of options);');
      expect(p.moves.some((m) => m.reasons.some((r) => r.includes('counting the place')))).toBe(false);
    });
  });

  it('frees no place for a trade the user dismissed', async () => {
    try {
      await inScenario(fullWithOneTrade, async () => {
        const before = await plan();
        expect(before.moves.filter((m) => m.kind === 'protect')[0].fortyMan).toEqual({ count: 39, limit: 40, comesOff: null });
        await decide(tradeKey, 'dismissed');
        const p = await plan();
        // The dismissed card is still made, but it no longer frees his place: he is the man who comes off
        const trade = p.moves.find((m) => m.key === tradeKey)!;
        expect(trade.decision.state).toBe('dismissed');
        const [first] = p.moves.filter((m) => m.kind === 'protect');
        expect(first.fortyMan).toEqual({ count: 40, limit: 40, comesOff });
        expect(first.reasons[0]).toContain('The 40-man is full at 40 of 40, so Triples Man2 is the place (out of options);');
        expect(p.moves.some((m) => m.reasons.some((r) => r.includes('counting the place')))).toBe(false);
      });
    } finally {
      historyDb.prepare(`DELETE FROM plan_decisions`).run();
    }
  });
});

describe('room or a need, for a man the cap passes over a level', () => {
  /** The DSL Dos infielder at 3 of 4 years: over the Complex cap of 3 by Opening Day, within Single-A's 4. */
  const dslThree = 98423;

  it('promotes a strong man to the first level that admits him when it has room, though it needs nobody', async () => {
    await inScenario(() => {
      // A ninth DSL Dos infielder, so his club can let him go
      addPlannerMan({ id: 98560, club: 'dslB', position: 4, age: 19, oa: 24, pot: 35, proYears: 1 });
      // Graded and hitting well past the Single-A median
      regrade(dslThree, 40, 52);
      rewriteBatting(dslThree, 40, [[PLAN.season - 1, 'dslB', 300], [PLAN.season - 2, 'dslB', 250]]);
    }, async () => {
      const p = await plan();
      // Single-A is short of nothing: every group at or over its minimum, and no need noted
      const singleA = level(p, 'single-a');
      expect(singleA.needs).toEqual([]);
      for (const s of singleA.structure) expect(s.tone, s.group).toBe('ok');
      const cards = movesOf(p, dslThree);
      expect(cards.map((m) => m.key)).toEqual([`promote:${dslThree}:dsl:single-a`]);
      const [up] = cards;
      // On merit, with the room named, and past the Complex its cap closes to him
      expect(up.reasons[0]).toMatch(/^Ready for Single-A: a fit of [0-9.]+ there, a strong one\.$/);
      expect(up.reasons).toContain(
        `The Complex (capped at 3) is closed to him: he will have 4 pro service years by Opening Day ${PLAN.season + 1}, so Single-A is the first level above the DSL that admits him.`
      );
      expect(up.reasons.some((r) => /^Planner Singles carries \d+ against a band of 28-35, so there is room without sending anyone down\.$/.test(r))).toBe(true);
      expect(row(p, 'single-a', dslThree).status).toBe('arrives');
    });
  });
});

describe('the age tie-break among surplus men of the same fit', () => {
  it('releases the oldest of three equal surplus men at a club held to its minimum, whatever their ids', async () => {
    // Three DSL relievers alike but for the age, with no lines: each reads -0.60 at the DSL,
    // since all three are past the two years under the median that the age term stops at
    const ages = [25, 26, 24];
    const ids = ages.map((_, k) => PLAN.spareFrom + k);
    await inScenario(() => {
      for (const [k, age] of ages.entries()) {
        addPlannerMan({ id: ids[k], club: 'dslA', position: 1, role: 12, age, oa: 25, pot: 25, proYears: 2, protectedYears: 5, lines: false });
      }
      // Five infielders gone, so DSL Uno's size has room for only one of them to go
      for (const id of [98365, 98366, 98367, 98369, 98370]) removePlannerMan(id);
    }, async () => {
      const p = await plan();
      for (const id of ids) expect(row(p, 'dsl', id).fit, String(id)).toBe(-0.6);
      // The 26-year-old has the middle id, so neither id order would pick him
      const oldest = ids[1];
      expect(movesOf(p, oldest).map((m) => m.kind)).toEqual(['release']);
      for (const id of [ids[0], ids[2]]) {
        const [m] = movesOf(p, id);
        expect(m.kind, String(id)).toBe('hold');
        expect(m.reasons[0]).toBe(
          'Kept for size: DSL Planner Uno stands at 30 against a minimum of 30, and releasing him would put it under the band with no level below to fill it.'
        );
      }
    });
  });
});
