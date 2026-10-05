import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// The planner first: history.ts reaches dashboard.ts for DATE_KEY, dashboard.ts
// reaches the planner, and the planner's decision store reaches history.ts —
// a ring that only loads when it is entered here and not at history.ts
import { verifyPlanDecisions } from '../server/planner.js';
import { db } from '../server/db.js';
import { currentSaveName, historyDb, leagueGameDate } from '../server/history.js';
import { migratePlanDecisions, planSaveSwitchPending, setPlanLeagueSave } from '../server/plandecisions.js';
import { stopWatcher } from '../server/watcher.js';
import type { Plan, PlanMove } from '../server/planTypes.js';
import { PLAN_DECISION_KINDS, planMoveCounts } from '../server/dashboard.js';
import { decisionText, isSettled } from '../src/pages/Planner.js';
import request, { post } from './request.js';
import { PLAN, PLAN_MEN, inScenario, removePlannerMan, seedPlannerOrg } from './plannerFixture.js';

/**
 * Decisions on the planner's moves, through HTTP, and what the next import
 * makes of them: accept and dismiss, the show filter, reopening, the
 * refusal of a key the plan does not hold, and the verifier reading done /
 * not yet / changed / moot off where each man stands in the new league.db —
 * with the deadline that turns a lingering not-yet into a changed, and the
 * brief's own check beside it, whether his level moved between snapshots.
 */

const base = () => `http://127.0.0.1:${process.env.OOTP_FO_PORT}`;
const plan = async (show = 'open'): Promise<Plan> => (await request(`/api/plan/${PLAN.org}?show=${show}`)) as Plan;
const decide = (moveKey: string, decision: string) => post(`/api/plan/${PLAN.org}/decisions`, { moveKey, decision });
const reopen = async (moveKey: string) =>
  (await fetch(`${base()}/api/plan/${PLAN.org}/decisions/${encodeURIComponent(moveKey)}`, { method: 'DELETE' })).json();
const listed = async () => (await request(`/api/plan/${PLAN.org}/decisions`)).decisions as Array<Record<string, unknown>>;
const outcomeOf = async (key: string) => (await listed()).find((d) => d.moveKey === key)?.outcome ?? null;
const seenAtOf = async (key: string) => (await listed()).find((d) => d.moveKey === key)?.seenAt ?? null;

/** Sets the export's date, and the season's Opening Day when given, on every league. */
function dated(gameDate: string, openingDay?: string): void {
  db.prepare(`UPDATE leagues SET "current_date" = ?`).run(gameDate);
  if (openingDay) db.prepare(`UPDATE leagues SET start_date = ?`).run(openingDay);
}

/** Puts a man on the 40-man the way an export lists it. */
function addTo40(id: number): void {
  db.prepare(`INSERT INTO team_roster VALUES (?, ?, 3)`).run(PLAN.org, id);
}

/** Moves a man to another club the way an export shows it: his team and the club's lists. */
function moveTo(id: number, team: number): void {
  db.prepare(`UPDATE players SET team_id = ? WHERE player_id = ?`).run(team, id);
  db.prepare(`DELETE FROM team_roster WHERE player_id = ? AND list_id IN (1, 2, 4)`).run(id);
  db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(team, id);
  db.prepare(`INSERT INTO team_roster VALUES (?, ?, 2)`).run(team, id);
}

/** Sends a man to another organisation altogether. */
function sell(id: number): void {
  db.prepare(`UPDATE players SET organization_id = 1, team_id = 1 WHERE player_id = ?`).run(id);
  db.prepare(`DELETE FROM team_roster WHERE player_id = ?`).run(id);
}

let promote: PlanMove;
let forced: PlanMove;
let trade: PlanMove;
let protect: PlanMove;

beforeAll(async () => {
  await request('/api/status');
  seedPlannerOrg();
  const p = await plan('all');
  promote = p.moves.find((m) => m.kind === 'promote' && m.horizon === 'now' && m.from.rung === 'aa' && m.to.rung === 'aaa')!;
  forced = p.moves.find((m) => m.kind === 'forced' && m.horizon === 'offseason' && m.from.rung === 'single-a' && m.to.rung === 'high-a')!;
  trade = p.moves.find((m) => m.kind === 'trade' && m.deadline?.kind === 'trade-deadline')!;
  // A protection with the Rule 5 date as its deadline, from whichever club the plan finds him on
  protect = p.moves.find((m) => m.kind === 'protect' && m.deadline?.kind === 'rule5')!;
  expect(promote).toBeDefined();
  expect(protect).toBeDefined();
  expect(forced).toBeDefined();
  expect(trade).toBeDefined();
});

beforeEach(() => {
  historyDb.prepare(`DELETE FROM plan_decisions`).run();
});

