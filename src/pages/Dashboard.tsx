import { useEffect, useState } from 'react';
import { apiGet } from '../api';
import { useJob, type JobStatus } from '../useJob';
import { FallbackNotice, type FallbackNoticeData } from '../FallbackNotice';
import { PlayerLink } from '../playerModal';
import { TeamLogo } from '../TeamLogo';
import { daysShort } from '../injury';
import { Th } from '../Th';
import { PlayerNames } from '../PlayerNames';
import type { Page, ParamsIn } from '../route';

/** Where the club stands for a place, which the division table does not say. */
interface Playoffs {
  spots: number;
  route: 'division' | 'wildcard' | 'out';
  divisionGb: number;
  wildcardGb: number | null;
  wildcardRank: number | null;
  magicNumber: number | null;
  summary: string;
}

/** Buy, hold or sell — see server/posture.ts for how it is worked out. */
interface DeadlineRead {
  posture: 'buy' | 'lean-buy' | 'hold' | 'lean-sell' | 'sell';
  odds: number;
  /** Set once the race is a result rather than a question. */
  settled?: 'in' | 'out' | null;
  /** The word on the card and the line beside it, both from the server. */
  verdict?: string;
  caption?: string;
  headline: string;
  reasons: string[];
  gamesLeft: number;
  gamesLeftKnown?: boolean;
  runDiff: number;
  daysToDeadline: number | null;
  deadlinePassed: boolean;
}

interface FormRow {
  player_id: number;
  name: string;
  positionName: string;
  pitcher?: boolean;
  pa?: number;
  ip?: number;
  avg?: number;
  ops: number;
  hr?: number;
}

/** The bracket, once the save reaches October. See server/postseason.ts. */
interface Postseason {
  active: boolean;
  currentRound: string | null;
  rounds: Array<{
    round: number;
    name: string;
    bestOf: number | null;
    series: Array<{
      home: { team_id: number; name: string; wins: number };
      away: { team_id: number; name: string; wins: number };
      bestOf: number;
      finished: boolean;
      winner: number | null;
      summary: string;
    }>;
  }>;
  champion: { team_id: number; name: string } | null;
}

interface DashboardData {
  streaks?: Array<{
    player_id: number; name: string; positionName: string; games: number; kind: string;
    since: string;
    /** His other live streak, when he has one — "6-game hitting streak". */
    also?: string | null;
  }>;
  standings: Array<{ team_id: number; team: string; w: number; l: number; gb: number; streak: number }>;
  /** Absent on a save imported before this existed. */
  playoffs?: Playoffs | null;
  /** Absent all season, and the whole story once it is not. */
  postseason?: Postseason | null;
  deadline?: DeadlineRead | null;
  recent: Array<{ date: string; opponent: string; isHome: boolean; score: string; won: boolean; innings: number }>;
  upcoming: Array<{
    /** The game itself, for the link to its plan. Absent in an export made before it was sent. */
    game_id?: number;
    date: string; isHome: boolean; opponent: string;
    ourStarter: { player_id: number; name: string; throws: string } | null;
    theirStarter: { player_id: number; name: string; throws: string } | null;
  }>;
  /**
   * Hitters and pitchers together. A pitcher's `ops` is the one he has ALLOWED,
   * so the same number means the opposite thing and the row has to say which.
   */
  hot: FormRow[];
  cold: FormRow[];
  injuries: Array<{ player_id: number; name: string; positionName: string; levelName: string; status: string; daysLeft: number | null; durationUnknown: boolean }>;
  pending: {
    expiring: number; extensionCandidates: number;
    /**
     * Farm men the page asks you to decide about: promote, blocked or demote.
     * "Watch" is not counted, which is most of what the farm page flags.
     */
    farmSignals: number;
    farmBreakdown?: { promote: number; blocked: number; demote: number };
    injuredCount: number;
    /** The length of the Needs attention list on the Roster Crunch page. */
    crunchIssues: number;
    /** Optional: a save imported before this existed has no count to show. */
    tradeTalk?: number;
    /**
     * The Org Planner's open decisions: forced, call-up, protect, demote,
     * trade, release and hold, after dismissals and the season's horizon fold.
     * Null when the planner could not run, so the chip can say so rather
     * than read as nothing to decide.
     */
    planMoves?: number | null;
    planBreakdown?: PlanBreakdown | null;
  };
}

/** What the Org moves count is made of, by kind. */
export type PlanBreakdown = Partial<Record<string, number>>;

interface Briefing {
  generatedAt?: string;
  gameDate?: string | null;
  markdown: string | null;
  /** Set when the chosen model could not be used and another answered. */
  notice?: FallbackNoticeData | null;
  job?: JobStatus;
}

/**
 * `onNavigate` opens a page, and may say what to open it on: the chips pass the
 * filter that makes the page show what the count counted.
 */
