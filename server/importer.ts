import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { db } from './db.js';

export interface ImportResult {
  tables: number;
  rows: number;
  startedAt: string;
  finishedAt: string;
  files: Array<{ table: string; rows: number }>;
  /** The save the import was made for; set by runImport, absent in a record written before 0.42.0. */
  saveName?: string | null;
}

/** Where the import has got to, for a page that would rather not look frozen. */
export interface ImportProgress {
  /** The table being written, as OOTP names the file. */
  table: string;
  /** 1-based, so it reads as "12 of 70" without arithmetic. */
  fileIndex: number;
  files: number;
  /** Rows written so far, across every table. */
  rows: number;
  phase: 'reading' | 'writing' | 'indexing';
}

/**
 * Hands the event loop back.
 *
 * The import used to be one synchronous run of seventy files and three hundred
 * megabytes, which on a single-threaded server meant nothing else was answered
 * for its whole duration — around thirty seconds. The page could poll for
 * progress all it liked; the reply was queued behind the very work it was
 * asking about. So a reader pressing Refresh saw the app hang and then simply
 * come back, with no way to tell the difference between working and broken.
 *
 * Yielding between chunks costs a few milliseconds in total and makes the
 * difference between a frozen window and a progress bar.
 */
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Rows written between breaths.
 *
 * The largest file in a real export is sixty-six megabytes and some seven
 * hundred thousand rows; per-FILE yielding alone would still hold the server
 * for the ten seconds that one takes. Twenty thousand keeps each stretch to a
 * couple of hundred milliseconds, which a poll every half second cannot notice.
 */
const CHUNK = 20_000;

const NUMERIC = /^-?\d+(\.\d+)?$/;

