import { Fragment, useEffect, useId, useState } from 'react';
import {
  decidePlanMove, getPlan, isStaticSite, reopenPlanMove,
  type MoveKind, type Plan, type PlanClub, type PlanLevel, type PlanMove, type RungKey, type Tone,
} from '../api';
import { PlayerLink, Tip, TIP_CURPOT } from '../playerModal';
import { SortableTh, Th } from '../Th';
import { formatRatingPair } from '../ratingScale';
import { navigate, useRoute, type RouteParams } from '../route';
import { MethodNote } from '../MethodNote';
import { CopyButton } from './Lineup';

/**
 * The Organization Planner: every level with its roster today and the one the
 * rules and the size targets say it should carry, and the moves that get it
 * there, each with its reasons, its OOTP screen and its deadline.
 *
 * The page fetches the whole plan once — decided moves included — and does its
 * own filtering, so a static export of the site, which cannot answer a query
 * string, shows exactly what the dev server does. Every filter lives in the
 * address (#/planner?level=aa&kind=decision), so the dashboard chip can open
 * the page on what it counted and a link carries the view with it.
 */

/** The first sentence of the method, shown beside the toggle while the note is shut. */
const METHOD_SUMMARY =
  'Rules first, then readiness: every level is checked against service caps, the international ' +
  'complex age limit, options and the 40-man before anyone is scored, and the moves are the ' +
  'difference between today’s rosters and the ones that pass.';

// ── Filters ─────────────────────────────────────────────────────────────

/**
 * Which moves the page lists, as the address asks for them. `decision` is
 * the seven kinds that ask for a call — the ones the dashboard's Org moves
 * chip counts — so following the chip lands on exactly as many moves as it
 * said. Promote, send-down, cover and assign are left out of it as they are
 * from the chip: each is the other half of a call-up or a forced move.
 */
export type KindFilter = 'all' | 'decision' | MoveKind;
export type HorizonFilter = 'now' | 'offseason' | 'all';
export type ShowFilter = 'open' | 'accepted' | 'dismissed' | 'all';

export const DECISION_KINDS: readonly MoveKind[] = ['forced', 'callup', 'protect', 'demote', 'trade', 'release', 'hold'];

const KIND_FILTERS: Array<{ key: KindFilter; label: string; tip?: string }> = [
  { key: 'all', label: 'All' },
  {
    key: 'decision', label: 'Decisions',
    tip: 'Forced, call-up, protect, demote, trade, release and hold: the kinds that ask for a call. The dashboard chip counts these.',
  },
  { key: 'forced', label: 'Forced' },
  { key: 'callup', label: 'Call-up' },
  { key: 'senddown', label: 'Send down' },
  { key: 'promote', label: 'Promote' },
  { key: 'demote', label: 'Demote' },
  { key: 'cover', label: 'Cover' },
  { key: 'assign', label: 'Assign' },
  { key: 'protect', label: 'Protect' },
  { key: 'il60', label: '60-day IL' },
  { key: 'trade', label: 'Trade' },
  { key: 'release', label: 'Release' },
  { key: 'hold', label: 'Hold' },
];

const HORIZON_FILTERS: Array<{ key: HorizonFilter; label: string; tip: string }> = [
  { key: 'now', label: 'Now', tip: 'Moves dated today.' },
  { key: 'offseason', label: 'Offseason', tip: 'Moves a cap or a date requires by next season, folded away until August.' },
  { key: 'all', label: 'All', tip: 'Both.' },
];

const SHOW_FILTERS: Array<{ key: ShowFilter; label: string; tip: string }> = [
  { key: 'open', label: 'Open', tip: 'Moves you have not decided on yet. The dashboard chip counts these.' },
  { key: 'accepted', label: 'Accepted', tip: 'Moves you accepted, with what the imports since have seen of them: not yet seen, done, or changed.' },
  { key: 'dismissed', label: 'Dismissed', tip: 'Moves you set aside. They stay off the page until you restore them, or until the planner stops making them.' },
  { key: 'all', label: 'All', tip: 'Everything the planner produced.' },
];

export interface PlanFilters {
  /** A rung key, or null for every level. */
  level: RungKey | null;
  kind: KindFilter;
  horizon: HorizonFilter;
  show: ShowFilter;
  /** A name, or part of one. */
  q: string;
}

/** What the address asked for. A value it does not recognise is every move, not an empty page. */
export function kindFilter(param: string | undefined): KindFilter {
  return KIND_FILTERS.find((f) => f.key === param)?.key ?? 'all';
}

export function matchesKind(filter: KindFilter, kind: MoveKind): boolean {
  if (filter === 'all') return true;
  if (filter === 'decision') return DECISION_KINDS.includes(kind);
  return kind === filter;
}

/** How many moves each button would show, so a filter says what is behind it before it is pressed. */
export function kindCounts(moves: PlanMove[]): Record<KindFilter, number> {
  const counts = {} as Record<KindFilter, number>;
  for (const f of KIND_FILTERS) counts[f.key] = moves.filter((m) => matchesKind(f.key, m.kind)).length;
  return counts;
}

/**
 * Which horizon the page opens on, from the game's own calendar: the moves
 * dated now until August, and everything once the offseason is in sight. The
 * 64 cap-forced moves on a typical farm are all offseason ones, and a page
 * that opened on them in May would bury the handful dated today. The
 * dashboard's chip makes the same choice (planHorizonFold in
 * server/dashboard.ts), so it counts what the page lists.
 */
export function defaultHorizon(gameDate: string): HorizonFilter {
  const month = Number(gameDate.split('-')[1]);
  return Number.isFinite(month) && month >= 8 ? 'all' : 'now';
}

/** Every rung, highest first, as the server names them. */
const RUNG_KEYS: readonly RungKey[] = ['mlb', 'aaa', 'aa', 'high-a', 'single-a', 'complex', 'dsl', 'ic'];

/**
 * The filters an address names, with the plan's calendar deciding the horizon
 * when it does not say. A level the plan has no card for (a mistyped
 * `level=AA`, or a rung this save lacks) is every level, as an unknown kind
 * is every kind: an empty page with nothing pressed would give no way back.
 */
export function readFilters(params: RouteParams, gameDate: string, rungs: readonly RungKey[] = RUNG_KEYS): PlanFilters {
  const horizon = HORIZON_FILTERS.find((f) => f.key === params.horizon)?.key ?? defaultHorizon(gameDate);
  const show = SHOW_FILTERS.find((f) => f.key === params.show)?.key ?? 'open';
  const level = rungs.find((r) => r === params.level) ?? null;
  return {
    level,
    kind: kindFilter(params.kind),
    horizon,
    show,
    q: params.q ?? '',
  };
}