export function Dashboard({ orgId, onNavigate }: {
  orgId: number;
  onNavigate: (page: Page, params?: ParamsIn) => void;
}) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The briefing runs on the server, so this watches it rather than waits for
  // it — start one and go somewhere else
  const {
    data: briefing, error: briefingError, running: briefingBusy, start: generateBriefing,
  } = useJob<Briefing>(`/api/briefing/${orgId}`);

  useEffect(() => {
    setData(null);
    apiGet<DashboardData>(`/api/dashboard/${orgId}`).then(setData).catch((e) => setError(e.message));
  }, [orgId]);

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="muted">Loading the morning report…</p>;

  const fmt3 = (n: number) => n.toFixed(3).replace(/^0\./, '.');

  return (
    <div className="dash">
      {/* What the season says to do about it, above the things to do */}
      {data.deadline && (
        <section className={`posture posture-${data.deadline.posture}`}>
          <div className="posture-head">
            <span className="posture-verdict">
              {data.deadline.verdict ?? data.deadline.posture.replace('-', ' ')}
            </span>
            {/* A settled season has no odds to give. It reads "IN — reached the
                postseason", not "BUY 99% to reach the postseason" under a year
                that has been played out. */}
            {!data.deadline.settled && (
              <span className="posture-odds">{Math.round(data.deadline.odds * 100)}%</span>
            )}
            <span className="muted">{data.deadline.caption ?? 'to reach the postseason'}</span>
          </div>
          <ul className="posture-why">
            {data.deadline.reasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </section>
      )}
      {/* October. Above the decisions, because in October it is the only thing
          on the page anybody is reading. */}
      {data.postseason && (
        <section className="postseason">
          <div className="postseason-head">
            <h2>
              {data.postseason.champion
                ? `${data.postseason.champion.name} — champions`
                : (data.postseason.currentRound ?? 'Postseason')}
            </h2>
            {data.postseason.active && <span className="muted">now playing</span>}
          </div>
          <div className="postseason-rounds">
            {data.postseason.rounds.map((round) => (
              <div key={round.round} className="postseason-round">
                <h3>
                  {round.name}
                  {round.bestOf ? <span className="muted"> · best of {round.bestOf}</span> : null}
                </h3>
                {round.series.map((s, i) => (
                  <div key={i} className={s.finished ? 'series done' : 'series'}>
                    <span className="series-teams">
                      {s.away.name} at {s.home.name}
                    </span>
                    <span className="series-line">{s.summary}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* A chip opens its page already filtered to what it counted, so the number
          here and the rows there can be checked against each other. The farm
          one is the three signals that ask for a call; the contract ones are
          the same two tests the server counts them with. The other three open
          pages that lead with the very list they count, so they carry nothing. */}
      <div className="dash-decisions">
        <DecisionChip
          label="Expiring contracts"
          count={data.pending.expiring}
          onClick={() => onNavigate('contracts', { flag: 'expiring' })}
        />
        <DecisionChip
          label="Extension candidates"
          count={data.pending.extensionCandidates}
          onClick={() => onNavigate('contracts', { action: 'extension' })}
        />
        <DecisionChip
          label="Farm signals"
          count={data.pending.farmSignals}
          title={farmBreakdownTitle(data.pending.farmBreakdown)}
          onClick={() => onNavigate('prospects', { signal: 'decision' })}
        />
        {/* The open moves of the decision kinds, so it opens the page on them;
            the page's own horizon and Open filter are the chip's fold */}
        <DecisionChip
          label="Org moves"
          count={data.pending.planMoves ?? null}
          title={data.pending.planMoves == null ? PLANNER_FAILED : planBreakdownTitle(data.pending.planBreakdown ?? undefined)}
          onClick={() => onNavigate('planner', { kind: 'decision' })}
        />
        <DecisionChip label="Trade talk" count={data.pending.tradeTalk ?? 0} onClick={() => onNavigate('trades')} />
        <DecisionChip label="Roster issues" count={data.pending.crunchIssues} onClick={() => onNavigate('crunch')} />
        <DecisionChip label="Injured org-wide" count={data.pending.injuredCount} onClick={() => onNavigate('injuries')} />
      </div>

      <div className="dash-grid">
        <section className="dash-panel">
          <h3>Division</h3>
          <table className="mini">
            <thead>
              <tr><th></th><Th>W</Th><Th>L</Th><Th>GB</Th></tr>
            </thead>
            <tbody>
              {data.standings.map((s) => (
                <tr key={s.team_id} className={s.team_id === orgId ? 'row-us' : ''}>
                  <td className="standings-team">
                    <TeamLogo teamId={s.team_id} size={40} className="logo-sm" />
                    {s.team}
                  </td>
                  <td className="num">{s.w}</td>
                  <td className="num">{s.l}</td>
                  <td className="num">{s.gb > 0 ? s.gb : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* Eleven of fifteen clubs in a division are not going to win it,
              and the race they are in is the one this line describes */}
          {data.playoffs && (
            <p className={`playoff-line ${data.playoffs.route}`}>
              {data.playoffs.route === 'division' && '◆ '}
              {data.playoffs.route === 'wildcard' && '● '}
              {data.playoffs.summary}
            </p>
          )}
        </section>

        <section className="dash-panel">
          <h3>Last 5</h3>
          <table className="mini">
            <tbody>
              {data.recent.map((g, i) => (
                <tr key={i}>
                  <td>{g.date.slice(5)}</td>
                  <td>{g.isHome ? 'vs' : '@'} {g.opponent}</td>
                  <td className={`num ${g.won ? 'good-text' : 'bad-text'}`}>
                    {g.won ? 'W' : 'L'} {g.score}
                    {g.innings > 9 ? ` (${g.innings})` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="dash-panel">
          <h3>Up Next</h3>
          <UpNext games={data.upcoming} onNavigate={onNavigate} />
        </section>

        <section className="dash-panel">
          <h3>🔥 Hot / 🧊 Cold (last 7 games)</h3>
          <table className="mini">
            <tbody>
              {[...data.hot.map((p) => ({ p, mark: '🔥' })), ...data.cold.map((p) => ({ p, mark: '🧊' }))].map(
                ({ p, mark }) => (
                  <tr key={`${mark}${p.player_id}`}>
                    <td>{mark} <PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
                    <td className="muted">{p.positionName}</td>
                    {/*
                      A pitcher's number is what he ALLOWED, so it is labelled
                      rather than left to look like a batting line — .200 is a
                      fine week for him and a dreadful one for a hitter.
                    */}
                    <td className="num">
                      {p.pitcher
                        ? `${p.ip} IP · ${fmt3(p.ops)} OPS against`
                        : `${fmt3(p.avg ?? 0)} avg · ${fmt3(p.ops)} OPS${(p.hr ?? 0) > 0 ? ` · ${p.hr} HR` : ''}`}
                    </td>
                  </tr>
                )
              )}
              {data.hot.length + data.cold.length === 0 && (
                <tr><td className="muted">Not enough recent games yet.</td></tr>
              )}
            </tbody>
          </table>
          {/* OOTP's own tracked streaks, which run longer than a 7-game window */}
          {(data.streaks?.length ?? 0) > 0 && (
            <div className="streak-strip">
              {(data.streaks ?? []).map((s) => (
                <span key={s.player_id} className="streak-chip">
                  <PlayerLink id={s.player_id}>{s.name}</PlayerLink>
                  <strong>{s.games}</strong>
                  <span className="muted">
                    game {s.kind}
                    {/* A man on a run is usually on both at once; saying so
                        beats giving him two of the six places */}
                    {s.also && <> · {s.also}</>}
                  </span>
                </span>
              ))}
            </div>
          )}
        </section>

        <section className="dash-panel">
          <h3>Injuries</h3>
          <table className="mini">
            <tbody>
              {data.injuries.map((p) => (
                <tr key={p.player_id}>
                  <td><PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
                  <td><span className="level-tag">{p.levelName}</span> {p.positionName}</td>
                  <td className="num">{p.status}{daysShort(p) && ` · ${daysShort(p)}`}</td>
                </tr>
              ))}
              {data.injuries.length === 0 && <tr><td className="muted">Fully healthy. Knock on wood.</td></tr>}
            </tbody>
          </table>
        </section>

        <section className="dash-panel dash-briefing">
          <div className="briefing-head">
            <h3>GM Briefing</h3>
            <button onClick={() => void generateBriefing()} disabled={briefingBusy}>
              {briefingBusy ? 'Writing…' : briefing?.markdown ? '↻ New briefing' : '✍ Generate'}
            </button>
          </div>
          {briefingError && <div className="banner error">{briefingError}</div>}
          {briefing?.notice && <FallbackNotice notice={briefing.notice} />}
          {/* It keeps writing whether or not you stay on this page, so the
              previous briefing stays readable while the new one is made */}
          {briefingBusy && (
            <p className="muted">
              Writing in the background — leave this page if you like, it will be here when you
              come back.
            </p>
          )}
          {briefing?.markdown ? (
            <>
              <div className="briefing-body">
                <PlayerNames orgId={orgId}>{renderMarkdown(briefing.markdown)}</PlayerNames>
              </div>
              <span className="muted">
                As of {briefing.gameDate}
                {briefing.generatedAt && ` · ${new Date(briefing.generatedAt).toLocaleString()}`}
              </span>
            </>
          ) : (
            !briefingBusy && (
              <p className="muted">
                An AI assistant-GM digest of standings, injuries, prospects, and looming decisions. Regenerate after
                each sim session.
              </p>
            )
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * The next few games, each with a way into the plan for it.
 *
 * The plan (their starter, how our hitters have done against him, who to be
 * careful with) was reachable only from the Schedule, by finding the game in a
 * list of a hundred and sixty. These five rows are the games a manager opens it
 * for, so each says "Plan" and opens the Schedule on that game with the plan
 * already up.
 */
export function UpNext({ games, onNavigate }: {
  games: DashboardData['upcoming'];
  onNavigate: (page: Page, params?: ParamsIn) => void;
}) {
  // An export made before the games carried their id has nothing to open, and
  // an empty column of links would only take room from the starters
  const linked = games.some((g) => g.game_id !== undefined);
  return (
    <table className="mini">
      <tbody>
        {games.map((g, i) => (
          <tr key={i}>
            <td>{g.date.slice(5)}</td>
            <td>{g.isHome ? 'vs' : '@'} {g.opponent}</td>
            {/* Two full names and a hand fit no fixed width, and the
                cell was running out past the edge of the panel */}
            <td className="muted wrap-cell">
              {g.ourStarter && <PlayerLink id={g.ourStarter.player_id}>{g.ourStarter.name}</PlayerLink>}
              {g.theirStarter && (
                <>
                  {' '}v <PlayerLink id={g.theirStarter.player_id}>{g.theirStarter.name}</PlayerLink> ({g.theirStarter.throws}HP)
                </>
              )}
            </td>
            {linked && (
              <td className="series-plan">
                {g.game_id !== undefined && (
                  <button
                    type="button"
                    className="link-button"
                    title="Open the game plan for this game"
                    aria-label={`Plan for ${g.date.slice(5)} ${g.isHome ? 'vs' : '@'} ${g.opponent}`}
                    onClick={() => onNavigate('schedule', { game: g.game_id })}
                  >
                    Plan
                  </button>
                )}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * What the farm count is made of, for the chip's hover text: "0 promote · 17
 * blocked · 2 demote". The page it opens lists the men marked watch as well, so
 * without this the two numbers read as a disagreement.
 */
export function farmBreakdownTitle(
  b: { promote: number; blocked: number; demote: number } | undefined
): string | undefined {
  return b ? `${b.promote} promote · ${b.blocked} blocked · ${b.demote} demote` : undefined;
}

/**
 * What the Org moves count is made of, for the chip's hover text: "2 forced ·
 * 3 protect · 1 trade". Only the kinds with men in them, in the planner's own
 * order, so the text says what the page will show first. Undefined when the
 * planner sent nothing or counted nobody, so the chip gets no empty title.
 */
export function planBreakdownTitle(b: PlanBreakdown | undefined): string | undefined {
  if (!b) return undefined;
  const parts = ['forced', 'callup', 'protect', 'demote', 'trade', 'release', 'hold']
    .filter((kind) => (b[kind] ?? 0) > 0)
    .map((kind) => `${b[kind]} ${kind === 'callup' ? 'call-up' : kind}`);
  return parts.length ? parts.join(' · ') : undefined;
}

/** The Org moves chip's hover text when there is no count to give. */
export const PLANNER_FAILED = 'The planner could not run on this save, so there is no count; the Org Planner page says why.';

/**
 * One count and the page it opens. A null count is one that could not be
 * worked out: it reads "—", never 0, which would say there is nothing to do.
 */
export function DecisionChip({
  label, count, onClick, title,
}: { label: string; count: number | null; onClick: () => void; title?: string }) {
  return (
    <button className={`decision-chip ${count !== null && count > 0 ? 'has-items' : ''}`} onClick={onClick} title={title}>
      <span className="decision-count">{count ?? '—'}</span>
      <span>{label}</span>
    </button>
  );
}

/** Tiny renderer for the briefing's simple markdown (## headers, **bold**, lists). */
function renderMarkdown(md: string) {
  return md.split('\n').map((line, i) => {
    if (line.startsWith('## ')) return <h4 key={i}>{line.slice(3)}</h4>;
    if (line.startsWith('# ')) return <h4 key={i}>{line.slice(2)}</h4>;
    if (line.trim() === '') return null;
    const parts = line.split(/\*\*(.+?)\*\*/g).map((seg, j) => (j % 2 === 1 ? <strong key={j}>{seg}</strong> : seg));
    if (line.startsWith('- ') || line.startsWith('* ')) {
      return <li key={i}>{line.slice(2).split(/\*\*(.+?)\*\*/g).map((seg, j) => (j % 2 === 1 ? <strong key={j}>{seg}</strong> : seg))}</li>;
    }
    return <p key={i}>{parts}</p>;
  });
}
