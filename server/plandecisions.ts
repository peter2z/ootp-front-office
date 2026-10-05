import type Database from 'better-sqlite3';
import { clubLabelOf, currentSaveName, historyDb, leagueGameDate, leagueOpeningDay } from './history.js';
import {
  RUNG_KEYS, type DecisionOutcome, type Horizon, type MoveDecision, type MoveKind, type PlanMove, type Verify,
} from './planTypes.js';

/**
 * What the user said about each of the planner's moves, kept across imports.
 *
 * The planner is deterministic: the same export and the same settings give
 * the same moves, with the same keys. That is what makes a decision worth
 * remembering — accept a promotion today and the key is still there after the
 * next import, so the app can look at the new export and say whether the move
 * happened. Lives in history.db because league.db is rebuilt on every import,
 * and keyed by save because one person runs more than one.
 *
 * The verify predicate is stored with the decision, not recomputed: the plan
 * that produced the move may differ after the next import (the man may have
 * moved, which is the point), and the question to answer is whether what was
 * accepted happened, not whether the new plan would still ask for it.
 */
historyDb.exec(`
  CREATE TABLE IF NOT EXISTS plan_decisions (
    save_name TEXT NOT NULL, org_id INTEGER NOT NULL, move_key TEXT NOT NULL,
    player_id INTEGER NOT NULL, player_name TEXT, kind TEXT NOT NULL, horizon TEXT,
    from_rung TEXT, from_team_id INTEGER, to_rung TEXT, to_team_id INTEGER, target INTEGER,
    decision TEXT NOT NULL CHECK (decision IN ('accepted','dismissed')),
    decided_game_date TEXT, decided_at TEXT,
    verify_json TEXT, deadline_date TEXT,
    outcome TEXT CHECK (outcome IN ('done','not-yet','changed','moot')),
    verified_game_date TEXT,
    seen_team_id INTEGER, seen_label TEXT,
    PRIMARY KEY (save_name, org_id, move_key)
  );
  CREATE INDEX IF NOT EXISTS idx_plan_decisions_org ON plan_decisions (save_name, org_id);
`);

/**
 * Columns added after the table first shipped, with their types.
 *
 * CREATE TABLE IF NOT EXISTS does nothing to a table that is already there,
 * so a history.db written by an earlier build keeps its old shape until the
 * columns are added by hand. Adding a nullable column keeps every row, and a
 * row verified before the column existed simply has no club to show.
 */
const ADDED_COLUMNS: ReadonlyArray<[string, string]> = [
  ['seen_team_id', 'INTEGER'],
  ['seen_label', 'TEXT'],
];

/**
 * Brings an older plan_decisions table up to the current shape, and its keys
 * up to the current form. Returns the columns it added.
 */
export function migratePlanDecisions(handle: Database.Database = historyDb): string[] {
  const have = new Set(
    (handle.prepare(`PRAGMA table_info(plan_decisions)`).all() as Array<{ name: string }>).map((c) => c.name)
  );
  const added: string[] = [];
  for (const [column, type] of ADDED_COLUMNS) {
    if (have.has(column)) continue;
    handle.exec(`ALTER TABLE plan_decisions ADD COLUMN ${column} ${type}`);
    added.push(column);
  }
  rekeyFortyQuestions(handle);
  return added;
}

/** The 40-man question's key as earlier builds wrote it, with the man's rung in it. */
const RUNG_FORTY_KEY = /^protect:(\d+):[^:]+:40man$/;

/**
 * Rewrites the 40-man question's keys from protect:<id>:<rung>:40man to
 * protect:<id>:40man. The question is about the man, not the club he plays
 * for, so the key carried his rung only by accident, and a promotion the plan
 * itself recommended orphaned an accepted protection under the old key. When
 * one man has decisions under two old keys, the latest decided is kept.
 * Returns how many keys it rewrote.
 */
