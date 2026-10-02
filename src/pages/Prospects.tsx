import { useEffect, useState } from 'react';
import { getProspects, type Prospect, type ProspectsResponse } from '../api';
import { PlayerLink, Tip, TIP_CURPOT } from '../playerModal';
import { Th } from '../Th';
import { formatRatingPair } from '../ratingScale';
import { navigate, useRoute } from '../route';
import { MethodNote } from '../MethodNote';

/** The first sentence of the method, shown beside the toggle while the note is shut. */
const METHOD_SUMMARY =
  'Minor leaguers ranked by promotion signal: production vs level average, age vs level average, and ' +
  'current-vs-potential ratings.';

/**
 * Which signals the page lists, as the address asks for them:
 * #/prospects?signal=decision.
 *
 * `decision` is promote, blocked and demote, the three the dashboard's Farm
 * signals chip counts and the three that ask for a call, so following the chip
 * lands on a page holding exactly as many men as the chip said. Watch is left
 * out of it, as it is from the chip: it only says a man is playing well.
 */
export type SignalFilter = 'all' | 'decision' | 'promote' | 'blocked' | 'demote' | 'watch';

const SIGNAL_FILTERS: Array<{ key: SignalFilter; label: string; tip?: string }> = [
  { key: 'all', label: 'All' },
  {
    key: 'decision', label: 'Decisions',
    tip: 'Promote, blocked and demote: the signals that ask for a call. The dashboard chip counts these.',
  },
  { key: 'promote', label: 'Promote' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'demote', label: 'Demote' },
  { key: 'watch', label: 'Watch' },
];

/** What the address asked for. A value it does not recognise is the whole farm, not an empty page. */
export function signalFilter(param: string | undefined): SignalFilter {
  return SIGNAL_FILTERS.find((f) => f.key === param)?.key ?? 'all';
}

export function matchesSignal(filter: SignalFilter, signal: Prospect['signal']): boolean {
  if (filter === 'all') return true;
  if (filter === 'decision') return signal === 'promote' || signal === 'blocked' || signal === 'demote';
  return signal === filter;
}

/** How many men each button would show, so a filter says what is behind it before it is pressed. */
export function signalCounts(data: ProspectsResponse): Record<SignalFilter, number> {
  const everyone = [...data.batters, ...data.pitchers];
  const counts = {} as Record<SignalFilter, number>;
  for (const f of SIGNAL_FILTERS) counts[f.key] = everyone.filter((p) => matchesSignal(f.key, p.signal)).length;
  return counts;
}

/**
 * The 40-man part of a move, as the server sends it beside the note. Declared
 * here until the Prospect type in api.ts carries it.
 */
interface FortyManNeed {
  count: number;
  limit: number;
  comesOff: { player_id: number; name: string; why: string } | null;
}

const fortyManNeed = (p: Prospect): FortyManNeed | null =>
  (p.move as { fortyMan?: FortyManNeed | null } | null)?.fortyMan ?? null;

/**
 * `onNavigate` opens another page; given it, a call-up that needs a 40-man
 * place links straight to the 40-Man Roster, where that place is found.
 */
export function Prospects({ orgId, onNavigate }: { orgId: number; onNavigate?: (page: string) => void }) {
  const [data, setData] = useState<ProspectsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { params } = useRoute();

  useEffect(() => {
    setData(null);
    getProspects(orgId).then(setData).catch((e) => setError(e.message));
  }, [orgId]);

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="muted">Loading prospects…</p>;

  // The filter lives in the address, so a chip can open the page on it and a
  // link to the page carries it. Choosing one rewrites the entry in place: it is
  // not a step worth undoing, and the address then says what the page shows
  const pick = (next: SignalFilter) =>
    navigate('prospects', { ...params, signal: next === 'all' ? undefined : next }, { replace: true });
  return <ProspectsView data={data} filter={signalFilter(params.signal)} onFilter={pick} onNavigate={onNavigate} />;
}

/**
 * The page once its data is in. Apart from the fetch and the address so that it
 * can be drawn from a payload and a filter alone, which is how the tests read
 * what a man would see.
 */
