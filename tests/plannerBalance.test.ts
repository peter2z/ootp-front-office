import { beforeAll, describe, expect, it } from 'vitest';
// The planner first: history.ts reaches dashboard.ts for DATE_KEY, dashboard.ts
// reaches the planner, and the planner's decision store reaches history.ts —
// a ring that only loads when it is entered here and not at history.ts
import { clearPlanCache } from '../server/planner.js';
import { db } from '../server/db.js';
import { historyDb } from '../server/history.js';
import type { Plan, PlanLevel, PlanMove } from '../server/planTypes.js';
import request, { post } from './request.js';
import { PLAN, PLAN_MEN, addPlannerMan, inScenario, removePlannerMan, seedPlannerOrg } from './plannerFixture.js';

/**
 * The balance, through HTTP, on the synthetic org: the size band with its
 * hard minimum and soft maximum, the structure minimums counted on healthy
 * men, the eight-position cover check, the cascade, the DSL pair, the needs
 * nobody below can fill, the staff sort, and the three things every plan
 * must be — full of reasons, byte-identical, and quick.
 */

const plan = async (): Promise<Plan> => (await request(`/api/plan/${PLAN.org}?show=all`)) as Plan;
const level = (p: Plan, rung: string): PlanLevel => p.levels.find((l) => l.rung === rung)!;
const leaving = (l: PlanLevel) => l.roster.filter((r) => r.status === 'leaves');
const movesOf = (p: Plan, id: number): PlanMove[] => p.moves.filter((m) => m.player.player_id === id);

/** Puts a minor leaguer on the injured list the way an export shows it: list 4, the flag, the days. */
function injure(id: number, team: number, days: number): void {
  db.prepare(`UPDATE players SET injury_is_injured = 1, injury_left = ? WHERE player_id = ?`).run(days, id);
  db.prepare(`UPDATE players_roster_status SET is_on_dl = 1 WHERE player_id = ?`).run(id);
  db.prepare(`DELETE FROM team_roster WHERE player_id = ? AND list_id = 2`).run(id);
  db.prepare(`INSERT INTO team_roster VALUES (?, ?, 4)`).run(team, id);
}

/** Regrades a man: OOTP's exact and rounded grades and his overall value together. */
function regrade(id: number, oa: number, pot: number): void {
  db.prepare(
    `UPDATE players_value SET oa = ?, pot = ?, oa_rating = ?, pot_rating = ?, overall_value = ?, talent_value = ? WHERE player_id = ?`
  ).run(oa, pot, Math.round(oa / 5) * 5, Math.round(pot / 5) * 5, oa * 20, pot * 20, id);
}

/** The club each man of a level stands at once the moves dated now are made: his club today, or the club a move sends him to. */
function plannedClubs(p: Plan, l: PlanLevel): Map<number, number> {
  const today = new Map(
    (db.prepare(`SELECT player_id, team_id FROM players WHERE team_id IN (${l.teamIds.map(() => '?').join(', ')})`).all(...l.teamIds) as
      Array<{ player_id: number; team_id: number }>).map((r) => [r.player_id, r.team_id])
  );
  const out = new Map<number, number>();
  for (const r of l.roster) {
    if (r.status === 'leaves') continue;
    const arrival = p.moves.find((m) => m.player.player_id === r.player_id && m.horizon === 'now' && m.to.rung === l.rung && m.kind !== 'hold' && m.kind !== 'protect');
    const club = r.status === 'arrives' ? arrival?.to.team_id ?? null : today.get(r.player_id) ?? null;
    if (club !== null) out.set(r.player_id, club);
  }
  return out;
}

/** The positions a man covers today, rated 40 or better, from the fielding rows. */
function coversToday(id: number): Set<number> {
  const row = db.prepare(`SELECT * FROM players_fielding WHERE player_id = ?`).get(id) as Record<string, number | null> | undefined;
  const out = new Set<number>();
  for (let pos = 2; pos <= 9; pos++) if ((row?.[`fielding_rating_pos${pos}`] ?? 0) >= 40) out.add(pos);
  return out;
}

/** Ordinary Triple-A men at the positions given, as many as take the club to its soft maximum so nothing is promoted into it. */
function fillTripleA(positions: number[] = [7, 8, 9]): void {
  for (const [k, position] of positions.entries()) {
    addPlannerMan({ id: 98540 + k, club: 'aaa', position, age: 25, oa: 42, pot: 45, proYears: 5 });
  }
}

beforeAll(async () => {
  await request('/api/status');
  seedPlannerOrg();
  historyDb.prepare(`DELETE FROM plan_decisions`).run();
});

