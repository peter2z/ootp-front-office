import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { apiGet } from '../api';
import { PlayerLink } from '../playerModal';

interface Segment { text: string; kind?: 'player' | 'team'; id?: number }
interface Transaction {
  date: string | null;
  kind: 'trade' | 'signing' | 'waiver' | 'contract';
  seenBetween?: { from: string | null; to: string | null };
  summary: Segment[];
  plain: string;
  yours: boolean;
}
interface Feed {
  transactions: Transaction[];
  /** Of the deals in this answer. */
  yours: number;
  available: boolean;
  /** Whether older deals exist beyond what has been read so far. */
  hasMore: boolean;
}

/** The date box has no rule of its own in the stylesheet; this is the look the other controls have. */
const DATE_BOX: CSSProperties = {
  background: 'var(--panel)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: 13,
  fontFamily: 'inherit',
};

const KIND_LABEL: Record<Transaction['kind'], string> = {
  trade: 'Trade',
  signing: 'Signing',
  waiver: 'Waivers',
  contract: 'Contract',
};

/**
 * OOTP writes its summaries with the names marked up, so every player in a deal
 * can be opened from the sentence describing it rather than looked up
 * afterwards.
 */
function Summary({ segments }: { segments: Segment[] }) {
  return (
    <>
      {segments.map((s, i) =>
        s.kind === 'player' && s.id ? (
          <PlayerLink key={i} id={s.id}>{s.text}</PlayerLink>
        ) : s.kind === 'team' ? (
          <strong key={i}>{s.text}</strong>
        ) : (
          <span key={i}>{s.text}</span>
        )
      )}
    </>
  );
}

