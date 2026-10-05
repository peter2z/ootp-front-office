import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentSaveName, historyDb, leagueGameDate } from '../server/history.js';
import {
  decidePlanMove, migratePlanDecisions, planDecisions, PlanSaveSwitchError, reopenPlanMove, retireDismissals,
  setPlanLeagueSave, verifyDecisions, type Standing,
} from '../server/plandecisions.js';
import type { PlanMove } from '../server/planTypes.js';

/**
 * The decision store on its own, below the planner: what it writes, what it
 * reads back, and what an import makes of an accepted move.
 *
 * The verifier is fed a stub of where each man stands rather than a league
 * database, because the rules it applies — done, not yet, changed, moot, and
 * the deadline that turns a not-yet into a changed — are about the predicate
 * and the row, not about how a rung is read. The planner's own tests cover
 * that join through HTTP.
 */

const ORG = 15;

function move(over: Partial<PlanMove> & { key: string; player_id?: number }): PlanMove {
  const player_id = over.player_id ?? 127542;
  return {
    kind: 'forced',
    horizon: 'now',
    forced: true,
    player: {
      player_id, name: 'Joendry Vargas', age: 22, positionName: '3B', roleLabel: null, oa: 39, pot: 47,
      bats: 'R', throws: 'R', utility: 'IF', assetClass: 'prospect',
    },
    from: { rung: 'high-a', label: 'Great Lakes Loons', team_id: 198 },
    to: { rung: 'aa', label: 'Tulsa Drillers', team_id: 81, position: null, role: null },
    reasons: ['This is his last eligible season at High-A.'],
    screen: 'Player page → Transactions',
    ootpSteps: ['Open Joendry Vargas (Great Lakes Loons)'],
    deadline: { kind: 'service-cap', date: '2028-9-10', what: 'Last eligible season at High-A', daysAway: 118 },
    verify: { field: 'rung', expect: 'aa' },
    fortyMan: null,
    linked: [],
    decision: { state: 'open', gameDate: null, outcome: null, verifiedGameDate: null },
    ...over,
  };
}

const at = (over: Partial<Standing>): Standing => ({
  rung: 'high-a', inOrg: true, position: 5, roleClass: null, on40: false, il60: false, rostered: true, teamId: 198, ...over,
});

beforeEach(() => {
  historyDb.prepare(`DELETE FROM plan_decisions`).run();
});

describe('decide, list, reopen', () => {
  it('records a decision stamped with the game date and the move\'s predicate', () => {
    const before = Date.now();
    const d = decidePlanMove(ORG, move({ key: 'forced:127542:high-a:aa' }), 'accepted');
    expect(d.state).toBe('accepted');
    expect(d.gameDate).toBe(leagueGameDate());
    expect(d.gameDate).toMatch(/^\d{4}-\d{1,2}-\d{1,2}$/);
    expect(Date.parse(d.decidedAt!)).toBeGreaterThanOrEqual(before - 1000);
    expect(d.verify).toEqual({ field: 'rung', expect: 'aa' });
    expect(d.deadlineDate).toBe('2028-9-10');
    expect(d.fromTeamId).toBe(198);
    expect(d.toTeamId).toBe(81);
    expect(d.kind).toBe('forced');
    expect(d.outcome).toBeNull();
    expect(d.verifiedGameDate).toBeNull();

    const listed = planDecisions(ORG);
    expect([...listed.keys()]).toEqual(['forced:127542:high-a:aa']);
    expect(listed.get('forced:127542:high-a:aa')).toEqual(d);
  });

  it('replaces a decision and starts verification over', () => {
    decidePlanMove(ORG, move({ key: 'k' }), 'accepted');
    historyDb.prepare(`UPDATE plan_decisions SET outcome = 'done', verified_game_date = '2028-8-4'`).run();
    const d = decidePlanMove(ORG, move({ key: 'k' }), 'dismissed');
    expect(d.state).toBe('dismissed');
    expect(d.outcome).toBeNull();
    expect(d.verifiedGameDate).toBeNull();
    expect(planDecisions(ORG).size).toBe(1);
  });

  it('reopens a move, and says whether there was anything to reopen', () => {
    decidePlanMove(ORG, move({ key: 'k' }), 'dismissed');
    expect(reopenPlanMove(ORG, 'k')).toBe(true);
    expect(planDecisions(ORG).size).toBe(0);
    expect(reopenPlanMove(ORG, 'k')).toBe(false);
  });

  it('is keyed by save and by org', () => {
    decidePlanMove(ORG, move({ key: 'mine' }), 'accepted');
    decidePlanMove(ORG + 1, move({ key: 'other-org' }), 'accepted');
    historyDb
      .prepare(
        `INSERT INTO plan_decisions (save_name, org_id, move_key, player_id, kind, decision)
         VALUES ('another save', ?, 'other-save', 1, 'promote', 'accepted')`
      )
      .run(ORG);
    expect([...planDecisions(ORG).keys()]).toEqual(['mine']);
    expect([...planDecisions(ORG + 1).keys()]).toEqual(['other-org']);
    expect(planDecisions(ORG).get('mine')!.orgId).toBe(ORG);
    expect(currentSaveName()).not.toBe('another save');
  });

  it('stores a hold without a predicate', () => {
    const d = decidePlanMove(ORG, move({ key: 'hold:1:aaa:aaa', kind: 'hold', verify: null, deadline: null }), 'dismissed');
    expect(d.verify).toBeNull();
    expect(d.deadlineDate).toBeNull();
  });
});