export function ProspectsView({ data, filter, onFilter, onNavigate }: {
  data: ProspectsResponse;
  filter: SignalFilter;
  onFilter: (next: SignalFilter) => void;
  onNavigate?: (page: string) => void;
}) {
  const counts = signalCounts(data);
  const keep = (rows: Prospect[]) => rows.filter((p) => matchesSignal(filter, p.signal));
  return (
    <div>
      <div className="toolbar">
        <div className="tabs" role="group" aria-label="Signal">
          {SIGNAL_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={filter === f.key ? 'active' : ''}
              aria-pressed={filter === f.key}
              title={f.tip}
              onClick={() => onFilter(f.key)}
            >
              {f.label} <span className="muted">{counts[f.key]}</span>
            </button>
          ))}
        </div>
      </div>
      <MethodNote pageKey="prospects" summary={METHOD_SUMMARY}>
      <p className="muted hint-line">
        {METHOD_SUMMARY} Sample minimums: 60 PA / 15 IP this season.{' '}
        <strong>Demote</strong> marks a man clearly below his level who is not young for it — it asks a
        bigger gap and a longer look than promote does, because sending somebody down is the easier call
        to get wrong, and it is never shown for the lowest club in the organisation.{' '}
        Those sit at the bottom of each table, since the order runs on the same signal.
      </p>
      <p className="muted hint-line">
        <strong>The move</strong> is the other half of a call-up: who comes off the big club to make
        room, and whether the swap is an improvement. It compares OOTP's Overall grade rather than the
        season lines, because a .900 OPS in Double-A and a .900 OPS in the majors are not the same
        achievement — the grade is scouted current ability and means the same thing at every level. A
        man graded below everyone at his listed position is marked <strong>blocked</strong> instead of
        promote: he has earned it where he is, but the club is better as it stands. Not when the
        weakest of them is having a poor season or is 33 or older, though: a slump excuses a lead of
        up to 20 points and age one of up to 10 (on the 20-80 scale), and the move says which. The
        comparison runs on his listed position only, so a shortstop blocked by a shortstop may still
        have a home at second or third. If he is not on a full 40-man, the move also names who could
        give up a place on it.
      </p>
      </MethodNote>
      <h2>Batters</h2>
      <ProspectTable prospects={keep(data.batters)} kind="batter" filtered={filter !== 'all'} onNavigate={onNavigate} />
      <h2>Pitchers</h2>
      <ProspectTable prospects={keep(data.pitchers)} kind="pitcher" filtered={filter !== 'all'} onNavigate={onNavigate} />
    </div>
  );
}

function ProspectTable({
  prospects, kind, filtered, onNavigate,
}: { prospects: Prospect[]; kind: 'batter' | 'pitcher'; filtered: boolean; onNavigate?: (page: string) => void }) {
  if (prospects.length === 0) {
    // With a filter on, the sample is not what is missing, and saying so would send the reader off to wait for nothing
    return filtered
      ? <p className="muted">No {kind}s with that signal.</p>
      : <p className="muted">No qualified {kind}s yet — small samples this early in the season.</p>;
  }
  return (
    <div className="table-scroll">
    <table>
      <thead>
        <tr>
          <Th>Signal</Th>
          <Th>Player</Th>
          <Th>Age</Th>
          <Th>Pos</Th>
          <Th>Team</Th>
          {kind === 'batter' ? (
            <>
              <Th>PA</Th>
              <Th>OPS</Th>
              <Th>HR</Th>
              <Th>SB</Th>
            </>
          ) : (
            <>
              <Th>IP</Th>
              <Th>ERA</Th>
              <Th>K%</Th>
            </>
          )}
          <Th>WAR</Th>
          <th><Tip label="Cur→Pot" tip={TIP_CURPOT} /></th>
          <Th>The move</Th>
          <Th>Why</Th>
        </tr>
      </thead>
      <tbody>
        {prospects.map((p) => (
          <tr key={p.player_id}>
            <td>{p.signal && <span className={`badge ${p.signal}`}>{p.signal}</span>}</td>
            <td className="name"><PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
            <td>{p.age}</td>
            <td>{p.positionName}</td>
            <td>
              <span className="level-tag">{p.levelName}</span> {p.team}
            </td>
            {kind === 'batter' ? (
              <>
                <td className="num">{p.pa}</td>
                <td className="num">{p.opsVal?.toFixed(3)}</td>
                <td className="num">{p.hr}</td>
                <td className="num">{p.sb}</td>
              </>
            ) : (
              <>
                <td className="num">{p.ip}</td>
                <td className="num">{p.era?.toFixed(2)}</td>
                <td className="num">{p.kpct?.toFixed(1)}</td>
              </>
            )}
            <td className="num">{p.war?.toFixed(1)}</td>
            <td className="num">
              {formatRatingPair(p.cur, p.pot)}
            </td>
            <td className="reasons">
              {p.signal === 'promote' || p.signal === 'blocked' ? p.move?.note ?? '—' : ''}
              {p.signal === 'promote' && fortyManNeed(p) && onNavigate && (
                <>
                  {' '}
                  <button type="button" className="link-button" onClick={() => onNavigate('crunch')}>
                    40-Man Roster
                  </button>
                </>
              )}
            </td>
            <td className="reasons">{p.reasons.join('; ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}
