import {
  isValidElement, useCallback, useEffect, useId, useRef, useState, type ReactNode, type Ref,
} from 'react';
import { apiDelete, apiGet, apiPost, getPlayer, type PlayerDossier } from './api';
import { PlayerHover } from './playerHover';
import { PlayerTrend } from './PlayerTrend';
import { formatRatingPair, ratingFraction } from './ratingScale';
import { daysLong } from './injury';
import { describeService, formatMoney, formatService, ordinal, pctColor, plural } from './stats';
import { back, currentRoute, entryState, navigate, usePlayer } from './route';

/**
 * Open the player card from any table cell, without prop drilling.
 *
 * The card is the `player` in the address (see route.ts) and not state of its
 * own, so one can be bookmarked and sent, survives a reload, and is closed by
 * Back. It opens over whatever page is showing and takes that page's filter
 * along. Following a man from inside a card swaps the card rather than stacking
 * another on top, so one Back, or one ✕, closes it however far the reader has
 * wandered through it.
 */
export function openPlayer(id: number): void {
  const { page, params, player } = currentRoute();
  if (player === id) return;
  if (player === null) {
    // Marked as the card's own entry, which is what lets closePlayer pop it
    navigate(page, params, { player: id, state: { card: true } });
  } else {
    navigate(page, params, { player: id, replace: true });
  }
}

/**
 * Close the card. An entry pushed to open it is popped, so opening and closing
 * a card leaves nothing behind in the history. One that was not pushed for it —
 * a link, a bookmark, a typed address — has nothing to pop, and is rewritten
 * without the player where it stands, so Back still leaves the app's own pages
 * alone.
 */
export function closePlayer(): void {
  const { page, params, player } = currentRoute();
  if (player === null) return;
  if (entryState()?.card === true) back();
  else navigate(page, params, { replace: true });
}

/** The words in a piece of content as a screen reader would say them: no markup, in order. */
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

/**
 * Clickable player name — use anywhere a player appears.
 *
 * What pressing it does is in its name, with his after it. A list of twenty
 * prospects is twenty buttons, and one that says only who it is leaves the
 * reader guessing what it will do. His visible words are inside the name, so
 * somebody speaking to the screen can still say what they see. `name` is for a
 * link whose words are not his name (an initial, a number), and should still
 * contain them.
 *
 * It has no title attribute: that was the same words again, read out a second
 * time after the name, and drawn over the hover card for a mouse.
 */
export function PlayerLink({ id, name, children }: { id: number; name?: string; children: ReactNode }) {
  const who = (name ?? textOf(children)).replace(/\s+/g, ' ').trim();
  return (
    <PlayerHover id={id}>
      <button
        className="player-link"
        onClick={() => openPlayer(id)}
        // The hover card hears this focus through the span around the button.
        // When it is the card handing focus back, it should not.
        onFocus={(e) => { if (handingFocusBack) e.stopPropagation(); }}
        aria-label={who ? `Open player card: ${who}` : 'Open player card'}
      >
        {children}
      </button>
    </PlayerHover>
  );
}

/**
 * Hoverable explainer — dotted underline with a styled popup.
 *
 * The words can be tabbed to, and the popup opens for a keyboard resting on
 * them as it does for a mouse. It used to open for a mouse alone, which put the
 * definition of every column in the app out of reach of anybody not using one.
 * The text is the words' description, so a screen reader says it after them
 * rather than leaving it in a box it never sees.
 *
 * Inside a button or a link, a sortable header say, the control already takes
 * focus and a second stop within it would be a button inside a button. There
 * `inControl` leaves the words alone, and the control points at the text itself
 * through the `popId` it was given. A tip that finds itself inside one anyway,
 * because whoever drew it did not say, comes to the same thing on mounting:
 * it is the same fault, and one more tab stop for every column is the price.
 */
export function Tip({
  label, tip, inControl = false, popId,
}: {
  label: ReactNode;
  tip: string;
  inControl?: boolean;
  popId?: string;
}) {
  const own = useId();
  const id = popId ?? own;
  const wrap = useRef<HTMLSpanElement>(null);
  const [found, setFound] = useState(false);
  useEffect(() => {
    if (!inControl && wrap.current?.closest('button, a[href], [role="button"]')) setFound(true);
  }, [inControl]);
  const inside = inControl || found;
  return (
    <span className="tip" ref={wrap}>
      <span
        className="tip-label"
        tabIndex={inside ? undefined : 0}
        aria-describedby={inside ? undefined : id}
      >
        {label}
      </span>
      <span className="tip-pop" id={id} role="tooltip">{tip}</span>
    </span>
  );
}

export const TIP_OA =
  "OOTP's own Overall and Potential, on the 20-80 scouting scale — the same numbers printed on the " +
  "player's page in the game, so you can cross-check the app against it.\n\n" +
  'Deliberately coarse: it moves in five-point steps and the whole league fits into twelve grades, ' +
  'so dozens of players share any given number. Value and Talent beside it are continuous and are ' +
  'compared against others in the same role, which is why those — not this — drive the rankings and ' +
  'recommendations elsewhere in the app.\n\n' +
  'It is on ONE major-league scale at every level: a Triple-A regular grades around 30-40 here, not ' +
  '50. So a prospect can be hitting well for his level and still show a low Overall. The rate stats ' +
  'on his card — OPS+, wRC+ — are the opposite, measured against the league he actually played in. ' +
  'The two are answering different questions, which is worth remembering before reading a minor ' +
  'leaguer as major-league ready.';

