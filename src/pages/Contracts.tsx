import { Fragment, useEffect, useState } from 'react';
import { getContracts, type ContractsResponse, type TeamFinances } from '../api';
import { PlayerLink, Tip, TIP_TALENT, TIP_VALUE } from '../playerModal';
import { Th } from '../Th';
import { define } from '../glossary';
import { describeService, formatMoney, formatService, pctColor, plural, SERVICE_NOTATION } from '../stats';
import { navigate, useRoute } from '../route';

/**
 * The three actions that make a man an extension candidate: the same list
 * server/contracts.ts's isExtensionAction holds, which is what the dashboard
 * chip counts, so the chip and this filter cannot disagree.
 */
const EXTENSION_ACTIONS = new Set(['Extension candidate', 'Extend now', 'Extend (value only)']);

/**
 * Still exported from here because the Free Agents page imports it from here.
 * The formatting itself is in stats.ts, with the rest of the shared formats, so
 * that a negative reads -$16.5M on every page and not only on this one.
 */
export const money = formatMoney;

/** What a deal would run to, as the server works it out from recent signings. */
interface Terms {
  /** Null, with `aav`, when fewer than three comparable deals were found. */
  years: number | null;
  aav: number | null;
  comparables: number;
  /** Who the comparables were, for a tooltip. */
  basis: string;
}

interface Deadline {
  kind: 'free-agency' | 'arbitration' | 'none';
  afterSeason: number | null;
  label: string;
}

/**
 * A row as this page reads it.
 *
 * The advice fields are declared here and not on ContractRow in api.ts, which
 * the page shares and which does not carry them yet. They are optional so that
 * a server that predates them still draws the page.
 */
type Row = ContractsResponse['players'][number] & {
  urgencyTier?: 1 | 2 | 3 | 4;
  urgencyRank?: number;
  noActionReason?: string | null;
  terms?: Terms | null;
  deadline?: Deadline;
};

/**
 * Exact service days, when the server sends them.
 *
 * It sends the figure as a decimal rounded to two places, and a day count
 * recovered from that can be one out. Days are used as soon as they are there,
 * and until then the column converts from the decimal.
 */
const serviceDaysOf = (p: ContractsResponse['players'][number]): number | null | undefined =>
  (p as { serviceDays?: number | null }).serviceDays;

/**
 * Budget less OOTP's own estimate of next year's payroll.
 *
 * One definition because two things quote it, the card below and the line over
 * the terms, and they have to be the same number. It is the estimate and not the
 * signed total the Payroll page charts, which is why both say so.
 */
export const roomNextSeason = (finances: TeamFinances): number =>
  finances.budget - finances.payrollNextSeason;

export function FinanceCards({ finances }: { finances: TeamFinances | null }) {
  if (!finances) return null;
  const room = finances.budget - finances.payroll;
  const roomNext = roomNextSeason(finances);
  // Next year's figure is OOTP's own estimate. It was labelled "Committed", the
  // word the Payroll page uses for signed deals only, and the two are not the
  // same number: $298.5M against $266.5M on one save
  const cards: Array<[string, string, string?]> = [
    ['Budget', money(finances.budget)],
    ['Payroll', money(finances.payroll)],
    ['Room now', money(room), room < 0 ? 'bad' : 'good'],
    ['Payroll next yr (OOTP est.)', money(finances.payrollNextSeason)],
    ['Room next yr (OOTP est.)', money(roomNext), roomNext < 0 ? 'bad' : 'good'],
    ['Cash', money(finances.cash)],
  ];
  return (
    <div className="cards">
      {cards.map(([label, value, tone]) => (
        <div key={label} className="card">
          <span className="card-label">{label}</span>
          <span className={`card-value ${tone ?? ''}`}>{value}</span>
        </div>
      ))}
    </div>
  );
}

export function Pct({ value }: { value: number | null }) {
  if (value === null) return <span className="muted">—</span>;
  return <span style={{ color: pctColor(value) }}>{value}</span>;
}

/**
 * What happens to this man at the end of the season, in the order a GM worries
 * about it. The flags already say this per player, but a page of thirty rows
 * does not answer "who am I about to lose" at a glance — which is the question
 * the offseason is actually about.
 */
export type Status = 'freeAgency' | 'arbitration' | 'preArb' | 'reserve' | 'signed';

const STATUS_LABEL: Record<Status, string> = {
  freeAgency: 'Hitting free agency',
  arbitration: 'Arbitration',
  preArb: 'Pre-arbitration',
  reserve: 'Reserve clause',
  signed: 'Under contract',
};

/**
 * One chip per flag, with a plain space between them.
 *
 * The chips were separated only by a margin, so anything that reads the page as
 * text — copying a row, a screen reader, a text export — got "EXPIRINGNO-TRADE"
 * as a single word.
 */
