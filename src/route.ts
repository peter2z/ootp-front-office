import { useSyncExternalStore } from 'react';

/**
 * Where the reader is, written in the address instead of kept in memory.
 *
 * The page used to be one piece of React state, which left the browser nothing
 * to work with: no link to a page, no bookmark, and a Back button that did
 * nothing because the whole session was a single history entry. A chip on the
 * dashboard could name a page and that was all — it could not say "the farm,
 * and only the men who want a decision" — and a player card could not be sent
 * to anybody. Every one of those needs the place written down somewhere the
 * browser can see it.
 *
 *   #/dashboard
 *   #/prospects?signal=decision              a page, and the filter it opens on
 *   #/contracts?flag=expiring&player=35502   the same, with a player card open over it
 *
 * It is the hash and not a path because this app is served three ways — the dev
 * server, the desktop shell and a static export that can be dropped on any
 * host — and the fragment is the one part of an address none of them has to be
 * taught to answer. Nothing is ever asked for /prospects.
 *
 * The player card is the `player` parameter and not a page of its own. It opens
 * over whatever page is current, so Back from a card lands on the page it was
 * opened over, and a link to a card carries that page and its filter along.
 * Pages never see it among their own parameters; it is `route.player`.
 */

/**
 * Every page there is. `Page` is made from this list, so a menu entry or a
 * branch in App.tsx that names a page missing from it does not compile;
 * tests/route.test.ts checks the other direction, that nothing here is left
 * undrawn.
 */
export const PAGES = [
  'dashboard', 'newspaper', 'recap', 'transactions', 'rosters', 'depth', 'prospects', 'development', 'draft',
  'franchise', 'orgcompare', 'contracts', 'crunch', 'injuries', 'freeagents', 'trades', 'lineup', 'leaders',
  'staff', 'watchlist', 'players', 'standings', 'pitching', 'schedule', 'payroll', 'trends', 'settings',
  'planner',
] as const;

export type Page = (typeof PAGES)[number];

/** Where an address that names nothing, or nothing real, lands. */
export const DEFAULT_PAGE: Page = 'dashboard';

export const isPage = (key: string): key is Page => (PAGES as readonly string[]).includes(key);

/** What a page reads out of the address. Always text: a number written into a hash comes back as one. */
export type RouteParams = Record<string, string>;

/**
 * What a caller may hand over. Numbers are written as text, and null or
 * undefined leaves the key out, so `{ signal: undefined }` clears a filter
 * without the caller having to build a second object.
 */
export type ParamsIn = Record<string, string | number | null | undefined>;

export interface Route {
  page: Page;
  params: RouteParams;
  /** The player whose card is open over the page, or null. */
  player: number | null;
}

/**
 * How the reader got here: `push` and `replace` are our own doing; `pop` is
 * everything the browser does for itself — Back, Forward, a typed address, the
 * first load. App tells a step forward from a step back by this.
 */
export type NavAction = 'push' | 'replace' | 'pop';

export interface CurrentRoute extends Route {
  action: NavAction;
}

/** A player id is a positive whole number; anything else in `player` is somebody's typo. */
const asPlayerId = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/**
 * The route an address names.
 *
 * Forgiving about how it was written — `#prospects` and `#/prospects/` are the
 * page too — and about what it names: a page that does not exist is the
 * dashboard, and its parameters are dropped, since they were meant for
 * something else.
 */
