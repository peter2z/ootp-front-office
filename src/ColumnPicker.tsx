import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { statsFor, type StatDef, type StatGroup } from './stats';
import { stepIndex } from './Nav';

const SECTIONS: Array<StatDef['section']> = ['Counting', 'Rate', 'Advanced'];

export function ColumnPicker({
  group, selected, onChange, onClose, onReset,
}: {
  group: StatGroup;
  selected: string[];
  onChange: (keys: string[]) => void;
  onClose: () => void;
  onReset: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // What had focus when the picker opened, which is the button that opened it.
  // Kept in a ref so that a second pass over the effect below, which React makes
  // in development, does not take the first box — where focus has gone by then —
  // for it.
  const opener = useRef<HTMLElement | null | undefined>(undefined);

  // Focus goes into the list when the picker opens and back to its button when
  // it closes, however it closes. A keyboard that opened it from the button
  // would otherwise be left on the button with forty boxes to Tab through.
  useEffect(() => {
    if (opener.current === undefined) {
      const at = document.activeElement;
      opener.current = at instanceof HTMLElement && at !== document.body ? at : null;
    }
    ref.current?.querySelector<HTMLElement>('input')?.focus();
    return () => {
      const to = opener.current;
      const now = document.activeElement;
      // Only if focus went down with the picker: a click on something else has
      // already put it where the reader wants it
      if (to?.isConnected && (now === null || now === document.body)) to.focus();
    };
  }, []);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const toggle = (key: string) => {
    // Preserve the catalog's order so columns don't jump around as you toggle
    const next = selected.includes(key)
      ? selected.filter((k) => k !== key)
      : statsFor(group).map((s) => s.key).filter((k) => k === key || selected.includes(k));
    onChange(next);
  };

  // Arrow keys, Home and End move between the boxes, as they would in a menu;
  // the two buttons are left to Tab
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!(e.target instanceof HTMLInputElement)) return;
    const boxes = Array.from(e.currentTarget.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    const to = stepIndex(e.key, boxes.indexOf(e.target), boxes.length);
    if (to === null) return;
    e.preventDefault();
    boxes[to]?.focus();
  };

  return (
    <div className="col-picker" ref={ref} role="dialog" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <div className="col-picker-head">
        <strong id={titleId}>{group === 'batting' ? 'Batting' : 'Pitching'} columns</strong>
        <button className="chip-x" onClick={onClose} aria-label="Close column picker">✕</button>
      </div>
      <div className="col-picker-body">
        {SECTIONS.map((section) => (
          <div key={section} className="col-section">
            <span className="col-section-label">{section}</span>
            {statsFor(group)
              .filter((s) => s.section === section)
              .map((s) => (
                <label key={s.key} className="col-option" title={s.desc}>
                  <input
                    type="checkbox"
                    checked={selected.includes(s.key)}
                    onChange={() => toggle(s.key)}
                  />
                  <span className="col-option-label">{s.label}</span>
                  <span className="col-option-desc">{s.desc}</span>
                </label>
              ))}
          </div>
        ))}
      </div>
      <div className="col-picker-foot">
        <span className="muted">{selected.length} shown</span>
        <button onClick={onReset}>Reset to defaults</button>
      </div>
    </div>
  );
}
