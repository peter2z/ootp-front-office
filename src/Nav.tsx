import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

export interface NavItem<P extends string> {
  page: P;
  label: string;
  hint: string;
}
export interface NavGroup<P extends string> {
  label: string;
  icon: string;
  items: Array<NavItem<P>>;
}
/** A top-level entry is either a direct link or a dropdown of related pages. */
export type NavEntry<P extends string> = ({ kind: 'link' } & NavItem<P>) | ({ kind: 'group' } & NavGroup<P>);

/**
 * Where an arrow key, Home or End sends focus in a list of `count` things when
 * it is on the one at `at` (-1 for none of them), or null for any other key.
 * Past either end it wraps round, as a menu does.
 *
 * Pure, so it can be checked without a page. The menus below and the column
 * picker both move focus this way, and which way that is is the part worth
 * pinning down.
 */
export function stepIndex(key: string, at: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowDown': return at >= count - 1 ? 0 : at + 1;
    case 'ArrowUp': return at <= 0 ? count - 1 : at - 1;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}

export function Nav<P extends string>({
  entries, current, onNavigate,
}: {
  entries: Array<NavEntry<P>>;
  current: P;
  onNavigate: (page: P) => void;
}) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);
  // Which end of a menu to land on once it has opened from the keyboard. A mouse
  // opens it and leaves focus where it was.
  const landOn = useRef<'first' | 'last' | null>(null);

  const menuItems = () =>
    Array.from(navRef.current?.querySelectorAll<HTMLElement>('.nav-dropdown [role="menuitem"]') ?? []);

  /**
   * Shuts the menu and, when asked, puts focus back on the button that opened
   * it. Whatever had focus inside the menu goes off the page with it, and focus
   * that goes with it falls to the top of the document, which for somebody on a
   * keyboard is the start of the whole page again.
   */
  const shut = (refocus: boolean) => {
    const trigger = navRef.current?.querySelector<HTMLElement>('.nav-top[aria-expanded="true"]');
    setOpenMenu(null);
    if (refocus) trigger?.focus();
  };

  // Close on outside click or Escape
  useEffect(() => {
    if (openMenu === null) return;
    const onClick = (e: MouseEvent) => {
      if (!navRef.current?.contains(e.target as Node)) setOpenMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') shut(true);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [openMenu]);

  // A menu opened from the keyboard is opened to be used, so focus goes into it
  useEffect(() => {
    if (openMenu === null) return;
    const end = landOn.current;
    landOn.current = null;
    if (end === null) return;
    const items = menuItems();
    items[end === 'last' ? items.length - 1 : 0]?.focus();
  }, [openMenu]);

  const go = (page: P, fromMenu = false) => {
    onNavigate(page);
    // Choosing from a menu sends focus back to its button; a link outside any
    // menu is already where the focus is
    if (fromMenu) shut(true);
    else setOpenMenu(null);
  };

  const onTriggerKey = (e: ReactKeyboardEvent<HTMLButtonElement>, label: string, isOpen: boolean) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const end = e.key === 'ArrowDown' ? 'first' : 'last';
      if (isOpen) {
        const items = menuItems();
        items[end === 'last' ? items.length - 1 : 0]?.focus();
      } else {
        landOn.current = end;
        setOpenMenu(label);
      }
    } else if (e.key === 'Tab' && isOpen) {
      // Moving on from the button leaves the menu behind
      setOpenMenu(null);
    }
  };

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Tab') {
      // Tab is a way out of the menu, not a way round it. Focus goes to the button
      // first so the Tab carries on from there, not from an item about to vanish.
      shut(true);
      return;
    }
    const items = menuItems();
    const to = stepIndex(e.key, items.indexOf(document.activeElement as HTMLElement), items.length);
    if (to === null) return;
    e.preventDefault();
    items[to]?.focus();
  };

  const activeLabel = entries
    .flatMap((e) => (e.kind === 'group' ? e.items : [e]))
    .find((i) => i.page === current)?.label;

  return (
    <>
      <nav className="nav" ref={navRef}>
        {entries.map((entry) => {
          if (entry.kind === 'link') {
            return (
              <button
                key={entry.page}
                className={`nav-top ${current === entry.page ? 'active' : ''}`}
                aria-current={current === entry.page ? 'page' : undefined}
                onClick={() => go(entry.page)}
              >
                {/* The icons and the caret are decoration: read aloud they come out
                    as "baseball" and "black down-pointing small triangle" */}
                <span className="nav-icon" aria-hidden="true">{entry.hint}</span>
                {entry.label}
              </button>
            );
          }
          const holdsCurrent = entry.items.some((i) => i.page === current);
          const isOpen = openMenu === entry.label;
          return (
            <div key={entry.label} className="nav-group">
              <button
                className={`nav-top ${holdsCurrent ? 'active' : ''} ${isOpen ? 'open' : ''}`}
                aria-haspopup="menu"
                aria-expanded={isOpen}
                onClick={(e) => {
                  // Enter and Space arrive as a click with no pointer behind it
                  // (detail 0), and a keyboard wants to be inside what it opened
                  if (!isOpen && e.detail === 0) landOn.current = 'first';
                  setOpenMenu(isOpen ? null : entry.label);
                }}
                onKeyDown={(e) => onTriggerKey(e, entry.label, isOpen)}
              >
                <span className="nav-icon" aria-hidden="true">{entry.icon}</span>
                {entry.label}
                <span className="nav-caret" aria-hidden="true">▾</span>
              </button>
              {isOpen && (
                <div className="nav-dropdown" role="menu" aria-label={entry.label} onKeyDown={onMenuKey}>
                  {entry.items.map((item) => (
                    // tabIndex -1: the arrow keys move between these, so the
                    // whole menu is one stop on the way through the page
                    <button
                      key={item.page}
                      role="menuitem"
                      tabIndex={-1}
                      className={current === item.page ? 'active' : ''}
                      aria-current={current === item.page ? 'page' : undefined}
                      onClick={() => go(item.page, true)}
                    >
                      <span className="nav-item-label">{item.label}</span>
                      <span className="nav-item-hint">{item.hint}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>
      {activeLabel && <div className="page-title">{activeLabel}</div>}
    </>
  );
}
