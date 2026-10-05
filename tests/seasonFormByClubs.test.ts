import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../server/db.js';
import { seasonFormByClubs, seasonFormByPlayer } from '../server/form.js';
import request from './request.js';
import { PLAN, seedPlannerOrg } from './plannerFixture.js';

/**
 * The planner reads every club's season form in one pass rather than one call
 * per club, which on a real save walked the season's stats eight times over.
 * The one pass must hand each club exactly what the single call does: the
 * club's own men, at the club's own level, against its own league-season.
 */

const clubs = Object.values(PLAN.teams);

beforeAll(async () => {
  await request('/api/status');
  seedPlannerOrg();
});

describe('season form for several clubs at once', () => {
  it('gives every club of the planner org what one call per club gives', () => {
    const together = seasonFormByClubs(clubs);
    expect([...together.keys()].sort()).toEqual([...clubs].sort());
    for (const club of clubs) {
      const alone = seasonFormByPlayer(club);
      const mine = together.get(club)!;
      expect([...mine.entries()], `club ${club}`).toEqual([...alone.entries()]);
    }
  });

  it('has lines to compare, or the equality above proves nothing', () => {
    const together = seasonFormByClubs(clubs);
    const filled = clubs.filter((c) => (together.get(c)?.size ?? 0) > 0);
    expect(filled.length).toBeGreaterThanOrEqual(4);
    // Batters and pitchers both, so both halves of the pass are covered
    const units = new Set([...together.values()].flatMap((m) => [...m.values()].map((f) => f.unit)));
    expect(units).toEqual(new Set(['PA', 'IP']));
  });

  /*
   * Both of the above now run through the one pass, so this asks the tables
   * the way the single call used to — one club, its level bound as a value —
   * and holds the pass to the same men and the same samples.
   */
  it('reads the same men and samples as the per-club query it replaced', () => {
    const together = seasonFormByClubs(clubs);
    const year = (db.prepare(
      `SELECT MAX(y) AS y FROM (SELECT MAX(year) AS y FROM players_career_batting_stats
                              UNION ALL SELECT MAX(year) FROM players_career_pitching_stats)`
    ).get() as { y: number }).y;
    for (const club of clubs) {
      const { level } = db.prepare(`SELECT level FROM teams WHERE team_id = ?`).get(club) as { level: number };
      const pit = db.prepare(
        `SELECT s.player_id, SUM(s.outs) AS outs FROM players_career_pitching_stats s
         JOIN players p ON p.player_id = s.player_id
         WHERE s.year = ? AND s.split_id = 1 AND s.level_id = ? AND p.team_id = ? GROUP BY s.player_id`
      ).all(year, level, club) as Array<{ player_id: number; outs: number }>;
      const bat = db.prepare(
        `SELECT s.player_id, SUM(s.pa) AS pa FROM players_career_batting_stats s
         JOIN players p ON p.player_id = s.player_id
         WHERE s.year = ? AND s.split_id = 1 AND s.level_id = ? AND p.team_id = ? AND p.position <> 1
         GROUP BY s.player_id`
      ).all(year, level, club) as Array<{ player_id: number; pa: number }>;
      const want = new Map<number, number>();
      for (const r of pit) want.set(r.player_id, Math.round((r.outs / 3) * 10) / 10);
      for (const r of bat) want.set(r.player_id, r.pa ?? 0);
      const got = together.get(club)!;
      expect(new Map([...got].map(([id, f]) => [id, f.sample])), `club ${club}`).toEqual(want);
    }
  });

  it('puts each man under his own club only', () => {
    const teamOf = db.prepare(`SELECT team_id FROM players WHERE player_id = ?`);
    for (const [club, forms] of seasonFormByClubs(clubs)) {
      for (const id of forms.keys()) {
        expect((teamOf.get(id) as { team_id: number }).team_id, `player ${id}`).toBe(club);
      }
    }
  });

  it('does not depend on the order or repetition of the clubs asked for', () => {
    const forward = seasonFormByClubs(clubs);
    const backward = seasonFormByClubs([...clubs].reverse().concat(clubs[0]));
    for (const club of clubs) {
      expect([...backward.get(club)!.entries()]).toEqual([...forward.get(club)!.entries()]);
    }
  });

  it('leaves out a club the teams table does not know, as the single call returns nothing for it', () => {
    const out = seasonFormByClubs([PLAN.teams.mlb, 987654]);
    expect(out.has(987654)).toBe(false);
    expect(seasonFormByPlayer(987654).size).toBe(0);
    expect(seasonFormByClubs([]).size).toBe(0);
  });
});
