import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * Who is on the market, and who would fix a hole.
 *
 * The Free Agents page listed 2,766 players as available now, and 1,594 of them
 * were in the 2,744-man draft pool. OOTP marks the whole class as without a club
 * until it is drafted, and the page took it at its word: Chris Berger, talent
 * 100 and number 12 on the Draft Board, sat on the open market and on the board
 * at once. Only 1,172 were real free agents, and the best of those was at the
 * 70th percentile.
 *
 * The FILLS HOLE badge went to every man who played one of the club's three
 * thinnest positions: 471 players, 470 of them below the 25th percentile of
 * major-league value. Matt Vierling, at the 1st, was marked as fixing a hole.
 *
 * And every free agent's last salary read $0, because a free agent's contract
 * row is empty. What he was paid is in the salary history.
 *
 * (docs/review/2026-10-02-front-office-review.md, finding T5.)
 */

const LEAGUE = IDS.league;
const OTHER_LEAGUE_ID = 999;

// The draft class, in the ways it turns up
const PHENOM = 8700; // flagged, in this league's draft, on the board
const TAKEN = 8701; // flagged, and already picked — the flag stays set
const ELSEWHERE = 8702; // flagged, but for another league's draft
const SENIOR = 8703; // a school year and nothing else: no flag

// Real free agents, all third basemen but two, at values chosen against the pool
const REGULAR = 8710; // 885
const ALMOST = 8711; // 865
const SHORT = 8712; // 845
const LOWER = 8713; // 600
const REPLACEMENT = 8714; // 700
const SHORTSTOP = 8715; // 1100
const RIGHTFIELDER = 8716; // 1100

// Men parked on the other major-league club with no roster spot
const PARKED_2B = 8720;
const PARKED_LF = 8721;
const PARKED_CF = 8722;
const PARKED_RF = 8723;

