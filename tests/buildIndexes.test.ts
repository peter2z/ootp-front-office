import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../server/config.js';
import { db } from '../server/db.js';
import { buildIndexes } from '../server/importer.js';

/**
 * buildIndexes() returned as soon as any idx_ index existed, so an index added
 * in a later version reached only a database imported from scratch, and the
 * planner kept scanning 700,000 stats lines for "this season" on every save
 * imported before it. It now creates whatever is missing, and startup calls it
 * whenever there is a league, so an upgrade gains the indexes without a
 * re-import.
 */

const indexNames = (): string[] =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name`).all() as
    Array<{ name: string }>).map((r) => r.name);

/** What ANALYZE has measured; unchanged when nothing was measured. */
const statRows = (): unknown[] => {
  const has = db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'sqlite_stat1'`).get();
  return has ? db.prepare(`SELECT tbl, idx, stat FROM sqlite_stat1 ORDER BY tbl, idx`).all() : [];
};

afterEach(() => {
  vi.restoreAllMocks();
});

const ADDED = [
  'idx_players_career_batting_stats_year',
  'idx_players_career_pitching_stats_year',
  'idx_players_organization_id',
  'idx_players_career_batting_stats_league_year',
  'idx_players_career_pitching_stats_league_year',
];

describe('building the indexes on a database that already has some', () => {
  it('creates the ones that are missing', () => {
    buildIndexes('new');
    for (const name of ADDED) db.exec(`DROP INDEX IF EXISTS "${name}"`);
    expect(indexNames().length, 'the older indexes are still there').toBeGreaterThan(0);
    expect(indexNames()).not.toContain(ADDED[0]);

    buildIndexes('new');
    for (const name of ADDED) expect(indexNames(), name).toContain(name);
  });

  it('does nothing the second time: no index made, nothing measured, nothing logged', () => {
    buildIndexes('new');
    const before = indexNames();
    const stats = statRows();
    const exec = vi.spyOn(db, 'exec');
    const log = vi.spyOn(console, 'log');
    buildIndexes('new');
    expect(indexNames()).toEqual(before);
    // A skipped check would re-create every index with IF NOT EXISTS and run ANALYZE on every boot
    expect(exec).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(statRows()).toEqual(stats);
  });

  // Not the org's men: on a fixture this small a scan of players is the cheaper plan
  it('answers "this season" from an index rather than a scan', () => {
    buildIndexes('new');
    const plan = (sql: string): string =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail).join(' | ');
    expect(plan(`SELECT MAX(year) FROM players_career_batting_stats`)).toMatch(/idx_players_career_batting_stats_year/);
    expect(plan(`SELECT MAX(year) FROM players_career_pitching_stats`)).toMatch(/idx_players_career_pitching_stats_year/);
  });
});

describe('startup', () => {
  it('gives a league imported by an older version the index it lacks, with no export folder set, and does nothing on the next boot', async () => {
    // Loaded the way the desktop app loads it, so importing it does not start a second server
    process.env.OOTP_FO_EMBEDDED = '1';
    const { bootstrapData } = await import('../server/index.js');
    // No export folder: boot builds the indexes and stops there, importing and watching nothing
    expect(loadConfig().csvDir).toBeNull();
    buildIndexes('new');
    db.exec('DROP INDEX IF EXISTS "idx_players_organization_id"');
    expect(indexNames()).not.toContain('idx_players_organization_id');

    const exec = vi.spyOn(db, 'exec');
    bootstrapData();
    expect(indexNames()).toContain('idx_players_organization_id');
    const ran = exec.mock.calls.map(([sql]) => String(sql));
    expect(ran.filter((sql) => sql.startsWith('CREATE INDEX'))).toHaveLength(1);
    // Only the index just made is measured, not the whole database
    expect(ran.filter((sql) => sql.startsWith('ANALYZE'))).toEqual(['ANALYZE "idx_players_organization_id"']);

    exec.mockClear();
    bootstrapData();
    expect(exec.mock.calls.map(([sql]) => String(sql)).filter((sql) => /CREATE INDEX|ANALYZE/.test(sql))).toEqual([]);
  });
});
