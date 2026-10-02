import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../server/db.js';
import { MIN_DRAFT_AGE } from '../server/rosterops.js';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * The draft board is the top of the class, and the class is a page at a time.
 *
 * The board used to send every man in the draft pool with his scouting read
 * attached. In the save this was reviewed against that is two thousand seven
 * hundred and forty-four of them and an answer of 860 KB, drawn from in the
 * browser a hundred rows at a time — the page showed a hundred men and held the
 * other two thousand six hundred in memory, and took more than five seconds to
 * appear. Now the board is the best hundred, with counts that describe the whole
 * class, and the class itself is a page of the pool asked for with `?pool=1`.
 *
 * Splitting it must change nothing a reader could notice. The board is the same
 * hundred men in the same order as before. The pool laid end to end is the same
 * class. A count above the table still counts everybody, not the hundred who
 * happen to be on the board. The second shortlist — the best at the spots the
 * club is thinnest — is still read from the whole class, because a catcher is
 * not obliged to rank in the top hundred. And the things the page used to do to
 * the class in the browser, searching and filtering and sorting, are done where
 * the class is: sorting a page would order the page and not the draft.
 *
 * The class below is a hundred and ten pitchers who outrank everybody, and forty
 * hitters, five at each position the club can be thin at, who do not. That
 * arrangement is deliberate: however the fixture's roster happens to fall, every
 * spot the club is thin at is a hitter's spot, and every hitter is past the end
 * of the board, so the shortlist can only be right if it looked beyond it.
 */

const FIRST_ARM = 8000;
const ARMS = 110;
const FIRST_BAT = 8200;
/** Catcher, first, second, third, short, left, centre, right: the spots a club can be thin at. */
const HOLE_SPOTS = [2, 3, 4, 5, 6, 7, 8, 9];
const PER_SPOT = 5;
const BATS = HOLE_SPOTS.length * PER_SPOT;
const CLASS = ARMS + BATS;

interface Expected {
  id: number;
  name: string;
  age: number;
  position: string;
  school: 'HS' | 'College';
  pot: number;
}
/** What was put in the league, kept beside it so that no figure below is worked out from the answer. */
const made: Expected[] = [];

