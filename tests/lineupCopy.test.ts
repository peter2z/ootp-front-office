import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../server/db.js';
import { copyText, CopyButton, GamePlanLink, lineupCard } from '../src/pages/Lineup.js';
import { Availability, bullpenCard, type Reliever } from '../src/pages/Pitching.js';
import { UpNext } from '../src/pages/Dashboard.js';
import { plannedGame } from '../src/pages/Schedule.js';
import { buildHash, currentRoute, parseRoute } from '../src/route.js';
import type { LineupResponse, LineupSlot } from '../src/api.js';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * A lineup or a bullpen card that can leave the app, and a game plan one click
 * from the games it is for.
 *
 * Both cards were a screenful of table with nowhere to go. Sending the order to
 * a coach, pasting it into a note or a forum thread, or keeping it beside the
 * game meant retyping nine names and nine positions; and a red reliever read
 * "Third straight day" and stopped there. The pages now put a plain-text card
 * on the clipboard, and the plan for tonight's game, which lived only in a row
 * of the Schedule, is a link from the dashboard's Up Next list and from the
 * Lineup's banner.
 *
 * What is checked is what a reader would paste, and that nothing stops him.
 * The cards are built by pure functions the pages export, so their shape is
 * checked directly: what a line says, what is left out when there is nothing
 * to say, and that it is plain text. The clipboard is checked against stand-ins
 * for the two ways a browser offers it, because a button that works on
 * localhost and does nothing on a copy of the app served over a network is the
 * way this goes wrong. There is no DOM in this suite to click in, so what a
 * click does is driven by hand in a browser; here the handlers are called
 * through the tree the components return, and the pages are read as source for
 * what only a page can show.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

/* ---------- The lineup card ---------- */

const slot = (
  n: number, name: string, positionName: string, bats: string, over: Partial<LineupSlot> = {}
): LineupSlot => ({
  slot: n, player_id: 100 + n, name, positionName, bats, off: 100, why: '',
  pa: null, ops: null, opsPlus: null, wrcPlus: null, war: null, ...over,
});

/** The nine from the save this was written against. */
const NINE: LineupSlot[] = [
  slot(1, 'Will Smith', 'C', 'R'),
  slot(2, 'Andy Pages', 'RF', 'R'),
  slot(3, 'Shohei Ohtani', 'DH', 'L'),
  slot(4, 'Freddie Freeman', '1B', 'L'),
  slot(5, 'Eduardo Quintero', 'CF', 'R'),
  slot(6, 'Max Muncy', '3B', 'L'),
  slot(7, 'Alex Freeland', 'SS', 'S'),
  slot(8, 'Jackson Holliday', '2B', 'L'),
  slot(9, 'Josue De Paula', 'LF', 'L'),
];

const card = (over: Partial<LineupResponse> = {}): LineupResponse => ({
  vs: 'r', style: 'saber', usesDH: true, leagueUsesDH: true, dhOverridden: false,
  lineup: NINE, bench: [], unavailable: [], ...over,
});

const TONIGHT = {
  date: '2028-5-15',
  isHome: true,
  opponent: 'Pittsburgh Pirates',
  ourStarter: { player_id: 1, name: 'Blake Snell', throws: 'L' },
  theirStarter: { player_id: 2, name: 'Lucas Giolito', throws: 'R' },
};

