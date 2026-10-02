import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadNoteOpen, MethodNote, noteStorageKey, saveNoteOpen } from '../src/MethodNote.js';

/**
 * A page's method text sits behind a toggle, and the toggle remembers.
 *
 * The paragraphs that say how a page works were right and in the wrong place.
 * Prospects opened on two of them before its first row, and the lineup and the
 * trade fits on one each, so the table a reader came for began below the fold
 * on three of the screens opened most. They now sit behind a "How this works"
 * toggle that stays as it was left.
 *
 * Two kinds of check, because there are two ways for this to go wrong. The
 * component is rendered, since what it has to get right is small and exact:
 * shut until asked, readable by a screen reader in both states, and unbroken in
 * a browser that will not hold storage. The pages are read as source, because a
 * page needs a server and a save to render, and the mistakes worth catching are
 * a page that goes back to printing its paragraph bare, and one that folds away
 * something about the card in front of the reader — which a note nobody opens
 * would then hide for good.
 *
 * What a click does is not covered here: there is no DOM in this suite to click
 * in. It was driven by hand in a browser instead.
 */

const SRC = join(fileURLToPath(import.meta.url), '..', '..', 'src');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, found);
    else if (/\.tsx?$/.test(entry)) found.push(path);
  }
  return found;
}

let pages = 0;
/**
 * A page name no other test has used. The component remembers within a session
 * as well as in storage, so two tests sharing a name would be sharing state.
 */
