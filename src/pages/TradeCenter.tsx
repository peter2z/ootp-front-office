import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, getOrgs, type Org } from '../api';
import { FallbackNotice, type FallbackNoticeData } from '../FallbackNotice';
import { formatMoney, ordinal } from '../stats';
import { PlayerLink } from '../playerModal';
import { MethodNote } from '../MethodNote';

interface FitPlayer { player_id: number; name: string; value: number; age: number; positionName: string }
interface Fits {
  myWeakest: Array<{ positionName: string; bestValue: number }>;
  mySurplus: Array<{ positionName: string; players: FitPlayer[] }>;
  fits: Array<{
    orgId: number; label: string; score: number;
    theyNeed: Array<{ positionName: string; myCandidates: FitPlayer[] }>;
    theyOffer: Array<{ positionName: string; players: FitPlayer[] }>;
  }>;
}
interface SearchResult { player_id: number; name: string; age: number; positionName: string; team: string; value: number }
/** A man on a club's books, as /api/trade/roster lists him. */
interface RosterPlayer extends SearchResult { levelName: string }
interface SideSummary {
  players: Array<{
    player_id: number; name: string; age: number; positionName: string; team: string | null;
    overallPct: number | null; talentPct: number | null; salaryNow: number; yearsAfterThis: number;
    value: number; surplus: number;
  }>;
  totalValue: number; totalTalent: number; totalSalary: number;
  bestPct: number | null; bestName: string | null; surplus: number;
}
/** Which side gives up more surplus over replacement. Side A is always yours. */
type Verdict = 'even' | 'sideA' | 'sideB';
type Warning = 'quantity-for-quality' | null;
interface Analysis {
  sideA: SideSummary; sideB: SideSummary;
  valueDiff: number; talentDiff: number; salaryDiff: number;
  surplusDiff: number; verdict: Verdict; warning: Warning;
}
interface ProposalSide {
  players: Array<{ player_id: number; name: string; age: number; positionName: string; team: string | null }>;
  totalValue: number;
  totalSalary: number;
  surplus: number;
}
interface Proposal {
  message_id: number;
  trade_id: number;
  subject: string;
  date: string | null;
  from: { team_id: number; label: string };
  theySend: ProposalSide;
  weSend: ProposalSide;
  valueDiff: number;
  salaryDiff: number;
  surplusDiff: number;
  verdict: Verdict;
  warning: Warning;
}

interface TalkItem {
  message_id: number;
  subject: string;
  date: string;
  otherTeam: { orgId: number; label: string };
  player: {
    player_id: number; name: string; age: number; positionName: string; levelName: string;
    overallPct: number | null; talentPct: number | null; salaryNow: number; yearsAfterThis: number;
  };
}

interface Voice {
  name: string;
  role: string;
}

/** Sent when the chosen model could not be used and another answered. */
type Notice = FallbackNoticeData | null;

interface TradeTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** A percentile as it is said aloud, or a dash for a man with no reading. */
const pct = (n: number | null): string => (n === null ? '—' : ordinal(n));

/**
 * The verdict is the only figure coloured. The summed value beside it is not a
 * verdict at all — every extra body adds to a sum, which is how a throw-in once
 * beat a star — so it is shown plainly and judged by nobody.
 */
const VERDICT: Record<Verdict, { text: string; offer: string; tone?: 'good' | 'bad' }> = {
  sideA: { text: 'You give up more', offer: 'You give up more surplus', tone: 'bad' },
  sideB: { text: 'They give up more', offer: 'They give up more surplus', tone: 'good' },
  even: { text: 'Even', offer: 'Even on surplus' },
};

/**
 * Said when the bigger surplus is made of lesser players. Depth needs roster
 * places a club may not have, and the best man in the deal is usually the one
 * who decides it.
 */
function qualityNote(a: { sideA: SideSummary; sideB: SideSummary }): string {
  const better = a.sideA.surplus > a.sideB.surplus ? a.sideB : a.sideA;
  return (
    'Quantity for quality: the bigger surplus is spread over lesser players, and the best ' +
    `player in the deal is ${better.bestName ?? 'on the other side'} (${pct(better.bestPct)}).`
  );
}