const SPOT_NAMES: Record<number, string> = { 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF' };

beforeAll(() => {
  db.prepare(`UPDATE leagues SET show_draft_pool = 1 WHERE league_id = ?`).run(IDS.league);

  const add = db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college, picked_in_draft, draft_league_id)
     VALUES (?, ?, ?, ?, ?, 0, 1, 1, 0, 0, 0, 0, 0, 1, ?, 0, ?)`
  );
  const batting = db.prepare(
    `INSERT INTO players_batting VALUES (?, ?, ?, ?, ?, ?, 45, ?, ?, ?, ?, ?)`
  );
  const pitching = db.prepare(`INSERT INTO players_pitching VALUES (?, ?, ?, ?, ?, ?, ?, 50, 90)`);

  for (let i = 0; i < ARMS; i++) {
    const id = FIRST_ARM + i;
    // Seven men in a row have no Zedd in them, then one does: a search has something to find
    const last = i % 8 === 0 ? `Zedd${i}` : `Arm${i}`;
    // Ceilings fall from 80 to 60 and repeat, five or six men to a value, so the board has ties to break
    const pot = 80 - (i % 21);
    const cur = 40 + (i % 4) * 3;
    const age = 14 + (i % 9);
    const college = i % 3 === 0 ? 1 : 0;
    add.run(id, 'Pitch', last, age, 1, college, IDS.league);
    pitching.run(id, cur, cur, cur, pot, pot, pot);
    made.push({ id, name: `Pitch ${last}`, age, position: 'P', school: college ? 'College' : 'HS', pot });
  }
  for (let i = 0; i < BATS; i++) {
    const id = FIRST_BAT + i;
    const spot = HOLE_SPOTS[i % HOLE_SPOTS.length];
    const last = i % 8 === 1 ? `Zedd${i}` : `Bat${i}`;
    // Fifty at the very best: below the weakest arm, so no hitter is within a hundred of the board
    const pot = 50 - Math.floor(i / HOLE_SPOTS.length);
    const cur = 38 + (i % 3);
    const age = 14 + (i % 9);
    const college = i % 2 === 0 ? 1 : 0;
    add.run(id, 'Bat', last, age, spot, college, IDS.league);
    batting.run(id, cur, cur, cur, cur, cur, pot, pot, pot, pot, pot);
    made.push({ id, name: `Bat ${last}`, age, position: SPOT_NAMES[spot], school: college ? 'College' : 'HS', pot });
  }
});

interface Prospect {
  player_id: number;
  name: string;
  age: number;
  positionName: string;
  school: string;
  pot: number | null;
  cur: number | null;
  upside: number | null;
  boardRank: number;
  yearsToEligibility: number;
  recommendation: { label: string; reasons: string[] } | null;
}
interface Board {
  poolVisible: boolean;
  total: number;
  boardSize: number;
  minDraftAge: number;
  tooYoung: number;
  poolRule: string;
  needs: Array<{ positionName: string }>;
  excluded: { alreadyPicked: number; otherDraft: number; unrated: number };
  pool: { school: { HS: number; College: number }; positions: Record<string, number> };
  fits: Prospect[];
  prospects: Prospect[];
}
interface PoolPage {
  total: number;
  matched: number;
  offset: number;
  limit: number;
  sort?: string;
  dir?: string;
  prospects: Prospect[];
}

const board = (): Promise<Board> => request(`/api/draft/${IDS.mlbTeam}`);
const pool = (query = ''): Promise<PoolPage> => request(`/api/draft/${IDS.mlbTeam}?pool=1${query ? `&${query}` : ''}`);

/** Every page of a query, laid end to end. */
async function everyPage(query: string, size: number): Promise<Prospect[]> {
  const rows: Prospect[] = [];
  for (let offset = 0; offset < 2000; offset += size) {
    const page = await pool(`${query}${query ? '&' : ''}limit=${size}&offset=${offset}`);
    rows.push(...page.prospects);
    if (page.prospects.length < size) return rows;
  }
  throw new Error('the pages never ran out');
}
const ids = (rows: Prospect[]): number[] => rows.map((p) => p.player_id);

describe('the board', () => {
  it('is the best hundred of the class, ranked one to a hundred', async () => {
    const d = await board();
    expect(d.prospects).toHaveLength(100);
    expect(d.boardSize).toBe(100);
    expect(d.prospects.map((p) => p.boardRank)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    const ceilings = d.prospects.map((p) => p.pot ?? 0);
    expect(ceilings, 'the board is no longer in ceiling order').toEqual([...ceilings].sort((a, b) => b - a));
    // Only arms are good enough, by construction: the hundred are a hundred of the hundred and ten
    for (const p of d.prospects) expect(p.positionName).toBe('P');
  });

  it('still says how many are in the class, and not how many it carries', async () => {
    const d = await board();
    expect(d.total).toBe(CLASS);
    expect(d.total).toBeGreaterThan(d.prospects.length);
  });

  it('keeps every field it always had, on the board and on each man', async () => {
    const d = await board();
    expect(d.minDraftAge).toBe(MIN_DRAFT_AGE);
    expect(d.poolRule).toBe('flag');
    expect(Array.isArray(d.needs)).toBe(true);
    expect(d.excluded).toEqual({ alreadyPicked: 0, otherDraft: 0, unrated: 0 });
    for (const p of d.prospects) {
      for (const key of ['player_id', 'name', 'age', 'positionName', 'bats', 'throws', 'school', 'isPitcher',
        'cur', 'pot', 'upside', 'speed', 'boardRank', 'yearsToEligibility', 'recommendation']) {
        expect(p, `${p.name} has no ${key}`).toHaveProperty(key);
      }
    }
  });

  it('counts the young men of the whole class, not of the hundred', async () => {
    /*
     * The figure above the table says how many are under the draft age. Worked
     * out from the board's own rows it would be a count of arms, and the
     * hitters — who are all past the end of it — would not be in it.
     */
    const d = await board();
    const young = made.filter((m) => m.age < MIN_DRAFT_AGE).length;
    expect(d.tooYoung).toBe(young);
    expect(d.tooYoung).toBeGreaterThan(d.prospects.filter((p) => p.yearsToEligibility > 0).length);
  });

  it('describes the whole class before any of it is fetched', async () => {
    const d = await board();
    expect(d.pool.school.HS + d.pool.school.College).toBe(CLASS);
    expect(d.pool.school.College).toBe(made.filter((m) => m.school === 'College').length);
    expect(d.pool.positions.P).toBe(ARMS);
    expect(d.pool.positions.C).toBe(PER_SPOT);
    expect(d.pool.positions.IF).toBe(PER_SPOT * 4);
    expect(d.pool.positions.OF).toBe(PER_SPOT * 3);
    expect(d.pool.positions.C + d.pool.positions.IF + d.pool.positions.OF + d.pool.positions.P).toBe(CLASS);
  });

  it('is not changed by anybody paging through the pool', async () => {
    const before = await board();
    await everyPage('', 40);
    await pool('sort=age&dir=asc&limit=30');
    await pool('q=zedd&school=College');
    expect(await board()).toEqual(before);
  });

  it('is small, which is the point of it', async () => {
    // A hundred men and a shortlist, where the whole class was two and a half thousand
    const body = JSON.stringify(await board());
    expect(body.length).toBeLessThan(80_000);
  });
});

describe('the shortlist', () => {
  it('reads the spots the club is thin at from the whole class, not from the board', async () => {
    const d = await board();
    const thin = new Set(d.needs.slice(0, 3).map((h) => h.positionName));
    expect(thin.size).toBe(3);

    const everyone = await everyPage('', 60);
    const best = new Set(ids(everyone.slice(0, 5)));
    const expected = everyone.filter((p) => thin.has(p.positionName) && !best.has(p.player_id)).slice(0, 3);

    expect(ids(d.fits)).toEqual(ids(expected));
    expect(d.fits).toHaveLength(3);
    for (const p of d.fits) {
      expect(thin.has(p.positionName), `${p.name} plays ${p.positionName}`).toBe(true);
      // Every hitter ranks beyond the hundredth man, so a board that only looked down to a hundred has none
      expect(p.boardRank).toBeGreaterThan(100);
    }
  });

  it('is never one of the five best available', async () => {
    const d = await board();
    const top = new Set(d.prospects.slice(0, 5).map((p) => p.player_id));
    for (const p of d.fits) expect(top.has(p.player_id)).toBe(false);
  });
});

describe('the pool', () => {
  it('begins where the board does, and is the board in the same order', async () => {
    const d = await board();
    const first = await pool('limit=100');
    expect(ids(first.prospects)).toEqual(ids(d.prospects));
    expect(first.prospects).toEqual(d.prospects);
  });

  it('is the whole class when its pages are laid end to end, with nobody twice and nobody missing', async () => {
    const d = await board();
    const everyone = await everyPage('', 37);
    expect(everyone).toHaveLength(d.total);
    expect(new Set(ids(everyone)).size, 'a man was on two pages').toBe(CLASS);
    expect(ids(everyone).slice(0, 100)).toEqual(ids(d.prospects));
    // The ranks run one to the last, so the places a re-sorted table reports are the board's
    expect(everyone.map((p) => p.boardRank)).toEqual(Array.from({ length: CLASS }, (_, i) => i + 1));
    expect(ids(everyone).sort((a, b) => a - b)).toEqual(made.map((m) => m.id).sort((a, b) => a - b));
  });

  it('is cut the same way whatever the size of the page', async () => {
    // Ceilings repeat, so any page size lands inside a tie somewhere
    const lists = await Promise.all([13, 50, 101, 300].map((n) => everyPage('', n)));
    for (const rows of lists) expect(ids(rows)).toEqual(ids(lists[0]));
  });

  it('says how many there are and how many matched, on every page', async () => {
    const one = await pool('limit=20&offset=0');
    const two = await pool('limit=20&offset=20');
    expect(one.total).toBe(CLASS);
    expect(one.matched).toBe(CLASS);
    expect(two.total).toBe(CLASS);
    expect(one.limit).toBe(20);
    expect(two.offset).toBe(20);
    expect(ids(two.prospects).some((id) => ids(one.prospects).includes(id))).toBe(false);
  });

  it('carries the same read on a man as the board does', async () => {
    const d = await board();
    const deep = await pool('limit=5&offset=100');
    expect(deep.prospects).toHaveLength(5);
    for (const p of deep.prospects) {
      expect(p).toHaveProperty('recommendation');
      expect(p).toHaveProperty('yearsToEligibility');
    }
    // A ceiling of 50 or better earns a read at all: the one a board arm has is the same kind of thing
    expect(d.prospects[0].recommendation).not.toBeNull();
  });
});

describe('searching the pool', () => {
  it('narrows it to the names that match, whatever the case', async () => {
    const expected = made.filter((m) => /zedd/i.test(m.name));
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(CLASS);

    for (const needle of ['zedd', 'ZEDD', 'Zedd']) {
      const found = await pool(`q=${needle}&limit=300`);
      expect(found.matched, needle).toBe(expected.length);
      expect(found.total).toBe(CLASS);
      for (const p of found.prospects) expect(p.name.toLowerCase()).toContain('zedd');
    }
  });

  it('keeps the places of the men it finds, so a name can still say where he stood', async () => {
    const found = await pool('q=zedd&limit=300');
    const everyone = await everyPage('', 300);
    const rank = new Map(everyone.map((p) => [p.player_id, p.boardRank]));
    for (const p of found.prospects) expect(p.boardRank).toBe(rank.get(p.player_id));
    // Still best ceiling first
    expect(found.prospects.map((p) => p.boardRank)).toEqual([...found.prospects.map((p) => p.boardRank)].sort((a, b) => a - b));
  });

  it('is laid out in pages like everything else, and they add up to what it matched', async () => {
    const found = await pool('q=zedd&limit=1');
    const pieces = await everyPage('q=zedd', 4);
    expect(pieces).toHaveLength(found.matched);
    expect(new Set(ids(pieces)).size).toBe(found.matched);
  });

  it('finds nobody when nobody matches, and says so', async () => {
    const none = await pool('q=nobodyiscalledthis');
    expect(none.matched).toBe(0);
    expect(none.prospects).toEqual([]);
    expect(none.total).toBe(CLASS);
  });

  it('takes the narrowing the filters used to do in the browser', async () => {
    const wants = (test: (m: Expected) => boolean) => made.filter(test).length;

    const pitchers = await pool('group=P&limit=300');
    expect(pitchers.matched).toBe(ARMS);
    for (const p of pitchers.prospects) expect(p.positionName).toBe('P');

    const infield = await pool('group=IF&limit=300');
    expect(infield.matched).toBe(PER_SPOT * 4);
    for (const p of infield.prospects) expect(['1B', '2B', '3B', 'SS']).toContain(p.positionName);

    const college = await pool('school=College&limit=300');
    expect(college.matched).toBe(wants((m) => m.school === 'College'));
    for (const p of college.prospects) expect(p.school).toBe('College');

    const young = await pool('maxAge=16&limit=300');
    expect(young.matched).toBe(wants((m) => m.age <= 16));
    for (const p of young.prospects) expect(p.age).toBeLessThanOrEqual(16);

    const ceiling = await pool('minPot=70&limit=300');
    expect(ceiling.matched).toBe(wants((m) => m.pot >= 70));
    for (const p of ceiling.prospects) expect(p.pot ?? 0).toBeGreaterThanOrEqual(70);
  });

  it('puts the filters together rather than letting the last one win', async () => {
    const both = await pool('group=P&school=HS&maxAge=18&minPot=65&q=pitch&limit=300');
    const expected = made.filter(
      (m) => m.position === 'P' && m.school === 'HS' && m.age <= 18 && m.pot >= 65 && /pitch/i.test(m.name)
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(both.matched).toBe(expected.length);
    expect(ids(both.prospects).sort((a, b) => a - b)).toEqual(expected.map((m) => m.id).sort((a, b) => a - b));
  });

  it('ignores a filter it cannot make sense of rather than matching nothing', async () => {
    const bare = await pool('limit=1');
    const odd = await pool('group=everything&school=Mars&maxAge=old&minPot=lots&limit=1');
    expect(odd.matched).toBe(bare.matched);
  });
});

describe('sorting the pool', () => {
  type Case = [label: string, query: string, key: (p: Prospect) => number | string, dir: 'asc' | 'desc'];
  const cases: Case[] = [
    ['age, youngest first', 'sort=age&dir=asc', (p) => p.age, 'asc'],
    ['age, oldest first', 'sort=age&dir=desc', (p) => p.age, 'desc'],
    ['name, A to Z', 'sort=name&dir=asc', (p) => p.name, 'asc'],
    ['ceiling, lowest first', 'sort=pot&dir=asc', (p) => p.pot ?? 0, 'asc'],
    ['upside, most first', 'sort=upside&dir=desc', (p) => p.upside ?? 0, 'desc'],
    ['current ability, best first', 'sort=cur&dir=desc', (p) => p.cur ?? 0, 'desc'],
    ['board rank, last first', 'sort=boardRank&dir=desc', (p) => p.boardRank, 'desc'],
  ];

  it.each(cases)('%s: page two carries on from page one', async (_l, query, key, dir) => {
    /*
     * The order has to be fixed over the whole pool before it is cut. Sorting
     * what had been fetched would put the best arm in the draft on a page
     * nobody had asked for.
     */
    const one = await pool(`${query}&limit=50&offset=0`);
    const two = await pool(`${query}&limit=50&offset=50`);
    const last = key(one.prospects[one.prospects.length - 1]);
    const next = key(two.prospects[0]);
    expect(dir === 'asc' ? last <= next : last >= next, `${last} then ${next}`).toBe(true);
  });

  it.each(cases)('%s: the pages laid end to end are the whole pool in that order', async (_l, query, key, dir) => {
    const pieces = await everyPage(query, 29);
    expect(pieces).toHaveLength(CLASS);
    expect(new Set(ids(pieces)).size).toBe(CLASS);
    const keys = pieces.map(key);
    // The server compares names the way a person would, so this has to as well
    const compare = (a: number | string, b: number | string): number =>
      typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b) : a < b ? -1 : a > b ? 1 : 0;
    const sorted = [...keys].sort(compare);
    expect(keys).toEqual(dir === 'asc' ? sorted : sorted.reverse());
  });

  it('leaves men who tie where the board had them', async () => {
    // Ages repeat all over the class: among men of one age the board's own order stands
    const rows = await everyPage('sort=age&dir=asc', 300);
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].age === rows[i - 1].age) expect(rows[i].boardRank).toBeGreaterThan(rows[i - 1].boardRank);
    }
  });

  it('takes the direction a reader would want first, when not told', async () => {
    // Ratings read best high-first; a name or an age reads best low-first
    const byName = (await pool('sort=name&limit=300')).prospects.map((p) => p.name);
    expect(byName).toEqual([...byName].sort((a, b) => a.localeCompare(b)));
    const byCeiling = (await pool('sort=pot&limit=300')).prospects.map((p) => p.pot ?? 0);
    expect(byCeiling).toEqual([...byCeiling].sort((a, b) => b - a));
  });

  it('is not disturbed by a column that does not exist', async () => {
    const plain = await pool('limit=20');
    for (const sort of ['nonsense', 'constructor', '__proto__']) {
      const page = await pool(`sort=${sort}&limit=20`);
      expect(ids(page.prospects), sort).toEqual(ids(plain.prospects));
    }
  });
});

describe('a request cannot take the class', () => {
  it('is held to a page however large a page is asked for', async () => {
    const page = await pool('limit=100000');
    expect(page.limit).toBe(300);
    expect(page.prospects.length).toBeLessThanOrEqual(300);
  });

  it('reads a negative size as nothing, and a negative place as the start', async () => {
    const none = await pool('limit=-1');
    expect(none.prospects).toEqual([]);
    expect(none.matched).toBe(CLASS);
    const top = await pool('limit=5&offset=0');
    const odd = await pool('limit=5&offset=-9');
    expect(odd.offset).toBe(0);
    expect(ids(odd.prospects)).toEqual(ids(top.prospects));
  });

  it('is a hundred when the size is not a number', async () => {
    const page = await pool('limit=lots');
    expect(page.limit).toBe(100);
    expect(page.prospects).toHaveLength(100);
  });
});

describe('a class that has not been published', () => {
  afterAll(() => {
    db.prepare(`UPDATE leagues SET show_draft_pool = 1 WHERE league_id = ?`).run(IDS.league);
  });

  it('answers the pool in the same shape as a class that has', async () => {
    /*
     * The board once answered an unpublished class in a shape the page could
     * not read, and one visit between drafts took the whole window down. The
     * pool must not make the same mistake: it has to have a prospects array
     * and a count whether or not there is anything to put in them.
     */
    db.prepare(`UPDATE leagues SET show_draft_pool = 0 WHERE league_id = ?`).run(IDS.league);
    const page = await pool('limit=20');
    expect(page.prospects).toEqual([]);
    expect(page.matched).toBe(0);
    expect(page.total).toBe(0);
    const d = await board();
    expect(d.poolVisible).toBe(false);
    expect(d.prospects).toEqual([]);
    expect(d.fits).toEqual([]);
  });
});

/**
 * Read from the source rather than rendered, for the same reason the board's
 * other page tests are: there is no React renderer in this suite, and what
 * matters is what the page asks for and what it holds.
 */
describe('the page', () => {
  const page = fs.readFileSync(path.join(process.cwd(), 'src/pages/Draft.tsx'), 'utf8');

  it('opens on the board and goes to the pool only when it is asked something the board cannot answer', () => {
    expect(page).toMatch(/apiGet<DraftData>\(`\/api\/draft\/\$\{orgId\}`\)/);
    expect(page).toMatch(/\?pool=1&limit=\$\{PAGE\}&offset=\$\{offset\}/);
    // The plain class is the board, which is already here: no second request for it
    expect(page).toMatch(/if \(search === '' \|\| staticSite\)/);
  });

  it('holds the rows it has been given and nothing beyond them', () => {
    expect(page).toMatch(/\.\.\.now\.rows, \.\.\.r\.prospects|\[\.\.\.now\.rows,/);
    expect(page, 'the browser is searching the class itself').not.toMatch(/name\.toLowerCase\(\)\.includes/);
    expect(page, 'the browser is sorting what arrived').not.toMatch(/\.sort\(/);
  });

  it('reads the second shortlist from the server, which looked at the whole class', () => {
    expect(page).toMatch(/data\?\.fits \?\? \[\]/);
  });

  it('says what the pool holds from the counts it arrived with', () => {
    expect(page).toMatch(/data\.pool\?\.positions\.C/);
    expect(page).toMatch(/data\.pool\?\.school\.HS/);
  });

  it('does not offer a search it has no server to run when it is a saved copy of the site', () => {
    expect(page).toMatch(/isStaticSite\(\)/);
    expect(page).toMatch(/staticSite \? \(/);
  });
});
