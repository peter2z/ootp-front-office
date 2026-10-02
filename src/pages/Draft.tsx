import { useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, isStaticSite } from '../api';
import { PlayerLink, Tip, TIP_CURPOT } from '../playerModal';
import { Th } from '../Th';
import { formatRating, formatRatingPair } from '../ratingScale';

interface DraftProspect {
  player_id: number; name: string; age: number; positionName: string; bats: string; throws: string;
  school: string; isPitcher: boolean; cur: number | null; pot: number | null; upside: number | null;
  speed: number | null; boardRank: number;
  /** Years until he reaches the draft age, 0 once he has. Absent in an older export. */
  yearsToEligibility?: number;
  recommendation: { label: string; reasons: string[] } | null;
}
interface DraftData {
  leagueName: string;
  hasDraft: boolean;
  poolVisible: boolean;
  gameDate: string | null;
  draftDate: string | null;
  poolDate: string | null;
  combineDate: string | null;
  rounds: number;
  /** The whole class. `prospects` below is only the best of it. */
  total: number;
  /** The age the years-to-eligibility figures count to, and how many of the class are under it. */
  minDraftAge?: number;
  tooYoung?: number;
  /**
   * Eligible men this board deliberately left out. Shown only when it is not
   * empty: a reader whose universe runs its own high-school and college drafts
   * saw a board full of the wrong players and had no way to tell whether the
   * app had missed his class or ruled it out.
   */
  excluded?: { alreadyPicked: number; otherDraft: number; unrated: number };
  /**
   * 'flag' where OOTP marks the class itself, 'class' where the league runs its
   * own school competitions and eligibility has to be read from the year group.
   */
  poolRule?: 'flag' | 'class';
  /** What the whole class holds, said before any of it has been fetched. */
  pool?: { school: { HS: number; College: number }; positions: Record<Group, number> };
  /** The best at the spots the club is thinnest, read from the whole class and not from the board. */
  fits?: DraftProspect[];
  needs: Array<{ position: number; positionName: string; bestValue: number | null }>;
  /** The board: the best hundred of the class by ceiling. The rest is asked for a page at a time. */
  prospects: DraftProspect[];
}

/** One page of the class, narrowed and ordered the way the table asked for it. */
interface PoolPage {
  total: number;
  matched: number;
  prospects: DraftProspect[];
}

/**
 * Says what the board left out, when it left anything out.
 *
 * Silent on a save where none of it applies, which is most of them. It exists
 * because "these are the wrong players" and "the app cannot see my players"
 * look identical from the outside, and a reader with high-school and college
 * leagues of his own hit exactly that.
 */
function leftOut(x: DraftData['excluded']): string {
  if (!x) return '';
  const parts: string[] = [];
  if (x.alreadyPicked > 0) parts.push(`${x.alreadyPicked} already drafted`);
  if (x.otherDraft > 0) parts.push(`${x.otherDraft} in another league's draft`);
  if (x.unrated > 0) parts.push(`${x.unrated} with no scouted ceiling`);
  return parts.length ? ` Not shown: ${parts.join(', ')}.` : '';
}

/** "3 yrs" for a man still below the draft age, and an empty string for one who is not. */
const waits = (p: DraftProspect): string => {
  const n = p.yearsToEligibility ?? 0;
  return n > 0 ? `${n} yr${n === 1 ? '' : 's'}` : '';
};

/**
 * Marks a man who cannot be taken yet. OOTP's pool holds fourteen- and
 * fifteen-year-olds, and a shortlist that offers one with no word of it reads as
 * advice to draft a child.
 */
function NotYet({ p }: { p: DraftProspect }) {
  const w = waits(p);
  return w ? <span className="flag flag-hot">eligible in {w}</span> : null;
}

/** Builds a local Date from YYYY-MM-DD, which Date.parse would read as UTC. */
const asDate = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const pretty = (iso: string | null): string =>
  iso ? asDate(iso).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }) : '';
const monthDay = (iso: string | null): string =>
  iso ? asDate(iso).toLocaleDateString([], { month: 'long', day: 'numeric' }) : '';
const daysUntil = (from: string, to: string): number =>
  Math.round((asDate(to).getTime() - asDate(from).getTime()) / 86_400_000);

/** Position groups, so "infield" does not mean typing four filters. The server reads them the same way. */
type Group = 'C' | 'IF' | 'OF' | 'P';

/** The table is long; rendering the whole class at once is not useful. */
const PAGE = 100;