/**
 * Open is what nobody has decided on yet, and nothing else: an accepted move
 * waits under Accepted with what the imports have seen of it. That is also
 * what the dashboard chip counts, so following the chip lands on its number.
 */
export function matchesShow(show: ShowFilter, move: PlanMove): boolean {
  if (show === 'all') return true;
  return move.decision.state === show;
}

export function matchesHorizon(filter: HorizonFilter, move: PlanMove): boolean {
  return filter === 'all' || move.horizon === filter;
}

const touchesLevel = (move: PlanMove, level: RungKey | null): boolean =>
  level === null || move.from.rung === level || move.to.rung === level;

const matchesName = (move: PlanMove, q: string): boolean =>
  q.trim() === '' || move.player.name.toLowerCase().includes(q.trim().toLowerCase());

/**
 * The moves the page lists under its filters, in the server's order: forced
 * first, then by deadline, then by fit. The kind filter is applied last so
 * the kind buttons can count what each would show.
 */
export function visibleMoves(plan: Plan, filters: PlanFilters): { moves: PlanMove[]; beforeKind: PlanMove[]; folded: number } {
  const shown = plan.moves.filter((m) => matchesShow(filters.show, m) && touchesLevel(m, filters.level) && matchesName(m, filters.q));
  const beforeKind = shown.filter((m) => matchesHorizon(filters.horizon, m));
  const moves = beforeKind.filter((m) => matchesKind(filters.kind, m.kind));
  // What the horizon put out of sight, so the page can say so
  const folded = filters.horizon === 'now' ? shown.filter((m) => m.horizon === 'offseason').length : 0;
  return { moves, beforeKind, folded };
}

/**
 * What an empty moves table says. The all-clear is a claim about the whole
 * organisation, so it is made only when nothing at all was hidden and every
 * level passes; otherwise the sentence names what emptied the table.
 */
export function emptyMovesText(plan: Plan, filters: PlanFilters, folded: number): string {
  if (filters.kind !== 'all' || filters.level !== null || filters.q.trim() !== '') return 'No moves under that filter.';
  if (filters.show === 'accepted') return 'No accepted moves.';
  if (filters.show === 'dismissed') return 'No dismissed moves.';
  if (folded > 0) {
    return `No moves dated now; ${folded} ${folded === 1 ? 'move is' : 'moves are'} folded under offseason.`;
  }
  if (filters.horizon === 'offseason') return 'No offseason moves.';
  const off = plan.levels.filter((l) => levelTone(l) !== 'ok' || l.tone !== 'ok').length;
  if (off > 0) {
    const which = off === 1 ? 'level is still short or over its band' : 'levels are still short or over their band';
    return `No moves left to make, but ${off} ${which}; the level cards say what is missing.`;
  }
  if (filters.show === 'open' && plan.moves.some((m) => m.decision.state !== 'open')) {
    return 'Nothing left open: every move is accepted or dismissed.';
  }
  return 'Nothing to do: every level passes its rules and sits inside its band.';
}

// ── Dates ───────────────────────────────────────────────────────────────

/** Days from one OOTP date to another, both unpadded (2028-5-15); NaN when either is not a date. */
export function daysBetween(from: string, to: string): number {
  const parse = (s: string): number => {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s.trim());
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  };
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}

/** How close a dated item is, in the availability colours: red inside a month, amber inside three. */
const closeness = (days: number): string => (days <= 30 ? 'avail-bad' : days <= 90 ? 'avail-warn' : 'avail-ok');

/** OOTP's own `DATE_KEY`, in the browser: a sortable number from an unpadded date. */
const dateKey = (date: string): number => {
  const [y, m, d] = date.split('-').map(Number);
  return (y ?? 0) * 10_000 + (m ?? 0) * 100 + (d ?? 0);
};

/**
 * The step the server writes on an accepted move it no longer makes, when it
 * rebuilds that move from the stored decision so the page can still show it
 * (settledMove in server/planner.ts).
 */
const NO_LONGER_LISTED = 'No move: the plan no longer lists it';

/**
 * Whether an accepted move is settled: an import saw it done, saw its
 * deadline pass without it or found him somewhere the move did not name
 * (changed), or found him gone from the organisation (moot), or the plan no
 * longer recommends it. Nothing is left to make by its deadline, so the row
 * shows the date muted, never as one coming up, and the deadline sort lists
 * it after the moves still to make.
 */
export function isSettled(m: PlanMove): boolean {
  const d = m.decision;
  if (d.state !== 'accepted') return false;
  return d.outcome === 'done' || d.outcome === 'changed' || d.outcome === 'moot' || m.ootpSteps.includes(NO_LONGER_LISTED);
}

/**
 * The row's key in the table. A settled acceptance can sit beside the open
 * card that asks the same man's question afresh under the same move key (a
 * protection not made by last winter's deadline, and this winter's), so a
 * settled row is told apart from the card.
 */
export const moveRowKey = (m: PlanMove): string => (isSettled(m) ? `${m.key}:settled` : m.key);

// ── Badges and tones ────────────────────────────────────────────────────

/**
 * The badge class for a kind. The signal badges the farm page already has are
 * reused where the meaning is the same (a call-up is a promotion, a send-down
 * a demotion, a hold is blocked); the planner's own kinds get rules of their
 * own in styles.css.
 */
export function badgeClass(kind: MoveKind): string {
  switch (kind) {
    case 'promote': case 'callup': case 'cover': case 'assign': return 'badge promote';
    case 'demote': case 'senddown': return 'badge demote';
    case 'position': case 'role': return 'badge watch';
    case 'hold': return 'badge blocked';
    default: return `badge ${kind}`;
  }
}

const KIND_LABEL: Record<MoveKind, string> = {
  forced: 'forced', callup: 'call-up', senddown: 'send down', promote: 'promote', demote: 'demote',
  cover: 'cover', assign: 'assign', position: 'position', role: 'role', protect: 'protect',
  il60: '60-day IL', trade: 'trade', release: 'release', hold: 'hold',
};

/** The size band's verdict on a roster: the minimum is hard, the maximum only warns. */
export function sizeTone(roster: number, target: { min: number; max: number }): Tone {
  return roster < target.min ? 'bad' : roster > target.max ? 'warn' : 'ok';
}

