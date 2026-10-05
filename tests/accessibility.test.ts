import { describe, expect, it } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModalShell, PlayerLink, Tip, tabWrap } from '../src/playerModal.js';
import { Nav, stepIndex, type NavEntry } from '../src/Nav.js';
import { SortableTh, Th } from '../src/Th.js';

/**
 * What a keyboard and a screen reader are given.
 *
 * A review of the app without a mouse found five things that looked fine to
 * anybody with one. A player's name was a button that said who it was and not
 * what it did, so twenty prospects read as twenty names going nowhere in
 * particular. The player card was a div laid over the page: no dialog role, so
 * nothing said a card had opened; nothing moved focus into it, so a keyboard
 * went on tabbing through the page underneath; nothing kept it from leaving.
 * The explanation behind every dotted underline opened for a mouse resting on
 * it and for nothing else. The menus along the top had to be tabbed through
 * item by item, and when Escape shut one the focus went down with it. And the
 * ✕, ← and ⚙ were, to a screen reader, exactly that: a glyph.
 *
 * Two kinds of check, because the page itself is not to be had here. What can
 * be drawn is drawn — the link, the card's frame, the tooltips, the menu
 * buttons — and read back as markup. Where focus goes after a keypress is the
 * part that needs a page, so the decisions in it are pulled out as plain
 * functions (tabWrap, stepIndex) that are run here, and what is left is read
 * from the source.
 *
 * What a key actually does to a live page is not covered: there is no DOM in
 * this suite to press one in. It was driven by hand in a browser instead — Tab
 * round the card and out of it on both sides, Escape from a tooltip inside it,
 * the menus and the column picker from the keyboard alone.
 */

