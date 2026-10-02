import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * The farm-system rank, which was a headcount.
 *
 * "Spearman correlation between farm rank and players in the system is 0.973:
 * the top ten farms carry 288-310 players, the Dodgers carry 248 and rank #24."
 * Read off the Org Comparison page of a real save, where the club ranked first
 * in the league for its farm was simply the one that had signed the most men.
 *
 * The rank added up the talent of everybody below the majors. Most of any farm
 * system is filler of one grade, so the total mostly counted the filler, and
 * signing fifty more of it was the cheapest way to climb the table. The rank now
 * takes each system's ten best prospects and nothing below them.
 *
 * These build the league the way a real one goes wrong: one system with a
 * hundred players of the same middling grade against others with a dozen good
 * ones. Four clubs, each with an affiliate, whose scores are far enough apart
 * that nothing here depends on how ties are broken.
 */

const ALPHA = 501;   // twelve at 1500: the best top ten
const BRAVO = 502;   // exactly ten at 1200
const CHARLIE = 503; // thirteen at 1000: a bigger total than Bravo, a worse top ten
const DELTA = 504;   // a hundred at 800: by far the biggest total, the weakest ten
const ECHO = 505;    // only three prospects, all good

/** Where each club's players are kept: an affiliate one level down. */
const affiliate = (club: number): number => club + 100;

let nextId = 30000;

function addClub(id: number, name: string): void {
  const team = db.prepare(
    `INSERT INTO teams (team_id, name, nickname, abbr, level, league_id, sub_league_id,
                        division_id, parent_team_id, allstar_team, human_team)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, 0, 0)`
  );
  team.run(id, name, name, name.slice(0, 3).toUpperCase(), 1, IDS.league, 0);
  team.run(affiliate(id), `${name} Farm`, `${name} Farm`, 'FRM', 2, IDS.league, id);
}

/** Adds men to a club's farm and returns their ids, so a test can take them out again. */
function addProspects(club: number, count: number, talent: number, age: number): number[] {
  const player = db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Farm', ?, ?, 6, 0, 1, 1, 1, ?, ?, 0, 0, 0, 0)`
  );
  const value = db.prepare(
    `INSERT INTO players_value (player_id, overall_value, talent_value) VALUES (?, ?, ?)`
  );
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const id = nextId++;
    player.run(id, `Prospect${id}`, age, affiliate(club), club);
    // Overall is lower than talent: a prospect is worth more tomorrow than today
    value.run(id, Math.round(talent / 2), talent);
    ids.push(id);
  }
  return ids;
}