const toneClass = (tone: Tone): string => (tone === 'ok' ? 'good' : tone);

const worstTone = (tones: Tone[]): Tone => (tones.includes('bad') ? 'bad' : tones.includes('warn') ? 'warn' : 'ok');

/** The engine's sentence for a club over its soft maximum, which the card already says in its own line. */
const SURPLUS_ONLY = 'only surplus men are moved for size';
const OVER_NEED = /over the \d+ you set; only surplus men are moved for size/;

/**
 * The clubs of a rung that holds several (the two DSL clubs), each sized
 * against the band one club answers to. Null for a rung of one club, and for
 * a plan sent before the engine wrote them.
 */
const clubsOf = (level: PlanLevel): PlanClub[] | null => (level.clubs && level.clubs.length > 1 ? level.clubs : null);

/** How many clubs share the rung's figures, so a two-club total is never read against one club's band. */
const clubCount = (level: PlanLevel): number => clubsOf(level)?.length ?? Math.max(level.teamIds.length, 1);

/**
 * The size verdict a level card is coloured by. One club is read against its
 * band; a rung of several takes its worst club, because the band is per club
 * and the two clubs' total says nothing against it. The big club's figure is
 * the active roster, which can only be wrong by being over; the complex pool
 * only warns.
 */
export function levelTone(level: PlanLevel): Tone {
  const { planned, target } = level;
  if (level.rung === 'mlb') return planned.roster > target.max ? 'bad' : 'ok';
  if (level.rung === 'ic') return planned.roster > target.max ? 'warn' : 'ok';
  const clubs = clubsOf(level);
  if (clubs) return worstTone(clubs.map((c) => c.tone));
  if (clubCount(level) > 1) return level.tone;
  return sizeTone(planned.roster, target);
}

/** The card's headline figure, worded for what the rung is. */
export function levelValueText(level: PlanLevel): string {
  const { now, planned, target } = level;
  if (level.rung === 'ic') return `${now.roster} in the pool → planned ${planned.roster} (max ${target.max})`;
  if (level.rung === 'mlb') {
    return `${now.roster} of ${target.max} active places (${now.healthy} healthy, ${now.il} IL) → planned ${planned.roster}`;
  }
  const n = clubCount(level);
  if (n > 1) {
    return `${now.roster} on the roster across ${n} clubs (${now.healthy} healthy, ${now.il} IL) → planned ${planned.roster} (target ${target.min}-${target.max} a club)`;
  }
  return `${now.roster} on the roster (${now.healthy} healthy, ${now.il} IL) → planned ${planned.roster} (target ${target.min}-${target.max})`;
}

const clubLineText = (c: PlanClub): string => {
  const verdict = c.planned < c.min
    ? `, ${c.min - c.planned} under the ${c.min} minimum`
    : c.planned > c.max
      ? `, ${c.planned - c.max} over the ${c.max} you set; ${SURPLUS_ONLY}`
      : '';
  return `${c.label}: ${c.now} → planned ${c.planned}${verdict}`;
};

/**
 * The lines under the headline that say how far outside its band a level is.
 * A rung of several clubs gets one line a club, each against its own band; a
 * plan without the clubs gets none rather than a sum read against one club.
 */
export function sizeLines(level: PlanLevel): Array<{ text: string; tone: Tone }> {
  const { planned, target } = level;
  const over = planned.roster - target.max;
  if (level.rung === 'mlb') return over > 0 ? [{ text: `${over} over the ${target.max} active places`, tone: 'bad' }] : [];
  if (level.rung === 'ic') return over > 0 ? [{ text: `${over} over the ${target.max} places the pool holds`, tone: 'warn' }] : [];
  const clubs = clubsOf(level);
  if (clubs) return clubs.map((c) => ({ text: clubLineText(c), tone: c.tone }));
  if (clubCount(level) > 1) return [];
  const lines: Array<{ text: string; tone: Tone }> = [];
  if (over > 0) lines.push({ text: `${over} over the ${target.max} you set; ${SURPLUS_ONLY}`, tone: 'warn' });
  if (planned.roster < target.min) lines.push({ text: `${target.min - planned.roster} under the ${target.min} minimum`, tone: 'bad' });
  return lines;
}

/** The level's needs, less the over-maximum sentence when the card has already said it. */
export function levelNeeds(level: PlanLevel): string[] {
  const said = sizeLines(level).some((l) => l.text.includes(SURPLUS_ONLY));
  return said ? level.needs.filter((n) => !OVER_NEED.test(n)) : level.needs;
}

// ── Copy ────────────────────────────────────────────────────────────────

/**
 * The plan as plain text, grouped by level, one line per visible move:
 *
 *   AA — Tulsa Drillers (41 now → 34; target 28-35)
 *   PROMOTE  Emil Morales (3B, 21)  Tulsa Drillers → Oklahoma City Comets  — by 2028-12-20 — <first reason>
 *
 * Built from what the page is showing, filters and all, so what is pasted is
 * what was on the screen.
 */