function rekeyFortyQuestions(handle: Database.Database): number {
  const rows = (
    handle
      .prepare(`SELECT save_name, org_id, move_key, decided_at FROM plan_decisions WHERE move_key LIKE 'protect:%:%:40man'`)
      .all() as Array<{ save_name: string; org_id: number; move_key: string; decided_at: string | null }>
  )
    .filter((r) => RUNG_FORTY_KEY.test(r.move_key))
    // The latest decision first, so it is the one that keeps the new key
    .sort((a, b) => String(b.decided_at ?? '').localeCompare(String(a.decided_at ?? '')) || a.move_key.localeCompare(b.move_key));
  if (rows.length === 0) return 0;
  const taken = handle.prepare(`SELECT 1 FROM plan_decisions WHERE save_name = ? AND org_id = ? AND move_key = ?`);
  const rename = handle.prepare(`UPDATE plan_decisions SET move_key = ? WHERE save_name = ? AND org_id = ? AND move_key = ?`);
  const drop = handle.prepare(`DELETE FROM plan_decisions WHERE save_name = ? AND org_id = ? AND move_key = ?`);
  handle.transaction(() => {
    for (const r of rows) {
      const key = `protect:${RUNG_FORTY_KEY.exec(r.move_key)![1]}:40man`;
      if (taken.get(r.save_name, r.org_id, key)) drop.run(r.save_name, r.org_id, r.move_key);
      else rename.run(key, r.save_name, r.org_id, r.move_key);
    }
  })();
  return rows.length;
}
migratePlanDecisions();

/** A row of plan_decisions as SQLite hands it back. */
interface DecisionRow {
  save_name: string;
  org_id: number;
  move_key: string;
  player_id: number;
  player_name: string | null;
  kind: MoveKind;
  horizon: Horizon | null;
  from_rung: string | null;
  from_team_id: number | null;
  to_rung: string | null;
  to_team_id: number | null;
  target: number | null;
  decision: 'accepted' | 'dismissed';
  decided_game_date: string | null;
  decided_at: string | null;
  verify_json: string | null;
  deadline_date: string | null;
  outcome: DecisionOutcome | null;
  verified_game_date: string | null;
  seen_team_id: number | null;
  seen_label: string | null;
}

/** A stored decision, in the shape a Move's `decision` field takes plus what the verifier needs. */
export interface PlanDecision extends MoveDecision {
  state: 'accepted' | 'dismissed';
  orgId: number;
  moveKey: string;
  player_id: number;
  playerName: string | null;
  kind: MoveKind;
  horizon: Horizon | null;
  fromRung: string | null;
  fromTeamId: number | null;
  toRung: string | null;
  toTeamId: number | null;
  /** The position number of a `position` move; null otherwise. */
  target: number | null;
  verify: Verify | null;
  deadlineDate: string | null;
  /** Wall-clock time of the decision, for the record; the game date is what the page prints. */
  decidedAt: string | null;
  /**
   * Where the verifier found him: the club's name, "International complex",
   * or "out of the organization" when he had left it. Null until an import
   * has settled the move, and while it reads not-yet.
   */
  seenAt: string | null;
  /** The club behind `seenAt`; null when he was on no roster. */
  seenTeamId: number | null;
}

/**
 * Where a man stands in the current export, as the verifier needs it. The
 * planner supplies this from its own loads so the store never has to know
 * how a rung is built.
 */
export interface Standing {
  rung: string | null;
  inOrg: boolean;
  position: number | null;
  roleClass: string | null;
  on40: boolean;
  il60: boolean;
  rostered: boolean;
  teamId: number | null;
  /** The club's name as the plan prints it; read from the teams table when left out. */
  teamLabel?: string | null;
}

export type StandingOf = (orgId: number, playerId: number) => Standing | null;

/** What the page prints for a man the verifier found outside the organisation. */
export const OUT_OF_ORG = 'out of the organization';

/**
 * Which save the league in league.db came from, when that is known.
 *
 * The config names the save the user has chosen; league.db holds the save
 * that was last imported. Between choosing a new save and the end of its
 * import the two differ, and the plan the server can compute (and the one it
 * has cached) is the old save's. A decision written then would be stored
 * under the new save against a move of the old one, and a dismissal of the
 * new save that the old plan happens not to produce would be called moot. So
 * the store writes only while the two agree. Null means nobody has said, and
 * the config is taken at its word, as it always was.
 */
