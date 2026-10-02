import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { farmSignalCounts } from '../server/dashboard.js';
import {
  PAGES, buildHash, currentRoute, entryState, isPage, navigate, parseRoute, usePage, usePlayer, useRoute, watchRoute,
  type Page,
} from '../src/route.js';
import { closePlayer, openPlayer } from '../src/playerModal.js';
import { ProspectsView, matchesSignal, signalCounts, signalFilter } from '../src/pages/Prospects.js';
import type { Prospect, ProspectsResponse } from '../src/api.js';

/**
 * A place you can link to.
 *
 * "No URLs. The page is React state: no deep links, no bookmarks, browser Back
 * does nothing, chips and cross-links cannot carry a filter, and a player card
 * cannot be shared."
 *
 * The page is the address now — #/prospects?signal=decision — and what is held
 * down here is the part that goes wrong without anybody seeing it. That an
 * address and the route it names are the same thing in both directions for every
 * page there is, so a page left off the list is caught rather than quietly
 * becoming the dashboard. That an address nobody understands is the dashboard
 * and not a blank screen. That a filter and a player card ride along. And that
 * the router does what a reader expects of one: Back goes back, a card closes
 * with it, and pressing the same button twice is not two steps.
 *
 * Nothing here needs a browser. The address and its history are a stand-in
 * (installBrowser below), and what the pages and the app do with them is read
 * from their source, the way the other page tests are — there is no DOM in this
 * suite to draw them into.
 */

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

/**
 * Every page App.tsx draws, from its source: the branches that render a page,
 * and the menu entries that lead to one.
 */
const drawn = (): string[] => [...read('src/App.tsx').matchAll(/page === '([a-z]+)'/g)].map((m) => m[1]);
const inMenu = (): string[] => [...read('src/App.tsx').matchAll(/page: '([a-z]+)'/g)].map((m) => m[1]);

describe('the pages', () => {
  it('are the ones App.tsx draws, no more and no fewer', () => {
    /*
     * Both ways round matter. A page App draws that is missing from the list is
     * reachable from the menu and then lands on the dashboard when linked to; a
     * page on the list that App never draws is an address that shows nothing.
     * `Page` is made from the list, so the first cannot compile, but a menu
     * entry can be edited around the type, and the second is only caught here.
     */
    expect([...new Set(drawn())].sort()).toEqual([...PAGES].sort());
  });

  it('are all reachable from the menu or the gear', () => {
    for (const page of inMenu()) expect(isPage(page), `${page} is in the menu but is not a page`).toBe(true);
    // The one page with no menu entry is the settings gear, which has its own button
    const noEntry = PAGES.filter((p) => !inMenu().includes(p));
    expect(noEntry).toEqual(['settings']);
  });

  it('are named with a single lowercase word, which is all an address can carry safely', () => {
    // A slash or a question mark in a name would be read as the start of something else
    for (const page of PAGES) expect(page, page).toMatch(/^[a-z]+$/);
  });
});

describe('an address and the route it names', () => {
  it('are the same thing in both directions, for every page App.tsx has', () => {
    // From the source and not from the list, so a page added to App and not to
    // the list shows up here as the dashboard it would become
    const pages = [...new Set([...drawn(), ...inMenu()])] as Page[];
    expect(pages.length).toBeGreaterThan(20);
    for (const page of pages) {
      const hash = buildHash(page);
      expect(parseRoute(hash), page).toEqual({ page, params: {}, player: null });
      expect(buildHash(parseRoute(hash).page), page).toBe(hash);
    }
  });

  it('writes a page as #/page, and a filter after it', () => {
    expect(buildHash('dashboard')).toBe('#/dashboard');
    expect(buildHash('prospects', { signal: 'promote' })).toBe('#/prospects?signal=promote');
  });

  it('takes the dashboard for a page that does not exist', () => {
    // Nothing, nothing real, and what a person might type for the card
    for (const hash of ['', '#', '#/', '#/nonsense', '#/prospects/extra', '#/player/35502']) {
      expect(parseRoute(hash), JSON.stringify(hash)).toEqual({ page: 'dashboard', params: {}, player: null });
    }
  });

  it('drops the parameters of a page that does not exist, since they were meant for something else', () => {
    expect(parseRoute('#/nonsense?signal=promote&player=5'))
      .toEqual({ page: 'dashboard', params: {}, player: null });
  });

  it('forgives how a page was written', () => {
    for (const hash of ['#prospects', '#/prospects/', 'prospects', '#//prospects']) {
      expect(parseRoute(hash).page, hash).toBe('prospects');
    }
  });
});