describe('accept, dismiss, reopen', () => {
  it('accepts a move: it stays in the plan marked accepted, with the game date', async () => {
    const { ok, decision } = await decide(promote.key, 'accepted');
    expect(ok).toBe(true);
    expect(decision.state).toBe('accepted');
    expect(decision.gameDate).toBe(leagueGameDate());
    expect(decision.outcome).toBeNull();
    // show=open lists open moves only; an accepted move is read under all (and accepted)
    expect((await plan()).moves.some((x) => x.key === promote.key)).toBe(false);
    const p = await plan('all');
    const m = p.moves.find((x) => x.key === promote.key)!;
    // seenAt rides on the decision once the engine copies it over; null until an import has seen the move
    expect(m.decision).toEqual({
      state: 'accepted', gameDate: leagueGameDate(), outcome: null, verifiedGameDate: null, seenAt: null,
      // The deadline the move carried when it was decided
      deadlineDate: promote.deadline?.date ?? null,
    });
    expect(p.counts.accepted).toBe(1);
    expect(p.counts.open).toBe(p.moves.length - 1);
    expect((await plan('accepted')).moves.map((x) => x.key)).toEqual([promote.key]);
  });

  it('dismisses a move: gone from the open plan, kept under show=dismissed, counted', async () => {
    const { decision } = await decide(promote.key, 'dismissed');
    expect(decision.state).toBe('dismissed');
    const open = await plan();
    expect(open.moves.some((x) => x.key === promote.key)).toBe(false);
    expect(open.counts.dismissed).toBe(1);
    const dismissed = await plan('dismissed');
    expect(dismissed.moves.map((x) => x.key)).toEqual([promote.key]);
    expect(dismissed.moves[0].decision.state).toBe('dismissed');
    // The counts by kind follow the filter; the decision roll-up does not
    expect(dismissed.counts.promote).toBe(1);
    expect(dismissed.counts.dismissed).toBe(1);
    expect((await plan('all')).moves.some((x) => x.key === promote.key)).toBe(true);
  });

  it('reopens a move, and says when there was nothing to reopen', async () => {
    await decide(promote.key, 'dismissed');
    expect(await reopen(promote.key)).toEqual({ ok: true });
    expect((await plan()).moves.some((x) => x.key === promote.key)).toBe(true);
    expect(await listed()).toEqual([]);
    expect(await reopen(promote.key)).toEqual({ ok: false });
  });

  it('refuses a key the plan does not hold, and a decision that is neither accepted nor dismissed', async () => {
    const bad = await fetch(`${base()}/api/plan/${PLAN.org}/decisions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ moveKey: 'promote:1:aa:aaa', decision: 'accepted' }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ ok: false, error: 'moveKey is not in the current plan.' });
    const worse = await fetch(`${base()}/api/plan/${PLAN.org}/decisions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ moveKey: promote.key, decision: 'maybe' }),
    });
    expect(worse.status).toBe(400);
    expect(await listed()).toEqual([]);
  });

  it('lists the decisions with what the store and the snapshots know about each', async () => {
    await decide(promote.key, 'accepted');
    await decide(forced.key, 'dismissed');
    const rows = await listed();
    expect(rows.map((d) => d.moveKey).sort()).toEqual([forced.key, promote.key].sort());
    const d = rows.find((x) => x.moveKey === promote.key)!;
    expect(d).toMatchObject({
      state: 'accepted', kind: 'promote', player_id: promote.player.player_id, fromRung: 'aa', toRung: 'aaa',
      fromTeamId: promote.from.team_id, toTeamId: promote.to.team_id, verify: { field: 'rung', expect: 'aaa' },
      outcome: null, levelChanged: null,
    });
  });
});

