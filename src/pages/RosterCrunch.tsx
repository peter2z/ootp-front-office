import { Fragment, useEffect, useState } from 'react';
import { apiGet, getPlan, type Plan } from '../api';
import { PlayerLink } from '../playerModal';
import { buildHash } from '../route';
import { Th } from '../Th';

export interface CrunchPlayer {
  player_id: number; name: string; age: number; positionName: string; levelName: string;
  on26: boolean; on40: boolean; optionsUsed: number; rule5Protected: number; issues: string[];
  /** On the 60-day IL: still on the 40-man list, but not counted against the 40. */
  il60: boolean;
  note: string | null;
  /**
   * Rule 5, as a fact on every row: eligible is most of a farm (115 of the
   * Dodgers' 324), so it is a flag and not an issue; only a man the protect
   * gate passes carries the issue line and counts toward the chip.
   */
  rule5: { eligible: boolean; protectRecommended: boolean };
}
export interface CrunchData {
  counts: { active: number; fortyMan: number; issues: number; il60: number; rule5Eligible: number };
  issues: CrunchPlayer[];
  fortyMan: CrunchPlayer[];
  /** Every Rule 5 eligible man, the ones worth a 40-man place first. */
  rule5Eligible: CrunchPlayer[];
}

/** The out-of-options line is a heads-up about a future move, not a limit being broken today. */
const isHeadsUp = (issue: string) => issue.startsWith('Out of options');

/** The fact, in the plain flag style: it is not a problem until the gate says a place is worth it. */
const Rule5Flag = () => <span className="flag">Rule 5 eligible</span>;

/** How many protections the planner has open: the men it says to put on the 40-man before the Rule 5 draft. */
export function plannerProtects(plan: Pick<Plan, 'moves'>): number {
  return plan.moves.filter((m) => m.kind === 'protect' && m.decision.state === 'open').length;
}

/** Where the planner lists those protections, every horizon, so the link lands on the number it carries. */
export const PLANNER_PROTECT_HASH = buildHash('planner', { kind: 'protect', horizon: 'all' });

/**
 * The Rule 5 card. Two numbers by design: eligibility is a fact about most of
 * a farm, and the ones worth protecting are the decision. This page judges
 * that on the grade alone; the planner also reads production, so it can
 * recommend more, and the card says its figure beside this one and links to
 * the list rather than leave the two pages to disagree in silence. Without a
 * plan (it failed, or has not come back) the card says only its own figures.
 */
export function Rule5Card({ eligible, worth, protects }: { eligible: number; worth: number; protects: number | null }) {
  return (
    <div className="card">
      <span className="card-label">Rule 5 this winter</span>
      <span className="card-value">{eligible} eligible · {worth} worth a place on grade alone</span>
      {protects !== null && (
        <span className="muted">
          Grade and production together: <a href={PLANNER_PROTECT_HASH}>the planner recommends protecting {protects}</a>
        </span>
      )}
    </div>
  );
}

export function RosterCrunch({ orgId }: { orgId: number }) {
  const [data, setData] = useState<CrunchData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [protects, setProtects] = useState<number | null>(null);

  useEffect(() => {
    setData(null);
    setProtects(null);
    apiGet<CrunchData>(`/api/roster-crunch/${orgId}`).then(setData).catch((e) => setError(e.message));
    // The plan the Org Planner page reads, served from the server's cache. A
    // save it cannot run on simply leaves the planner's figure off the card
    getPlan(orgId).then((plan) => setProtects(plannerProtects(plan))).catch(() => setProtects(null));
  }, [orgId]);

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="muted">Loading roster status…</p>;
  return <RosterCrunchView data={data} protects={protects} />;
}

/**
 * The page drawn from what the server sent, apart from the fetching, so a
 * test can render it from the route's own answer and read the markup.
 */