/** Shown when the desk sends back nothing at all, rather than an empty box. */
const NO_ANSWER =
  'No answer came back. The desk may have run out of lookups before it finished — ask again, ' +
  'or narrow the question.';

/** How a fit is made, and the line shown while the note about the fits is folded. */
const FIT_RULE = 'Matches below need what you have, or have what you need.';

/**
 * The deal and the conversation about it, kept for the browser tab.
 *
 * Leaving the page used to throw the conversation away: a verdict, three
 * follow-ups and the deal they were about, gone on a trip to the Lineup page
 * to check something the GM had said. Session storage is the right length of
 * memory for it — the deal belongs to this sitting, and a new one starts with
 * a clean desk. Keyed by club, so one club's deal never appears under
 * another's name.
 */
interface SavedDesk {
  sideA: SearchResult[];
  sideB: SearchResult[];
  clubB: number | null;
  thread: TradeTurn[];
  /** Whether the comparison was on screen; it is priced again rather than stored stale. */
  compared: boolean;
}

const deskKey = (orgId: number) => `ootp-trade-desk-${orgId}`;

function listOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function loadDesk(orgId: number): SavedDesk | null {
  try {
    const raw = sessionStorage.getItem(deskKey(orgId));
    if (!raw) return null;
    const saved = JSON.parse(raw) as Partial<SavedDesk>;
    return {
      sideA: listOf<SearchResult>(saved.sideA),
      sideB: listOf<SearchResult>(saved.sideB),
      clubB: typeof saved.clubB === 'number' ? saved.clubB : null,
      thread: listOf<TradeTurn>(saved.thread).filter(
        (t) => (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string'
      ),
      compared: saved.compared === true,
    };
  } catch {
    // Storage that is switched off or holds something unreadable costs the memory, not the page
    return null;
  }
}

function saveDesk(orgId: number, desk: SavedDesk): void {
  try {
    sessionStorage.setItem(deskKey(orgId), JSON.stringify(desk));
  } catch {
    // A full or disabled store loses the memory and nothing else
  }
}

export function TradeCenter({ orgId, orgLabel }: { orgId: number; orgLabel: string }) {
  // What this tab last left on the desk for this club, read once on the way in
  const [restored] = useState(() => loadDesk(orgId));
  /** Whose deal is on screen: it lags orgId for one render when the club is switched. */
  const [deskOrg, setDeskOrg] = useState(orgId);
  const [fits, setFits] = useState<Fits | null>(null);
  const [sideA, setSideA] = useState<SearchResult[]>(restored?.sideA ?? []);
  const [sideB, setSideB] = useState<SearchResult[]>(restored?.sideB ?? []);
  /** The club the other side's roster list is showing. */
  const [clubB, setClubB] = useState<number | null>(restored?.clubB ?? null);
  const [clubs, setClubs] = useState<Org[]>([]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  // The conversation about the deal on screen, held here rather than on the
  // server: it belongs to these two lists of players, and they change with
  // every click
  const [thread, setThread] = useState<TradeTurn[]>(restored?.thread ?? []);
  const [voice, setVoice] = useState<Voice | null>(null);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [talk, setTalk] = useState<TalkItem[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const builderRef = useRef<HTMLDivElement | null>(null);
  /** The club the page is on now, so an answer that arrives after a switch lands on its own desk. */
  const orgRef = useRef(orgId);
  const mounted = useRef(true);

  useEffect(() => {
    orgRef.current = orgId;
  }, [orgId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    // Who answers, so the button can carry his name before he has said anything
    setVoice(null);
    apiGet<Voice>(`/api/trade/voice/${orgId}`).then(setVoice).catch(() => setVoice(null));
  }, [orgId]);

  useEffect(() => {
    // The clubs a roster can be picked from; without them the search box still works
    getOrgs().then(setClubs).catch(() => setClubs([]));
  }, []);

  useEffect(() => {
    setFits(null);
    apiGet<Fits>(`/api/trade/fits/${orgId}`).then(setFits).catch((e) => setError(e.message));
  }, [orgId]);

  useEffect(() => {
    setProposals([]);
    apiGet<{ proposals: Proposal[] }>(`/api/trade-proposals/${orgId}`)
      .then((r) => setProposals(r.proposals))
      .catch(() => setProposals([]));
  }, [orgId]);

  useEffect(() => {
    setTalk([]);
    apiGet<{ items: TalkItem[] }>(`/api/trade-talk/${orgId}`)
      .then((r) => setTalk(r.items))
      // The inbox is a bonus on top of the analyser, so a save without it
      // should cost the page nothing
      .catch(() => setTalk([]));
  }, [orgId]);

  /** Prices the deal without touching the conversation about it. */
  const compare = async (a: SearchResult[], b: SearchResult[]) => {
    const forOrg = orgId;
    try {
      const r = await apiPost<Analysis>('/api/trade/analyze', {
        sideA: a.map((p) => p.player_id),
        sideB: b.map((p) => p.player_id),
      });
      if (orgRef.current === forOrg) setAnalysis(r);
    } catch (e) {
      if (orgRef.current === forOrg) setError((e as Error).message);
    }
  };

  useEffect(() => {
    // Coming back to a deal that had been compared shows the comparison again
    if (restored?.compared && restored.sideA.length > 0 && restored.sideB.length > 0) {
      void compare(restored.sideA, restored.sideB);
    }
  }, []);

  useEffect(() => {
    if (deskOrg === orgId) return;
    // Another club's desk: its own deal and conversation, or a clean one
    const next = loadDesk(orgId);
    setSideA(next?.sideA ?? []);
    setSideB(next?.sideB ?? []);
    setClubB(next?.clubB ?? null);
    setThread(next?.thread ?? []);
    setAnalysis(null);
    setDraft('');
    setNotice(null);
    setDeskOrg(orgId);
    if (next?.compared && next.sideA.length > 0 && next.sideB.length > 0) {
      void compare(next.sideA, next.sideB);
    }
  }, [orgId, deskOrg]);

  useEffect(() => {
    // Until the switch above has run, what is on screen is still the last club's deal
    if (deskOrg !== orgId) return;
    saveDesk(orgId, { sideA, sideB, clubB, thread, compared: analysis !== null });
  }, [orgId, deskOrg, sideA, sideB, clubB, thread, analysis]);

  /**
   * Lands an answer from the desk. One that arrives after the page has been
   * left, or after a switch to another club, is written to its own club's
   * desk instead, so it is there on the way back.
   */
  const land = (forOrg: number, next: TradeTurn[]) => {
    if (mounted.current && orgRef.current === forOrg) {
      setThread(next);
      return;
    }
    const saved = loadDesk(forOrg);
    if (saved) saveDesk(forOrg, { ...saved, thread: next });
  };

  /** Puts a deal on the builder and takes the user to it. */
  const startDeal = (a: SearchResult[] | null, b: SearchResult[], partner: number | null) => {
    setAnalysis(null);
    setThread([]);
    setDraft('');
    if (a !== null) setSideA(a);
    setSideB(b);
    // Their roster list opens on the club the deal is with
    if (partner !== null) setClubB(partner);
    // After the paint, not before it: loading the player re-renders the builder,
    // and a scroll begun in the same tick is cancelled by the layout change.
    // Instant rather than smooth — smooth silently does nothing in some
    // embedded browsers, and a jump that sometimes fails to happen is worse
    // than one that always does.
    requestAnimationFrame(() =>
      builderRef.current?.scrollIntoView({ behavior: 'auto', block: 'start' })
    );
  };

  /** Loads a real offer into the builder, both sides as they were proposed. */
  const reviewProposal = (p: Proposal) => {
    const toRow = (x: ProposalSide['players'][number], team: string | null) => ({
      player_id: x.player_id,
      name: x.name,
      age: x.age,
      positionName: x.positionName,
      team: x.team ?? team ?? '',
      value: 0,
    });
    startDeal(
      p.weSend.players.map((x) => toRow(x, orgLabel)),
      p.theySend.players.map((x) => toRow(x, p.from.label)),
      p.from.team_id
    );
  };

  /**
   * Load a suggested target into the builder and take the user to it.
   *
   * A staff note only names the man you would receive — what he costs is the
   * open question, so the other side is left empty for you to fill in. An
   * actual offer is different and goes through reviewProposal above, which
   * carries both sides.
   */
  const review = (item: TalkItem) => {
    startDeal(
      null,
      [{
        player_id: item.player.player_id,
        name: item.player.name,
        age: item.player.age,
        positionName: item.player.positionName,
        team: item.otherTeam.label,
        value: 0,
      }],
      item.otherTeam.orgId
    );
  };

  /**
   * A fit card's deal, ready to price. The first man named on each line goes
   * in: the others on that line are alternatives to him, not extras.
   */
  const loadFit = (f: Fits['fits'][number]) => {
    const row = (p: FitPlayer, team: string): SearchResult => ({ ...p, team });
    startDeal(
      f.theyNeed.map((n) => row(n.myCandidates[0], orgLabel)),
      f.theyOffer.map((o) => row(o.players[0], f.label)),
      f.orgId
    );
  };

  const analyze = async () => {
    setError(null);
    setThread([]);
    await compare(sideA, sideB);
  };

  /** The two sides as ids, which every request about this deal needs. */
  const deal = () => ({
    sideA: sideA.map((p) => p.player_id),
    sideB: sideB.map((p) => p.player_id),
    // The club matters now: the verdict weighs the incoming men against
    // whoever already holds their jobs here
    orgId,
    orgLabel,
  });

  const askAI = async () => {
    const forOrg = orgId;
    setAiBusy(true);
    setError(null);
    try {
      const r = await apiPost<{ verdict: string; voice: Voice; notice: Notice }>(
        '/api/trade/ai-eval', deal()
      );
      if (orgRef.current === forOrg) {
        setVoice(r.voice);
        setNotice(r.notice ?? null);
      }
      land(forOrg, [{ role: 'assistant', content: r.verdict?.trim() ? r.verdict : NO_ANSWER }]);
    } catch (e) {
      if (orgRef.current === forOrg) setError((e as Error).message);
    } finally {
      setAiBusy(false);
    }
  };

  const reply = async () => {
    const message = draft.trim();
    if (!message || aiBusy) return;
    const forOrg = orgId;
    const asked: TradeTurn[] = [...thread, { role: 'user', content: message }];
    setThread(asked);
    setDraft('');
    setAiBusy(true);
    setError(null);
    try {
      // The thread sent is the one without the new line in it — that goes as
      // the question, and sending it twice would have him answer it twice
      const r = await apiPost<{ reply: string; voice: Voice; notice: Notice }>(
        '/api/trade/ai-reply', { ...deal(), thread, message }
      );
      if (orgRef.current === forOrg) setNotice(r.notice ?? null);
      land(forOrg, [...asked, { role: 'assistant', content: r.reply?.trim() ? r.reply : NO_ANSWER }]);
    } catch (e) {
      if (mounted.current && orgRef.current === forOrg) {
        setError((e as Error).message);
        // Put the question back rather than lose what was typed
        setThread(thread);
        setDraft(message);
      }
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <div>
      {error && <div className="banner error">{error}</div>}

      {proposals.length > 0 && (
        <>
          <h2>Offers on the Table</h2>
          <p className="muted hint-line">
            Proposals sitting in your OOTP inbox. Which players go which way is not stored in the
            message — it is worked out from who each man currently plays for — so check it against
            the mail before acting on anything. The verdict is the same one the analyser below gives.
          </p>
          <div className="talk-grid">
            {proposals.map((p) => (
              <div key={p.message_id} className="talk-card proposal-card">
                <span className="talk-date">{p.date} · {p.from.label}</span>
                <p className="talk-subject">{p.subject}</p>
                <p className="proposal-side">
                  <span className="proposal-label">They send</span>{' '}
                  {p.theySend.players.map((x, i) => (
                    <span key={x.player_id}>
                      {i > 0 && ', '}
                      <PlayerLink id={x.player_id}>{x.name}</PlayerLink>
                      <span className="muted"> {x.positionName} {x.age}</span>
                    </span>
                  ))}
                </p>
                <p className="proposal-side">
                  <span className="proposal-label">You send</span>{' '}
                  {p.weSend.players.map((x, i) => (
                    <span key={x.player_id}>
                      {i > 0 && ', '}
                      <PlayerLink id={x.player_id}>{x.name}</PlayerLink>
                      <span className="muted"> {x.positionName} {x.age}</span>
                    </span>
                  ))}
                </p>
                <p className="muted talk-line">
                  {(VERDICT[p.verdict] ?? VERDICT.even).offer} ({p.weSend.surplus} v {p.theySend.surplus})
                  {' '}· payroll {p.salaryDiff > 0 ? '−' : '+'}{formatMoney(Math.abs(p.salaryDiff))}
                </p>
                <button onClick={() => reviewProposal(p)}>Review this offer</button>
              </div>
            ))}
          </div>
        </>
      )}

      {talk.length > 0 && (
        <>
          <h2>Trade Talk in Your Inbox</h2>
          <p className="muted hint-line">
            Targets your staff has raised, newest first. OOTP's messages name the player and the
            club but never the price, so "Review" loads him as the man you would receive and leaves
            what you give up to you.
          </p>
          <div className="talk-grid">
            {talk.map((t) => (
              <div key={t.message_id} className="talk-card">
                <span className="talk-date">{t.date}</span>
                <p className="talk-subject">{t.subject}</p>
                <p className="talk-player">
                  <PlayerLink id={t.player.player_id}>{t.player.name}</PlayerLink>{' '}
                  <span className="muted">
                    {t.player.positionName} · {t.player.age} · {t.otherTeam.label}
                  </span>
                </p>
                <p className="muted talk-line">
                  Value {t.player.overallPct ?? '—'} · Talent {t.player.talentPct ?? '—'} ·{' '}
                  {formatMoney(t.player.salaryNow)}
                  {t.player.yearsAfterThis > 0 ? ` · ${t.player.yearsAfterThis}y after this` : ' · expiring'}
                </p>
                <button onClick={() => review(t)}>Review this target</button>
              </div>
            ))}
          </div>
        </>
      )}

      <h2>Trade Analyzer</h2>
      <div className="trade-builder" ref={builderRef}>
        <TradeSide title={`${orgLabel} send`} players={sideA} setPlayers={setSideA} club={orgId} />
        <div className="trade-middle">
          <button className="btn-feature" onClick={() => void analyze()} disabled={!sideA.length || !sideB.length}>
            ⇄ Compare
          </button>
          <button onClick={() => void askAI()} disabled={aiBusy || !sideA.length || !sideB.length}>
            {aiBusy && thread.length === 0
              ? 'Thinking…'
              : `🤖 Ask ${voice ? voice.name : 'the front office'}`}
          </button>
        </div>
        <TradeSide
          title={`${orgLabel} receive`}
          players={sideB}
          setPlayers={setSideB}
          clubs={clubs.filter((c) => c.team_id !== orgId)}
          club={clubB}
          setClub={setClubB}
        />
      </div>

      {analysis && (
        <>
          <div className="cards trade-verdict">
            <SummaryCard
              label="Summed value"
              value={`${Math.round(analysis.sideA.totalValue)} / ${Math.round(analysis.sideB.totalValue)}`}
              note="you send / you get"
            />
            <SummaryCard
              label="Best player"
              value={`${pct(analysis.sideA.bestPct)} / ${pct(analysis.sideB.bestPct)}`}
              note={`${analysis.sideA.bestName ?? '—'} / ${analysis.sideB.bestName ?? '—'}`}
            />
            <SummaryCard
              label="Surplus"
              value={`${analysis.sideA.surplus} / ${analysis.sideB.surplus}`}
              note="value over replacement"
            />
            <SummaryCard
              label="Verdict"
              value={(VERDICT[analysis.verdict] ?? VERDICT.even).text}
              tone={(VERDICT[analysis.verdict] ?? VERDICT.even).tone}
              note="on surplus"
            />
            <SummaryCard
              label="Payroll"
              value={`${analysis.salaryDiff > 0 ? '−' : '+'}${formatMoney(Math.abs(analysis.salaryDiff))}`}
              note="this season"
            />
          </div>
          {analysis.warning === 'quantity-for-quality' && (
            <p className="muted hint-line">{qualityNote(analysis)}</p>
          )}
        </>
      )}
      {notice && <FallbackNotice notice={notice} />}
      {thread.length > 0 && (
        <div className="ai-verdict">
          {thread.map((turn, i) =>
            turn.role === 'user' ? (
              <p key={i} className="trade-question">
                {turn.content}
              </p>
            ) : (
              <div key={i} className="trade-answer">
                {voice && (
                  <span className="trade-speaker">
                    {voice.name} · {voice.role}
                  </span>
                )}
                {renderVerdict(turn.content)}
              </div>
            )
          )}
          {aiBusy && <p className="muted">Thinking…</p>}
          {/* A verdict you cannot argue with is the less useful half of one */}
          <div className="trade-reply">
            <input
              value={draft}
              placeholder={`Ask ${voice ? voice.name.split(' ')[0] : 'a follow-up'}…`}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void reply();
              }}
              disabled={aiBusy}
            />
            <button onClick={() => void reply()} disabled={aiBusy || !draft.trim()}>
              Send
            </button>
          </div>
        </div>
      )}

      <h2>Trade Fits Around the League</h2>
      {!fits ? (
        <p className="muted">Scanning 29 front offices…</p>
      ) : (
        <>
          {/* Which spots are weak is about this club, so it stays in view. How the
              matches below are made is the note, folded until it is asked for */}
          <p className="muted hint-line">
            Your weakest spots: {fits.myWeakest.map((w) => w.positionName).join(', ')}
            {fits.mySurplus.length > 0 &&
              ` · your tradable surplus: ${fits.mySurplus.map((s) => s.positionName).join(', ')}`}
            .
          </p>
          <MethodNote pageKey="trade-fits" summary={FIT_RULE}>
            <p className="muted hint-line">{FIT_RULE} The man holding a position is never offered; a spare starting pitcher can be.</p>
          </MethodNote>
          {fits.fits.length === 0 && <p className="muted">No obvious complementary partners right now.</p>}
          <div className="fit-grid">
            {fits.fits.map((f) => (
              <div key={f.orgId} className="fit-card">
                <h3>{f.label}</h3>
                {f.theyNeed.map((n, i) => (
                  <p key={`n${i}`}>
                    They need <strong>{n.positionName}</strong> — you could offer{' '}
                    {n.myCandidates.map((c, j) => (
                      <span key={c.player_id}>
                        {j > 0 && ', '}
                        <PlayerLink id={c.player_id}>{c.name}</PlayerLink>
                      </span>
                    ))}
                  </p>
                ))}
                {f.theyOffer.map((o, i) => (
                  <p key={`o${i}`}>
                    They have spare <strong>{o.positionName}</strong>:{' '}
                    {o.players.map((c, j) => (
                      <span key={c.player_id}>
                        {j > 0 && ', '}
                        <PlayerLink id={c.player_id}>{c.name}</PlayerLink>
                      </span>
                    ))}
                  </p>
                ))}
                <button onClick={() => loadFit(f)}>Load into analyzer</button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function TradeSide({
  title, players, setPlayers, clubs, club, setClub,
}: {
  title: string;
  players: SearchResult[];
  setPlayers: (p: SearchResult[]) => void;
  /** Clubs to choose a roster from. Left out on your own side, which lists your club. */
  clubs?: Org[];
  club: number | null;
  setClub?: (id: number | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = (q: string) => {
    setQuery(q);
    if (timer.current) clearTimeout(timer.current);
    if (q.length < 2) {
      setResults([]);
      return;
    }
    timer.current = setTimeout(() => {
      apiGet<SearchResult[]>(`/api/search-players?q=${encodeURIComponent(q)}`).then(setResults).catch(() => {});
    }, 250);
  };

  const add = (r: SearchResult) => {
    if (!players.some((p) => p.player_id === r.player_id)) setPlayers([...players, r]);
  };

  return (
    <div className="trade-side">
      <h3>{title}</h3>
      <input
        className="trade-search"
        placeholder="Search a player…"
        value={query}
        onChange={(e) => search(e.target.value)}
      />
      {results.length > 0 && (
        <div className="trade-results">
          {results.map((r) => (
            <button
              key={r.player_id}
              onClick={() => {
                add(r);
                setQuery('');
                setResults([]);
              }}
            >
              {r.name} · {r.positionName} · {r.age} · {r.team}
            </button>
          ))}
        </div>
      )}
      <RosterPicker clubs={clubs} club={club} setClub={setClub} onPick={add} taken={players} />
      {players.map((p) => (
        <div key={p.player_id} className="trade-chip">
          <PlayerLink id={p.player_id}>{p.name}</PlayerLink>
          <span className="muted"> {p.positionName} · {p.age}</span>
          <button
            className="chip-x"
            onClick={() => setPlayers(players.filter((x) => x.player_id !== p.player_id))}
            aria-label={`Remove ${p.name} from the deal`}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

/** Levels in the order a roster is read, top down. */
const LEVEL_ORDER = ['MLB', 'AAA', 'AA', 'A', 'R'];
const levelRank = (level: string) => {
  const i = LEVEL_ORDER.indexOf(level);
  return i < 0 ? LEVEL_ORDER.length : i;
};

/**
 * A club's whole organisation in a list, so a player goes in with a click.
 *
 * Typing names was the slow part of building a deal — copying them off another
 * screen one search at a time — and /api/trade/roster was written for exactly
 * this and then never used. Grouped by level and best first within each, which
 * is how the men an offer is built around come to the top.
 */
function RosterPicker({
  clubs, club, setClub, onPick, taken,
}: {
  clubs?: Org[];
  club: number | null;
  setClub?: (id: number | null) => void;
  onPick: (p: SearchResult) => void;
  taken: SearchResult[];
}) {
  const [roster, setRoster] = useState<RosterPlayer[] | null>(null);

  useEffect(() => {
    setRoster(null);
    if (club === null) return;
    let live = true;
    apiGet<{ players: RosterPlayer[] }>(`/api/trade/roster/${club}`)
      .then((r) => {
        if (live) setRoster(r.players);
      })
      .catch(() => {
        if (live) setRoster([]);
      });
    // A slow answer for the club picked before this one must not land on top of it
    return () => {
      live = false;
    };
  }, [club]);

  const already = new Set(taken.map((p) => p.player_id));
  const available = (roster ?? []).filter((p) => !already.has(p.player_id));
  const levels = [...new Set(available.map((p) => p.levelName))].sort((a, b) => levelRank(a) - levelRank(b));

  return (
    <>
      {clubs && setClub && (
        <select
          className="trade-search"
          value={club ?? ''}
          onChange={(e) => setClub(e.target.value ? Number(e.target.value) : null)}
          aria-label="Club to pick from"
        >
          <option value="">Pick from a club's roster…</option>
          {clubs.map((c) => (
            <option key={c.team_id} value={c.team_id}>{c.label}</option>
          ))}
        </select>
      )}
      {club !== null && (
        <select
          className="trade-search"
          value=""
          aria-label="Add a player from the roster"
          disabled={roster === null || available.length === 0}
          onChange={(e) => {
            const p = available.find((x) => x.player_id === Number(e.target.value));
            if (p) onPick(p);
          }}
        >
          <option value="">{roster === null ? 'Loading roster…' : 'Add from the roster…'}</option>
          {levels.map((level) => (
            <optgroup key={level} label={level}>
              {available
                .filter((p) => p.levelName === level)
                .map((p) => (
                  <option key={p.player_id} value={p.player_id}>
                    {p.name} · {p.positionName} · {p.age}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      )}
    </>
  );
}

function SummaryCard({
  label, value, tone, note,
}: { label: string; value: string; tone?: 'good' | 'bad'; note?: string }) {
  return (
    <div className="card">
      <span className="card-label">{label}</span>
      <span className={`card-value ${tone ?? ''}`}>{value}</span>
      {note && <span className="muted hint-line">{note}</span>}
    </div>
  );
}

/**
 * The model writes markdown. Only the bold and heading markers ever show up
 * here, and "## Verdict: Accept" was being printed with its hashes on the page.
 */
function renderVerdict(text: string) {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((line, i) => {
      const heading = /^#{1,6}\s+/.test(line);
      const body = line.replace(/^#{1,6}\s+/, '').replace(/\*\*/g, '');
      return heading ? <h4 key={i}>{body}</h4> : <p key={i}>{body}</p>;
    });
}