const root = join(fileURLToPath(import.meta.url), '..', '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

const render = (node: ReactNode) => renderToStaticMarkup(node as never);
const attr = (tag: string, name: string) => new RegExp(String.raw`\s${name}="([^"]*)"`).exec(tag)?.[1];
const tagOf = (html: string, pattern: RegExp) => pattern.exec(html)?.[0] ?? '';

/**
 * The opening tag of the button whose only content is `glyph`, taken from
 * source. Found from the glyph backwards, because an attribute can hold an
 * arrow function and so a `>` of its own.
 */
function buttonShowing(source: string, glyph: string): string {
  const found = new RegExp(String.raw`>\s*${glyph}\s*</button>`).exec(source);
  if (!found) return '';
  return source.slice(source.lastIndexOf('<button', found.index), found.index + 1);
}

describe('a player link', () => {
  const link = (children: ReactNode, name?: string) =>
    render(createElement(PlayerLink, { id: 7, name, children }));
  const button = (html: string) => tagOf(html, /<button[^>]*>/);

  it('says what it does and whose card it opens', () => {
    expect(attr(button(link('Emil Morales')), 'aria-label')).toBe('Open player card: Emil Morales');
  });

  it('keeps the words on screen exactly as they were', () => {
    expect(link('Emil Morales')).toContain('>Emil Morales</button>');
  });

  it('puts the visible words inside its name, so somebody speaking to the screen can still say them', () => {
    // WCAG 2.5.3: a name that leaves out what is printed on the button cannot be
    // reached by saying what is printed on it
    expect(attr(button(link('Emil Morales')), 'aria-label')).toContain('Emil Morales');
  });

  it('finds the name when it is not one string', () => {
    // The roster writes {first} {last}, which arrives as three children
    expect(attr(button(link(['Emil', ' ', 'Morales'])), 'aria-label')).toBe('Open player card: Emil Morales');
    expect(attr(button(link(createElement('strong', null, 'Emil Morales'))), 'aria-label')).toBe(
      'Open player card: Emil Morales'
    );
  });

  it('takes the name it is told when the words are not one', () => {
    expect(attr(button(link('#7', 'Emil Morales')), 'aria-label')).toBe('Open player card: Emil Morales');
  });

  it('does not run his words together across a line break', () => {
    expect(attr(button(link('Emil\n   Morales')), 'aria-label')).toBe('Open player card: Emil Morales');
  });

  it('is still a link to a card with nobody to name', () => {
    expect(attr(button(link(null)), 'aria-label')).toBe('Open player card');
  });

  it('gives twenty prospects twenty different names', () => {
    // The finding in one line: a list of them must not read as identical buttons
    const names = Array.from({ length: 20 }, (_, i) => `Prospect Number ${i + 1}`);
    const labels = names.map((n) => attr(button(link(n)), 'aria-label'));
    expect(new Set(labels).size).toBe(20);
  });

  it('does not say it all a second time as a title', () => {
    // A title becomes the description once there is a name, and a reader hears
    // "Open player card" twice; to a mouse it was drawn over the hover card
    expect(button(link('Emil Morales'))).not.toMatch(/\stitle=/);
  });
});

describe('the player card as a dialog', () => {
  const shell = (titleId?: string) =>
    render(createElement(ModalShell, { titleId }, createElement('h2', { id: titleId }, 'Emil Morales')));
  const dialog = (html: string) => tagOf(html, /<div[^>]*role="dialog"[^>]*>/);

  it('is a dialog, and says that the page behind it is not available', () => {
    const tag = dialog(shell('card-title'));
    expect(tag, 'no dialog role').toContain('role="dialog"');
    expect(tag, 'not marked modal').toContain('aria-modal="true"');
  });

  it('is named by the heading it contains', () => {
    const html = shell('card-title');
    expect(attr(dialog(html), 'aria-labelledby')).toBe('card-title');
    expect(html).toContain('<h2 id="card-title">');
    expect(dialog(html), 'two names for one card').not.toContain('aria-label=');
  });

  it('is just "Player card" while the man is still loading', () => {
    // Pointing at a heading that is not on the page yet would be a name that is not there
    const tag = dialog(shell());
    expect(attr(tag, 'aria-label')).toBe('Player card');
    expect(tag).not.toContain('aria-labelledby');
  });

  it('can be given focus by a script without becoming a stop on the way through the page', () => {
    // It is where focus lands on opening, and where it falls back to when the
    // link that held it is replaced by following another man
    expect(attr(dialog(shell('card-title')), 'tabindex')).toBe('-1');
  });

  it('has a way out that says so', () => {
    const close = tagOf(shell('card-title'), /<button[^>]*class="modal-close"[^>]*>/);
    expect(attr(close, 'aria-label')).toBe('Close player card');
  });

  it('draws what it is given inside the dialog and not beside it', () => {
    const html = shell('card-title');
    expect(html.indexOf('role="dialog"')).toBeLessThan(html.indexOf('Emil Morales'));
  });

  describe('in the source', () => {
    const modal = read('src/playerModal.tsx');

    it('names itself by the heading the dossier prints, which carries the id it points at', () => {
      expect(modal).toMatch(/<h2 className="dossier-name" id=\{titleId\}>/);
      expect(modal).toMatch(/titleId=\{dossier \? titleId : undefined\}/);
    });

    it('moves focus into the card, and keeps it there when the man is replaced', () => {
      // Following a man from inside the card unmounts the link just pressed, and
      // focus goes with it to the page behind
      expect(modal).toMatch(/!dialog\.contains\(document\.activeElement\)\) dialog\.focus\(\)/);
      expect(modal).toMatch(/\}, \[playerId, dossier, error\]\);/);
    });

    it('gives focus back to what opened it, whichever way the card is closed', () => {
      // In the cleanup of an effect on whether it is open, so Escape, the ✕, the
      // backdrop and Back all end up in the same place
      expect(modal).toMatch(/return \(\) => giveFocusBack\(opener\);\s+\}, \[open\]\);/);
    });

    it('does not bring up the hover card as it hands focus back', () => {
      // A link shows its hover card whenever it takes focus, so every close would
      // otherwise end with one over the name that was last pressed
      expect(modal).toMatch(/onFocus=\{\(e\) => \{ if \(handingFocusBack\) e\.stopPropagation\(\); \}\}/);
      expect(modal).toMatch(/handingFocusBack = true;\s+try \{\s+to\.focus\(\);\s+\} finally \{\s+handingFocusBack = false;/);
    });

    it('keeps Tab inside while open, from the same listener that closes it on Escape', () => {
      expect(modal).toMatch(
        /if \(e\.key === 'Escape'\) closePlayer\(\);\s+\/\/[^\n]*\n\s+else if \(e\.key === 'Tab' && dialogRef\.current\) keepTabInside/
      );
    });

    it('says when it is loading and when it has failed', () => {
      expect(modal).toMatch(/<div className="banner error" role="alert">/);
      expect(modal).toMatch(/<p className="muted" role="status">Loading player…<\/p>/);
    });
  });
});

