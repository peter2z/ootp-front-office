import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../server/db.js';
import { clearValuationCaches } from '../server/valuation.js';
import { clearTradeCache } from '../server/trade.js';
import request, { post } from './request.js';
import { IDS } from './fixture.js';

/**
 * Pricing a deal.
 *
 * "The trade analyzer's 'value swing' is a raw sum, so a throw-in beats a
 * star." Josh Jung, an 80th-percentile third baseman, came out behind Ronny
 * Mauricio (34th) and Ted Forrest, a seventeen-year-old valued at 356 — a
 * value swing of -98, coloured on the page as though it were a verdict. Two
 * numbers add up to more than one, and that was the whole of the reasoning.
 *
 * The verdict is now taken on surplus over replacement: what each man is worth
 * beyond what a club could get for nothing, which a throw-in adds nothing to.
 * Replacement is measured within each man's own group, because OOTP's value
 * bakes in playing time and a closer's total can never reach an everyday
 * player's however good he is.
 */

/** A club of a hundred major leaguers, spread evenly, so percentiles mean what they say. */
const POOL_CLUB = 50;
const POOL = Array.from({ length: 100 }, (_, i) => 9000 + i);
const POOL_STARTERS = Array.from({ length: 20 }, (_, i) => 9100 + i);
const POOL_RELIEVERS = Array.from({ length: 20 }, (_, i) => 9120 + i);

// The real case, at the real values
const JUNG = 9200;
const MAURICIO = 9201;
/** Seventeen, unassigned, parked on the big-league club with no roster place. */
const FORREST = 9202;
/** Two of a kind, for the deal that should come out even. */
const TWIN_A = 9203;
const TWIN_B = 9204;
const CLOSER = 9205;
const REGULAR = 9206;
const STAR = 9207;
const DEPTH = [9208, 9209, 9210];

const POSITIONS = [2, 3, 4, 5, 6, 7, 8, 9];

function addPlayer(
  id: number, opts: { team: number; position: number; value: number; role?: number; age?: number; rostered?: boolean }
): void {
  db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Trade', ?, ?, ?, ?, 1, 1, 0, ?, ?, 0, 0, 0, 0)`
  ).run(id, `Man${id}`, opts.age ?? 27, opts.position, opts.role ?? 0, opts.team, opts.team);
  db.prepare(
    `INSERT INTO players_value
       (player_id, overall_value, talent_value, offensive_value, offensive_value_vsl,
        offensive_value_vsr, pitching_value, oa_rating, pot_rating, oa, pot)
     VALUES (?, ?, ?, 100, 100, 100, 0, 50, 50, 50, 50)`
  ).run(id, opts.value, opts.value);
  if (opts.rostered !== false) {
    db.prepare(
      `INSERT INTO players_roster_status
         (player_id, is_active, is_on_dl, is_on_dl60, is_on_secondary,
          mlb_service_years, mlb_service_days, mlb_service_days_this_year)
       VALUES (?, 1, 0, 0, 1, 3.0, ?, 40)`
    ).run(id, 3 * 172);
  }
}

const name = (id: number) => `Trade Man${id}`;

beforeAll(() => {
  db.prepare(
    `INSERT INTO teams (team_id, name, nickname, abbr, level, league_id, sub_league_id,
                        division_id, parent_team_id, allstar_team, human_team)
     VALUES (?, 'Pool', 'Club', 'POO', 1, ?, 0, 0, 0, 0, 0)`
  ).run(POOL_CLUB, IDS.league);
  POOL.forEach((id, i) => addPlayer(id, { team: POOL_CLUB, position: POSITIONS[i % 8], value: 900 + 5 * i }));
  POOL_STARTERS.forEach((id, i) => addPlayer(id, { team: POOL_CLUB, position: 1, role: 11, value: 1000 + 10 * i }));
  POOL_RELIEVERS.forEach((id, i) => addPlayer(id, { team: POOL_CLUB, position: 1, role: 12, value: 600 + 10 * i }));

  addPlayer(JUNG, { team: IDS.otherMlbTeam, position: 5, value: 1296 });
  addPlayer(MAURICIO, { team: IDS.otherMlbTeam, position: 6, value: 1038 });
  addPlayer(FORREST, { team: IDS.otherMlbTeam, position: 8, value: 356, age: 17, rostered: false });
  addPlayer(TWIN_A, { team: IDS.mlbTeam, position: 7, value: 1150 });
  addPlayer(TWIN_B, { team: IDS.otherMlbTeam, position: 7, value: 1150 });
  addPlayer(CLOSER, { team: IDS.mlbTeam, position: 1, role: 13, value: 1000 });
  addPlayer(REGULAR, { team: IDS.otherMlbTeam, position: 3, value: 1000 });
  addPlayer(STAR, { team: IDS.mlbTeam, position: 9, value: 1390 });
  for (const id of DEPTH) addPlayer(id, { team: IDS.otherMlbTeam, position: 8, value: 1250 });

  clearValuationCaches();
  clearTradeCache();
});

