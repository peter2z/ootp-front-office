import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '../api';
import { PlayerLink, Tip } from '../playerModal';
import { daysLong, daysShort } from '../injury';
import { findStat, formatStat, plusColor as statPlusColor } from '../stats';
import { Th } from '../Th';
import { MethodNote } from '../MethodNote';
import { CopyButton } from './Lineup';

/** The first thing the page's note says, and so the line shown while the note is folded. */
const ROTATION_SOURCE = 'Rotation order comes from the save’s own projected starters.';

const TIP_STAMINA =
  "OOTP's stamina rating on the same 1-100 scale as the other ratings. It drives how deep a " +
  'starter can go before he tires, and whether a reliever can cover more than an inning.';
const TIP_FIP =
  findStat('pitching', 'fip')?.desc ??
  'Fielding Independent Pitching — ERA rebuilt from only strikeouts, walks, and home runs.';
const TIP_ERA_PLUS = findStat('pitching', 'eraPlus')?.desc ?? '';
const TIP_P3D =
  "Pitches thrown across the three days before tonight's game. This is " +
  'the number that decides whether an arm is really available tonight, regardless of how good ' +
  'his season line looks.';
const TIP_REST = 'Days since this pitcher last appeared in a game.';

const ERA_PLUS_DEF = findStat('pitching', 'eraPlus');

const plusColor = (value: number | null | undefined): string | undefined =>
  ERA_PLUS_DEF ? statPlusColor(ERA_PLUS_DEF, value) : undefined;

/**
 * Uses the shared formatter so a pitcher with a 0.00 ERA reads as an infinite
 * ERA+ here exactly as it does on the roster and player-search pages.
 */
const eraPlusText = (stats: Stats | null): string => {
  if (!ERA_PLUS_DEF || !stats) return '';
  return formatStat(ERA_PLUS_DEF, stats.eraPlus, stats as unknown as Record<string, number | null>);
};

interface Stats {
  era: number | null; eraPlus: number | null; fip: number | null; whip: number | null;
  ip: number | null; k9: number | null; kbb: number | null; sv: number | null; hld: number | null;
  g: number | null; gs: number | null; w: number | null; l: number | null; war: number | null;
}
interface Arm {
  player_id: number;
  name: string;
  age: number;
  throws: string;
  stamina: number | null;
  velocity: number | null;
  daysRest: number | null;
  lastOuting: { date: string; pitches: number; outs: number } | null;
  /** `playable` is false only for the injured list; day-to-day men can pitch. */
  injury: { status: string; daysLeft: number | null; durationUnknown: boolean; playable: boolean } | null;
  stats: Stats | null;
}
interface Starter extends Arm {
  slot: number | null;
  projected: boolean;
  nextStartInDays: number | null;
}
export interface Reliever extends Arm {
  isCloser: boolean;
  status: string;
  tone: 'ok' | 'warn' | 'bad';
  pitchesLast3: number;
  appearancesLast3: number;
  /**
   * Who to use in his place when he is limited or out: the best available
   * arm, or null when nobody can go. Absent in an export made before it was
   * sent, and then there is nothing to show.
   */
  instead?: { player_id: number; name: string; label: string } | null;
}
interface PitchingData {
  today: number | null;
  rotation: Starter[];
  starterDepth: Starter[];
  bullpen: Reliever[];
  tired: number;
  injured: number;
}

const era = (v: number | null | undefined) => (v === null || v === undefined ? '' : v.toFixed(2));
const num = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));

/** A date key (20280515) the way OOTP writes a date everywhere else in the app: 2028-5-15. */
const keyDate = (key: number): string =>
  `${Math.floor(key / 10000)}-${Math.floor(key / 100) % 100}-${key % 100}`;

/**
 * The bullpen as plain text, for pasting into a message, a note or a forum.
 *
 * One line to an arm, in the order the table has them, with what the table says
 * about him tonight and, where he cannot go, who to use instead. It is the list
 * the page is showing, so an arm on the injured list is in it only when the
 * reader has chosen to see him. The stand-in carries his own availability in
 * parentheses, because pasted away from the table nothing else says why he is
 * the one.
 */