export const TIP_VALUE =
  "OOTP's evaluation of the player's current worth to a club, shown as a percentile against others " +
  'in his own role — position players, starters and relievers are ranked separately. 86 means better ' +
  'right now than 86% of MLB-rostered players doing his job.\n\n' +
  'The split matters because the underlying number includes playing time: a closer throws around 65 ' +
  'innings, so ranking him against starters and everyday players would bury even an excellent one.';
export const TIP_TALENT =
  'The scouted ceiling (potential), as a percentile against MLB-rostered players in the same role. ' +
  'Talent well below Value suggests decline risk; well above suggests untapped upside still to develop. ' +
  'A settled veteran often sits lower here than on Value simply because most of the league still has ' +
  'projection left and he does not.';
export const TIP_CURPOT =
  'Current → potential scout ratings (20-80 scale), averaged across the main rating categories. 45→60 means an average-ish player today with above-average upside.';

const money = formatMoney;
const fmt3 = (n: number | null) => (n === null ? '' : n.toFixed(3).replace(/^0/, ''));

const RATING_LABELS: Record<string, string> = {
  contact: 'Contact', gap: 'Gap', power: 'Power', eye: 'Eye', avoidK: 'Avoid K',
  speed: 'Speed', stealing: 'Stealing', baserunning: 'Baserunning',
  stuff: 'Stuff', movement: 'Movement', control: 'Control', stamina: 'Stamina',
  infieldRange: 'IF Range', infieldArm: 'IF Arm', turnDP: 'Turn DP',
  outfieldRange: 'OF Range', outfieldArm: 'OF Arm', catcherArm: 'C Arm', catcherAbility: 'C Ability',
};
const PITCH_LABELS: Record<string, string> = {
  fastball: 'Fastball', sinker: 'Sinker', cutter: 'Cutter', slider: 'Slider', curveball: 'Curveball',
  changeup: 'Changeup', splitter: 'Splitter', forkball: 'Forkball', screwball: 'Screwball',
  circlechange: 'Circle Change', knucklecurve: 'Knuckle Curve', knuckleball: 'Knuckleball',
};

/**
 * Where Tab has to be sent by hand to keep it inside the card, or null when the
 * browser's own step already stays inside.
 *
 * `stops` is everything Tab can land on in the card, in order, and `at` is
 * where focus is now. Focus anywhere that is not one of them — on the card
 * itself, or dropped to the page behind when the thing that held it was
 * replaced — is brought in at the end Tab was heading for.
 *
 * Pure, so the edges can be checked without a page.
 */
export function tabWrap<T>(stops: readonly T[], at: T | null, backwards: boolean): T | null {
  if (stops.length === 0) return null;
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (at === null || !stops.includes(at)) return backwards ? last : first;
  if (backwards && at === first) return last;
  if (!backwards && at === last) return first;
  return null;
}

const TAB_STOPS = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled):not([type="hidden"])',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** What Tab can land on inside the card, in the order it would. */
function tabStops(root: HTMLElement): HTMLElement[] {
  // No boxes means not drawn: a tooltip that is not showing, a note that is shut
  return Array.from(root.querySelectorAll<HTMLElement>(TAB_STOPS)).filter(
    (el) => el.getClientRects().length > 0
  );
}

function keepTabInside(e: KeyboardEvent, dialog: HTMLElement): void {
  const stops = tabStops(dialog);
  if (stops.length === 0) {
    e.preventDefault();
    dialog.focus();
    return;
  }
  const at = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const to = tabWrap(stops, at, e.shiftKey);
  if (to === null) return;
  e.preventDefault();
  to.focus();
}

/**
 * True while the card hands focus back to the link that opened it. A link
 * brings up its hover card whenever it takes focus, which is right for a
 * keyboard arriving at it and wrong here: the reader has just shut a card and
 * is looking at the page, not asking for another one over it. Every close
 * would otherwise end with a card for the name last pressed.
 */
let handingFocusBack = false;

/**
 * Hands focus back to whatever had it before the card opened. Only when focus
 * went down with the card: a reader who has already clicked on something else
 * is where they meant to be.
 */
function giveFocusBack(to: HTMLElement | null): void {
  const at = document.activeElement;
  if (!to || !to.isConnected || (at !== null && at !== document.body)) return;
  handingFocusBack = true;
  try {
    to.focus();
  } finally {
    handingFocusBack = false;
  }
}

/**
 * The card's frame: the dimmed page, the dialog on it, and the way out.
 *
 * Kept apart from what is in the card so that what makes it a dialog can be
 * drawn and checked without a save to open it on. Everything that closes it
 * from here — this button, a click on the dimmed page, Escape — goes through
 * closePlayer, so none of them can come to differ; Back needs nothing of ours,
 * since the card is the address.
 *
 * `titleId` is the heading that names the card. Until there is one, while the
 * man loads, the card is just "Player card" rather than pointing at a heading
 * that is not on the page yet.
 */
