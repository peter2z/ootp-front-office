import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS, SEASON } from './fixture.js';

/**
 * League rules are invisible to the player. A reserve-clause league turns off
 * free agency entirely, so expiring deals never become available and the page
 * that listed them should explain why instead of showing an empty table.
 *
 * (docs/review/2026-10-02-front-office-review.md, finding (a).)
 */

interface FreeAgentsResponse {
  rulesNote?: string;
  upcomingFAs: Array<{ name: string }>;
}

beforeAll(() => {
  // The fixture's players table predates the last_league_id column, which is how
  // OOTP says which league a free agent last played in. Add it if missing.
  const columns = (db.prepare(`PRAGMA table_info(players)`).all() as Array<{ name: string }>).map(
    (c) => c.name
  );
  if (!columns.includes('last_league_id')) {
    db.exec(`ALTER TABLE players ADD COLUMN last_league_id INTEGER`);
  }
});

const freeAgents = async (org: number = IDS.mlbTeam): Promise<FreeAgentsResponse> =>
  await request(`/api/free-agents/${org}`) as FreeAgentsResponse;

describe('free agency in reserve-clause leagues', () => {
  it('returns an empty upcoming list with a rules note when the league has no free agency', async () => {
    // In a real reserve-clause league, faMinYears is 0: players never reach the market.
    db.prepare(`UPDATE leagues SET rules_fa_minimum_years = 0 WHERE league_id = ?`).run(IDS.league);

    const response = await freeAgents();
    expect(response.rulesNote).toBe('This league has no free agency: expiring deals renew under the reserve clause');
    expect(response.upcomingFAs).toEqual([]);
  });

  afterAll(() => {
    // Reset the league to its default state so other tests work correctly
    db.prepare(`UPDATE leagues SET rules_fa_minimum_years = 6 WHERE league_id = ?`).run(IDS.league);
  });
});
