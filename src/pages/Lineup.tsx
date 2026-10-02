import { useEffect, useRef, useState } from 'react';
import { apiGet, getLineup, type LineupResponse } from '../api';
import { PlayerLink, Tip } from '../playerModal';
import { daysShort } from '../injury';
import { findStat, leagueDay, plusColor as statPlusColor } from '../stats';
import { Th } from '../Th';
import { MethodNote } from '../MethodNote';
import { navigate } from '../route';

/** OOTP's own internal rating, which is what the ordering is actually built on. */
const TIP_OFF_VALUE =
  "OOTP's own offensive value for this batter against this hand of pitching, read straight from " +
  "the save (players_value.offensive_value_vsr / _vsl). It is a projection built from the hitter's " +
  'current ratings — contact, power, eye, gap — on an arbitrary scale where only the ranking ' +
  'matters, not the number itself. The batting order is sorted by it, and switching between ' +
  'vs RHP and vs LHP re-ranks everyone on their platoon split.\n\n' +
  'It is NOT this season\'s production. A veteran whose ratings have slipped can rank low while ' +
  'hitting well, and a highly rated young player can rank high during a slump — so read it ' +
  'alongside the OPS+ and wRC+ columns, which are what actually happened.';
const TIP_OPS_PLUS = findStat('batting', 'opsPlus')?.desc ?? '';
const TIP_WRC_PLUS = findStat('batting', 'wrcPlus')?.desc ?? '';

const plusColor = (value: number | null): string | undefined => {
  const def = findStat('batting', 'opsPlus');
  return def ? statPlusColor(def, value) : undefined;
};

/**
 * How each style of card is ordered. It is also the line shown while the note
 * about the card is folded, so the gist is there without opening anything.
 */
const ORDERING: Record<'saber' | 'trad', string> = {
  saber: 'Ordering per The Book (Tango et al.): your three best hitters bat 1, 2, and 4 — not 3-4-5.',
  trad: 'Classic ordering: speed leads off, bat control 2nd, best hitter 3rd, power cleanup.',
};

interface NextGame {
  /** The game itself, which is what the link to its plan needs. Absent in an export made before it was sent. */
  game_id?: number;
  date: string;
  isHome: boolean;
  opponent: string;
  ourStarter: { player_id: number; name: string; throws: string } | null;
  theirStarter: { player_id: number; name: string; throws: string } | null;
}

/**
 * The way from the banner to the plan for the game it is about: the Schedule,
 * opened on that game with its plan up. Nothing for an export made before the
 * next game carried its id, since there is no game to name.
 */
export function GamePlanLink({ game }: { game: number | undefined }) {
  if (game === undefined) return null;
  return (
    <button
      type="button"
      className="link-button"
      title="Open the game plan for this game"
      onClick={() => navigate('schedule', { game })}
    >
      Game plan
    </button>
  );
}

/**
 * Puts text on the clipboard, and says whether it got there.
 *
 * The clipboard API where the page may use it: a secure context, in a window
 * the browser counts as in use. Where that is missing or refuses (an address
 * that is neither https nor localhost, as on a copy of the app served over a
 * network, or a window that has lost focus) the older way still works from
 * inside a click: put the text in a textarea, select it, and ask the browser to
 * copy the selection. False only when both have failed, so the button can say
 * so instead of looking as if it had worked.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused. The textarea has no permission to be refused, so it gets its turn
  }
  return copyViaTextarea(text);
}

function copyViaTextarea(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const kept = document.activeElement as { focus?: () => void } | null;
  const box = document.createElement('textarea');
  box.value = text;
  // Read-only so a phone does not raise its keyboard. Out of sight but in the
  // page, because a selection needs something that has been drawn
  box.setAttribute('readonly', '');
  box.style.position = 'fixed';
  box.style.top = '0';
  box.style.left = '-9999px';
  box.style.opacity = '0';
  document.body.appendChild(box);
  let copied = false;
  try {
    box.focus();
    box.select();
    // iOS ignores select() on a textarea and wants the range said outright
    box.setSelectionRange(0, text.length);
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    document.body.removeChild(box);
    // Back to the button that was pressed, so the keyboard is where it was
    kept?.focus?.();
  }
  return copied;
}

/**
 * A button that copies a card as plain text, and says so for a moment.
 *
 * The cards on the lineup and pitching pages were a screenful of table that
 * could not leave the app: pasting one into a message, a note or a forum meant
 * retyping it. The text is built when the button is pressed, from whatever the
 * page is showing then, so what is copied is what was on the screen.
 *
 * "Copied" fades out by itself, and a failure stays up longer, since that one
 * is news. The note sits in a status region that is always on the page, so a
 * screen reader is told when it fills.
 */