beforeAll(() => {
  /*
   * The fixture's players table predates this page: it has no last_league_id,
   * which is how OOTP says which league a free agent last played in, and it has
   * no salary history. Added here when they are missing, so this does not break
   * the day the fixture grows them.
   */
  const columns = (db.prepare(`PRAGMA table_info(players)`).all() as Array<{ name: string }>).map(
    (c) => c.name
  );
  if (!columns.includes('last_league_id')) {
    db.exec(`ALTER TABLE players ADD COLUMN last_league_id INTEGER`);
  }
  db.exec(
    `CREATE TABLE IF NOT EXISTS players_salary_history (
       player_id INTEGER, team_id INTEGER, year INTEGER, salary REAL, uniform INTEGER
     )`
  );

  const add = (
    id: number, first: string, last: string, age: number, position: number,
    opts: {
      value?: number; freeAgent?: number; team?: number; draftEligible?: number; picked?: number;
      draftLeague?: number; hsc?: number;
    } = {}
  ) => {
    db.prepare(
      `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                            uniform_number, team_id, organization_id, retired, hidden,
                            draft_eligible, college, picked_in_draft, draft_league_id, hsc_status,
                            free_agent, last_league_id)
       VALUES (?, ?, ?, ?, ?, 0, 1, 1, 0, ?, ?, 0, 0, ?, 0, ?, ?, ?, ?, ?)`
    ).run(
      id, first, last, age, position,
      opts.team ?? 0, opts.team ?? 0,
      opts.draftEligible ?? 0, opts.picked ?? 0, opts.draftLeague ?? 0, opts.hsc ?? 0,
      opts.freeAgent ?? 1, LEAGUE
    );
    db.prepare(
      `INSERT INTO players_value
         (player_id, overall_value, talent_value, offensive_value, offensive_value_vsl,
          offensive_value_vsr, pitching_value, oa_rating, pot_rating, oa, pot)
       VALUES (?, ?, ?, 100, 100, 100, 0, 50, 50, 50, 50)`
    ).run(id, opts.value ?? 100, opts.value ?? 100);
  };
  // A scouted ceiling, or the draft board has nothing to rank him on
  const scouted = (id: number) =>
    db.prepare(`INSERT INTO players_batting VALUES (?, 45, 45, 45, 45, 45, 45, 60, 60, 60, 60, 60)`).run(id);

  /*
   * The draft class. The prospect is a centre fielder worth far more than
   * anybody else on the list, which is exactly what put him at the top of it:
   * the old page would have badged him as the answer to centre field.
   */
  add(PHENOM, 'Draft', 'Phenom', 17, 8, {
    value: 1500, draftEligible: 1, draftLeague: LEAGUE, hsc: 4,
  });
  scouted(PHENOM);
  add(TAKEN, 'Draft', 'Taken', 18, 5, { value: 1300, draftEligible: 1, picked: 1, draftLeague: LEAGUE });
  add(ELSEWHERE, 'Draft', 'Elsewhere', 19, 5, {
    value: 1200, draftEligible: 1, draftLeague: OTHER_LEAGUE_ID,
  });
  add(SENIOR, 'School', 'Senior', 22, 6, { value: 1000, draftLeague: LEAGUE, hsc: 4 });
  scouted(SENIOR);

  // The market proper
  add(REGULAR, 'Vet', 'Regular', 33, 5, { value: 885 });
  add(ALMOST, 'Vet', 'Almost', 31, 5, { value: 865 });
  add(SHORT, 'Vet', 'Short', 30, 5, { value: 845 });
  // The worse of the two goes in first, so the database's own order is the
  // wrong one for the ordering test below
  add(LOWER, 'Vet', 'Lower', 34, 5, { value: 600 });
  add(REPLACEMENT, 'Vet', 'Replacement', 29, 5, { value: 700 });
  add(SHORTSTOP, 'Vet', 'Shortstop', 32, 6, { value: 1100 });
  add(RIGHTFIELDER, 'Vet', 'Rightfielder', 28, 9, { value: 1100 });

  /*
   * Four men on the other club who are nobody's roster: they count as what the
   * club has at the position, and not as major leaguers in the percentile pool.
   * With them, that club has nobody at catcher, third base or short, so those
   * are its thin spots and there is no incumbent to beat at any of them.
   */
  add(PARKED_2B, 'Parked', 'Second', 27, 4, { value: 1300, freeAgent: 0, team: IDS.otherMlbTeam });
  add(PARKED_LF, 'Parked', 'Left', 27, 7, { value: 1300, freeAgent: 0, team: IDS.otherMlbTeam });
  add(PARKED_CF, 'Parked', 'Centre', 27, 8, { value: 1300, freeAgent: 0, team: IDS.otherMlbTeam });
  add(PARKED_RF, 'Parked', 'Right', 27, 9, { value: 1300, freeAgent: 0, team: IDS.otherMlbTeam });

  /*
   * What the export holds for a free agent: a contract row with nothing in it,
   * and a salary history with a placeholder (year 0, salary 0) where there is no
   * season on record. The later season goes in first, so reading the newest is
   * not simply reading the last row written.
   */
  const emptyContract = db.prepare(
    `INSERT INTO players_contract
       (player_id, team_id, contract_team_id, season_year, years, current_year, is_major, retained, salary0)
     VALUES (?, 0, 0, 0, 0, 0, 0, 0, 0)`
  );
  emptyContract.run(REGULAR);
  emptyContract.run(ALMOST);
  const paid = db.prepare(
    `INSERT INTO players_salary_history (player_id, team_id, year, salary, uniform) VALUES (?, ?, ?, ?, 7)`
  );
  paid.run(REGULAR, IDS.otherMlbTeam, 2027, 22_400_000);
  paid.run(REGULAR, IDS.otherMlbTeam, 2026, 20_000_000);
  paid.run(REGULAR, 0, 0, 0);
  paid.run(ALMOST, 0, 0, 0);
});

interface Row {
  player_id: number;
  name: string;
  age: number;
  positionName: string;
  team: string | null;
  overallPct: number | null;
  lastSalary: number | null;
  fillsHole: boolean;
}

interface Market {
  holes: Array<{ positionName: string; bestValue: number | null }>;
  currentFAs: Row[];
  upcomingFAs: Row[];
  amateursLeftOut: number;
}

const market = async (org: number = IDS.mlbTeam): Promise<Market> =>
  await request(`/api/free-agents/${org}`) as Market;

const listed = async (org?: number): Promise<string[]> =>
  (await market(org)).currentFAs.map((p) => p.name);

const row = async (name: string, org?: number): Promise<Row> => {
  const found = (await market(org)).currentFAs.find((p) => p.name === name);
  if (!found) throw new Error(`${name} is not on the list`);
  return found;
};

const board = async (): Promise<number[]> =>
  ((await request(`/api/draft/${IDS.mlbTeam}`)).prospects as Array<{ player_id: number }>).map(
    (p) => p.player_id
  );