let leagueSave: string | null = null;

/** Records which save league.db now holds; the import calls it once the league has arrived. */
export function setPlanLeagueSave(save: string | null): void {
  leagueSave = save;
}

/** The save whose decisions go with the plan the server can compute now. */
export function planLeagueSave(): string {
  return leagueSave ?? currentSaveName();
}

/**
 * Why nothing can be decided right now, or null when it can: the save was
 * switched and its league has not been imported yet.
 */
export function planSaveSwitchPending(): string | null {
  if (leagueSave === null || leagueSave === currentSaveName()) return null;
  return `The plan on screen is from ${leagueSave}, and ${currentSaveName()} has not finished importing. Decide once the import is done.`;
}

/**
 * Who wants to know when a decision is written. The planner reads the
 * decisions on the 40-man (an accepted protection keeps its place, a
 * dismissed one gives it up) while it computes a plan, so a plan it has
 * cached is out of date the moment one is written. A callback rather than an
 * import, since the planner imports this store. Called with the org whose
 * decisions changed, or null when an import may have changed any org's.
 */
const decisionListeners: Array<(orgId: number | null) => void> = [];

/** Registers a callback for every write to the decisions. */
export function onPlanDecisionsChanged(fn: (orgId: number | null) => void): void {
  decisionListeners.push(fn);
}

function decisionsChanged(orgId: number | null): void {
  for (const fn of decisionListeners) fn(orgId);
}

/** Thrown by a write made while the league in league.db belongs to another save. */
export class PlanSaveSwitchError extends Error {}

function assertWritable(): void {
  const why = planSaveSwitchPending();
  if (why) throw new PlanSaveSwitchError(why);
}

function toDecision(row: DecisionRow): PlanDecision {
  let verify: Verify | null = null;
  if (row.verify_json) {
    try {
      verify = JSON.parse(row.verify_json) as Verify;
    } catch {
      verify = null; // a row written by hand; treated as a hold, which is never verified
    }
  }
  return {
    state: row.decision,
    gameDate: row.decided_game_date,
    outcome: row.outcome,
    verifiedGameDate: row.verified_game_date,
    seenAt: row.seen_label ?? null,
    seenTeamId: row.seen_team_id ?? null,
    orgId: row.org_id,
    moveKey: row.move_key,
    player_id: row.player_id,
    playerName: row.player_name,
    kind: row.kind,
    horizon: row.horizon,
    fromRung: row.from_rung,
    fromTeamId: row.from_team_id,
    toRung: row.to_rung,
    toTeamId: row.to_team_id,
    target: row.target,
    verify,
    deadlineDate: row.deadline_date,
    decidedAt: row.decided_at,
  };
}

/**
 * Records a decision on a move. Deciding again replaces the decision and
 * starts verification over: a move dismissed and then accepted has no outcome
 * yet, whatever an import said about it while it was dismissed.
 *
 * The move is the planner's own object, looked up by key in the current plan,
 * so the client never writes a predicate — the server stamps the game date,
 * the wall clock, the verify predicate and the deadline from what it computed.
 * Refused while a save switch is importing, since the plan is the old save's.
 */
