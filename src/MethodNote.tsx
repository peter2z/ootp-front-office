import { useId, useState, type ReactNode } from 'react';

/**
 * Where a page's note was last left, filed under the page it belongs to.
 *
 * The prefix matches the column picker's (`ootp-fo:columns:`), so everything
 * this app keeps in the browser sits under one name.
 */
export const noteStorageKey = (pageKey: string): string => `ootp-fo:method-note:${pageKey}`;

/**
 * What this session has been told, for the browsers that will not hold it.
 *
 * A page that rebuilds its card takes the note down with it — the lineup does
 * on every switch of hand or style — so with storage blocked a reader would
 * find the note shut again after each click. It also wins over storage, which
 * covers a store that reads but will not write (full, or read-only).
 */
const remembered = new Map<string, boolean>();

/** Shut unless the reader opened it: the point is that the table comes first. */
export function loadNoteOpen(pageKey: string): boolean {
  const seen = remembered.get(pageKey);
  if (seen !== undefined) return seen;
  try {
    return localStorage.getItem(noteStorageKey(pageKey)) === 'open';
  } catch {
    // Storage that is switched off, blocked or missing costs the memory, not the page
    return false;
  }
}

export function saveNoteOpen(pageKey: string, open: boolean): void {
  remembered.set(pageKey, open);
  try {
    localStorage.setItem(noteStorageKey(pageKey), open ? 'open' : 'closed');
  } catch {
    // Private mode or a full store: it stays as it was left until the page is closed
  }
}

/**
 * The paragraph that says how a page works, folded away until it is asked for.
 *
 * These paragraphs are right to exist and wrong to come first. Prospects opened
 * on two of them before its first row, and the lineup and the trade fits on one
 * each, so the table a reader came for began below the fold. Deleting them
 * would take away the reasoning that makes the numbers worth trusting, so they
 * stay, behind one quiet row that remembers how the reader left it.
 *
 * A note holds how a page is built and nothing else. Anything that is true of
 * the card or table on screen — a warning, what a search just did — stays
 * beside it, in view, because a reader who never opens the note would never
 * see it.
 *
 * `pageKey` is the page's name and stays the same for as long as the page
 * does. `summary` is the note's first sentence, shown beside the toggle while
 * it is shut so the gist is there without opening anything; it goes once the
 * note is open, since the same sentence is then the first thing in it.
 */
export function MethodNote({
  pageKey, summary, children,
}: {
  pageKey: string;
  summary?: string;
  children: ReactNode;
}) {
  // Read as the page draws, not after it: an effect would show the note shut
  // for a frame and then open it, which looks like a flicker on every visit
  const [open, setOpen] = useState(() => loadNoteOpen(pageKey));
  const id = useId();
  const buttonId = `${id}-toggle`;
  const bodyId = `${id}-body`;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    // Here and not in the state updater, which React is free to run twice
    saveNoteOpen(pageKey, next);
  };

  return (
    <div className="method-note">
      <div className="method-note-head">
        {/* A real button, so Enter and Space work without a line of handler */}
        <button
          type="button"
          id={buttonId}
          className="method-note-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={toggle}
        >
          <span className="method-note-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
          How this works
        </button>
        {!open && summary && <span className="method-note-summary">{summary}</span>}
      </div>
      {/* Always in the page, so the button's aria-controls has something to point
          at; `hidden` is what keeps it out of sight and out of the reading order */}
      <div id={bodyId} role="region" aria-labelledby={buttonId} className="method-note-body" hidden={!open}>
        {children}
      </div>
    </div>
  );
}