describe('the size band: minimum hard, maximum soft', () => {
  it('moves exactly the three surplus men out of a Double-A roster of 38 against 35, lowest fits first, and tones the card warn', async () => {
    await inScenario(() => {
      fillTripleA();
      // The one other Double-A man the grade calls surplus becomes depth, so the three named men are the only ones
      regrade(98153, 36, 44);
      // The man over the Single-A cap goes to Double-A now; this case counts Double-A's own men
      removePlannerMan(PLAN_MEN.singleAOver);
    }, async () => {
      const p = await plan();
      const aa = level(p, 'aa');
      expect(aa.now.roster).toBe(38);
      expect(aa.target).toEqual({ min: 28, max: 35 });
      expect(leaving(aa).map((r) => r.player_id).sort()).toEqual([...PLAN_MEN.surplus]);
      for (const r of leaving(aa)) expect(r.assetClass, r.name).toBe('surplus');
      expect(aa.planned.roster).toBe(35);
      expect(aa.tone).toBe('warn');
      // Lowest fit first: the roster sizes the three sentences quote count down from 38
      const pushed = PLAN_MEN.surplus.map((id) => movesOf(p, id)[0]);
      const sizes = pushed.map((m) => Number(/Planner Doubles is (\d+) against a soft maximum of 35/.exec(m.reasons[0])![1]));
      const fits = pushed.map((m) => Number(/lowest-fit of them \((-?[\d.]+) at Double-A/.exec(m.reasons[0])![1]));
      const byFit = [...PLAN_MEN.surplus].map((id, i) => ({ id, fit: fits[i], size: sizes[i] })).sort((a, b) => a.fit - b.fit);
      expect(byFit.map((x) => x.size)).toEqual([38, 37, 36]);
      // Eligible nowhere below at eleven years and more, they leave through the list rather than down the ladder
      for (const m of pushed) {
        expect(m.to.rung).toBe('out');
        expect(m.reasons[0]).toContain('so only its surplus men leave for size; he is the lowest-fit of them');
        expect(m.reasons[0]).toContain('He is eligible at no level below');
      }
      expect(p.releaseOrTrade.filter((r) => PLAN_MEN.surplus.includes(r.player_id as never)).map((r) => r.player_id))
        .toEqual(byFit.map((x) => x.id));
      // Each is counted in his own group although the balance has already
      // moved him off the planned roster: one of the outfielders who stay, plus him
      const outfield = aa.structure.find((s) => s.group === 'OF')!.have;
      const words = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
      for (const m of pushed) {
        const count = m.reasons.find((r) => / outfielders at Planner Doubles, /.test(r))!;
        expect(count, m.key).toMatch(new RegExp(` of ${words[outfield + 1]} outfielders at Planner Doubles, `));
        expect(count, m.key).toContain(`releasing him leaves ${words[outfield]} against the five the level needs.`);
        const [ordinal, of] = /^(\w+) of (\w+) outfielders/.exec(count)!.slice(1);
        const rank = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'].indexOf(ordinal) + 1;
        expect(rank, `${m.key}: ${ordinal} of ${of}`).toBeLessThanOrEqual(words.indexOf(of));
      }
    });
  });

  it('moves one surplus man out of 38, says "2 over", and leaves every depth and prospect man where he is', async () => {
    await inScenario(() => {
      fillTripleA();
      regrade(98153, 36, 44);
      removePlannerMan(PLAN_MEN.singleAOver);
      // Two of the three old outfielders keep a ceiling above the median grade: depth, not surplus
      regrade(PLAN_MEN.surplus[0], 36, 40);
      regrade(PLAN_MEN.surplus[1], 36, 40);
    }, async () => {
      const p = await plan();
      const aa = level(p, 'aa');
      expect(aa.now.roster).toBe(38);
      expect(leaving(aa).map((r) => r.player_id)).toEqual([PLAN_MEN.surplus[2]]);
      expect(aa.planned.roster).toBe(37);
      expect(aa.tone).toBe('warn');
      expect(aa.needs).toContain('37 on the planned roster, 2 over the 35 you set; only surplus men are moved for size.');
      for (const r of aa.roster) {
        if (r.assetClass === 'depth' || r.assetClass === 'prospect') expect(r.status, r.name).not.toBe('leaves');
      }
      expect(p.moves.filter((m) => m.kind === 'demote')).toEqual([]);
    });
  });

  it('lets a strong candidate into a full club in place of a surplus man, and holds an ordinary one back', async () => {
    const [strong, ordinary] = [98145, 98137];
    await inScenario(() => {
      fillTripleA();
      // One Double-A man graded well past the Triple-A median: a strong fit there
      regrade(strong, 50, 58);
    }, async () => {
      const p = await plan();
      const up = movesOf(p, strong).find((m) => m.kind === 'promote')!;
      expect(up, 'the strong man goes up').toBeDefined();
      expect(up.to.rung).toBe('aaa');
      expect(up.reasons[0]).toMatch(/^Ready for Triple-A: a fit of [\d.]+ there, a strong one\.$/);
      expect(up.reasons).toContain('Planner Triples carries 35 against a band of 28-35, so a surplus man there makes room for him.');
      // The man who makes room is a surplus man, moved for size
      const out = p.moves.filter((m) => m.from.rung === 'aaa' && /^Planner Triples is 36 against a soft maximum of 35, so only its surplus men leave for size/.test(m.reasons[0]));
      expect(out).toHaveLength(1);
      expect(out[0].player.assetClass).toBe('surplus');
      expect(level(p, 'aaa').planned.roster).toBeLessThanOrEqual(35);
      // A man who is ready but not strongly so waits for room
      expect(movesOf(p, ordinary).filter((m) => m.kind === 'promote')).toEqual([]);
    });
  });

  it('pulls a High-A roster of 25 up to its minimum from Single-A by fit, its one catcher short first', async () => {
    // Two of the three catchers and five infielders go, leaving 25 with one catcher and three infielders
    const gone = [98180, 98181, 98184, 98185, 98186, 98187, 98190];
    // Two Single-A infielders graded well above the rest, so the best two by fit are known before the plan is read
    const best = [98245, 98247];
    await inScenario(() => {
      for (const id of gone) removePlannerMan(id);
      for (const id of best) regrade(id, 40, 50);
    }, async () => {
      const p = await plan();
      const highA = level(p, 'high-a');
      expect(highA.now).toMatchObject({ roster: 25, groups: { C: 1, IF: 3, OF: 6, SP: 6, RP: 9 } });
      const pulls = p.moves.filter((m) => m.kind === 'promote' && m.to.rung === 'high-a');
      expect(pulls.length).toBeGreaterThan(1);
      for (const m of pulls) expect(m.from.rung, m.key).toBe('single-a');
      // The catcher is pulled for the group, not for the size
      const catcher = pulls.find((m) => m.player.positionName === 'C')!;
      expect(catcher, 'a catcher is pulled before the general fill').toBeDefined();
      expect(catcher.reasons[0]).toMatch(
        /^Planner Highs is short of catchers: one against the two the level needs, and he is the best eligible catcher below \(fit -?[\d.]+ at High-A\)\.$/
      );
      expect(highA.planned.roster).toBeGreaterThanOrEqual(28);
      expect(highA.structure.find((s) => s.group === 'C')).toMatchObject({ have: 2, need: 2, tone: 'ok' });
      expect(highA.structure.find((s) => s.group === 'IF')?.tone).toBe('ok');
      expect(highA.tone).not.toBe('bad');
      expect(highA.needs.filter((n) => n.startsWith('Sign'))).toEqual([]);
      // By fit, judged on who was chosen and not on the order the list is
      // printed in: the infielder pulled for the group is one of the two
      // Single-A infielders graded far above the rest
      const forGroup = pulls.filter((m) => m.reasons[0].startsWith('Planner Highs is short of infielders'));
      expect(forGroup.length).toBeGreaterThan(0);
      for (const m of forGroup) expect(best, m.key).toContain(m.player.player_id);
      // By fit: the fits the sentences quote fall in the order the men are listed
      const quoted = pulls
        .map((m) => /a fit of (-?[\d.]+) there|\(fit (-?[\d.]+) at High-A\)/.exec(m.reasons[0]))
        .map((x) => Number(x?.[1] ?? x?.[2] ?? NaN))
        .filter((f) => !Number.isNaN(f));
      expect(quoted.length).toBe(pulls.length);
      expect(quoted).toEqual([...quoted].sort((a, b) => b - a));
    });
  });
});

describe('structure minimums, on healthy men', () => {
  it('does not count an injured catcher toward the minimum, and covers the gap from below', async () => {
    const [first, second] = PLAN_MEN.aaaCatchers;
    await inScenario(() => {
      injure(first, PLAN.teams.aaa, 45);
      injure(second, PLAN.teams.aaa, 45);
    }, async () => {
      const p = await plan();
      const aaa = level(p, 'aaa');
      expect(aaa.now).toMatchObject({ roster: 32, healthy: 29, il: 3 });
      // Four catchers hold places on the planned roster; two of them count
      expect(aaa.roster.filter((r) => r.positionName === 'C' && r.status !== 'leaves')).toHaveLength(4);
      expect(aaa.planned.groups.C).toBe(2);
      expect(aaa.structure.find((s) => s.group === 'C')).toMatchObject({ have: 2, need: 2, tone: 'ok' });
      const cover = p.moves.find((m) => m.kind === 'cover' && m.to.rung === 'aaa')!;
      expect(cover).toBeDefined();
      expect(cover.player.positionName).toBe('C');
      for (const id of [first, second]) expect(aaa.roster.find((r) => r.player_id === id)).toMatchObject({ frozen: true, status: 'stays' });
    });
  });

  it('replaces a release that would leave one catcher with a hold that says kept for structure', async () => {
    const [, second, third] = PLAN_MEN.aaaCatchers;
    await inScenario(() => {
      // Two old catchers with no ceiling, off the 40-man: surplus by any reading.
      // Neither has a line this season, so neither is marked overmatched and
      // demoted to the uncapped Double-A instead of reaching the list. Only one
      // can go, and the one released is the one with the lower fit at Triple-A
      // (the third, on his older lines), whatever the order of their ids
      for (const id of [second, third]) {
        regrade(id, 30, 30);
        db.prepare(`UPDATE players SET age = 35 WHERE player_id = ?`).run(id);
        db.prepare(`UPDATE players_roster_status SET is_on_secondary = 0, options_used = 0, options_used_this_year = 0 WHERE player_id = ?`).run(id);
        db.prepare(`DELETE FROM team_roster WHERE player_id = ? AND list_id = 3`).run(id);
        db.prepare(`DELETE FROM players_career_batting_stats WHERE player_id = ? AND year = ?`).run(id, PLAN.season);
      }
    }, async () => {
      const p = await plan();
      const fitOf = (id: number): number => level(p, 'aaa').roster.find((r) => r.player_id === id)!.fit!;
      expect(fitOf(third)).toBeLessThan(fitOf(second));
      const released = movesOf(p, third);
      expect(released.map((m) => m.kind)).toEqual(['release']);
      const kept = movesOf(p, second);
      expect(kept.map((m) => m.kind)).toEqual(['hold']);
      expect(kept[0].key).toBe(`hold:${second}:aaa:aaa`);
      expect(kept[0].reasons[0]).toBe(
        'Kept for structure: second catcher at Planner Triples, where releasing him would leave one against the two the level needs.'
      );
      expect(level(p, 'aaa').structure.find((s) => s.group === 'C')).toMatchObject({ have: 2, need: 2, tone: 'ok' });
      expect(p.releaseOrTrade.map((r) => r.player_id)).not.toContain(second);
    });
  });

  it('fills a position nobody healthy covers before it counts the groups', async () => {
    await inScenario(() => {
      // Both men who cover centre field go, and the club is filled to its
      // maximum with men who do not, so nobody arrives on merit first
      for (const id of PLAN_MEN.aaaCentreFielders) removePlannerMan(id);
      fillTripleA([7, 9, 3, 7, 9]);
    }, async () => {
      const p = await plan();
      const aaa = level(p, 'aaa');
      expect(aaa.now.roster).toBe(35);
      expect(aaa.now.groups.OF).toBe(8);
      expect(p.moves.filter((m) => m.to.rung === 'aaa' && m.kind === 'promote' && /^Ready for/.test(m.reasons[0]))).toEqual([]);
      const cf = p.moves.find((m) => m.to.rung === 'aaa' && /covers CF/.test(m.reasons[0]))!;
      expect(cf, 'the man who covers centre field').toBeDefined();
      expect(cf.kind).toBe('promote');
      expect(cf.from.rung).toBe('aa');
      expect(cf.player.positionName).toBe('CF');
      expect(cf.reasons[0]).toBe(
        `Nobody healthy on the planned Planner Triples roster covers CF; he is rated 55 there, the best eligible man below (fit ${aaa.roster.find((r) => r.player_id === cf.player.player_id)!.fit} at Triple-A).`
      );
      expect(aaa.structure.find((s) => s.group === 'CF cover')).toMatchObject({ have: 1, need: 1, tone: 'ok' });
      // The outfield was never short, so he is the only man pulled, and for the position alone
      expect(p.moves.filter((m) => m.to.rung === 'aaa' && (m.kind === 'promote' || m.kind === 'cover'))).toEqual([cf]);
      const leaving = p.moves.filter((m) => m.from.rung === 'aaa' && m.to.rung !== 'aaa' && m.kind !== 'hold' && m.kind !== 'protect');
      expect(aaa.planned.roster).toBe(35 + 1 - leaving.length);
    });
  });

  it('counts a man as shortstop cover on his rating today, never on his ceiling alone', async () => {
    // Every Triple-A glove at short becomes 30 now with a 55 ceiling: revealed, worth a job some day, not cover today
    const shortstops = (db.prepare(
      `SELECT f.player_id FROM players_fielding f JOIN players p ON p.player_id = f.player_id
       WHERE p.team_id = ? AND f.fielding_rating_pos6 > 0 ORDER BY f.player_id`
    ).all(PLAN.teams.aaa) as Array<{ player_id: number }>).map((r) => r.player_id);
    await inScenario(() => {
      db.prepare(
        `UPDATE players_fielding SET fielding_rating_pos6 = 30, fielding_rating_pos6_pot = 55
         WHERE player_id IN (${shortstops.map(() => '?').join(', ')})`
      ).run(...shortstops);
    }, async () => {
      expect(shortstops.length).toBeGreaterThan(2);
      const p = await plan();
      const aaa = level(p, 'aaa');
      // The field check finds nobody at short and pulls the best man below who is rated 40 or better there
      const ss = p.moves.find((m) => m.to.rung === 'aaa' && /covers SS/.test(m.reasons[0]))!;
      expect(ss, 'a shortstop pulled from Double-A').toBeDefined();
      expect(ss.from.rung).toBe('aa');
      expect(ss.reasons[0]).toMatch(
        /^Nobody healthy on the planned Planner Triples roster covers SS; he is rated (\d+) there, the best eligible man below \(fit -?[\d.]+ at Triple-A\)\.$/
      );
      expect(Number(/rated (\d+) there/.exec(ss.reasons[0])![1])).toBeGreaterThanOrEqual(40);
      // The cover row counts him alone, and names none of the 30-rated men
      const row = aaa.structure.find((s) => s.group === 'SS cover')!;
      expect(row).toMatchObject({ have: 1, need: 1, tone: 'ok' });
      expect(row.note).toBe(`${ss.player.name} ${/rated (\d+) there/.exec(ss.reasons[0])![1]} once he arrives`);
    });
  });

  it('leaves every club with a healthy man rated 40 or better at each of the eight positions', async () => {
    const p = await plan();
    const FIELD = [2, 6, 8, 5, 4, 9, 7, 3];
    const NAMES: Record<number, string> = { 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF' };
    for (const l of p.levels) {
      if (!l.structure.length) continue;
      const clubs = plannedClubs(p, l);
      for (const club of l.teamIds) {
        const men = l.roster.filter((r) => !r.frozen && clubs.get(r.player_id) === club && r.positionName !== 'LHP' && r.positionName !== 'RHP');
        expect(men.length, `${l.rung} ${club}`).toBeGreaterThan(0);
        const covered = new Set(men.flatMap((r) => [...coversToday(r.player_id)]));
        for (const pos of FIELD) expect(covered.has(pos), `${l.rung} club ${club} at ${NAMES[pos]}`).toBe(true);
      }
    }
  });

  /*
   * The check above passes on the fixture as it is generated, where every club
   * happens to cover all eight positions, so on its own it would pass an engine
   * that looked only at catcher, shortstop, centre field and first base. Each
   * case here takes one of the other four away at Triple-A: every man rated 40
   * or better there is marked down to 30, his ceiling kept, and his listed
   * position, and so his group, unchanged. The club is then filled to its
   * maximum with men who do not play the position, so every group is full and
   * nobody arrives on merit. Only the field check can bring in a man who covers
   * the position, and the card that brings him has to name it.
   *
   * Left field leaves the injured centre fielder his 45 there, so the man who
   * comes up covers until he is back. Right field marks him down with the
   * rest, so there, as at second and third, which he never played, the man who
   * comes up is an ordinary promotion.
   */
  const OPEN_POSITIONS = [
    { pos: 4, name: '2B', fill: [7, 8, 9], kind: 'promote' },
    { pos: 5, name: '3B', fill: [7, 8, 9], kind: 'promote' },
    { pos: 7, name: 'LF', fill: [3, 4, 5], kind: 'cover' },
    { pos: 9, name: 'RF', fill: [3, 4, 5], kind: 'promote' },
  ] as const;
  for (const { pos, name, fill, kind } of OPEN_POSITIONS) {
    it(`fills ${name} when nobody healthy at Triple-A covers it, and the card names the position`, async () => {
      const [injured] = PLAN_MEN.aaaCentreFielders;
      const ratingAt = (id: number): number =>
        (db.prepare(`SELECT fielding_rating_pos${pos} AS r FROM players_fielding WHERE player_id = ?`).get(id) as { r: number | null } | undefined)?.r ?? 0;
      await inScenario(() => {
        const able = (db.prepare(
          `SELECT f.player_id FROM players_fielding f JOIN players p ON p.player_id = f.player_id
           WHERE p.team_id = ? AND f.fielding_rating_pos${pos} >= 40 ORDER BY f.player_id`
        ).all(PLAN.teams.aaa) as Array<{ player_id: number }>).map((r) => r.player_id)
          .filter((id) => kind === 'promote' || id !== injured);
        db.prepare(
          `UPDATE players_fielding SET fielding_rating_pos${pos} = 30 WHERE player_id IN (${able.map(() => '?').join(', ')})`
        ).run(...able);
        fillTripleA([...fill]);
      }, async () => {
        const p = await plan();
        const aaa = level(p, 'aaa');
        expect(aaa.now.roster).toBe(35);
        // Nobody healthy at the club covers the position today, and the groups are full
        expect(aaa.roster.filter((r) => !r.frozen && r.status !== 'arrives' && coversToday(r.player_id).has(pos)).map((r) => r.name)).toEqual([]);
        for (const g of ['C', 'IF', 'OF', 'SS cover', 'CF cover'] as const) {
          const s = aaa.structure.find((x) => x.group === g)!;
          expect(s.have, g).toBeGreaterThanOrEqual(s.need);
        }
        const card = p.moves.find((m) => m.to.rung === 'aaa' && new RegExp(`covers ${name}\\b`).test(m.reasons[0]))!;
        expect(card, `the man who covers ${name}`).toBeDefined();
        expect(card.kind).toBe(kind);
        expect(card.horizon).toBe('now');
        expect(card.from.rung).toBe('aa');
        expect(coversToday(card.player.player_id).has(pos)).toBe(true);
        if (kind === 'promote') {
          expect(card.reasons[0]).toBe(
            `Nobody healthy on the planned Planner Triples roster covers ${name}; he is rated ${ratingAt(card.player.player_id)} there, the best eligible man below (fit ${aaa.roster.find((r) => r.player_id === card.player.player_id)!.fit} at Triple-A).`
          );
        } else {
          // The injured man who plays it opened the place, so the card covers until he is back
          const hurt = aaa.roster.find((r) => r.player_id === injured)!;
          expect(hurt.frozen).toBe(true);
          expect(ratingAt(injured)).toBeGreaterThanOrEqual(40);
          expect(card.reasons[0]).toMatch(new RegExp(
            `^${hurt.name} is on the injured list at Planner Triples for about 45 more days \\(back around [\\d-]+\\), and nobody healthy on the planned roster covers ${name} without him, so he covers until ${hurt.name} returns\\.$`
          ));
        }
        // He is the only man brought to the club, and for the position alone
        expect(p.moves.filter((m) => m.to.rung === 'aaa' && (m.kind === 'promote' || m.kind === 'cover'))).toEqual([card]);
        // The planned roster covers the position, through him
        const clubs = plannedClubs(p, aaa);
        const covering = aaa.roster.filter((r) => !r.frozen && clubs.get(r.player_id) === PLAN.teams.aaa && coversToday(r.player_id).has(pos));
        expect(covering.map((r) => r.player_id)).toEqual([card.player.player_id]);
      });
    });
  }

  it('fills first base when nobody covers it, as a promotion and not a cover hung on an injured shortstop', async () => {
    const [shortstop] = [98063];
    await inScenario(() => {
      // Both Triple-A first basemen go, and a shortstop, who does not play first, is hurt
      removePlannerMan(98066);
      removePlannerMan(98070);
      injure(shortstop, PLAN.teams.aaa, 30);
    }, async () => {
      const p = await plan();
      const first = p.moves.find((m) => m.to.rung === 'aaa' && /covers 1B/.test(m.reasons[0]))!;
      expect(first, 'a man who covers first base').toBeDefined();
      expect(first.kind).toBe('promote');
      expect(first.from.rung).toBe('aa');
      expect(first.reasons[0]).toBe(
        `Nobody healthy on the planned Planner Triples roster covers 1B; he is rated 50 there, the best eligible man below (fit ${level(p, 'aaa').roster.find((r) => r.player_id === first.player.player_id)!.fit} at Triple-A).`
      );
      expect(coversToday(first.player.player_id).has(3)).toBe(true);
      // The injured shortstop opened nothing at first base
      expect(p.moves.filter((m) => m.kind === 'cover' && m.reasons[0].includes('Triples Man4'))).toEqual([]);
    });
  });

  /*
   * A position the field pull could not fill leaves a note, the way a group
   * shortfall does: the groups can all stand at their minimums with nobody
   * among them who plays second base, so no group note would say so.
   */
  it('asks for a second baseman when nobody at Triple-A covers second and nobody below does either', async () => {
    await inScenario(() => {
      // Every man rated 40 or better at second, at Triple-A and at Double-A, marked down to 30
      db.prepare(
        `UPDATE players_fielding SET fielding_rating_pos4 = 30
         WHERE fielding_rating_pos4 >= 40 AND player_id IN (SELECT player_id FROM players WHERE team_id IN (?, ?))`
      ).run(PLAN.teams.aaa, PLAN.teams.aa);
      fillTripleA();
    }, async () => {
      const p = await plan();
      const aaa = level(p, 'aaa');
      const clubs = plannedClubs(p, aaa);
      expect(aaa.roster.filter((r) => !r.frozen && clubs.get(r.player_id) === PLAN.teams.aaa && coversToday(r.player_id).has(4))).toEqual([]);
      for (const g of ['C', 'IF', 'OF', 'SS cover', 'CF cover'] as const) {
        const s = aaa.structure.find((x) => x.group === g)!;
        expect(s.have, g).toBeGreaterThanOrEqual(s.need);
      }
      expect(p.moves.filter((m) => m.to.rung === 'aaa' && /covers 2B/.test(m.reasons[0]))).toEqual([]);
      expect(aaa.needs).toEqual(['Sign a second baseman: nobody eligible below covers 2B.']);
    });
  });

  it('asks for a first baseman when the men below who cover first cannot be spared', async () => {
    await inScenario(() => {
      // Triple-A one catcher short, and nobody at Double-A who plays first base. High-A has men
      // who do, but its one free place goes to the refill Triple-A's catcher pull counts on, and
      // Single-A stands at its minimum with nobody at the Complex ready for it
      for (const id of [98061, 98062, 98122, 98123, 98127, 98131, 98184, 98191, 98199, 98242, 98261, 98264, 98314, 98325, 98306]) {
        removePlannerMan(id);
      }
    }, async () => {
      const p = await plan();
      const aa = level(p, 'aa');
      const clubs = plannedClubs(p, aa);
      expect(aa.roster.filter((r) => !r.frozen && clubs.get(r.player_id) === PLAN.teams.aa && coversToday(r.player_id).has(3))).toEqual([]);
      // Men below cover first base, so the note does not say nobody is there
      const highA = level(p, 'high-a');
      expect(highA.roster.filter((r) => !r.frozen && r.status !== 'leaves' && coversToday(r.player_id).has(3)).length).toBeGreaterThan(0);
      expect(aa.needs).toEqual(['Sign a first baseman: nobody below can cover 1B without leaving his club short.']);
    });
  });

  /*
   * Catchers are counted by the C group, not by a rating of 40 behind the
   * plate: a DSL club of three teenage catchers, none of them rated 40 there
   * yet, has its catchers, and its C row says so. A note asking for one would
   * contradict the row.
   */
  it('asks for no catcher at a DSL club whose three catchers are all rated under 40 behind the plate', async () => {
    await inScenario(() => {
      db.prepare(
        `UPDATE players_fielding SET fielding_rating_pos2 = 30
         WHERE player_id IN (SELECT player_id FROM players WHERE team_id = ?)`
      ).run(PLAN.teams.dslA);
    }, async () => {
      const p = await plan();
      const dsl = level(p, 'dsl');
      const clubs = plannedClubs(p, dsl);
      const unoCatchers = dsl.roster.filter((r) => !r.frozen && clubs.get(r.player_id) === PLAN.teams.dslA && r.positionName === 'C');
      expect(unoCatchers.length).toBeGreaterThanOrEqual(3);
      for (const r of unoCatchers) expect(coversToday(r.player_id).has(2), r.name).toBe(false);
      const c = dsl.structure.find((s) => s.group === 'C')!;
      expect(c.tone).toBe('ok');
      expect(c.have).toBeGreaterThanOrEqual(c.need);
      expect(dsl.needs.filter((n) => /catcher|\bC\b/.test(n))).toEqual([]);
    });
  });

  /*
   * The same rule binds the field pull. The Complex has a club below it, so a
   * catcher rated 40 could be brought up; but the Complex club has its three
   * catchers, and a promotion that says nobody covers C would contradict the
   * C row that says it does.
   */
  it('brings no catcher up to a Complex club whose catchers are all rated under 40 while its C row is at its minimum', async () => {
    await inScenario(() => {
      db.prepare(
        `UPDATE players_fielding SET fielding_rating_pos2 = 30
         WHERE player_id IN (SELECT player_id FROM players WHERE team_id = ?)`
      ).run(PLAN.teams.complex);
      // A spare fourth catcher at DSL Uno, rated to cover C, whom a pull could bring up
      addPlannerMan({ id: PLAN.spareFrom + 40, club: 'dslA', position: 2, age: 19, oa: 35, pot: 50, proYears: 1 });
    }, async () => {
      const p = await plan();
      const complex = level(p, 'complex');
      const c = complex.structure.find((s) => s.group === 'C')!;
      expect(c.have).toBeGreaterThanOrEqual(c.need);
      expect(complex.roster.some((r) => r.positionName === 'C' && !r.frozen)).toBe(true);
      expect(p.moves.filter((m) => m.to.rung === 'complex' && m.reasons.some((s) => /covers C\b/.test(s)))).toEqual([]);
      expect(complex.needs.filter((n) => /catcher|\bC\b/.test(n))).toEqual([]);
    });
  });

  /*
   * The upper-rung wording of the group note, pinned: a shortfall nobody
   * eligible below can fill says so, where the bottom rung speaks of no level
   * below at all.
   */
  it('says nobody eligible below can fill a Complex catcher shortfall once every DSL catcher is gone', async () => {
    await inScenario(() => {
      const catchers = (team: number): number[] =>
        (db.prepare('SELECT player_id FROM players WHERE team_id = ? AND position = 2 ORDER BY player_id').all(team) as { player_id: number }[]).map((r) => r.player_id);
      removePlannerMan(catchers(PLAN.teams.complex)[0]);
      for (const id of [...catchers(PLAN.teams.dslA), ...catchers(PLAN.teams.dslB)]) removePlannerMan(id);
    }, async () => {
      const p = await plan();
      const complex = level(p, 'complex');
      const note = complex.needs.find((n) => n.includes('catcher'));
      expect(note).toBeDefined();
      expect(note!.endsWith('(nobody eligible below can fill it).')).toBe(true);
      for (const n of level(p, 'dsl').needs) expect(n.includes('nobody eligible below')).toBe(false);
    });
  });

  /*
   * A DSL man held because his club cannot spare him while the Complex is
   * short: the hold names the shortage, but never says nobody below can take
   * his place, since nothing is below the DSL.
   */
  it('holds a DSL outfielder the Complex needs without speaking of anyone below him', async () => {
    await inScenario(() => {
      const outfielders = (db.prepare('SELECT player_id FROM players WHERE team_id = ? AND position IN (7, 8, 9) ORDER BY player_id').all(PLAN.teams.complex) as { player_id: number }[]).map((r) => r.player_id);
      for (const id of outfielders.slice(0, 2)) removePlannerMan(id);
    }, async () => {
      const p = await plan();
      const held = p.moves.filter((m) => m.kind === 'hold' && m.from.rung === 'dsl' && m.reasons[0].includes('is short of outfielders'));
      expect(held.length).toBeGreaterThan(0);
      for (const m of held) {
        expect(m.reasons[0].includes('would be left with')).toBe(true);
        expect(m.reasons[0].includes('nobody below')).toBe(false);
      }
    });
  });

  /*
   * The catcher rule reaches the sentence that says what a club above lacks:
   * a Complex club at its catcher minimum lacks nobody behind the plate, so no
   * DSL catcher is held for it with "nobody healthy who covers C". The
   * strong DSL Uno catcher is ready for the Complex, and his club cannot
   * spare him; whatever holds him, it is not a catcher shortage above.
   */
  it('never says a Complex club at its catcher minimum has nobody who covers C', async () => {
    await inScenario(() => {
      db.prepare(
        `UPDATE players_fielding SET fielding_rating_pos2 = 30
         WHERE player_id IN (SELECT player_id FROM players WHERE team_id = ?)`
      ).run(PLAN.teams.complex);
      const [strong] = (db.prepare('SELECT player_id FROM players WHERE team_id = ? AND position = 2 ORDER BY player_id').all(PLAN.teams.dslA) as { player_id: number }[]).map((r) => r.player_id);
      regrade(strong, 42, 58);
    }, async () => {
      const p = await plan();
      const c = level(p, 'complex').structure.find((s) => s.group === 'C')!;
      expect(c.have).toBeGreaterThanOrEqual(c.need);
      expect(p.moves.filter((m) => m.reasons.some((s) => s.includes('nobody healthy who covers C')))).toEqual([]);
    });
  });

  /*
   * At the bottom of the ladder nobody is below to bring up, so the note
   * speaks of the roster alone.
   */
  it('asks for a second baseman at a DSL club nobody on the roster covers second for, without speaking of anyone below', async () => {
    await inScenario(() => {
      db.prepare(
        `UPDATE players_fielding SET fielding_rating_pos4 = 30
         WHERE player_id IN (SELECT player_id FROM players WHERE team_id = ?)`
      ).run(PLAN.teams.dslA);
    }, async () => {
      const p = await plan();
      const dsl = level(p, 'dsl');
      expect(dsl.needs).toEqual(['Sign a second baseman for DSL Planner Uno: nobody on the roster covers 2B.']);
      expect(dsl.needs.some((n) => /below/.test(n))).toBe(false);
    });
  });

  it('leaves every level with a healthy man at catcher, shortstop and centre field', async () => {
    const p = await plan();
    for (const l of p.levels) {
      if (!l.structure.length) continue;
      for (const g of ['C', 'SS cover', 'CF cover'] as const) {
        const s = l.structure.find((x) => x.group === g)!;
        expect(s.have, `${l.rung} ${g}`).toBeGreaterThanOrEqual(Math.max(1, s.need));
      }
    }
  });
});

describe('the release-or-trade list', () => {
  it('makes a trade that breaks a minimum good from below, and says so on both cards', async () => {
    const [, outOfOptions, third] = PLAN_MEN.aaaCatchers;
    await inScenario(() => {
      // Two Triple-A catchers left, one of them out of options on the 40-man:
      // trading him leaves one against the two. The club is filled to its
      // maximum so no catcher arrives on merit first
      removePlannerMan(third);
      fillTripleA([7, 8, 9, 7]);
    }, async () => {
      const p = await plan();
      const [trade] = movesOf(p, outOfOptions);
      expect(trade.kind).toBe('trade');
      const fill = p.moves.find((m) => m.kind === 'promote' && m.to.rung === 'aaa' && m.reasons[0].startsWith('Planner Triples trades'))!;
      expect(fill, 'the man who takes his place').toBeDefined();
      expect(fill.player.positionName).toBe('C');
      expect(fill.from.rung).toBe('aa');
      expect(fill.reasons[0]).toMatch(
        /^Planner Triples trades Triples Man2, which would leave one catcher against the two the level needs, so he comes up to take the place: the best eligible catcher below \(fit -?[\d.]+ at Triple-A\)\.$/
      );
      expect(trade.reasons).toContain(`${fill.player.name} comes up from Planner Doubles to take his place, so the trade leaves Planner Triples no shorter.`);
      const aaa = level(p, 'aaa');
      expect(aaa.structure.find((s) => s.group === 'C')).toMatchObject({ have: 2, need: 2, tone: 'ok' });
      // No note asks for a free agent the club below could supply
      expect(aaa.needs.filter((n) => n.startsWith('Sign'))).toEqual([]);
    });
  });

  it('shops a surplus man off the 40-man whose major-league deal still owes money, rather than releasing him', async () => {
    const id = 98069;
    await inScenario(() => {
      regrade(id, 30, 30);
      db.prepare(`UPDATE players SET age = 33 WHERE player_id = ?`).run(id);
      db.prepare(`DELETE FROM players_career_batting_stats WHERE player_id = ? AND year = ?`).run(id, PLAN.season);
      db.prepare(
        `UPDATE players_contract SET is_major = 1, years = 3, current_year = 1, salary0 = 1000000, salary1 = 1100000, salary2 = 1200000 WHERE player_id = ?`
      ).run(id);
    }, async () => {
      const p = await plan();
      const [card] = movesOf(p, id);
      expect(card.key).toBe(`trade:${id}:aaa:out`);
      expect(card.reasons).toContain('Money is owed beyond this season (one more year), so he is shopped rather than released.');
      expect(p.releaseOrTrade.find((r) => r.player_id === id)?.kind).toBe('trade');
    });
  });

  it('releases a no-trade man instead, and says what the release still costs', async () => {
    const id = 98069;
    await inScenario(() => {
      regrade(id, 30, 30);
      db.prepare(`UPDATE players SET age = 33 WHERE player_id = ?`).run(id);
      db.prepare(`DELETE FROM players_career_batting_stats WHERE player_id = ? AND year = ?`).run(id, PLAN.season);
      db.prepare(
        `UPDATE players_contract SET is_major = 1, no_trade = 1, years = 3, current_year = 1, salary0 = 1000000, salary1 = 1100000, salary2 = 1200000 WHERE player_id = ?`
      ).run(id);
    }, async () => {
      const p = await plan();
      const [card] = movesOf(p, id);
      expect(card.key).toBe(`release:${id}:aaa:out`);
      expect(card.reasons).toContain('His contract carries a no-trade clause, so he cannot be shopped and a release is the way out.');
      expect(card.reasons).toContain(
        'His 3-year $1,100,000 deal runs through 2032, and a release does not end it: the club still owes $1,100,000 this season and $1,200,000 over the one season after it.'
      );
    });
  });

  it('keeps a no-trade man on the 40-man off the trade list, whatever his options say', async () => {
    const id = PLAN_MEN.farmOutOfOptions;
    await inScenario(() => {
      db.prepare(`UPDATE players_contract SET no_trade = 1 WHERE player_id = ?`).run(id);
    }, async () => {
      const p = await plan();
      expect(movesOf(p, id).map((m) => m.kind)).toEqual(['hold']);
      expect(movesOf(p, id)[0].reasons).toContain('His contract carries a no-trade clause, so he is kept off the trade list.');
      expect(p.releaseOrTrade.map((r) => r.player_id)).not.toContain(id);
    });
  });

  it('gives the reason the class gave: a man old for a complex level is surplus for his age, not his grade', async () => {
    const id = 98560;
    await inScenario(() => {
      // Five years over the Complex median age, and graded as well as any reliever there
      addPlannerMan({ id, club: 'complex', position: 1, role: 12, age: 26, oa: 33, pot: 36, proYears: 2 });
    }, async () => {
      const p = await plan();
      const [card] = movesOf(p, id);
      expect(card.key).toBe(`release:${id}:complex:out`);
      const median = level(p, 'complex').baseline;
      expect(card.reasons[0]).toBe(
        `Surplus at the Complex: at 26 he is ${['', '', '', 'three', 'four', 'five', 'six', 'seven'][26 - median.medAge!]} years older than the Complex median of ${median.medAge}, and three years over it is old for a complex level whatever the grade (33 with a 36 ceiling).`
      );
      expect(card.reasons.join(' ')).not.toMatch(/below the Complex median of [\d.]+ and with no ceiling/);
      expect(card.reasons[1]).toMatch(/^First of \w+ relievers at ACL Planner Nine, none of the others graded above him; releasing him leaves \w+ against the nine the level needs\.$/);
    });
  });
});

describe('a man at the rung he is planned at', () => {
  it('re-classes a complex starter at Single-A, where a third rated pitch is asked for', async () => {
    const id = 98561;
    await inScenario(() => {
      // Stamina 55 and one rated pitch: a starter at the Complex, a reliever from Single-A up
      addPlannerMan({ id, club: 'complex', position: 1, role: 11, age: 19, oa: 40, pot: 55, proYears: 1 });
      db.prepare(
        `UPDATE players_pitching SET pitching_ratings_pitches_slider = 0, pitching_ratings_pitches_changeup = 0, pitching_ratings_pitches_curveball = 0 WHERE player_id = ?`
      ).run(id);
    }, async () => {
      const p = await plan();
      const up = movesOf(p, id).find((m) => m.to.rung === 'single-a')!;
      expect(up, 'he goes up').toBeDefined();
      const singleA = level(p, 'single-a');
      expect(singleA.roster.find((r) => r.player_id === id)?.utility).toBe('RP');
      expect(up.player.utility).toBe('RP');
      expect(singleA.staff.rotation.map((r) => r.player_id)).not.toContain(id);
      expect(singleA.staff.bullpen.map((r) => r.player_id)).toContain(id);
    });
  });

  it('says "once he arrives" only of a man the plan brings to the club now', async () => {
    const p = await plan();
    // The DSL shortstop the cap sends two steps up after the season is there all year
    const dsl = level(p, 'dsl').structure.find((s) => s.group === 'SS cover')!;
    expect(dsl.note).toContain('Uno Man4 55');
    expect(dsl.note).not.toContain('Uno Man4 55 once he arrives');
    // So is the High-A shortstop in his last eligible season there
    const highA = level(p, 'high-a').structure.find((s) => s.group === 'SS cover')!;
    expect(highA.note).toContain('Highs Man4 55');
    expect(highA.note).not.toContain('Highs Man4 55 once he arrives');
    // A man who does arrive now still says so
    const aaa = level(p, 'aaa').structure.find((s) => s.group === 'CF cover')!;
    expect(aaa.note).toMatch(/Doubles Man\d+ 55 once he arrives/);
  });
});

describe('the cascade and the bottom of the ladder', () => {
  it('pushes a surplus man into a full rung, which then pushes its own surplus one step in the same round', async () => {
    const pushed = PLAN_MEN.surplus[2];
    await inScenario(() => {
      fillTripleA();
      regrade(98153, 36, 44);
      // High-A at its maximum already, and one Double-A surplus man eligible
      // there: four pro years, so five next season is still within High-A's
      // cap of five, and young enough not to be read as overmatched (which is
      // a demotion of its own)
      for (const [k, id] of [98543, 98544, 98545, 98546].entries()) {
        addPlannerMan({ id, club: 'highA', position: 7 + (k % 3), age: 23, oa: 34, pot: 40, proYears: 3 });
      }
      db.prepare(`UPDATE players_roster_status SET pro_service_years = 4 WHERE player_id = ?`).run(pushed);
      db.prepare(`UPDATE players SET age = 22 WHERE player_id = ?`).run(pushed);
      // High-A's lowest-fit surplus man has three pro years, so four next season is within Single-A's cap
      db.prepare(`UPDATE players_roster_status SET pro_service_years = 3 WHERE player_id = ?`).run(98191);
    }, async () => {
      const p = await plan();
      const [down] = movesOf(p, pushed);
      expect(down.kind).toBe('demote');
      expect(down.key).toBe(`demote:${pushed}:aa:high-a`);
      expect(down.reasons[0]).toMatch(/^Planner Doubles is 3[678] against a soft maximum of 35, so only its surplus men leave for size/);
      expect(down.reasons[0]).toContain('He is eligible at High-A, so he goes down rather than out.');
      // The other two, eligible nowhere below, still go out
      for (const id of PLAN_MEN.surplus.slice(0, 2)) expect(movesOf(p, id)[0].to.rung, String(id)).toBe('out');
      const cascade = p.moves.filter((m) => m.kind === 'demote' && m.from.rung === 'high-a' && m.to.rung === 'single-a');
      expect(cascade.length).toBeGreaterThan(0);
      expect(cascade.some((m) => m.reasons[0].startsWith('Planner Highs is 37 against a soft maximum of 35, so only its surplus men leave for size'))).toBe(true);
      for (const m of cascade) expect(m.player.assetClass, m.key).toBe('surplus');
      expect(level(p, 'high-a').planned.roster).toBeLessThanOrEqual(35 + 1);
    });
  });

  it('ends each DSL club at or above its minimum, and never shuffles a man between the two', async () => {
    const p = await plan();
    const dsl = level(p, 'dsl');
    expect(dsl.target).toEqual({ min: 30, max: 45 });
    const clubOf = new Map(
      (db.prepare(`SELECT player_id, team_id FROM players WHERE team_id IN (?, ?)`).all(PLAN.teams.dslA, PLAN.teams.dslB) as Array<{ player_id: number; team_id: number }>)
        .map((r) => [r.player_id, r.team_id])
    );
    for (const club of [PLAN.teams.dslA, PLAN.teams.dslB]) {
      const stays = dsl.roster.filter((r) => r.status === 'stays' && clubOf.get(r.player_id) === club).length;
      const arrivals = p.moves.filter((m) => m.horizon === 'now' && m.to.team_id === club && m.verify?.field !== 'on40' && m.kind !== 'hold').length;
      expect(stays + arrivals, `club ${club}`).toBeGreaterThanOrEqual(30);
    }
    expect(dsl.planned.roster).toBeGreaterThanOrEqual(60);
    expect(p.moves.filter((m) => m.from.rung === 'dsl' && m.to.rung === 'dsl' && m.kind !== 'hold')).toEqual([]);
    // Nothing is pulled into the DSL from the pool but the two assignments the rules make
    expect(p.moves.filter((m) => m.to.rung === 'dsl' && m.kind !== 'hold').map((m) => m.kind)).toEqual(['assign', 'assign']);
  });

  it('fills the Complex\'s structure before promoting anyone on merit, so no DSL club is drained under its minimum', async () => {
    await inScenario(() => {
      // Two DSL Uno relievers the Complex would take on merit, and six Complex infielders gone,
      // so the structure needs five DSL infielders as well
      for (const id of [98548, 98549]) addPlannerMan({ id, club: 'dslA', position: 1, role: 12, age: 18, oa: 34, pot: 50, proYears: 0 });
      for (const id of [98303, 98304, 98305, 98306, 98307, 98308]) removePlannerMan(id);
    }, async () => {
      const p = await plan();
      const dsl = level(p, 'dsl');
      const clubOf = new Map(
        (db.prepare(`SELECT player_id, team_id FROM players WHERE team_id IN (?, ?)`).all(PLAN.teams.dslA, PLAN.teams.dslB) as Array<{ player_id: number; team_id: number }>)
          .map((r) => [r.player_id, r.team_id])
      );
      // The Complex is short of infielders, and the structure pull that fills it
      // comes from the DSL club with one to spare (DSL Dos, given a shortstop
      // by the complex pool); the rest the DSL cannot give without going under
      // its own minimum of eight (§4), so they stay a need at the Complex
      const pulls = p.moves.filter((m) => m.from.rung === 'dsl' && m.to.rung === 'complex' && m.reasons[0].startsWith('ACL Planner Nine is short of infielders'));
      expect(pulls.length).toBeGreaterThan(0);
      for (const club of [PLAN.teams.dslA, PLAN.teams.dslB]) {
        const stays = dsl.roster.filter((r) => r.status === 'stays' && clubOf.get(r.player_id) === club).length;
        const arrivals = p.moves.filter((m) => m.horizon === 'now' && m.to.team_id === club && m.verify?.field !== 'on40' && m.kind !== 'hold').length;
        // A promotion on merit never takes a club under its hard minimum
        expect(stays + arrivals, `club ${club}`).toBeGreaterThanOrEqual(30);
      }
      // Nor does any pull take a DSL club under a group minimum
      for (const s of dsl.structure) expect(s.have, `DSL ${s.group}: ${s.note ?? ''}`).toBeGreaterThanOrEqual(s.need);
      for (const c of dsl.clubs!) expect(c, c.label).toMatchObject({ tone: 'ok' });
      const complex = level(p, 'complex');
      expect(complex.structure.find((s) => s.group === 'IF')!.tone).toBe('bad');
      expect(complex.needs.find((n) => /infielders/.test(n))).toMatch(
        /^Sign \d+ minor-league free agents: \w+ infielders \(the men below who could fill it would leave their own clubs short\)\.$/
      );
    });
  });

  it('never drains a DSL club under its size or a group minimum to fill the Complex, and leaves the Complex\'s shortfall as a need', async () => {
    // Five Complex infielders gone: the Complex is short of its eight, and
    // nothing below the DSL refills a club the Complex takes from
    await inScenario(() => {
      for (const id of [98303, 98304, 98305, 98306, 98307]) removePlannerMan(id);
    }, async () => {
      const p = await plan();
      const dsl = level(p, 'dsl');
      expect(dsl.clubs!.map((c) => c.team_id)).toEqual([PLAN.teams.dslA, PLAN.teams.dslB]);
      for (const c of dsl.clubs!) {
        expect(c.planned, c.label).toBeGreaterThanOrEqual(30);
        expect(c.tone, c.label).not.toBe('bad');
      }
      // Group by group and club by club, through the fielding and the moves, not the card alone
      const clubs = plannedClubs(p, dsl);
      for (const club of [PLAN.teams.dslA, PLAN.teams.dslB]) {
        const men = dsl.roster.filter((r) => clubs.get(r.player_id) === club && !r.frozen);
        const groups = { C: 0, IF: 0, OF: 0 };
        for (const r of men) {
          if (r.positionName === 'C') groups.C++;
          else if (['1B', '2B', '3B', 'SS'].includes(r.positionName)) groups.IF++;
          else if (['LF', 'CF', 'RF'].includes(r.positionName)) groups.OF++;
        }
        expect(groups, `club ${club}`).toMatchObject({ C: expect.any(Number) });
        expect(groups.C, `club ${club} catchers`).toBeGreaterThanOrEqual(3);
        expect(groups.IF, `club ${club} infielders`).toBeGreaterThanOrEqual(8);
        expect(groups.OF, `club ${club} outfielders`).toBeGreaterThanOrEqual(6);
      }
      for (const s of dsl.structure) expect(s.have, `DSL ${s.group}`).toBeGreaterThanOrEqual(s.need);
      // What the DSL cannot give, the Complex is told to sign
      const complex = level(p, 'complex');
      const row = complex.structure.find((s) => s.group === 'IF')!;
      expect(row.tone).toBe('bad');
      expect(complex.needs.some((n) => n.startsWith('Sign') && /infielders?/.test(n))).toBe(true);
    });
  });

  it('judges each DSL club on its own: one club with a single catcher reads bad, whatever its sister club has', async () => {
    // Two of DSL Uno's three catchers go; DSL Dos keeps its three
    await inScenario(() => {
      removePlannerMan(98360);
      removePlannerMan(98361);
    }, async () => {
      const p = await plan();
      const dsl = level(p, 'dsl');
      expect(dsl.structure.find((s) => s.group === 'C')).toEqual({
        group: 'C', have: 1, need: 3, tone: 'bad', note: 'DSL Planner Uno 1; DSL Planner Dos 3',
      });
      expect(dsl.clubs).toEqual([
        { team_id: PLAN.teams.dslA, label: 'DSL Planner Uno', now: 30, planned: expect.any(Number), min: 30, max: 45, tone: expect.any(String) },
        { team_id: PLAN.teams.dslB, label: 'DSL Planner Dos', now: 32, planned: expect.any(Number), min: 30, max: 45, tone: expect.any(String) },
      ]);
      for (const c of dsl.clubs!) expect(c.tone).toBe(c.planned < 30 ? 'bad' : c.planned > 45 ? 'warn' : 'ok');
      // The level's own figures add the two clubs together; the clubs add up to them
      expect(dsl.clubs!.reduce((a, c) => a + c.planned, 0)).toBe(dsl.planned.roster);
      // The note names the club it is about
      expect(dsl.needs).toContain('Sign 2 minor-league free agents for DSL Planner Uno: two catchers (no level below to fill it from).');
      // A one-club rung carries no club rows
      expect(level(p, 'aa').clubs).toBeUndefined();
    });
  });

  it('turns a shortfall nobody eligible can fill into a need, never a move', async () => {
    await inScenario(() => {
      // Five of DSL Uno's six outfielders are gone
      for (const id of [98371, 98372, 98373, 98374, 98375]) removePlannerMan(id);
    }, async () => {
      const p = await plan();
      const dsl = level(p, 'dsl');
      expect(dsl.tone).toBe('bad');
      // The note names the group and the position cover the club is short of; the figure counts the size shortfall too
      const need = dsl.needs.find((n) => /outfielders/.test(n))!;
      expect(need).toMatch(/^Sign \d+ minor-league free agents for DSL Planner Uno: five outfielders and a man who can play centre field \(no level below to fill it from\)\.$/);
      expect(dsl.needs).toHaveLength(1);
      expect(p.moves.filter((m) => m.to.rung === 'dsl' && (m.kind === 'promote' || m.kind === 'cover'))).toEqual([]);
      expect(p.moves.filter((m) => m.from.rung === 'ic' && m.kind !== 'assign')).toEqual([]);
    });
  });
});

describe('the staff per level', () => {
  it('lists five SP-class arms by fit at Double-A and six at Single-A, the derived closer first in the bullpen', async () => {
    await inScenario(() => {
      // Three more starters at Single-A, graded at its median, since some of its six are surplus and
      // leave and the best goes up on merit; the rotation of six is then read from seven or more
      for (const id of [98546, 98547, 98548]) addPlannerMan({ id, club: 'singleA', position: 1, role: 11, age: 22, oa: 33, pot: 45, proYears: 2 });
    }, async () => {
      const p = await plan();
      for (const [rung, size] of [['aa', 5], ['single-a', 6]] as const) {
        const { rotation, bullpen } = level(p, rung).staff;
        expect(rotation, rung).toHaveLength(size);
        for (const r of rotation) expect(r.tag, `${rung} ${r.name}`).toBeNull();
        const fits = rotation.map((r) => r.fit ?? -Infinity);
        expect(fits, rung).toEqual([...fits].sort((a, b) => b - a));
        expect(bullpen[0].tag, rung).toBe('CL');
        expect(bullpen.filter((r) => r.tag === 'CL'), rung).toHaveLength(1);
        for (const r of bullpen.slice(1)) expect([null, 'vs L', 'vs R', 'swing'], `${rung} ${r.name}`).toContain(r.tag);
        expect(bullpen.some((r) => r.tag === 'vs L'), `${rung} has a specialist`).toBe(true);
        // Nobody is in both
        expect(new Set([...rotation, ...bullpen].map((r) => r.player_id)).size).toBe(rotation.length + bullpen.length);
        // The bullpen is the closer and the RP- and swing-class men: a starter
        // with no rotation spot is not shown as a reliever (§5.6)
        const classOf = new Map(level(p, rung).roster.map((r) => [r.player_id, r.utility]));
        for (const r of bullpen) expect(classOf.get(r.player_id), `${rung} ${r.name}`).not.toBe('SP');
      }
      // Triple-A carries more SP-class arms than its five rotation places: the extras are in neither list
      const aaa = level(p, 'aaa');
      const starters = aaa.roster.filter((r) => r.utility === 'SP' && r.status !== 'leaves' && !r.frozen);
      expect(starters.length).toBeGreaterThan(5);
      const listed = new Set([...aaa.staff.rotation, ...aaa.staff.bullpen].map((r) => r.player_id));
      expect(starters.filter((r) => !listed.has(r.player_id)).length).toBe(starters.length - 5);
      expect(level(p, 'ic').staff).toEqual({ rotation: [], bullpen: [] });
    });
  });
});

describe('every plan', () => {
  it('never prints an empty reason', async () => {
    const p = await plan();
    expect(p.moves.length).toBeGreaterThan(50);
    for (const m of p.moves) {
      expect(m.reasons.length, m.key).toBeGreaterThan(0);
      for (const r of m.reasons) {
        expect(typeof r).toBe('string');
        expect(r.trim().length, m.key).toBeGreaterThan(20);
      }
    }
    for (const r of p.releaseOrTrade) expect(r.reasons.length, r.name).toBeGreaterThan(0);
  });

  it('gives byte-identical JSON twice, and again after a decision overlay', async () => {
    const a = JSON.stringify(await plan());
    clearPlanCache();
    const b = JSON.stringify(await plan());
    expect(a).toBe(b);
    const key = (await plan()).moves.find((m) => m.kind === 'promote')!.key;
    await post(`/api/plan/${PLAN.org}/decisions`, { moveKey: key, decision: 'accepted' });
    const c = JSON.stringify(await plan());
    clearPlanCache();
    const d = JSON.stringify(await plan());
    expect(c).toBe(d);
    expect(c).not.toBe(a);
    historyDb.prepare(`DELETE FROM plan_decisions`).run();
    expect(JSON.stringify(await plan())).toBe(a);
  });

  it('answers a warm request in well under a second', async () => {
    await plan();
    const t0 = performance.now();
    await plan();
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