export function CopyButton({ label, text, className }: {
  label: string;
  text: () => string;
  className?: string;
}) {
  const [note, setNote] = useState<'copied' | 'failed' | null>(null);
  const [fading, setFading] = useState(false);
  const timers = useRef<number[]>([]);
  const clear = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };
  // Leaving the page with the note still up must not leave a timer behind
  useEffect(() => clear, []);

  const press = async () => {
    const ok = await copyText(text());
    clear();
    setNote(ok ? 'copied' : 'failed');
    setFading(false);
    timers.current = [
      window.setTimeout(() => setFading(true), ok ? 1200 : 3000),
      window.setTimeout(() => setNote(null), ok ? 1800 : 3600),
    ];
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <button type="button" className={className} onClick={() => void press()}>
        {label}
      </button>
      {/* Drawn in at once and faded out over the last half-second, which is
          the only time the transition is switched on */}
      <span
        role="status"
        className={note === 'failed' ? 'warn' : 'ok'}
        style={{
          opacity: note !== null && !fading ? 1 : 0,
          transition: fading ? 'opacity 0.6s ease' : 'none',
        }}
      >
        {note === 'copied' ? 'Copied' : note === 'failed' ? 'Could not copy' : ''}
      </span>
    </span>
  );
}

/**
 * The card as plain text, for pasting into a message, a note or a forum.
 *
 * One line to a man, with the position he plays and the side he bats from,
 * which is what a lineup card says. The header carries what the card was built
 * for, because pasted away from the page nothing else will: the hand it is
 * against, how it was ordered, and tonight's game when there is one. Written
 * from what the page was handed rather than read back off the screen.
 */
export function lineupCard(
  data: LineupResponse,
  extras: { next?: NextGame | null; sort?: 'talent' | 'production' } = {}
): string {
  const built = [
    data.style === 'trad' ? 'Traditional' : 'Sabermetric',
    extras.sort === 'production' ? 'by production' : extras.sort === 'talent' ? 'by talent' : null,
    data.usesDH === undefined ? null : data.usesDH ? 'with DH' : 'no DH',
  ].filter((part): part is string => part !== null);
  const lines = [`Lineup vs ${data.vs === 'l' ? 'LHP' : 'RHP'} (${built.join(', ')})`];

  const game = extras.next;
  if (game) {
    const who = [
      game.theirStarter && `their probable: ${game.theirStarter.name} (${game.theirStarter.throws}HP)`,
      game.ourStarter && `ours: ${game.ourStarter.name}`,
    ].filter(Boolean);
    lines.push(
      `Tonight, ${game.date}: ${game.isHome ? 'vs' : '@'} ${game.opponent}` +
        (who.length > 0 ? ` (${who.join('; ')})` : '')
    );
  }

  lines.push('');
  for (const l of data.lineup) {
    lines.push(`${l.slot}. ${l.name}, ${l.positionName} (bats ${l.bats})${l.dayToDay ? ' - day-to-day' : ''}`);
  }

  const aside: string[] = [];
  if (data.bench.length > 0) {
    aside.push(`Bench: ${data.bench.map((b) => `${b.name} (${b.positionName})`).join(', ')}`);
  }
  if (data.unavailable.length > 0) {
    aside.push(
      `Unavailable: ${data.unavailable
        .map((u) => `${u.name} (${u.positionName}, ${u.status}${daysShort(u) ? `, ${daysShort(u)}` : ''})`)
        .join(', ')}`
    );
  }
  if (aside.length > 0) lines.push('', ...aside);

  return lines.join('\n');
}