describe('the draft class', () => {
  it('is on the draft board, and that is where it is', async () => {
    // The man the rest of this describe is about has to be in the pool, or
    // leaving him off the market proves nothing
    expect(await board()).toContain(PHENOM);
    expect(
      await listed(),
      'a draft prospect was on the open market as well as on the board'
    ).not.toContain('Draft Phenom');
  });

  it('is not on the market once a man has been picked, though the flag stays set', async () => {
    // The flag outlives the pick: 185 men in one save carried both. The board
    // drops him, but he is not a free agent either — his club holds his rights
    expect(await board()).not.toContain(TAKEN);
    expect(await listed(), 'a man already drafted was offered as a free agent').not.toContain('Draft Taken');
  });

  it("is not on the market when it belongs to another league's draft", async () => {
    expect(await board()).not.toContain(ELSEWHERE);
    expect(await listed()).not.toContain('Draft Elsewhere');
  });

  it('never overlaps the board: nobody on it is also listed as a free agent', async () => {
    /*
     * The invariant itself, whatever the individual cases say. Before the fix
     * this overlap was 1,594 players.
     */
    const onBoard = await board();
    expect(onBoard.length, 'the board was empty, so this proved nothing').toBeGreaterThan(0);
    const ids = new Set((await market()).currentFAs.map((p) => p.player_id));
    expect(onBoard.filter((id) => ids.has(id))).toEqual([]);
  });

  it('is counted, so the page can say what it left out', async () => {
    // The prospect, the man already picked, and the one in another league's draft
    expect((await market()).amateursLeftOut).toBe(3);
  });
});

describe('the real free agents', () => {
  it('are still listed', async () => {
    const names = await listed();
    for (const n of ['Vet Regular', 'Vet Almost', 'Vet Short', 'Vet Replacement', 'Vet Shortstop']) {
      expect(names, `${n} was dropped from the market`).toContain(n);
    }
  });

  it('are listed without a club', async () => {
    expect((await row('Vet Regular')).team).toBeNull();
  });

  it('include a man whose only mark is a school year, where the save flags its class', async () => {
    /*
     * The board reads the flag where a save sets one, and so does this page.
     * Three men in the save this was checked against carried a school class and
     * professional seasons but no flag; none was on the board, and all three
     * are among the 1,172 who were genuinely free to sign.
     */
    expect(await board()).not.toContain(SENIOR);
    expect(await listed()).toContain('School Senior');
  });

  it('are ordered by value, and by the value underneath it among the men at the bottom', async () => {
    const list = (await market()).currentFAs;
    const pcts = list.map((p) => p.overallPct ?? -1);
    expect(pcts, 'the list was not in descending order of value').toEqual([...pcts].sort((a, b) => b - a));
    /*
     * Most of a real market sits at percentile 0. Both of these do, and without
     * the second key their order was whatever the database returned.
     */
    const names = list.map((p) => p.name);
    expect(list.find((p) => p.name === 'Vet Replacement')!.overallPct).toBe(0);
    expect(list.find((p) => p.name === 'Vet Lower')!.overallPct).toBe(0);
    expect(names.indexOf('Vet Replacement')).toBeLessThan(names.indexOf('Vet Lower'));
  });
});