function sanitizeIdent(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

function decodeCsv(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  let text = buf.toString('utf8');
  // OOTP exports can be Latin-1; fall back if UTF-8 decoding produced
  // replacement characters (accented player names, etc.)
  if (text.includes('�')) text = buf.toString('latin1');
  return text;
}

/**
 * Works out which character separates the fields.
 *
 * OOTP has an "Export Field Delimiter" setting, and it is not always a comma —
 * semicolon is common on European locales, where a comma is the decimal
 * separator. Reading a semicolon file as comma-delimited produces one giant
 * column per row, so the table ends up with a single column named
 * `team_id;name;abbr;...` and every query fails with "no such column: team_id".
 *
 * The header row decides it: whichever candidate appears most often outside
 * quotes is the separator. A one-column file legitimately has none of them, in
 * which case the choice does not matter and comma is as good as any.
 */
function detectDelimiter(text: string): string {
  const header = text.slice(0, text.indexOf('\n') === -1 ? undefined : text.indexOf('\n'));
  let best = ',';
  let bestCount = 0;
  for (const candidate of [',', ';', '\t', '|']) {
    let count = 0;
    let inQuotes = false;
    for (const ch of header) {
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === candidate && !inQuotes) count += 1;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Import every CSV in the export directory into SQLite, one table per file,
 * columns taken from each file's header row. Values that look numeric are
 * stored as numbers so comparisons and math work in SQL.
 */
export async function importCsvDir(
  csvDir: string,
  onProgress?: (p: ImportProgress) => void
): Promise<ImportResult> {
  const startedAt = new Date().toISOString();
  const files = fs
    .readdirSync(csvDir)
    .filter((f) => f.endsWith('.csv'))
    .sort();
  if (files.length === 0) throw new Error(`No .csv files found in ${csvDir}`);

  const result: ImportResult['files'] = [];
  let totalRows = 0;

  for (const [index, file] of files.entries()) {
    const tableName = sanitizeIdent(file.replace(/\.csv$/, ''));
    const say = (phase: ImportProgress['phase']) =>
      onProgress?.({ table: tableName, fileIndex: index + 1, files: files.length, rows: totalRows, phase });
    say('reading');
    // Reading and parsing a sixty-megabyte file is itself a second of work, so
    // the breath comes before it rather than after
    await breathe();
    const text = decodeCsv(path.join(csvDir, file));
    let records: string[][];
    try {
      records = parse(text, {
        delimiter: detectDelimiter(text),
        relax_column_count: true,
        relax_quotes: true,
        skip_empty_lines: true,
      }) as string[][];
    } catch (err) {
      console.warn(`[import] Skipping ${file}: parse error — ${(err as Error).message}`);
      continue;
    }
    if (records.length < 1) continue;

    const header = records[0].map((h, i) => sanitizeIdent(h.trim() || `col_${i}`));
    const dataRows = records.slice(1);

    const columnDefs = header.map((h) => `"${h}"`).join(', ');
    const placeholders = header.map(() => '?').join(', ');

    db.exec(`DROP TABLE IF EXISTS "${tableName}"`);
    db.exec(`CREATE TABLE "${tableName}" (${columnDefs})`);
    const insert = db.prepare(`INSERT INTO "${tableName}" VALUES (${placeholders})`);

    /*
     * One transaction per file still, but driven by hand so the loop can
     * breathe inside it. better-sqlite3's transaction() wrapper is synchronous
     * by design and cannot be awaited across, and committing per chunk instead
     * would leave a half-written table behind any failure. Readers are
     * unaffected either way — the database is in write-ahead mode, so the
     * pages the app queries stay available while this transaction is open.
     */
    say('writing');
    db.exec('BEGIN');
    try {
      const writeChunk = db.transaction((rows: string[][]) => {
        for (const row of rows) {
          const values = header.map((_, i) => {
            const v = row[i];
            if (v === undefined || v === '') return null;
            return NUMERIC.test(v) ? Number(v) : v;
          });
          insert.run(values);
        }
      });
      for (let at = 0; at < dataRows.length; at += CHUNK) {
        writeChunk(dataRows.slice(at, at + CHUNK));
        totalRows += Math.min(CHUNK, dataRows.length - at);
        say('writing');
        await breathe();
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    result.push({ table: tableName, rows: dataRows.length });
  }

  onProgress?.({
    table: 'indexes', fileIndex: files.length, files: files.length, rows: totalRows, phase: 'indexing',
  });
  await breathe();
  buildIndexes();

  return {
    tables: result.length,
    rows: totalRows,
    startedAt,
    finishedAt: new Date().toISOString(),
    files: result,
  };
}

/** The tables whose league-season aggregates get a composite (league_id, year) index. */
const LEAGUE_YEAR_TABLES = new Set(['players_career_batting_stats', 'players_career_pitching_stats']);

/**
 * Single columns indexed on one table only, where the column name is too
 * common to index everywhere it appears.
 *
 * year      "this season" is MAX(year) over the career stats, read by the farm
 *           pages, the season form and the planner; without it each read was a
 *           scan of 700,000 batting lines or 390,000 pitching ones
 * organization_id   the org's men, read by the roster pages, the 40-man and the
 *           planner, each a scan of all 135,000 players in a real save
 */
const TABLE_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ['players_career_batting_stats', 'year'],
  ['players_career_pitching_stats', 'year'],
  ['players', 'organization_id'],
];

/**
 * Indexes the columns every page actually filters on.
 *
 * The import creates plain tables with no indexes, so a lookup like "this
 * player's career stats" scanned all 679,000 rows of players_career_batting_stats.
 * Nothing was obviously broken — the app just did far more work than it needed
 * to on every page, and a player card cost about 0.4s of that.
 *
 * Columns are discovered rather than listed, because the importer is
 * deliberately schema-tolerant: OOTP adds and renames fields between versions,
 * and a hardcoded list would quietly stop covering new tables.
 *
 * Idempotent, and creates whatever is missing. It used to return as soon as
 * any idx_ index existed, which left a database imported by an older version
 * without every index added since — and, because an import replaces only the
 * tables in the export, could leave a re-imported table bare beside indexed
 * ones. Startup calls it on every launch; when everything is there the cost
 * is a schema read per table and no writes.
 *
 * `analyze` says what to measure once something was made: 'all' (the import)
 * runs ANALYZE over the whole database, as every import did; 'new' (startup)
 * measures only the indexes just added unless there were none before, so an
 * upgrade gains its indexes without a whole-database pass on launch.
 */
export function buildIndexes(analyze: 'all' | 'new' = 'all'): void {
  const started = Date.now();
  const have = new Set(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>).map((i) => i.name)
  );
  const fresh = ![...have].some((n) => n.startsWith('idx_'));
  const tables = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>
  ).map((t) => t.name);

  const made: string[] = [];
  const create = (table: string, name: string, columns: string[]): void => {
    if (have.has(name)) return;
    try {
      db.exec(`CREATE INDEX IF NOT EXISTS "${name}" ON "${table}" (${columns.map((c) => `"${c}"`).join(', ')})`);
      have.add(name);
      made.push(name);
    } catch (err) {
      // A malformed table should not fail the whole import
      console.warn(`[import] index on ${table}(${columns.join(', ')}) failed:`, (err as Error).message);
    }
  };
  for (const table of tables) {
    const columns = new Set(
      (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((c) => c.name)
    );
    for (const column of ['player_id', 'team_id', 'game_id', 'league_id']) {
      if (columns.has(column)) create(table, `idx_${table}_${column}`, [column]);
    }
    for (const [only, column] of TABLE_COLUMNS) {
      if (only === table && columns.has(column)) create(table, `idx_${table}_${column}`, [column]);
    }
    // The league baselines sum one league-season at a time, and on the single
    // column indexes above each of those sums still walked every row of the
    // league — about 97 ms per league-season on a real save, which the
    // planner pays twenty-odd times over. A composite index turns each one
    // into a range scan.
    if (LEAGUE_YEAR_TABLES.has(table) && columns.has('league_id') && columns.has('year')) {
      create(table, `idx_${table}_league_year`, ['league_id', 'year']);
    }
  }
  if (made.length === 0) return;
  // Lets SQLite pick between the indexes it now has rather than guessing
  if (analyze === 'all' || fresh) db.exec('ANALYZE');
  else for (const name of made) db.exec(`ANALYZE "${name}"`);
  console.log(`[import] ${made.length} indexes in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