export function planCopyText(plan: Plan, moves: PlanMove[]): string {
  const lines: string[] = [`Org Planner — ${plan.gameDate}`, orgLineText(plan), ''];
  const levels = [...plan.levels].sort((a, b) => a.rank - b.rank);
  for (const level of levels) {
    lines.push(levelHeaderText(level));
    for (const m of moves.filter((x) => x.from.rung === level.rung)) lines.push(moveLineText(m, plan.gameDate));
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

/**
 * A level's header in the copy text. A rung of several clubs gives each club
 * its own figures, since the band is per club; the big club and the pool say
 * what their limit is rather than a band nobody set.
 */
export function levelHeaderText(level: PlanLevel): string {
  const { now, planned, target } = level;
  const head = `${level.levelName} — `;
  if (level.rung === 'mlb') return `${head}${level.label} (${now.roster} now → ${planned.roster}; ${target.max} active places)`;
  if (level.rung === 'ic') return `${head}${level.label} (${now.roster} now → ${planned.roster}; max ${target.max})`;
  const clubs = clubsOf(level);
  if (clubs) {
    return head + clubs.map((c) => `${c.label} (${c.now} now → ${c.planned}; target ${c.min}-${c.max})`).join(' · ');
  }
  const n = clubCount(level);
  if (n > 1) {
    return `${head}${level.label} (${now.roster} now → ${planned.roster} across ${n} clubs; target ${target.min}-${target.max} a club)`;
  }
  return `${head}${level.label} (${now.roster} now → ${planned.roster}; target ${target.min}-${target.max})`;
}

/**
 * One move as a line of the copy text. A move still to make says the date it
 * is to be made by. A settled one says the date it was due by once that date
 * has passed, and no date before it: there is nothing left to make by then.
 * The game date tells the two apart; without it a settled move gives none.
 */
export function moveLineText(m: PlanMove, gameDate?: string): string {
  const date = m.deadline?.date;
  const days = date && gameDate ? daysBetween(gameDate, date) : NaN;
  const by = !date ? ''
    : !isSettled(m) ? `  — by ${date}`
    : days < 0 ? `  — was due ${date}`
    : '';
  return `${m.kind.toUpperCase()}  ${m.player.name} (${m.player.positionName}, ${m.player.age})  ${m.from.label} → ${m.to.label}${by} — ${m.reasons[0] ?? ''}`;
}

function orgLineText(plan: Plan): string {
  const o = plan.org;
  const parts = [
    `${o.fullSeasonNow} full-season men`,
    `band ${o.fullSeasonMin}-${o.fullSeasonMax}`,
    `40-man ${o.fortyMan.count} of ${o.fortyMan.limit}`,
    `international complex ${o.ic.size} of ${o.ic.max}`,
  ];
  if (o.mlbThinnest.length) parts.push(`big club thinnest at ${o.mlbThinnest.join(', ')}`);
  return parts.join(' · ');
}

// ── The page ────────────────────────────────────────────────────────────

export type DecideAction = 'accepted' | 'dismissed' | 'reopen';

/** A decision the server refused, kept beside the row it was made on. */
export interface DecideError {
  /** Whose move it was, for when the row has gone from the plan read again after it. */
  name: string;
  message: string;
}

/**
 * `onNavigate` opens another page, so a protection that needs a 40-man place
 * can send the reader to the 40-Man Roster.
 */
export function Planner({ orgId, onNavigate }: { orgId: number; onNavigate?: (page: string) => void }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decideErrors, setDecideErrors] = useState<Record<string, DecideError>>({});
  const { params } = useRoute();

  useEffect(() => {
    setPlan(null);
    setError(null);
    setDecideErrors({});
    getPlan(orgId).then(setPlan).catch((e: Error) => setError(e.message));
  }, [orgId]);

  // Only the first read can lose the page. Once a plan is on screen, a failed
  // decision or a failed re-read is said beside the row and the plan stays
  if (error) return <div className="banner error">{error}</div>;
  if (!plan) return <p className="muted">Working out the plan…</p>;

  // The filters live in the address, so a chip can open the page on them and
  // a link carries them. Choosing one rewrites the entry in place: it is not a
  // step worth undoing, and the address then says what the page shows
  const filters = readFilters(params, plan.gameDate, plan.levels.map((l) => l.rung));
  const onFilter = (patch: Partial<PlanFilters>) => {
    const next = { ...filters, ...patch };
    navigate('planner', {
      ...params,
      level: next.level ?? undefined,
      kind: next.kind === 'all' ? undefined : next.kind,
      horizon: next.horizon === defaultHorizon(plan.gameDate) ? undefined : next.horizon,
      show: next.show === 'open' ? undefined : next.show,
      q: next.q.trim() === '' ? undefined : next.q,
    }, { replace: true });
  };
  // The decision is stored on the server and the plan re-read, so what the
  // row then says is what the next import will be checking. A refusal (the
  // plan changed under the page after an import elsewhere) is kept on the row
  // and the plan read again, so the page shows what the server now holds
  const onDecide = async (moveKey: string, action: DecideAction) => {
    const name = plan.moves.find((m) => m.key === moveKey)?.player.name ?? 'this move';
    const note = (message: string) => setDecideErrors((prev) => ({ ...prev, [moveKey]: { name, message } }));
    try {
      if (action === 'reopen') await reopenPlanMove(orgId, moveKey);
      else await decidePlanMove(orgId, moveKey, action);
    } catch (e) {
      note(`Not saved: ${(e as Error).message}`);
      await getPlan(orgId).then(setPlan).catch(() => undefined);
      return;
    }
    setDecideErrors(({ [moveKey]: _cleared, ...rest }) => rest);
    try {
      setPlan(await getPlan(orgId));
    } catch (e) {
      note(`Saved, but the plan could not be read again: ${(e as Error).message}`);
    }
  };
  return (
    <PlannerView
      plan={plan}
      filters={filters}
      onFilter={onFilter}
      onDecide={onDecide}
      onNavigate={onNavigate}
      decideErrors={decideErrors}
    />
  );
}

/**
 * The page once its plan is in. Apart from the fetch and the address so that
 * it can be drawn from a payload and a set of filters alone, which is how the
 * tests read what a man would see.
 */
export function PlannerView({ plan, filters, onFilter, onDecide, onNavigate, decideErrors = {} }: {
  plan: Plan;
  filters: PlanFilters;
  onFilter: (patch: Partial<PlanFilters>) => void;
  onDecide: (moveKey: string, action: DecideAction) => void;
  onNavigate?: (page: string) => void;
  decideErrors?: Record<string, DecideError>;
}) {
  const { moves, beforeKind, folded } = visibleMoves(plan, filters);
  const counts = kindCounts(beforeKind);
  const levels = [...plan.levels].sort((a, b) => a.rank - b.rank);
  const searchId = useId();
  // A refused decision whose move the plan read again no longer has: said
  // above the table, since there is no row left to say it on
  const orphaned = Object.entries(decideErrors).filter(([key]) => !plan.moves.some((m) => m.key === key));

  return (
    <div>
      {plan.warnings.map((w) => (
        <p key={w} className="muted hint-line">{w}</p>
      ))}

      <OrgLine plan={plan} folded={folded} />
      <DeadlineStrip plan={plan} />

      <div className="cards">
        {levels.map((level) => (
          <LevelCard
            key={level.rung}
            level={level}
            season={plan.season}
            active={filters.level === level.rung}
            onClick={() => onFilter({ level: filters.level === level.rung ? null : level.rung })}
          />
        ))}
      </div>

      <div className="toolbar">
        <div className="tabs" role="group" aria-label="Horizon">
          {HORIZON_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={filters.horizon === f.key ? 'active' : ''}
              aria-pressed={filters.horizon === f.key}
              title={f.tip}
              onClick={() => onFilter({ horizon: f.key })}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="tabs" role="group" aria-label="Decision state">
          {SHOW_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={filters.show === f.key ? 'active' : ''}
              aria-pressed={filters.show === f.key}
              title={f.tip}
              onClick={() => onFilter({ show: f.key })}
            >
              {f.label}
            </button>
          ))}
        </div>
        <label htmlFor={searchId} className="muted">Player</label>
        <input
          id={searchId}
          type="search"
          value={filters.q}
          placeholder="Name"
          onChange={(e) => onFilter({ q: e.target.value })}
        />
        <CopyButton label="Copy plan" text={() => planCopyText(plan, moves)} />
      </div>
      <div className="toolbar">
        <div className="tabs" role="group" aria-label="Kind">
          {/* A kind with nothing behind it is left off, unless it is the one
              pressed: the empty table then still shows which filter emptied it */}
          {KIND_FILTERS.filter((f) => f.key === 'all' || f.key === 'decision' || f.key === filters.kind || counts[f.key] > 0).map((f) => (
            <button
              key={f.key}
              type="button"
              className={filters.kind === f.key ? 'active' : ''}
              aria-pressed={filters.kind === f.key}
              title={f.tip}
              onClick={() => onFilter({ kind: f.key })}
            >
              {f.label} <span className="muted">{counts[f.key]}</span>
            </button>
          ))}
        </div>
      </div>

      <MethodNote pageKey="planner" summary={METHOD_SUMMARY}>
        <p className="muted hint-line">
          {METHOD_SUMMARY} A rung is one level of the organisation; the planner builds the ladder from
          each league&rsquo;s reputation, so High-A and Single-A are told apart. A man is eligible at a
          rung when his pro service years fit under that level&rsquo;s cap (Settings &rarr; Planner; the
          game does not export the limit, so check League Settings), and a man at the cap is in his last
          eligible season &mdash; that move is forced and dated. Readiness blends three things: production
          over up to three seasons (wRC+ for hitters, ERA+ and FIP+ for pitchers, each measured against
          its own league and translated one rung at a time by OOTP&rsquo;s own level factors),
          OOTP&rsquo;s Overall against the median man at that level, and age against the level&rsquo;s
          median. Sample gates: 150 PA / 40 IP over three seasons for production to count, 60 PA / 15 IP
          for a claim about this season, 100 PA / 30 IP before anyone is marked for demotion, and nobody
          is promoted on a poor season or demoted on a good one. Each level is checked for a man at every
          position first, then filled to its catchers, shortstop and centre-field cover, starters and
          relievers, then to your size band, counted on the full roster so injured men hold their place;
          the band&rsquo;s minimum is enforced and its maximum only warns, and only surplus men are moved
          for size. Where two men fit equally, the one who covers what the big club is thinnest at goes
          first. Nothing breaks a cap, an option rule or a 40-man place; injured men stay where they are.
          Accept or dismiss each move; the next import checks whether it happened.
        </p>
      </MethodNote>

      <h2>Moves</h2>
      {orphaned.map(([key, e]) => (
        <p key={key} className="tone-bad hint-line" role="alert">
          {e.name}: {e.message} The plan has been read again and no longer has that move.
        </p>
      ))}
      <MovesTable
        plan={plan}
        moves={moves}
        empty={emptyMovesText(plan, filters, folded)}
        onDecide={onDecide}
        onNavigate={onNavigate}
        decideErrors={decideErrors}
      />

      <h2>Release or trade</h2>
      <ReleaseTable plan={plan} />

      {plan.leaving.length > 0 && (
        <>
          <h2>Already on their way out</h2>
          <ul className="posture-why">
            {plan.leaving.map((p) => (
              <li key={p.player_id}><PlayerLink id={p.player_id}>{p.name}</PlayerLink> — {p.why}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** The organisation in one line: the figures the whole page answers to. */
function OrgLine({ plan, folded }: { plan: Plan; folded: number }) {
  const o = plan.org;
  const fullSeason = o.fullSeasonNow < o.fullSeasonMin ? 'bad' : o.fullSeasonNow > o.fullSeasonMax ? 'warn' : 'good';
  return (
    <div className="plan-org-line">
      <span className={`card-value ${fullSeason}`}>{o.fullSeasonNow} full-season men</span>
      <span className="muted">· band {o.fullSeasonMin}-{o.fullSeasonMax}</span>
      <span className={`card-value ${o.fortyMan.count > o.fortyMan.limit ? 'bad' : ''}`}>· 40-man {o.fortyMan.count} of {o.fortyMan.limit}</span>
      <span className={`card-value ${o.ic.size > o.ic.max ? 'bad' : ''}`}>· international complex {o.ic.size} of {o.ic.max}</span>
      {o.mlbThinnest.length > 0 && <span className="card-value">· big club thinnest at {o.mlbThinnest.join(', ')}</span>}
      {folded > 0 && (
        <span className="muted">· {folded} {folded === 1 ? 'move' : 'moves'} folded under offseason</span>
      )}
    </div>
  );
}

/** How close a deadline is, in words, for a reader who cannot see the pill's colour. */
const closenessText = (days: number): string =>
  days < 0 ? 'passed' : days <= 30 ? 'within a month' : days <= 90 ? 'within three months' : 'more than three months away';

/**
 * The deadlines the page shows: the dated items, less any whose move has been
 * dismissed. The engine already leaves those out; the page checks again so a
 * plan cached before the dismissal cannot show one.
 */
export function liveDeadlines(plan: Plan): Plan['deadlines'] {
  const dismissed = new Set(plan.moves.filter((m) => m.decision.state === 'dismissed').map((m) => m.key));
  return plan.deadlines.filter((d) => d.moveKey === null || !dismissed.has(d.moveKey));
}

/** The next eight dated items, coloured by how close each is and saying so in words. */
function DeadlineStrip({ plan }: { plan: Plan }) {
  const next = [...liveDeadlines(plan)].sort((a, b) => dateKey(a.date) - dateKey(b.date)).slice(0, 8);
  if (next.length === 0) return null;
  return (
    <ul className="plan-deadlines" aria-label="Deadlines">
      {next.map((d, i) => {
        const days = daysBetween(plan.gameDate, d.date);
        return (
          <li key={`${d.date}:${d.player_id}:${i}`} className={`plan-deadline ${closeness(days)}`}>
            <span className="plan-deadline-date">{d.date}</span>
            <span className="visually-hidden">({closenessText(days)})</span>
            <span>· {d.what}</span>
            <span>· <PlayerLink id={d.player_id}>{d.name}</PlayerLink></span>
          </li>
        );
      })}
    </ul>
  );
}

const GROUPS = ['C', 'IF', 'OF', 'SP', 'RP'] as const;

/**
 * The structure line of the planned roster: "C 3 · IF 7 (SS 3) · OF 6 (CF 2)
 * · SP 6 · RP 12", each group in the tone the engine gave it. The figure and
 * its colour come from the same roster, the one after the moves, so a red
 * number is the shortfall it is red for. On a rung of several clubs the
 * engine gives each group the club with the fewest men, and its note names
 * every club's count; the note rides along as the part's title.
 */
export function structureParts(level: PlanLevel): Array<{ text: string; tone: Tone; title?: string }> {
  const row = (group: string) => level.structure.find((s) => s.group === group);
  const withNote = (part: { text: string; tone: Tone }, note: string | undefined) => (note ? { ...part, title: note } : part);
  const cover = (group: 'SS cover' | 'CF cover', short: string) => {
    const r = row(group);
    return r ? withNote({ text: ` (${short} ${r.have})`, tone: r.tone }, r.note) : null;
  };
  const parts: Array<{ text: string; tone: Tone; title?: string }> = [];
  for (const group of GROUPS) {
    const r = row(group);
    parts.push(withNote({ text: `${group} ${r?.have ?? level.planned.groups[group]}`, tone: r?.tone ?? 'ok' }, r?.note));
    const extra = group === 'IF' ? cover('SS cover', 'SS') : group === 'OF' ? cover('CF cover', 'CF') : null;
    if (extra) parts.push(extra);
  }
  return parts;
}

/**
 * What the structure line's figures are. On a rung of several clubs each
 * figure is the club with the fewest men in that group, judged against what
 * one club needs, so the line says so instead of reading as the two together.
 */
export function structureLabel(level: PlanLevel): string {
  const n = clubCount(level);
  return n > 1 ? `Planned, the thinner of the ${n} clubs in each group:` : 'Planned:';
}

/**
 * Today's healthy men by group, for the line under the planned one: "Today:
 * C 5 · IF 7 · OF 5 · SP 5 · RP 19". Null when the plan moves nobody in or
 * out of any group, so the card does not print the same figures twice. Null
 * too on a rung of several clubs: today's figures there are the clubs added
 * together, and set under one club's figures they would read as a change the
 * plan does not make.
 */
export function todayStructureText(level: PlanLevel): string | null {
  if (clubCount(level) > 1) return null;
  const planned = (g: (typeof GROUPS)[number]) => level.structure.find((s) => s.group === g)?.have ?? level.planned.groups[g];
  if (GROUPS.every((g) => planned(g) === level.now.groups[g])) return null;
  return `Today: ${GROUPS.map((g) => `${g} ${level.now.groups[g]}`).join(' · ')}`;
}

const staffText = (rows: PlanLevel['staff']['rotation']): string =>
  rows.map((r) => (r.tag ? `${r.name} (${r.tag})` : r.name)).join(', ');

/**
 * One level: its roster today and planned, the structure, the staff and the
 * cap. The card is also the level filter, so pressing it lists that level's
 * moves and pressing it again lists everyone's.
 */
function LevelCard({ level, season, active, onClick }: {
  level: PlanLevel;
  season: number;
  active: boolean;
  onClick: () => void;
}) {
  const tone = levelTone(level);
  const lastEligible = level.roster.filter((r) => r.lastEligibleSeason === season).length;
  const pool = level.rung === 'ic';
  const today = pool ? null : todayStructureText(level);
  const needs = levelNeeds(level);
  return (
    <div
      className={`card plan-level${active ? ' active' : ''}`}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
    >
      <span className="card-label"><span className="level-tag">{level.levelName}</span> {level.label}</span>
      <span className={`card-value ${toneClass(tone)}`}>{levelValueText(level)}</span>
      {sizeLines(level).map((l) => (
        <span key={l.text} className={`plan-level-line${l.tone === 'ok' ? '' : ` tone-${l.tone}`}`}>{l.text}</span>
      ))}
      {!pool && (
        <span className="plan-level-line">
          {structureLabel(level)}{' '}
          {structureParts(level).map((p, i) => (
            <Fragment key={p.text}>
              {i > 0 && !p.text.startsWith(' (') && ' · '}
              <span className={p.tone === 'ok' ? undefined : `tone-${p.tone}`} title={p.title}>{p.text}</span>
            </Fragment>
          ))}
        </span>
      )}
      {today && <span className="plan-level-line muted">{today}</span>}
      {(level.staff.rotation.length > 0 || level.staff.bullpen.length > 0) && (
        <span className="plan-level-line muted">
          Rotation: {staffText(level.staff.rotation) || '—'} · Bullpen: {staffText(level.staff.bullpen) || '—'}
        </span>
      )}
      {!pool && (
        <span className="plan-level-line muted">
          {level.serviceCap === null
            ? 'no service cap'
            : `cap ${level.serviceCap} · ${lastEligible} in their last eligible season`}
        </span>
      )}
      {needs.length > 0 && <span className="reasons">{needs.join('; ')}</span>}
    </div>
  );
}

export type SortKey = 'kind' | 'player' | 'age' | 'deadline';

/** The moves, one row each, with the decision controls where there is a server to tell. */
function MovesTable({ plan, moves, empty, onDecide, onNavigate, decideErrors }: {
  plan: Plan;
  moves: PlanMove[];
  /** What to say when nothing is listed. */
  empty: string;
  onDecide: (moveKey: string, action: DecideAction) => void;
  onNavigate?: (page: string) => void;
  decideErrors: Record<string, DecideError>;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const staticSite = isStaticSite();
  if (moves.length === 0) return <p className="muted">{empty}</p>;
  const sorted = sort ? sortMoves(moves, sort.key, sort.dir) : moves;
  const header = (key: SortKey, label: string) => (
    <SortableTh
      active={sort?.key === key}
      dir={sort?.key === key ? sort.dir : 1}
      onSort={() => setSort((s) => (s?.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }))}
    >
      {label}
    </SortableTh>
  );
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {header('kind', 'Kind')}
            {header('player', 'Player')}
            {header('age', 'Age')}
            <Th>Pos/Role</Th>
            <th><Tip label="Cur→Pot" tip={TIP_CURPOT} /></th>
            <Th>From → To</Th>
            <Th>Why</Th>
            {header('deadline', 'Deadline')}
            <Th>In OOTP</Th>
            {!staticSite && <Th>Decide</Th>}
          </tr>
        </thead>
        <tbody>
          {sorted.map((m) => (
            <MoveRow
              key={moveRowKey(m)}
              plan={plan}
              move={m}
              staticSite={staticSite}
              onDecide={onDecide}
              onNavigate={onNavigate}
              error={decideErrors[m.key]?.message}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The moves in the order a header asks for. Sorted by deadline, a settled
 * move comes after every move still to make, whichever way the dates run:
 * its date is a record of when it was due, not one to work to.
 */
export function sortMoves(moves: PlanMove[], key: SortKey, dir: 1 | -1): PlanMove[] {
  const value = (m: PlanMove): string | number => {
    switch (key) {
      case 'kind': return m.kind;
      case 'player': return m.player.name;
      case 'age': return m.player.age;
      case 'deadline': return m.deadline ? dateKey(m.deadline.date) : Number.MAX_SAFE_INTEGER;
    }
  };
  return [...moves].sort((a, b) => {
    if (key === 'deadline' && isSettled(a) !== isSettled(b)) return isSettled(a) ? 1 : -1;
    const [x, y] = [value(a), value(b)];
    const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return cmp * dir;
  });
}

/**
 * The move a row's buttons act on, for their accessible names: one man can
 * have two rows (a hold and a trade), so his name alone is not enough.
 */
export const moveName = (m: PlanMove): string => `${m.player.name}'s ${KIND_LABEL[m.kind]} move`;

/**
 * A move's deadline in its row. One still to make is a flag, hot inside a
 * month. A settled one is muted and never hot, since nothing is left to make
 * by it: once its date has passed it reads "was due" and the date, and before
 * then it is a plain flag.
 */
function DeadlineCell({ move: m, gameDate }: { move: PlanMove; gameDate: string }) {
  if (!m.deadline) return null;
  const { date, what } = m.deadline;
  const days = daysBetween(gameDate, date);
  if (isSettled(m)) {
    return days < 0
      ? <span className="muted" title={what}>{`was due ${date}`}</span>
      : <span className="flag" title={what}>{date}</span>;
  }
  return <span className={days < 30 ? 'flag flag-hot' : 'flag'} title={what}>{date}</span>;
}

function MoveRow({ plan, move: m, staticSite, onDecide, onNavigate, error }: {
  plan: Plan;
  move: PlanMove;
  staticSite: boolean;
  onDecide: (moveKey: string, action: DecideAction) => void;
  onNavigate?: (page: string) => void;
  error?: string;
}) {
  const [stepsOpen, setStepsOpen] = useState(false);
  const stepsId = useId();
  return (
    <tr>
      <td><span className={badgeClass(m.kind)}>{KIND_LABEL[m.kind]}</span></td>
      <td className="name"><PlayerLink id={m.player.player_id}>{m.player.name}</PlayerLink></td>
      <td>{m.player.age}</td>
      <td>{m.player.positionName}{m.player.roleLabel ? ` · ${m.player.roleLabel}` : ''}</td>
      <td className="num">{formatRatingPair(m.player.oa, m.player.pot)}</td>
      <td>
        <span className="level-tag">{m.from.label}</span> → <span className="level-tag">{m.to.label}</span>
        {m.fortyMan && onNavigate && !staticSite && (
          <>
            {' '}
            <button type="button" className="link-button" onClick={() => onNavigate('crunch')}>
              40-Man Roster
            </button>
          </>
        )}
      </td>
      <td className="reasons">{m.reasons.join('; ')}</td>
      <td><DeadlineCell move={m} gameDate={plan.gameDate} /></td>
      <td>
        <button
          type="button"
          className="link-button"
          aria-expanded={stepsOpen}
          aria-controls={stepsId}
          title={m.screen}
          aria-label={`Steps for ${moveName(m)}`}
          onClick={() => setStepsOpen((v) => !v)}
        >
          {stepsOpen ? 'Steps ▾' : 'Steps ▸'}
        </button>
        {/* Left in the markup and hidden, so the button always controls something */}
        <ol id={stepsId} className="plan-steps" hidden={!stepsOpen}>
          {m.ootpSteps.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      </td>
      {!staticSite && (
        <td className="plan-decide">
          <DecideCell
            move={m}
            today={m.decision.outcome === 'not-yet' ? clubToday(plan, m) : null}
            onDecide={onDecide}
            error={error}
          />
        </td>
      )}
    </tr>
  );
}

/** Where an import found him, as a phrase: "on Tulsa Drillers", or "out of the organization". */
const seenPhrase = (seenAt: string): string => (/^out of /i.test(seenAt) ? seenAt : `on ${seenAt}`);

/**
 * The list a move puts him on, for the moves that are about a place on one:
 * a protection asks for the 40-man, a move to the 60-day list for that list.
 * Neither cares which club he plays for, so where he is never makes one
 * "changed"; it is done or it is not. Null for every other move.
 */
const listOf = (m: PlanMove): string | null =>
  m.verify?.field === 'on40' || m.to.rung === '40man' ? 'the 40-man roster'
  : m.verify?.field === 'il60' ? 'the 60-day injured list'
  : null;

/**
 * "by the 2028-12-20 deadline": the deadline the decision was made against,
 * as the server stored it with the decision. The card beside it may already
 * carry a later one: once the draft is held OOTP rolls the Rule 5 date
 * forward a year, and a man the plan would still protect gets next winter's.
 *
 * A plan sent before decisions carried their deadline falls back to the
 * card's, and then names the date only when it is one that has passed: the
 * import that closed the window came after the deadline it closed, so a date
 * on or after that import is a later one, and the card says "its deadline"
 * rather than a date that has not come.
 */
function byDeadline(m: PlanMove): string {
  const date = m.decision.deadlineDate ?? m.deadline?.date;
  const seen = m.decision.verifiedGameDate;
  return date && (!seen || dateKey(date) < dateKey(seen)) ? `by the ${date} deadline` : 'by its deadline';
}

/**
 * The club the plan has him on today, for the "Not yet — on …" of a move
 * about a list: the import records where it saw him only once a move is
 * settled, and the plan is drawn from that same export. His row at a level
 * he stays at or leaves is where the export has him. A rung of two clubs
 * does not say which of the two, so there the move's own club is named while
 * he is still on its rung, and nothing otherwise.
 */
export function clubToday(plan: Pick<Plan, 'levels'>, m: PlanMove): string | null {
  const id = m.player.player_id;
  const level = plan.levels.find((l) => l.roster.some((r) => r.player_id === id && r.status !== 'arrives'));
  if (!level) return null;
  if (!clubsOf(level) && level.teamIds.length <= 1) return level.label;
  const sameClub = level.rung === m.from.rung && m.from.team_id !== null && level.teamIds.includes(m.from.team_id);
  return sameClub ? m.from.label : null;
}

/**
 * What the import saw, never what happened: the card says what was seen and
 * where.
 *
 * A changed move is one of two things. Either he went somewhere the move did
 * not name ("Changed — on Tulsa, not Oklahoma City"), or its deadline passed
 * with him still where he was: a release or trade man still in the
 * organisation, anyone else still on the club the move started from. The
 * second is said as what it is, never as a move he did not make.
 *
 * A move about a list (a protection, the 60-day list) is never "changed",
 * because it did not ask him to go anywhere: past its deadline it was not
 * done, and before it, it is not done yet, wherever he plays. Both say the
 * club he is on and the list he is not on. `today` is the club the plan has
 * him on (`clubToday`), since an import that has not settled the move does
 * not record one; without it the card says only that he is not on the list.
 */
export function decisionText(m: PlanMove, today: string | null = null): string {
  const d = m.decision;
  if (d.state === 'dismissed') return `Dismissed ${d.gameDate ?? ''}`.trim();
  if (d.state !== 'accepted') return '';
  const seen = d.verifiedGameDate ? ` in the ${d.verifiedGameDate} export` : '';
  const seenAt = d.seenAt ?? null;
  const list = listOf(m);
  // "on Oklahoma City Comets, not the 40-man roster, in the … export", or only the certain part
  const offList = (club: string | null): string =>
    club !== null && !/^out of /i.test(club) ? `on ${club}, not ${list}${seen ? `,${seen}` : ''}` : `not on ${list}${seen}`;
  switch (d.outcome) {
    case 'done':
      return seenAt ? `Done — ${seenPhrase(seenAt)}${seen}` : `Done — seen${seen}`;
    case 'changed': {
      const by = byDeadline(m);
      if (list) return `Not done ${by} — ${offList(seenAt)}`;
      // A release or trade is only ever changed by its deadline passing: he
      // is still in the organisation, wherever the export found him
      if (m.to.rung === 'out') {
        const where = seenAt !== null && !/^out of /i.test(seenAt) ? `on ${seenAt}` : 'in the organisation';
        return `Not done ${by} — still ${where}${seen}`;
      }
      if (seenAt !== null && seenAt === m.from.label) return `Not done ${by} — still on ${seenAt}${seen}`;
      if (seenAt !== null) return `Changed — ${seenPhrase(seenAt)}, not ${m.to.label}${seen ? `,${seen}` : ''}`;
      // Nowhere recorded: say only what is certain, that he is not where the move named
      return `Changed — not on ${m.to.label}${seen}`;
    }
    case 'not-yet':
      if (list) return `Not yet — ${offList(today)}`;
      return `Accepted ${d.gameDate ?? ''} · not yet seen${seen}`;
    case 'moot': return `Moot — no longer in the organisation${seen}`;
    default: return `Accepted ${d.gameDate ?? ''} · not yet seen${seen}`;
  }
}

function DecideCell({ move: m, today, onDecide, error }: {
  move: PlanMove;
  /** The club the plan has him on, for a move not yet seen done; null when it is not needed. */
  today: string | null;
  onDecide: (moveKey: string, action: DecideAction) => void;
  /** Why the last decision on this row was not saved. */
  error?: string;
}) {
  const name = moveName(m);
  const note = error ? <> <span className="tone-bad plan-decide-error" role="alert">{error}</span></> : null;
  if (m.decision.state === 'open') {
    return (
      <>
        <button type="button" className="link-button" aria-label={`Accept ${name}`} onClick={() => onDecide(m.key, 'accepted')}>Accept</button>
        {' · '}
        <button type="button" className="link-button" aria-label={`Dismiss ${name}`} onClick={() => onDecide(m.key, 'dismissed')}>Dismiss</button>
        {note}
      </>
    );
  }
  const undo = m.decision.state === 'dismissed' ? 'Restore' : 'Reopen';
  return (
    <>
      <span className="muted">{decisionText(m, today)}</span>
      {' · '}
      <button type="button" className="link-button" aria-label={`${undo} ${name}`} onClick={() => onDecide(m.key, 'reopen')}>
        {undo}
      </button>
      {note}
    </>
  );
}

/**
 * The release-or-trade rows the page lists: less a man whose release or
 * trade was dismissed and who has no other such move still standing. The
 * engine already leaves those out; the page checks again for a cached plan.
 */
export function liveReleaseRows(plan: Plan): Plan['releaseOrTrade'] {
  const out = (m: PlanMove) => m.kind === 'release' || m.kind === 'trade';
  const dismissed = new Set(plan.moves.filter((m) => out(m) && m.decision.state === 'dismissed').map((m) => m.player.player_id));
  const standing = new Set(plan.moves.filter((m) => out(m) && m.decision.state !== 'dismissed').map((m) => m.player.player_id));
  return plan.releaseOrTrade.filter((r) => !dismissed.has(r.player_id) || standing.has(r.player_id));
}

/** What the Flags column of the release-or-trade list holds: roster facts, not contract clauses. */
export const MODIFIERS_TIP =
  'Roster facts that change what he is worth: in his last option year or out of options on the 40-man, ' +
  'exposed to the Rule 5 draft, or a minor-league free agent after the season.';

/** The ranked release-or-trade list: the top is the man to act on. */
function ReleaseTable({ plan }: { plan: Plan }) {
  const rows = liveReleaseRows(plan);
  if (rows.length === 0) return <p className="muted">Nobody to move out.</p>;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <Th>Rk</Th>
            <Th>Kind</Th>
            <Th>Player</Th>
            <Th>Asset class</Th>
            <Th tip={MODIFIERS_TIP}>Flags</Th>
            <Th>Why</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.player_id}>
              <td className="num">{r.rank}</td>
              <td><span className={badgeClass(r.kind)}>{r.kind}</span></td>
              <td className="name"><PlayerLink id={r.player_id}>{r.name}</PlayerLink></td>
              <td>{r.assetClass}</td>
              <td>
                {r.modifiers.map((f, n) => (
                  <Fragment key={f}>
                    {n > 0 && ' '}
                    <span className="flag">{f}</span>
                  </Fragment>
                ))}
              </td>
              <td className="reasons">{r.reasons.join('; ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