const freshPage = () => `test-page-${++pages}`;

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
afterEach(() => {
  vi.unstubAllGlobals();
  // Back to whatever the runtime had, which on this version of Node is nothing
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

/** A store that holds what it is given, so a test can say what the reader left behind. */
function stubStorage(held: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(held));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  return store;
}

const render = (pageKey: string, summary?: string) =>
  renderToStaticMarkup(
    createElement(MethodNote, {
      pageKey,
      summary,
      children: createElement('p', { className: 'muted hint-line' }, 'How the order is built.'),
    })
  );

const tagOf = (html: string, pattern: RegExp) => pattern.exec(html)?.[0] ?? '';
const toggle = (html: string) => tagOf(html, /<button[^>]*>/);
const region = (html: string) => tagOf(html, /<div[^>]*role="region"[^>]*>/);
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/** The toggle as a screen reader announces it: its words, without the arrow beside them. */
function toggleName(html: string): string {
  const button = /<button[\s\S]*?<\/button>/.exec(html)?.[0] ?? '';
  return button
    .replace(/<span[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/span>/g, '')
    .replace(/<[^>]*>/g, '')
    .trim();
}

describe('a note nobody has touched', () => {
  it('is shut, and the toggle says so', () => {
    const html = render(freshPage());
    expect(toggleName(html)).toBe('How this works');
    expect(toggle(html)).toContain('aria-expanded="false"');
  });

  it('keeps the paragraph out of sight but in the page', () => {
    // `hidden` takes it out of view and out of the reading order, and leaving it
    // in the markup means the toggle's aria-controls always points at something
    const html = render(freshPage());
    expect(region(html)).toMatch(/\shidden(?:=""|[\s>])/);
    expect(html).toContain('How the order is built.');
  });

  it('points the toggle at the region it opens, and the region back at the toggle', () => {
    const html = render(freshPage());
    const controls = attr(toggle(html), 'aria-controls');
    expect(controls, 'the toggle controls nothing').toBeTruthy();
    expect(attr(region(html), 'id')).toBe(controls);
    // So a screen reader announces the region as "How this works"
    expect(attr(region(html), 'aria-labelledby')).toBe(attr(toggle(html), 'id'));
  });

  it('is a real button, so Enter and Space work without a handler of ours', () => {
    // A div with an onClick is a mouse-only control; type="button" also keeps it
    // from submitting a form it happens to be inside
    const tag = toggle(render(freshPage()));
    expect(tag).toMatch(/^<button\b/);
    expect(tag).toContain('type="button"');
  });
});

describe('a note left open', () => {
  it('is open when the stored state says so', () => {
    const page = freshPage();
    stubStorage({ [noteStorageKey(page)]: 'open' });
    const html = render(page);
    expect(toggle(html)).toContain('aria-expanded="true"');
    expect(region(html)).not.toMatch(/\shidden/);
  });

  it('is open on drawing, not after it', () => {
    // Read in an effect, it would be shut for a frame and then spring open — on
    // every visit, for everyone who ever left it open. Server rendering runs no
    // effects, so an open note here is one that was read as the page was drawn.
    const page = freshPage();
    stubStorage({ [noteStorageKey(page)]: 'open' });
    expect(render(page)).toContain('aria-expanded="true"');
  });

  it('is open for the page it was left open on and for no other', () => {
    const lineup = freshPage();
    const pitching = freshPage();
    stubStorage({ [noteStorageKey(lineup)]: 'open' });
    expect(toggle(render(lineup))).toContain('aria-expanded="true"');
    expect(toggle(render(pitching))).toContain('aria-expanded="false"');
  });

  it('stays shut for anything stored that is not "open"', () => {
    // Something an older build wrote, or something else on the same origin: it
    // must not pop a note open, since shut is the state that protects the table
    for (const stored of ['closed', 'true', '1', 'OPEN', '']) {
      const page = freshPage();
      stubStorage({ [noteStorageKey(page)]: stored });
      expect(toggle(render(page)), `"${stored}" opened it`).toContain('aria-expanded="false"');
    }
  });
});

describe('a browser that will not hold storage', () => {
  it('still draws the page, shut, when there is no storage at all', () => {
    vi.stubGlobal('localStorage', undefined);
    const html = render(freshPage());
    expect(toggle(html)).toContain('aria-expanded="false"');
    expect(html).toContain('How the order is built.');
  });

  it('still draws the page when every call to storage throws', () => {
    const denied = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    vi.stubGlobal('localStorage', { getItem: denied, setItem: denied, removeItem: denied });
    expect(toggle(render(freshPage()))).toContain('aria-expanded="false"');
  });

  it('still draws the page when merely looking for storage throws', () => {
    // Chrome does this with site data blocked: it is the property that throws,
    // before there is any storage to call
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    expect(toggle(render(freshPage()))).toContain('aria-expanded="false"');
    expect(() => saveNoteOpen(freshPage(), true)).not.toThrow();
  });

  it('does not slam shut when the page rebuilds its card', () => {
    // The lineup takes the whole card down and puts it back on every switch of
    // hand or style, the note with it. With nowhere to keep the choice, it would
    // be shut again after every click — so it is also kept for the session.
    vi.stubGlobal('localStorage', undefined);
    const page = freshPage();
    saveNoteOpen(page, true);
    expect(loadNoteOpen(page)).toBe(true);
    expect(toggle(render(page))).toContain('aria-expanded="true"');
    saveNoteOpen(page, false);
    expect(toggle(render(page))).toContain('aria-expanded="false"');
  });
});

describe('remembering how the note was left', () => {
  it('writes the choice to storage under the page it belongs to', () => {
    const page = freshPage();
    const store = stubStorage();
    saveNoteOpen(page, true);
    expect(store.get(noteStorageKey(page))).toBe('open');
    saveNoteOpen(page, false);
    expect(store.get(noteStorageKey(page))).toBe('closed');
  });

  it('reads it back on the next visit', () => {
    // A new visit is a page that has not saved anything this session, so only
    // storage knows
    const page = freshPage();
    stubStorage({ [noteStorageKey(page)]: 'open' });
    expect(loadNoteOpen(page)).toBe(true);
  });

  it('keeps one page\'s choice from opening another\'s', () => {
    const [a, b] = [freshPage(), freshPage()];
    const store = stubStorage();
    saveNoteOpen(a, true);
    expect(store.has(noteStorageKey(b))).toBe(false);
    expect(loadNoteOpen(b)).toBe(false);
  });

  it('puts what was said this session ahead of what an earlier one stored', () => {
    // A store that reads but will not write (full, or read-only): the choice
    // just made must win over the stale one it cannot overwrite
    const page = freshPage();
    vi.stubGlobal('localStorage', {
      getItem: () => 'closed',
      setItem: () => {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      },
    });
    saveNoteOpen(page, true);
    expect(loadNoteOpen(page)).toBe(true);
  });

  it('files under the same prefix as the rest of what the app keeps in the browser', () => {
    expect(noteStorageKey('lineup')).toBe('ootp-fo:method-note:lineup');
  });
});

describe('the one-line summary', () => {
  it('sits beside the toggle while the note is shut', () => {
    const html = render(freshPage(), 'Ordering per The Book.');
    expect(html).toMatch(/class="method-note-summary">Ordering per The Book\.</);
  });

  it('goes once the note is open, because the same sentence now leads it', () => {
    const page = freshPage();
    stubStorage({ [noteStorageKey(page)]: 'open' });
    expect(render(page, 'Ordering per The Book.')).not.toContain('method-note-summary');
  });

  it('is not made up when the page gives none', () => {
    expect(render(freshPage())).not.toContain('method-note-summary');
  });
});

describe('the pages', () => {
  /**
   * `reads` is the variable each page loads its data into. A note holds how a
   * page is built; what it says about the card or table in front of the reader
   * has to stay in view, because a note nobody opens would hide it for good.
   * The lineup's DH override and the result of its search are the two that
   * nearly went in, and Trade Fits opens on which positions are weakest.
   */
  const PAGES = [
    { file: 'pages/TradeCenter.tsx', key: 'trade-fits', reads: 'fits' },
    { file: 'pages/Lineup.tsx', key: 'lineup', reads: 'data' },
    { file: 'pages/Pitching.tsx', key: 'pitching', reads: 'data' },
    { file: 'pages/Prospects.tsx', key: 'prospects', reads: 'data' },
  ];

  /** What sits between the tags, which is the part of a page the note folds away. */
  const folded = (source: string) =>
    (source.match(/<MethodNote\b[\s\S]*?<\/MethodNote>/g) ?? []).join('\n');

  for (const { file, key, reads } of PAGES) {
    describe(file, () => {
      const source = read(file);

      // Booleans rather than toMatch on the source, whose failure would print the whole page
      it('imports the note and renders it under its own key', () => {
        expect(
          /import \{ MethodNote \} from '\.\.\/MethodNote'/.test(source),
          'it no longer imports the note'
        ).toBe(true);
        expect(
          source.includes(`<MethodNote pageKey="${key}"`),
          `it no longer renders the note as "${key}"`
        ).toBe(true);
      });

      it('folds a paragraph away rather than an empty tag', () => {
        expect(folded(source), 'there is nothing inside the note').toContain('hint-line');
      });

      it('folds nothing that is read from what it loaded', () => {
        expect(
          folded(source),
          `something about this card or table is inside the note; keep it beside it, in view`
        ).not.toMatch(new RegExp(`\\b${reads}\\.`));
      });
    });
  }

  it('gives every page its own key, so one page\'s choice never opens another\'s', () => {
    const keys = sources(SRC).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/<MethodNote\b[^>]*?\bpageKey="([^"]+)"/g)].map((m) => m[1])
    );
    expect(keys.length).toBeGreaterThanOrEqual(PAGES.length);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i), 'two notes share a key').toEqual([]);
  });
});

describe('the stylesheet', () => {
  const css = read('styles.css');

  it('has a rule for every class the note renders', () => {
    const html = render(freshPage(), 'A summary.');
    const classes = new Set(
      [...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/))
    );
    // Not the page's own paragraph, which is styled where it always was
    classes.delete('muted');
    classes.delete('hint-line');
    expect(classes.size).toBeGreaterThanOrEqual(6);
    for (const name of classes) expect(css, `no rule for .${name}`).toContain(`.${name}`);
  });

  it('leaves the display of the folded body alone, or `hidden` stops working', () => {
    // A class that says display: block outranks the browser's own display: none
    // for [hidden], and a note that cannot be shut is the whole bug again
    const rules = [...css.matchAll(/\.method-note-body\s*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) expect(rule).not.toMatch(/display\s*:/);
  });
});
