import { beforeAll, describe, expect, it } from 'vitest';
// The planner first: history.ts reaches dashboard.ts for DATE_KEY, dashboard.ts
// reaches the planner, and the planner's decision store reaches history.ts —
// a ring that only loads when it is entered here and not at history.ts
import '../server/planner.js';
import { db } from '../server/db.js';
import { historyDb } from '../server/history.js';
import type { Plan, PlanMove } from '../server/planTypes.js';
import request from './request.js';
import {
  CLUBS, PLAN, PLAN_MEN, addPlannerMan, battingLine, inScenario, removePlannerMan, seedPlannerOrg,
} from './plannerFixture.js';

/**
 * The rules, through HTTP, on the synthetic org: service caps and the
 * two-steps-up case, the international complex age and room rules, the
 * injured list, the 40-man and the 60-day list, options, Rule 5 and its
 * dates, the big club's tie-break, men already on their way out, and a save
 * that exports no roster status. Every sentence asserted is the one the
 * design writes, because the sentence is what the user reads.
 */

const plan = async (): Promise<Plan> => (await request(`/api/plan/${PLAN.org}?show=all`)) as Plan;
const movesOf = (p: Plan, id: number): PlanMove[] => p.moves.filter((m) => m.player.player_id === id);
const level = (p: Plan, rung: string) => p.levels.find((l) => l.rung === rung)!;
const row = (p: Plan, rung: string, id: number) => level(p, rung).roster.find((r) => r.player_id === id)!;
const nextSeason = PLAN.season + 1;

/** Puts a minor leaguer on the injured list the way an export shows it: list 4, the flag, the days. */
function injure(id: number, team: number, days: number): void {
  db.prepare(`UPDATE players SET injury_is_injured = 1, injury_left = ? WHERE player_id = ?`).run(days, id);
  db.prepare(`UPDATE players_roster_status SET is_on_dl = 1 WHERE player_id = ?`).run(id);
  db.prepare(`DELETE FROM team_roster WHERE player_id = ? AND list_id = 2`).run(id);
  db.prepare(`INSERT INTO team_roster VALUES (?, ?, 4)`).run(team, id);
}

/** Gives a man a 40-man place: the flag and the big club's list 3. */
function onForty(id: number): void {
  db.prepare(`UPDATE players_roster_status SET is_on_secondary = 1 WHERE player_id = ?`).run(id);
  db.prepare(`INSERT OR IGNORE INTO team_roster VALUES (?, ?, 3)`).run(PLAN.teams.mlb, id);
}

/** Fills the 40-man from 35 with Triple-A starters nothing else touches: five to reach 40, or fewer beside another addition. */
const fillForty = (count = 5): void => { for (const id of [98080, 98081, 98082, 98083, 98084].slice(0, count)) onForty(id); };

/** The two Triple-A 40-man men the plan trades by the deadline, each freeing a place before the Rule 5 draft. */
const AAA_TRADED = { surplus: 98068, outOfOptions: PLAN_MEN.farmOutOfOptions } as const;

/**
 * Keeps both of them, so the plan frees no 40-man place of its own: the
 * surplus man graded up to depth, the man out of options given a no-trade
 * clause (he stays first in line to come off).
 */
function keepTripleATrades(): void {
  regrade(AAA_TRADED.surplus, 44, 47);
  db.prepare(`UPDATE players_contract SET no_trade = 1 WHERE player_id = ?`).run(AAA_TRADED.outOfOptions);
}

/** Regrades a man: OOTP's exact and rounded grades and his overall value together. */
function regrade(id: number, oa: number, pot: number): void {
  db.prepare(
    `UPDATE players_value SET oa = ?, pot = ?, oa_rating = ?, pot_rating = ?, overall_value = ?, talent_value = ? WHERE player_id = ?`
  ).run(oa, pot, Math.round(oa / 5) * 5, Math.round(pot / 5) * 5, oa * 20, pot * 20, id);
}

/** Replaces a position player's three seasons with lines at the given grade against each club's median. */
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