export function ModalShell({
  titleId, dialogRef, children,
}: {
  titleId?: string;
  dialogRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <div className="modal-backdrop" onClick={closePlayer}>
      <div
        className="modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-label={titleId ? undefined : 'Player card'}
        // Focusable by a script and not by Tab: where focus goes when the card
        // opens, and where it falls back to when what held it has been replaced
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="modal-close" onClick={closePlayer} aria-label="Close player card">✕</button>
        {children}
      </div>
    </div>
  );
}

/**
 * The card can send the reader to a page — the 40-Man Roster, from the line
 * about his place on it — when whoever mounts it says how to get there. Left
 * out, the card still says everything and simply offers no link.
 *
 * While it is open it is the whole of the page to a keyboard: focus moves into
 * it, Tab goes round inside it, and closing it by any road puts focus back on
 * what opened it.
 */
export function PlayerModal({ onNavigate }: { onNavigate?: (page: string) => void }) {
  // Drawn from the address, so Back, Forward and a bookmark all open and close it
  const playerId = usePlayer();
  const [dossier, setDossier] = useState<PlayerDossier | null>(null);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const open = playerId !== null;

  useEffect(() => {
    if (playerId === null) return;
    setDossier(null);
    setError(null);
    // Back and Forward can change the man faster than the server answers, and
    // the answer to arrive last must not be one for a man no longer on screen
    let current = true;
    getPlayer(playerId)
      .then((d) => { if (current) setDossier(d); })
      .catch((e) => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [playerId]);

  // Opening and closing the card, for a keyboard: whatever had focus when it
  // opened gets it back when it closes, whichever way it was closed
  useEffect(() => {
    if (!open) return;
    const at = document.activeElement;
    const opener = at instanceof HTMLElement && at !== document.body ? at : null;
    return () => giveFocusBack(opener);
  }, [open]);

  // Focus goes into the card on opening and stays in it. Following a man from
  // inside the card replaces everything in it, the link just pressed included,
  // and focus that goes with it falls to the page behind.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus();
  }, [playerId, dossier, error]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Escape and the ✕ are one act, so they cannot come to differ
      if (e.key === 'Escape') closePlayer();
      // Tab goes round inside the card: it is all there is while it is open
      else if (e.key === 'Tab' && dialogRef.current) keepTabInside(e, dialogRef.current);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (playerId === null) return null;

  return (
    <ModalShell titleId={dossier ? titleId : undefined} dialogRef={dialogRef}>
      {error && <div className="banner error" role="alert">{error}</div>}
      {!dossier && !error && <p className="muted" role="status">Loading player…</p>}
      {dossier && (
        <Dossier
          d={dossier}
          titleId={titleId}
          // Leaving the page closes the card with it: the card belongs to the
          // page it was opened over, and the next page has none
          onRoster={onNavigate ? () => onNavigate('crunch') : undefined}
        />
      )}
    </ModalShell>
  );
}

function WatchControls({ playerId, name }: { playerId: number; name: string }) {
  const [watched, setWatched] = useState(false);
  const [note, setNote] = useState('');
  const [loaded, setLoaded] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    apiGet<{ watched: boolean; note: string }>(`/api/watchlist/${playerId}`)
      .then((w) => {
        setWatched(w.watched);
        setNote(w.note);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [playerId]);

  const toggle = async () => {
    if (watched) {
      await apiDelete(`/api/watchlist/${playerId}`);
      setWatched(false);
    } else {
      await apiPost('/api/watchlist', { player_id: playerId, name, note });
      setWatched(true);
    }
  };

  const onNote = (value: string) => {
    setNote(value);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void apiPost('/api/watchlist', { player_id: playerId, name, note: value });
      setWatched(true);
    }, 600);
  };

  if (!loaded) return null;
  return (
    <div className="watch-controls">
      <button className={`watch-star ${watched ? 'on' : ''}`} onClick={toggle} title="Watchlist">
        {watched ? '★ Watching' : '☆ Watch'}
      </button>
      {watched && (
        <textarea
          className="watch-note"
          placeholder="Your notes on this player…"
          value={note}
          onChange={(e) => onNote(e.target.value)}
          rows={2}
        />
      )}
    </div>
  );
}

/**
 * Which levels a career table shows.
 *
 * A reader asked to see a man's major-league line on its own, or his minor
 * league one. The split is simply level one against everything under it, which
 * is the question he asked and is also the only version of it that survives a
 * league with levels this app has never seen — no list of what counts as the
 * minors to fall out of date.
 */
export type LevelScope = 'all' | 'mlb' | 'minors';

export const inScope = (levelId: unknown, scope: LevelScope): boolean => {
  if (scope === 'all') return true;
  const majors = Number(levelId) === 1;
  return scope === 'mlb' ? majors : !majors;
};