export function Flags({ flags }: { flags: string[] }) {
  return (
    <>
      {flags.map((f, i) => (
        <Fragment key={f}>
          {i > 0 && ' '}
          <span
            className={`flag ${f === 'expiring' ? 'flag-hot' : ''}${
              f.startsWith('extended thru') ? 'flag-locked' : ''
            }`}
          >
            {f}
          </span>
        </Fragment>
      ))}
    </>
  );
}

/** Same precedence the flags use, so the two can never disagree. */
function statusOf(p: ContractsResponse['players'][number]): Status {
  if (p.flags.some((f: string) => f.startsWith('extended thru'))) return 'signed';
  if (p.flags.includes('reserve clause')) return 'reserve';
  if (p.flags.includes('expiring')) return 'freeAgency';
  if (p.flags.some((f: string) => f.startsWith('arbitration'))) return 'arbitration';
  if (p.flags.includes('pre-arbitration')) return 'preArb';
  return 'signed';
}

/**
 * What a deal would run to. The figure is the median of recent comparable deals;
 * the tooltip says whose, because a number with no source is a number to argue with.
 */
function TermsCell({ terms }: { terms?: Terms | null }) {
  if (!terms) return <span className="muted">—</span>;
  if (terms.years === null || terms.aav === null) {
    return <span title={terms.basis}>no comparables</span>;
  }
  return (
    <div title={terms.basis}>
      <strong className="rec-action">
        {plural(terms.years, 'yr')}, {money(terms.aav)} a year
      </strong>
      <div>median of {terms.comparables} similar deals</div>
    </div>
  );
}

/**
 * Next season's room beside what the suggested deals would cost.
 *
 * Only the men whose deals end and who can leave are added up. Their pay is
 * already off next season's books, so a deal for any of them is new money
 * against exactly this room; a man the club keeps through arbitration is in
 * OOTP's estimate already, and adding his new deal on top would count him twice.
 * The room itself is the figure on the cards above, from the same function.
 */
function RoomLine({ rows, finances }: { rows: Row[]; finances: TeamFinances | null }) {
  if (!finances) return null;
  const room = roomNextSeason(finances);
  const priced = rows.filter((r) => r.urgencyTier === 1 && typeof r.terms?.aav === 'number');
  const total = priced.reduce((sum, r) => sum + (r.terms?.aav ?? 0), 0);
  return (
    <p className="muted hint-line">
      Room next season:{' '}
      <strong className={room < 0 ? 'bad-text' : 'good-text'}>{money(room)}</strong> (budget less
      OOTP&rsquo;s estimate of next year&rsquo;s payroll).
      {priced.length > 0 && (
        <>
          {' '}Re-signing the {plural(priced.length, 'player')} reaching free agency who{' '}
          {priced.length === 1 ? 'has' : 'have'} suggested terms would take {money(total)} a year of it.
        </>
      )}
    </p>
  );
}

export function Contracts({ orgId }: { orgId: number }) {
  const [data, setData] = useState<ContractsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  /*
   * The dashboard's chips arrive with their filter in the address: "expiring"
   * is the free-agency group, and "extension" the rows the extension chip
   * counted. The address is read once for the starting filter; a chip clicked
   * here rewrites it in place, so Back still leaves the page rather than
   * replaying every filter.
   */
  const { params } = useRoute();
  const [only, setOnly] = useState<Status | null>(params.flag === 'expiring' ? 'freeAgency' : null);
  const extensionOnly = params.action === 'extension';
  const choose = (next: Status | null) => {
    setOnly(next);
    navigate('contracts', { flag: next === 'freeAgency' ? 'expiring' : undefined }, { replace: true });
  };
  const clearExtension = () => navigate('contracts', { flag: params.flag }, { replace: true });

  useEffect(() => {
    setData(null);
    getContracts(orgId).then(setData).catch((e) => setError(e.message));
  }, [orgId]);

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="muted">Loading contracts…</p>;
  return (
    <ContractsView
      data={data}
      only={only}
      onOnly={choose}
      extensionOnly={extensionOnly}
      onClearExtension={clearExtension}
    />
  );
}

/**
 * The page once its data is in. Apart from the fetch so that it can be drawn
 * from a payload alone, which is how the tests read what a man would see.
 */