describe('keeping Tab inside the card', () => {
  const stops = ['close', 'watch', 'level', 'remove'];

  it('leaves the browser to step between the ends', () => {
    expect(tabWrap(stops, 'watch', false)).toBeNull();
    expect(tabWrap(stops, 'level', true)).toBeNull();
    expect(tabWrap(stops, 'close', false)).toBeNull();
    expect(tabWrap(stops, 'remove', true)).toBeNull();
  });

  it('turns the last stop round to the first, and the first back to the last', () => {
    expect(tabWrap(stops, 'remove', false)).toBe('close');
    expect(tabWrap(stops, 'close', true)).toBe('remove');
  });

  it('brings focus in from the card itself, which is not a stop', () => {
    expect(tabWrap(stops, 'the card', false)).toBe('close');
    expect(tabWrap(stops, 'the card', true)).toBe('remove');
  });

  it('brings focus in from nowhere, as when the link that held it was replaced', () => {
    expect(tabWrap(stops, null, false)).toBe('close');
    expect(tabWrap(stops, null, true)).toBe('remove');
  });

  it('holds with a single stop, where both ends are the same', () => {
    expect(tabWrap(['close'], 'close', false)).toBe('close');
    expect(tabWrap(['close'], 'close', true)).toBe('close');
  });

  it('has nothing to say about a card with nothing in it', () => {
    expect(tabWrap([], null, false)).toBeNull();
  });
});