/** How an emptied table names the levels it was asked for. */
const scopeWord = (scope: LevelScope): string =>
  scope === 'mlb' ? 'major-league' : scope === 'minors' ? 'minor-league' : '';

const SCOPES: Array<{ key: LevelScope; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'mlb', label: 'MLB' },
  { key: 'minors', label: 'Minors' },
];

/**
 * Shown beside each history heading rather than once at the top, because these
 * tables are spread down a scrolling card and a control you have to scroll back
 * to is one you stop using. All three read the same state, so setting it
 * anywhere sets it everywhere.
 */
function LevelPicker({ scope, onPick }: { scope: LevelScope; onPick: (s: LevelScope) => void }) {
  return (
    <span className="level-picker">
      {SCOPES.map((s) => (
        <button
          key={s.key}
          type="button"
          className={s.key === scope ? 'active' : ''}
          onClick={() => onPick(s.key)}
        >
          {s.label}
        </button>
      ))}
    </span>
  );
}

/**
 * His major-league service, said the way the Contracts page says it.
 *
 * The card is sent whole years only, because mlb_service_years is truncated,
 * and writing that as years.days would claim a day count nobody sent: 11.000
 * for a man who is 11.027. So it says the years it has, as years, until the
 * server also sends days — and uses them as soon as it does.
 */
function ServiceTime({ d }: { d: PlayerDossier }) {
  const days = (d as { serviceDays?: number | null }).serviceDays;
  if (typeof days === 'number') {
    return <> · <span title={describeService(null, days)}>{formatService(null, days)} MLB service</span></>;
  }
  if (d.serviceYears === null) return null;
  return (
    <> · <span title="Whole years of major-league service, rounded down.">{plural(d.serviceYears, 'yr')} MLB service</span></>
  );
}

/**
 * Where he stands on the 40-man, as the server sends it in `rosterStatus`.
 * Declared here until PlayerDossier in api.ts carries it.
 */
interface RosterStanding {
  on40: boolean;
  on26: boolean;
  /** On the 60-day IL: still listed with the 40-man, but not counted on it. */
  il60: boolean;
  optionsUsed: number | null;
  optionsLeft: number | null;
  /** All three used with under five years' service: he cannot go down without waivers. */
  outOfOptions: boolean;
  /** His organisation's 40-man, sent for a man in the minors. */
  fortyMan: { count: number; limit: number } | null;
}

/**
 * His place on the 40-man, his options, and how full the roster is.
 *
 * A reader following a prospect from the farm page found his ratings, his
 * history and "0 yrs MLB service" here, and had to open the 40-Man page on his
 * own to learn whether the man could be called up at all.
 */
function RosterLine({ d, onRoster }: { d: PlayerDossier; onRoster?: () => void }) {
  const r = (d as { rosterStatus?: RosterStanding | null }).rosterStatus;
  if (!r) return null;
  const where = r.on26
    ? 'Active roster'
    : r.il60
      ? '60-day IL, off the 40-man count'
      : r.on40
        ? 'On the 40-man'
        : 'Not on the 40-man';
  return (
    <div className="muted">
      {where}
      {r.fortyMan && (
        <>
          {' · '}
          <span title={`His organisation's 40-man: ${r.fortyMan.count} of ${r.fortyMan.limit} places taken. Men on the 60-day IL do not count.`}>
            {r.fortyMan.count}/{r.fortyMan.limit}
          </span>
        </>
      )}
      {r.outOfOptions ? (
        <>
          {' · '}
          <span title="All three options used, under five years' service: he cannot be sent down without clearing waivers.">
            out of options
          </span>
        </>
      ) : r.optionsLeft === 0 ? (
        <>
          {' · '}
          <span title="All three options used, but with five years' service he can refuse an assignment anyway.">
            no options left
          </span>
        </>
      ) : r.optionsLeft !== null ? (
        ` · ${plural(r.optionsLeft, 'option')} left`
      ) : null}
      {onRoster && (
        <>
          {' · '}
          <button type="button" className="link-button" onClick={onRoster}>40-Man Roster</button>
        </>
      )}
    </div>
  );
}