export function ContractsView({ data, only, onOnly, extensionOnly = false, onClearExtension }: {
  data: ContractsResponse;
  only: Status | null;
  onOnly: (status: Status | null) => void;
  /** Only the rows the dashboard's extension chip counted. */
  extensionOnly?: boolean;
  onClearExtension?: () => void;
}) {
  // By urgency, which the server numbers: the order is its judgment and the page
  // only follows it. A server that predates the numbering leaves the order as sent.
  const players = [...(data.players as Row[])].sort(
    (a, b) => (a.urgencyRank ?? 0) - (b.urgencyRank ?? 0)
  );

  // Groups in the order they matter, skipping any the club does not have
  const groups = (['freeAgency', 'arbitration', 'preArb', 'reserve', 'signed'] as Status[])
    .map((key) => {
      const inGroup = players.filter((p) => statusOf(p) === key);
      return { key, players: inGroup, money: inGroup.reduce((sum, p) => sum + (p.salaryNow ?? 0), 0) };
    })
    .filter((g) => g.players.length > 0);

  const byStatus = only ? players.filter((p) => statusOf(p) === only) : players;
  const shown = extensionOnly
    ? byStatus.filter((p) => EXTENSION_ACTIONS.has(p.recommendation?.action ?? ''))
    : byStatus;

  return (
    <div>
      <FinanceCards finances={data.finances} />

      <section>
        <h2>After {data.seasonYear}</h2>
        <div className="status-chips">
          {groups.map((g) => (
            <button
              key={g.key}
              className={`status-chip ${only === g.key ? 'active' : ''}`}
              onClick={() => onOnly(only === g.key ? null : g.key)}
            >
              <strong>{g.players.length}</strong>
              <span>{STATUS_LABEL[g.key]}</span>
              <span className="muted">{money(g.money)}</span>
            </button>
          ))}
          {only && (
            <button className="link-button" onClick={() => onOnly(null)}>
              Show everyone
            </button>
          )}
        </div>
        {extensionOnly && (
          <p className="muted hint-line">
            Showing the {plural(shown.length, 'extension candidate')} the dashboard counted.{' '}
            <button className="link-button" onClick={onClearExtension}>
              Show everyone
            </button>
          </p>
        )}
        <p className="muted hint-line">
          Free agency means he can leave; arbitration and pre-arbitration mean the club keeps him
          whether he likes it or not, at a price the process sets. Salary is this season&rsquo;s; the
          Terms column is what players like him were recently given.
        </p>
      </section>

      <p className="muted hint-line">
        Sorted by urgency: players who can leave this winter first, then arbitration cases, then
        extension calls, then everyone else, best value first within each. Value/Talent are
        percentiles against MLB-rostered players in the same role — position players, starters and
        relievers ranked separately. They are OOTP&rsquo;s own figures, and they are worth to the club
        rather than performance: playing time counts towards them, so a man who has soaked up
        innings or plate appearances badly can still rank high. That is why every recommendation
        here quotes what he has actually done this season.
      </p>
      <RoomLine rows={players} finances={data.finances} />
      <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <Th>Player</Th>
            <Th>Pos</Th>
            <Th>Age</Th>
            <Th>Salary</Th>
            <Th>Thru</Th>
            <Th>Yrs left</Th>
            <Th tip={`${define('Svc') ?? ''} ${SERVICE_NOTATION}`.trim()}>Svc</Th>
            <th><Tip label="Value" tip={TIP_VALUE} /></th>
            <th><Tip label="Talent" tip={TIP_TALENT} /></th>
            <Th>Flags</Th>
            <Th>Recommendation</Th>
            <Th tip="Length and average annual value of a deal for him, as the median of deals of two years or more that players of similar value, age and role were recently given in this league. 'No comparables' means fewer than three. Hover a figure to see who they were.">
              Terms
            </Th>
            <Th tip="When the decision stops being free to make: free agency or the arbitration filing, after the season named. None where nothing is time-boxed.">
              Deadline
            </Th>
          </tr>
        </thead>
        <tbody>
          {shown.map((p) => (
            <tr key={p.player_id}>
              <td className="name"><PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
              <td>{p.positionName}</td>
              <td>{p.age}</td>
              <td className="num">{money(p.salaryNow)}</td>
              <td className="num">{p.endYear}</td>
              <td className="num">{p.yearsAfterThis}</td>
              <td className="num" title={describeService(p.serviceYears, serviceDaysOf(p)) || undefined}>
                {formatService(p.serviceYears, serviceDaysOf(p))}
              </td>
              <td className="num"><Pct value={p.overallPct} /></td>
              <td className="num"><Pct value={p.talentPct} /></td>
              <td><Flags flags={p.flags} /></td>
              <td className="reasons">
                {p.recommendation ? (
                  <>
                    <strong className="rec-action">{p.recommendation.action}</strong>
                    {p.recommendation.reasons.length > 0 && <> — {p.recommendation.reasons.join('; ')}</>}
                  </>
                ) : (
                  // Never an empty cell: with nothing to do, say why
                  p.noActionReason ?? 'nothing to decide'
                )}
              </td>
              <td className="reasons" style={{ maxWidth: 200 }}><TermsCell terms={p.terms} /></td>
              <td className="reasons" style={{ maxWidth: 200 }}>
                {p.deadline && p.deadline.kind !== 'none' ? p.deadline.label : 'none'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}