describe('a tooltip', () => {
  const tip = () => render(createElement(Tip, { label: 'Value', tip: 'What he is worth to a club.' }));
  const labelOf = (html: string) => tagOf(html, /<span class="tip-label"[^>]*>/);
  const popOf = (html: string) => tagOf(html, /<span class="tip-pop"[^>]*>/);

  it('can be reached with Tab', () => {
    expect(attr(labelOf(tip()), 'tabindex')).toBe('0');
  });

  it('is described by the text it pops up', () => {
    const html = tip();
    const pointsAt = attr(labelOf(html), 'aria-describedby');
    expect(pointsAt, 'the words describe nothing').toBeTruthy();
    expect(attr(popOf(html), 'id')).toBe(pointsAt);
    expect(attr(popOf(html), 'role')).toBe('tooltip');
  });

  it('keeps the text out of the words that hold focus', () => {
    // Inside them it would be read once as part of them and again as their description
    expect(tip()).toMatch(/<span class="tip-label"[^>]*>Value<\/span><span class="tip-pop"/);
  });

  it('finds out for itself when it has been put inside a button or a link', () => {
    // Player Search draws its own sortable headers around a tip and does not say
    // so. Drawn here there is no page to look in, so this reads the look-up and
    // the stop it takes away.
    const modal = read('src/playerModal.tsx');
    expect(modal).toMatch(/closest\('button, a\[href\], \[role="button"\]'\)\) setFound\(true\)/);
    expect(modal).toMatch(/tabIndex=\{inside \? undefined : 0\}/);
  });

  it('gives every tip on a page an id of its own', () => {
    // Two sharing one would have both describe themselves with the first one's text
    const html = render(
      createElement('div', null,
        createElement(Tip, { label: 'Value', tip: 'One.' }),
        createElement(Tip, { label: 'Talent', tip: 'Two.' }))
    );
    const ids = [...html.matchAll(/class="tip-pop"[^>]*\sid="([^"]*)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('is what a plain header with a glossary entry is built from', () => {
    const html = render(
      createElement('table', null, createElement('thead', null, createElement('tr', null,
        createElement(Th, null, 'Age'))))
    );
    expect(attr(labelOf(html), 'tabindex')).toBe('0');
    expect(attr(popOf(html), 'id')).toBe(attr(labelOf(html), 'aria-describedby'));
  });

  describe('inside a sortable header', () => {
    const header = (label: string) =>
      render(
        createElement('table', null, createElement('thead', null, createElement('tr', null,
          createElement(SortableTh, { active: false, dir: 1, onSort: () => {} }, label))))
      );
    const buttonOf = (html: string) => tagOf(html, /<button[^>]*>/);

    it('is not a second stop within the button', () => {
      // A control inside a button is not something a screen reader can reach
      expect(header('Age')).not.toContain('tabindex');
    });

    it('is described by the button, which is what takes focus', () => {
      const html = header('Age');
      const pointsAt = attr(buttonOf(html), 'aria-describedby');
      expect(pointsAt, 'the button describes nothing').toBeTruthy();
      expect(attr(popOf(html), 'id')).toBe(pointsAt);
    });

    it('describes nothing for a column with nothing to say', () => {
      const html = header('Zzz not a documented column');
      expect(buttonOf(html)).not.toContain('aria-describedby');
      expect(html).not.toContain('tip-pop');
    });
  });
});

describe('the stylesheet', () => {
  const css = read('src/styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].trim().replace(/\s+/g, ' '),
    body: m[2],
  }));
  const rule = (selector: string) => rules.find((r) => r.selector === selector);
  /** Every selector of every rule that puts the popup on screen. */
  const showing = rules
    .filter((r) => /display\s*:\s*block/.test(r.body) && r.selector.includes('.tip-pop'))
    .map((r) => r.selector)
    .join(', ');

  it('keeps the popup out of sight until something asks for it', () => {
    expect(rule('.tip-pop')?.body).toMatch(/display\s*:\s*none/);
  });

  it('opens the popup for a keyboard as well as for a mouse', () => {
    expect(showing, 'no hover rule').toContain('.tip:hover .tip-pop');
    expect(showing, 'the tip is hover-only again').toContain(':focus-visible');
    // The words, and also a control the tip sits inside
    expect(showing).toMatch(/\.tip-label:focus-visible \+ \.tip-pop/);
    expect(showing).toMatch(/:is\(button, a\):focus-visible \.tip-pop/);
  });

  it('does not open it on a plain :focus, which a click would leave stuck open', () => {
    expect(showing).not.toMatch(/:focus(?![-\w])/);
  });

  it('draws a ring on the words while they hold focus', () => {
    expect(rule('.tip-label:focus-visible')?.body).toMatch(/outline\s*:[^;]*\bsolid\b/);
  });

  it('draws a ring on the organization picker for a keyboard, which a click switched off', () => {
    // .org-select:focus { outline: none } left a keyboard nothing to follow
    expect(rule('.org-select:focus')?.body).toMatch(/outline\s*:\s*none/);
    expect(rule('.org-select:focus-visible')?.body).toMatch(/outline\s*:[^;]*\bsolid\b/);
  });

  it('lights the row a keyboard is on in the column picker, and not the one a click opened it on', () => {
    expect(rule('.col-option:has(input:focus-visible)')?.body).toMatch(/background\s*:/);
    // On its own: a browser without :has() throws away the whole rule it is in
    expect(rule('.col-option:hover')?.body).toMatch(/background\s*:/);
  });

  it('shows where the arrow keys have got to in a menu, as hover does', () => {
    const focused = rule('.nav-dropdown button:focus-visible');
    expect(focused?.body).toMatch(/background\s*:/);
    expect(focused?.body).toMatch(/outline\s*:/);
  });

  it('puts no ring on the card itself, which is a place for focus and not a control', () => {
    expect(rule('.modal:focus')?.body).toMatch(/outline\s*:\s*none/);
  });
});