/** A value that follows another at a distance, so typing does not ask a question per keystroke. */
function useDebounced<T>(value: T, ms: number): T {
  const [held, setHeld] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setHeld(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return held;
}

function Calendar({ data }: { data: DraftData }) {
  const stops: Array<[string, string | null]> = [
    ['Class published', data.poolDate],
    ['Combine', data.combineDate],
    ['Draft day', data.draftDate],
  ];
  const known = stops.filter(([, d]) => d);
  if (known.length === 0) return null;
  return (
    <table className="mini">
      <tbody>
        {known.map(([label, d]) => (
          <tr key={label}>
            <td>{label}</td>
            <td className="num">{pretty(d)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Draft({ orgId }: { orgId: number }) {
  /** The board: the shortlist, the counts, and the best hundred of the class. */
  const [data, setData] = useState<DraftData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [q, setQ] = useState('');
  const [group, setGroup] = useState<'all' | Group>('all');
  const [school, setSchool] = useState<'all' | 'HS' | 'College'>('all');
  const [maxAge, setMaxAge] = useState(30);
  const [minPot, setMinPot] = useState(0);
  const [sortKey, setSortKey] = useState<string>('pot');
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

  /*
   * What is on the table, and how much of the class matches what it was asked.
   *
   * It starts as the board, which arrived with the page and is exactly the top
   * of the class in its own order. Everything else — a name typed, a column
   * sorted, a filter set, another hundred — is a question for the pool, which
   * the server holds and answers a page at a time. The page keeps the rows it
   * has been given and nothing beyond them: it used to be sent the whole class,
   * two thousand seven hundred men and 860 KB, to show the first hundred.
   */
  const [table, setTable] = useState<{ search: string; rows: DraftProspect[]; matched: number } | null>(null);
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [poolError, setPoolError] = useState<string | null>(null);
  // A static copy of the site has no server to ask, so it can only show the board it was saved with
  const staticSite = isStaticSite();

  useEffect(() => {
    setData(null);
    setTable(null);
    setError(null);
    apiGet<DraftData>(`/api/draft/${orgId}`).then(setData).catch((e) => setError(e.message));
  }, [orgId]);

  const setSort = (key: string) => {
    if (staticSite) return;
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      // Ratings read best high-first; name and age read best low-first
      setSortDir(key === 'name' || key === 'age' || key === 'boardRank' ? 1 : -1);
    }
  };
  const arrow = (key: string) => (key === sortKey ? (sortDir === 1 ? ' ▲' : ' ▼') : '');

  // Typed things wait for the typing to stop; a menu or a column heading is answered at once
  const typed = useDebounced(q.trim(), 300);
  const ageCap = useDebounced(maxAge, 300);
  const ceiling = useDebounced(minPot, 300);
  /** The question put to the pool, without the page. Empty is the plain class, which is the board. */
  const search = useMemo(() => {
    const params = new URLSearchParams();
    if (typed) params.set('q', typed);
    if (group !== 'all') params.set('group', group);
    if (school !== 'all') params.set('school', school);
    if (ageCap < 30) params.set('maxAge', String(ageCap));
    if (ceiling > 0) params.set('minPot', String(ceiling));
    if (sortKey !== 'pot' || sortDir !== -1) {
      params.set('sort', sortKey);
      params.set('dir', sortDir === 1 ? 'asc' : 'desc');
    }
    return params.toString();
  }, [typed, group, school, ageCap, ceiling, sortKey, sortDir]);

  const poolUrl = (asked: string, offset: number) =>
    `/api/draft/${orgId}?pool=1&limit=${PAGE}&offset=${offset}${asked ? `&${asked}` : ''}`;

  /*
   * A new question starts again from the top of the answer. The generation
   * number is how a slow reply to a question already abandoned is told apart
   * from the reply to the current one, and dropped.
   */
  const generation = useRef(0);
  const asking = useRef(false);
  useEffect(() => {
    if (!data?.prospects) return;
    const mine = ++generation.current;
    asking.current = false;
    setLoadingMore(false);
    setPoolError(null);
    if (search === '' || staticSite) {
      setTable({ search, rows: data.prospects, matched: data.total });
      setSearching(false);
      return;
    }
    setSearching(true);
    apiGet<PoolPage>(poolUrl(search, 0))
      .then((r) => {
        if (generation.current !== mine) return;
        setTable({ search, rows: r.prospects, matched: r.matched });
        setSearching(false);
      })
      .catch((e) => {
        if (generation.current !== mine) return;
        setPoolError(e.message);
        setSearching(false);
      });
  }, [data, search, orgId, staticSite]);

  /** The next hundred of the same question, from where the rows already here end. */
  const showMore = () => {
    if (!table || asking.current) return;
    asking.current = true;
    const mine = generation.current;
    const asked = table.search;
    setLoadingMore(true);
    apiGet<PoolPage>(poolUrl(asked, table.rows.length))
      .then((r) => {
        if (generation.current !== mine) return;
        setTable((now) => {
          if (!now || now.search !== asked) return now;
          // An import between the two requests can shift the class under us
          const seen = new Set(now.rows.map((p) => p.player_id));
          return {
            ...now,
            matched: r.matched,
            rows: [...now.rows, ...r.prospects.filter((p) => !seen.has(p.player_id))],
          };
        });
      })
      .catch((e) => {
        if (generation.current === mine) setPoolError(e.message);
      })
      .finally(() => {
        if (generation.current === mine) {
          asking.current = false;
          setLoadingMore(false);
        }
      });
  };

  /**
   * A short list to actually act on. Best available is the honest first answer;
   * the need-based picks are offered second and labelled as the weaker idea,
   * because a draft pick is years from helping the club he is drafted by.
   */
  const best = useMemo(() => {
    /*
     * These run before the lines below that hand back "no draft" and "class not
     * published", so they see every answer the endpoint can give — including
     * the ones with no class in them at all.
     */
    if (!data?.prospects) return [];
    return data.prospects.slice(0, 5);
  }, [data]);
  // Read by the server from the whole class: a fit can be ranked well below the hundredth man
  const fits = data?.fits ?? [];

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="muted">Reading the scouting reports…</p>;

  if (!data.hasDraft) {
    return (
      <div className="hint">
        <h3>No amateur draft</h3>
        <p>{data.leagueName} does not run one, so there is no class to scout.</p>
      </div>
    );
  }

  if (!data.poolVisible) {
    const before = !!(data.gameDate && data.poolDate && data.poolDate > data.gameDate);
    return (
      <div className="hint">
        <h3>The class has not been published yet</h3>
        <p>
          {before ? (
            <>
              {data.leagueName} publishes the draft class on <strong>{pretty(data.poolDate)}</strong>
              {data.gameDate && <> — {daysUntil(data.gameDate, data.poolDate!)} days from now</>}. The
              board fills in on its own that morning.
            </>
          ) : (
            <>
              This year&rsquo;s draft is behind you. The next class is published around{' '}
              <strong>{monthDay(data.poolDate) || 'the same date next season'}</strong>.
            </>
          )}
        </p>
        <p className="muted">
          Amateurs exist in your export before then, but OOTP keeps them off every screen until the
          class is announced — they are on no team, in no league, and in no draft pool. Ranking them
          early would be scouting information the game has not given you.
        </p>
        <Calendar data={data} />
      </div>
    );
  }

  // Before the first answer to a question has landed, the board is the table
  const shown = table?.rows ?? data.prospects;
  const matched = table?.matched ?? data.total;
  /** " (247)" beside a menu entry, from the counts the board arrived with. */
  const count = (n: number | undefined): string => (n === undefined ? '' : ` (${n.toLocaleString()})`);

  return (
    <div>
      <section>
        <h2>Who to take</h2>
        <div className="two-col">
          <div>
            <strong className="muted">Best available</strong>
            <table className="mini">
              <tbody>
                {best.map((p) => (
                  <tr key={p.player_id}>
                    <td className="num muted">{p.boardRank}</td>
                    <td className="name"><PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
                    <td>{p.positionName}</td>
                    <td className="num">{formatRatingPair(p.cur, p.pot)}</td>
                    <td className="muted">{p.recommendation?.label ?? ''}</td>
                    <td><NotYet p={p} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {fits.length > 0 && (
            <div>
              <strong className="muted">
                Best at your thinnest spots ({(data.needs ?? []).slice(0, 3).map((h) => h.positionName).join(', ')})
              </strong>
              <table className="mini">
                <tbody>
                  {fits.map((p) => (
                    <tr key={p.player_id}>
                      <td className="num muted">{p.boardRank}</td>
                      <td className="name"><PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
                      <td>{p.positionName}</td>
                      <td className="num">{formatRatingPair(p.cur, p.pot)}</td>
                      <td><NotYet p={p} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <p className="muted hint-line">
          Best available is the stronger idea. Drafting for a hole is the weaker one and is offered
          second on purpose: a pick taken today is years from the majors, and the position you are
          thin at now is rarely the one you will be short of when he arrives. Every number here is a
          scouted rating on an amateur your staff has barely seen — treat the ordering as rough.
        </p>
      </section>

      <div className="toolbar">
        <span className="muted">
          {data.total} draft-eligible players.
          {/* OOTP's pool holds younger amateurs than a draft can take, and the
              "Eligible in" column says how long each of them has to wait */}
          {(data.tooYoung ?? 0) > 0 && <> {data.tooYoung} are under {data.minDraftAge ?? 17}.</>}
          {data.draftDate && data.gameDate && (
            <> Draft day is {pretty(data.draftDate)}, {daysUntil(data.gameDate, data.draftDate)} days out
              {data.rounds > 0 && <> — {data.rounds} rounds</>}.
            </>
          )}
          {leftOut(data.excluded)}
          {/* Said out loud because it is a judgement rather than a lookup, and
              the reader is the one who can tell us if it has the class wrong */}
          {data.poolRule === 'class' && (
            <> Your league runs its own school competitions, so the class is read
              from school year — seniors and college upperclassmen.</>
          )}
        </span>
      </div>

      {staticSite ? (
        <p className="muted hint-line">
          This copy of the site was saved with the best {shown.length.toLocaleString()} of the class.
          Open the app itself to search and sort all {data.total.toLocaleString()}.
        </p>
      ) : (
        <div className="draft-filters">
          <input
            className="trade-search"
            placeholder="Search by name…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select value={group} onChange={(e) => setGroup(e.target.value as typeof group)} aria-label="Position group">
            <option value="all">All positions</option>
            <option value="C">Catchers{count(data.pool?.positions.C)}</option>
            <option value="IF">Infielders{count(data.pool?.positions.IF)}</option>
            <option value="OF">Outfielders{count(data.pool?.positions.OF)}</option>
            <option value="P">Pitchers{count(data.pool?.positions.P)}</option>
          </select>
          <select value={school} onChange={(e) => setSchool(e.target.value as typeof school)} aria-label="School">
            <option value="all">HS and college</option>
            <option value="HS">High school{count(data.pool?.school.HS)}</option>
            <option value="College">College{count(data.pool?.school.College)}</option>
          </select>
          <label className="muted">
            Age ≤{' '}
            <input
              type="number" min={16} max={30} value={maxAge}
              onChange={(e) => setMaxAge(Number(e.target.value) || 30)}
            />
          </label>
          <label className="muted">
            Ceiling ≥{' '}
            <input
              type="number" min={0} max={80} step={5} value={minPot}
              onChange={(e) => setMinPot(Number(e.target.value) || 0)}
            />
          </label>
          {(q || group !== 'all' || school !== 'all' || maxAge !== 30 || minPot !== 0) && (
            <button
              className="link-button"
              onClick={() => { setQ(''); setGroup('all'); setSchool('all'); setMaxAge(30); setMinPot(0); }}
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      {poolError && <div className="banner error">{poolError}</div>}

      <p className="muted hint-line">
        {matched === data.total
          ? `Showing ${shown.length} of ${data.total}.`
          : `${matched} match — showing ${shown.length}.`}{' '}
        {searching ? 'Searching…' : staticSite ? '' : 'Click a column to sort.'}
      </p>

      <table>
        <thead>
          <tr>
            <th onClick={() => setSort('boardRank')}>Rk{arrow('boardRank')}</th>
            <th onClick={() => setSort('name')}>Player{arrow('name')}</th>
            <th onClick={() => setSort('age')}>Age{arrow('age')}</th>
            <Th
              tip={`Years until he reaches ${data.minDraftAge ?? 17}, the age this board takes as the minimum for the draft. OOTP's pool lists younger amateurs too; the ranking does not use this.`}
            >
              Eligible in
            </Th>
            <th onClick={() => setSort('pos')}>Pos{arrow('pos')}</th>
            <Th>B/T</Th>
            <th onClick={() => setSort('school')}>From{arrow('school')}</th>
            <th className="num" onClick={() => setSort('cur')}>Cur{arrow('cur')}</th>
            <th className="num" onClick={() => setSort('pot')}>
              <Tip label="Pot" tip={TIP_CURPOT} />{arrow('pot')}
            </th>
            <th className="num" onClick={() => setSort('upside')}>
              <Tip
                label="Upside"
                tip="Ceiling minus current ability — how much of the projection has yet to happen. A big number is upside and risk in the same breath."
              />
              {arrow('upside')}
            </th>
            <Th>Read</Th>
          </tr>
        </thead>
        <tbody>
          {shown.map((p) => (
            <tr key={p.player_id}>
              <td className="num muted">{p.boardRank}</td>
              <td className="name"><PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
              <td>{p.age}</td>
              <td>
                {waits(p)
                  ? <span className="flag flag-hot">{waits(p)}</span>
                  : <span className="muted">now</span>}
              </td>
              <td>{p.positionName}</td>
              <td>{p.bats}/{p.throws}</td>
              <td>{p.school}</td>
              <td className="num">{formatRating(p.cur)}</td>
              <td className="num">{formatRating(p.pot)}</td>
              <td className="num">{p.upside === null ? '' : `+${p.upside}`}</td>
              <td className="muted">{p.recommendation?.label ?? ''}</td>
            </tr>
          ))}
          {shown.length === 0 && (
            <tr><td colSpan={11} className="muted">Nothing matches those filters.</td></tr>
          )}
        </tbody>
      </table>

      {!staticSite && matched > shown.length && (
        <p>
          <button disabled={loadingMore || searching} onClick={showMore}>
            {loadingMore ? 'Loading…' : `Show ${Math.min(PAGE, matched - shown.length)} more`}
          </button>
        </p>
      )}
    </div>
  );
}
