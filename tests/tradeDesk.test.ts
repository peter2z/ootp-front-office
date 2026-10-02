import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../server/db.js';
import { clearStatCaches, computeBatting, leagueBaseline } from '../server/stats.js';
import { clearValuationCaches } from '../server/valuation.js';
import { clearTradeCache, summarizeSide, tradeContext } from '../server/trade.js';
import { leagueRulesBriefing } from '../server/chat.js';
import { tradingBlock } from '../server/tradingblock.js';
import { IDS, SEASON } from './fixture.js';

/**
 * What the AI trade desk is told about a man's season.
 *
 * "The AI trade desk is told the stats are park- and league-adjusted; they are
 * not." It added a man's Triple-A season to his major-league one, measured the
 * total against whichever level he was at now, and passed team 0 for the park
 * — so no park at all — while the chat's prompt assured the model the figures
 * were adjusted for both. A Coors Field season read as a great one.
 *
 * Each level now gets its own line, read against that level's league and
 * adjusted for the park he played in. And the staff chat, which had the date
 * and the organisation but none of the league's rules, is now told them.
 */

/** Up from Triple-A this year, so he has a line at two levels. */
const SHUTTLE = 7100;
/** Traded between two major-league clubs mid-season. */
const MOVER = 7101;
const GIVE = 7102;
/** Listed by the club he was traded to: the trading block reads his line as well. */
const LISTED = 7103;

type Line = Record<string, number | string | null>;
const mlbRow = { pa: 60, ab: 54, h: 15, d: 3, t3: 0, hr: 3, bb: 5, ibb: 0, hp: 1, sf: 0, k: 14 };
const aaaRow = { pa: 200, ab: 180, h: 60, d: 12, t3: 2, hr: 10, bb: 16, ibb: 1, hp: 2, sf: 2, k: 40 };
const awayRow = { pa: 150, ab: 135, h: 40, d: 9, t3: 1, hr: 6, bb: 12, ibb: 0, hp: 2, sf: 1, k: 30 };
const homeRow = { pa: 100, ab: 90, h: 30, d: 6, t3: 0, hr: 5, bb: 9, ibb: 0, hp: 0, sf: 1, k: 20 };

function addBatter(id: number, team: number, position: number): void {
  db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Desk', ?, 26, ?, 0, 1, 1, 0, ?, ?, 0, 0, 0, 0)`
  ).run(id, `Man${id}`, position, team, team === IDS.aaaTeam ? IDS.mlbTeam : team);
  db.prepare(
    `INSERT INTO players_value
       (player_id, overall_value, talent_value, offensive_value, offensive_value_vsl,
        offensive_value_vsr, pitching_value, oa_rating, pot_rating, oa, pot)
     VALUES (?, 1100, 1100, 100, 100, 100, 0, 50, 50, 50, 50)`
  ).run(id);
  db.prepare(
    `INSERT INTO players_roster_status
       (player_id, is_active, is_on_dl, is_on_dl60, is_on_secondary,
        mlb_service_years, mlb_service_days, mlb_service_days_this_year)
     VALUES (?, 1, 0, 0, 1, 1.0, 172, 40)`
  ).run(id);
}

function addLine(id: number, team: number, level: number, row: typeof mlbRow): void {
  db.prepare(
    `INSERT INTO players_career_batting_stats
       (player_id, year, team_id, league_id, level_id, split_id, pa, ab, h, d, t, hr, bb, ibb,
        hp, sf, k, sb, cs, r, rbi, war)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 10, 10, 0.5)`
  ).run(id, SEASON, team, IDS.league, level, row.pa, row.ab, row.h, row.d, row.t3, row.hr,
        row.bb, row.ibb, row.hp, row.sf, row.k);
}

const linesOf = (id: number): Line[] => {
  const ctx = tradeContext(IDS.mlbTeam, [GIVE], [id]);
  const man = (ctx.weReceive as Array<{ player_id: number; seasonLines: Line[] }>)
    .find((p) => p.player_id === id);
  return man!.seasonLines;
};

beforeAll(() => {
  // A hitters' park at home, a pitchers' park across town, a neutral farm
  db.exec(`ALTER TABLE teams ADD COLUMN park_id INTEGER`);
  db.exec(`UPDATE teams SET park_id = team_id`);
  db.exec(`CREATE TABLE parks (park_id INTEGER, avg REAL, hr REAL)`);
  const park = db.prepare(`INSERT INTO parks VALUES (?, ?, ?)`);
  park.run(IDS.mlbTeam, 1.2, 1.2);
  park.run(IDS.otherMlbTeam, 0.9, 0.9);
  park.run(IDS.aaaTeam, 1, 1);

  addBatter(SHUTTLE, IDS.aaaTeam, 7);
  addLine(SHUTTLE, IDS.mlbTeam, 1, mlbRow);
  addLine(SHUTTLE, IDS.aaaTeam, 2, aaaRow);

  addBatter(MOVER, IDS.mlbTeam, 8);
  addLine(MOVER, IDS.otherMlbTeam, 1, awayRow);
  addLine(MOVER, IDS.mlbTeam, 1, homeRow);

  addBatter(GIVE, IDS.mlbTeam, 7);

  addBatter(LISTED, IDS.mlbTeam, 9);
  addLine(LISTED, IDS.otherMlbTeam, 1, awayRow);
  addLine(LISTED, IDS.mlbTeam, 1, homeRow);
  db.prepare(`UPDATE players_roster_status SET trade_status = 2 WHERE player_id = ?`).run(LISTED);

  clearStatCaches();
  clearValuationCaches();
  clearTradeCache();
});