describe('the menus along the top', () => {
  const entries: Array<NavEntry<string>> = [
    { kind: 'link', page: 'dashboard', label: 'Dashboard', hint: '🏟' },
    {
      kind: 'group', label: 'Clubhouse', icon: '⚾',
      items: [
        { page: 'schedule', label: 'Schedule', hint: 'Series by series' },
        { page: 'lineup', label: 'Lineup', hint: "Tonight's card" },
      ],
    },
    {
      kind: 'group', label: 'League', icon: '📊',
      items: [{ page: 'standings', label: 'Standings', hint: 'Every division' }],
    },
  ];
  const nav = (current: string) =>
    render(createElement(Nav, { entries, current, onNavigate: () => {} } as never));
  const buttons = (html: string) => html.match(/<button[^>]*>/g) ?? [];

  it('says of each dropdown that it opens a menu, and whether it is open', () => {
    const groups = buttons(nav('dashboard')).filter((b) => b.includes('aria-haspopup'));
    expect(groups).toHaveLength(2);
    for (const tag of groups) {
      expect(attr(tag, 'aria-haspopup')).toBe('menu');
      expect(attr(tag, 'aria-expanded')).toBe('false');
    }
  });

  it('says nothing of the kind of a plain link', () => {
    const link = buttons(nav('dashboard')).find((b) => !b.includes('aria-haspopup'));
    expect(link).toBeTruthy();
    expect(link).not.toContain('aria-expanded');
  });

  it('marks the page the reader is on', () => {
    expect(attr(buttons(nav('dashboard'))[0], 'aria-current')).toBe('page');
    expect(buttons(nav('standings'))[0]).not.toContain('aria-current');
  });

  it('hides the icons and the caret, which read aloud as a baseball and a triangle', () => {
    const decoration = nav('dashboard').match(/<span class="nav-(?:icon|caret)"[^>]*>/g) ?? [];
    expect(decoration).toHaveLength(5);
    for (const tag of decoration) expect(tag).toContain('aria-hidden="true"');
  });

  describe('in the source', () => {
    const source = read('src/Nav.tsx');

    it('has its dropdown buttons say that they open a menu and whether it is open', () => {
      // Also drawn above; this is the attribute itself, which a rewrite of the
      // button could lose without any page being there to notice
      expect(source).toMatch(/aria-haspopup="menu"\s+aria-expanded=\{isOpen\}/);
    });

    it('is a menu of menu items, each a stop of its own only once the arrow keys have brought focus to it', () => {
      expect(source).toMatch(/className="nav-dropdown" role="menu"/);
      expect(source).toMatch(/role="menuitem"\s+tabIndex=\{-1\}/);
    });

    it('opens from the arrow keys on the button, to the end the key points at', () => {
      expect(source).toMatch(/e\.key === 'ArrowDown' \|\| e\.key === 'ArrowUp'/);
      expect(source).toMatch(/const end = e\.key === 'ArrowDown' \? 'first' : 'last'/);
    });

    it('moves inside the menu with the keys stepIndex knows', () => {
      expect(source).toMatch(
        /stepIndex\(e\.key, items\.indexOf\(document\.activeElement as HTMLElement\), items\.length\)/
      );
    });

    it('closes on Escape and puts focus back on the button that opened it', () => {
      expect(source).toMatch(/if \(e\.key === 'Escape'\) shut\(true\)/);
    });

    it('puts focus back on the button when something is chosen, too', () => {
      // The item is about to leave the page, and the focus with it
      expect(source).toMatch(/onClick=\{\(\) => go\(item\.page, true\)\}/);
      expect(source).toMatch(/if \(fromMenu\) shut\(true\)/);
    });
  });
});

describe('the keys inside a menu or a list of boxes', () => {
  it('step down and up', () => {
    expect(stepIndex('ArrowDown', 1, 5)).toBe(2);
    expect(stepIndex('ArrowUp', 3, 5)).toBe(2);
  });

  it('wrap round at either end, as a menu does', () => {
    expect(stepIndex('ArrowDown', 4, 5)).toBe(0);
    expect(stepIndex('ArrowUp', 0, 5)).toBe(4);
  });

  it('jump to the ends with Home and End', () => {
    expect(stepIndex('Home', 3, 5)).toBe(0);
    expect(stepIndex('End', 1, 5)).toBe(4);
  });

  it('start from the top or the bottom when focus is on none of them', () => {
    expect(stepIndex('ArrowDown', -1, 5)).toBe(0);
    expect(stepIndex('ArrowUp', -1, 5)).toBe(4);
  });

  it('leave every other key alone, so typing and Tab still work', () => {
    for (const key of ['Tab', 'Enter', ' ', 'a', 'ArrowLeft', 'ArrowRight', 'PageDown', 'Escape']) {
      expect(stepIndex(key, 2, 5), key).toBeNull();
    }
  });

  it('have nowhere to go in an empty list', () => {
    expect(stepIndex('ArrowDown', -1, 0)).toBeNull();
    expect(stepIndex('End', -1, 0)).toBeNull();
  });
});