export function Transactions({ orgId }: { orgId: number }) {
  const [data, setData] = useState<Feed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mine, setMine] = useState(false);
  const [kind, setKind] = useState<'all' | Transaction['kind']>('all');
  /*
   * The day the feed is cut off at, kept with the club it was chosen for so
   * that another club starts at its newest deal with nothing to reset.
   */
  const [pick, setPick] = useState({ org: orgId, date: '' });
  const before = pick.org === orgId ? pick.date : '';
  const [busy, setBusy] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  /*
   * Bumped whenever the feed being read changes, so that an answer to a
   * question asked before the club or the date changed is dropped instead of
   * being added to the new feed.
   */
  const version = useRef(0);
  const dateQuery = before ? `before=${before}` : '';

  // Another club is another feed. A new date keeps the old one on screen until
  // the answer arrives, so the date box is not unmounted under the reader.
  useEffect(() => {
    setData(null);
  }, [orgId]);

  useEffect(() => {
    const asked = ++version.current;
    setError(null);
    setMoreError(null);
    setBusy(true);
    apiGet<Feed>(`/api/transactions/${orgId}${dateQuery ? `?${dateQuery}` : ''}`)
      .then((d) => { if (asked === version.current) setData(d); })
      .catch((e) => { if (asked === version.current) setError(e.message); })
      .finally(() => { if (asked === version.current) setBusy(false); });
  }, [orgId, dateQuery]);

  /*
   * The next page, added on. It asks for as many deals as it already has
   * skipped, so what is appended starts exactly where the list stops.
   */
  const loadMore = () => {
    if (!data || busy) return;
    const asked = version.current;
    setBusy(true);
    setMoreError(null);
    const query = [`offset=${data.transactions.length}`, dateQuery].filter(Boolean).join('&');
    apiGet<Feed>(`/api/transactions/${orgId}?${query}`)
      .then((next) => {
        if (asked !== version.current) return;
        setData((d) =>
          d && {
            ...d,
            transactions: [...d.transactions, ...next.transactions],
            yours: d.yours + next.yours,
            hasMore: next.hasMore,
          }
        );
      })
      .catch((e) => { if (asked === version.current) setMoreError(e.message); })
      .finally(() => { if (asked === version.current) setBusy(false); });
  };

  const shown = useMemo(() => {
    if (!data) return [];
    return data.transactions.filter(
      (t) => (!mine || t.yours) && (kind === 'all' || t.kind === kind)
    );
  }, [data, mine, kind]);

  const kinds = useMemo(
    () => [...new Set((data?.transactions ?? []).map((t) => t.kind))],
    [data]
  );

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="muted">Reading the league's paperwork…</p>;

  // A date with nothing on or before it is not an empty league: the toolbar
  // stays, so the date can be changed
  if (data.transactions.length === 0 && !before) {
    return (
      <div className="hint">
        <h3>No transactions in this export</h3>
        <p>
          {data.available
            ? 'The league has not traded or signed anybody yet — the moment it does, the deals show up here.'
            : 'This save does not carry the trade and message tables the feed is built from.'}
        </p>
      </div>
    );
  }

  return (
    <div>
      <p className="muted hint-line">
        Every deal in the league, newest first, as OOTP itself recorded it — trades with both sides
        named, free-agent signings, and waiver claims. Your own moves are marked. The point of the
        rest is the one a reader put better than I would: watching for a man who fits a hole you have
        turning up on waivers or changing hands cheaply.
      </p>
      <p className="muted hint-line">
        Where the dates come from, since it matters. Trades and waiver claims are the game's own
        records and are exact. <strong>Signings</strong> come from the league's news, and OOTP does
        not write a story for every one — it favours the bigger name, so a quiet extension can go
        unreported. Those turn up as <strong>Contract</strong> instead: the app noticed the deal
        changed between two of your exports, so it knows what happened but only the window it
        happened in, not the day. That needs two imports to see anything, and it can never recover a
        signing from before you started importing.
      </p>

      <div className="toolbar">
        <span className="level-picker">
          <button className={mine ? '' : 'active'} onClick={() => setMine(false)}>
            Whole league
          </button>
          <button className={mine ? 'active' : ''} onClick={() => setMine(true)}>
            My club ({data.yours})
          </button>
        </span>
        {kinds.length > 1 && (
          <span className="level-picker">
            <button className={kind === 'all' ? 'active' : ''} onClick={() => setKind('all')}>
              All
            </button>
            {kinds.map((k) => (
              <button key={k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>
                {KIND_LABEL[k]}
              </button>
            ))}
          </span>
        )}
        <label className="muted">
          Up to{' '}
          <input
            type="date"
            style={DATE_BOX}
            value={before}
            aria-label="Show deals up to this date"
            onChange={(e) => setPick({ org: orgId, date: e.target.value })}
          />
        </label>
        {before && <button onClick={() => setPick({ org: orgId, date: '' })}>Latest</button>}
        <span className="muted">
          {shown.length} of {data.transactions.length} loaded
        </span>
      </div>

      {data.transactions.length === 0 ? (
        <p className="muted">Nothing on record up to {before}.</p>
      ) : shown.length === 0 ? (
        <p className="muted">
          Nothing matches those filters{data.hasMore ? ' in the deals loaded so far' : ''}.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Kind</th>
              <th>What happened</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((t, i) => (
              <tr key={i} className={t.yours ? 'ours' : undefined}>
                <td className="num">
                  {t.date ?? ''}
                  {t.seenBetween && (
                    <div className="muted seen-between">
                      since {t.seenBetween.from}
                    </div>
                  )}
                </td>
                <td>
                  <span className={`badge txn-${t.kind}`}>{KIND_LABEL[t.kind]}</span>
                </td>
                <td className="wrap-cell">
                  <Summary segments={t.summary} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data.hasMore ? (
        <p>
          <button onClick={loadMore} disabled={busy}>
            {busy ? 'Loading…' : 'Load older deals'}
          </button>
          {moreError && <span className="bad-text"> Could not load them: {moreError}</span>}
        </p>
      ) : (
        data.transactions.length > 0 && (
          <p className="muted">
            That is every deal on record{before ? ` up to ${before}` : ''}.
          </p>
        )
      )}
    </div>
  );
}