const analyze = (sideA: number[], sideB: number[]) => post('/api/trade/analyze', { sideA, sideB });

describe('the verdict on a deal', () => {
  it('does not let a throw-in beat a star', async () => {
    const r = await analyze([JUNG], [MAURICIO, FORREST]);
    // The trap is still there in the raw sum: two men add up to more than one
    expect(r.valueDiff).toBeLessThan(0);
    // ...and the verdict no longer falls into it
    expect(r.verdict).not.toBe('sideB');
    expect(r.verdict).toBe('sideA');
    expect(r.surplusDiff).toBeGreaterThan(0);
  });

  it('gives a throw-in no surplus at all', async () => {
    const r = await analyze([JUNG], [MAURICIO, FORREST]);
    const forrest = r.sideB.players.find((p: { player_id: number }) => p.player_id === FORREST);
    expect(forrest.surplus).toBe(0);
    // So the two-man side is worth exactly what Mauricio is worth over replacement
    const mauricio = r.sideB.players.find((p: { player_id: number }) => p.player_id === MAURICIO);
    expect(r.sideB.surplus).toBe(mauricio.surplus);
  });

  it('names the best man on each side by percentile, separately from the sum', async () => {
    const r = await analyze([JUNG], [MAURICIO, FORREST]);
    expect(r.sideA.bestName).toBe(name(JUNG));
    expect(r.sideB.bestName).toBe(name(MAURICIO));
    // The real case: Jung around the 80th, Mauricio in the 30s
    expect(r.sideA.bestPct).toBeGreaterThanOrEqual(75);
    expect(r.sideB.bestPct).toBeLessThanOrEqual(40);
    // The sum is still reported, as a figure rather than a verdict
    expect(r.sideA.totalValue).toBe(1296);
    expect(r.sideB.totalValue).toBe(1394);
  });

  it('calls a one-for-one of equals even', async () => {
    const r = await analyze([TWIN_A], [TWIN_B]);
    expect(r.verdict).toBe('even');
    expect(r.surplusDiff).toBe(0);
    expect(r.warning).toBeNull();
  });

  it('measures a reliever against relievers, not against everyday players', async () => {
    /*
     * The same raw value either way, and a raw sum calls it a wash. But 1,000
     * is an elite closer and a replacement-level first baseman: relievers
     * pitch sixty-five innings, so their values sit hundreds of points lower,
     * and only a group's own replacement level can see what each is worth.
     */
    const r = await analyze([CLOSER], [REGULAR]);
    expect(r.valueDiff).toBe(0);
    expect(r.verdict).toBe('sideA');
    expect(r.sideA.surplus).toBeGreaterThan(r.sideB.surplus);
  });

  it('warns when the bigger surplus is only depth', async () => {
    // Three good regulars outweigh one star on surplus, and the star is still
    // the best man in the deal by a distance — roster places are not free
    const r = await analyze([STAR], DEPTH);
    expect(r.verdict).toBe('sideB');
    expect(r.warning).toBe('quantity-for-quality');
  });

  it('does not warn when the side giving up more also has the best man', async () => {
    const r = await analyze([JUNG], [MAURICIO, FORREST]);
    expect(r.warning).toBeNull();
  });
});

describe('an offer from the inbox', () => {
  /*
   * "The same figures the analyser reports, so an offer read here and one
   * pasted into the builder can never disagree." Which now has to include the
   * verdict, or the offer card would go on reading the raw sum.
   */
  it('carries the same verdict the analyser gives', async () => {
    for (const column of [
      'sender_id', 'trade_id',
      ...Array.from({ length: 9 }, (_, i) => `player_id_${i + 1}`),
    ]) {
      db.exec(`ALTER TABLE messages ADD COLUMN ${column} INTEGER DEFAULT 0`);
    }
    db.prepare(
      `INSERT INTO messages (message_id, subject, date, message_type, team_id_0, team_id_1,
                             player_id_0, player_id_1, league_id_0, deleted, recipient_id,
                             sender_type, sender_id, trade_id)
       VALUES (9300, 'Trade proposal', '2030-5-20', 4, 0, 0, ?, ?, ?, 0, 1, 0, ?, 77)`
    ).run(JUNG, TWIN_A, IDS.league, IDS.otherMlbTeam);

    const { proposals } = await request(`/api/trade-proposals/${IDS.mlbTeam}`);
    expect(proposals).toHaveLength(1);
    const offer = proposals[0];
    expect(offer.weSend.players.map((p: { player_id: number }) => p.player_id)).toEqual([TWIN_A]);
    expect(offer.theySend.players.map((p: { player_id: number }) => p.player_id)).toEqual([JUNG]);

    const priced = await analyze([TWIN_A], [JUNG]);
    expect(offer.verdict).toBe(priced.verdict);
    expect(offer.surplusDiff).toBe(priced.surplusDiff);
    // Jung is worth more over replacement than the left fielder going the other way
    expect(offer.verdict).toBe('sideB');
  });
});