describe('verifyPlanDecisions() against the next export', () => {
  it('reads not yet while he is where the move started', async () => {
    await decide(promote.key, 'accepted');
    const updated = verifyPlanDecisions();
    expect(updated.map((d) => [d.moveKey, d.outcome])).toEqual([[promote.key, 'not-yet']]);
    expect(await outcomeOf(promote.key)).toBe('not-yet');
    // Not seen yet, so nowhere to say he was seen
    expect(updated[0].seenAt).toBeNull();
    expect(await seenAtOf(promote.key)).toBeNull();
    const m = (await plan('accepted')).moves.find((x) => x.key === promote.key)!;
    expect(m.decision.outcome).toBe('not-yet');
    expect(m.decision.verifiedGameDate).toBe(updated[0].verifiedGameDate);
  });

  it('reads done once the export has him at the target club', async () => {
    await decide(promote.key, 'accepted');
    await inScenario(() => moveTo(promote.player.player_id, promote.to.team_id!), async () => {
      expect(verifyPlanDecisions().map((d) => [d.outcome, d.seenAt])).toEqual([['done', 'Planner Triples']]);
      expect(await outcomeOf(promote.key)).toBe('done');
      expect(await seenAtOf(promote.key)).toBe('Planner Triples');
      // A plan drawn on the new export no longer produces the move, so it is
      // not open; it is still listed under accepted, from the stored row, with
      // what the import saw — the page's "Done — on Planner Triples"
      expect((await plan()).moves.some((x) => x.key === promote.key)).toBe(false);
      const done = (await plan('accepted')).moves.find((x) => x.key === promote.key)!;
      expect(done.decision).toMatchObject({ state: 'accepted', outcome: 'done', seenAt: 'Planner Triples' });
      expect((await plan('all')).counts.done).toBe(1);
      expect((await listed()).find((d) => d.moveKey === promote.key)).toMatchObject({ state: 'accepted', outcome: 'done' });
    });
  });

  it('reads changed when he went to a third club', async () => {
    await decide(promote.key, 'accepted');
    await inScenario(() => moveTo(promote.player.player_id, PLAN.teams.highA), async () => {
      expect(verifyPlanDecisions().map((d) => d.outcome)).toEqual(['changed']);
      expect(await outcomeOf(promote.key)).toBe('changed');
      // Where he went, for "Changed — on Planner Highs, not Planner Triples"
      expect(await seenAtOf(promote.key)).toBe('Planner Highs');
    });
  });

  it('reads moot when a promoted man has left the organisation', async () => {
    await decide(promote.key, 'accepted');
    await inScenario(() => sell(promote.player.player_id), async () => {
      expect(verifyPlanDecisions().map((d) => d.outcome)).toEqual(['moot']);
      expect(await outcomeOf(promote.key)).toBe('moot');
      expect(await seenAtOf(promote.key)).toBe('out of the organization');
    });
  });

  it('reads a trade done by his absence, and not yet while he is still anywhere in the organisation', async () => {
    await decide(trade.key, 'accepted');
    await inScenario(() => moveTo(trade.player.player_id, PLAN.teams.aa), async () => {
      expect(verifyPlanDecisions().map((d) => d.outcome)).toEqual(['not-yet']);
    });
    expect(await seenAtOf(trade.key)).toBeNull();
    await inScenario(() => removePlannerMan(trade.player.player_id), async () => {
      expect(verifyPlanDecisions().map((d) => d.outcome)).toEqual(['done']);
    });
    expect(await seenAtOf(trade.key)).toBe('out of the organization');
  });

  it('accepts any rung at or above the one an offseason move named', async () => {
    await decide(forced.key, 'accepted');
    await inScenario(() => moveTo(forced.player.player_id, PLAN.teams.aa), async () => {
      expect(verifyPlanDecisions().map((d) => d.outcome)).toEqual(['done']);
    });
  });

  it('re-checks a not-yet on every import until the deadline passes, then marks it changed and never revisits it', async () => {
    // A move for this season: the trade deadline closes it
    await decide(trade.key, 'accepted');
    expect(trade.deadline?.date).toBe(PLAN.dates.tradeDeadline);
    expect(verifyPlanDecisions().map((d) => d.outcome)).toEqual(['not-yet']);
    expect(verifyPlanDecisions().map((d) => d.outcome)).toEqual(['not-yet']);
    await inScenario(() => dated(PLAN.dates.tradeDeadline), async () => {
      expect(verifyPlanDecisions().map((d) => d.outcome)).toEqual(['not-yet']);
    });
    await inScenario(() => dated('2030-8-4'), async () => {
      const [d] = verifyPlanDecisions();
      expect(d.outcome).toBe('changed');
      expect(d.verifiedGameDate).toBe('2030-8-4');
      // Still on his club when the window closed
      expect(d.seenAt).toBe('Planner Triples');
    });
    expect(await outcomeOf(trade.key)).toBe('changed');
    // Settled: an export that would read it done no longer changes it
    await inScenario(() => removePlannerMan(trade.player.player_id), async () => {
      expect(verifyPlanDecisions()).toEqual([]);
      expect(await outcomeOf(trade.key)).toBe('changed');
    });
  });

  it('keeps an offseason move not yet after his season ends, and judges it at the next Opening Day', async () => {
    // Accepted in June; his league's last game (the deadline) is when the window to make it opens
    await decide(forced.key, 'accepted');
    expect(forced.horizon).toBe('offseason');
    expect(forced.deadline?.date).toBe(PLAN.seasonEnd.singleA);
    // The first import after his season ends, before the winter assignment: still not yet
    await inScenario(() => dated('2030-9-20'), async () => {
      expect(verifyPlanDecisions().map((d) => d.outcome)).toEqual(['not-yet']);
    });
    // The save has rolled over, but Opening Day 2031 is still to come
    await inScenario(() => dated('2031-2-1', '2031-4-4'), async () => {
      expect(verifyPlanDecisions().map((d) => d.outcome)).toEqual(['not-yet']);
    });
    expect(await outcomeOf(forced.key)).toBe('not-yet');
    // Assigned to High-A over the winter: done, and where
    await inScenario(() => { dated('2031-3-1', '2031-4-4'); moveTo(forced.player.player_id, PLAN.teams.highA); }, async () => {
      expect(verifyPlanDecisions().map((d) => [d.outcome, d.seenAt])).toEqual([['done', 'Planner Highs']]);
    });
  });

  it('marks an offseason move changed when Opening Day comes and he has not moved', async () => {
    await decide(forced.key, 'accepted');
    await inScenario(() => dated('2031-4-3', '2031-4-4'), async () => {
      expect(verifyPlanDecisions().map((d) => d.outcome)).toEqual(['not-yet']);
    });
    await inScenario(() => dated('2031-4-4', '2031-4-4'), async () => {
      expect(verifyPlanDecisions().map((d) => [d.outcome, d.verifiedGameDate, d.seenAt])).toEqual([['changed', '2031-4-4', 'Planner Singles']]);
    });
  });

  it('reads a protection done once he is on the 40-man, even after another move took him to a different club first', async () => {
    await decide(protect.key, 'accepted');
    expect(protect.verify).toEqual({ field: 'on40', expect: true });
    // A promotion from Double-A, or for a Triple-A man any other club: what matters is that he left the one the card named
    const [elsewhere, label] = protect.from.team_id === PLAN.teams.aaa ? [PLAN.teams.aa, 'Planner Doubles'] : [PLAN.teams.aaa, 'Planner Triples'];
    expect(protect.from.team_id).not.toBe(elsewhere);
    // On the other club, not yet on the 40: not yet, not changed
    await inScenario(() => moveTo(protect.player.player_id, elsewhere), async () => {
      expect(verifyPlanDecisions().map((d) => [d.outcome, d.seenAt])).toEqual([['not-yet', null]]);
    });
    expect(await outcomeOf(protect.key)).toBe('not-yet');
    // Then added to the 40-man in November
    await inScenario(() => { dated('2030-11-15'); moveTo(protect.player.player_id, elsewhere); addTo40(protect.player.player_id); }, async () => {
      expect(verifyPlanDecisions().map((d) => [d.outcome, d.seenAt])).toEqual([['done', label]]);
    });
    expect(await outcomeOf(protect.key)).toBe('done');
  });

  it('leaves a dismissed move alone, and retires a dismissal the plan no longer produces', async () => {
    await decide(promote.key, 'dismissed');
    expect(verifyPlanDecisions()).toEqual([]);
    expect(await outcomeOf(promote.key)).toBeNull();
    // The man is sold: the plan stops producing his key, and the next read of the plan marks the dismissal moot
    await inScenario(() => sell(promote.player.player_id), async () => {
      await plan();
      expect(await outcomeOf(promote.key)).toBe('moot');
    });
  });

  it('lets a dismissal lapse once the deadline it was made against has passed, so next winter\'s question is open again', async () => {
    const on = leagueGameDate();
    await decide(protect.key, 'dismissed');
    expect(protect.deadline?.date).toBe(PLAN.dates.rule5);
    // On the deadline itself the dismissal stands
    await inScenario(() => dated(PLAN.dates.rule5), async () => {
      expect(verifyPlanDecisions()).toEqual([]);
    });
    expect(await outcomeOf(protect.key)).toBeNull();
    // The first export after the draft: OOTP has rolled the Rule 5 date a year on
    await inScenario(() => {
      dated('2030-12-21');
      db.prepare(`UPDATE leagues SET rule_5_draft_date = '2031-12-20'`).run();
    }, async () => {
      expect(verifyPlanDecisions().map((d) => [d.moveKey, d.outcome, d.seenAt])).toEqual([[protect.key, 'moot', null]]);
      expect(await outcomeOf(protect.key)).toBe('moot');
      const card = (await plan()).moves.find((m) => m.key === protect.key)!;
      expect(card).toBeDefined();
      expect(card.decision.state).toBe('open');
      expect(card.deadline?.date).toBe('2031-12-20');
      expect(card.reasons.at(-1)).toBe(`Asked again: it was dismissed on ${on} for the ${PLAN.dates.rule5} deadline, which had passed by the 2030-12-21 export.`);
    });
  });
});