/** Saves planner settings through the route the Settings page uses; request.ts has no PUT. */
async function putSettings(body: unknown): Promise<void> {
  await request('/api/status'); // the server is up and its port known
  const res = await fetch(`http://127.0.0.1:${process.env.OOTP_FO_PORT}/api/planner-settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`planner-settings -> ${res.status} ${await res.text()}`);
}

beforeAll(async () => {
  await request('/api/status');
  seedPlannerOrg();
  historyDb.prepare(`DELETE FROM plan_decisions`).run();
});

describe('service caps', () => {
  it('forces a man in his last eligible season up, dated at his league\'s last game, in the design\'s words', async () => {
    const [m] = movesOf(await plan(), PLAN_MEN.singleACapped);
    expect(m.kind).toBe('forced');
    expect(m.forced).toBe(true);
    expect(m.from.rung).toBe('single-a');
    expect(m.to.rung).toBe('high-a');
    expect(m.reasons[0]).toBe(
      `This is his last eligible season at Single-A: 4 of 4 pro service years against the Single-A cap, so he must open ${nextSeason} at High-A or above.`
    );
    expect(m.deadline?.kind).toBe('service-cap');
    expect(m.deadline?.date).toBe(PLAN.seasonEnd.singleA);
    expect(m.deadline?.what).toBe(`Last eligible season at Single-A — must be at High-A or above by Opening Day ${nextSeason}`);
    expect(m.verify).toEqual({ field: 'rung', expect: 'high-a' });
  });

  it('forces nothing on a man a year short of the cap', async () => {
    const p = await plan();
    expect(movesOf(p, PLAN_MEN.singleAUnder).filter((m) => m.kind === 'forced')).toEqual([]);
    expect(row(p, 'single-a', PLAN_MEN.singleAUnder).lastEligibleSeason).toBe(nextSeason);
  });

  it('moves a man over the cap now, past a rung he would be over next season, and marks his level bad', async () => {
    const p = await plan();
    const [m] = movesOf(p, PLAN_MEN.singleAOver);
    expect(m.kind).toBe('forced');
    expect(m.horizon).toBe('now');
    // High-A takes 5 years this season but not the 6 he carries into next, so Double-A it is
    expect(m.to.rung).toBe('aa');
    expect(m.reasons[0]).toBe(
      `He is over the Single-A cap today: 5 pro service years against a cap of 4, so the roster is invalid until he moves, and the first level he may play at this season and next is Double-A: High-A is capped at 5, and he will have 6 by Opening Day ${nextSeason}.`
    );
    expect(m.deadline?.date).toBe(PLAN.gameDate);
    expect(m.deadline?.daysAway).toBe(0);
    expect(level(p, 'single-a').tone).toBe('bad');
    expect(row(p, 'single-a', PLAN_MEN.singleAOver).status).toBe('leaves');
    expect(row(p, 'aa', PLAN_MEN.singleAOver).status).toBe('arrives');
  });

  it('never moves a man into a rung where his years next season are over the cap', async () => {
    const p = await plan();
    const caps = p.settings.serviceCaps;
    const years = db.prepare(`SELECT pro_service_years AS y FROM players_roster_status WHERE player_id = ?`);
    let checked = 0;
    for (const m of p.moves) {
      const cap = caps[m.to.rung];
      if (typeof cap !== 'number') continue;
      const { y } = years.get(m.player.player_id) as { y: number };
      if (m.kind === 'hold') {
        // A hold moves nobody; the rung it names he may play at this season
        expect(y, m.key).toBeLessThanOrEqual(cap);
        continue;
      }
      // A rostered man gains a year by Opening Day: nobody arrives in his last eligible season
      expect(y + 1, m.key).toBeLessThanOrEqual(cap);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    // The fixture's 3-year DSL man who fits the Complex is not sent there at 3 of 3
    expect(movesOf(p, 98423).filter((m) => m.to.rung === 'complex')).toEqual([]);
    // The Double-A surplus men, at eleven years and more, go out and never down to the Complex
    for (const id of PLAN_MEN.surplus) {
      for (const m of movesOf(p, id)) expect(['out', 'aa']).toContain(m.to.rung);
    }
  });

  it('sends a 4-of-4 DSL man two steps up when he fits High-A, and says so first', async () => {
    const [m] = movesOf(await plan(), PLAN_MEN.dslTwoStepsFit);
    expect(m.kind).toBe('forced');
    expect(m.to.rung).toBe('high-a');
    expect(m.reasons[0]).toBe(
      `This is his last eligible season at the DSL: 4 of 4 pro service years against the DSL cap, and with the Complex capped at 3 and Single-A capped at 4 the first level he may open ${nextSeason} at is High-A, two steps up.`
    );
    expect(m.reasons[0]).toContain(`the first level he may open ${nextSeason} at is High-A, two steps up`);
    expect(m.deadline?.date).toBe(PLAN.seasonEnd.dsl);
  });

  it('puts the same man on the release list when he is not close to High-A, with the sentence and no forced move', async () => {
    const p = await plan();
    expect(movesOf(p, PLAN_MEN.dslTwoStepsShort).filter((m) => m.kind === 'forced')).toEqual([]);
    const listed = p.releaseOrTrade.find((r) => r.player_id === PLAN_MEN.dslTwoStepsShort)!;
    expect(listed).toBeDefined();
    expect(listed.kind).toBe('release');
    expect(listed.reasons[0]).toBe(
      `This is his last eligible season at the DSL: 4 of 4 pro service years against the DSL cap, and with the Complex capped at 3 and Single-A capped at 4 the first level he may open ${nextSeason} at is High-A, two steps up, and at 21 with a 25 grade he is not close to it.`
    );
    const card = movesOf(p, PLAN_MEN.dslTwoStepsShort);
    expect(card.map((m) => m.kind)).toEqual(['release']);
    expect(card[0].to.rung).toBe('out');
    // The cap binds from Opening Day: he plays the season out on his club and goes at its end
    expect(card[0].horizon).toBe('offseason');
    expect(card[0].deadline).toMatchObject({ kind: 'service-cap', date: PLAN.seasonEnd.dsl });
    expect(card[0].deadline?.what).toBe(`Last eligible season at the DSL — release Uno Man5 before Opening Day ${nextSeason}`);
    expect(card[0].reasons).toContain(
      `He is eligible at DSL Planner Uno for the rest of this season, so he plays it out there and is released after it ends on ${PLAN.seasonEnd.dsl}, before Opening Day ${nextSeason}.`
    );
    expect(row(p, 'dsl', PLAN_MEN.dslTwoStepsShort).status).toBe('stays');
  });

  it('names the rung two steps up on the deadline of an injured 4-of-4 DSL man', async () => {
    await inScenario(() => {
      injure(PLAN_MEN.dslTwoStepsShort, PLAN.teams.dslA, 12);
    }, async () => {
      const p = await plan();
      expect(movesOf(p, PLAN_MEN.dslTwoStepsShort)).toEqual([]);
      const rows = p.deadlines.filter((d) => d.player_id === PLAN_MEN.dslTwoStepsShort);
      expect(rows.map((d) => d.what)).toEqual([
        `Last eligible season at the DSL — on the injured list, must open ${nextSeason} at High-A or above, two steps up (the Complex capped at 3 and Single-A capped at 4)`,
      ]);
      expect(rows[0].date).toBe(PLAN.seasonEnd.dsl);
    });
  });

  it('never balances a 4-year man down to the Complex, nor a 3-year man who would be over its cap next season', async () => {
    // Single-A well over its soft maximum of 35 with surplus men at the bottom of
    // it: two with four and three pro years, graded below everyone, and seven ordinary men
    const [four, three] = [98548, 98549];
    await inScenario(() => {
      addPlannerMan({ id: four, club: 'singleA', position: 7, age: 27, oa: 20, pot: 22, proYears: 4 });
      addPlannerMan({ id: three, club: 'singleA', position: 9, age: 27, oa: 20, pot: 22, proYears: 3 });
      for (const [k, position] of [3, 7, 9, 3, 7, 9, 3].entries()) {
        addPlannerMan({ id: 98550 + k, club: 'singleA', position, age: 22, oa: 33, pot: 45, proYears: 1 });
      }
    }, async () => {
      const p = await plan();
      const caps = p.settings.serviceCaps;
      for (const [id, years] of [[four, 4], [three, 3]] as const) {
        const cards = movesOf(p, id);
        expect(cards.length, String(id)).toBeGreaterThan(0);
        for (const m of cards) {
          expect(m.to.rung, m.key).not.toBe('complex');
          const cap = caps[m.to.rung];
          if (typeof cap === 'number') expect(years + 1, m.key).toBeLessThanOrEqual(cap);
        }
      }
      // The 4-year man is in his last Single-A season, so the cap sends him up, not down
      expect(movesOf(p, four).map((m) => `${m.kind}:${m.to.rung}:${m.horizon}`)).toEqual(['forced:high-a:offseason']);
      // The 3-year man would be over the Complex cap next season, so the push for size passes the
      // Complex by and takes him to the DSL, where four years next season is still within the cap
      const [down] = movesOf(p, three);
      expect(down.key).toBe(`demote:${three}:single-a:dsl`);
      expect(down.reasons[0]).toMatch(/^Planner Singles is \d+ against a soft maximum of 35, so only its surplus men leave for size/);
      expect(down.reasons[0]).toContain('He is eligible at the DSL, so he goes down rather than out.');
    });
  });

  it('dates the last-season move today when he fits the rung above at 0.5 or better, and at the deadline when he does not', async () => {
    const id = PLAN_MEN.singleACapped;
    const deadlineWhat = `Last eligible season at Single-A — must be at High-A or above by Opening Day ${nextSeason}`;
    const earned = 'He has earned the move now, so it is dated today rather than at the deadline.';
    // As generated, a 33 with a 40 ceiling: short of a strong fit at High-A, so the move waits for the winter
    const p = await plan();
    const [later] = movesOf(p, id);
    expect(later.kind).toBe('forced');
    expect(later.horizon).toBe('offseason');
    expect(later.deadline).toMatchObject({ kind: 'service-cap', date: PLAN.seasonEnd.singleA, what: deadlineWhat });
    expect(later.reasons).not.toContain(earned);
    // He plays the season out where he is
    expect(row(p, 'single-a', id).status).toBe('stays');
    expect(level(p, 'high-a').roster.some((r) => r.player_id === id)).toBe(false);
    // Graded and hitting well past the High-A median: a strong fit, so the move is made now
    await inScenario(() => {
      regrade(id, 48, 55);
      rewriteBatting(id, 48, [[PLAN.season, 'singleA', 158], [PLAN.season - 1, 'singleA', 450], [PLAN.season - 2, 'complex', 400]]);
    }, async () => {
      const q = await plan();
      const [now] = movesOf(q, id);
      expect(now.kind).toBe('forced');
      expect(now.horizon).toBe('now');
      expect(now.reasons[1]).toBe(earned);
      expect(now.deadline).toMatchObject({ kind: 'service-cap', date: PLAN.seasonEnd.singleA, what: deadlineWhat });
      const arrived = row(q, 'high-a', id);
      expect(arrived.status).toBe('arrives');
      expect(arrived.fit).toBeGreaterThanOrEqual(0.5);
    });
  });

  it('holds the line at a fit of 0.5: just under it the move waits for the deadline, at or just over it the move is today', async () => {
    const id = PLAN_MEN.singleACapped;
    const earned = 'He has earned the move now, so it is dated today rather than at the deadline.';
    const graded = (oa: number) => (): void => {
      regrade(id, oa, 40);
      rewriteBatting(id, oa, [[PLAN.season, 'singleA', 158], [PLAN.season - 1, 'singleA', 450], [PLAN.season - 2, 'complex', 400]]);
    };
    const forcedOf = (p: Plan): PlanMove => movesOf(p, id).find((m) => m.kind === 'forced')!;
    // A 37: a fit above the promotion bar at High-A but short of a strong one, so the move waits
    await inScenario(graded(37), async () => {
      const p = await plan();
      const m = forcedOf(p);
      expect(m.horizon).toBe('offseason');
      expect(m.reasons).not.toContain(earned);
      expect(m.deadline).toMatchObject({ kind: 'service-cap', date: PLAN.seasonEnd.singleA });
      expect(m.deadline?.what).toContain('by Opening Day');
      expect(level(p, 'high-a').roster.some((r) => r.player_id === id)).toBe(false);
    });
    // Its fit is read off the same man a year short of the cap, who goes up on merit and arrives
    // on the High-A roster: above the promotion bar, short of a strong fit
    await inScenario(() => {
      graded(37)();
      db.prepare(`UPDATE players_roster_status SET pro_service_years = 3 WHERE player_id = ?`).run(id);
      // Room at Single-A to let him go
      for (const k of [0, 1]) addPlannerMan({ id: PLAN.spareFrom + k, club: 'singleA', position: 1, role: 12, age: 22, oa: 32, pot: 45, proYears: 1 });
    }, async () => {
      const p = await plan();
      expect(movesOf(p, id).map((m) => m.key)).toContain(`promote:${id}:single-a:high-a`);
      const fit = row(p, 'high-a', id).fit!;
      expect(fit).toBeGreaterThan(0);
      expect(fit).toBeLessThan(0.5);
    });
    // A 39: a fit just over 0.5 at High-A, so the move is made today
    await inScenario(graded(39), async () => {
      const p = await plan();
      const m = forcedOf(p);
      expect(m.horizon).toBe('now');
      expect(m.reasons[1]).toBe(earned);
      const fit = row(p, 'high-a', id).fit!;
      expect(fit).toBeGreaterThanOrEqual(0.5);
      expect(fit).toBeLessThan(0.8);
    });
  });

  it('says "one step up" when the cap sends a man one rung past the next, and "steps" only for more', async () => {
    // A DSL cap of 3, which the design suggests: a 3-year DSL man is in his last season there, the
    // Complex (3) is closed to him by Opening Day and Single-A (4) is the first level that takes him
    const caps = { aaa: null, aa: null, 'high-a': 5, 'single-a': 4, complex: 3, dsl: 3 };
    const hurt = 98368;
    try {
      await putSettings({ serviceCaps: caps });
      await inScenario(() => injure(hurt, PLAN.teams.dslA, 12), async () => {
        const p = await plan();
        const words = `and with the Complex capped at 3 the first level he may open ${nextSeason} at is Single-A, one step up`;
        const card = movesOf(p, 98423).find((m) => m.kind === 'forced') ?? p.releaseOrTrade.find((r) => r.player_id === 98423);
        expect(card, 'the 3-year DSL man has a forced move or a place on the release list').toBeDefined();
        expect(card!.reasons[0]).toContain(`This is his last eligible season at the DSL: 3 of 3 pro service years against the DSL cap, ${words}`);
        const all = [...p.moves.flatMap((m) => m.reasons), ...p.deadlines.map((d) => d.what)];
        expect(all.filter((r) => r.includes('one steps up'))).toEqual([]);
        // The injured man's deadline names the rung the same way
        expect(p.deadlines.filter((d) => d.player_id === hurt).map((d) => d.what)).toEqual([
          `Last eligible season at the DSL — on the injured list, must open ${nextSeason} at Single-A or above, one step up (the Complex capped at 3)`,
        ]);
      });
    } finally {
      await putSettings({ serviceCaps: { ...caps, dsl: 4 } });
    }
  });
});

describe('the first eligible rung above', () => {
  /** The DSL Dos infielder at 3 of 4 years: over the Complex cap of 3 by Opening Day, within Single-A's 4. */
  const dslThree = 98423;
  const closed = `The Complex (capped at 3) is closed to him: he will have 4 pro service years by Opening Day ${nextSeason}`;
  /** The sentence as a pattern: its brackets and full stops taken literally. */
  const literally = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /** Graded and hitting well past the Single-A median, so he fits Single-A as well as the Complex. */
  const strong = (): void => {
    regrade(dslThree, 40, 52);
    rewriteBatting(dslThree, 40, [[PLAN.season - 1, 'dslB', 300], [PLAN.season - 2, 'dslB', 250]]);
  };
  /** No card of his may target a rung his years next season are over the cap of. */
  const withinCaps = (p: Plan, id: number, years: number): void => {
    for (const m of movesOf(p, id)) {
      expect(m.to.rung, m.key).not.toBe('complex');
      const cap = p.settings.serviceCaps[m.to.rung];
      if (typeof cap === 'number') expect(years + 1, m.key).toBeLessThanOrEqual(cap);
    }
  };
  /** Ten young men at Single-A, none an infielder and none surplus: the club is full without an infield. */
  const fillSingleA = (): void => {
    for (let k = 0; k < 10; k++) {
      addPlannerMan({
        id: 98561 + k, club: 'singleA', position: k < 5 ? 1 : [7, 8, 9][k % 3], role: k < 5 ? 12 : 0, age: 19, oa: 28, pot: 45, proYears: 1,
      });
    }
  };

  /** His card's first sentence up to the fit he has at Single-A, which is under the bar. */
  const shortOfSingleA = `^${literally(closed)}, so Single-A is the first level above the DSL that admits him, but his fit there is -[0-9.]+, short of the 0 a promotion asks, `;

  it('gives a 3-year DSL man who fits the Complex a hold that names its cap, when he does not fit Single-A', async () => {
    // As generated he fits the Complex, which his cap closes, and not Single-A: the card says both.
    // Single-A (capped at 4) takes him this season only, since a move next year must hold for the
    // year after, when he has 5; next year he is at the DSL cap, so the cap sends him two steps up
    // or off the club, and the card says so instead of promising he moves up when his grade does
    const p = await plan();
    const [card] = movesOf(p, dslThree);
    expect(card.key).toBe(`hold:${dslThree}:dsl:single-a`);
    expect(card.reasons[0]).toMatch(new RegExp(
      `${shortOfSingleA}and this is the last season Single-A can take him: next year he is at the DSL cap, 4 of 4 pro service years, and must open ${nextSeason + 1} at High-A or above, or leave\\.$`
    ));
    expect(card.reasons.some((r) => r.includes('when his grade or his line carries him there'))).toBe(false);
    expect(movesOf(p, dslThree)).toHaveLength(1);
    withinCaps(p, dslThree, 3);
  });

  it('promises he moves up when his grade carries him only while the level stays open to him next year', async () => {
    // Single-A capped at 5: a move next year, at 4 years, still holds for the year after
    const caps = { aaa: null, aa: null, 'high-a': 5, 'single-a': 5, complex: 3, dsl: 4 };
    try {
      await putSettings({ serviceCaps: caps });
      const p = await plan();
      const [card] = movesOf(p, dslThree);
      expect(card.key).toBe(`hold:${dslThree}:dsl:single-a`);
      expect(card.reasons[0]).toMatch(new RegExp(`${shortOfSingleA}so he moves up when his grade or his line carries him there\\.$`));
    } finally {
      await putSettings({ serviceCaps: { ...caps, 'single-a': 4 } });
    }
  });

  it('names the first level that admits him after this season when next year is not his last at the DSL', async () => {
    // A DSL cap of 5: next year he has 4 of 5 there, so nothing forces him, but Single-A is closed to him by then
    const caps = { aaa: null, aa: null, 'high-a': 5, 'single-a': 4, complex: 3, dsl: 5 };
    try {
      await putSettings({ serviceCaps: caps });
      const p = await plan();
      const [card] = movesOf(p, dslThree);
      expect(card.key).toBe(`hold:${dslThree}:dsl:single-a`);
      expect(card.reasons[0]).toMatch(new RegExp(
        `${shortOfSingleA}and this is the last season Single-A can take him: after it, the first level above the DSL that admits him is High-A\\.$`
      ));
    } finally {
      await putSettings({ serviceCaps: { ...caps, dsl: 4 } });
    }
  });

  it('promotes the same man past the Complex to Single-A when Single-A is short of infielders', async () => {
    await inScenario(() => {
      // Three Single-A infielders gone: four left against the six the level needs
      for (const id of [98245, 98246, 98247]) removePlannerMan(id);
      // A ninth DSL Dos infielder, so his club can let him go without a refill the DSL cannot make
      addPlannerMan({ id: 98560, club: 'dslB', position: 4, age: 19, oa: 24, pot: 35, proYears: 1 });
      strong();
    }, async () => {
      const p = await plan();
      const cards = movesOf(p, dslThree);
      expect(cards.map((m) => m.key)).toEqual([`promote:${dslThree}:dsl:single-a`]);
      const [up] = cards;
      expect(up.reasons[0]).toMatch(/^Planner Singles is short of infielders: four against the six the level needs, and he is the best eligible infielder below \(fit [0-9.]+ at Single-A\)\.$/);
      expect(up.reasons).toContain(`${closed}, so Single-A is the first level above the DSL that admits him.`);
      expect(row(p, 'single-a', dslThree).status).toBe('arrives');
      withinCaps(p, dslThree, 3);
    });
  });

  it('holds him with the cap sentence first and the place that would open, when Single-A is full', async () => {
    await inScenario(() => {
      fillSingleA();
      // Spare infielders at DSL Dos, so it is Single-A's size and not his own club that stops him
      for (const id of [98555, 98556, 98557, 98558, 98559, 98560]) {
        addPlannerMan({ id, club: 'dslB', position: 4, age: 19, oa: 18, pot: 30, proYears: 1 });
      }
      strong();
    }, async () => {
      const p = await plan();
      const cards = movesOf(p, dslThree);
      expect(cards.map((m) => m.key)).toEqual([`hold:${dslThree}:dsl:single-a`]);
      expect(cards[0].reasons[0]).toMatch(new RegExp(
        `^${literally(closed)}, so Single-A is the first level above the DSL that admits him, and his fit there is [0-9.]+, but Planner Singles is at \\d+ against its maximum of 35, so he moves up when a place opens there\\.$`
      ));
      withinCaps(p, dslThree, 3);
    });
  });

  it('names the level above that needs him before the minimum at his own club that holds him, the caps still first', async () => {
    await inScenario(() => {
      // Single-A three infielders short. The Complex at its eight infielders and each DSL club
      // without a spare one, so neither the Complex nor DSL Dos can let an infielder go
      for (const id of [98245, 98246, 98247, 98311, 98367, 98429]) removePlannerMan(id);
      strong();
    }, async () => {
      const p = await plan();
      const cards = movesOf(p, dslThree);
      expect(cards.map((m) => m.key)).toEqual([`hold:${dslThree}:dsl:single-a`]);
      expect(cards[0].reasons[0]).toMatch(new RegExp(
        `^${literally(closed)}, so Single-A is the first level above the DSL that admits him, and his fit there is [0-9.]+; Planner Singles is short of infielders: four against the six the level needs, but DSL Planner Dos would be left with seven infielders against the eight the level needs without him, so he moves up when it can spare him\\.$`
      ));
      expect(level(p, 'single-a').structure.find((s) => s.group === 'IF')).toMatchObject({ have: 4, need: 6 });
      withinCaps(p, dslThree, 3);
    });
  });

  it('keeps the cap hold as his one card when a minimum also keeps him off the release list, and says the minimum after', async () => {
    // Graded and hitting well, but at 22 he is old for a complex level, so the class calls him
    // surplus and the release loop holds him for DSL Dos's infield as well. Single-A is full
    await inScenario(() => {
      strong();
      db.prepare('UPDATE players SET age = 22, date_of_birth = ? WHERE player_id = ?').run(`${PLAN.season - 22}-03-05`, dslThree);
      fillSingleA();
      for (const id of [98555, 98556, 98557, 98558, 98559, 98560]) {
        addPlannerMan({ id, club: 'dslB', position: 4, age: 19, oa: 18, pot: 30, proYears: 1 });
      }
    }, async () => {
      const p = await plan();
      const cards = movesOf(p, dslThree);
      // The card and its key are the cap hold's, written first, so a decision on it is not orphaned
      // when the release loop's hold comes or goes
      expect(cards.map((m) => m.key)).toEqual([`hold:${dslThree}:dsl:single-a`]);
      expect(row(p, 'dsl', dslThree).assetClass).toBe('surplus');
      expect(cards[0].reasons[0]).toMatch(new RegExp(
        `^${literally(closed)}, so Single-A is the first level above the DSL that admits him, and his fit there is [0-9.]+, but Planner Singles is at \\d+ against its maximum of 35, so he moves up when a place opens there\\.$`
      ));
      expect(cards[0].reasons[1]).toBe(
        'Kept for structure: eighth infielder at DSL Planner Dos, where releasing him would leave seven against the eight the level needs.'
      );
    });
  });

  it('says first that the club above needs him and his own club cannot spare him, and the size after', async () => {
    const man = 98305; // a Complex third baseman, graded past the Single-A median
    await inScenario(() => {
      // Single-A short of infielders and full without them
      for (const id of [98245, 98246, 98247]) removePlannerMan(id);
      fillSingleA();
      // The Complex at its eight infielders, and neither DSL club with one to spare to refill it
      for (const id of [98311, 98367, 98429]) removePlannerMan(id);
      regrade(man, 42, 58);
      rewriteBatting(man, 42, [[PLAN.season, 'complex', 158], [PLAN.season - 1, 'complex', 450], [PLAN.season - 2, 'dslA', 400]]);
    }, async () => {
      const p = await plan();
      const cards = movesOf(p, man);
      expect(cards.map((m) => m.key)).toEqual([`hold:${man}:complex:single-a`]);
      expect(cards[0].reasons[0]).toMatch(
        /^Planner Singles is short of infielders: four against the six the level needs, and he is ready for Single-A at a fit of [0-9.]+, but ACL Planner Nine would be left with seven infielders against the eight the level needs without him, and nobody below can take his place there\.$/
      );
      expect(cards[0].reasons[1]).toBe('Planner Singles is at 35 against its maximum of 35, and only surplus men are moved for size.');
      // The minimum is said once, not again as a second hold folded in
      expect(cards[0].reasons.filter((r) => r.includes('would be left with seven infielders'))).toHaveLength(1);
    });
  });
  it('keeps a club name with a stop in it whole when two sentences of his card open with it', async () => {
    const man = 98305;
    // "St." is an abbreviation the pattern knows; "Al." is one only the club's own name says is not a sentence end
    for (const name of ['St. Planner', 'Al. Planner']) {
      await inScenario(() => {
        db.prepare(`UPDATE teams SET name = ? WHERE team_id = ?`).run(name, PLAN.teams.singleA);
        for (const id of [98245, 98246, 98247]) removePlannerMan(id);
        fillSingleA();
        for (const id of [98311, 98367, 98429]) removePlannerMan(id);
        regrade(man, 42, 58);
        rewriteBatting(man, 42, [[PLAN.season, 'complex', 158], [PLAN.season - 1, 'complex', 450], [PLAN.season - 2, 'dslA', 400]]);
      }, async () => {
        const p = await plan();
        const [card] = movesOf(p, man);
        expect(card.key).toBe(`hold:${man}:complex:single-a`);
        expect(card.reasons[0].startsWith(`${name} Singles is short of infielders: four against the six the level needs,`), card.reasons[0]).toBe(true);
        expect(card.reasons[1]).toBe(`${name} Singles is at 35 against its maximum of 35, and only surplus men are moved for size.`);
      });
    }
  });

  it('says first that the club above needs him when a minimum at his own club holds him, not that merit never breaks one', async () => {
    const man = 98369; // a DSL Uno third baseman with one pro year, graded past the Complex median
    await inScenario(() => {
      // The Complex two infielders short, with room under its maximum. Each DSL club loses an
      // infielder, and DSL Dos gains a reliever, so the complex shortstop the full pool sends out
      // joins the smaller DSL Uno: Uno stands at its eight infielders and Dos at seven, neither
      // has one to spare, and no pull can fill the Complex
      for (const id of [98308, 98311, 98365, 98429]) removePlannerMan(id);
      addPlannerMan({ id: PLAN.spareFrom, club: 'dslB', position: 1, role: 12, age: 18, oa: 22, pot: 36, proYears: 0 });
      regrade(man, 42, 58);
      rewriteBatting(man, 42, [[PLAN.season, 'dslA', 158], [PLAN.season - 1, 'dslA', 400]]);
    }, async () => {
      const p = await plan();
      const cards = movesOf(p, man);
      expect(cards.map((m) => m.key)).toEqual([`hold:${man}:dsl:complex`]);
      expect(cards[0].reasons[0]).toMatch(
        /^ACL Planner Nine is short of infielders: seven against the eight the level needs, and he is ready for the Complex at a fit of [0-9.]+, but DSL Planner Uno would be left with seven infielders against the eight the level needs without him\.$/
      );
      expect(cards[0].reasons.some((r) => r.includes('a promotion on merit'))).toBe(false);
      expect(level(p, 'complex').planned.roster).toBeLessThan(level(p, 'complex').target.max);
    });
  });
});

describe('the international complex', () => {
  it('assigns a nineteen-year-old before his twentieth birthday, the deadline read off his birth date', async () => {
    const [m] = movesOf(await plan(), PLAN_MEN.icNineteen);
    const { born } = db.prepare(`SELECT date_of_birth AS born FROM players WHERE player_id = ?`).get(PLAN_MEN.icNineteen) as { born: string };
    const [y, mo, d] = born.split('-').map(Number);
    expect(m.kind).toBe('assign');
    expect(m.forced).toBe(true);
    expect(m.from.rung).toBe('ic');
    expect(m.to.rung).toBe('dsl');
    expect(m.deadline?.kind).toBe('ic-age');
    expect(m.deadline?.date).toBe(`${y + 20}-${mo}-${d}`);
    expect(m.reasons[0]).toContain(`He turns 20 on ${y + 20}-${mo}-${d}, when OOTP moves him out of the international complex by itself`);
    expect(m.verify).toEqual({ field: 'rostered', expect: true });
  });

  it('sends the best eighteen-year-old out of a full pool by the DSL\'s first day', async () => {
    const p = await plan();
    expect(p.org.ic).toEqual({ size: 50, max: 50, ages: { '16': 16, '17': 30, '18': 3, '19': 1 } });
    const [m] = movesOf(p, PLAN_MEN.icBestEighteen);
    expect(m.kind).toBe('assign');
    expect(m.forced).toBe(false);
    expect(m.deadline?.kind).toBe('ic-room');
    expect(m.deadline?.date).toBe(PLAN.dates.dslStart);
    expect(m.reasons[0]).toContain('the pool is full at 50 of 50, so the scout finds nobody until a place opens');
    expect(m.reasons[0]).toContain('he is the best 18-year-old in it by ceiling (58)');
  });

  it('never trades, releases or receives a complex man', async () => {
    const p = await plan();
    const pool = new Set((db.prepare(`SELECT player_id FROM players WHERE league_id = ? AND organization_id = ?`).all(PLAN.icLeague, PLAN.org) as Array<{ player_id: number }>).map((r) => r.player_id));
    expect(pool.size).toBe(PLAN.icSize);
    expect(p.releaseOrTrade.filter((r) => pool.has(r.player_id))).toEqual([]);
    for (const m of p.moves) {
      expect(m.to.rung, m.key).not.toBe('ic');
      if (pool.has(m.player.player_id)) expect(m.kind, m.key).toBe('assign');
    }
  });
});

describe('the injured list', () => {
  it('freezes a list-4 man: listed, counted, never moved', async () => {
    const p = await plan();
    for (const [rung, id] of [['aaa', PLAN_MEN.aaaInjured], ['aa', PLAN_MEN.aaInjured]] as const) {
      expect(movesOf(p, id)).toEqual([]);
      const r = row(p, rung, id);
      expect(r.frozen).toBe(true);
      expect(r.verdict).toBe('frozen');
      expect(r.status).toBe('stays');
    }
    expect(level(p, 'aaa').now).toMatchObject({ roster: 32, healthy: 31, il: 1 });
  });

  it('reads list 2 as healthy, whatever a stale is_on_dl60 flag says', async () => {
    const p = await plan();
    expect(row(p, 'aa', PLAN_MEN.staleDl60).frozen).toBe(false);
    expect(row(p, 'aa', PLAN_MEN.staleDl60).verdict).not.toBe('frozen');
  });

  it('covers an injured catcher from below, with his return date in the first sentence', async () => {
    const [first, second] = PLAN_MEN.aaaCatchers;
    await inScenario(() => {
      injure(first, PLAN.teams.aaa, 45);
      injure(second, PLAN.teams.aaa, 45);
    }, async () => {
      const p = await plan();
      const cover = p.moves.find((m) => m.kind === 'cover')!;
      expect(cover).toBeDefined();
      expect(cover.to.rung).toBe('aaa');
      expect(cover.from.rung).toBe('aa');
      expect(PLAN_MEN.aaCatchers).toContain(cover.player.player_id);
      expect(cover.player.positionName).toBe('C');
      expect(cover.reasons[0]).toBe(
        'Triples Man1 is on the injured list at Planner Triples for about 45 more days (back around 2030-7-16), leaving one healthy catcher against the two the level needs, so he covers until Triples Man1 returns.'
      );
      expect(cover.verify).toEqual({ field: 'rung', expect: 'aaa' });
      expect(level(p, 'aaa').structure.find((s) => s.group === 'C')).toMatchObject({ have: 2, need: 2, tone: 'ok' });
    });
  });

  it('opens one cover for one injury, gives it to the best catcher below, and fills the rest of the shortfall with promotions', async () => {
    const [first, second, third] = PLAN_MEN.aaaCatchers;
    await inScenario(() => {
      // One catcher hurt and the other two gone: two short, and only one of them is the injury
      injure(first, PLAN.teams.aaa, 45);
      removePlannerMan(second);
      removePlannerMan(third);
    }, async () => {
      const p = await plan();
      const pulls = p.moves.filter((m) => m.to.rung === 'aaa' && (m.kind === 'cover' || m.kind === 'promote') && m.player.positionName === 'C');
      expect(pulls.map((m) => m.kind).sort()).toEqual(['cover', 'promote']);
      expect(p.moves.filter((m) => m.kind === 'cover')).toHaveLength(1);
      const cover = pulls.find((m) => m.kind === 'cover')!;
      const promote = pulls.find((m) => m.kind === 'promote')!;
      // The injury is one place of the two, and the sentence says so: reversing
      // the cover when he returns must not reopen the other
      expect(cover.reasons[0]).toBe(
        'Triples Man1 is on the injured list at Planner Triples for about 45 more days (back around 2030-7-16). Planner Triples has no healthy catchers against the two the level needs and would still be one short with him back, so one place is his to cover until Triples Man1 returns; the other is filled by promotion.'
      );
      expect(promote.reasons[0]).toMatch(
        /^Planner Triples is short of catchers: one against the two the level needs, and he is the best eligible catcher below \(fit -?[\d.]+ at Triple-A\)\.$/
      );
      // The cover is the best of the healthy Double-A catchers by fit, and better than the man promoted beside him
      const aaCatchers = level(p, 'aa').roster.filter((r) => r.positionName === 'C' && !r.frozen);
      const best = [...aaCatchers].sort((a, b) => (b.fit ?? -Infinity) - (a.fit ?? -Infinity) || a.player_id - b.player_id)[0];
      expect(cover.player.player_id).toBe(best.player_id);
      expect(row(p, 'aaa', cover.player.player_id).fit!).toBeGreaterThanOrEqual(row(p, 'aaa', promote.player.player_id).fit!);
      expect(level(p, 'aaa').structure.find((s) => s.group === 'C')).toMatchObject({ have: 2, need: 2, tone: 'ok' });
    });
  });
});

describe('the 40-man', () => {
  it('moves a long-term injury to the 60-day list when the 40 is full', async () => {
    await inScenario(() => {
      // Four fillers and the injured man himself make the forty
      fillForty(4);
      injure(PLAN_MEN.aaaInjured, PLAN.teams.aaa, 90);
      db.prepare(`DELETE FROM team_roster WHERE player_id = ? AND list_id = 4`).run(PLAN_MEN.aaaInjured);
      db.prepare(`INSERT INTO team_roster VALUES (?, ?, 4)`).run(PLAN.teams.aaa, PLAN_MEN.aaaInjured);
      onForty(PLAN_MEN.aaaInjured);
    }, async () => {
      const p = await plan();
      expect(p.org.fortyMan).toEqual({ count: 40, limit: 40 });
      const [m] = movesOf(p, PLAN_MEN.aaaInjured);
      expect(m.kind).toBe('il60');
      expect(m.key).toBe(`il60:${PLAN_MEN.aaaInjured}:aaa:aaa`);
      expect(m.reasons[0]).toBe(
        'The 40-man is full at 40 of 40. He is out for about 90 more days, past the 60 the long list asks, so moving him there frees a 40-man place without losing him.'
      );
      expect(m.verify).toEqual({ field: 'il60', expect: true });
      expect(m.ootpSteps).toContain('Transactions → Place on 60-Day Injured List');
    });
  });

  it('flags a man on the 26 out of options and never moves him', async () => {
    const p = await plan();
    expect(movesOf(p, PLAN_MEN.mlbOutOfOptions)).toEqual([]);
    expect(row(p, 'mlb', PLAN_MEN.mlbOutOfOptions).flags).toEqual(['Out of options: cannot be sent down without clearing waivers']);
    expect(level(p, 'mlb').roster.filter((r) => r.flags.length).map((r) => r.player_id)).toEqual([PLAN_MEN.mlbOutOfOptions]);
  });

  it('names the man who comes off a full 40 for a call-up', async () => {
    const [, healthyCf] = PLAN_MEN.aaaCentreFielders;
    await inScenario(() => {
      fillForty();
      regrade(healthyCf, 60, 62);
    }, async () => {
      const p = await plan();
      const up = movesOf(p, healthyCf).find((m) => m.kind === 'callup')!;
      expect(up).toBeDefined();
      expect(up.fortyMan?.count).toBe(40);
      expect(up.fortyMan?.limit).toBe(40);
      expect(up.fortyMan?.comesOff).not.toBeNull();
      const off = up.fortyMan!.comesOff!;
      expect(off.why).toBe('out of options');
      // Out of options the way optionState() reads it: not the man in his last
      // option year (3 used, this year's among them), who grades lower, nor the
      // man on the 26, whose place there the call-up already settles
      expect(off.player_id).toBe(PLAN_MEN.farmOutOfOptions);
      expect(up.reasons).toContain(`He is not on the 40-man, which is full at 40 of 40; ${off.name} is the place (${off.why}).`);
      expect(up.ootpSteps).toContain(`Open ${off.name} → Transactions → Designate for Assignment`);
      // The man he displaces on the 26 goes down with him linked
      const down = p.moves.find((m) => m.kind === 'senddown' && m.linked.includes(up.key))!;
      expect(down).toBeDefined();
      expect(up.linked).toContain(down.key);
    });
  });

  it('turns the call-up into a hold naming the full 40 when nobody can cheaply give up his place', async () => {
    const [, healthyCf] = PLAN_MEN.aaaCentreFielders;
    await inScenario(() => {
      fillForty();
      keepTripleATrades();
      regrade(healthyCf, 60, 62);
      // Five pro years against four of protection: Rule 5 eligible as well
      db.prepare(`UPDATE players_roster_status SET pro_service_years = 5 WHERE player_id = ?`).run(healthyCf);
      // Nobody on the 40 is out of options, and nobody is out sixty days
      db.prepare(`UPDATE players_roster_status SET options_used = 0, options_used_this_year = 0 WHERE player_id IN (?, ?, ?)`)
        .run(PLAN_MEN.lastOptionYear, PLAN_MEN.farmOutOfOptions, PLAN_MEN.mlbOutOfOptions);
    }, async () => {
      const p = await plan();
      // One man, one card: his 40-man question, held by the same full 40, with the call-up hold folded into it.
      // It keeps the protection's key and the Rule 5 date, so a decision on it survives whichever card carries it
      const cards = movesOf(p, healthyCf);
      expect(cards.map((m) => m.kind)).toEqual(['hold']);
      const [m] = cards;
      expect(m.key).toBe(`protect:${healthyCf}:40man`);
      expect(m.to.rung).toBe('40man');
      expect(m.reasons[0]).toBe('Worth a 40-man place before the Rule 5 draft, but the 40-man is full at 40 of 40 and nobody on it can cheaply give up his place.');
      expect(m.deadline).toMatchObject({ kind: 'rule5', date: PLAN.dates.rule5 });
      // Accepting it means adding him, so the next import checks the 40-man as it would for the protection
      expect(m.verify).toEqual({ field: 'on40', expect: true });
      expect(p.moves.filter((x) => x.kind === 'callup')).toEqual([]);
      expect(m.reasons).toContain('Would take a place on the 26, but the 40-man is full at 40 of 40 and nobody on it can cheaply give up his place.');
    });
  });
});

describe('one man, one card', () => {
  it('folds a call-up held up on the 26 into the trade the same man gets, so he is listed and counted once', async () => {
    const id = PLAN_MEN.lastOptionYear;
    await inScenario(() => {
      // A 33-year-old catcher graded above the big club's weakest, hitting well, in his last option year:
      // the 26 wants him, and the club's options say shop him
      regrade(id, 52, 52);
      db.prepare(`UPDATE players SET age = 33 WHERE player_id = ?`).run(id);
      rewriteBatting(id, 62, [[PLAN.season, 'aaa', 158], [PLAN.season - 1, 'aaa', 450], [PLAN.season - 2, 'aaa', 405]]);
      // The catcher he would replace cannot be optioned
      db.prepare(`UPDATE players_roster_status SET options_used = 3, options_used_this_year = 0 WHERE player_id = ?`).run(PLAN_MEN.mlbCatchers[0]);
    }, async () => {
      const p = await plan();
      const cards = movesOf(p, id);
      expect(cards.map((m) => m.kind)).toEqual(['trade']);
      expect(cards[0].reasons).toContain(
        "Would take Nine Man1's place on the 26, but Nine Man1 cannot be optioned: 3 of 3 options used and none this year, so a send-down means waivers."
      );
      expect(p.releaseOrTrade.filter((r) => r.player_id === id)).toHaveLength(1);
      // Nobody anywhere in the plan carries two cards, his 40-man question (a protection, or the hold
      // that stands in for one) beside a move apart
      const kinds = new Map<number, Array<{ kind: string; forty: boolean }>>();
      for (const m of p.moves) kinds.set(m.player.player_id, [...(kinds.get(m.player.player_id) ?? []), { kind: m.kind, forty: m.to.rung === '40man' }]);
      for (const [who, cards] of kinds) {
        const said = `${who}: ${cards.map((c) => c.kind).join(', ')}`;
        const rung = cards.filter((c) => !c.forty && c.kind !== 'il60').map((c) => c.kind);
        expect(rung.length, said).toBeLessThanOrEqual(1);
        expect(cards.filter((c) => c.forty).length, said).toBeLessThanOrEqual(1);
        if (cards.some((c) => c.forty)) expect(['hold', 'trade', 'release'].some((k) => rung.includes(k)), said).toBe(false);
      }
    });
  });
});

describe('Rule 5', () => {
  it('protects an eligible man with a 52 ceiling on the grade alone', async () => {
    const p = await plan();
    const m = movesOf(p, PLAN_MEN.rule5Grade).find((x) => x.kind === 'protect')!;
    expect(m).toBeDefined();
    expect(m.key).toBe(`protect:${PLAN_MEN.rule5Grade}:40man`);
    // Third of the four protections by fit: the count is the one after the two above him, less the two
    // places the plan's own trades free by the trade deadline, before the Rule 5 draft
    expect(m.reasons[0]).toBe(
      `Rule 5 eligible on ${PLAN.dates.rule5}: 5 pro seasons against 4 years of protection, not on the 40-man. The 40-man would hold 35 of 40 after the two protections above, counting the places the trades of Triples Man9 and Triples Man2 free, so a place is open; at a 52 ceiling the grade earns it.`
    );
    expect(m.fortyMan).toEqual({ count: 35, limit: 40, comesOff: null });
    expect(m.verify).toEqual({ field: 'on40', expect: true });
    expect(m.ootpSteps).toContain(`Transactions → Add to 40-Man Roster, before ${PLAN.dates.rule5}`);
  });

  it('uses up the open places one protection at a time, then names who comes off, then holds the rest', async () => {
    await inScenario(() => {
      // Two more on the 40 leave three places open, and a fifth man earns one;
      // the plan trades nobody off the 40, so it frees no place of its own
      fillForty(2);
      keepTripleATrades();
      regrade(PLAN_MEN.rule5Depth, 40, 52);
    }, async () => {
      const p = await plan();
      expect(p.org.fortyMan).toEqual({ count: 37, limit: 40 });
      const protects = p.moves.filter((m) => m.kind === 'protect');
      // Three open places and one man out of options to give his up: four protections, never more
      expect(protects.map((m) => m.fortyMan)).toEqual([
        { count: 37, limit: 40, comesOff: null },
        { count: 38, limit: 40, comesOff: null },
        { count: 39, limit: 40, comesOff: null },
        { count: 40, limit: 40, comesOff: { player_id: PLAN_MEN.farmOutOfOptions, name: 'Triples Man2', why: 'out of options' } },
      ]);
      const clause = (m: PlanMove) => /not on the 40-man\. (.*); at a \d+ ceiling/.exec(m.reasons[0])?.[1];
      expect(protects.map(clause)).toEqual([
        'The 40-man holds 37 of 40, so a place is open',
        'The 40-man would hold 38 of 40 after the protection above, so a place is open',
        'The 40-man would hold 39 of 40 after the two protections above, so a place is open',
        'The 40-man would be full: 40 of 40 after the three protections above, so Triples Man2 is the place (out of options)',
      ]);
      expect(protects[3].ootpSteps).toContain('Open Triples Man2 → Transactions → Designate for Assignment');
      // Nobody is left to give up a place, so the fifth man is a hold that says why
      const held = p.moves.filter((m) => m.kind === 'hold' && m.to.rung === '40man');
      expect(held).toHaveLength(1);
      expect(held[0].reasons[0]).toBe(
        'Worth a 40-man place before the Rule 5 draft, but the 40-man would be full: 40 of 40 after the four protections above and nobody on it can cheaply give up his place.'
      );
      // Accepted together, the cards fit: the places taken never pass the limit
      const added = protects.filter((m) => m.fortyMan?.comesOff === null).length;
      expect(p.org.fortyMan.count + added).toBeLessThanOrEqual(40);
      // The places go by fit, so the man held is the lowest-fit of the five, and he keeps his Rule 5 date,
      // on the card and on the strip
      expect(protects.map((m) => m.player.player_id)).not.toContain(98078);
      expect(held[0].key).toBe('protect:98078:40man');
      expect(held[0].deadline).toMatchObject({
        kind: 'rule5', date: PLAN.dates.rule5, what: `Rule 5 draft — ${held[0].player.name} is exposed unless a 40-man place opens`,
      });
      expect(p.deadlines.find((d) => d.moveKey === held[0].key)?.date).toBe(PLAN.dates.rule5);
    });
  });

  it('protects by fit, so a lower-fit man who walks earlier does not jump a better one', async () => {
    // The lowest-fit of the men worth a place becomes a minor-league free agent at the Triple-A season's end
    const walker = 98078;
    await inScenario(() => {
      // One place open and one man to come off: two protections, then holds (the fourth filler,
      // 98083, was worth a place himself, so the two left are the Triple-A 54 and the Double-A 52)
      fillForty(4);
      keepTripleATrades();
      db.prepare(`UPDATE players_roster_status SET pro_service_years = 6 WHERE player_id = ?`).run(walker);
    }, async () => {
      const p = await plan();
      const protects = p.moves.filter((m) => m.kind === 'protect');
      expect(protects.map((m) => m.player.player_id)).toEqual([98088, PLAN_MEN.rule5Grade]);
      expect(protects.map((m) => m.fortyMan)).toEqual([
        { count: 39, limit: 40, comesOff: null },
        { count: 40, limit: 40, comesOff: { player_id: PLAN_MEN.farmOutOfOptions, name: 'Triples Man2', why: 'out of options' } },
      ]);
      // He walks first, but two better men are ahead of him: his card is the hold, dated when he can walk
      const [held] = movesOf(p, walker);
      expect(held.kind).toBe('hold');
      expect(held.key).toBe(`protect:${walker}:40man`);
      expect(held.reasons[0]).toBe(
        'Worth a 40-man place before he becomes a minor-league free agent, but the 40-man would be full: 40 of 40 after the two protections above and nobody on it can cheaply give up his place.'
      );
      expect(held.deadline).toMatchObject({ kind: 'minor-fa', date: PLAN.seasonEnd.aaa });
    });
  });

  it('counts the place a trade of a 40-man man frees before the Rule 5 draft, and says so', async () => {
    await inScenario(() => {
      // The 40 is full; the plan trades the man out of options by the deadline, and nobody else
      fillForty();
      regrade(AAA_TRADED.surplus, 44, 47);
    }, async () => {
      const p = await plan();
      expect(p.org.fortyMan).toEqual({ count: 40, limit: 40 });
      const trade = movesOf(p, AAA_TRADED.outOfOptions).find((m) => m.kind === 'trade')!;
      expect(trade.deadline).toMatchObject({ kind: 'trade-deadline', date: PLAN.dates.tradeDeadline });
      const protects = p.moves.filter((m) => m.kind === 'protect');
      expect(protects.map((m) => m.fortyMan)).toEqual([{ count: 39, limit: 40, comesOff: null }]);
      expect(protects[0].reasons[0]).toContain(
        'The 40-man would hold 39 of 40, counting the place the trade of Triples Man2 frees, so a place is open;'
      );
      // He is going, so he is not also the man who comes off for the next one
      const held = p.moves.filter((m) => m.kind === 'hold' && m.to.rung === '40man');
      expect(held.length).toBeGreaterThan(0);
      expect(held[0].reasons[0]).toBe(
        'Worth a 40-man place before the Rule 5 draft, but the 40-man would be full: 40 of 40 after the protection above, counting the place the trade of Triples Man2 frees, and nobody on it can cheaply give up his place.'
      );
    });
  });

  it('takes no place for a man who passes the gate but whom the plan lets go, so the next count does not skip him', async () => {
    const id = PLAN_MEN.dslTwoStepsShort;
    await inScenario(() => {
      // A 52 ceiling and four years of protection used up: worth a place on the grade, but two steps up is too far
      db.prepare(`UPDATE players_roster_status SET years_protected_from_rule_5 = 4 WHERE player_id = ?`).run(id);
      regrade(id, 25, 52);
      // A man who passes the gate with a lower fit, so a protection is judged after him
      regrade(98078, 12, 52);
    }, async () => {
      const p = await plan();
      const cards = movesOf(p, id);
      expect(cards.map((m) => m.kind)).toEqual(['release']);
      expect(cards[0].reasons).toContain(
        'Rule 5 eligible this winter (4 pro years, protected for 4) and not on the 40-man; the grade would earn him a place, but the plan lets him go first.'
      );
      // The protections count on from the 40-man as it stands, less the two places the plan's trades free, with no gap for him
      const protects = p.moves.filter((m) => m.kind === 'protect');
      const counts = protects.map((m) => m.fortyMan?.count);
      expect(counts).toHaveLength(4);
      expect(counts).toEqual(counts.map((_, i) => p.org.fortyMan.count - 2 + i));
      // The last of them is judged after him, and counts only the three protections above
      const last = protects[3];
      expect(last.player.player_id).toBe(98078);
      expect(last.reasons[0]).toContain(`would hold ${p.org.fortyMan.count + 1} of 40 after the three protections above`);
    });
  });

  it('states the 40-man count on his 40-man card only, so every count of the protections above matches the cards listed above it', async () => {
    const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
    /** "after the protection above" is one, "after the call-up and the three protections above" three. */
    const audit = (p: Plan): void => {
      p.moves.forEach((m, i) => {
        const above = p.moves.slice(0, i).filter((x) => x.kind === 'protect').length;
        for (const r of m.reasons) {
          const hit = /after (?:the (?:\w+ )?call-ups? and )?the (?:(\w+) )?protections? above/.exec(r);
          if (hit) expect(hit[1] ? WORDS.indexOf(hit[1]) : 1, `${m.key}: ${r}`).toBe(above);
        }
      });
    };
    const pointer = 'His 40-man place is asked on a card of its own, linked to this one;';
    // Forced up by the High-A cap and worth a place: the forced card is listed before every protection
    const capped = PLAN_MEN.highACapped;
    await inScenario(() => regrade(capped, 40, 52), async () => {
      const p = await plan();
      audit(p);
      const forced = p.moves.findIndex((m) => m.key === `forced:${capped}:high-a:aa`);
      const forty = p.moves.findIndex((m) => m.key === `protect:${capped}:40man`);
      expect(forced).toBeGreaterThanOrEqual(0);
      expect(p.moves[forty].kind).toBe('protect');
      expect(p.moves[forty].fortyMan!.count).toBeGreaterThan(p.org.fortyMan.count - 2);
      expect(forced).toBeLessThan(p.moves.findIndex((m) => m.kind === 'protect'));
      const line = p.moves[forced].reasons.find((r) => r.startsWith('Rule 5 eligible'))!;
      expect(line).toContain(pointer);
      expect(line).not.toMatch(/of 40/);
    });
    // Promoted to Triple-A on merit and protected first: the promotion is listed after every protection
    const id = PLAN_MEN.rule5Grade;
    await inScenario(() => regrade(id, 46, 56), async () => {
      const p = await plan();
      audit(p);
      const up = p.moves.findIndex((m) => m.key === `promote:${id}:aa:aaa`);
      expect(up).toBeGreaterThan(p.moves.map((m) => m.kind).lastIndexOf('protect'));
      const line = p.moves[up].reasons.find((r) => r.startsWith('Rule 5 eligible'))!;
      expect(line).toContain(pointer);
      expect(line).not.toMatch(/of 40/);
      // His own card keeps the count
      expect(p.moves.find((m) => m.key === `protect:${id}:40man`)!.reasons[0]).toMatch(/would hold \d+ of 40/);
    });
  });

  it('dates a protection at season end for a man who becomes a minor-league free agent then', async () => {
    const id = PLAN_MEN.rule5Grade;
    await inScenario(() => {
      // Six pro years on a minor-league deal: he walks when the Double-A season ends
      db.prepare(`UPDATE players_roster_status SET pro_service_years = 6 WHERE player_id = ?`).run(id);
    }, async () => {
      const p = await plan();
      const m = movesOf(p, id).find((x) => x.kind === 'protect')!;
      expect(m).toBeDefined();
      expect(m.deadline).toMatchObject({ kind: 'minor-fa', date: PLAN.seasonEnd.aa });
      expect(m.deadline?.what).toBe('Minor-league free agent after the season — add Doubles Man12 to the 40-man or re-sign him');
      expect(m.reasons[0].startsWith(
        `A minor-league free agent after this season: 6 pro seasons on a minor-league deal, so he can walk when the Double-A season ends on ${PLAN.seasonEnd.aa}, before the Rule 5 draft on ${PLAN.dates.rule5}, unless he is added to the 40-man or re-signed.`
      )).toBe(true);
      expect(m.ootpSteps).toContain(`Transactions → Add to 40-Man Roster, before ${PLAN.seasonEnd.aa}`);
      expect(p.deadlines.find((d) => d.moveKey === m.key)?.date).toBe(PLAN.seasonEnd.aa);
    });
  });

  it('protects a 41 with a 43 ceiling when his index is 110 or better', async () => {
    const id = PLAN_MEN.rule5Depth;
    await inScenario(() => {
      regrade(id, 41, 43);
      // Three seasons of hitting thirty grades above every league he played in
      rewriteBatting(id, 70, [[PLAN.season, 'aa', 158], [PLAN.season - 1, 'highA', 450], [PLAN.season - 2, 'singleA', 405]]);
    }, async () => {
      const p = await plan();
      const m = movesOf(p, id).find((x) => x.kind === 'protect')!;
      expect(m).toBeDefined();
      const index = /at a 43 ceiling the grade alone would not earn it — the index of (\d+) does\.$/.exec(m.reasons[0]);
      expect(index, m.reasons[0]).not.toBeNull();
      expect(Number(index![1])).toBeGreaterThanOrEqual(110);
      expect(m.reasons[0].startsWith(`Rule 5 eligible on ${PLAN.dates.rule5}: 5 pro seasons against 4 years of protection, not on the 40-man.`)).toBe(true);
    });
  });

  it('gives a 40-ceiling man with no sample a reason line and no protection', async () => {
    const id = PLAN_MEN.rule5Depth;
    await inScenario(() => {
      // Nothing to read, and a grade that makes him surplus so he has a card to carry the line
      db.prepare(`DELETE FROM players_career_batting_stats WHERE player_id = ?`).run(id);
      regrade(id, 30, 40);
    }, async () => {
      const p = await plan();
      expect(movesOf(p, id).filter((m) => m.kind === 'protect')).toEqual([]);
      const cards = movesOf(p, id);
      expect(cards.length).toBeGreaterThan(0);
      for (const c of cards) {
        expect(c.reasons).toContain(
          `Rule 5 eligible this winter (5 pro years, protected for 4) and not on the 40-man; at 30 with a 40 ceiling he does not meet the gate of POT 50 or OA 40 with an index of 110, so no 40-man place is recommended — he is exposed on ${PLAN.dates.rule5} unless the grade moves.`
        );
        expect(c.reasons.some((r) => r.includes('production index'))).toBe(false);
      }
    });
  });

  it('dates every protection from the big league\'s row, never a farm row\'s stale date', async () => {
    const p = await plan();
    const stale = (db.prepare(`SELECT DISTINCT rule_5_draft_date AS d FROM leagues WHERE league_id IN (?, ?)`).all(PLAN.leagues.aa, PLAN.leagues.dsl) as Array<{ d: string }>).map((r) => r.d);
    expect(stale).toEqual(['2028-12-1']);
    const protects = p.moves.filter((m) => m.kind === 'protect');
    expect(protects.length).toBeGreaterThan(0);
    for (const m of protects) {
      // Nobody here walks as a minor-league free agent first (that case is dated at season end, above)
      expect(m.deadline?.kind, m.key).toBe('rule5');
      expect(m.deadline?.date, m.key).toBe(PLAN.dates.rule5);
    }
  });
});

/**
 * The group a card's man counts in at the club he leaves, read from his row
 * there: a pitcher by the class he has at that club today, a position player
 * by his listed position.
 */
const groupAtFrom = (p: Plan, m: PlanMove): 'C' | 'IF' | 'OF' | 'SP' | 'RP' => {
  const r = level(p, m.from.rung).roster.find((x) => x.player_id === m.player.player_id)!;
  if (r.positionName === 'LHP' || r.positionName === 'RHP') return r.utility === 'RP' ? 'RP' : 'SP';
  return r.positionName === 'C' ? 'C' : ['LF', 'CF', 'RF'].includes(r.positionName) ? 'OF' : 'IF';
};

/**
 * No club the plan takes a man from to fill another ends short because of it:
 * the club he leaves keeps its catchers, infielders, outfielders, starters
 * and relievers, and its size. The DSL pair, which nothing refills, is left
 * to the balance tests.
 */
function expectNoHoleFromRefills(p: Plan): void {
  for (const m of p.moves.filter((x) => (x.kind === 'promote' || x.kind === 'cover') && x.horizon === 'now')) {
    const from = level(p, m.from.rung);
    if (!from.structure.length || from.clubs) continue;
    const g = groupAtFrom(p, m);
    const row = from.structure.find((s) => s.group === g)!;
    expect(row.have, `${m.key} leaves ${from.label} with ${row.have} of ${row.need} ${g}`).toBeGreaterThanOrEqual(row.need);
    expect(from.planned.roster, `${m.key} leaves ${from.label} under its minimum`).toBeGreaterThanOrEqual(from.target.min);
  }
}

describe('refills and releases', () => {
  it('leaves no club short of a group or its minimum because a man was taken from it', async () => {
    expectNoHoleFromRefills(await plan());
  });

  /**
   * Triple-A down to two catchers, one of them out of options on the 40-man, so the trade needs
   * a catcher from Double-A, which has exactly its two. High-A has three catchers against the two
   * it needs, all depth men, so none is released and its third is still there when the trade is
   * judged: Double-A could be refilled from High-A in a balance turn, but the balance has run, so
   * nothing would bring him up behind the move.
   */
  const tradeWithNoFill = (): void => {
    removePlannerMan(PLAN_MEN.aaaCatchers[2]);
    for (const [k, position] of [7, 8, 9, 7].entries()) {
      addPlannerMan({ id: PLAN.spareFrom + k, club: 'aaa', position, age: 25, oa: 42, pot: 45, proYears: 5 });
    }
    removePlannerMan(98122);
    removePlannerMan(98123);
    for (const id of [98180, 98181, 98182]) {
      regrade(id, 34, 40);
      db.prepare('UPDATE players SET age = 23 WHERE player_id = ?').run(id);
    }
  };
  const CANNOT_COVER =
    'Planner Triples cannot cover his place from below: he is the second catcher there, trading him would leave one against the two the level needs, and every catcher below who could come up would leave his own club short.';

  it('holds a trade the club cannot make good from below, rather than drain the club below', async () => {
    const outOfOptions = PLAN_MEN.farmOutOfOptions;
    await inScenario(tradeWithNoFill, async () => {
      const p = await plan();
      const cards = movesOf(p, outOfOptions);
      expect(cards.map((m) => m.kind)).toEqual(['hold']);
      expect(cards[0].reasons[0]).toBe(CANNOT_COVER);
      expect(p.moves.filter((m) => (m.kind === 'promote' || m.kind === 'cover') && m.to.rung === 'aaa' && m.player.positionName === 'C')).toEqual([]);
      expect(level(p, 'aa').structure.find((s) => s.group === 'C')).toMatchObject({ have: 2, need: 2, tone: 'ok' });
      // High-A's third catcher was still there to make the refill look possible
      expect(level(p, 'high-a').structure.find((s) => s.group === 'C')).toMatchObject({ have: 3, need: 2 });
      expectNoHoleFromRefills(p);
    });
  });

  it('says first that the club cannot cover his place, even when a poor season holds him too', async () => {
    const outOfOptions = PLAN_MEN.farmOutOfOptions;
    await inScenario(() => {
      tradeWithNoFill();
      // His lines become the last-option man's poor ones, so a poor-season hold is written for him first
      db.prepare('DELETE FROM players_career_batting_stats WHERE player_id = ?').run(outOfOptions);
      db.exec(`CREATE TEMP TABLE poor AS SELECT * FROM players_career_batting_stats WHERE player_id = ${PLAN_MEN.lastOptionYear};
        UPDATE poor SET player_id = ${outOfOptions};
        INSERT INTO players_career_batting_stats SELECT * FROM poor;
        DROP TABLE poor;`);
    }, async () => {
      const p = await plan();
      const cards = movesOf(p, outOfOptions);
      expect(cards.map((m) => m.kind)).toEqual(['hold']);
      expect(cards[0].reasons[0]).toBe(CANNOT_COVER);
      // The poor season is still said, after it
      expect(cards[0].reasons.some((r) => r.includes('the season verdict is poor'))).toBe(true);
      expect(level(p, 'aa').structure.find((s) => s.group === 'C')).toMatchObject({ have: 2, need: 2, tone: 'ok' });
    });
  });

  it('promises a refill to one pull only, so two pulls cannot both count on the same man below', async () => {
    await inScenario(() => {
      // Double-A has no catcher and needs two; High-A has exactly its two, and Single-A one to spare.
      // The first pull takes a High-A catcher and counts on Single-A's spare to refill High-A; the
      // second may not count on the same man
      for (const id of [...PLAN_MEN.aaCatchers, 98180]) removePlannerMan(id);
    }, async () => {
      const p = await plan();
      const intoAa = p.moves.filter((m) => m.to.rung === 'aa' && m.from.rung === 'high-a' && m.player.positionName === 'C');
      expect(intoAa).toHaveLength(1);
      const intoHighA = p.moves.filter((m) => m.to.rung === 'high-a' && m.from.rung === 'single-a' && m.player.positionName === 'C');
      expect(intoHighA).toHaveLength(1);
      // The club short of a catcher is the one that was short, not the one that gave a man up
      expect(level(p, 'high-a').structure.find((s) => s.group === 'C')).toMatchObject({ have: 2, need: 2 });
      expect(level(p, 'single-a').structure.find((s) => s.group === 'C')).toMatchObject({ have: 2, need: 2 });
      expect(level(p, 'aa').structure.find((s) => s.group === 'C')).toMatchObject({ have: 1, need: 2, tone: 'bad' });
      expect(level(p, 'aa').needs.some((n) => n.includes('a catcher'))).toBe(true);
      expectNoHoleFromRefills(p);
    });
  });

  it('never lets a pull take the free place a refill promised to another club counted on', async () => {
    await inScenario(() => {
      // Triple-A one catcher short. Double-A has exactly its two catchers and nobody who
      // plays first base; High-A has a catcher to spare but only one place above its size
      // minimum; Single-A stands at its minimum, with nobody at the Complex ready for it.
      // Triple-A's catcher pull counts on High-A's spare catcher to refill Double-A, so
      // Double-A's own first-base pull may not take High-A's one free place first
      for (const id of [98061, 98062, 98122, 98123, 98127, 98131, 98184, 98191, 98199, 98242, 98261, 98264, 98314, 98325, 98306]) {
        removePlannerMan(id);
      }
    }, async () => {
      const p = await plan();
      const intoAaa = p.moves.filter((m) => m.to.rung === 'aaa' && m.from.rung === 'aa' && m.player.positionName === 'C');
      expect(intoAaa.map((m) => m.key)).toEqual(['promote:98121:aa:aaa']);
      // The refill it counted on came, and nothing took his place first
      expect(movesOf(p, 98181).map((m) => m.key)).toEqual(['promote:98181:high-a:aa']);
      expect(movesOf(p, 98186).filter((m) => m.to.rung === 'aa')).toEqual([]);
      expect(level(p, 'aa').structure.find((s) => s.group === 'C')).toMatchObject({ have: 2, need: 2, tone: 'ok' });
      expect(level(p, 'aa').needs.some((n) => n.includes('a catcher'))).toBe(false);
      expect(level(p, 'high-a').planned.roster).toBeGreaterThanOrEqual(level(p, 'high-a').target.min);
      expectNoHoleFromRefills(p);
    });
  });

  it('keeps a refill promised until he moves, so a second pull from the same club cannot count on him again', async () => {
    await inScenario(() => {
      // The scenario above, with one man more at Single-A, so it can refill High-A once, and
      // nobody at Double-A who plays second base. Triple-A's catcher pull counts on High-A's
      // spare catcher to refill Double-A; Double-A's first-base pull then takes a High-A man
      // and counts on Single-A's one spare man to refill High-A. Double-A's second-base pull
      // may not count on that same Single-A man again while the catcher he stands behind is
      // still at High-A
      for (const id of [98061, 98062, 98122, 98123, 98127, 98131, 98184, 98191, 98199, 98242, 98261, 98264, 98314, 98325, 98306]) {
        removePlannerMan(id);
      }
      addPlannerMan({ id: PLAN.spareFrom, club: 'singleA', position: 7, age: 21, oa: 35, pot: 45, proYears: 2 });
      db.prepare('UPDATE players_fielding SET fielding_rating_pos4 = 30 WHERE player_id IN (SELECT player_id FROM players WHERE team_id = ?) OR player_id = 98244')
        .run(PLAN.teams.aa);
    }, async () => {
      const p = await plan();
      const keys = p.moves.map((m) => m.key);
      expect(['promote:98189:high-a:aa', 'promote:98186:high-a:aa'].filter((k) => keys.includes(k)).length).toBeLessThanOrEqual(1);
      expect(keys).toContain('promote:98181:high-a:aa');
      expect(level(p, 'aa').structure.find((s) => s.group === 'C')).toMatchObject({ have: 2, need: 2, tone: 'ok' });
      expectNoHoleFromRefills(p);
    });
  });

  it('refuses a pull whose leaving breaks two groups when only one can be refilled', async () => {
    const shortstop = 98184;
    const noShort = (ids: number[]): void => {
      for (const id of ids) db.prepare('UPDATE players_fielding SET fielding_rating_pos6 = 30 WHERE player_id = ?').run(id);
    };
    await inScenario(() => {
      // Double-A: eleven infielders, but nobody who can play shortstop
      noShort([98124, 98125, 98128, 98129, 98132, 98133, 98244]);
      // High-A: exactly its six infielders, and one of them, 98184, the only man who plays shortstop
      noShort([98183, 98187, 98188]);
      for (const id of [98185, 98190]) db.prepare('UPDATE players SET position = 7 WHERE player_id = ?').run(id);
      // Single-A: two places over its minimum and infielders to spare, but its one shortstop
      // (98243, forced up after the season) is all it has at the position
      noShort([98247, 98248]);
      for (const k of [0, 1]) {
        addPlannerMan({ id: PLAN.spareFrom + k, club: 'singleA', position: 1, role: 12, age: 22, oa: 36, pot: 48, proYears: 2 });
      }
    }, async () => {
      const p = await plan();
      // Single-A could refill High-A's infield, but nobody below could refill its shortstop
      expect(movesOf(p, shortstop)).toEqual([]);
      expect(level(p, 'high-a').structure.find((s) => s.group === 'SS cover')).toMatchObject({ have: 1, need: 1, tone: 'ok' });
      expect(level(p, 'high-a').structure.find((s) => s.group === 'IF')).toMatchObject({ have: 6, need: 6, tone: 'ok' });
      // The club that was short says so, and the club below is not drained to fill it
      expect(level(p, 'aa').structure.find((s) => s.group === 'SS cover')).toMatchObject({ have: 0, tone: 'bad' });
      expect(level(p, 'aa').needs).toHaveLength(1);
      expectNoHoleFromRefills(p);
    });
  });

  it('counts the men at a released man\'s club in the class each plays there in the plan, as the release was judged', async () => {
    // A Complex starter on stamina alone with one rated pitch, graded well past the Single-A median:
    // the plan promotes him, and at Single-A, without a third pitch, he is a reliever. Single-A's
    // surplus relievers are released, and each card counts the relievers the club will carry,
    // him among them, so its count agrees with the minimum the release was judged against
    const arm = 98319;
    const promoteArm = (): void => {
      db.prepare(
        `UPDATE players_pitching SET pitching_ratings_pitches_slider = 0, pitching_ratings_pitches_changeup = 0,
                pitching_ratings_pitches_curveball = 0 WHERE player_id = ?`
      ).run(arm);
      regrade(arm, 45, 60);
    };
    const peerSentence = async (): Promise<string> => {
      const p = await plan();
      const [card] = movesOf(p, 98267);
      expect(card.kind).toBe('release');
      expect(row(p, 'single-a', 98267)).toMatchObject({ status: 'leaves', utility: 'RP' });
      return card.reasons[1];
    };
    // An old reliever more at Single-A, so the club has relievers to let go
    const oldArm = (): void => addPlannerMan({ id: PLAN.spareFrom, club: 'singleA', position: 1, role: 12, age: 27, oa: 24, pot: 24, proYears: 4 });
    await inScenario(oldArm, async () => {
      expect(await peerSentence()).toBe('Seventh of eight relievers at Planner Singles, six of the others graded above him; releasing him leaves seven against the seven the level needs.');
    });
    await inScenario(() => { oldArm(); promoteArm(); }, async () => {
      const p = await plan();
      expect(movesOf(p, arm).map((m) => m.key)).toEqual([`promote:${arm}:complex:single-a`]);
      expect(row(p, 'complex', arm)).toMatchObject({ status: 'leaves', utility: 'SP' });
      expect(row(p, 'single-a', arm)).toMatchObject({ status: 'arrives', utility: 'RP' });
      expect(await peerSentence()).toBe('Eighth of nine relievers at Planner Singles, seven of the others graded above him; releasing him leaves eight against the seven the level needs.');
    });
  });

  it('releases the lowest-fit of equal surplus men at a club held to its minimum, whatever their ids', async () => {
    const [first, second, lowest] = [PLAN.spareFrom, PLAN.spareFrom + 1, PLAN.spareFrom + 2];
    await inScenario(() => {
      // Three old relievers alike but for the grade, the lowest graded with the highest id, at a
      // DSL club five infielders short, so its size has room for one of them to go
      for (const [k, oa] of [26, 25, 24].entries()) {
        addPlannerMan({ id: PLAN.spareFrom + k, club: 'dslA', position: 1, role: 12, age: 24, oa, pot: 24, proYears: 2, protectedYears: 5 });
      }
      for (const id of [98365, 98366, 98367, 98369, 98370]) removePlannerMan(id);
    }, async () => {
      const p = await plan();
      expect(movesOf(p, lowest).map((m) => m.kind)).toEqual(['release']);
      for (const id of [first, second]) {
        const [m] = movesOf(p, id);
        expect(m.kind, String(id)).toBe('hold');
        expect(m.reasons[0]).toBe(
          'Kept for size: DSL Planner Uno stands at 30 against a minimum of 30, and releasing him would put it under the band with no level below to fill it.'
        );
      }
    });
  });
});

describe('the big club\'s tie-break', () => {
  it('lists the catcher first of two equal call-ups when the 26 carries one catcher, and says why on his card', async () => {
    const [infielder, , catcher] = PLAN_MEN.aaaCatchers;
    await inScenario(() => {
      // One catcher left on the 26, so catcher is the big club's thinnest spot
      removePlannerMan(PLAN_MEN.mlbCatchers[1]);
      // Two Triple-A men of the same grade, age and lines, the lower id a shortstop: only the tie-break puts the catcher first
      db.prepare(`UPDATE players SET position = 6, age = 25 WHERE player_id = ?`).run(infielder);
      db.prepare(`UPDATE players SET age = 25 WHERE player_id = ?`).run(catcher);
      db.prepare(`DELETE FROM players_fielding WHERE player_id = ?`).run(infielder);
      db.prepare(
        `INSERT INTO players_fielding (player_id, position, fielding_rating_pos6, fielding_rating_pos6_pot, fielding_rating_pos4, fielding_rating_pos4_pot, fielding_experience6)
         VALUES (?, 6, 55, 60, 50, 55, 150)`
      ).run(infielder);
      for (const id of [infielder, catcher]) {
        regrade(id, 60, 62);
        rewriteBatting(id, 60, [[PLAN.season, 'aaa', 158], [PLAN.season - 1, 'aa', 450], [PLAN.season - 2, 'highA', 405]]);
      }
    }, async () => {
      const p = await plan();
      expect(p.org.mlbThinnest).toContain('C');
      const ups = p.moves.filter((m) => m.kind === 'callup');
      expect(ups.map((m) => m.player.player_id)).toEqual([catcher, infielder]);
      expect(ups[0].player.positionName).toBe('C');
      expect(ups[0].reasons).toContain('Ahead of the other candidates because the big club is thinnest at C, and he covers it.');
      expect(ups[1].reasons.some((r) => r.includes('thinnest'))).toBe(false);
      // Equal on everything the fit reads: the two cards quote the same index and grade
      expect(ups[0].reasons.find((r) => r.startsWith('Grades'))).toBe(ups[1].reasons.find((r) => r.startsWith('Grades')));
    });
  });
});

describe('men already on their way out', () => {
  it('lists a designated man under leaving and plans nothing for him', async () => {
    const id = 98075;
    await inScenario(() => {
      db.prepare(`UPDATE players_roster_status SET designated_for_assignment = 1, days_on_dfa_left = 5 WHERE player_id = ?`).run(id);
    }, async () => {
      const p = await plan();
      expect(p.leaving).toEqual([{ player_id: id, name: 'Triples Man16', why: 'designated for assignment, 5 days to resolve' }]);
      expect(movesOf(p, id)).toEqual([]);
      expect(row(p, 'aaa', id).frozen).toBe(true);
    });
  });

  it('lists a waiver man the same way', async () => {
    const id = 98076;
    await inScenario(() => {
      db.prepare(`UPDATE players_roster_status SET is_on_waivers = 1, days_on_waivers_left = 3 WHERE player_id = ?`).run(id);
    }, async () => {
      const p = await plan();
      expect(p.leaving).toEqual([{ player_id: id, name: 'Triples Man17', why: 'on waivers, 3 days left' }]);
      expect(movesOf(p, id)).toEqual([]);
    });
  });
});

describe('what the export cannot support', () => {
  it('plans sizes without roster status, says so, and applies no cap, option or Rule 5 rule', async () => {
    await inScenario(() => {
      db.exec(`DROP TABLE players_roster_status`);
    }, async () => {
      const p = await plan();
      expect(p.warnings).toContain('roster status not exported; service-time, option and Rule 5 rules are off');
      expect(p.levels.map((l) => l.rung)).toEqual(['mlb', 'aaa', 'aa', 'high-a', 'single-a', 'complex', 'dsl', 'ic']);
      expect(level(p, 'aa').now.roster).toBe(38);
      expect(p.counts.forced).toBe(0);
      expect(p.counts.protect).toBe(0);
      expect(p.moves.filter((m) => m.deadline?.kind === 'service-cap')).toEqual([]);
      for (const l of p.levels) for (const r of l.roster) expect(r.lastEligibleSeason, `${l.rung} ${r.name}`).toBeNull();
      expect(p.releaseOrTrade.flatMap((r) => r.modifiers)).toEqual([]);
    });
  });

  it('404s an org without a big-league club', async () => {
    const res = await fetch(`http://127.0.0.1:${process.env.OOTP_FO_PORT}/api/plan/424242`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Unknown org' });
  });
});