export function decidePlanMove(orgId: number, move: PlanMove, decision: 'accepted' | 'dismissed'): PlanDecision {
  assertWritable();
  historyDb
    .prepare(
      `INSERT INTO plan_decisions
         (save_name, org_id, move_key, player_id, player_name, kind, horizon,
          from_rung, from_team_id, to_rung, to_team_id, target,
          decision, decided_game_date, decided_at, verify_json, deadline_date, outcome, verified_game_date,
          seen_team_id, seen_label)
       VALUES (@save, @org, @key, @player, @name, @kind, @horizon,
               @fromRung, @fromTeam, @toRung, @toTeam, @target,
               @decision, @gameDate, @now, @verify, @deadline, NULL, NULL, NULL, NULL)
       ON CONFLICT (save_name, org_id, move_key) DO UPDATE SET
         player_name = excluded.player_name, kind = excluded.kind, horizon = excluded.horizon,
         from_rung = excluded.from_rung, from_team_id = excluded.from_team_id,
         to_rung = excluded.to_rung, to_team_id = excluded.to_team_id, target = excluded.target,
         decision = excluded.decision, decided_game_date = excluded.decided_game_date,
         decided_at = excluded.decided_at, verify_json = excluded.verify_json,
         deadline_date = excluded.deadline_date, outcome = NULL, verified_game_date = NULL,
         seen_team_id = NULL, seen_label = NULL`
    )
    .run({
      save: currentSaveName(),
      org: orgId,
      key: move.key,
      player: move.player.player_id,
      name: move.player.name ?? null,
      kind: move.kind,
      horizon: move.horizon ?? null,
      fromRung: move.from?.rung ?? null,
      fromTeam: move.from?.team_id ?? null,
      toRung: move.to?.rung ?? null,
      toTeam: move.to?.team_id ?? null,
      target: move.to?.position ?? null,
      decision,
      gameDate: leagueGameDate(),
      now: new Date().toISOString(),
      verify: move.verify ? JSON.stringify(move.verify) : null,
      deadline: move.deadline?.date ?? null,
    });
  decisionsChanged(orgId);
  return planDecisions(orgId).get(move.key)!;
}

/** Forgets a decision, so the move is open again. True when there was one to forget. */
export function reopenPlanMove(orgId: number, moveKey: string): boolean {
  assertWritable();
  const forgot =
    historyDb
      .prepare(`DELETE FROM plan_decisions WHERE save_name = ? AND org_id = ? AND move_key = ?`)
      .run(currentSaveName(), orgId, moveKey).changes > 0;
  if (forgot) decisionsChanged(orgId);
  return forgot;
}

/**
 * Every decision on this org's moves, by move key, for the save whose league
 * is loaded — the one the plan beside them was drawn from.
 */
export function planDecisions(orgId: number): Map<string, PlanDecision> {
  const rows = historyDb
    .prepare(`SELECT * FROM plan_decisions WHERE save_name = ? AND org_id = ? ORDER BY move_key`)
    .all(planLeagueSave(), orgId) as DecisionRow[];
  return new Map(rows.map((r) => [r.move_key, toDecision(r)]));
}

/**
 * Marks dismissed moves the planner no longer produces as moot, so a
 * dismissal is not shown forever for a man who has since moved. Called with
 * the keys of the plan just computed; returns how many were retired. Does
 * nothing while a save switch is importing: the keys are the old save's.
 */
export function retireDismissals(orgId: number, liveKeys: Iterable<string>, gameDate: string | null = leagueGameDate()): number {
  if (planSaveSwitchPending()) return 0;
  const live = new Set(liveKeys);
  const stale = (
    historyDb
      .prepare(
        `SELECT move_key FROM plan_decisions
         WHERE save_name = ? AND org_id = ? AND decision = 'dismissed' AND outcome IS NULL`
      )
      .all(currentSaveName(), orgId) as Array<{ move_key: string }>
  ).filter((r) => !live.has(r.move_key));
  const mark = historyDb.prepare(
    `UPDATE plan_decisions SET outcome = 'moot', verified_game_date = ?
     WHERE save_name = ? AND org_id = ? AND move_key = ?`
  );
  historyDb.transaction(() => {
    for (const r of stale) mark.run(gameDate, currentSaveName(), orgId, r.move_key);
  })();
  if (stale.length) decisionsChanged(orgId);
  return stale.length;
}

/**
 * An OOTP date as a number, so "2028-9-10" sorts before "2028-12-20". The
 * JavaScript twin of `DATE_KEY` in db.ts, for the two dates that are already
 * out of the database. Null for anything that is not a date.
 */
function dateOrdinal(raw: string | null | undefined): number | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(raw ?? '').trim());
  return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : null;
}