describe('the season lines the trade desk reads', () => {
  it('gives each level its own line, labelled, rather than one sum', () => {
    const lines = linesOf(SHUTTLE);
    expect(lines.map((l) => l.level)).toEqual(['MLB', 'AAA']);
    expect(lines.map((l) => l.pa)).toEqual([mlbRow.pa, aaaRow.pa]);
  });

  it('reads each line against its own level and in the park he played in', () => {
    const [mlb, aaa] = linesOf(SHUTTLE);
    const majors = leagueBaseline(IDS.league, SEASON, 1);
    expect(mlb.opsPlus).toBe(computeBatting(mlbRow, majors, IDS.mlbTeam).opsPlus);
    expect(mlb.wrcPlus).toBe(computeBatting(mlbRow, majors, IDS.mlbTeam).wrcPlus);
    // The park is not decoration: in a hitters' park the same line is worth less
    expect(mlb.opsPlus as number).toBeLessThan(computeBatting(mlbRow, majors, null).opsPlus as number);
    const farm = leagueBaseline(IDS.league, SEASON, 2);
    expect(aaa.opsPlus).toBe(computeBatting(aaaRow, farm, IDS.aaaTeam).opsPlus);
  });

  it('keeps a mid-season move as one line for the level, with each club in its own park', () => {
    const [mlb] = linesOf(MOVER);
    expect(mlb.pa).toBe(awayRow.pa + homeRow.pa);
    const byClub = mlb.byClub as unknown as Array<Line>;
    expect(byClub).toHaveLength(2);
    const majors = leagueBaseline(IDS.league, SEASON, 1);
    const away = byClub.find((c) => c.club === 'OTH');
    const home = byClub.find((c) => c.club === 'TST');
    expect(away?.opsPlus).toBe(computeBatting(awayRow, majors, IDS.otherMlbTeam).opsPlus);
    expect(home?.opsPlus).toBe(computeBatting(homeRow, majors, IDS.mlbTeam).opsPlus);
  });

  it('hands the desk the same surplus figures the page shows', () => {
    const ctx = tradeContext(IDS.mlbTeam, [GIVE], [SHUTTLE]);
    expect(ctx.totals.surplusSent).toBe(summarizeSide([GIVE]).surplus);
    expect(ctx.totals.surplusReceived).toBe(summarizeSide([SHUTTLE]).surplus);
    expect(typeof ctx.totals.verdict).toBe('string');
  });
});

describe('the lines on the trading block', () => {
  /*
   * The block read its lines with no park at all, so the same season scored
   * one way on the block and another at the desk. It reads them as the desk
   * does now: in the park of the club he did most of his work for.
   */
  it('reads a season in the park he played most of it in', () => {
    const him = tradingBlock().listed.find((p) => p.player_id === LISTED);
    const wrcPlus = Number(/(\d+) wRC\+/.exec(him?.seasonLine ?? '')?.[1]);
    const total = Object.fromEntries(
      (Object.keys(awayRow) as Array<keyof typeof awayRow>).map((k) => [k, awayRow[k] + homeRow[k]])
    );
    const majors = leagueBaseline(IDS.league, SEASON, 1);
    // A hundred and fifty of his 250 plate appearances came across town, in the pitchers' park
    expect(wrcPlus).toBe(computeBatting(total, majors, IDS.otherMlbTeam).wrcPlus);
    expect(wrcPlus).not.toBe(computeBatting(total, majors, null).wrcPlus);
  });
});

describe('the league rules every voice is told', () => {
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

  it('says what the save carries, and stays short', () => {
    const said = leagueRulesBriefing(IDS.mlbTeam);
    expect(said).toContain('uses the designated hitter');
    expect(said).toContain('Free agency after 6 years');
    expect(said).toContain('arbitration from 3');
    expect(said).toContain('20-80 scale');
    expect(words(said)).toBeLessThan(120);
  });

  it('leaves out what the export does not carry rather than guessing', () => {
    // This fixture's league row has no roster or option settings at all
    const said = leagueRulesBriefing(IDS.mlbTeam);
    expect(said).not.toContain('Roster limits');
    expect(said).not.toContain('option');
  });

  it('reads roster sizes and option rules where the save has them', () => {
    for (const column of [
      'rules_active_roster_limit', 'rules_secondary_roster_limit', 'rules_expanded_roster_limit',
      'rules_minor_league_options', 'rules_min_service_days',
    ]) {
      db.exec(`ALTER TABLE leagues ADD COLUMN ${column} INTEGER`);
    }
    db.prepare(
      `UPDATE leagues SET rules_active_roster_limit = 26, rules_secondary_roster_limit = 40,
                          rules_expanded_roster_limit = 28, rules_minor_league_options = 1,
                          rules_min_service_days = 172`
    ).run();
    const said = leagueRulesBriefing(IDS.mlbTeam);
    expect(said).toContain('26 active (28 once rosters expand) and a 40-man roster');
    expect(said).toContain('out of options must clear waivers');
    expect(said).toContain('a service year is 172 days');
    expect(words(said)).toBeLessThan(120);
  });

  it('says so when the pitcher bats', () => {
    db.prepare(`UPDATE sub_leagues SET designated_hitter = 0`).run();
    expect(leagueRulesBriefing(IDS.mlbTeam)).toContain('no designated hitter: the pitcher bats');
    db.prepare(`UPDATE sub_leagues SET designated_hitter = 1`).run();
  });

  it('says so when there is no free agency to reach', () => {
    db.prepare(`UPDATE leagues SET rules_fa_minimum_years = 0`).run();
    expect(leagueRulesBriefing(IDS.mlbTeam)).toContain('No free agency');
    db.prepare(`UPDATE leagues SET rules_fa_minimum_years = 6`).run();
  });
});