export function bullpenCard(bullpen: Reliever[], today: number | null): string {
  const limited = bullpen.filter((p) => p.tone !== 'ok').length;
  const lines = [
    `Bullpen availability tonight${today === null ? '' : `, ${keyDate(today)}`}` +
      (limited > 0 ? ` (${limited} of ${bullpen.length} limited or unavailable)` : ''),
  ];
  for (const p of bullpen) {
    const tag = [p.isCloser ? 'closer' : null, p.throws === '?' ? null : `throws ${p.throws}`]
      .filter((part): part is string => part !== null)
      .join(', ');
    lines.push(
      `${p.name}${tag ? ` (${tag})` : ''} - ${p.status}` +
        // A day-to-day man reads green on his workload; the card must not lose that he is hurt
        (p.injury?.playable ? ` - ${p.injury.status.toLowerCase()}` : '') +
        (p.instead ? ` - use ${p.instead.name} instead (${p.instead.label})` : '')
    );
  }
  return lines.join('\n');
}

/**
 * What the availability column says about a reliever: the colour that says
 * whether he can go tonight and, beside it where he cannot, who to use instead.
 * It names nobody when nobody can go, since the rest of the column already says
 * so, and for an export made before the page was told who to use.
 */
export function Availability({ arm }: { arm: Reliever }) {
  return (
    <>
      <span className={`avail avail-${arm.tone}`}>{arm.status}</span>
      {arm.instead && (
        <span className="muted">
          {' '}use <PlayerLink id={arm.instead.player_id}>{arm.instead.name}</PlayerLink> instead
        </span>
      )}
    </>
  );
}

function InjuryTag({ injury }: { injury: Arm['injury'] }) {
  if (!injury) return null;
  return (
    <span className="injury-tag" title={daysLong(injury) || undefined}>
      {injury.status}
      {daysShort(injury) && ` ${daysShort(injury)}`}
    </span>
  );
}