describe('a filter', () => {
  it('survives the trip, every one of them', () => {
    const params = { flag: 'expiring', action: 'extension' };
    expect(parseRoute(buildHash('contracts', params)))
      .toEqual({ page: 'contracts', params, player: null });
  });

  it('is written in a fixed order, so one place has one address', () => {
    // navigate() does nothing when the address would not change, and that only
    // works if the same filter built two ways is the same string
    const one = buildHash('contracts', { flag: 'expiring', action: 'extension' });
    const other = buildHash('contracts', { action: 'extension', flag: 'expiring' });
    expect(one).toBe(other);
    expect(one).toBe('#/contracts?action=extension&flag=expiring');
  });

  it('leaves out what has no value, and reads a bare name as none', () => {
    expect(buildHash('prospects', { signal: undefined, team: null, q: '' })).toBe('#/prospects');
    // So clearing a filter is { signal: undefined } and not a second object to build
    expect(parseRoute('#/prospects?signal=&team').params).toEqual({});
  });

  it('is written as text, a number included', () => {
    expect(buildHash('payroll', { year: 2029 })).toBe('#/payroll?year=2029');
    expect(parseRoute('#/payroll?year=2029').params).toEqual({ year: '2029' });
  });

  it('survives characters that mean something in an address', () => {
    const params = { q: "O'Neil & Sons = 100% #1? yes", name: 'José Ramírez', zero: '0' };
    expect(parseRoute(buildHash('players', params)).params).toEqual(params);
  });

  it('is the first of a name given twice', () => {
    expect(parseRoute('#/prospects?signal=promote&signal=demote').params).toEqual({ signal: 'promote' });
  });

  it('is only a name when it is called __proto__', () => {
    const { params } = parseRoute('#/prospects?__proto__=polluted&constructor=x');
    expect(Object.getPrototypeOf(params)).toBe(Object.prototype);
    expect(Object.keys(params).sort()).toEqual(['__proto__', 'constructor']);
  });
});