export function RosterCrunchView({ data, protects }: { data: CrunchData; protects: number | null }) {
  // An export made before the flag existed has neither the list nor the count
  const exposed = data.rule5Eligible ?? [];
  const eligibleCount = data.counts.rule5Eligible ?? exposed.length;
  const worthAPlace = exposed.filter((p) => p.rule5?.protectRecommended).length;

  return (
    <div>
      <div className="cards">
        <div className="card">
          <span className="card-label">Active roster</span>
          <span className="card-value">{data.counts.active}/26</span>
        </div>
        <div className="card">
          <span className="card-label">40-man</span>
          {/* Full is not a problem; over is. Men on the 60-day IL do not count, and the card says how many. */}
          <span className={`card-value ${data.counts.fortyMan > 40 ? 'bad' : ''}`}>{data.counts.fortyMan}/40</span>
          {data.counts.il60 > 0 && (
            <span className="muted">+{data.counts.il60} on the 60-day IL, not counted</span>
          )}
        </div>
        <div className="card">
          <span className="card-label">Needs attention</span>
          <span className={`card-value ${data.counts.issues > 0 ? 'bad' : 'good'}`}>{data.counts.issues}</span>
        </div>
        <Rule5Card eligible={eligibleCount} worth={worthAPlace} protects={protects} />
      </div>

      {data.issues.length > 0 && (
        <>
          <h2>⚠ Needs Attention</h2>
          <table>
            <thead>
              <tr><Th>Player</Th><Th>Pos</Th><Th>Age</Th><Th>Level</Th><Th>Issues</Th></tr>
            </thead>
            <tbody>
              {data.issues.map((p) => (
                <tr key={p.player_id}>
                  <td className="name"><PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
                  <td>{p.positionName}</td>
                  <td>{p.age}</td>
                  <td><span className="level-tag">{p.levelName}</span></td>
                  {/* A space between chips, so copied or read-aloud text does not run the issues together */}
                  <td>
                    {p.issues.map((i, n) => (
                      <Fragment key={i}>
                        {n > 0 && ' '}
                        <span className={isHeadsUp(i) ? 'flag' : 'flag flag-hot'}>{i}</span>
                      </Fragment>
                    ))}
                    {/* The same space before this chip as between the issues */}
                    {p.rule5?.eligible && (<>{p.issues.length > 0 && ' '}<Rule5Flag /></>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {exposed.length > 0 && (
        <>
          <h2>Rule 5 eligible</h2>
          <p className="muted hint-line">
            Not on the 40-man and past their protection: any club may take them in the draft. The ones
            worth a place lead the list; the rest are listed so the fact is in view, not because each
            needs a decision.
          </p>
          <table>
            <thead>
              <tr><Th>Player</Th><Th>Pos</Th><Th>Age</Th><Th>Level</Th><Th>Status</Th></tr>
            </thead>
            <tbody>
              {exposed.map((p) => (
                <tr key={p.player_id}>
                  <td className="name"><PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
                  <td>{p.positionName}</td>
                  <td>{p.age}</td>
                  <td><span className="level-tag">{p.levelName}</span></td>
                  <td>
                    <Rule5Flag />
                    {p.rule5.protectRecommended && (<>{' '}<span className="flag flag-hot">Rule 5: worth a 40-man place</span></>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h2>40-Man Roster</h2>
      <table>
        <thead>
          <tr><Th>Player</Th><Th>Pos</Th><Th>Age</Th><Th>Level</Th><Th>Status</Th><Th>Options used</Th></tr>
        </thead>
        <tbody>
          {data.fortyMan.map((p) => (
            <tr key={p.player_id}>
              <td className="name"><PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
              <td>{p.positionName}</td>
              <td>{p.age}</td>
              <td><span className="level-tag">{p.levelName}</span></td>
              <td>{p.on26 ? <span className="badge promote">Active</span> : <span className="flag">{p.note ?? '40-man'}</span>}</td>
              <td className="num">{p.optionsUsed}/3</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