describe('decisions on the 40-man feed its count', () => {
  /** Gives a man a 40-man place: the flag and the big club's list 3. */
  const onForty = (id: number): void => {
    db.prepare(`UPDATE players_roster_status SET is_on_secondary = 1 WHERE player_id = ?`).run(id);
    db.prepare(`INSERT OR IGNORE INTO team_roster VALUES (?, ?, 3)`).run(PLAN.org, id);
  };
  const regrade = (id: number, oa: number, pot: number): void => {
    db.prepare(
      `UPDATE players_value SET oa = ?, pot = ?, oa_rating = ?, pot_rating = ?, overall_value = ?, talent_value = ? WHERE player_id = ?`
    ).run(oa, pot, Math.round(oa / 5) * 5, Math.round(pot / 5) * 5, oa * 20, pot * 20, id);
  };
  /**
   * Three places open and one man out of options to give his up, with the
   * plan trading nobody off the 40: five men worth a place, four protections
   * by fit (37, 38, 39, then 40 with the man out of options coming off) and
   * one hold, the lowest-fit man.
   */
  const fiveForFour = (): void => {
    for (const id of [98080, 98081]) onForty(id);
    regrade(98068, 44, 47);
    db.prepare(`UPDATE players_contract SET no_trade = 1 WHERE player_id = ?`).run(PLAN_MEN.farmOutOfOptions);
    regrade(PLAN_MEN.rule5Depth, 40, 52);
  };
  const fortyCards = (p: Plan): PlanMove[] => p.moves.filter((m) => m.to.rung === '40man');
  const clause = (m: PlanMove) => /not on the 40-man\. (.*); at a \d+ ceiling/.exec(m.reasons[0])?.[1];
  const held = 'protect:98078:40man';

  it('gives a dismissed protection its place back to the men after it, so the held man is protected under the same key', async () => {
    await inScenario(fiveForFour, async () => {
      const before = await plan('all');
      const protects = before.moves.filter((m) => m.kind === 'protect');
      expect(protects.map((m) => m.fortyMan?.count)).toEqual([37, 38, 39, 40]);
      expect(before.moves.find((m) => m.key === held)?.kind).toBe('hold');
      const [first, second] = protects;
      expect(clause(second)).toBe('The 40-man would hold 38 of 40 after the protection above, so a place is open');
      await decide(first.key, 'dismissed');
      const after = await plan('open');
      const open = after.moves.filter((m) => m.kind === 'protect');
      // One protection fewer above every card: the second man now holds the first place
      expect(open.map((m) => m.fortyMan?.count)).toEqual([37, 38, 39, 40]);
      expect(open[0].key).toBe(second.key);
      expect(clause(open[0])).toBe('The 40-man holds 37 of 40, so a place is open');
      // The man who was held takes the place the dismissal gave up, under the key he had as a hold
      expect(open.at(-1)!.key).toBe(held);
      expect(open.at(-1)!.fortyMan?.comesOff?.player_id).toBe(PLAN_MEN.farmOutOfOptions);
      expect(fortyCards(after).filter((m) => m.kind === 'hold')).toEqual([]);
      // The dismissed card is still made, under its own key, so the dismissal keeps its move
      expect((await plan('dismissed')).moves.map((m) => m.key)).toEqual([first.key]);
      expect(await outcomeOf(first.key)).toBeNull();
    });
  });

  it('reserves the place of an accepted protection before the ordering, and keeps it a protection under the same key', async () => {
    await inScenario(fiveForFour, async () => {
      await decide(held, 'accepted');
      const p = await plan('all');
      const protects = p.moves.filter((m) => m.kind === 'protect');
      expect(protects[0].key).toBe(held);
      expect(protects[0].decision.state).toBe('accepted');
      expect(clause(protects[0])).toBe('The 40-man holds 37 of 40, so a place is open');
      expect(protects.map((m) => m.fortyMan?.count)).toEqual([37, 38, 39, 40]);
      // The lowest-fit of the others is now the one held, and each man still has one 40-man card
      const holds = fortyCards(p).filter((m) => m.kind === 'hold');
      expect(holds).toHaveLength(1);
      expect(new Set(fortyCards(p).map((m) => m.player.player_id)).size).toBe(fortyCards(p).length);
      expect((await plan('accepted')).moves.map((m) => [m.key, m.kind])).toEqual([[held, 'protect']]);
    });
  });

  it('keeps an accepted protection a protection when another hold of his would fold it away', async () => {
    const cf = 98074;
    await inScenario(() => {
      // The 40 full, nobody to come off, nobody traded off it: his call-up is held, and so is his protection
      for (const id of [98080, 98081, 98082, 98083, 98084]) onForty(id);
      regrade(98068, 44, 47);
      regrade(cf, 60, 62);
      db.prepare(`UPDATE players_roster_status SET pro_service_years = 5 WHERE player_id = ?`).run(cf);
      db.prepare(`UPDATE players_roster_status SET options_used = 0, options_used_this_year = 0 WHERE player_id IN (?, ?, ?)`)
        .run(PLAN_MEN.lastOptionYear, PLAN_MEN.farmOutOfOptions, PLAN_MEN.mlbOutOfOptions);
    }, async () => {
      const key = `protect:${cf}:40man`;
      const [card] = (await plan('all')).moves.filter((m) => m.player.player_id === cf);
      expect([card.key, card.kind]).toEqual([key, 'hold']);
      await decide(key, 'accepted');
      const cards = (await plan('all')).moves.filter((m) => m.player.player_id === cf);
      expect(cards.map((m) => [m.key, m.kind, m.decision.state])).toEqual([[key, 'protect', 'accepted']]);
      expect(cards[0].reasons[0]).toContain('The 40-man is full at 40 of 40, so a place has to be cleared for him;');
      // The call-up hold is folded into it, not the other way round
      expect(cards[0].reasons).toContain('Would take a place on the 26, but the 40-man is full at 40 of 40 and nobody on it can cheaply give up his place.');
    });
  });

  it('gives the place of a dismissed call-up back to the protections after it', async () => {
    const cf = 98074;
    await inScenario(() => {
      fiveForFour();
      // A Triple-A centre fielder off the 40-man, graded for the big club: his call-up takes a place first
      regrade(cf, 60, 62);
    }, async () => {
      const before = await plan('all');
      const up = before.moves.find((m) => m.kind === 'callup' && m.player.player_id === cf)!;
      expect(up.key).toBe(`callup:${cf}:aaa:mlb`);
      expect(up.fortyMan?.count).toBe(37);
      const protects = before.moves.filter((m) => m.kind === 'protect');
      expect(protects.map((m) => m.fortyMan?.count)).toEqual([38, 39, 40]);
      expect(clause(protects[0])).toBe('The 40-man would hold 38 of 40 after the call-up above, so a place is open');
      expect(fortyCards(before).filter((m) => m.kind === 'hold')).toHaveLength(2);
      await decide(up.key, 'dismissed');
      const after = await plan('open');
      const open = after.moves.filter((m) => m.kind === 'protect');
      // One addition fewer above every card, and the man held for want of a place is protected
      expect(open.map((m) => m.fortyMan?.count)).toEqual([37, 38, 39, 40]);
      expect(clause(open[0])).toBe('The 40-man holds 37 of 40, so a place is open');
      expect(open.some((m) => m.reasons[0].includes('the call-up'))).toBe(false);
      expect(fortyCards(after).filter((m) => m.kind === 'hold')).toHaveLength(1);
      // The dismissed call-up is still made, under its own key
      expect((await plan('dismissed')).moves.map((m) => m.key)).toEqual([up.key]);
      expect(await outcomeOf(up.key)).toBeNull();
      // Forgotten by hand, around the store: the cached plan is not served, and the call-up counts again
      historyDb.prepare(`DELETE FROM plan_decisions`).run();
      expect((await plan('all')).moves.filter((m) => m.kind === 'protect').map((m) => m.fortyMan?.count)).toEqual([38, 39, 40]);
    });
  });

  it('asks the 40-man question of a Rule 5 man whose call-up was dismissed, with the Rule 5 date', async () => {
    const cf = 98074;
    await inScenario(() => {
      fiveForFour();
      regrade(cf, 60, 62);
      // Five pro years: Rule 5 eligible this winter, and his grade passes the gate
      db.prepare(`UPDATE players_roster_status SET pro_service_years = 5 WHERE player_id = ?`).run(cf);
    }, async () => {
      const key = `protect:${cf}:40man`;
      const before = await plan('all');
      // The call-up puts him on the 40-man, which is his protection
      expect(before.moves.filter((m) => m.player.player_id === cf).map((m) => m.kind)).toEqual(['callup']);
      await decide(`callup:${cf}:aaa:mlb`, 'dismissed');
      const after = await plan('open');
      const card = after.moves.find((m) => m.key === key)!;
      expect(card).toBeDefined();
      expect(card.kind).toBe('protect');
      expect(card.deadline).toMatchObject({ kind: 'rule5', date: PLAN.dates.rule5 });
      expect(card.reasons[0]).toMatch(/^Rule 5 eligible on /);
      expect(after.deadlines.some((d) => d.moveKey === key && d.date === PLAN.dates.rule5)).toBe(true);
    });
  });

  it('computes the plan again when a decision is written around the store', async () => {
    await inScenario(fiveForFour, async () => {
      const first = (await plan('all')).moves.find((m) => m.kind === 'protect')!;
      await decide(first.key, 'dismissed');
      expect((await plan('open')).moves.some((m) => m.key === held && m.kind === 'protect')).toBe(true);
      // Forgotten by hand, as a test or another tool might: the cached plan is not served
      historyDb.prepare(`DELETE FROM plan_decisions`).run();
      expect((await plan('all')).moves.find((m) => m.key === held)?.kind).toBe('hold');
    });
  });

  it('stops reserving a place for an acceptance an import settled as not done, so the better man is protected again', async () => {
    await inScenario(fiveForFour, async () => {
      // The lowest-fit man, accepted: he takes the first place and the better man drops to the hold
      await decide(held, 'accepted');
      const accepted = await plan('all');
      expect(accepted.moves.find((m) => m.key === held)?.kind).toBe('protect');
      expect(accepted.moves.find((m) => m.key === 'protect:98132:40man')?.kind).toBe('hold');
      // The deadline passed with him still off the 40-man: the import says changed, and the
      // acceptance no longer steers the count, though the card still shows it
      historyDb.prepare(`UPDATE plan_decisions SET outcome = 'changed', verified_game_date = '2030-12-21' WHERE move_key = ?`).run(held);
      const p = await plan('all');
      expect(p.moves.find((m) => m.key === 'protect:98132:40man')?.kind).toBe('protect');
      const card = p.moves.find((m) => m.key === held)!;
      expect(card.kind).toBe('hold');
      expect(card.decision).toMatchObject({ state: 'accepted', outcome: 'changed' });
      expect(p.moves.filter((m) => m.kind === 'protect').map((m) => m.fortyMan?.count)).toEqual([37, 38, 39, 40]);
    });
  });

  /*
   * The 40-man question keeps one key from winter to winter, so a protection
   * accepted for one Rule 5 date and not made shares its key with the next
   * winter's question. That question is a new one: the card is open, counted
   * open and on the dashboard's chip, and the old acceptance is listed beside
   * it on a row of its own with the deadline it was made against.
   */
  it('asks next winter\'s 40-man question afresh beside a protection that was not made by last winter\'s deadline', async () => {
    const key = 'protect:98088:40man';
    await inScenario(fiveForFour, async () => {
      expect((await plan('all')).moves.find((m) => m.key === key)?.kind).toBe('protect');
      const on = leagueGameDate();
      await decide(key, 'accepted');
      historyDb.prepare(
        `UPDATE plan_decisions SET outcome = 'changed', verified_game_date = '2030-12-21', seen_team_id = ?, seen_label = 'Planner Triples' WHERE move_key = ?`
      ).run(PLAN.teams.aaa, key);
      // The first export after the draft: OOTP has rolled the Rule 5 date a year on
      await inScenario(() => {
        dated('2030-12-21');
        db.prepare(`UPDATE leagues SET rule_5_draft_date = '2031-12-20'`).run();
      }, async () => {
        const all = await plan('all');
        const same = all.moves.filter((m) => m.key === key);
        expect(same).toHaveLength(2);
        // The fresh card: protected at the first place, open, its deadline next winter's and still to make
        const card = same.find((m) => m.decision.state === 'open')!;
        expect(card.kind).toBe('protect');
        expect(card.fortyMan?.count).toBe(37);
        expect(card.deadline?.date).toBe('2031-12-20');
        expect(isSettled(card)).toBe(false);
        expect(card.reasons.at(-1)).toBe(
          `Asked again: it was accepted on ${on} for the ${PLAN.dates.rule5} deadline, and the 2030-12-21 export found it not done.`
        );
        expect(all.deadlines.some((d) => d.moveKey === key && d.date === '2031-12-20')).toBe(true);
        // The old acceptance, on its own row with the deadline it was made against
        const old = same.find((m) => m.decision.state === 'accepted')!;
        expect(old.decision).toMatchObject({ outcome: 'changed', deadlineDate: PLAN.dates.rule5, seenAt: 'Planner Triples' });
        expect(old.deadline?.date).toBe(PLAN.dates.rule5);
        expect(isSettled(old)).toBe(true);
        expect(decisionText(old)).toBe(`Not done by the ${PLAN.dates.rule5} deadline — on Planner Triples, not the 40-man roster, in the 2030-12-21 export`);
        // Open lists the card and not the row; accepted lists the row and not the card
        const open = await plan('open');
        expect(open.moves.filter((m) => m.key === key).map((m) => m.decision.state)).toEqual(['open']);
        const accepted = await plan('accepted');
        expect(accepted.moves.filter((m) => m.key === key).map((m) => [m.decision.state, m.deadline?.date])).toEqual([['accepted', PLAN.dates.rule5]]);
        // Counted open, here and on the dashboard's chip, which counts what the page lists
        expect(all.counts.open).toBe(all.moves.filter((m) => m.decision.state === 'open').length);
        const chip = open.moves.filter((m) => PLAN_DECISION_KINDS.includes(m.kind));
        expect(planMoveCounts(PLAN.org)!.total).toBe(chip.length);
        expect(planMoveCounts(PLAN.org)!.byKind.protect).toBe(chip.filter((m) => m.kind === 'protect').length);
      });
    });
  });

  it('keeps a settled decision on its card while the card asks the question it was made on', async () => {
    const key = 'protect:98088:40man';
    await inScenario(fiveForFour, async () => {
      await decide(key, 'accepted');
      // Not done, and the deadline it was made against is still the card's: the card shows it
      historyDb.prepare(`UPDATE plan_decisions SET outcome = 'changed', verified_game_date = '2030-6-2' WHERE move_key = ?`).run(key);
      let all = await plan('all');
      expect(all.moves.filter((m) => m.key === key).map((m) => [m.decision.state, m.decision.outcome, m.deadline?.date]))
        .toEqual([['accepted', 'changed', PLAN.dates.rule5]]);
      expect((await plan('open')).moves.some((m) => m.key === key)).toBe(false);
      // Done on the same deadline: used up, as before, so the card is open again and says why; no second row
      historyDb.prepare(`UPDATE plan_decisions SET outcome = 'done' WHERE move_key = ?`).run(key);
      all = await plan('all');
      const same = all.moves.filter((m) => m.key === key);
      expect(same.map((m) => [m.decision.state, m.deadline?.date])).toEqual([['open', PLAN.dates.rule5]]);
      expect(same[0].reasons.at(-1)).toBe('Recommended again after it was done on 2030-6-2: he is back where the move started.');
      expect((await plan('accepted')).moves.some((m) => m.key === key)).toBe(false);
      // Done against an earlier deadline than the card's: the card is open and the done row is listed beside it
      await inScenario(() => {
        dated('2030-12-21');
        db.prepare(`UPDATE leagues SET rule_5_draft_date = '2031-12-20'`).run();
      }, async () => {
        const rolled = (await plan('all')).moves.filter((m) => m.key === key);
        expect(rolled.map((m) => [m.decision.state, m.decision.outcome, m.deadline?.date]))
          .toEqual([['open', null, '2031-12-20'], ['accepted', 'done', PLAN.dates.rule5]]);
      });
    });
  });

  it('keeps a dismissed call-up\'s man where he is: nobody is sent down for him, and his 40-man question is asked', async () => {
    const cf = 98074;
    await inScenario(() => {
      fiveForFour();
      regrade(cf, 60, 62);
      db.prepare(`UPDATE players_roster_status SET pro_service_years = 5 WHERE player_id = ?`).run(cf);
    }, async () => {
      const up = `callup:${cf}:aaa:mlb`;
      const before = await plan('all');
      expect(before.moves.some((m) => m.key === up)).toBe(true);
      const sentDown = before.moves.filter((m) => m.kind === 'senddown' && m.linked.includes(up));
      expect(sentDown).toHaveLength(1);
      await decide(up, 'dismissed');
      const p = await plan('all');
      // The card is still made, so the dismissal keeps its key
      expect(p.moves.find((m) => m.key === up)?.decision.state).toBe('dismissed');
      // On the rosters he stays at Triple-A, and nobody leaves the 26 to make room for him
      const rowsOf = (rung: string) => p.levels.find((l) => l.rung === rung)!.roster.filter((r) => r.player_id === cf);
      expect(rowsOf('aaa').map((r) => r.status)).toEqual(['stays']);
      expect(rowsOf('mlb')).toEqual([]);
      expect(p.moves.filter((m) => m.kind === 'senddown')).toEqual([]);
      expect(p.moves.some((m) => m.key === sentDown[0].key)).toBe(false);
      // His 40-man question is asked, and is open
      const forty = p.moves.find((m) => m.key === `protect:${cf}:40man`)!;
      expect(forty).toBeDefined();
      expect(forty.decision.state).toBe('open');
    });
  });

  it('counts an accepted protection made with the 40-man full among the protections above the cards after it', async () => {
    const cf = 98074;
    await inScenario(() => {
      // The 40 full, nobody to come off, nobody traded off it, and two men worth a place
      for (const id of [98080, 98081, 98082, 98083, 98084]) onForty(id);
      regrade(98068, 44, 47);
      regrade(cf, 60, 62);
      regrade(PLAN_MEN.rule5Depth, 40, 52);
      db.prepare(`UPDATE players_roster_status SET pro_service_years = 5 WHERE player_id = ?`).run(cf);
      db.prepare(`UPDATE players_roster_status SET options_used = 0, options_used_this_year = 0 WHERE player_id IN (?, ?, ?)`)
        .run(PLAN_MEN.lastOptionYear, PLAN_MEN.farmOutOfOptions, PLAN_MEN.mlbOutOfOptions);
    }, async () => {
      const key = `protect:${cf}:40man`;
      await decide(key, 'accepted');
      const p = await plan('all');
      const forty = fortyCards(p);
      const protects = forty.filter((m) => m.kind === 'protect');
      expect(protects.map((m) => m.key)).toEqual([key]);
      expect(protects[0].reasons[0]).toContain('The 40-man is full at 40 of 40, so a place has to be cleared for him;');
      // Every card after it says the protection above is counted
      const after = forty.filter((m) => m.kind === 'hold');
      expect(after.length).toBeGreaterThan(0);
      for (const m of after) expect(m.reasons[0], m.key).toContain('the 40-man would be full: 40 of 40 after the protection above');
    });
  });
});