describe('verifyDecisions', () => {
  const GAME_DATE = '2028-8-4';

  it('reads done, not yet, changed and moot off where each man stands', () => {
    decidePlanMove(ORG, move({ key: 'done', player_id: 1 }), 'accepted');
    decidePlanMove(ORG, move({ key: 'not-yet', player_id: 2 }), 'accepted');
    decidePlanMove(ORG, move({ key: 'changed', player_id: 3 }), 'accepted');
    decidePlanMove(ORG, move({ key: 'moot', player_id: 4 }), 'accepted');
    decidePlanMove(ORG, move({ key: 'moot-gone', player_id: 5 }), 'accepted');
    const standing: Record<number, Standing | null> = {
      1: at({ rung: 'aa', teamId: 81 }),
      2: at({}),
      3: at({ rung: 'aaa', teamId: 52 }),
      4: at({ inOrg: false, rung: null, teamId: 999 }),
      5: null,
    };
    const updated = verifyDecisions((_org, id) => standing[id], GAME_DATE);
    const outcomes = Object.fromEntries(updated.map((d) => [d.moveKey, d.outcome]));
    expect(outcomes).toEqual({ done: 'done', 'not-yet': 'not-yet', changed: 'changed', moot: 'moot', 'moot-gone': 'moot' });
    for (const d of updated) expect(d.verifiedGameDate).toBe(GAME_DATE);

    const stored = planDecisions(ORG);
    expect(stored.get('done')!.outcome).toBe('done');
    expect(stored.get('done')!.verifiedGameDate).toBe(GAME_DATE);
    expect(stored.get('changed')!.outcome).toBe('changed');
  });

  it('verifies a release or trade by his absence', () => {
    const out = (key: string, player_id: number, kind: 'release' | 'trade') =>
      move({
        key, player_id, kind, forced: false,
        to: { rung: 'out', label: 'out', team_id: null, position: null, role: null },
        verify: { field: 'org', expect: 'gone' },
        deadline: null,
      });
    decidePlanMove(ORG, out('release:1', 1, 'release'), 'accepted');
    decidePlanMove(ORG, out('trade:2', 2, 'trade'), 'accepted');
    decidePlanMove(ORG, out('trade:3', 3, 'trade'), 'accepted');
    const standing: Record<number, Standing | null> = {
      1: null,
      2: at({ inOrg: false, teamId: 999 }),
      3: at({ rung: 'aa', teamId: 81 }), // moved within the org: still here
    };
    const outcomes = Object.fromEntries(verifyDecisions((_o, id) => standing[id], GAME_DATE).map((d) => [d.moveKey, d.outcome]));
    expect(outcomes).toEqual({ 'release:1': 'done', 'trade:2': 'done', 'trade:3': 'not-yet' });
  });

  it('accepts any rung at or above the one an offseason move named', () => {
    decidePlanMove(ORG, move({ key: 'off', player_id: 1, horizon: 'offseason' }), 'accepted');
    decidePlanMove(ORG, move({ key: 'now', player_id: 2, horizon: 'now' }), 'accepted');
    const above = at({ rung: 'aaa', teamId: 52 });
    const outcomes = Object.fromEntries(verifyDecisions(() => above, GAME_DATE).map((d) => [d.moveKey, d.outcome]));
    expect(outcomes).toEqual({ off: 'done', now: 'changed' });
  });

  it('checks the other predicate fields', () => {
    const same = { rung: 'aaa' as const, label: 'Oklahoma City Comets', team_id: 52 };
    const cases: Array<[string, PlanMove['verify'], Partial<Standing>, string]> = [
      ['protect', { field: 'on40', expect: true }, { on40: true }, 'done'],
      ['protect-no', { field: 'on40', expect: true }, { on40: false }, 'not-yet'],
      ['il60', { field: 'il60', expect: true }, { il60: true }, 'done'],
      ['assign', { field: 'rostered', expect: true }, { rostered: true }, 'done'],
      ['assign-no', { field: 'rostered', expect: true }, { rostered: false }, 'not-yet'],
      ['position', { field: 'position', expect: 6 }, { position: 6 }, 'done'],
      ['position-no', { field: 'position', expect: 6 }, { position: 5 }, 'not-yet'],
      ['role', { field: 'role', expect: 'SP' }, { roleClass: 'SP' }, 'done'],
      ['role-no', { field: 'role', expect: 'SP' }, { roleClass: 'RP' }, 'not-yet'],
    ];
    cases.forEach(([key, verify, , ], i) => {
      decidePlanMove(ORG, move({ key, player_id: i + 1, from: same, to: { ...same, position: null, role: null }, verify, deadline: null }), 'accepted');
    });
    const standing = (id: number) => at({ rung: 'aaa', teamId: 52, ...cases[id - 1][2] });
    const outcomes = Object.fromEntries(verifyDecisions((_o, id) => standing(id), GAME_DATE).map((d) => [d.moveKey, d.outcome]));
    expect(outcomes).toEqual(Object.fromEntries(cases.map(([key, , , expected]) => [key, expected])));
  });

  it('re-checks a not-yet on every import until the deadline passes, then marks it changed', () => {
    decidePlanMove(ORG, move({ key: 'k', player_id: 1 }), 'accepted'); // deadline 2028-9-10
    expect(verifyDecisions(() => at({}), '2028-8-4')[0].outcome).toBe('not-yet');
    expect(verifyDecisions(() => at({}), '2028-9-10')[0].outcome).toBe('not-yet');
    // Unpadded dates compare as dates, not as text: 9-11 is after 9-10 and before 12-20
    expect(verifyDecisions(() => at({}), '2028-9-11')[0].outcome).toBe('changed');
    expect(planDecisions(ORG).get('k')!.outcome).toBe('changed');
    // Once changed it is not revisited, even by an import that would read it done
    expect(verifyDecisions(() => at({ rung: 'aa', teamId: 81 }), '2028-12-20')).toEqual([]);
  });

  it('reads a move made on the deadline\'s last day as done, and a late one as done too', () => {
    decidePlanMove(ORG, move({ key: 'k', player_id: 1 }), 'accepted');
    expect(verifyDecisions(() => at({ rung: 'aa', teamId: 81 }), '2028-9-10')[0].outcome).toBe('done');
    decidePlanMove(ORG, move({ key: 'late', player_id: 2 }), 'accepted');
    expect(verifyDecisions(() => at({ rung: 'aa', teamId: 81 }), '2029-4-4').map((d) => d.moveKey)).toEqual(['late']);
  });

  it('leaves dismissed moves, settled outcomes and holds alone', () => {
    decidePlanMove(ORG, move({ key: 'dismissed', player_id: 1 }), 'dismissed');
    decidePlanMove(ORG, move({ key: 'settled', player_id: 2 }), 'accepted');
    historyDb.prepare(`UPDATE plan_decisions SET outcome = 'done', verified_game_date = '2028-6-1' WHERE move_key = 'settled'`).run();
    decidePlanMove(ORG, move({ key: 'hold', player_id: 3, kind: 'hold', verify: null }), 'accepted');
    const asked: number[] = [];
    const updated = verifyDecisions((_o, id) => { asked.push(id); return at({ rung: 'aa', teamId: 81 }); }, GAME_DATE);
    expect(updated).toEqual([]);
    expect(asked).toEqual([3]); // the hold is looked at and found to have nothing to check
    expect(planDecisions(ORG).get('hold')!.outcome).toBeNull();
    expect(planDecisions(ORG).get('settled')!.verifiedGameDate).toBe('2028-6-1');
  });

  it('stamps where he was seen: the club when done or changed, nothing while not yet, out of the organization once gone', () => {
    decidePlanMove(ORG, move({ key: 'done', player_id: 1 }), 'accepted');
    decidePlanMove(ORG, move({ key: 'not-yet', player_id: 2 }), 'accepted');
    decidePlanMove(ORG, move({ key: 'changed', player_id: 3 }), 'accepted');
    decidePlanMove(ORG, move({ key: 'moot', player_id: 4 }), 'accepted');
    decidePlanMove(ORG, move({
      key: 'release', player_id: 5, kind: 'release', to: { rung: 'out', label: 'released', team_id: null, position: null, role: null },
      verify: { field: 'org', expect: 'gone' }, deadline: null,
    }), 'accepted');
    const standing: Record<number, Standing | null> = {
      1: at({ rung: 'aa', teamId: 81, teamLabel: 'Tulsa Drillers' }),
      2: at({ teamLabel: 'Great Lakes Loons' }),
      3: at({ rung: 'aaa', teamId: 52, teamLabel: 'Oklahoma City Comets' }),
      4: at({ inOrg: false, rung: null, teamId: 999, teamLabel: 'Somebody Else' }),
      5: null,
    };
    const seen = Object.fromEntries(verifyDecisions((_o, id) => standing[id], GAME_DATE).map((d) => [d.moveKey, [d.outcome, d.seenAt, d.seenTeamId]]));
    expect(seen).toEqual({
      done: ['done', 'Tulsa Drillers', 81],
      'not-yet': ['not-yet', null, null],
      changed: ['changed', 'Oklahoma City Comets', 52],
      moot: ['moot', 'out of the organization', 999],
      release: ['done', 'out of the organization', null],
    });
    // Stored, and read back the same way
    const stored = planDecisions(ORG);
    expect(stored.get('changed')!.seenAt).toBe('Oklahoma City Comets');
    expect(stored.get('changed')!.seenTeamId).toBe(52);
    expect(stored.get('not-yet')!.seenAt).toBeNull();
    // Deciding again starts over, place and all
    decidePlanMove(ORG, move({ key: 'done', player_id: 1 }), 'accepted');
    expect(planDecisions(ORG).get('done')!.seenAt).toBeNull();
  });

  it('reads a list move not yet wherever he plays, and still reads a club move changed when he went elsewhere', () => {
    const tulsa = { rung: 'aa' as const, label: 'Tulsa Drillers', team_id: 81 };
    const protect = (key: string, player_id: number) =>
      move({
        key, player_id, kind: 'protect', forced: false, from: tulsa,
        to: { rung: '40man', label: '40-man roster', team_id: 15, position: null, role: null },
        verify: { field: 'on40', expect: true },
        deadline: { kind: 'rule5', date: '2028-12-20', what: 'Rule 5 draft', daysAway: 219 },
      });
    decidePlanMove(ORG, protect('protect:1:aa:40man', 1), 'accepted');
    decidePlanMove(ORG, move({ key: 'position', player_id: 2, from: tulsa, verify: { field: 'position', expect: 6 }, deadline: null }), 'accepted');
    decidePlanMove(ORG, move({ key: 'promote', player_id: 3, kind: 'promote', horizon: 'now', from: tulsa, verify: { field: 'rung', expect: 'aaa' }, deadline: null }), 'accepted');
    // All three promoted to Oklahoma City first; none of them on the 40 or at short
    const okc = at({ rung: 'aaa', teamId: 52, on40: false, position: 5 });
    const first = Object.fromEntries(verifyDecisions(() => okc, '2028-7-20').map((d) => [d.moveKey, d.outcome]));
    expect(first).toEqual({ 'protect:1:aa:40man': 'not-yet', position: 'not-yet', promote: 'done' });
    // Added to the 40 in November, still at Oklahoma City
    const second = verifyDecisions((_o, id) => (id === 1 ? at({ rung: 'aaa', teamId: 52, on40: true }) : okc), '2028-11-15');
    expect(second.map((d) => [d.moveKey, d.outcome])).toEqual([['position', 'not-yet'], ['protect:1:aa:40man', 'done']]);
    // A club move that did not happen, with him on a third club, is still changed
    decidePlanMove(ORG, move({ key: 'promote-2', player_id: 4, kind: 'promote', from: tulsa, verify: { field: 'rung', expect: 'aaa' }, deadline: null }), 'accepted');
    expect(verifyDecisions(() => at({ rung: 'high-a', teamId: 198 }), '2028-11-15').find((d) => d.moveKey === 'promote-2')!.outcome).toBe('changed');
  });

  it('keeps an offseason move not yet until the next Opening Day, whatever club he is on, then judges it', () => {
    decidePlanMove(ORG, move({ key: 'off', player_id: 1, horizon: 'offseason' }), 'accepted'); // deadline 2028-9-10, his last game
    const stays = at({});
    // After his season ends; this season's Opening Day is behind the deadline, so it does not close anything
    expect(verifyDecisions(() => stays, '2028-9-20', '2028-3-30')[0].outcome).toBe('not-yet');
    // Moved to another High-A club over the winter: not judged by club in the offseason
    expect(verifyDecisions(() => at({ teamId: 199 }), '2028-12-1', '2028-3-30')[0].outcome).toBe('not-yet');
    // The save has rolled over and Opening Day 2029 is still ahead
    expect(verifyDecisions(() => stays, '2029-3-31', '2029-4-1')[0].outcome).toBe('not-yet');
    // An export without a start date never closes the window on a guess
    expect(verifyDecisions(() => stays, '2029-6-1', null)[0].outcome).toBe('not-yet');
    // Opening Day itself: he did not move, so it is changed, and where he was is kept
    const [d] = verifyDecisions(() => at({ teamLabel: 'Great Lakes Loons' }), '2029-4-1', '2029-4-1');
    expect([d.outcome, d.seenAt]).toEqual(['changed', 'Great Lakes Loons']);
  });

  it('reads an offseason move done the moment he is at or above its rung, before Opening Day', () => {
    decidePlanMove(ORG, move({ key: 'off', player_id: 1, horizon: 'offseason' }), 'accepted');
    expect(verifyDecisions(() => at({ rung: 'aa', teamId: 81, teamLabel: 'Tulsa Drillers' }), '2028-11-1', '2028-3-30').map((d) => [d.outcome, d.seenAt]))
      .toEqual([['done', 'Tulsa Drillers']]);
  });

  it('covers every org of the save in one pass', () => {
    decidePlanMove(ORG, move({ key: 'a', player_id: 1 }), 'accepted');
    decidePlanMove(ORG + 1, move({ key: 'b', player_id: 1 }), 'accepted');
    const seen: Array<[number, number]> = [];
    verifyDecisions((org, id) => { seen.push([org, id]); return at({ rung: 'aa', teamId: 81 }); }, GAME_DATE);
    expect(seen).toEqual([[ORG, 1], [ORG + 1, 1]]);
  });
});