export function Lineup({ teamId }: { teamId: number }) {
  const [vs, setVs] = useState<'r' | 'l'>('r');
  const [style, setStyle] = useState<'saber' | 'trad'>('saber');
  const [dh, setDh] = useState<'auto' | 'on' | 'off'>('auto');
  // Talent is OOTP's projection and stays the default; production is what has
  // actually happened. They answer different questions, so both are on offer
  const [sort, setSort] = useState<'talent' | 'production'>('talent');
  const [data, setData] = useState<LineupResponse | null>(null);
  const [next, setNext] = useState<NextGame | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<NextGame | null>(`/api/next-game/${teamId}`)
      .then((g) => {
        setNext(g);
        // Default the platoon side to tonight's actual opposing starter
        if (g?.theirStarter?.throws === 'L') setVs('l');
      })
      .catch(() => {});
  }, [teamId]);

  useEffect(() => {
    setData(null);
    setError(null);
    getLineup(teamId, vs, style, dh, sort).then(setData).catch((e) => setError(e.message));
  }, [teamId, vs, style, dh, sort]);

  // Switching clubs can mean switching leagues, so the override goes back to
  // following the rule rather than silently carrying to another team's card
  useEffect(() => setDh('auto'), [teamId]);

  return (
    <div>
      {next && (
        <div className="next-game-banner">
          <span className="story-category">Tonight · {leagueDay(next.date)}</span>
          <span>
            {next.isHome ? 'vs' : '@'} <strong>{next.opponent}</strong>
            {next.theirStarter && (
              <>
                {' — their probable: '}
                <PlayerLink id={next.theirStarter.player_id}>{next.theirStarter.name}</PlayerLink>{' '}
                ({next.theirStarter.throws}HP)
              </>
            )}
            {next.ourStarter && (
              <>
                {' · ours: '}
                <PlayerLink id={next.ourStarter.player_id}>{next.ourStarter.name}</PlayerLink>
              </>
            )}
          </span>
          {/*
            The card is already built for tonight's man by default, and said so
            nowhere — a reader asked for a lineup against the probable starter
            without realising he was looking at one. It says which of the two
            it is now, rather than only offering the button when he has wandered
            off.
          */}
          {next.theirStarter &&
            (vs === (next.theirStarter.throws === 'L' ? 'l' : 'r') ? (
              <span className="built-for">
                ✓ Card built for {next.theirStarter.name}
              </span>
            ) : (
              <button onClick={() => setVs(next.theirStarter!.throws === 'L' ? 'l' : 'r')}>
                Build vs {next.theirStarter.name}
              </button>
            ))}
          {/*
            The plan for this game (their starter, how our hitters have done
            against him, who to be careful with) was reachable only by finding
            the game in the schedule. It is one click from the game it is for.
          */}
          <GamePlanLink game={next.game_id} />
        </div>
      )}
      <div className="toolbar">
        <div className="tabs">
          <button className={style === 'saber' ? 'active' : ''} onClick={() => setStyle('saber')}>
            Sabermetric
          </button>
          <button className={style === 'trad' ? 'active' : ''} onClick={() => setStyle('trad')}>
            Traditional
          </button>
        </div>
        <div className="tabs">
          <button className={vs === 'r' ? 'active' : ''} onClick={() => setVs('r')}>
            vs RHP
          </button>
          <button className={vs === 'l' ? 'active' : ''} onClick={() => setVs('l')}>
            vs LHP
          </button>
        </div>
        {/* What the order is built from. Not gated on the roster loading —
            it is a preference, and it should be there to set while it does */}
        <div className="tabs">
          <button className={sort === 'talent' ? 'active' : ''} onClick={() => setSort('talent')}>
            By talent
          </button>
          <button
            className={sort === 'production' ? 'active' : ''}
            onClick={() => setSort('production')}
          >
            By production
          </button>
        </div>
        {/* The rule is read from the save; this only changes the card on screen */}
        {data && (
          <div className="tabs">
            <button
              className={data.usesDH ? 'active' : ''}
              onClick={() => setDh(data.leagueUsesDH === true ? 'auto' : 'on')}
            >
              With DH
            </button>
            <button
              className={!data.usesDH ? 'active' : ''}
              onClick={() => setDh(data.leagueUsesDH === false ? 'auto' : 'off')}
            >
              No DH
            </button>
          </div>
        )}
        {/* The card as it is on screen, as plain text for a message or a note */}
        {data && <CopyButton label="Copy lineup" text={() => lineupCard(data, { next, sort })} />}
      </div>
      {error && <div className="banner error">{error}</div>}
      {!data && !error && <p className="muted">Building lineup…</p>}
      {data && (
        <>
          <MethodNote pageKey="lineup" summary={ORDERING[style]}>
            <p className="muted hint-line">
              {ORDERING[style]}{' '}
              {sort === 'talent' ? (
                <>
                  Ranked on OOTP's offensive value {vs === 'r' ? 'vs right-handed' : 'vs left-handed'} pitching —
                  a projection from current ratings, not this season's results.
                </>
              ) : (
                <>
                  Ranked on this season's wRC+, regressed toward league average on plate appearances so a
                  hot twenty at-bats does not lead off. Not platoon-split: the production sort reads the
                  whole season, so the vs-LHP/RHP choice only moves the defensive assignment.
                </>
              )}
            </p>
          </MethodNote>
          {/*
            What follows says something about the card in front of you rather
            than about the method, so it is not in the note: one nobody opens
            would hide it for good. The search is said out loud because it is a
            claim the reader can check, and because a card that quietly
            rearranges itself is unnerving.
          */}
          {data.runSearch?.moved && data.runSearch.gain >= 1 && (
            <p className="muted hint-line">
              Then searched: swapping pairs against an expected-runs model moved this card from{' '}
              {data.runSearch.seededRuns.toFixed(1)} to {data.runSearch.optimisedRuns.toFixed(1)} runs
              a season,{' '}
              <strong>+{data.runSearch.gain.toFixed(1)}</strong> in {data.runSearch.evaluations} tries. The model
              leaves out double plays and steals, so read that as an estimate.
            </p>
          )}
          {data.dhOverridden ? (
            <p className="muted hint-line">
              <strong>
                {data.usesDH
                  ? 'Showing a DH card, which this league does not use.'
                  : 'Showing a no-DH card, which this league does not use.'}
              </strong>
            </p>
          ) : (
            data.usesDH === false && (
              <p className="muted hint-line">
                This league bats no designated hitter, so the order is eight position players with
                tonight&rsquo;s starting pitcher batting ninth.
              </p>
            )
          )}
          <table>
            <thead>
              <tr>
                <th></th>
                <Th>Player</Th>
                <Th>Pos</Th>
                <th>
                  <Tip
                    label="Glove"
                    tip="OOTP's 20-80 fielding rating for this player at the position he is assigned. Positions are chosen on offence adjusted for defence, then swapped wherever two men are better suited the other way round — so the best bat plays the spot he can actually field."
                  />
                </th>
                <Th>B</Th>
                <th>
                  <Tip label="Off Value" tip={TIP_OFF_VALUE} />
                </th>
                <Th>PA</Th>
                <Th>OPS</Th>
                <th><Tip label="OPS+" tip={TIP_OPS_PLUS} /></th>
                <th><Tip label="wRC+" tip={TIP_WRC_PLUS} /></th>
                <Th>WAR</Th>
                <Th>Why here</Th>
              </tr>
            </thead>
            <tbody>
              {data.lineup.map((l) => (
                <tr key={l.slot}>
                  <td className="slot-num">{l.slot}</td>
                  <td className="name">
                    <PlayerLink id={l.player_id}>{l.name}</PlayerLink>
                    {l.dayToDay && (
                      <Tip
                        label=" DTD"
                        tip="Day-to-day. OOTP will let you play him, so he is still on the card — but check him before you post it."
                      />
                    )}
                  </td>
                  <td>{l.positionName}</td>
                  {/* A designated hitter is not fielding anywhere, so there is
                      no rating to show — an empty glove is the honest answer */}
                  <td className="num">{l.defRating ?? '—'}</td>
                  <td>{l.bats}</td>
                  {/* A pitcher has no scouted offensive value; 0 would read as
                      a measured one rather than "does not apply" */}
                  <td className="num">{l.positionName === 'P' ? '—' : Math.round(l.off)}</td>
                  <td className="num">{l.pa ?? ''}</td>
                  <td className="num">{l.ops !== null ? l.ops.toFixed(3).replace(/^0\./, '.') : ''}</td>
                  <td className="num" style={{ color: plusColor(l.opsPlus) }}>{l.opsPlus ?? ''}</td>
                  <td className="num" style={{ color: plusColor(l.wrcPlus) }}>{l.wrcPlus ?? ''}</td>
                  <td className="num">{l.war !== null ? l.war.toFixed(1) : ''}</td>
                  <td className="reasons">{l.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.bench.length > 0 && (
            <p className="muted">
              Bench: {data.bench.map((b) => `${b.name} (${b.positionName})`).join(', ')}
            </p>
          )}
          {data.unavailable.length > 0 && (
            <p className="muted">
              Unavailable:{' '}
              {data.unavailable
                .map(
                  (u) =>
                    `${u.name} (${u.positionName} · ${u.status}${
                      daysShort(u) ? `, ${daysShort(u)}` : ''
                    })`
                )
                .join(', ')}
            </p>
          )}
        </>
      )}
    </div>
  );
}
