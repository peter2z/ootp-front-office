import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS, SEASON } from './fixture.js';

/**
 * Player Search is a window on the league, and the window is a hundred rows.
 *
 * A review of the app against a real save found the league-wide player search
 * taking more than five seconds to appear. The rows were never the weight: the
 * page had been asking for a hundred at a time, with Previous and Next, for a
 * long while. What was heavy was finding them. Every request summed the whole
 * season's stat lines for every player in the league, seven hundred thousand
 * career rows, to put a hundred men in order — and did it twice, once to count
 * the match and once to list it — and then read the same table end to end
 * again to learn which season it was.
 *
 * Making it fast must not make it wrong, and the ways to get it wrong are all
 * about pages. A count worked out differently from the rows beneath it reads as
 * a paging bug. A sort that is only applied to the page in hand puts the
 * league's leader on page three. A sort with ties and no tie-break lets a man
 * show up on two pages and another on none. A page size nobody capped is the
 * whole league on request, and SQLite treats a negative LIMIT as exactly that.
 * So these pin the contract the page now leans on: a page, the size of what is
 * behind it, an order that holds from one page to the next, and a request that
 * cannot ask for more than a page.
 *
 * The league below has forty-five extra batters and twelve arms on the major-
 * league club, built so that every boundary between pages falls through a tie:
 * ages repeat in runs of five, four men share one name, and the batting lines
 * are drawn from six values, so most of them tie on OPS as well.
 */

const FIRST = 7000;
const BATTERS = 45;
const FIRST_ARM = 7200;
const ARMS = 12;