describe('the lineup card as text', () => {
  it('is a header, then the order, a line to a man', () => {
    const lines = lineupCard(card(), { sort: 'talent' }).split('\n');
    expect(lines[0]).toBe('Lineup vs RHP (Sabermetric, by talent, with DH)');
    expect(lines[1]).toBe('');
    expect(lines.slice(2)).toEqual([
      '1. Will Smith, C (bats R)',
      '2. Andy Pages, RF (bats R)',
      '3. Shohei Ohtani, DH (bats L)',
      '4. Freddie Freeman, 1B (bats L)',
      '5. Eduardo Quintero, CF (bats R)',
      '6. Max Muncy, 3B (bats L)',
      '7. Alex Freeland, SS (bats S)',
      '8. Jackson Holliday, 2B (bats L)',
      '9. Josue De Paula, LF (bats L)',
    ]);
  });

  it('says which hand it is against, how it was ordered, and whether there is a DH', () => {
    // The card pasted away from the page is the only place these are written down
    const text = lineupCard(card({ vs: 'l', style: 'trad', usesDH: false }), { sort: 'production' });
    expect(text.split('\n')[0]).toBe('Lineup vs LHP (Traditional, by production, no DH)');
  });

  it('does not make up what the page was not told', () => {
    // An export with no DH rule in it, and a caller with no sort to give
    expect(lineupCard(card({ usesDH: undefined })).split('\n')[0]).toBe('Lineup vs RHP (Sabermetric)');
  });

  it('puts the pitcher in the ninth place of a card with no DH, as the page does', () => {
    const nl = card({
      usesDH: false,
      lineup: [...NINE.slice(0, 8), slot(9, 'Blake Snell', 'P', 'L')],
    });
    const lines = lineupCard(nl).split('\n');
    expect(lines[lines.length - 1]).toBe('9. Blake Snell, P (bats L)');
  });

  it('flags a day-to-day man, whom the page flags too', () => {
    const hurt = card({ lineup: [slot(1, 'Will Smith', 'C', 'R', { dayToDay: true }), ...NINE.slice(1)] });
    const lines = lineupCard(hurt).split('\n');
    expect(lines[2]).toBe('1. Will Smith, C (bats R) - day-to-day');
    expect(lines[3]).not.toContain('day-to-day');
  });

  describe("and tonight's game", () => {
    it('is the second line, with both probables', () => {
      const lines = lineupCard(card(), { next: TONIGHT }).split('\n');
      expect(lines[1]).toBe(
        'Tonight, 2028-5-15: vs Pittsburgh Pirates (their probable: Lucas Giolito (RHP); ours: Blake Snell)'
      );
      // The blank line and the order follow it
      expect(lines[2]).toBe('');
      expect(lines[3]).toBe('1. Will Smith, C (bats R)');
    });

    it('says @ for a game on the road', () => {
      const away = lineupCard(card(), { next: { ...TONIGHT, isHome: false } }).split('\n')[1];
      expect(away).toMatch(/^Tonight, 2028-5-15: @ Pittsburgh Pirates/);
    });

    it('names no starters it was not given', () => {
      const bare = { ...TONIGHT, ourStarter: null, theirStarter: null };
      expect(lineupCard(card(), { next: bare }).split('\n')[1]).toBe('Tonight, 2028-5-15: vs Pittsburgh Pirates');
      const onlyTheirs = { ...TONIGHT, ourStarter: null };
      expect(lineupCard(card(), { next: onlyTheirs }).split('\n')[1]).toBe(
        'Tonight, 2028-5-15: vs Pittsburgh Pirates (their probable: Lucas Giolito (RHP))'
      );
    });

    it('has no line for a game there is none of', () => {
      expect(lineupCard(card(), { next: null })).not.toContain('Tonight');
      expect(lineupCard(card())).not.toContain('Tonight');
    });
  });

  describe('and the men not in it', () => {
    const betts = { player_id: 7, name: 'Mookie Betts', positionName: 'SS', off: 1045 };
    const dingler = { player_id: 8, name: 'Dillon Dingler', positionName: 'C', off: 991 };
    const star = {
      player_id: 9, name: 'Hurt Star', positionName: 'LF', status: 'IL', daysLeft: 12, durationUnknown: false,
    };

    it('lists the bench and who is out, after a blank line, as the page does under the table', () => {
      const lines = lineupCard(card({ bench: [betts, dingler], unavailable: [star] })).split('\n');
      expect(lines.slice(-4)).toEqual([
        '9. Josue De Paula, LF (bats L)',
        '',
        'Bench: Mookie Betts (SS), Dillon Dingler (C)',
        'Unavailable: Hurt Star (LF, IL, ~12d)',
      ]);
    });

    it('says "no date" for a man out with no return date, which is what the page says', () => {
      const none = { ...star, daysLeft: null, durationUnknown: true };
      expect(lineupCard(card({ unavailable: [none] }))).toContain('Unavailable: Hurt Star (LF, IL, no date)');
    });

    it('leaves out a bench or an injury list with nobody on it, and ends on the last man', () => {
      const text = lineupCard(card());
      expect(text).not.toContain('Bench');
      expect(text).not.toContain('Unavailable');
      expect(text.endsWith('9. Josue De Paula, LF (bats L)')).toBe(true);
    });

    it('leaves out the half that is empty and keeps the other', () => {
      expect(lineupCard(card({ bench: [betts] }))).toMatch(/\n\nBench: Mookie Betts \(SS\)$/);
      expect(lineupCard(card({ unavailable: [star] }))).toMatch(/\n\nUnavailable: Hurt Star/);
    });
  });

  it('is plain text: no markup, no tabs, and nothing outside ASCII that the page did not give it', () => {
    // It goes into a message, a note and a forum, none of which render what a
    // table does. The names here are plain; an accented one passes through.
    const everything = lineupCard(
      card({
        bench: [{ player_id: 7, name: 'Mookie Betts', positionName: 'SS', off: 1 }],
        unavailable: [
          { player_id: 9, name: 'Hurt Star', positionName: 'LF', status: 'IL', daysLeft: 12, durationUnknown: false },
        ],
      }),
      { next: TONIGHT, sort: 'production' }
    );
    expect(everything).toMatch(/^[\x20-\x7e\n]*$/);
    expect(everything).not.toMatch(/[<>*_#|]/);
  });
});

/* ---------- The bullpen card ---------- */

const arm = (id: number, name: string, over: Partial<Reliever> = {}): Reliever => ({
  player_id: id, name, age: 28, throws: 'R', stamina: 50, velocity: 93, daysRest: 2, lastOuting: null,
  injury: null, stats: null, isCloser: false, status: 'Rested 2d', tone: 'ok',
  pitchesLast3: 0, appearancesLast3: 0, instead: null, ...over,
});

const OKERT = { player_id: 29882, name: 'Steven Okert', label: 'Rested 5d' };

/** The pen as it was on the 15th of May: a closer who can go, two who cannot, one who can. */
const PEN: Reliever[] = [
  arm(1544, 'Andres Munoz', { isCloser: true, status: 'Available (13 yesterday)' }),
  arm(38754, 'Jack Dreyer', { throws: 'L', status: '34 pitches yesterday', tone: 'warn', instead: OKERT }),
  arm(37290, 'Grant Anderson', { status: 'Third straight day', tone: 'bad', instead: OKERT }),
  arm(29882, 'Steven Okert', { throws: 'L', status: 'Rested 5d' }),
];

describe('the bullpen card as text', () => {
  it('is a header and a line to an arm, in the order of the table', () => {
    expect(bullpenCard(PEN, 20280515).split('\n')).toEqual([
      'Bullpen availability tonight, 2028-5-15 (2 of 4 limited or unavailable)',
      'Andres Munoz (closer, throws R) - Available (13 yesterday)',
      'Jack Dreyer (throws L) - 34 pitches yesterday - use Steven Okert instead (Rested 5d)',
      'Grant Anderson (throws R) - Third straight day - use Steven Okert instead (Rested 5d)',
      'Steven Okert (throws L) - Rested 5d',
    ]);
  });

  it('says who to use instead, and how he is doing, next to each arm who cannot go', () => {
    const lines = bullpenCard(PEN, 20280515).split('\n');
    const withInstead = lines.filter((l) => l.includes('instead'));
    expect(withInstead).toHaveLength(2);
    for (const line of withInstead) expect(line).toMatch(/ - use Steven Okert instead \(Rested 5d\)$/);
  });

  it('says nothing about a stand-in for a man who has none', () => {
    // Nobody can go: the line says how he is and stops. Absent, as in an older export, reads the same
    const none = [
      arm(1, 'Closer', { isCloser: true, status: 'Third straight day', tone: 'bad', instead: null }),
      arm(2, 'Tired', { status: 'Pitched yesterday (22 pitches)', tone: 'warn', instead: undefined }),
    ];
    const text = bullpenCard(none, 20280515);
    expect(text).not.toContain('instead');
    expect(text.split('\n')[1]).toBe('Closer (closer, throws R) - Third straight day');
    expect(text.split('\n')[2]).toBe('Tired (throws R) - Pitched yesterday (22 pitches)');
  });

  it('leaves the count out when everyone can go', () => {
    expect(bullpenCard([PEN[0], PEN[3]], 20280515).split('\n')[0]).toBe('Bullpen availability tonight, 2028-5-15');
  });

  it('leaves the date out when the save has none to give', () => {
    expect(bullpenCard([PEN[0]], null).split('\n')[0]).toBe('Bullpen availability tonight');
  });

  it('writes the date as the rest of the app does, with no zero in front of the month or the day', () => {
    expect(bullpenCard([PEN[0]], 20280105).split('\n')[0]).toBe('Bullpen availability tonight, 2028-1-5');
  });

  it('does not lose that a green arm is hurt', () => {
    // A day-to-day man reads on his workload and can be green; he is not a clean bill of health
    const sore = arm(5, 'Sore Arm', {
      injury: { status: 'Day-to-day', daysLeft: 2, durationUnknown: false, playable: true },
    });
    expect(bullpenCard([sore], 20280515).split('\n')[1]).toBe('Sore Arm (throws R) - Rested 2d - day-to-day');
  });

  it('does not say twice that a man on the injured list is out', () => {
    const out = arm(6, 'Shelved', {
      status: 'Out about 46 more days', tone: 'bad',
      injury: { status: 'IL-60', daysLeft: 46, durationUnknown: false, playable: false },
    });
    expect(bullpenCard([out], 20280515).split('\n')[1]).toBe('Shelved (throws R) - Out about 46 more days');
  });

  it('leaves out a hand that was not read, rather than print a question mark', () => {
    const unknown = arm(7, 'Mystery', { throws: '?' });
    expect(bullpenCard([unknown], 20280515).split('\n')[1]).toBe('Mystery - Rested 2d');
  });

  it('is plain text', () => {
    expect(bullpenCard(PEN, 20280515)).toMatch(/^[\x20-\x7e\n]*$/);
  });
});

describe('the availability column', () => {
  const cell = (arm: Reliever) => renderToStaticMarkup(createElement(Availability, { arm }));
  const words = (html: string) => html.replace(/<[^>]*>/g, '');

  it('says who to use instead beside the colour that says he cannot go', () => {
    const html = cell(PEN[1]);
    expect(html).toMatch(/^<span class="avail avail-warn">34 pitches yesterday<\/span>/);
    expect(words(html)).toBe('34 pitches yesterday use Steven Okert instead');
  });

  it('makes the stand-in a link to his card, like every other name on the page', () => {
    expect(cell(PEN[1])).toMatch(/<button[^>]*>Steven Okert<\/button>/);
  });

  it('says it for a red arm as well as an amber one', () => {
    expect(cell(PEN[2])).toMatch(/avail-bad">Third straight day<\/span>/);
    expect(words(cell(PEN[2]))).toBe('Third straight day use Steven Okert instead');
  });

  it('says nothing for an arm who can go', () => {
    expect(cell(PEN[0])).toBe('<span class="avail avail-ok">Available (13 yesterday)</span>');
  });

  it('says nothing for an arm who cannot go when nobody can take his place', () => {
    const alone = arm(1, 'Closer', { status: 'Third straight day', tone: 'bad', instead: null });
    expect(cell(alone)).toBe('<span class="avail avail-bad">Third straight day</span>');
  });

  it('draws as it did for an export made before the page was told who to use', () => {
    const old = arm(1, 'Closer', { status: 'Pitched yesterday (22 pitches)', tone: 'warn', instead: undefined });
    expect(cell(old)).toBe('<span class="avail avail-warn">Pitched yesterday (22 pitches)</span>');
  });
});

/* ---------- The clipboard ---------- */

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A stand-in for the page's document, with the one thing the old way of
 * copying needs from it: a textarea that is put in the page, selected, copied
 * from and taken out again. What it saw at the moment of the copy is kept,
 * since the order is the point.
 */
function fakeDocument(copy: () => boolean = () => true) {
  const inPage = new Set<unknown>();
  const box = {
    value: '',
    attributes: {} as Record<string, string>,
    style: {} as Record<string, string>,
    selected: false,
    range: null as [number, number] | null,
    setAttribute(name: string, value: string) { this.attributes[name] = value; },
    focus: vi.fn(),
    select() { this.selected = true; },
    setSelectionRange(from: number, to: number) { this.range = [from, to]; },
  };
  const seen: { inPage?: boolean; selected?: boolean; value?: string } = {};
  const back = vi.fn();
  const doc = {
    body: {
      appendChild: vi.fn((el: unknown) => { inPage.add(el); }),
      removeChild: vi.fn((el: unknown) => { inPage.delete(el); }),
    },
    createElement: vi.fn(() => box),
    activeElement: { focus: back },
    execCommand: vi.fn((command: string) => {
      seen.inPage = inPage.has(box);
      seen.selected = box.selected;
      seen.value = box.value;
      return command === 'copy' && copy();
    }),
  };
  vi.stubGlobal('document', doc);
  return { doc, box, seen, back, inPage };
}

const CARD = 'Lineup vs RHP (Sabermetric)\n\n1. Will Smith, C (bats R)';

describe('copying to the clipboard', () => {
  it('uses the clipboard API where the page has it, and touches nothing else', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { doc } = fakeDocument();
    expect(await copyText(CARD)).toBe(true);
    expect(writeText).toHaveBeenCalledWith(CARD);
    expect(doc.createElement, 'it built a textarea it did not need').not.toHaveBeenCalled();
  });

  it('falls back to a selected textarea where there is no clipboard API', async () => {
    // An address that is neither https nor localhost has none: navigator.clipboard is undefined there
    vi.stubGlobal('navigator', {});
    const { box, seen, doc } = fakeDocument();
    expect(await copyText(CARD)).toBe(true);
    expect(doc.execCommand).toHaveBeenCalledWith('copy');
    // Holding the card, in the page and selected when the copy was asked for
    expect(seen).toEqual({ inPage: true, selected: true, value: CARD });
    expect(box.range).toEqual([0, CARD.length]);
  });

  it('falls back when the clipboard API is there and says no', async () => {
    // Permission refused, or a window that has lost focus
    const writeText = vi.fn(async () => { throw new DOMException('Not allowed', 'NotAllowedError'); });
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { doc } = fakeDocument();
    expect(await copyText(CARD)).toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(doc.execCommand).toHaveBeenCalledWith('copy');
  });

  it('takes the textarea out of the page again, and gives the focus back', async () => {
    vi.stubGlobal('navigator', {});
    const { inPage, back, doc } = fakeDocument();
    await copyText(CARD);
    expect(doc.body.appendChild).toHaveBeenCalledTimes(1);
    expect(inPage.size, 'a textarea was left in the page').toBe(0);
    expect(back, 'the button that was pressed lost its focus').toHaveBeenCalled();
  });

  it('keeps the textarea out of sight and out of the way', async () => {
    vi.stubGlobal('navigator', {});
    const { box } = fakeDocument();
    await copyText(CARD);
    // Read-only so a phone does not raise its keyboard; fixed and invisible so the page does not move
    expect(box.attributes.readonly).toBe('');
    expect(box.style.position).toBe('fixed');
    expect(box.style.opacity).toBe('0');
  });

  it('is false when the browser will not copy either way, and still tidies up', async () => {
    vi.stubGlobal('navigator', {});
    const { inPage } = fakeDocument(() => false);
    expect(await copyText(CARD)).toBe(false);
    expect(inPage.size).toBe(0);
  });

  it('is false, not an error, when copying throws', async () => {
    vi.stubGlobal('navigator', {});
    const { inPage } = fakeDocument(() => { throw new Error('execCommand is disabled'); });
    await expect(copyText(CARD)).resolves.toBe(false);
    expect(inPage.size, 'the textarea stayed in the page after the error').toBe(0);
  });

  it('is false where there is no page at all', async () => {
    vi.stubGlobal('navigator', undefined);
    vi.stubGlobal('document', undefined);
    await expect(copyText(CARD)).resolves.toBe(false);
  });
});

describe('the copy button', () => {
  const draw = (props: Partial<Parameters<typeof CopyButton>[0]> = {}) =>
    renderToStaticMarkup(createElement(CopyButton, { label: 'Copy lineup', text: () => CARD, ...props }));

  it('is a real button, so Enter and Space work and it submits nothing', () => {
    const html = draw();
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Copy lineup<\/button>/);
  });

  it('has an empty status region from the start, which is what a screen reader listens to', () => {
    // A region that is added when the note appears is often not announced; one
    // that is already there and fills is. Nothing is said until it has copied.
    const html = draw();
    expect(html).toMatch(/<span[^>]*role="status"[^>]*><\/span>/);
    expect(html).not.toContain('Copied');
  });

  it('is invisible until it has something to say, and has no fade running', () => {
    // The fade is only switched on for the last half-second; a transition that
    // was always on would also delay "Copied" appearing
    const html = draw();
    expect(html).toMatch(/style="opacity:0;transition:none"/);
  });

  it('does not build the card until it is pressed', () => {
    const text = vi.fn(() => CARD);
    draw({ text });
    expect(text, 'the card was built on every draw').not.toHaveBeenCalled();
  });

  it('takes the style of the place it is put', () => {
    expect(draw({ className: 'link-button' })).toMatch(/<button[^>]*class="link-button"/);
  });
});

/* ---------- Links to the game plan ---------- */

/** Every element in what a component returned, in order, without drawing any of them. */
function elements(node: ReactNode, found: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    node.forEach((child) => elements(child, found));
  } else if (isValidElement(node)) {
    found.push(node);
    elements((node.props as { children?: ReactNode }).children, found);
  }
  return found;
}