describe('an accepted protection when he changes clubs', () => {
  it('keeps his acceptance when the promotion the plan recommended is made, and still reserves his place first', async () => {
    const id = PLAN_MEN.rule5Grade;
    const before = await plan('all');
    // His 40-man question as the plan asks it of a Double-A man, keyed by the man alone
    const card = before.moves.find((m) => m.player.player_id === id && m.to.rung === '40man')!;
    expect([card.key, card.kind, card.from.rung]).toEqual([`protect:${id}:40man`, 'protect', 'aa']);
    const key = card.key;
    await decide(key, 'accepted');
    // Promoted to Triple-A, still off the 40-man: the question is the same, so it keeps its key
    await inScenario(() => moveTo(id, PLAN.teams.aaa), async () => {
      const p = await plan('all');
      const protects = p.moves.filter((m) => m.kind === 'protect');
      expect(protects[0].key).toBe(key);
      expect(protects[0].from.rung).toBe('aaa');
      expect(protects[0].decision.state).toBe('accepted');
      expect(protects[0].fortyMan?.count).toBe(Math.min(...protects.map((m) => m.fortyMan!.count)));
      // Nothing is left over as an acceptance the plan no longer recommends
      expect((await plan('accepted')).moves.map((m) => m.key)).toEqual([key]);
    });
  });

  it('keeps the deadline it was accepted against once the plan stops asking, and says he is not on the 40-man rather than not where a move sent him', async () => {
    const id = PLAN_MEN.rule5Grade;
    const key = `protect:${id}:40man`;
    expect((await plan('all')).moves.find((m) => m.key === key)?.kind).toBe('protect');
    await decide(key, 'accepted');
    await inScenario(() => {
      // Promoted to Triple-A since, never added to the 40-man, and graded down so the plan no
      // longer asks: the import after the deadline found him off the list
      moveTo(id, PLAN.teams.aaa);
      db.prepare(`UPDATE players_value SET oa = 30, pot = 35, oa_rating = 30, pot_rating = 35 WHERE player_id = ?`).run(id);
      historyDb.prepare(
        `UPDATE plan_decisions SET outcome = 'changed', verified_game_date = '2030-12-21', seen_team_id = ?, seen_label = 'Planner Triples' WHERE move_key = ?`
      ).run(PLAN.teams.aaa, key);
    }, async () => {
      expect((await plan('open')).moves.some((m) => m.key === key)).toBe(false);
      const p = await plan('accepted');
      const settled = p.moves.find((m) => m.key === key)!;
      expect(settled).toBeDefined();
      expect(settled.deadline?.date).toBe(PLAN.dates.rule5);
      // The deadline the decision was made under rides on the decision itself
      expect(settled.decision.deadlineDate).toBe(PLAN.dates.rule5);
      expect(settled.reasons[0]).toBe(`Accepted on ${settled.decision.gameDate}; the 2030-12-21 export found him on Planner Triples, not on the 40-man roster.`);
      expect(settled.reasons.some((r) => r.includes('not where the move sent him'))).toBe(false);
      expect(decisionText(settled)).toBe(`Not done by the ${PLAN.dates.rule5} deadline — on Planner Triples, not the 40-man roster, in the 2030-12-21 export`);
    });
  });

  it('rewrites the keys earlier builds stored with his rung in them, once, keeping the latest decision of a man', async () => {
    const id = PLAN_MEN.rule5Grade;
    const insert = historyDb.prepare(
      `INSERT INTO plan_decisions (save_name, org_id, move_key, player_id, kind, to_rung, decision, decided_at, verify_json)
       VALUES (?, ?, ?, ?, 'protect', '40man', ?, ?, '{"field":"on40","expect":true}')`
    );
    insert.run(currentSaveName(), PLAN.org, `protect:${id}:single-a:40man`, id, 'dismissed', '2030-05-01T00:00:00.000Z');
    insert.run(currentSaveName(), PLAN.org, `protect:${id}:aa:40man`, id, 'accepted', '2030-05-20T00:00:00.000Z');
    insert.run(currentSaveName(), PLAN.org, 'protect:98078:aaa:40man', 98078, 'dismissed', '2030-05-20T00:00:00.000Z');
    insert.run(currentSaveName(), PLAN.org, promote.key, promote.player.player_id, 'accepted', '2030-05-20T00:00:00.000Z');
    expect(migratePlanDecisions()).toEqual([]);
    const keys = () => (historyDb.prepare(`SELECT move_key, decision FROM plan_decisions ORDER BY move_key`).all() as
      Array<{ move_key: string; decision: string }>).map((r) => `${r.move_key}=${r.decision}`);
    expect(keys()).toEqual([`${promote.key}=accepted`, `protect:${id}:40man=accepted`, 'protect:98078:40man=dismissed'].sort());
    // Once is enough: a second pass changes nothing
    migratePlanDecisions();
    expect(keys()).toEqual([`${promote.key}=accepted`, `protect:${id}:40man=accepted`, 'protect:98078:40man=dismissed'].sort());
    // And the plan reads the acceptance under the key it asks the question with
    const card = (await plan('all')).moves.find((m) => m.key === `protect:${id}:40man`)!;
    expect(card.decision.state).toBe('accepted');
  });
});