export function Pitching({ teamId }: { teamId: number }) {
  const [data, setData] = useState<PitchingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  /*
   * Kept in settings.json rather than in the browser, because the desktop
   * app's origin changes with every version and anything in localStorage goes
   * with it — a preference that resets itself on each update is not one.
   */
  const [showIl, setShowIl] = useState(false);

  useEffect(() => {
    setData(null);
    setError(null);
    apiGet<PitchingData>(`/api/pitching/${teamId}`).then(setData).catch((e) => setError(e.message));
  }, [teamId]);

  useEffect(() => {
    apiGet<{ settings: { showUnavailablePitchers?: boolean } }>('/api/settings')
      .then((r) => setShowIl(r.settings.showUnavailablePitchers === true))
      .catch(() => {});
  }, []);

  const toggleIl = () => {
    const next = !showIl;
    setShowIl(next);
    void apiPost('/api/settings', { showUnavailablePitchers: next });
  };

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="muted">Reading the staff…</p>;

  // Day-to-day men stay: OOTP will let you use them, so that is your call
  const onIl = data.bullpen.filter((p) => p.injury?.playable === false);
  const bullpen = showIl ? data.bullpen : data.bullpen.filter((p) => p.injury?.playable !== false);
  const limited = bullpen.filter((p) => p.tone !== 'ok').length;

  return (
    <div>
      <MethodNote pageKey="pitching" summary={ROTATION_SOURCE}>
        <p className="muted hint-line">
          {ROTATION_SOURCE} Bullpen availability is computed from actual game-by-game pitch counts,
          so it reflects who can really throw tonight rather than who has the best season line.
        </p>
      </MethodNote>

      <section>
        <h2>Rotation</h2>
        {data.rotation.length === 0 ? (
          <p className="muted">No projected rotation in this save.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th></th>
                <Th>Pitcher</Th>
                <Th>T</Th>
                <Th>Age</Th>
                <Th>W-L</Th>
                <Th>IP</Th>
                <Th>ERA</Th>
                <th><Tip label="ERA+" tip={TIP_ERA_PLUS} /></th>
                <th><Tip label="FIP" tip={TIP_FIP} /></th>
                <Th>WHIP</Th>
                <Th>K/9</Th>
                <th><Tip label="Stam" tip={TIP_STAMINA} /></th>
                <th><Tip label="Rest" tip={TIP_REST} /></th>
                <Th>Next start</Th>
              </tr>
            </thead>
            <tbody>
              {data.rotation.map((p) => (
                <tr key={p.player_id}>
                  <td className="slot-num">{p.slot}</td>
                  <td className="name">
                    <PlayerLink id={p.player_id}>{p.name}</PlayerLink>
                    <InjuryTag injury={p.injury} />
                  </td>
                  <td>{p.throws}</td>
                  <td className="num">{p.age}</td>
                  <td className="num">{num(p.stats?.w)}-{num(p.stats?.l)}</td>
                  <td className="num">{num(p.stats?.ip)}</td>
                  <td className="num">{era(p.stats?.era)}</td>
                  <td className="num" style={{ color: plusColor(p.stats?.eraPlus) }}>{eraPlusText(p.stats)}</td>
                  <td className="num">{era(p.stats?.fip)}</td>
                  <td className="num">{era(p.stats?.whip)}</td>
                  <td className="num">{num(p.stats?.k9)}</td>
                  <td className="num">{num(p.stamina)}</td>
                  <td className="num">{p.daysRest === null ? '' : `${p.daysRest}d`}</td>
                  <td className="num">
                    {p.nextStartInDays === null
                      ? ''
                      : p.nextStartInDays === 0
                        ? 'today'
                        : `in ${p.nextStartInDays}d`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>
          Bullpen{' '}
          {limited > 0 && (
            <span className="muted subtle-count">
              — {limited} of {bullpen.length} limited or unavailable
            </span>
          )}
          {onIl.length > 0 && (
            <span className="subtle-count il-toggle">
              <button type="button" className="link-button" onClick={toggleIl}>
                {showIl
                  ? `Hide the ${onIl.length === 1 ? 'arm' : `${onIl.length} arms`} on the IL`
                  : `${onIl.length} on the IL — show`}
              </button>
            </span>
          )}
          {bullpen.length > 0 && (
            <span className="subtle-count il-toggle">
              <CopyButton
                label="Copy bullpen plan"
                className="link-button"
                text={() => bullpenCard(bullpen, data.today)}
              />
            </span>
          )}
        </h2>
        <table>
          <thead>
            <tr>
              <Th>Pitcher</Th>
              <Th>T</Th>
              <Th>IP</Th>
              <Th>ERA</Th>
              <th><Tip label="ERA+" tip={TIP_ERA_PLUS} /></th>
              <th><Tip label="FIP" tip={TIP_FIP} /></th>
              <Th>SV</Th>
              <Th>HLD</Th>
              <th><Tip label="P/3d" tip={TIP_P3D} /></th>
              <Th>App</Th>
              <Th>Availability tonight</Th>
            </tr>
          </thead>
          <tbody>
            {bullpen.map((p) => (
              <tr key={p.player_id}>
                <td className="name">
                  {p.isCloser && <><span className="role-tag">CL</span>{' '}</>}
                  <PlayerLink id={p.player_id}>{p.name}</PlayerLink>
                  <InjuryTag injury={p.injury} />
                </td>
                <td>{p.throws}</td>
                <td className="num">{num(p.stats?.ip)}</td>
                <td className="num">{era(p.stats?.era)}</td>
                <td className="num" style={{ color: plusColor(p.stats?.eraPlus) }}>{eraPlusText(p.stats)}</td>
                <td className="num">{era(p.stats?.fip)}</td>
                <td className="num">{num(p.stats?.sv)}</td>
                <td className="num">{num(p.stats?.hld)}</td>
                <td className="num">{p.pitchesLast3 || ''}</td>
                <td className="num">{p.appearancesLast3 || ''}</td>
                {/* The cell may wrap, or the stand-in widens a column that is
                    already the last one on a table this wide */}
                <td className="wrap-cell">
                  <Availability arm={p} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {data.starterDepth.length > 0 && (
        <section>
          <h2>
            Starting depth{' '}
            <span className="muted subtle-count">— spot starters, long men, and arms on the IL</span>
          </h2>
          <table>
            <thead>
              <tr>
                <Th>Pitcher</Th><Th>T</Th><Th>Age</Th><Th>IP</Th><Th>ERA</Th>
                <th><Tip label="ERA+" tip={TIP_ERA_PLUS} /></th>
                <th><Tip label="Stam" tip={TIP_STAMINA} /></th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {data.starterDepth.map((p) => (
                <tr key={p.player_id}>
                  <td className="name"><PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
                  <td>{p.throws}</td>
                  <td className="num">{p.age}</td>
                  <td className="num">{num(p.stats?.ip)}</td>
                  <td className="num">{era(p.stats?.era)}</td>
                  <td className="num" style={{ color: plusColor(p.stats?.eraPlus) }}>{eraPlusText(p.stats)}</td>
                  <td className="num">{num(p.stamina)}</td>
                  <td>
                    {p.injury ? (
                      <span className="avail avail-bad">
                        {p.injury.status}
                        {daysLong(p.injury) && ` · ${daysLong(p.injury)}`}
                      </span>
                    ) : (
                      <span className="avail avail-ok">Healthy</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