const game = (id: number | undefined, opponent: string) => ({
  game_id: id,
  date: '2030-06-02',
  isHome: true,
  opponent,
  ourStarter: { player_id: 1, name: 'Our Ace', throws: 'R' },
  theirStarter: null,
});

describe("the dashboard's Up Next rows", () => {
  const rows = [game(7801, 'Other Club'), game(7802, 'Other Club'), game(7803, 'Farm Hands')];
  const planLinks = (tree: ReactNode) =>
    elements(tree).filter(
      (el) => el.type === 'button' && (el.props as { className?: string }).className === 'link-button'
    );

  it('each have a Plan link', () => {
    const html = renderToStaticMarkup(createElement(UpNext, { games: rows, onNavigate: () => {} }));
    expect((html.match(/>Plan<\/button>/g) ?? []).length).toBe(3);
  });

  it('open the Schedule on that game, with its id in the address', () => {
    const onNavigate = vi.fn();
    const links = planLinks(UpNext({ games: rows, onNavigate }));
    expect(links).toHaveLength(3);
    links.forEach((link, i) => {
      (link.props as { onClick: () => void }).onClick();
      expect(onNavigate).toHaveBeenLastCalledWith('schedule', { game: rows[i].game_id });
    });
    expect(onNavigate).toHaveBeenCalledTimes(3);
  });

  it('write an address the Schedule reads back as the same game', () => {
    const onNavigate = vi.fn();
    (planLinks(UpNext({ games: rows, onNavigate }))[1].props as { onClick: () => void }).onClick();
    const [page, params] = onNavigate.mock.calls[0];
    const address = buildHash(page, params);
    expect(address).toBe('#/schedule?game=7802');
    expect(plannedGame(parseRoute(address).params)).toBe(7802);
  });

  it('say what they do, on hover', () => {
    const html = renderToStaticMarkup(createElement(UpNext, { games: rows, onNavigate: () => {} }));
    expect(html).toContain('title="Open the game plan for this game"');
  });

  it('have no link for a game that carries no id, and the others keep theirs', () => {
    const mixed = [game(7801, 'Other Club'), game(undefined, 'Other Club')];
    const links = planLinks(UpNext({ games: mixed, onNavigate: () => {} }));
    expect(links).toHaveLength(1);
  });

  it('draw no column of links at all when no game carries an id', () => {
    // An export made before the games carried one: an empty column would only
    // take room from the starters in a panel that is already narrow
    const html = renderToStaticMarkup(
      createElement(UpNext, { games: [game(undefined, 'Other Club')], onNavigate: () => {} })
    );
    expect(html).not.toContain('series-plan');
    expect(html).not.toContain('Plan');
  });

  it('still show the games and the starters, as they did', () => {
    const html = renderToStaticMarkup(createElement(UpNext, { games: rows, onNavigate: () => {} }));
    expect(html).toContain('06-02');
    expect(html).toContain('vs Other Club');
    expect(html).toContain('Our Ace');
  });
});