function remove(ids: number[]): void {
  const holes = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM players WHERE player_id IN (${holes})`).run(...ids);
  db.prepare(`DELETE FROM players_value WHERE player_id IN (${holes})`).run(...ids);
}

interface Club {
  team_id: number; farmTalent: number; farmCount: number; farmRank: number;
  youngTalent: number; youngRank: number; topProspect: number;
}
const clubs = async (): Promise<Club[]> =>
  (await request(`/api/org-comparison/${IDS.mlbTeam}`)).clubs;
const club = async (id: number): Promise<Club> => (await clubs()).find((c) => c.team_id === id)!;

/** What the rank used to be built from: everybody below the majors, added up. */
const oldTotal = (club: number): number =>
  (db
    .prepare(
      `SELECT SUM(v.talent_value) AS total FROM players p
       JOIN players_value v ON v.player_id = p.player_id WHERE p.organization_id = ?`
    )
    .get(club) as { total: number }).total;

beforeAll(() => {
  addClub(ALPHA, 'Alpha');
  addClub(BRAVO, 'Bravo');
  addClub(CHARLIE, 'Charlie');
  addClub(DELTA, 'Delta');
  addClub(ECHO, 'Echo');
  /*
   * Ages are set so the under-22 column has something to separate too: Alpha's
   * are all 23, so none of its talent counts as young at all.
   */
  addProspects(ALPHA, 12, 1500, 23);
  addProspects(BRAVO, 10, 1200, 20);
  addProspects(CHARLIE, 13, 1000, 21);
  addProspects(DELTA, 100, 800, 19);
  addProspects(ECHO, 3, 1400, 20);
});

describe('ranking a farm system', () => {
  it('goes by the best prospects, not by how many men there are', async () => {
    const rank = async (id: number) => (await club(id)).farmRank;
    // Delta signed a hundred men and has the weakest ten of the four
    expect(await rank(ALPHA)).toBeLessThan(await rank(BRAVO));
    expect(await rank(BRAVO)).toBeLessThan(await rank(CHARLIE));
    expect(await rank(CHARLIE)).toBeLessThan(await rank(DELTA));
  });

  it('is a scenario the old headcount rule got wrong', () => {
    /*
     * Guards the test above against passing for the wrong reason. Added up the
     * old way, the hundred middling men put Delta first and the thirteen put
     * Charlie ahead of Bravo — the reverse of who has the better prospects.
     */
    expect(oldTotal(DELTA)).toBeGreaterThan(oldTotal(ALPHA));
    expect(oldTotal(CHARLIE)).toBeGreaterThan(oldTotal(BRAVO));
  });

  it('adds up the ten best, so the score is the sum of those ten', async () => {
    // Alpha has twelve; only ten of them count
    expect((await club(ALPHA)).farmTalent).toBe(10 * 1500);
    expect((await club(BRAVO)).farmTalent).toBe(10 * 1200);
    expect((await club(CHARLIE)).farmTalent).toBe(10 * 1000);
    expect((await club(DELTA)).farmTalent).toBe(10 * 800);
  });

  it('still reports the headcount, for context', async () => {
    // Shown beside the rank on the page; it is just no longer what decides it
    expect((await club(DELTA)).farmCount).toBe(100);
    expect((await club(ALPHA)).farmCount).toBe(12);
  });

  it('counts a system with fewer than ten for what it has', async () => {
    // Three good prospects is a thin system, and the rank says so
    const echo = await club(ECHO);
    expect(echo.farmCount).toBe(3);
    expect(echo.farmTalent).toBe(3 * 1400);
    expect(echo.farmRank).toBeGreaterThan((await club(DELTA)).farmRank);
  });

  it('still names the best single prospect', async () => {
    expect((await club(ALPHA)).topProspect).toBe(1500);
    expect((await club(DELTA)).topProspect).toBe(800);
  });
});

describe('a system that adds fifty replacement-level players', () => {
  const added: number[] = [];
  afterEach(() => {
    if (added.length > 0) remove(added.splice(0));
  });

  it('does not move its rank', async () => {
    /*
     * Fifty men at 800 into Bravo, whose tenth-best prospect is 1200. Under the
     * old rule that is 40,000 points: enough to take Bravo from second of the
     * four to first. Under this one the fifty are not in Bravo's ten, so
     * nothing about Bravo, or about anybody else, can have changed.
     */
    const before = await clubs();
    const bravoBefore = before.find((c) => c.team_id === BRAVO)!;

    added.push(...addProspects(BRAVO, 50, 800, 20));
    const after = await clubs();
    const bravoAfter = after.find((c) => c.team_id === BRAVO)!;

    expect(bravoAfter.farmRank).toBe(bravoBefore.farmRank);
    expect(bravoAfter.farmTalent).toBe(bravoBefore.farmTalent);
    // The headcount did move, which is the whole point of showing it separately
    expect(bravoAfter.farmCount).toBe(bravoBefore.farmCount + 50);
    // And nobody else was shifted by it
    for (const b of before) {
      expect(after.find((c) => c.team_id === b.team_id)!.farmRank, `club ${b.team_id}`).toBe(b.farmRank);
    }
    // The old rule would have put Bravo ahead of Alpha on the strength of it
    expect(oldTotal(BRAVO)).toBeGreaterThan(oldTotal(ALPHA));
  });

  it('does not move the under-22 rank either', async () => {
    const before = await club(BRAVO);
    added.push(...addProspects(BRAVO, 50, 800, 19));
    const after = await club(BRAVO);
    expect(after.youngRank).toBe(before.youngRank);
    expect(after.youngTalent).toBe(before.youngTalent);
  });
});

describe('a system that finds real prospects', () => {
  const added: number[] = [];
  afterEach(() => {
    if (added.length > 0) remove(added.splice(0));
  });

  it('does climb', async () => {
    /*
     * The other half of the same rule, so that "nothing moves it" cannot be
     * satisfied by a rank that never moves at all. Three men at 1900 push
     * Charlie's ten from 10,000 to 12,700, past Bravo's 12,000.
     */
    const before = await club(CHARLIE);
    expect(before.farmRank).toBeGreaterThan((await club(BRAVO)).farmRank);

    added.push(...addProspects(CHARLIE, 3, 1900, 21));
    const after = await club(CHARLIE);
    expect(after.farmTalent).toBe(3 * 1900 + 7 * 1000);
    expect(after.farmRank).toBeLessThan((await club(BRAVO)).farmRank);
  });
});

describe('the under-22 rank', () => {
  it('counts the best ten aged 21 and under, and nobody older', async () => {
    // Alpha's twelve are all 23: the best farm in the league holds no young talent
    expect((await club(ALPHA)).youngTalent).toBe(0);
    expect((await club(BRAVO)).youngTalent).toBe(10 * 1200);
    expect((await club(CHARLIE)).youngTalent).toBe(10 * 1000);
  });

  it('is not the headcount of teenagers', async () => {
    // A hundred nineteen-year-olds at 800 against ten twenty-year-olds at 1200
    const [bravo, delta] = [await club(BRAVO), await club(DELTA)];
    expect(delta.youngTalent).toBe(10 * 800);
    expect(bravo.youngRank).toBeLessThan(delta.youngRank);
  });
});
