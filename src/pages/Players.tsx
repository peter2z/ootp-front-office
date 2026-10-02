import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { apiGet, type Org } from '../api';
import { PlayerLink, Tip } from '../playerModal';
import { ColumnPicker } from '../ColumnPicker';
import { define } from '../glossary';
import {
  DEFAULT_BATTING, DEFAULT_PITCHING, findStat, formatStat, loadColumns, plusColor, saveColumns,
  type StatGroup,
} from '../stats';
import { Th } from '../Th';

interface LeaguePlayer {
  player_id: number;
  name: string;
  age: number;
  positionName: string;
  bats: string;
  throws: string;
  team: string | null;
  abbr: string | null;
  levelName: string | null;
  stats: Record<string, number | null> | null;
}
interface PlayersResponse {
  total: number;
  offset: number;
  limit: number;
  players: LeaguePlayer[];
}

const LEVELS: Array<[string, string]> = [
  ['1', 'MLB'], ['2', 'AAA'], ['3', 'AA'], ['4', 'A'], ['6', 'Rookie'], ['all', 'All levels'],
];
const POSITIONS: Array<[string, string]> = [
  ['2', 'C'], ['3', '1B'], ['4', '2B'], ['5', '3B'], ['6', 'SS'],
  ['7', 'LF'], ['8', 'CF'], ['9', 'RF'], ['10', 'DH'],
];
const ROLES: Array<[string, string]> = [['11', 'Starter'], ['12', 'Reliever'], ['13', 'Closer']];
const HANDS: Array<[string, string]> = [['1', 'Right'], ['2', 'Left']];
const PAGE = 100;

/** Everything narrowing the list, so it can be cleared and counted as a set. */
interface Filters {
  position: string;
  role: string;
  bats: string;
  throws: string;
  minAge: string;
  maxAge: string;
  minPt: string;
}
const NO_FILTERS: Filters = {
  position: '', role: '', bats: '', throws: '', minAge: '', maxAge: '', minPt: '',
};

/**
 * One row of the table.
 *
 * Its own memoised component so that asking for another hundred players draws
 * the hundred, and not the six hundred already on the screen as well: the rows
 * a reader has been given are the same objects after the next page arrives, so
 * nothing about them has changed and React need not look at them again.
 */
const PlayerRow = memo(function PlayerRow({ p, group, columns }: {
  p: LeaguePlayer; group: StatGroup; columns: string[];
}) {
  return (
    <tr>
      <td className="name"><PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
      <td>{p.age}</td>
      <td>{p.positionName}</td>
      <td>{p.bats}/{p.throws}</td>
      <td>
        {p.levelName && <span className="level-tag">{p.levelName}</span>} {p.team ?? '—'}
      </td>
      {columns.map((key) => {
        const def = findStat(group, key);
        if (!def) return null;
        const value = p.stats?.[key] ?? null;
        return (
          <td key={key} className="num" style={{ color: plusColor(def, value) }}>
            {p.stats ? formatStat(def, value, p.stats) : ''}
          </td>
        );
      })}
    </tr>
  );
});

