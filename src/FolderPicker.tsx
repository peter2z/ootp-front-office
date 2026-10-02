import { useEffect, useState } from 'react';
import {
  desktopBridge, getSearchLocations, resolveFolder,
  type SaveInfo, type SearchLocation,
} from './api';

/**
 * The hint in the empty field. One generic path was shown on every platform, and
 * on Windows it looks nothing like a real one, so Windows gets its own. It is a
 * pattern and not a promise: OneDrive often moves Documents to
 * C:\Users\<you>\OneDrive\Documents, and the list below says where we looked.
 */
const GENERIC_EXAMPLE = '/path/to/Your Save.lg';
const WINDOWS_EXAMPLE =
  'C:\\Users\\<you>\\Documents\\Out of the Park Developments\\OOTP Baseball 27\\saved_games\\<name>.lg';

/**
 * Fallback for when auto-detection doesn't find the user's save — a custom OOTP
 * install, an external drive, a cloud-synced folder. Shows where we looked,
 * offers a native folder picker in the desktop app, and accepts a typed path
 * everywhere else.
 */
export function FolderPicker({ onResolved }: { onResolved: (save: SaveInfo) => void }) {
  const [locations, setLocations] = useState<SearchLocation[]>([]);
  // The server's platform, not the browser's: it is the machine that reads the path typed here
  const [platform, setPlatform] = useState<string | null>(null);
  const [manualPath, setManualPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<SaveInfo[] | null>(null);
  const desktop = desktopBridge();

  useEffect(() => {
    getSearchLocations()
      .then((r) => {
        setLocations(r.locations);
        setPlatform(r.platform);
      })
      .catch(() => {});
  }, []);

  const tryPath = async (candidate: string) => {
    if (!candidate.trim()) return;
    setBusy(true);
    setError(null);
    setChoices(null);
    try {
      const result = await resolveFolder(candidate);
      if (result.ok && result.csvDir) {
        onResolved({
          name: result.saveName ?? 'Selected save',
          lgPath: candidate,
          csvDir: result.csvDir,
          csvCount: result.csvCount ?? 0,
          csvLastModified: null,
        });
      } else if (result.saves?.length) {
        setChoices(result.saves);
      } else {
        setError(result.error ?? 'That folder could not be used.');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const browse = async () => {
    const picked = await desktop?.selectFolder(manualPath || undefined);
    if (picked) {
      setManualPath(picked);
      void tryPath(picked);
    }
  };

  return (
    <div className="folder-picker">
      <h3>Can't find your save?</h3>
      <p className="muted">
        {desktop
          ? 'Browse for it, or paste the path below. '
          : 'Paste the folder path below. '}
        You can pick the save folder (it ends in <code>.lg</code>), the folder holding your saves, or the{' '}
        <code>import_export/csv</code> folder itself — whichever is easiest to find.
      </p>

      <div className="folder-row">
        {desktop && (
          <button className="btn-feature" onClick={browse} disabled={busy}>
            📁 Browse…
          </button>
        )}
        <input
          className="trade-search folder-input"
          placeholder={platform === 'win32' ? WINDOWS_EXAMPLE : GENERIC_EXAMPLE}
          value={manualPath}
          onChange={(e) => setManualPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void tryPath(manualPath)}
        />
        <button onClick={() => void tryPath(manualPath)} disabled={busy || !manualPath.trim()}>
          {busy ? 'Checking…' : 'Use this folder'}
        </button>
      </div>

      {error && <div className="banner error folder-error">{error}</div>}

      {choices && (
        <div className="folder-choices">
          <p className="muted">Found {choices.length} saves there — pick one:</p>
          {choices.map((s) => (
            <button
              key={s.lgPath}
              className="save-card"
              disabled={s.csvCount === 0}
              onClick={() => onResolved(s)}
            >
              <strong>{s.name}</strong>
              {s.csvCount > 0 ? (
                <span className="ok">
                  {s.csvCount} CSV files
                  {s.csvLastModified ? ` · exported ${new Date(s.csvLastModified).toLocaleString()}` : ''}
                </span>
              ) : (
                <span className="warn">No CSV export yet — export from OOTP first</span>
              )}
            </button>
          ))}
        </div>
      )}

      {locations.length > 0 && (
        <details className="folder-searched">
          <summary>Where we looked ({locations.filter((l) => l.exists).length} of {locations.length} found)</summary>
          <ul>
            {locations.map((l) => (
              <li key={l.path}>
                <span className={l.exists ? 'ok' : 'muted'}>{l.exists ? '✓' : '✕'}</span> {l.label}
                <code>{l.path}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