export function parseRoute(hash: string): Route {
  const body = hash.replace(/^#/, '').replace(/^\/+/, '');
  const cut = body.indexOf('?');
  const key = (cut === -1 ? body : body.slice(0, cut)).replace(/\/+$/, '');
  if (!isPage(key)) return { page: DEFAULT_PAGE, params: {}, player: null };

  // A Map and then fromEntries, so a parameter called __proto__ is only a name
  const found = new Map<string, string>();
  let player: number | null = null;
  if (cut !== -1) {
    for (const [name, value] of new URLSearchParams(body.slice(cut + 1))) {
      if (value === '') continue;
      if (name === 'player') player ??= asPlayerId(value);
      else if (!found.has(name)) found.set(name, value);
    }
  }
  return { page: key, params: Object.fromEntries(found), player };
}

/**
 * The address for a route; the inverse of {@link parseRoute}.
 *
 * Parameters come out in a fixed order, the card last, so one place has one
 * address however the caller happened to build it — the check for "already
 * here" depends on it. A `player` among the parameters is the card.
 */
export function buildHash(page: Page, params: ParamsIn = {}, player: number | null = null): string {
  const card = player ?? asPlayerId(params.player);
  const query = new URLSearchParams();
  for (const name of Object.keys(params).sort()) {
    const value = params[name];
    if (name === 'player' || value === null || value === undefined || value === '') continue;
    query.set(name, String(value));
  }
  if (card !== null) query.set('player', String(card));
  const text = query.toString();
  return `#/${page}${text ? `?${text}` : ''}`;
}

export interface NavigateOptions {
  /** Open this player's card over the page. */
  player?: number | null;
  /**
   * Rewrite the entry the reader is on instead of adding one after it. For a
   * change that is not a step worth undoing: a filter, or re-selecting the page
   * you are on. The entry keeps the state it had.
   */
  replace?: boolean;
  /** Kept with a pushed entry, and back with it on Back and Forward and after a reload. */
  state?: Record<string, unknown> | null;
}

/** What `navigate` last asked for, so the change it causes can be told from the browser's own. */
let requested: { hash: string; action: 'push' | 'replace' } | null = null;
let seen: { hash: string; route: CurrentRoute } | null = null;
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((listener) => listener());

/**
 * Go to a page, pushing history so that Back returns to where the reader was.
 * Does nothing when the address would not change: a second entry for the same
 * place only makes Back look as if it had done nothing.
 */
export function navigate(page: Page, params?: ParamsIn, options: NavigateOptions = {}): void {
  if (typeof window === 'undefined') return;
  const hash = buildHash(page, params, options.player ?? null);
  if (hash === window.location.hash) return;
  const action = options.replace ? 'replace' : 'push';
  requested = { hash, action };
  // Whatever was read last is stale now, even if the reader comes back to it
  seen = null;
  if (options.replace) {
    window.history.replaceState(options.state !== undefined ? options.state : window.history.state, '', hash);
  } else {
    window.history.pushState(options.state ?? null, '', hash);
  }
  // pushState and replaceState are silent: nothing fires, so the hook is told here
  emit();
}

/**
 * One step back in the history.
 *
 * The entry being left forgets its state first. A second press that lands
 * before the browser has moved would otherwise read the same entry and step back
 * again, and from a card that is not one step but two: the card, and the page
 * behind it.
 */
export function back(): void {
  if (typeof window === 'undefined') return;
  window.history.replaceState(null, '');
  window.history.back();
}

/** What the current history entry carries, as `navigate` was told to keep it. */
export function entryState(): Record<string, unknown> | null {
  if (typeof window === 'undefined') return null;
  const state: unknown = window.history.state;
  return state !== null && typeof state === 'object' ? (state as Record<string, unknown>) : null;
}

/** No address to read, as on a server render: the dashboard. Held in one object so a snapshot is stable. */
const SERVER_ROUTE: CurrentRoute = { ...parseRoute(''), action: 'pop' };

/**
 * The route now. The same object until the address changes, which is what lets
 * React compare snapshots, and why it is safe to call from anywhere.
 */
export function currentRoute(): CurrentRoute {
  if (typeof window === 'undefined') return SERVER_ROUTE;
  const hash = window.location.hash;
  if (seen?.hash !== hash) {
    const action: NavAction = requested?.hash === hash ? requested.action : 'pop';
    requested = null;
    seen = { hash, route: { ...parseRoute(hash), action } };
  }
  return seen.route;
}

/** Calls back whenever the route may have changed, until the returned function is called. */
export function watchRoute(listener: () => void): () => void {
  listeners.add(listener);
  // Back and Forward, and an address typed over the top. Which of the two a
  // browser fires for a fragment has varied, so both are heard; hearing one
  // change twice costs nothing, since the route is read afresh and is the same
  window.addEventListener('hashchange', listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('hashchange', listener);
    window.removeEventListener('popstate', listener);
  };
}

/**
 * The route, redrawn on whenever it changes — a filter, a page, a card opening.
 * What a page wants if it reads its own filter from the address.
 */
export function useRoute(): CurrentRoute {
  return useSyncExternalStore(watchRoute, currentRoute, () => SERVER_ROUTE);
}

/**
 * Only the page. App draws the whole tree beneath it, and a filter changing or a
 * card opening is not its business: listening for those would redraw every row
 * on the screen each time a player link was clicked.
 */
export function usePage(): Page {
  return useSyncExternalStore(watchRoute, () => currentRoute().page, () => DEFAULT_PAGE);
}

/** Only the card: whose is open over the page, or null. The modal listens for this and nothing else. */
export function usePlayer(): number | null {
  return useSyncExternalStore(watchRoute, () => currentRoute().player, () => null);
}