function Dossier({ d, titleId, onRoster }: { d: PlayerDossier; titleId: string; onRoster?: () => void }) {
  const [scope, setScope] = useState<LevelScope>('all');
  const battingYears = d.battingYears.filter((y) => inScope(y.level_id, scope));
  const pitchingYears = d.pitchingYears.filter((y) => inScope(y.level_id, scope));
  const fieldingYears = (d.fieldingYears ?? []).filter((f) => inScope(f.level_id, scope));

  /*
   * Offered only where there is something to divide. A man who has never
   * played anywhere but the majors gains nothing from being asked which levels
   * he wants, and the card is long enough already.
   */
  const everyRow = [...d.battingYears, ...d.pitchingYears, ...(d.fieldingYears ?? [])];
  const mixed =
    everyRow.some((r) => Number(r.level_id) === 1) && everyRow.some((r) => Number(r.level_id) !== 1);
  const picker = mixed ? <LevelPicker scope={scope} onPick={setScope} /> : null;

  const showBatting = !d.isPitcher || d.battingYears.length > 0;
  return (
    <div>
      <div className="dossier-head">
        <div>
          <h2 className="dossier-name" id={titleId}>
            {d.uniform !== null && <span className="dossier-number">#{d.uniform}</span>} {d.name}
          </h2>
          {d.nickname && <div className="dossier-nick">“{d.nickname}”</div>}
          <div className="muted">
            {d.roleName ?? d.positionName} · B/T {d.bats}/{d.throws} · Age {d.age}
            {d.heightWeight ? ` · ${d.heightWeight}` : ''}
          </div>
          <div className="muted">{d.team ?? 'No club'}<ServiceTime d={d} /></div>
          <RosterLine d={d} onRoster={onRoster} />
          {d.currentInjury && (
            <div className="injury-note">
              🩹 {d.currentInjury.status}
              {daysLong(d.currentInjury) && ` — ${daysLong(d.currentInjury)}`}
            </div>
          )}
          <WatchControls playerId={d.player_id} name={d.name} />
        </div>
        <div className="dossier-pcts">
          {d.oaRating !== null && (
            <div className="card">
              <span className="card-label"><Tip label="OA → POT" tip={TIP_OA} /></span>
              <span className="card-value">{formatRatingPair(d.oaRating, d.potRating, ' → ')}</span>
            </div>
          )}
          <div className="card">
            <span className="card-label"><Tip label="Value" tip={TIP_VALUE} /></span>
            <span className="card-value"><Pct v={d.overallPct} /></span>
          </div>
          <div className="card">
            <span className="card-label"><Tip label="Talent" tip={TIP_TALENT} /></span>
            <span className="card-value"><Pct v={d.talentPct} /></span>
          </div>
        </div>
      </div>

      <div className="dossier-columns">
        {d.isPitcher && d.pitchingRatings && (
          <section>
            <h3>Pitching</h3>
            {d.velocity && <p className="muted velo">Velocity: <strong>{d.velocity}</strong></p>}
            <RatingRows ratings={d.pitchingRatings} />
            {d.pitches.length > 0 && (
              <>
                <h3>Arsenal</h3>
                <RatingRows
                  ratings={Object.fromEntries(d.pitches.map((p) => [p.name, [p.rating, p.talent] as [number, number]]))}
                  labels={PITCH_LABELS}
                />
              </>
            )}
          </section>
        )}
        {!d.isPitcher && d.battingRatings && (
          <section>
            <h3>Batting</h3>
            <RatingRows ratings={d.battingRatings} />
          </section>
        )}
        <section>
          {/* The grades a coach reads before moving anybody, which the card
              never carried — only the components underneath them. Only the
              positions OOTP has revealed appear: it prints a dash at the rest,
              and what the dash hides is not ours to print. */}
          {(d.positionRatings?.length ?? 0) > 0 && (
            <>
              <h3>Positions</h3>
              <table className="mini">
                <tbody>
                  {(d.positionRatings ?? []).map((p) => (
                    <tr key={p.position} className={p.isPrimary ? 'row-us' : ''}>
                      <td>
                        {p.code}
                        {p.isPrimary && <span className="muted"> · listed</span>}
                      </td>
                      <td className="num">{formatRatingPair(p.current, p.potential, ' → ')}</td>
                      <td className="num muted">{p.experience > 0 ? 'has played here' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <span className="muted">
                Only positions OOTP has rated him at. Others stay blank until he plays there.
              </span>
            </>
          )}
          {!d.isPitcher && d.fieldingRatings && (
            <>
              <h3>Fielding</h3>
              <RatingRows
                ratings={Object.fromEntries(
                  Object.entries(d.fieldingRatings)
                    .filter(([, v]) => v > 0)
                    .map(([k, v]) => [k, [v, v] as [number, number]])
                )}
              />
            </>
          )}
          {d.contract && d.contract.salarySchedule.length > 0 && (
            <>
              <h3>Contract{d.contract.noTrade ? ' · no-trade' : ''}</h3>
              <table className="mini">
                <tbody>
                  {d.contract.salarySchedule.map((s) => (
                    <tr key={s.year}>
                      <td>{s.year}</td>
                      <td className="num">{money(s.salary)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      </div>

      {d.scouting && !d.scouting.empty && (
        <section>
          <h3>Scouting</h3>
          {d.scouting.tools.length > 0 && (
            <ul className="scout-list">
              {d.scouting.tools.map((t) => (
                <li key={t.label} className={t.good ? 'good-text' : 'bad-text'}>
                  {t.label} <span className="muted">{t.grade} · {ordinal(t.rank)} percentile</span>
                </li>
              ))}
            </ul>
          )}
          {d.scouting.makeup.length > 0 && (
            <p className="muted scout-makeup">{d.scouting.makeup.join(' · ')}</p>
          )}
          {/*
            Said out loud because a percentile means nothing until you know what
            it is a percentile of, and the first version of this ranked him
            against every player in the universe — which made an ordinary
            major-league bat look like one of the best in the world.
          */}
          <p className="muted hint-line">
            OOTP exports no written scouting, so this is his own ratings ranked against{' '}
            {d.scouting.peers ?? 'his peers'} — only the tools that stand out either way.
          </p>
        </section>
      )}

      {d.transactions && d.transactions.length > 0 && (
        <section>
          <h3>Transactions</h3>
          <table className="mini">
            <tbody>
              {d.transactions.map((t, i) => (
                <tr key={i}>
                  <td className="num">{t.date ?? ''}</td>
                  <td className="wrap-cell">
                    {t.summary.map((seg, j) =>
                      seg.kind === 'player' && seg.id ? (
                        <PlayerLink key={j} id={seg.id}>{seg.text}</PlayerLink>
                      ) : seg.kind === 'team' ? (
                        <strong key={j}>{seg.text}</strong>
                      ) : (
                        <span key={j}>{seg.text}</span>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section>
        <h3>This Season, Game by Game</h3>
        <PlayerTrend playerId={d.player_id} />
      </section>

      {showBatting && d.battingYears.length > 0 && (
        <section>
          <h3>Batting History {picker}</h3>
          <div className="history-scroll">
            <table className="mini">
              <thead>
                <tr>
                  <th>Year</th><th>Team</th><th>Lvl</th><th>PA</th><th>HR</th><th>RBI</th><th>SB</th>
                  <th>AVG</th><th>OBP</th><th>SLG</th><th>WAR</th>
                </tr>
              </thead>
              <tbody>
                {battingYears.map((y, i) => (
                  <tr key={i}>
                    <td>{y.year}</td>
                    <td>{y.team ?? '—'}</td>
                    <td><span className="level-tag">{y.levelName}</span></td>
                    <td className="num">{y.pa}</td>
                    <td className="num">{y.hr}</td>
                    <td className="num">{y.rbi}</td>
                    <td className="num">{y.sb}</td>
                    <td className="num">{fmt3(y.avg as number | null)}</td>
                    <td className="num">{fmt3(y.obp as number | null)}</td>
                    <td className="num">{fmt3(y.slg as number | null)}</td>
                    <td className="num">{y.war}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {battingYears.length === 0 && <p className="muted empty-scope">No {scopeWord(scope)} batting.</p>}
          </div>
        </section>
      )}

      {d.gameLogs.length > 0 && !d.isPitcher && (
        <section>
          <h3>Last {d.gameLogs.length} Games</h3>
          <div className="history-scroll">
            <table className="mini">
              <thead>
                <tr><th>Date</th><th>Opp</th><th>AB</th><th>H</th><th>HR</th><th>RBI</th><th>BB</th><th>K</th><th>SB</th></tr>
              </thead>
              <tbody>
                {d.gameLogs.map((g, i) => (
                  <tr key={i}>
                    <td>{g.date}</td><td>{g.opp}</td>
                    <td className="num">{g.ab}</td>
                    <td className="num">{g.h}</td>
                    <td className="num">{g.hr}</td>
                    <td className="num">{g.rbi}</td>
                    <td className="num">{g.bb}</td>
                    <td className="num">{g.k}</td>
                    <td className="num">{g.sb}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {d.pitchingGameLogs.length > 0 && (
        <section>
          <h3>Recent Outings</h3>
          <div className="history-scroll">
            <table className="mini">
              <thead>
                <tr><th>Date</th><th>Opp</th><th>GS</th><th>IP</th><th>ER</th><th>H</th><th>BB</th><th>K</th></tr>
              </thead>
              <tbody>
                {d.pitchingGameLogs.map((g, i) => (
                  <tr key={i}>
                    <td>{g.date}</td><td>{g.opp}</td>
                    <td className="num">{g.gs}</td>
                    <td className="num">{g.ip}</td>
                    <td className="num">{g.er}</td>
                    <td className="num">{g.ha}</td>
                    <td className="num">{g.bb}</td>
                    <td className="num">{g.k}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {(d.fieldingYears?.length ?? 0) > 0 && (
        <section>
          <h3>Fielding {picker}</h3>
          <table>
            <thead>
              <tr>
                <th>Year</th><th>Lvl</th><th>Pos</th>
                <th className="num">G</th><th className="num">Inn</th>
                <th className="num">PO</th><th className="num">A</th><th className="num">E</th>
                <th className="num">DP</th><th className="num">FPCT</th><th className="num">RF/9</th>
              </tr>
            </thead>
            <tbody>
              {fieldingYears.slice(0, 14).map((f, i) => (
                <tr key={i}>
                  <td className="num">{f.year}</td>
                  <td><span className="lvl-badge">{f.levelName}</span></td>
                  <td>{f.positionName}</td>
                  <td className="num">{f.g}</td>
                  <td className="num">{Math.round(f.innings)}</td>
                  <td className="num">{f.po}</td>
                  <td className="num">{f.a}</td>
                  <td className="num">{f.e}</td>
                  <td className="num">{f.dp}</td>
                  <td className="num">{f.fpct !== null ? f.fpct.toFixed(3).replace(/^0\./, '.') : ''}</td>
                  <td className="num">{f.rf9 !== null ? f.rf9.toFixed(2) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {fieldingYears.length === 0 && <p className="muted empty-scope">No {scopeWord(scope)} fielding.</p>}
        </section>
      )}

      {/* Honours first: what a player WAS is the headline of a career page */}
      {(d.awards?.length ?? 0) > 0 && (
        <section>
          <h3>Honours</h3>
          <div className="award-list">
            {Object.entries(
              (d.awards ?? []).reduce<Record<string, number[]>>((acc, a) => {
                const label = a.positionName ? `${a.award} (${a.positionName})` : a.award;
                (acc[label] ??= []).push(a.year);
                return acc;
              }, {})
            )
              // Keep the server's ordering: MVP before an All-Star nod
              .sort(
                (a, b) =>
                  ((d.awards ?? []).find((x) =>
                    (x.positionName ? `${x.award} (${x.positionName})` : x.award) === a[0]
                  )?.rank ?? 99) -
                  ((d.awards ?? []).find((x) =>
                    (x.positionName ? `${x.award} (${x.positionName})` : x.award) === b[0]
                  )?.rank ?? 99)
              )
              .map(([label, years]) => (
                <div key={label} className="award-row">
                  <span className="award-name">
                    {years.length > 1 && <strong>{years.length}× </strong>}
                    {label}
                  </span>
                  <span className="muted">{years.sort((a, b) => b - a).join(', ')}</span>
                </div>
              ))}
          </div>
        </section>
      )}

      {(d.leagueLeader?.length ?? 0) > 0 && (
        <section>
          <h3>Led the League</h3>
          <table className="mini">
            <tbody>
              {(d.leagueLeader ?? []).slice(0, 12).map((l, i) => (
                <tr key={i}>
                  <td className="num muted">{l.year}</td>
                  <td className="num">{ordinal(l.place)}</td>
                  <td>{l.category}</td>
                  <td className="num">{l.amount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <StaffNotes playerId={d.player_id} />

      {d.contact && (d.contact.battedBalls ?? 0) > 0 && (
        <section>
          <h3>
            <Tip
              label="Contact Quality"
              tip="Measured from every batted ball he has hit — OOTP records the exit velocity and launch angle of each one and shows none of it. Strikeouts and walks are excluded: they have no batted ball, so they belong in neither the numerator nor the denominator."
            />
          </h3>
          <div className="contact-grid">
            <ContactStat label="Avg exit velo" value={d.contact.avgExitVelo} unit=" mph" league={d.contactLeague?.avgExitVelo} />
            <ContactStat label="Hardest hit" value={d.contact.maxExitVelo} unit=" mph" />
            <ContactStat label="Hard-hit" value={d.contact.hardHitPct} unit="%" league={d.contactLeague?.hardHitPct} />
            <ContactStat label="Barrels" value={d.contact.barrelPct} unit="%" league={d.contactLeague?.barrelPct} />
            <ContactStat label="Sweet spot" value={d.contact.sweetSpotPct} unit="%" />
            <ContactStat label="Sprint speed" value={d.contact.sprintSpeed} unit="" league={d.contactLeague?.sprintSpeed} />
          </div>
          <p className="muted contact-line">
            Ground balls {d.contact.gbPct ?? '—'}% · line drives {d.contact.ldPct ?? '—'}% · fly balls{' '}
            {d.contact.fbPct ?? '—'}% &middot; {d.contact.battedBalls} batted balls
          </p>
          {d.contact.slgLuck !== null && d.contact.slgLuck !== undefined && (
            <p className={`contact-luck ${d.contact.slgLuck <= -0.06 ? 'good-text' : d.contact.slgLuck >= 0.06 ? 'bad-text' : 'muted'}`}>
              {/* Framed as what to expect next, since that is the only reason
                  the gap is worth knowing */}
              Slugging {fmt3(d.contact.slg)} against {fmt3(d.contact.xslg)} expected from his contact
              {d.contact.slgLuck <= -0.06 && ' — he has hit the ball better than the results show, and should improve without changing anything.'}
              {d.contact.slgLuck >= 0.06 && ' — the results have outrun the contact, so expect some giveback.'}
              {d.contact.slgLuck > -0.06 && d.contact.slgLuck < 0.06 && ' — his results match his contact.'}
            </p>
          )}
        </section>
      )}

      {d.splits.length > 1 && (
        <section>
          <h3>
            <Tip
              label="Situational"
              tip="Cut from the base-out state recorded on every plate appearance. Single-season splits are small samples — read the plate-appearance column before drawing a conclusion from any line here."
            />
          </h3>
          <div className="history-scroll">
            <table className="mini">
              <thead>
                <tr><th>Situation</th><th>PA</th><th>AVG</th><th>OPS</th></tr>
              </thead>
              <tbody>
                {d.splits.map((s) => (
                  <tr key={s.label}>
                    <td>{s.label}</td>
                    <td className="num">{s.pa}</td>
                    <td className="num">{fmt3(s.ba)}</td>
                    <td className="num">{fmt3(s.ops)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {d.injuryHistory.length > 0 && (
        <section>
          <h3>Injury History</h3>
          <div className="history-scroll">
            <table className="mini">
              <thead>
                <tr><th>Date</th><th>Missed</th><th>Type</th></tr>
              </thead>
              <tbody>
                {d.injuryHistory.map((h, i) => (
                  <tr key={i}>
                    <td>{h.date}</td>
                    <td className="num">{h.length ? plural(Number(h.length), 'day') : '—'}</td>
                    <td>{h.day_to_day === 1 ? 'Day-to-day' : 'IL stint'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {d.pitchingYears.length > 0 && (
        <section>
          <h3>Pitching History {picker}</h3>
          <div className="history-scroll">
            <table className="mini">
              <thead>
                <tr>
                  <th>Year</th><th>Team</th><th>Lvl</th><th>G</th><th>GS</th><th>W-L</th><th>SV</th>
                  <th>IP</th><th>ERA</th><th>WHIP</th><th>K</th><th>BB</th><th>WAR</th>
                </tr>
              </thead>
              <tbody>
                {pitchingYears.map((y, i) => (
                  <tr key={i}>
                    <td>{y.year}</td>
                    <td>{y.team ?? '—'}</td>
                    <td><span className="level-tag">{y.levelName}</span></td>
                    <td className="num">{y.g}</td>
                    <td className="num">{y.gs}</td>
                    <td className="num">{y.w}-{y.l}</td>
                    <td className="num">{y.sv}</td>
                    <td className="num">{y.ip}</td>
                    <td className="num">{y.era}</td>
                    <td className="num">{y.whip}</td>
                    <td className="num">{y.k}</td>
                    <td className="num">{y.bb}</td>
                    <td className="num">{y.war}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {pitchingYears.length === 0 && <p className="muted empty-scope">No {scopeWord(scope)} pitching.</p>}
          </div>
        </section>
      )}
    </div>
  );
}

function RatingRows({
  ratings, labels = RATING_LABELS,
}: { ratings: Record<string, [number, number]>; labels?: Record<string, string> }) {
  return (
    <div className="rating-rows">
      {Object.entries(ratings).map(([key, [cur, pot]]) => (
        <div key={key} className="rating-row">
          <span className="rating-row-label">{labels[key] ?? key}</span>
          <div className="rating wide">
            <div
              className="rating-bar"
              style={{
                width: `${ratingFraction(cur) * 100}%`,
                background: `hsl(${ratingFraction(cur) * 120}, 65%, 45%)`,
              }}
            />
            {pot > cur && (
              <div className="rating-pot" style={{ left: `${ratingFraction(pot) * 100}%` }} />
            )}
            <span>{cur}{pot > cur ? ` / ${pot}` : ''}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function Pct({ v }: { v: number | null }) {
  if (v === null) return <span className="muted">—</span>;
  return <span style={{ color: pctColor(v) }}>{v}</span>;
}

/**
 * One contact number, with the league's for scale. A raw "39.1% hard-hit"
 * means nothing to anyone who does not already know the league sits at 29.4.
 */
function ContactStat({
  label, value, unit, league,
}: { label: string; value: number | null | undefined; unit: string; league?: number }) {
  return (
    <div className="contact-stat">
      <span className="contact-label">{label}</span>
      <span className="contact-value">{value === null || value === undefined ? '—' : `${value}${unit}`}</span>
      {league !== undefined && <span className="contact-league">lg {league}{unit}</span>}
    </div>
  );
}

interface Note {
  id: number;
  source: string | null;
  body: string;
  game_date: string | null;
}

/**
 * What the staff have said about this man, kept on his page.
 *
 * Advice given in a chat window is only useful while you can still see it. A
 * plan for a pitcher coming back from the injured list is needed weeks later,
 * at the moment he is activated, which is exactly when the conversation is
 * long gone — so it is filed here, with who said it and the date of the game
 * when they did.
 */
function StaffNotes({ playerId }: { playerId: number }) {
  const [notes, setNotes] = useState<Note[]>([]);

  const load = useCallback(() => {
    apiGet<{ notes: Note[] }>(`/api/player-notes/${playerId}`)
      .then((r) => setNotes(r.notes))
      // Notes live in the history database, which a save exported elsewhere may
      // not have; the rest of the card should not care
      .catch(() => setNotes([]));
  }, [playerId]);

  useEffect(load, [load]);

  const remove = async (id: number) => {
    try {
      await apiDelete(`/api/player-notes/${id}`);
      load();
    } catch {
      /* leave it on screen rather than lying about having removed it */
    }
  };

  if (notes.length === 0) return null;

  return (
    <section>
      <h3>Staff Notes</h3>
      {notes.map((n) => (
        <div key={n.id} className="staff-note">
          <div className="staff-note-head">
            <strong>{n.source ?? 'You'}</strong>
            {n.game_date && <span className="muted"> · {n.game_date}</span>}
            <button className="link-button staff-note-x" onClick={() => void remove(n.id)}>
              Remove
            </button>
          </div>
          {n.body.split('\n').filter((l) => l.trim()).map((line, i) => (
            <p key={i}>{line.replace(/\*\*/g, '')}</p>
          ))}
        </div>
      ))}
    </section>
  );
}