describe('the FILLS HOLE badge', () => {
  const thin = (m: Market) => m.holes.slice(0, 3).map((h) => h.positionName).sort();

  it('is written around the thin spots these tests expect', async () => {
    /*
     * Catching drift in the fixture rather than a fault in the page. One club's
     * best men at centre, left and third are the weakest it has; the other has
     * nobody at catcher, third or short.
     */
    expect(thin(await market(IDS.mlbTeam))).toEqual(['3B', 'CF', 'LF']);
    expect(thin(await market(IDS.otherMlbTeam))).toEqual(['3B', 'C', 'SS']);
  });

  it('puts the free agents either side of the 25th percentile', async () => {
    expect((await row('Vet Almost')).overallPct as number).toBeGreaterThanOrEqual(25);
    expect((await row('Vet Short')).overallPct as number).toBeLessThan(25);
  });

  describe('where the club has nobody at the position, so the floor is the whole test', () => {
    const org = IDS.otherMlbTeam;

    it('is given to a man above the floor', async () => {
      expect((await row('Vet Regular', org)).fillsHole).toBe(true);
      // Better than a quarter of the majors, though he would not start for anybody
      expect((await row('Vet Almost', org)).fillsHole).toBe(true);
    });

    it('is withheld from a man below it', async () => {
      /*
       * The 470 of 471: a spot with nobody at it, and a free agent at the 17th
       * percentile who plays it. He is not a hole filler, he is a roster filler.
       */
      expect((await row('Vet Short', org)).fillsHole, 'a man below the floor was badged').toBe(false);
      expect((await row('Vet Replacement', org)).fillsHole).toBe(false);
    });
  });

  describe('where the club has somebody, so he has to be better than that man', () => {
    const org = IDS.mlbTeam;

    it('is given to a man who is', async () => {
      // His third baseman is worth 870; this one is worth 885
      expect((await row('Vet Regular', org)).fillsHole).toBe(true);
    });

    it('is withheld from a man who clears the floor and is still not an upgrade', async () => {
      /*
       * 865 is the 33rd percentile, so the floor alone would have badged him,
       * and the same man does get it at the club with nobody at third. Here it
       * would be telling the manager that a worse third baseman fills his hole.
       */
      const almost = await row('Vet Almost', org);
      expect(almost.overallPct as number).toBeGreaterThanOrEqual(25);
      expect(almost.fillsHole, 'a man worse than the incumbent was badged').toBe(false);
    });

    it('is withheld below the floor', async () => {
      expect((await row('Vet Short', org)).fillsHole).toBe(false);
      expect((await row('Vet Replacement', org)).fillsHole).toBe(false);
    });
  });

  it("is for the club's thin spots only", async () => {
    // A good shortstop is a hole filler for the club that has nobody there,
    // and no more than a good player for the one whose shortstop is its best
    expect((await row('Vet Shortstop', IDS.otherMlbTeam)).fillsHole).toBe(true);
    expect((await row('Vet Shortstop', IDS.mlbTeam)).fillsHole).toBe(false);
    // Neither club is thin in right
    expect((await row('Vet Rightfielder', IDS.otherMlbTeam)).fillsHole).toBe(false);
    expect((await row('Vet Rightfielder', IDS.mlbTeam)).fillsHole).toBe(false);
  });

  it('is decided for the offseason list as well', async () => {
    // Near Boundary is a shortstop on an expiring deal, valued at the 75th
    // percentile, and the other club has nobody at short
    const boundary = (await market(IDS.otherMlbTeam)).upcomingFAs.find((p) => p.name === 'Near Boundary');
    expect(boundary, 'the expiring shortstop was not on the upcoming list').toBeDefined();
    expect(boundary!.fillsHole).toBe(true);
  });
});

describe('what a free agent was last paid', () => {
  it('is his latest season in the salary history, not the empty contract row', async () => {
    // Every free agent read $0: a free agent's contract row has nothing in it
    expect((await row('Vet Regular')).lastSalary).toBe(22_400_000);
  });

  it('is nothing, not $0, for a man with no season on record', async () => {
    // Placeholder row only
    expect((await row('Vet Almost')).lastSalary).toBeNull();
    // No row of any kind
    expect((await row('Vet Short')).lastSalary).toBeNull();
  });

  it('is what he is paid now, for a man still under contract', async () => {
    const boundary = (await market(IDS.otherMlbTeam)).upcomingFAs.find((p) => p.name === 'Near Boundary');
    expect(boundary!.lastSalary).toBe(4_000_000);
  });
});

describe('a league that marks its class by school year', () => {
  /*
   * Its amateurs are rostered on school clubs and OOTP works eligibility out
   * from their class, so the flag is set on nobody. Take the flag off the
   * prospect and the board falls back to the class — and so must this page.
   */
  beforeAll(() => {
    db.prepare(`UPDATE players SET draft_eligible = 0 WHERE player_id = ?`).run(PHENOM);
  });
  afterAll(() => {
    db.prepare(`UPDATE players SET draft_eligible = 1 WHERE player_id = ?`).run(PHENOM);
  });

  it('is read by the board as the class', async () => {
    const onBoard = await board();
    expect(onBoard).toContain(PHENOM);
    expect(onBoard).toContain(SENIOR);
  });

  it('keeps the class off the market too', async () => {
    const names = await listed();
    expect(names, 'a senior in the class was offered as a free agent').not.toContain('School Senior');
    expect(names).not.toContain('Draft Phenom');
  });

  it('still keeps out the men the flag marks, wherever they are', async () => {
    const names = await listed();
    expect(names).not.toContain('Draft Taken');
    expect(names).not.toContain('Draft Elsewhere');
  });

  it('never overlaps the board', async () => {
    const ids = new Set((await market()).currentFAs.map((p) => p.player_id));
    expect((await board()).filter((id) => ids.has(id))).toEqual([]);
  });

  it('counts all four', async () => {
    expect((await market()).amateursLeftOut).toBe(4);
  });

  it('leaves the real free agents alone', async () => {
    expect(await listed()).toContain('Vet Regular');
  });
});