describe('the column picker', () => {
  const picker = read('src/ColumnPicker.tsx');

  it('is a dialog named by its own heading, and its ✕ says what it closes', () => {
    expect(picker).toMatch(/className="col-picker" ref=\{ref\} role="dialog" aria-labelledby=\{titleId\}/);
    expect(picker).toMatch(/<strong id=\{titleId\}>/);
    expect(buttonShowing(picker, '✕')).toContain('aria-label="Close column picker"');
  });

  it('moves between its boxes with the same keys a menu does', () => {
    expect(picker).toMatch(/import \{ stepIndex \} from '\.\/Nav'/);
    expect(picker).toMatch(/stepIndex\(e\.key, boxes\.indexOf\(e\.target\), boxes\.length\)/);
  });

  it('leaves the arrow keys alone on its buttons, where they are not for moving between boxes', () => {
    expect(picker).toMatch(/if \(!\(e\.target instanceof HTMLInputElement\)\) return;/);
  });

  it('takes focus on opening and gives it back to its button on closing', () => {
    expect(picker).toMatch(/\.querySelector<HTMLElement>\('input'\)\?\.focus\(\)/);
    expect(picker).toMatch(/to\?\.isConnected && \(now === null \|\| now === document\.body\)\) to\.focus\(\)/);
  });
});

describe('the controls that were only a glyph', () => {
  const app = read('src/App.tsx');

  it('say what they do: close the card, go back, open settings, close the chat', () => {
    expect(buttonShowing(read('src/playerModal.tsx'), '✕')).toContain('aria-label="Close player card"');
    expect(buttonShowing(app, '←')).toContain('aria-label="Back"');
    expect(buttonShowing(app, '⚙')).toContain('aria-label="Settings"');
    expect(buttonShowing(app, '✕')).toContain('aria-label="Close chat"');
  });

  it('are still the buttons they were, not something else wearing the label', () => {
    expect(buttonShowing(app, '←')).toContain('onClick={goBack}');
    expect(buttonShowing(app, '⚙')).toContain("setPage('settings')");
    expect(buttonShowing(app, '✕')).toContain('setChatOpen(false)');
  });

  it('name the two dropdowns in the header, which had no name to read', () => {
    const organization = app.slice(app.indexOf('className="org-select"'), app.indexOf('{orgs.map'));
    expect(organization).toContain('aria-label="Organization"');
    const save = app.slice(app.indexOf('value={status.saveName'), app.indexOf('{!status.saveName'));
    expect(save).toContain('aria-label="Game save"');
  });

  it('leave no button of ours with a glyph for its only content and no label', () => {
    // Only the files this was written for. Two outside them still do — the ✕ on
    // a player in the trade analyzer and the one in the watchlist — which is
    // for whoever owns those pages
    for (const file of ['src/App.tsx', 'src/playerModal.tsx', 'src/ColumnPicker.tsx', 'src/Nav.tsx', 'src/Th.tsx']) {
      const source = read(file);
      for (const found of source.matchAll(/>\s*([✕✖×←→⚙▾▴])\s*<\/button>/g)) {
        const tag = source.slice(source.lastIndexOf('<button', found.index), found.index + 1);
        expect(tag, `${file}: a button that is only ${found[1]}`).toContain('aria-label=');
      }
    }
  });
});

describe('the Org Planner', () => {
  const planner = read('src/pages/Planner.tsx');

  it('names no element that has no role to carry a name', () => {
    // A name on a plain div or span is dropped by screen readers: the
    // deadlines strip was one, and is now a list
    for (const found of planner.matchAll(/<(div|span)\b[^>]*\saria-label=/g)) {
      const tag = planner.slice(found.index, planner.indexOf('>', found.index) + 1);
      expect(tag, 'a generic element with a name').toMatch(/\srole="/);
    }
    expect(planner).toMatch(/<ul className="plan-deadlines" aria-label="Deadlines">/);
  });

  it('gives each row action the move it acts on, with the visible word first', () => {
    for (const word of ['Accept', 'Dismiss']) {
      expect(planner).toContain(`aria-label={\`${word} \${name}\`}`);
    }
    expect(planner).toContain('aria-label={`${undo} ${name}`}');
    expect(planner).toContain('aria-label={`Steps for ${moveName(m)}`}');
  });
});