/**
 * The part of a browser the router writes to: an address that pushState and
 * replaceState set. There is no DOM in this suite, so this stands in for one.
 */
function fakeAddressBar() {
  const win = {
    location: { hash: '' },
    history: {
      state: null as unknown,
      pushState(_state: unknown, _title: string, url: string) { win.location.hash = url; },
      replaceState(_state: unknown, _title: string, url?: string) { if (url) win.location.hash = url; },
    },
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal('window', win);
  return win;
}

describe("the Lineup banner's link", () => {
  const link = (game: number | undefined) => GamePlanLink({ game }) as ReactElement | null;

  it('is a button that says what it opens, and says so on hover', () => {
    const html = renderToStaticMarkup(createElement(GamePlanLink, { game: 7801 }));
    expect(html).toMatch(/^<button[^>]*type="button"[^>]*class="link-button"[^>]*>Game plan<\/button>$/);
    expect(html).toContain('title="Open the game plan for this game"');
  });

  it('opens the Schedule on tonight\'s game, with its id in the address', () => {
    const bar = fakeAddressBar();
    (link(7801)!.props as { onClick: () => void }).onClick();
    expect(bar.location.hash).toBe('#/schedule?game=7801');
    // And the Schedule reads from that address the game the banner named
    expect(plannedGame(currentRoute().params)).toBe(7801);
  });

  it('is nothing at all for a game that carries no id', () => {
    expect(link(undefined)).toBeNull();
    expect(renderToStaticMarkup(createElement(GamePlanLink, { game: undefined }))).toBe('');
  });
});

describe('the game a link names', () => {
  it('is the number after game= in the address', () => {
    expect(plannedGame({ game: '7801' })).toBe(7801);
    expect(plannedGame(parseRoute('#/schedule?game=7801').params)).toBe(7801);
  });

  it('is nobody when the address names no game, so the Schedule opens as it always did', () => {
    expect(plannedGame({})).toBeNull();
    expect(plannedGame(parseRoute('#/schedule').params)).toBeNull();
    expect(plannedGame(parseRoute('#/schedule?game=').params)).toBeNull();
  });

  it('is nobody when what it names is not a game id', () => {
    // Somebody's typo, or a link made by hand. A guess would open the wrong plan
    for (const bad of ['abc', '12abc', '1.5', '-3', '0', '1e3', ' 7', '7 ', '99999999999999999999']) {
      expect(plannedGame({ game: bad }), `"${bad}" named a game`).toBeNull();
    }
  });

  it('survives the trip through the address, with a player card open over it', () => {
    const address = buildHash('schedule', { game: 7801 }, 35502);
    const route = parseRoute(address);
    expect(route.page).toBe('schedule');
    expect(route.player).toBe(35502);
    expect(plannedGame(route.params)).toBe(7801);
  });
});

describe('the pages', () => {
  const lineup = read('src/pages/Lineup.tsx');
  const pitching = read('src/pages/Pitching.tsx');
  const dashboard = read('src/pages/Dashboard.tsx');
  const schedule = read('src/pages/Schedule.tsx');

  // Booleans rather than toMatch on the source, whose failure would print the whole page
  it('put a Copy lineup button beside the controls, once the card has loaded', () => {
    expect(/\{data && <CopyButton label="Copy lineup"/.test(lineup), 'no Copy lineup button on a loaded card').toBe(true);
    expect(/lineupCard\(data, \{ next, sort \}\)/.test(lineup), 'the card is not built from what is on screen').toBe(true);
  });

  it('put a Copy bullpen plan button on the bullpen, built from the arms that are shown', () => {
    expect(/label="Copy bullpen plan"/.test(pitching), 'no Copy bullpen plan button').toBe(true);
    // `bullpen` there is the list after the injured-list filter, not data.bullpen
    expect(/bullpenCard\(bullpen, data\.today\)/.test(pitching), 'the card is not the list on screen').toBe(true);
  });

  it('draw the availability column from the component that names who to use instead', () => {
    expect(/<td className="wrap-cell">\s*<Availability arm=\{p\} \/>\s*<\/td>/.test(pitching), 'the cell no longer says who to use').toBe(true);
  });

  it("put the link to tonight's game plan in the Lineup's banner, made from the game it is about", () => {
    expect(/<GamePlanLink game=\{next\.game_id\} \/>/.test(lineup), 'the banner has no link to the plan').toBe(true);
  });

  it('draw the dashboard Up Next list from the component that carries the links', () => {
    expect(/<UpNext games=\{data\.upcoming\} onNavigate=\{onNavigate\} \/>/.test(dashboard)).toBe(true);
    expect(/onNavigate\('schedule', \{ game: g\.game_id \}\)/.test(dashboard), 'the row does not name the game').toBe(true);
  });

  it('let the Schedule read the open plan from the address and write it back there', () => {
    expect(/plannedGame\(params\)/.test(schedule), 'the Schedule never reads the game from the address').toBe(true);
    expect(/setPlanGame/.test(schedule), 'the plan is also held in state, which can disagree with the address').toBe(false);
    // Opening and closing a plan rewrites the entry; a step to undo would put a plan between the reader and Back
    expect(/navigate\('schedule', \{ \.\.\.params, game \}, \{ replace: true, player \}\)/.test(schedule)).toBe(true);
  });

  it('keep the Plan and Close buttons of the Schedule, which now go through the address', () => {
    expect(/showPlan\(planGame === g\.game_id \? null : g\.game_id\)/.test(schedule), 'Plan no longer toggles').toBe(true);
    expect(/onClose=\{\(\) => showPlan\(null\)\}/.test(schedule), 'Close no longer closes').toBe(true);
  });

  it('say so when a link names a game that is not on the schedule', () => {
    expect(/planMissing/.test(schedule), 'a link to a game that is not there opens nothing and says nothing').toBe(true);
  });

  it('scroll to a linked plan once it has arrived, not before', () => {
    /*
     * A plan is a line saying it is working until its card has loaded, and the
     * page is not tall enough to put the series at the top until then: scrolled
     * to at once, the plan was left below the fold on a series near the end of
     * the schedule. So the plan says when it is as tall as it will be, and the
     * Schedule scrolls then, the first time only.
     */
    const plan = read('src/GamePlan.tsx');
    expect(/onSettled\?: \(\) => void/.test(plan), 'the plan has no way of saying it has arrived').toBe(true);
    expect(/plan !== null && lineup !== null/.test(plan), 'it says so before its card has arrived').toBe(true);
    expect(/onSettled=\{landOnPlan\}/.test(schedule), 'the Schedule does not wait for the plan').toBe(true);
    expect(/if \(!landing\.current\) return;/.test(schedule), 'a plan opened by a click would scroll the page').toBe(true);
  });
});

/* ---------- What the server sends ---------- */

describe('the games the links name', () => {
  const GAMES = [7801, 7802, 7803];

  beforeAll(() => {
    // The day after the fixture league's own date, so they are games still to come
    const insert = db.prepare(
      `INSERT INTO games (game_id, home_team, away_team, date, played, league_id, game_type)
       VALUES (?, ?, ?, ?, 0, ?, 0)`
    );
    insert.run(GAMES[0], IDS.mlbTeam, IDS.otherMlbTeam, '2030-6-2', IDS.league);
    insert.run(GAMES[1], IDS.mlbTeam, IDS.otherMlbTeam, '2030-6-3', IDS.league);
    insert.run(GAMES[2], IDS.otherMlbTeam, IDS.mlbTeam, '2030-6-4', IDS.league);
  });

  // These two ask the server for the id the links above are made from: the
  // pages draw no link for a game with no id, so a missing field costs the links
  it('are in the dashboard payload, in the order the rows are drawn', async () => {
    const { upcoming } = (await request(`/api/dashboard/${IDS.mlbTeam}`)) as {
      upcoming: Array<{ game_id?: number }>;
    };
    expect(upcoming.map((g) => g.game_id)).toEqual(GAMES);
  });

  it("are in tonight's game, which is the first of them", async () => {
    const next = (await request(`/api/next-game/${IDS.mlbTeam}`)) as { game_id?: number };
    expect(next.game_id).toBe(GAMES[0]);
  });
});