describe('retireDismissals', () => {
  it('marks a dismissed key the planner no longer produces as moot', () => {
    decidePlanMove(ORG, move({ key: 'still', player_id: 1 }), 'dismissed');
    decidePlanMove(ORG, move({ key: 'gone', player_id: 2 }), 'dismissed');
    decidePlanMove(ORG, move({ key: 'accepted-gone', player_id: 3 }), 'accepted');
    expect(retireDismissals(ORG, ['still'], '2028-8-4')).toBe(1);
    const stored = planDecisions(ORG);
    expect(stored.get('still')!.outcome).toBeNull();
    expect(stored.get('gone')!.outcome).toBe('moot');
    expect(stored.get('gone')!.verifiedGameDate).toBe('2028-8-4');
    // An accepted move that vanished is the verifier's business, not this one's
    expect(stored.get('accepted-gone')!.outcome).toBeNull();
    expect(retireDismissals(ORG, ['still'], '2028-8-4')).toBe(0);
  });
});

describe('a history.db written before the place a man was seen was kept', () => {
  it('gains the two columns and keeps its rows; a second run adds nothing', () => {
    const old = new Database(':memory:');
    old.exec(`
      CREATE TABLE plan_decisions (
        save_name TEXT NOT NULL, org_id INTEGER NOT NULL, move_key TEXT NOT NULL,
        player_id INTEGER NOT NULL, player_name TEXT, kind TEXT NOT NULL, horizon TEXT,
        from_rung TEXT, from_team_id INTEGER, to_rung TEXT, to_team_id INTEGER, target INTEGER,
        decision TEXT NOT NULL, decided_game_date TEXT, decided_at TEXT,
        verify_json TEXT, deadline_date TEXT, outcome TEXT, verified_game_date TEXT,
        PRIMARY KEY (save_name, org_id, move_key)
      );
      INSERT INTO plan_decisions (save_name, org_id, move_key, player_id, kind, decision, outcome)
      VALUES ('s', 15, 'k', 1, 'promote', 'accepted', 'done');
    `);
    expect(migratePlanDecisions(old)).toEqual(['seen_team_id', 'seen_label']);
    expect(old.prepare(`SELECT move_key, outcome, seen_team_id, seen_label FROM plan_decisions`).all())
      .toEqual([{ move_key: 'k', outcome: 'done', seen_team_id: null, seen_label: null }]);
    expect(migratePlanDecisions(old)).toEqual([]);
    old.close();
    // The live table already has them
    expect(migratePlanDecisions()).toEqual([]);
  });
});