const rungRank = (rung: string | null): number => {
  const i = (RUNG_KEYS as readonly string[]).indexOf(rung ?? '');
  return i === -1 ? Number.POSITIVE_INFINITY : i;
};

/**
 * Whether the predicate holds against where the man stands now.
 *
 * An offseason rung move accepts any rung at or above the one it named: a man
 * the cap forces to Double-A who opens the year at Triple-A has done what was
 * asked, and more. A `now` move is exact, because "promote to Oklahoma City"
 * and "call him up" are different instructions.
 */
function predicateHolds(verify: Verify, horizon: Horizon | null, s: Standing): boolean {
  switch (verify.field) {
    case 'rung':
      return horizon === 'offseason'
        ? rungRank(s.rung) <= rungRank(String(verify.expect))
        : s.rung === verify.expect;
    case 'org':
      return verify.expect === 'gone' ? !s.inOrg : s.inOrg;
    case 'position':
      return s.position !== null && s.position === Number(verify.expect);
    case 'role':
      return s.roleClass !== null && s.roleClass === String(verify.expect);
    case 'on40':
      return s.on40 === Boolean(verify.expect);
    case 'il60':
      return s.il60 === Boolean(verify.expect);
    case 'rostered':
      return s.rostered === Boolean(verify.expect);
    default:
      return false;
  }
}

/** A release or a trade is verified by his absence; every other kind by his presence somewhere. */
const leavesOrg = (d: PlanDecision): boolean =>
  d.kind === 'release' || d.kind === 'trade' || (d.verify?.field === 'org' && d.verify.expect === 'gone');

/**
 * Whether the window the move was asked for has closed by this import.
 *
 * Most moves close at their deadline. An offseason move does not: its
 * deadline is his league's last game, which is when the window to make it
 * opens, and the move is asked for "by Opening Day" of the next season. So it
 * closes at the first import on or after the next Opening Day — the league's
 * own start date once the save has rolled over to a season that starts after
 * the deadline. Without a start date it never closes, and stays not-yet
 * rather than being called changed on a guess.
 */
function windowClosed(d: PlanDecision, today: number | null, openingDay: string | null): boolean {
  if (today === null) return false;
  if (d.horizon === 'offseason') {
    const from = dateOrdinal(d.deadlineDate) ?? dateOrdinal(d.gameDate);
    const opens = dateOrdinal(openingDay);
    return from !== null && opens !== null && opens > from && today >= opens;
  }
  const deadline = dateOrdinal(d.deadlineDate);
  return deadline !== null && today > deadline;
}

/**
 * What one import says about one accepted move.
 *
 * The rules, in order: the predicate holds → done. Otherwise, for a release
 * or trade, he is still in the organisation → not yet. For anything else, he
 * has left the organisation → moot (a promotion cannot happen to a man who
 * was sold). A move between clubs that has not happened reads not yet while
 * he is still where it started and changed when he is somewhere else. A move
 * about his place on a list (the 40-man, the 60-day list, a position, a
 * role) does not care which club he is on, so it reads not yet wherever he
 * plays: a protection made after the promotion it was linked to is still a
 * protection. An offseason move is not judged by club at all until its window
 * closes. A not-yet whose window has closed is changed, but only after the
 * predicate has had its look, so a move made on the deadline's last day
 * still reads as done.
 */
function outcomeOf(
  d: PlanDecision, standing: Standing | null, gameDate: string, openingDay: string | null
): DecisionOutcome | null {
  if (!d.verify) return null; // a hold has nothing to check
  const gone = !standing || !standing.inOrg;
  let outcome: DecisionOutcome;
  if (leavesOrg(d)) {
    outcome = gone ? 'done' : 'not-yet';
  } else if (gone) {
    outcome = 'moot';
  } else if (predicateHolds(d.verify, d.horizon, standing)) {
    outcome = 'done';
  } else if (d.verify.field !== 'rung' || d.horizon === 'offseason') {
    outcome = 'not-yet';
  } else if (d.fromTeamId === null || standing.teamId === d.fromTeamId) {
    outcome = 'not-yet';
  } else {
    outcome = 'changed';
  }
  if (outcome === 'not-yet' && windowClosed(d, dateOrdinal(gameDate), openingDay)) outcome = 'changed';
  return outcome;
}