describe('the player card in the address', () => {
  it('is an id that rides along with the page and its filter', () => {
    const hash = buildHash('contracts', { flag: 'expiring' }, 35502);
    expect(hash).toBe('#/contracts?flag=expiring&player=35502');
    expect(parseRoute(hash)).toEqual({ page: 'contracts', params: { flag: 'expiring' }, player: 35502 });
  });

  it('opens over any page, and comes back out as the same id', () => {
    for (const page of PAGES) {
      expect(parseRoute(buildHash(page, {}, 35502)), page).toEqual({ page, params: {}, player: 35502 });
    }
  });

  it('is never among the parameters a page reads', () => {
    expect(parseRoute('#/prospects?signal=promote&player=9').params).toEqual({ signal: 'promote' });
  });

  it('may be asked for as a parameter, so a caller who does so is not silently ignored', () => {
    expect(buildHash('crunch', { player: 7 })).toBe('#/crunch?player=7');
    expect(buildHash('crunch', { player: '7' })).toBe('#/crunch?player=7');
  });

  it('is nobody when it is not a player id', () => {
    for (const bad of ['abc', '0', '-3', '1.5', '', '12abc', '99999999999999999999']) {
      expect(parseRoute(`#/crunch?player=${bad}`).player, JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('a route read where there is no address', () => {
  it('is the dashboard, so a page that asks for one can be drawn on a server', () => {
    const Probe = () => createElement('i', null, useRoute().page);
    expect(renderToStaticMarkup(createElement(Probe))).toBe('<i>dashboard</i>');
  });

  it('is the dashboard and nobody, for the parts of it that can be asked for alone', () => {
    const Probe = () => createElement('i', null, `${usePage()} ${usePlayer()}`);
    expect(renderToStaticMarkup(createElement(Probe))).toBe('<i>dashboard null</i>');
  });
});

/**
 * The part of a browser the router touches: an address, a list of the addresses
 * visited, and what Back and Forward do to it. There is no DOM in this suite, so
 * this stands in for one — just enough of the history and its events for what
 * the router does with them.
 *
 * Going back is queued, as it is in a browser, and settle() lets it happen. The
 * queue is the point: a second press that arrives before the first has landed is
 * the case that matters.
 */
function installBrowser(startAt: string[] = ['']) {
  interface Entry { hash: string; state: unknown }
  const entries: Entry[] = startAt.map((hash) => ({ hash, state: null }));
  let at = entries.length - 1;
  const queue: number[] = [];
  const handlers: Record<string, Set<() => void>> = { hashchange: new Set(), popstate: new Set() };
  const fragment = (url: string) => (url.startsWith('#') ? url : `#${url}`);

  const traverse = (delta: number) => queue.push(delta);
  (globalThis as unknown as { window?: unknown }).window = {
    location: { get hash() { return entries[at].hash; } },
    history: {
      get state() { return entries[at].state; },
      pushState(state: unknown, _title: string, url: string) {
        entries.splice(at + 1);
        entries.push({ hash: fragment(url), state });
        at += 1;
      },
      replaceState(state: unknown, _title: string, url?: string) {
        entries[at] = { hash: url === undefined ? entries[at].hash : fragment(url), state };
      },
      back: () => traverse(-1),
      forward: () => traverse(1),
    },
    addEventListener: (type: string, handler: () => void) => handlers[type]?.add(handler),
    removeEventListener: (type: string, handler: () => void) => handlers[type]?.delete(handler),
  };

  return {
    /** The addresses visited, in order, whether or not the reader has since gone back past them. */
    visited: () => entries.map((e) => e.hash),
    /** Which of them the reader is on. */
    position: () => at,
    /** Let the queued steps happen, firing what a browser fires for each. */
    settle() {
      for (const delta of queue.splice(0)) {
        const to = Math.min(Math.max(at + delta, 0), entries.length - 1);
        if (to === at) continue;
        at = to;
        for (const type of ['popstate', 'hashchange']) handlers[type].forEach((h) => h());
      }
    },
    back() { traverse(-1); this.settle(); },
    forward() { traverse(1); this.settle(); },
  };
}

type Browser = ReturnType<typeof installBrowser>;
let browser: Browser;
/** The reader arrives at the dashboard, as App rewrites a first load with no address. */
const arrive = (...earlier: string[]): Browser => {
  browser = installBrowser([...earlier, '']);
  navigate('dashboard', {}, { replace: true });
  return browser;
};

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('moving about', () => {
  beforeEach(() => {
    arrive();
  });

  it('rewrites a first load with no address, so Back has no mistake to land on', () => {
    expect(browser.visited()).toEqual(['#/dashboard']);
  });

  it('pushes an entry for each step, so Back goes back', () => {
    navigate('prospects', { signal: 'decision' });
    navigate('contracts', { flag: 'expiring' });
    expect(browser.visited()).toEqual(['#/dashboard', '#/prospects?signal=decision', '#/contracts?flag=expiring']);
    expect(currentRoute()).toMatchObject({ page: 'contracts', params: { flag: 'expiring' } });

    browser.back();
    expect(currentRoute()).toMatchObject({ page: 'prospects', params: { signal: 'decision' } });
    browser.back();
    expect(currentRoute()).toMatchObject({ page: 'dashboard' });
  });

  it('goes forward again, to the same place', () => {
    navigate('prospects', { signal: 'decision' });
    browser.back();
    browser.forward();
    expect(currentRoute()).toMatchObject({ page: 'prospects', params: { signal: 'decision' } });
  });

  it('adds nothing for the place the reader is already, which would make Back look broken', () => {
    navigate('prospects', { signal: 'decision' });
    navigate('prospects', { signal: 'decision' });
    expect(browser.visited()).toEqual(['#/dashboard', '#/prospects?signal=decision']);
  });

  it('rewrites the entry in place when asked, as a filter does', () => {
    navigate('prospects', { signal: 'decision' });
    navigate('prospects', { signal: 'promote' }, { replace: true });
    expect(browser.visited()).toEqual(['#/dashboard', '#/prospects?signal=promote']);
    // One Back leaves the page, not the filter before this one
    browser.back();
    expect(currentRoute().page).toBe('dashboard');
  });

  it('tells its own steps from the browser\'s, which is how App knows forward from back', () => {
    navigate('prospects');
    expect(currentRoute().action).toBe('push');
    navigate('prospects', { signal: 'promote' }, { replace: true });
    expect(currentRoute().action).toBe('replace');
    browser.back();
    expect(currentRoute().action).toBe('pop');
    browser.forward();
    expect(currentRoute().action).toBe('pop');
  });

  it('is not fooled by coming back to an address it last read, when nobody looked in between', () => {
    navigate('prospects');
    navigate('contracts');
    browser.back();
    expect(currentRoute().action).toBe('pop');
    // Not read again until the end: forward by our own step, and back to the address that was last read
    navigate('contracts');
    navigate('prospects');
    expect(currentRoute().action).toBe('push');
  });

  it('hands out the same route until the address changes, which is what lets React compare', () => {
    navigate('prospects');
    const first = currentRoute();
    expect(currentRoute()).toBe(first);
    navigate('contracts');
    expect(currentRoute()).not.toBe(first);
  });

  it('says so to whoever is watching, for its own steps and for Back', () => {
    const heard = vi.fn();
    const stop = watchRoute(heard);
    navigate('prospects');
    expect(heard).toHaveBeenCalledTimes(1);
    browser.back();
    expect(heard.mock.calls.length).toBeGreaterThan(1);
    stop();
    const before = heard.mock.calls.length;
    navigate('contracts');
    expect(heard.mock.calls.length, 'still listening after being told to stop').toBe(before);
  });

  it('keeps what it was told to keep with an entry, and brings it back with Back and Forward', () => {
    navigate('prospects', {}, { state: { note: 'kept' } });
    expect(entryState()).toEqual({ note: 'kept' });
    navigate('contracts');
    expect(entryState()).toBeNull();
    browser.back();
    expect(entryState()).toEqual({ note: 'kept' });
  });

  it('keeps an entry\'s state when it is rewritten in place', () => {
    navigate('prospects', {}, { state: { note: 'kept' } });
    navigate('prospects', { signal: 'promote' }, { replace: true });
    expect(entryState()).toEqual({ note: 'kept' });
  });
});

describe('the player card', () => {
  beforeEach(() => {
    arrive();
    navigate('prospects', { signal: 'decision' });
  });

  it('opens by writing the id into the address, over the page the reader is on', () => {
    openPlayer(35502);
    expect(currentRoute()).toMatchObject({ page: 'prospects', params: { signal: 'decision' }, player: 35502 });
    expect(browser.visited().at(-1)).toBe('#/prospects?signal=decision&player=35502');
  });

  it('closes by taking it out again, and leaves nothing behind', () => {
    openPlayer(35502);
    closePlayer();
    browser.settle();
    expect(currentRoute()).toMatchObject({ page: 'prospects', params: { signal: 'decision' }, player: null });
    // Back from here is the page before this one, not a card that was closed
    browser.back();
    expect(currentRoute().page).toBe('dashboard');
  });

  it('is closed by Back', () => {
    openPlayer(35502);
    browser.back();
    expect(currentRoute()).toMatchObject({ page: 'prospects', player: null });
  });

  it('is brought back by Forward, with the man it was open on', () => {
    openPlayer(35502);
    browser.back();
    browser.forward();
    expect(currentRoute().player).toBe(35502);
  });

  it('swaps for another man rather than stacking one on top, so one Back or ✕ closes it', () => {
    openPlayer(35502);
    openPlayer(11111);
    openPlayer(22222);
    expect(currentRoute().player).toBe(22222);
    // The page and the one card, however many men he followed through it
    expect(browser.visited()).toEqual([
      '#/dashboard', '#/prospects?signal=decision', '#/prospects?signal=decision&player=22222',
    ]);
    closePlayer();
    browser.settle();
    expect(currentRoute()).toMatchObject({ page: 'prospects', player: null });
  });

  it('is not opened a second time for the man already open', () => {
    openPlayer(35502);
    openPlayer(35502);
    expect(browser.visited()).toHaveLength(3);
  });

  it('is closed in place when it came from a link, which has no entry of ours to pop', () => {
    // Opened from a bookmark: the entry behind it is whatever the reader was doing before
    browser = installBrowser(['#/dashboard', '']);
    navigate('prospects', { signal: 'decision' }, { player: 35502, replace: true });
    closePlayer();
    browser.settle();
    expect(currentRoute()).toMatchObject({ page: 'prospects', params: { signal: 'decision' }, player: null });
    // Not popped: the entry before it is still behind it, and the reader is still on this page
    expect(browser.visited()).toEqual(['#/dashboard', '#/prospects?signal=decision']);
    expect(browser.position()).toBe(1);
  });

  it('is not two steps back when ✕ is pressed twice before the browser has moved', () => {
    /*
     * A double-click on a close button is not unusual. The first press pops the
     * card's entry; going back is not instant, so the second arrives while the
     * card is still the current entry, and a plain history.back() on it would
     * leave the card and then the page behind it.
     */
    openPlayer(35502);
    closePlayer();
    closePlayer();
    browser.settle();
    expect(currentRoute()).toMatchObject({ page: 'prospects', params: { signal: 'decision' }, player: null });
  });

  it('does nothing to close what is not open', () => {
    closePlayer();
    browser.settle();
    expect(currentRoute()).toMatchObject({ page: 'prospects' });
    expect(browser.visited()).toEqual(['#/dashboard', '#/prospects?signal=decision']);
  });

  it('does not follow the reader to another page, and is there again on Back', () => {
    openPlayer(35502);
    navigate('crunch');
    expect(currentRoute()).toMatchObject({ page: 'crunch', player: null });
    // Back is the card again, which is the page the reader was on
    browser.back();
    expect(currentRoute()).toMatchObject({ page: 'prospects', player: 35502 });
  });
});

describe('the farm page', () => {
  const prospect = (over: Partial<Prospect>): Prospect => ({
    player_id: 1, name: 'Nobody', age: 22, team: 'Test Nine', level: 4, levelName: 'AAA', cur: 40, pot: 55,
    ageDiff: 0, score: 1, reasons: [], positionName: 'SS', signal: null, move: null, war: 0.5,
    pa: 200, opsVal: 0.7, hr: 4, sb: 3, ...over,
  });
  const farm: ProspectsResponse = {
    batters: [
      prospect({ player_id: 1, name: 'Pat Promote', signal: 'promote' }),
      prospect({ player_id: 2, name: 'Bo Blocked', signal: 'blocked' }),
      prospect({ player_id: 3, name: 'Wes Watched', signal: 'watch' }),
      prospect({ player_id: 4, name: 'Nia Nosignal', signal: null }),
    ],
    pitchers: [
      prospect({ player_id: 5, name: 'Dee Demote', signal: 'demote', ip: 50, era: 6.1, kpct: 15 }),
      prospect({ player_id: 6, name: 'Wyn Watched', signal: 'watch', ip: 40, era: 3.1, kpct: 25 }),
    ],
  };
  const page = (filter: Parameters<typeof ProspectsView>[0]['filter']) =>
    renderToStaticMarkup(createElement(ProspectsView, { data: farm, filter, onFilter: () => {} }));

  it('reads the filter from the address, and takes anything it does not know for the whole farm', () => {
    for (const known of ['all', 'decision', 'promote', 'blocked', 'demote', 'watch']) {
      expect(signalFilter(known)).toBe(known);
    }
    // An address somebody edited should show everything, not an empty page that looks like no farm
    for (const unknown of [undefined, '', 'promotion', 'PROMOTE', 'decision,watch']) {
      expect(signalFilter(unknown), String(unknown)).toBe('all');
    }
  });

  it('means by "decision" the three signals the dashboard chip counts, and not watch', () => {
    expect(matchesSignal('decision', 'promote')).toBe(true);
    expect(matchesSignal('decision', 'blocked')).toBe(true);
    expect(matchesSignal('decision', 'demote')).toBe(true);
    expect(matchesSignal('decision', 'watch')).toBe(false);
    expect(matchesSignal('decision', null)).toBe(false);
  });

  it('holds as many men on its decisions as the server counted for the chip', () => {
    // The chip is the server's count and the page is this filter: if they ever
    // mean different things, the number on one and the rows on the other part ways
    const batters = farm.batters.map((p) => ({ signal: p.signal }));
    const pitchers = farm.pitchers.map((p) => ({ signal: p.signal }));
    const chip = farmSignalCounts({ batters, pitchers });
    expect(signalCounts(farm).decision).toBe(chip.total);
    expect(signalCounts(farm).promote).toBe(chip.promote);
    expect(signalCounts(farm).blocked).toBe(chip.blocked);
    expect(signalCounts(farm).demote).toBe(chip.demote);
  });

  it('lists exactly the men the chip counted when it is opened on the decisions', () => {
    const html = page('decision');
    for (const shown of ['Pat Promote', 'Bo Blocked', 'Dee Demote']) expect(html, shown).toContain(shown);
    for (const hidden of ['Wes Watched', 'Wyn Watched', 'Nia Nosignal']) expect(html, hidden).not.toContain(hidden);
  });

  it('lists everybody when there is no filter', () => {
    const html = page('all');
    for (const name of ['Pat Promote', 'Bo Blocked', 'Wes Watched', 'Nia Nosignal', 'Dee Demote', 'Wyn Watched']) {
      expect(html, name).toContain(name);
    }
  });

  it('opens on the filter the address named, and on that one only', () => {
    const active = (filter: Parameters<typeof page>[0]) =>
      [...page(filter).matchAll(/<button[^>]*class="active"[^>]*>(\w+)/g)].map((m) => m[1]);
    expect(active('decision')).toEqual(['Decisions']);
    expect(active('promote')).toEqual(['Promote']);
    expect(active('all')).toEqual(['All']);
  });

  it('says how many men each filter would show, on its button', () => {
    expect(signalCounts(farm)).toEqual({ all: 6, decision: 3, promote: 1, blocked: 1, demote: 1, watch: 2 });
    expect(page('all')).toMatch(/Decisions <span class="muted">3<\/span>/);
    expect(page('all')).toMatch(/Watch <span class="muted">2<\/span>/);
  });

  it('does not blame the sample when a filter is what left a table empty', () => {
    const html = page('demote');
    // No demoted batter in this farm: the filter is the reason, and waiting would not change it
    expect(html).toContain('No batters with that signal.');
    expect(html).not.toContain('small samples');
  });

  it('still says it is the sample when nobody has qualified at all', () => {
    const html = renderToStaticMarkup(createElement(ProspectsView, {
      data: { batters: [], pitchers: [] }, filter: 'all', onFilter: () => {},
    }));
    expect(html).toContain('No qualified batters yet');
  });

  it('writes the filter back into the address in place, so the link says what the page shows', () => {
    const source = read('src/pages/Prospects.tsx');
    expect(source).toMatch(/const \{ params \} = useRoute\(\)/);
    expect(source).toMatch(/navigate\('prospects', \{ \.\.\.params, signal: next === 'all' \? undefined : next \}, \{ replace: true \}\)/);
  });
});

describe('the dashboard chips', () => {
  const dash = read('src/pages/Dashboard.tsx');

  it('open their page on the filter that matches what they counted', () => {
    expect(dash).toMatch(/label="Farm signals"[\s\S]*?onNavigate\('prospects', \{ signal: 'decision' \}\)/);
    expect(dash).toMatch(/label="Expiring contracts"[\s\S]*?onNavigate\('contracts', \{ flag: 'expiring' \}\)/);
    expect(dash).toMatch(/label="Extension candidates"[\s\S]*?onNavigate\('contracts', \{ action: 'extension' \}\)/);
  });

  it('carry nothing where the page is the whole of the count', () => {
    expect(dash).toMatch(/label="Roster issues"[^\n]*onNavigate\('crunch'\)/);
    expect(dash).toMatch(/label="Trade talk"[^\n]*onNavigate\('trades'\)/);
    expect(dash).toMatch(/label="Injured org-wide"[^\n]*onNavigate\('injuries'\)/);
  });

  it('can only open a page there is: the type says so, and each of them is an address', () => {
    expect(dash).toMatch(/onNavigate: \(page: Page, params\?: ParamsIn\) => void/);
    expect(buildHash('prospects', { signal: 'decision' })).toBe('#/prospects?signal=decision');
    expect(buildHash('contracts', { flag: 'expiring' })).toBe('#/contracts?flag=expiring');
    expect(buildHash('contracts', { action: 'extension' })).toBe('#/contracts?action=extension');
  });
});

describe('the app', () => {
  const app = read('src/App.tsx');

  it('takes its page from the address, not from state of its own', () => {
    expect(app).toMatch(/const routePage = usePage\(\)/);
    expect(app, 'the page is a piece of state again').not.toMatch(/useState<Page>/);
    expect(app, 'a second list of pages').not.toMatch(/^type Page =/m);
  });

  it('goes back by the browser\'s history, which brings the page back with its filter', () => {
    expect(app).toMatch(/const goBack = useCallback\(\(\) => back\(\), \[\]\)/);
    expect(app).toMatch(/onClick=\{goBack\}/);
  });

  it('keeps the way back honest when the browser goes back instead', () => {
    // A step of ours pushes the page left onto the trail; the browser's own Back takes it off
    expect(app).toMatch(/action === 'push'/);
    expect(app).toMatch(/action === 'pop' && trail\[trail\.length - 1\] === page/);
  });

  it('is not redrawn, page and all, when a filter changes or a card opens', () => {
    /*
     * App draws every page beneath it, so listening for the whole route would
     * redraw every row on the screen each time a player link was clicked. It
     * listens for the page alone and reads the rest when it needs it.
     */
    expect(app, 'App listens for the whole route').not.toMatch(/useRoute\(/);
    expect(app, 'App listens for the card').not.toMatch(/usePlayer\(/);
  });

  it('rewrites a first load, a mistyped page and an unserved one in place, never by adding to Back', () => {
    expect(app).toMatch(/navigate\(page, params, \{ player: here\.player, replace: true \}\)/);
  });

  it('is the same for a static export, which cannot serve three pages', () => {
    // The menu already leaves two of them out; a typed address now has to agree
    expect(app).toMatch(/NOT_IN_SNAPSHOT: readonly Page\[\] = \['players', 'watchlist', 'settings'\]/);
    expect(app).toMatch(/isStaticSite\(\) && NOT_IN_SNAPSHOT\.includes\(routePage\) \? 'dashboard' : routePage/);
    expect(app).toMatch(/!NOT_IN_SNAPSHOT\.includes\(i\.page\)/);
  });

  it('does not open a card for a name that is not a page, or before there is a save', () => {
    expect(app).toMatch(/if \(isPage\(to\)\) setPage\(to, params\)/);
    expect(app).toMatch(/status\.hasData && <PlayerModal onNavigate=\{go\} \/>/);
  });

  it('leaves a card behind when the save is switched, since its number belongs to the old one', () => {
    expect(app).toMatch(/const \{ page: here, params \} = currentRoute\(\);\s+navigate\(here, params, \{ replace: true \}\);/);
  });

  it('treats choosing the page already open as a rewrite, which is not a step to undo', () => {
    expect(app).toMatch(/replace: next === currentRoute\(\)\.page/);
  });
});

describe('the card, in the modal', () => {
  const modal = read('src/playerModal.tsx');

  it('is drawn from the address and keeps no copy of it', () => {
    expect(modal).toMatch(/const playerId = usePlayer\(\)/);
    expect(modal, 'the card has state of its own again').not.toMatch(/useState<number \| null>/);
    expect(modal, 'the old way in is still there').not.toMatch(/let listener/);
  });

  it('is closed by Escape, by the backdrop and by the button, which are one function', () => {
    expect(modal).toMatch(/if \(e\.key === 'Escape'\) closePlayer\(\)/);
    expect(modal).toMatch(/className="modal-backdrop" onClick=\{closePlayer\}/);
    expect(modal).toMatch(/className="modal-close" onClick=\{closePlayer\}/);
  });

  it('ignores an answer for a man who is no longer on screen', () => {
    // Back and Forward change the man faster than the server answers
    expect(modal).toMatch(/if \(current\) setDossier\(d\)/);
    expect(modal).toMatch(/return \(\) => \{ current = false; \}/);
  });

  it('still takes the optional way to another page, and leaves the card to the page change', () => {
    expect(modal).toMatch(/onNavigate\?: \(page: string\) => void/);
    expect(modal).toMatch(/onRoster=\{onNavigate \? \(\) => onNavigate\('crunch'\) : undefined\}/);
  });
});