export function Players({ orgs, orgId }: { orgs: Org[]; orgId: number }) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [level, setLevel] = useState('1');
  const [scope, setScope] = useState<'league' | 'org' | 'fa'>('league');
  const [group, setGroup] = useState<StatGroup>('batting');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);

  /*
   * Which column the table is ordered by, and which way.
   *
   * Held here and sent to the server rather than sorting what arrived: a
   * typical search matches a few hundred players and a hundred come back, so
   * sorting in the browser would order the page instead of the league and the
   * leader in a category could sit on page three.
   */
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);
  /*
   * What has been loaded of this search, and how much of it there is.
   *
   * A hundred rows are asked for and a hundred are held. The rest stay on the
   * server until the reader asks for another hundred, so the table is as
   * heavy as what has been shown and no heavier, however many players match:
   * the majors alone are six hundred and seventy-eight batters, and a search
   * across every level is nearly five thousand. `total` is the whole match,
   * from the server, and is null until the first page has arrived.
   */
  const [rows, setRows] = useState<LeaguePlayer[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [battingCols, setBattingCols] = useState(() => loadColumns('batting'));
  const [pitchingCols, setPitchingCols] = useState(() => loadColumns('pitching'));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce so typing a name doesn't fire a query per keystroke
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setDebounced(query), 300);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query]);

  /** Which players, in what order: the search itself, without the page cut out of it. */
  const search = useMemo(() => {
    const params = new URLSearchParams({ group });
    if (debounced.trim().length >= 2) params.set('q', debounced.trim());
    if (scope === 'fa') params.set('freeAgents', '1');
    else {
      params.set('level', level);
      if (scope === 'org') params.set('orgId', String(orgId));
    }
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    if (sort) {
      params.set('sort', sort.key);
      params.set('dir', sort.dir);
    }
    return params.toString();
  }, [debounced, level, scope, group, orgId, filters, sort]);

  /*
   * Any change to the search starts again from the top of it, which is what a
   * reader who has changed the question wants and spares every control from
   * remembering to put the page back. The generation number is how a slow
   * answer to a question already abandoned is told apart from the answer to
   * the current one, and dropped.
   */
  const generation = useRef(0);
  const asking = useRef(false);
  useEffect(() => {
    const mine = ++generation.current;
    asking.current = false;
    setRows([]);
    setTotal(null);
    setLoadingMore(false);
    setError(null);
    apiGet<PlayersResponse>(`/api/players?${search}&limit=${PAGE}&offset=0`)
      .then((r) => {
        if (generation.current !== mine) return;
        setRows(r.players);
        setTotal(r.total);
      })
      .catch((e) => {
        if (generation.current === mine) setError(e.message);
      });
  }, [search]);

  /** The next hundred, from where the loaded ones end. */
  const showMore = () => {
    // A second click before the first answer is back would ask for the same hundred twice
    if (asking.current) return;
    asking.current = true;
    const mine = generation.current;
    setLoadingMore(true);
    apiGet<PlayersResponse>(`/api/players?${search}&limit=${PAGE}&offset=${rows.length}`)
      .then((r) => {
        if (generation.current !== mine) return;
        setRows((held) => {
          // Another import between the two requests can shift the list under us
          const seen = new Set(held.map((p) => p.player_id));
          return [...held, ...r.players.filter((p) => !seen.has(p.player_id))];
        });
        setTotal(r.total);
      })
      .catch((e) => {
        if (generation.current === mine) setError(e.message);
      })
      .finally(() => {
        if (generation.current === mine) {
          asking.current = false;
          setLoadingMore(false);
        }
      });
  };

  /**
   * A header you can click to order by.
   *
   * First click takes the useful direction — highest first for a statistic,
   * A to Z for a name — because asking for the home-run column and being shown
   * the men with none of them is not what anybody meant. Clicking again turns
   * it around, and a third time returns the table to its own order.
   */
  function SortTh({ sortKey, children, tip }: {
    sortKey: string; children: ReactNode; tip?: string;
  }) {
    const active = sort?.key === sortKey;
    const textual = sortKey === 'name' || sortKey === 'team' || sortKey === 'pos';
    const cycle = () => {
      const first: 'asc' | 'desc' = textual ? 'asc' : 'desc';
      if (!active) return setSort({ key: sortKey, dir: first });
      if (sort!.dir === first) return setSort({ key: sortKey, dir: first === 'asc' ? 'desc' : 'asc' });
      return setSort(null);
    };
    /*
     * The hover explanation stays, and it is the same one Th renders.
     *
     * The first version of this replaced it with the browser's title
     * attribute, which meant every stat column silently lost the definition it
     * had — the sort arrived and the explanations left. Tip is a plain span
     * with a CSS hover, so it sits inside the button perfectly happily; the
     * glossary is consulted exactly as Th does it, so a column documented
     * there is documented here without being told twice.
     */
    const label = typeof children === 'string' ? children : null;
    const definition = tip ?? (label ? define(label) : undefined);
    // The button is the one tab stop; the tip inside it describes the button
    // rather than adding a stop of its own
    const tipId = `tip-${sortKey}`;
    const inner = (
      <>
        {definition ? <Tip label={children} tip={definition} inControl popId={tipId} /> : children}
        {active && <span className="sort-arrow">{sort!.dir === 'asc' ? '▲' : '▼'}</span>}
      </>
    );
    return (
      <th className={active ? 'sortable sorted' : 'sortable'}>
        <button type="button" onClick={cycle} aria-describedby={definition ? tipId : undefined}>{inner}</button>
      </th>
    );
  }

  const setFilter = (key: keyof Filters, value: string) => setFilters((f) => ({ ...f, [key]: value }));
  const active = Object.values(filters).filter(Boolean).length;

  const columns = group === 'batting' ? battingCols : pitchingCols;
  const setColumns = (keys: string[]) => {
    if (group === 'batting') setBattingCols(keys);
    else setPitchingCols(keys);
    saveColumns(group, keys);
  };

  const orgLabel = orgs.find((o) => o.team_id === orgId)?.label ?? 'my org';

  return (
    <div>
      {error && <div className="banner error">{error}</div>}

      <div className="toolbar players-toolbar">
        <input
          className="trade-search player-search"
          placeholder="Search players by name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="tabs">
          <button className={group === 'batting' ? 'active' : ''} onClick={() => setGroup('batting')}>
            Batters
          </button>
          <button className={group === 'pitching' ? 'active' : ''} onClick={() => setGroup('pitching')}>
            Pitchers
          </button>
        </div>
        <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} aria-label="Scope">
          <option value="league">Whole league</option>
          <option value="org">{orgLabel} only</option>
          <option value="fa">Free agents</option>
        </select>
        {scope !== 'fa' && (
          <select value={level} onChange={(e) => setLevel(e.target.value)} aria-label="Level">
            {LEVELS.map(([v, label]) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>
        )}
        {/* Position for a hitter, role for a pitcher — the same question of
            what job he does, asked the way each side of the game asks it */}
        <select
          value={group === 'pitching' ? filters.role : filters.position}
          onChange={(e) => setFilter(group === 'pitching' ? 'role' : 'position', e.target.value)}
          aria-label={group === 'pitching' ? 'Role' : 'Position'}
        >
          <option value="">Any position</option>
          {(group === 'pitching' ? ROLES : POSITIONS).map(([v, label]) => (
            <option key={v} value={v}>{label}</option>
          ))}
        </select>
        <select value={filters.bats} onChange={(e) => setFilter('bats', e.target.value)} aria-label="Bats">
          <option value="">Bats any</option>
          {HANDS.map(([v, label]) => <option key={v} value={v}>Bats {label.toLowerCase()}</option>)}
        </select>
        <select value={filters.throws} onChange={(e) => setFilter('throws', e.target.value)} aria-label="Throws">
          <option value="">Throws any</option>
          {HANDS.map(([v, label]) => <option key={v} value={v}>Throws {label.toLowerCase()}</option>)}
        </select>
        <input
          className="filter-num" type="number" min={16} max={50} placeholder="Age from"
          value={filters.minAge} onChange={(e) => setFilter('minAge', e.target.value)}
        />
        <input
          className="filter-num" type="number" min={16} max={50} placeholder="to"
          value={filters.maxAge} onChange={(e) => setFilter('maxAge', e.target.value)}
        />
        {/* Without a floor the list is mostly men with four plate appearances */}
        <input
          className="filter-num filter-pt" type="number" min={0} step={10}
          placeholder={group === 'pitching' ? 'Min outs' : 'Min PA'}
          value={filters.minPt} onChange={(e) => setFilter('minPt', e.target.value)}
        />
        {active > 0 && (
          <button onClick={() => setFilters(NO_FILTERS)}>
            Clear {active} filter{active === 1 ? '' : 's'}
          </button>
        )}
        <div className="col-picker-wrap">
          <button onClick={() => setPickerOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={pickerOpen}>
            ⚙ Columns
          </button>
          {pickerOpen && (
            <ColumnPicker
              group={group}
              selected={columns}
              onChange={setColumns}
              onClose={() => setPickerOpen(false)}
              onReset={() => setColumns(group === 'batting' ? DEFAULT_BATTING : DEFAULT_PITCHING)}
            />
          )}
        </div>
      </div>

      {total === null && !error && <p className="muted">Searching…</p>}

      {total !== null && (
        <>
          <p className="muted hint-line">
            {total.toLocaleString()} player{total === 1 ? '' : 's'} match
            {total > rows.length && ` — showing ${rows.length.toLocaleString()}`}
          </p>
          <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <SortTh sortKey="name">Player</SortTh>
                <SortTh sortKey="age">Age</SortTh>
                <SortTh sortKey="pos">Pos</SortTh>
                <Th>B/T</Th>
                <SortTh sortKey="team">Team</SortTh>
                {columns.map((key) => {
                  const def = findStat(group, key);
                  return def ? (
                    <SortTh key={key} sortKey={key} tip={def.desc}>{def.label}</SortTh>
                  ) : null;
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <PlayerRow key={p.player_id} p={p} group={group} columns={columns} />
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5 + columns.length} className="muted">
                    No {group === 'batting' ? 'batters' : 'pitchers'} match those filters.
                    {debounced.trim().length >= 2 && (
                      <>
                        {' '}Batters and pitchers are searched separately — try the{' '}
                        <button className="link-button" onClick={() => setGroup(group === 'batting' ? 'pitching' : 'batting')}>
                          {group === 'batting' ? 'Pitchers' : 'Batters'}
                        </button>{' '}
                        tab.
                      </>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>

          {total > rows.length && (
            <div className="pager">
              <button disabled={loadingMore} onClick={showMore}>
                {loadingMore ? 'Loading…' : `Show ${Math.min(PAGE, total - rows.length).toLocaleString()} more`}
              </button>
              <span className="muted">
                {rows.length.toLocaleString()} of {total.toLocaleString()}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