describe('while a save switch is importing', () => {
  afterEach(() => setPlanLeagueSave(null));

  it('reads the loaded save\'s decisions and writes, retires and verifies nothing', () => {
    decidePlanMove(ORG, move({ key: 'mine', player_id: 1 }), 'accepted');
    decidePlanMove(ORG, move({ key: 'dismissed', player_id: 2 }), 'dismissed');
    // league.db still holds this save while the config already names another
    setPlanLeagueSave('the save league.db holds');
    expect(() => decidePlanMove(ORG, move({ key: 'new', player_id: 3 }), 'accepted')).toThrow(PlanSaveSwitchError);
    expect(() => reopenPlanMove(ORG, 'mine')).toThrow(PlanSaveSwitchError);
    expect(retireDismissals(ORG, [], '2028-8-4')).toBe(0);
    expect(verifyDecisions(() => at({ rung: 'aa', teamId: 81 }), '2028-8-4')).toEqual([]);
    // The plan on screen is the loaded save's, so the decisions beside it are too
    expect(planDecisions(ORG).size).toBe(0);
    setPlanLeagueSave(currentSaveName());
    const stored = planDecisions(ORG);
    expect([...stored.keys()]).toEqual(['dismissed', 'mine']);
    expect(stored.get('mine')!.outcome).toBeNull();
    expect(stored.get('dismissed')!.outcome).toBeNull();
  });
});