/** Where the verifier found him, for the page's "on Tulsa"; nothing while the move is not yet seen. */
function seenOf(standing: Standing | null, outcome: DecisionOutcome): { teamId: number | null; label: string | null } {
  if (outcome === 'not-yet') return { teamId: null, label: null };
  if (!standing || !standing.inOrg) return { teamId: standing?.teamId ?? null, label: OUT_OF_ORG };
  const label =
    standing.teamLabel ??
    clubLabelOf(standing.teamId) ??
    (standing.rung === 'ic' ? 'International complex' : null);
  return { teamId: standing.teamId, label };
}

/**
 * Reads every accepted move that has not been seen done against the export
 * just imported, and stamps what was seen and where. A dismissed move with a
 * deadline lapses once its window has closed: it is stamped moot, so the plan
 * no longer reads it and next winter's question about the same man is asked
 * fresh (a dismissed protection would otherwise give up his place every year
 * under the same key). A dismissal with no deadline stays until the plan
 * stops producing its key, as retireDismissals has it. Returns the rows it
 * changed.
 *
 * Runs once per import, after the snapshot, for every org of the current save
 * — a decision on the second org a user runs is not forgotten because the
 * dashboard happened to be on the first. `standingOf` is the planner's view
 * of the new league.db; this store never reads it directly, so the rung model
 * lives in one place. Only `not-yet` rows are revisited: `done`, `changed`
 * and `moot` are what an import said, and a later import does not unsay it.
 * `openingDay` is the league's start date in the export, which closes an
 * offseason move's window. Does nothing while a save switch is importing.
 */
export function verifyDecisions(
  standingOf: StandingOf, gameDate: string, openingDay: string | null = leagueOpeningDay()
): PlanDecision[] {
  if (planSaveSwitchPending()) return [];
  const rows = historyDb
    .prepare(
      `SELECT * FROM plan_decisions
       WHERE save_name = ? AND (
         (decision = 'accepted' AND (outcome IS NULL OR outcome = 'not-yet'))
         OR (decision = 'dismissed' AND outcome IS NULL AND deadline_date IS NOT NULL))
       ORDER BY org_id, move_key`
    )
    .all(currentSaveName()) as DecisionRow[];
  const stamp = historyDb.prepare(
    `UPDATE plan_decisions SET outcome = @outcome, verified_game_date = @gameDate,
       seen_team_id = @seenTeam, seen_label = @seenLabel
     WHERE save_name = @save AND org_id = @org AND move_key = @key`
  );
  const updated: PlanDecision[] = [];
  historyDb.transaction(() => {
    for (const row of rows) {
      const d = toDecision(row);
      if (d.state === 'dismissed') {
        // A dismissal is about the window it was made in, not where he stands
        if (!windowClosed(d, dateOrdinal(gameDate), openingDay)) continue;
        stamp.run({ outcome: 'moot', gameDate, seenTeam: null, seenLabel: null, save: currentSaveName(), org: d.orgId, key: d.moveKey });
        updated.push({ ...d, outcome: 'moot', verifiedGameDate: gameDate, seenAt: null, seenTeamId: null });
        continue;
      }
      const standing = standingOf(d.orgId, d.player_id);
      const outcome = outcomeOf(d, standing, gameDate, openingDay);
      if (!outcome) continue;
      const seen = seenOf(standing, outcome);
      stamp.run({
        outcome, gameDate, seenTeam: seen.teamId, seenLabel: seen.label,
        save: currentSaveName(), org: d.orgId, key: d.moveKey,
      });
      updated.push({ ...d, outcome, verifiedGameDate: gameDate, seenAt: seen.label, seenTeamId: seen.teamId });
    }
  })();
  if (updated.length) decisionsChanged(null);
  return updated;
}