describe('levelChanged from the last two snapshots', () => {
  const id = () => promote.player.player_id;
  const snapshot = (gameDate: string, level: number) =>
    historyDb
      .prepare(`INSERT OR REPLACE INTO rating_snapshots (save_name, game_date, player_id, name, team_id, org_id, level) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(currentSaveName(), gameDate, id(), promote.player.name, promote.from.team_id, PLAN.org, level);
  const clean = () => historyDb.prepare(`DELETE FROM rating_snapshots WHERE player_id = ?`).run(id());

  it('is null with fewer than two snapshots, true when his level moved, false when it did not', async () => {
    await decide(promote.key, 'accepted');
    try {
      clean();
      expect((await listed())[0].levelChanged).toBeNull();
      snapshot('2030-5-1', 3);
      expect((await listed())[0].levelChanged).toBeNull();
      snapshot('2030-6-1', 3);
      expect((await listed())[0].levelChanged).toBe(false);
      // Unpadded dates are ordered as dates, not as text: October comes after June
      snapshot('2030-10-1', 2);
      expect((await listed())[0].levelChanged).toBe(true);
      snapshot('2030-10-15', 2);
      expect((await listed())[0].levelChanged).toBe(false);
    } finally {
      clean();
    }
  });
});

describe('a save switch', () => {
  const B = 'Planner Save B';
  const configPath = path.join(process.env.OOTP_FO_DATA_DIR!, 'config.json');
  const rowsOf = (save: string) =>
    historyDb.prepare(`SELECT move_key, decision, outcome FROM plan_decisions WHERE save_name = ? ORDER BY move_key`).all(save) as
      Array<{ move_key: string; decision: string; outcome: string | null }>;
  const send = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${base()}${url}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const waitForImport = async () => {
    for (let i = 0; i < 200; i++) {
      if (!(await request('/api/status')).importing) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('the import never finished');
  };

  it('decides, retires and verifies nothing until the new save is imported, and never writes one save against the other\'s plan', async () => {
    const A = currentSaveName();
    const savedConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null;
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ootp-fo-switch-'));
    try {
      await decide(promote.key, 'accepted');
      // Save B already has a dismissal of its own that save A's plan does not produce
      historyDb
        .prepare(`INSERT INTO plan_decisions (save_name, org_id, move_key, player_id, kind, decision) VALUES (?, ?, 'promote:98999:aa:aaa', 98999, 'promote', 'dismissed')`)
        .run(B, PLAN.org);

      // The user picks save B; its folder is not there yet, so nothing is imported and league.db is still A's
      await post('/api/config', { csvDir: path.join(folder, 'not-yet-exported'), saveName: B });
      expect(currentSaveName()).toBe(B);
      expect(planSaveSwitchPending()).toContain(B);

      // Accept and reopen are refused with the reason, and nothing is written under B
      const accept = await send('POST', `/api/plan/${PLAN.org}/decisions`, { moveKey: forced.key, decision: 'accepted' });
      expect(accept.status).toBe(409);
      expect(accept.body.ok).toBe(false);
      expect(accept.body.error).toContain(B);
      expect((await send('DELETE', `/api/plan/${PLAN.org}/decisions/${encodeURIComponent(promote.key)}`)).status).toBe(409);

      // The plan still reads, with A's decisions beside A's league, and retires none of B's dismissals
      const p = await plan('all');
      expect(p.moves.find((m) => m.key === promote.key)?.decision.state).toBe('accepted');
      expect(verifyPlanDecisions()).toEqual([]);
      expect(rowsOf(B)).toEqual([{ move_key: 'promote:98999:aa:aaa', decision: 'dismissed', outcome: null }]);
      expect(rowsOf(A)).toEqual([{ move_key: promote.key, decision: 'accepted', outcome: null }]);

      // B's export arrives and is imported: decisions are B's from here on
      fs.writeFileSync(path.join(folder, 'zz_switch_probe.csv'), 'a\n1\n');
      await post('/api/config', { csvDir: folder, saveName: B });
      await waitForImport();
      expect(planSaveSwitchPending()).toBeNull();
      await plan(); // B's plan is drawn, and B's stale dismissal is retired against it
      expect(rowsOf(B)).toEqual([{ move_key: 'promote:98999:aa:aaa', decision: 'dismissed', outcome: 'moot' }]);
      const now = await send('POST', `/api/plan/${PLAN.org}/decisions`, { moveKey: forced.key, decision: 'accepted' });
      expect(now.status).toBe(200);
      expect(rowsOf(B).map((r) => r.move_key)).toEqual([forced.key, 'promote:98999:aa:aaa'].sort());
      // A's own decision was never touched
      expect(rowsOf(A)).toEqual([{ move_key: promote.key, decision: 'accepted', outcome: null }]);
    } finally {
      stopWatcher();
      if (savedConfig === null) fs.rmSync(configPath, { force: true });
      else fs.writeFileSync(configPath, savedConfig);
      setPlanLeagueSave(null);
      db.exec('DROP TABLE IF EXISTS zz_switch_probe');
      for (const table of ['plan_decisions', 'rating_snapshots', 'contract_snapshots']) {
        historyDb.prepare(`DELETE FROM ${table} WHERE save_name = ?`).run(B);
      }
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