beforeAll(() => {
  const player = db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, ?, ?, ?, ?, 0, 1, 1, ?, ?, ?, 0, 0, 0, 0)`
  );
  const bat = db.prepare(
    `INSERT INTO players_career_batting_stats
       (player_id, year, team_id, league_id, level_id, split_id, pa, ab, h, d, t, hr,
        bb, ibb, hp, sf, k, sb, cs, r, rbi, war)
     VALUES (?, ?, ?, ?, 1, 1, ?, 500, ?, 20, 2, ?, 40, 0, 2, 3, 90, 5, 2, 60, 70, 2.0)`
  );
  for (let i = 0; i < BATTERS; i++) {
    // Four of them are Page Twin, so a sort on the name has ties to break
    const twin = i >= 10 && i <= 13;
    const last = twin ? 'Twin' : `Row${String(i).padStart(2, '0')}`;
    player.run(FIRST + i, 'Page', last, 20 + Math.floor(i / 5), 2 + (i % 8), 70 + i, IDS.mlbTeam, IDS.mlbTeam);
    // Plate appearances all differ, so the default order has no ties; hits and
    // homers come from short cycles, so the stat sorts have nothing but
    bat.run(FIRST + i, SEASON, IDS.mlbTeam, IDS.league, 650 - i * 9, 120 + (i % 6) * 5, (i % 4) * 3);
  }

  const arm = db.prepare(
    `INSERT INTO players_career_pitching_stats
       (player_id, year, team_id, league_id, level_id, split_id, outs, er, ra, ha, bb, k,
        hra, hp, bf, g, gs, w, l, s, hld, war)
     VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, 90, 30, 100, 10, 3, 400, 30, 20, 8, 6, 0, 0, 2.0)`
  );
  for (let i = 0; i < ARMS; i++) {
    player.run(FIRST_ARM + i, 'Page', `Arm${String(i).padStart(2, '0')}`, 24 + (i % 4), 1, 90 + i, IDS.mlbTeam, IDS.mlbTeam);
    // Outs 600, 576, 552 ... so the arms have a clear order of their own
    arm.run(FIRST_ARM + i, SEASON, IDS.mlbTeam, IDS.league, 600 - i * 24, 40 + i, 42 + i);
  }
});

interface Row {
  player_id: number;
  name: string;
  age: number;
  stats: Record<string, number | null> | null;
}
interface Page {
  total: number;
  offset: number;
  limit: number;
  sort?: string | null;
  dir?: string;
  players: Row[];
}

const ask = (query: string, group = 'batting'): Promise<Page> =>
  request(`/api/players?group=${group}&level=1&${query}`);

/** Every page of a search, a few men at a time, laid end to end. */
async function everyPage(query: string, size: number, group = 'batting'): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; offset < 1000; offset += size) {
    const page = await ask(`${query}&limit=${size}&offset=${offset}`, group);
    rows.push(...page.players);
    if (page.players.length < size) return rows;
  }
  throw new Error('the pages never ran out');
}

const ids = (rows: Row[]): number[] => rows.map((r) => r.player_id);
const surname = (r: Row): string => r.name.split(' ').slice(-1)[0];

describe('a page of the league', () => {
  it('is the size asked for, from where it was asked, and says how many there are in all', async () => {
    const one = await ask('limit=10&offset=0');
    expect(one.players).toHaveLength(10);
    expect(one.limit).toBe(10);
    expect(one.offset).toBe(0);
    expect(one.total).toBeGreaterThanOrEqual(BATTERS);

    const two = await ask('limit=10&offset=10');
    expect(two.players).toHaveLength(10);
    expect(two.offset).toBe(10);
    // The figure above the table is the league's, not the page's: it must not
    // shrink as the reader goes further in
    expect(two.total).toBe(one.total);
    expect(ids(two.players).some((id) => ids(one.players).includes(id))).toBe(false);
  });

  it('is a hundred rows when nobody says', async () => {
    const page = await ask('');
    expect(page.limit).toBe(100);
    expect(page.players.length).toBeLessThanOrEqual(100);
  });

  it('lays end to end with nobody twice and nobody missing', async () => {
    const whole = await ask('limit=300');
    expect(whole.players.length).toBe(whole.total);
    const pieces = await everyPage('', 7);
    expect(pieces).toHaveLength(whole.total);
    expect(new Set(ids(pieces)).size, 'a man appeared on two pages').toBe(whole.total);
    expect(ids(pieces)).toEqual(ids(whole.players));
  });

  it('is empty past the end and still knows the total', async () => {
    const whole = await ask('limit=1');
    const past = await ask(`limit=10&offset=${whole.total + 50}`);
    expect(past.players).toEqual([]);
    expect(past.total).toBe(whole.total);
  });

  it('counts the same men the pages hold when a playing-time floor narrows the list', async () => {
    /*
     * The total and the rows are separate queries and the floor lives in both.
     * Applied to one and not the other it reads as a paging bug, and is harder
     * to spot than a wrong list.
     */
    const all = (await ask('limit=1')).total;
    const floor = await ask('minPt=400&limit=5');
    expect(floor.total).toBeGreaterThan(0);
    expect(floor.total).toBeLessThan(all);
    const pieces = await everyPage('minPt=400', 6);
    expect(pieces).toHaveLength(floor.total);
    for (const r of pieces) expect(r.stats?.pa ?? 0).toBeGreaterThanOrEqual(400);
  });

  it('puts the regulars first when nothing is said', async () => {
    // Most plate appearances first, which is what makes the first page worth opening
    const rows = (await ask('limit=40')).players;
    const pa = rows.map((r) => r.stats?.pa ?? 0);
    expect(pa).toEqual([...pa].sort((a, b) => b - a));
    expect(rows[0].player_id).toBe(FIRST);
  });
});

describe('a sort that holds from one page to the next', () => {
  type Case = [label: string, query: string, key: (r: Row) => number | string, dir: 'asc' | 'desc'];
  const cases: Case[] = [
    ['age, youngest first', 'sort=age&dir=asc', (r) => r.age, 'asc'],
    ['age, oldest first', 'sort=age&dir=desc', (r) => r.age, 'desc'],
    ['name, A to Z', 'sort=name&dir=asc', surname, 'asc'],
    ['name, Z to A', 'sort=name&dir=desc', surname, 'desc'],
    ['OPS, best first', 'sort=ops&dir=desc', (r) => r.stats?.ops ?? -1, 'desc'],
    ['OPS, worst first', 'sort=ops&dir=asc', (r) => r.stats?.ops ?? 99, 'asc'],
    ['home runs, most first', 'sort=hr&dir=desc', (r) => r.stats?.hr ?? -1, 'desc'],
  ];

  it.each(cases)('%s: the first man on page two is below the last man on page one', async (_l, query, key, dir) => {
    /*
     * Sorting what arrived would order the page and not the league, so the
     * order has to be fixed before the cut — and what shows it is the seam,
     * where the next page has to carry on from the last one rather than start
     * over. Ties are allowed at the seam; running the wrong way is not.
     */
    const one = await ask(`${query}&limit=10&offset=0`);
    const two = await ask(`${query}&limit=10&offset=10`);
    const last = key(one.players[one.players.length - 1]);
    const next = key(two.players[0]);
    expect(dir === 'asc' ? last <= next : last >= next, `${last} then ${next}`).toBe(true);
  });

  it.each(cases)('%s: the pages laid end to end are the whole league in that order', async (_l, query, key, dir) => {
    const whole = await ask(`${query}&limit=300`);
    const pieces = await everyPage(query, 8);
    expect(ids(pieces), 'cutting it into pages changed the order').toEqual(ids(whole.players));
    const keys = pieces.map(key);
    const sorted = [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(keys).toEqual(dir === 'asc' ? sorted : sorted.reverse());
  });

  it('breaks a tie the same way wherever the page happens to be cut', async () => {
    /*
     * Ages run in fives, so any page size lands inside a tie somewhere. With
     * nothing to break it, two men on the same age are free to swap between
     * one request and the next — one of them twice, the other not at all.
     */
    const sizes = [3, 4, 7, 11];
    const lists = await Promise.all(sizes.map((n) => everyPage('sort=age&dir=asc', n)));
    for (const rows of lists) expect(ids(rows)).toEqual(ids(lists[0]));
  });

  it('carries on across the pages with a stat sort, from the offset it is given', async () => {
    // Stat sorts widen the query to every match and cut afterwards, so the cut is its own code
    const ten = await ask('sort=ops&dir=desc&limit=10');
    const second = await ask('sort=ops&dir=desc&limit=5&offset=5');
    expect(ids(second.players)).toEqual(ids(ten.players.slice(5)));
  });

  it('orders by playing time, which is the column the default order is made of', async () => {
    // Asked for by name this used to be a syntax error, and nothing on the page asks for it
    const rows = (await ask('sort=pt&dir=desc&limit=300')).players;
    const pa = rows.map((r) => r.stats?.pa ?? 0);
    expect(pa).toEqual([...pa].sort((a, b) => b - a));
    const least = (await ask('sort=pt&dir=asc&limit=300')).players.map((r) => r.stats?.pa ?? 0);
    expect(least).toEqual([...least].sort((a, b) => a - b));
  });

  it('is not disturbed by a name that is not a column', async () => {
    // "constructor" is a property of every object and was read as though it were a sort
    for (const sort of ['constructor', '__proto__', 'toString']) {
      const page = await ask(`sort=${sort}&limit=5`);
      expect(page.players.length, sort).toBeGreaterThan(0);
    }
  });
});

describe('a request cannot take the league', () => {
  it('is held to a page, however large a page is asked for', async () => {
    const page = await ask('limit=100000');
    expect(page.limit).toBe(300);
    expect(page.players.length).toBeLessThanOrEqual(300);
  });

  it('reads a negative size as nothing, because SQLite reads it as everything', async () => {
    const page = await ask('limit=-1');
    expect(page.players).toEqual([]);
    expect(page.total).toBeGreaterThan(0);
  });

  it('starts from the top when the place is negative', async () => {
    const top = await ask('limit=5&offset=0');
    const odd = await ask('limit=5&offset=-5');
    expect(odd.offset).toBe(0);
    expect(ids(odd.players)).toEqual(ids(top.players));
  });

  it('takes a size that is not a number as no size at all', async () => {
    const page = await ask('limit=lots&offset=soon');
    expect(page.limit).toBe(100);
    expect(page.offset).toBe(0);
  });
});

describe('pitchers are paged the same way', () => {
  it('come most innings first, and lay end to end', async () => {
    const whole = await ask('limit=300', 'pitching');
    expect(whole.total).toBeGreaterThanOrEqual(ARMS);
    const outs = whole.players.map((r) => (r.stats?.ip ?? 0) * 3);
    expect(outs.slice(0, ARMS)).toEqual([...outs.slice(0, ARMS)].sort((a, b) => b - a));
    expect(whole.players[0].player_id).toBe(FIRST_ARM);
    const pieces = await everyPage('', 5, 'pitching');
    expect(ids(pieces)).toEqual(ids(whole.players));
  });

  it('are narrowed by outs, and counted the way they are listed', async () => {
    // 450 outs or more is the first seven arms: 600, 576, 552, 528, 504, 480, 456
    const page = await ask('minPt=450&limit=3', 'pitching');
    expect(page.total).toBe(7);
    expect(page.players).toHaveLength(3);
    expect(await everyPage('minPt=450', 3, 'pitching')).toHaveLength(7);
  });
});

describe('the season it reads is the newest one in the league', () => {
  const NEW_SEASON = SEASON + 1;

  afterAll(() => {
    db.prepare(`DELETE FROM players_career_batting_stats WHERE year = ?`).run(NEW_SEASON);
  });

  it('is found again when the league moves on, without a restart', async () => {
    /*
     * Which season to read is worked out once and remembered, because finding
     * it means reading every career row there is. It is remembered for as long
     * as the database is untouched and no longer, and this is the "no longer":
     * a new year's first line has to be noticed by the very next request.
     */
    const before = (await ask('limit=300')).players.find((r) => r.player_id === FIRST);
    expect(before?.stats?.pa).toBe(650);

    db.prepare(
      `INSERT INTO players_career_batting_stats
         (player_id, year, team_id, league_id, level_id, split_id, pa, ab, h, d, t, hr,
          bb, ibb, hp, sf, k, sb, cs, r, rbi, war)
       VALUES (?, ?, ?, ?, 1, 1, 111, 100, 30, 5, 0, 4, 8, 0, 1, 1, 20, 1, 0, 12, 14, 0.5)`
    ).run(FIRST, NEW_SEASON, IDS.mlbTeam, IDS.league);

    const after = (await ask('limit=300')).players;
    expect(after.find((r) => r.player_id === FIRST)?.stats?.pa).toBe(111);
    // Nobody else has played yet this year, so nobody else has a line to show
    expect(after.filter((r) => r.stats !== null).map((r) => r.player_id)).toEqual([FIRST]);

    db.prepare(`DELETE FROM players_career_batting_stats WHERE year = ?`).run(NEW_SEASON);
    const back = (await ask('limit=300')).players.find((r) => r.player_id === FIRST);
    expect(back?.stats?.pa).toBe(650);
  });
});

/**
 * Read from the source rather than rendered, as the other pages' structural
 * tests are: there is no React renderer in this suite, and what matters here
 * is what the page asks the server for and what it keeps.
 */
describe('the page', () => {
  const page = fs.readFileSync(path.join(process.cwd(), 'src/pages/Players.tsx'), 'utf8');

  it('asks for a hundred at a time, from where the rows it has end', () => {
    expect(page).toMatch(/const PAGE = 100;/);
    expect(page).toMatch(/limit=\$\{PAGE\}&offset=0/);
    expect(page).toMatch(/limit=\$\{PAGE\}&offset=\$\{rows\.length\}/);
  });

  it('offers more rather than a different page, and adds to what it holds', () => {
    expect(page).toMatch(/Show \$\{/);
    expect(page).toMatch(/\[\.\.\.held, /);
  });

  it('says how many there are from the server, not from what it has', () => {
    expect(page).toMatch(/setTotal\(r\.total\)/);
    expect(page).toMatch(/total\.toLocaleString\(\)/);
  });

  it('leaves the ordering to the server, so it covers the league and not the page', () => {
    expect(page).toMatch(/params\.set\('sort', sort\.key\)/);
    expect(page, 'the browser is sorting what arrived').not.toMatch(/\.sort\(/);
  });

  it('starts again from the top when the search changes, and ignores a late answer to an old one', () => {
    expect(page).toMatch(/generation\.current !== mine/);
    expect(page).toMatch(/setRows\(\[\]\)/);
  });
});
