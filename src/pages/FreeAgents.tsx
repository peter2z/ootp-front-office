import { useEffect, useState } from 'react';
import { getFreeAgents, type FreeAgentRow, type FreeAgentsResponse } from '../api';
import { FinanceCards, money, Pct } from './Contracts';
import { PlayerLink, Tip, TIP_TALENT, TIP_VALUE } from '../playerModal';
import { Th } from '../Th';

/**
 * Two things the server sends that the shared types in api.ts do not declare:
 * whether signing a man would patch one of the club's thin spots, and how many
 * draft-eligible amateurs it left out of the list.
 */
type Row = FreeAgentRow & { fillsHole?: boolean };
type Data = Omit<FreeAgentsResponse, 'currentFAs' | 'upcomingFAs'> & {
  currentFAs: Row[];
  upcomingFAs: Row[];
  amateursLeftOut?: number;
  rulesNote?: string;
};

const TIP_LAST_SALARY =
  'What he was paid in his last season with a club. OOTP does not export what he is asking, so this is ' +
  'a guide to the price, not the price.';

export function FreeAgents({ orgId }: { orgId: number }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [posFilter, setPosFilter] = useState<string>('');

  useEffect(() => {
    setData(null);
    getFreeAgents(orgId).then(setData).catch((e) => setError(e.message));
  }, [orgId]);

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="muted">Loading free agents…</p>;

  const positions = [...new Set(data.upcomingFAs.concat(data.currentFAs).map((p) => p.positionName))].sort();
  const filter = (rows: Row[]) => (posFilter ? rows.filter((p) => p.positionName === posFilter) : rows);
  const leftOut = data.amateursLeftOut ?? 0;

  return (
    <div>
      <FinanceCards finances={data.finances} />
      <div className="toolbar">
        <span className="muted">
          Weakest positions by best available player:{' '}
          {data.holes.slice(0, 3).map((h) => h.positionName).join(', ')}
        </span>
        <select value={posFilter} onChange={(e) => setPosFilter(e.target.value)} aria-label="Position">
          <option value="">All positions</option>
          {positions.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </div>

      <h2>Available now</h2>
      <p className="muted hint-line">
        {leftOut > 0 && (
          <>Not listed: {leftOut.toLocaleString()} draft-eligible amateurs, who cannot be signed until they
            are drafted. </>
        )}
        OOTP does not export what a free agent is asking, so last salary is a guide, not a quote.
      </p>
      {filter(data.currentFAs).length === 0 ? (
        <p className="muted">Nobody worth a look on the open market right now.</p>
      ) : (
        <FATable rows={filter(data.currentFAs)} salary="Last salary" />
      )}

      <h2>Hitting the market after this season</h2>
      {data.rulesNote ? (
        <p className="muted">{data.rulesNote}</p>
      ) : (
        <>
          <p className="muted hint-line">
            Players around the league on expiring deals with enough service time to reach free agency — your
            offseason shopping list. Team-controlled players (pre-arb/arb) are excluded.
          </p>
          <FATable rows={filter(data.upcomingFAs)} salary="Current salary" />
        </>
      )}
    </div>
  );
}

/**
 * The two lists share a table but not a meaning for the salary column: a man
 * on the market has a last salary, a man still under contract has a current one.
 */
function FATable({ rows, salary }: { rows: Row[]; salary: 'Last salary' | 'Current salary' }) {
  return (
    <table>
      <thead>
        <tr>
          <Th>Pos</Th>
          <Th>Player</Th>
          <Th>Age</Th>
          <th><Tip label="Value" tip={TIP_VALUE} /></th>
          <th><Tip label="Talent" tip={TIP_TALENT} /></th>
          <Th tip={salary === 'Last salary' ? TIP_LAST_SALARY : undefined}>{salary}</Th>
          <Th>Team</Th>
          <Th>Fit</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.player_id}>
            <td>{p.positionName}</td>
            <td className="name"><PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
            <td>{p.age}</td>
            <td className="num"><Pct value={p.overallPct} /></td>
            <td className="num"><Pct value={p.talentPct} /></td>
            <td className="num">{money(p.lastSalary)}</td>
            <td>{p.team ?? '—'}</td>
            <td>
              {p.fillsHole && (
                <span
                  className="badge promote"
                  title={`At least as good as your best ${p.positionName}, one of your three weakest positions`}
                >
                  fills hole
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
