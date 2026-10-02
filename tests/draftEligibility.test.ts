import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../server/db.js';
import { MIN_DRAFT_AGE, yearsToEligibility } from '../server/rosterops.js';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * How far each man on the draft board is from being old enough to be taken.
 *
 * In the save this was checked on, OOTP's own eligibility flag put 81
 * fourteen-year-olds and 340 fifteen-year-olds in the pool — high-school
 * freshmen and sophomores with years of school left — and the board ranked
 * them beside the seniors by ceiling. "Who to take" had a fifteen-year-old at
 * number five and a fourteen-year-old at number eleven, and nothing on the page
 * said either could not be taken this summer.
 *
 * The flag is OOTP's and the board keeps it, and so it keeps the ranking: the
 * figure is shown beside the age and nothing is hidden or reordered. What was
 * missing was any way to see that a man is years away, as a number rather than
 * a yes or no, so next year's class reads differently from a four-year wait.
 *
 * The export carries no draft-age setting, so the age is an assumption held in
 * one constant: 17, because the save's own 2026 and 2027 drafts took 39
 * seventeen-year-olds, counting age on draft day, and nobody younger. A first
 * guess of 18 would have told the high-school seniors who are 17 that they had a
 * year to wait.
 */

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

const FOURTEEN = 9800;
const FIFTEEN = 9801;
const SIXTEEN = 9806;
const SEVENTEEN = 9802;
const EIGHTEEN = 9803;
const TWENTY_ONE = 9804;
const NO_AGE = 9805;

beforeAll(() => {
  db.prepare(`UPDATE leagues SET show_draft_pool = 1 WHERE league_id = ?`).run(IDS.league);

  /*
   * Ceilings run the other way from ages: the youngest has the best, so a
   * board that reordered by eligibility would visibly put him last.
   */
  const add = (id: number, last: string, age: number, ceiling: number) => {
    db.prepare(
      `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                            uniform_number, team_id, organization_id, retired, hidden,
                            draft_eligible, college, picked_in_draft, draft_league_id)
       VALUES (?, 'Class', ?, ?, 6, 0, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, ?)`
    ).run(id, last, age, IDS.league);
    db.prepare(
      `INSERT INTO players_batting VALUES (?, 40, 40, 40, 40, 40, 45, ?, ?, ?, ?, ?)`
    ).run(id, ceiling, ceiling, ceiling, ceiling, ceiling);
  };
  add(FOURTEEN, 'Fourteen', 14, 70);
  add(FIFTEEN, 'Fifteen', 15, 65);
  add(SIXTEEN, 'Sixteen', 16, 62);
  add(SEVENTEEN, 'Seventeen', 17, 60);
  add(EIGHTEEN, 'Eighteen', 18, 55);
  add(TWENTY_ONE, 'Twentyone', 21, 50);
  // The export left his age blank
  add(NO_AGE, 'Noage', 0, 45);
});

interface Board {
  minDraftAge: number;
  tooYoung: number;
  total: number;
  prospects: Array<{
    player_id: number; name: string; age: number; pot: number | null; cur: number | null;
    boardRank: number; yearsToEligibility: number;
  }>;
}
const board = async (): Promise<Board> => (await request(`/api/draft/${IDS.mlbTeam}`)) as Board;
const years = async (id: number): Promise<number | undefined> =>
  (await board()).prospects.find((p) => p.player_id === id)?.yearsToEligibility;

describe('years to eligibility', () => {
  it('is returned with every man in the pool', async () => {
    const d = await board();
    expect(d.prospects.length).toBeGreaterThanOrEqual(7);
    for (const p of d.prospects) {
      expect(typeof p.yearsToEligibility, `${p.name} has no figure`).toBe('number');
    }
  });

  it('counts the years from his age to the draft age', async () => {
    expect(await years(FOURTEEN)).toBe(MIN_DRAFT_AGE - 14);
    expect(await years(FIFTEEN)).toBe(MIN_DRAFT_AGE - 15);
    expect(await years(SIXTEEN)).toBe(MIN_DRAFT_AGE - 16);
  });

  it('is nothing once he has reached it, and never negative', async () => {
    expect(await years(SEVENTEEN)).toBe(Math.max(0, MIN_DRAFT_AGE - 17));
    expect(await years(EIGHTEEN)).toBe(0);
    expect(await years(TWENTY_ONE)).toBe(0);
    for (const p of (await board()).prospects) expect(p.yearsToEligibility).toBeGreaterThanOrEqual(0);
  });

  it('does not set a man with no age a whole draft age away', async () => {
    expect(await years(NO_AGE)).toBe(0);
  });

  it('counts to the age it says it counts to', async () => {
    expect((await board()).minDraftAge).toBe(MIN_DRAFT_AGE);
  });

  it('assumes seventeen, the youngest this league has drafted', () => {
    /*
     * An assumption and not a setting, so it is pinned here with its reason.
     * The save's 2026 and 2027 drafts took 39 seventeen-year-olds, counting age
     * on draft day, and nobody younger: so seventeen is old enough, and a
     * sixteen-year-old is a year away. Eighteen was the first guess and it
     * would have put every seventeen-year-old senior a year out.
     */
    expect(MIN_DRAFT_AGE).toBe(17);
  });

  it('says how many of the class are under it', async () => {
    const d = await board();
    expect(d.tooYoung).toBe(d.prospects.filter((p) => p.yearsToEligibility > 0).length);
    const ages = [14, 15, 16, 17, 18, 21];
    expect(d.tooYoung).toBe(ages.filter((age) => age < MIN_DRAFT_AGE).length);
  });
});

describe('the board itself', () => {
  it('is ranked as it was, by ceiling and not by eligibility', async () => {
    const d = await board();
    const order = [FOURTEEN, FIFTEEN, SIXTEEN, SEVENTEEN, EIGHTEEN, TWENTY_ONE];
    const mine = d.prospects.filter((p) => order.includes(p.player_id));
    // The fourteen-year-old has the best ceiling and so still leads them
    expect(mine.map((p) => p.player_id)).toEqual(order);
    const ceilings = d.prospects.map((p) => p.pot ?? 0);
    expect(ceilings, 'the board is no longer in ceiling order')
      .toEqual([...ceilings].sort((a, b) => b - a));
  });

  it('numbers the ranks one to the last, with nobody dropped', async () => {
    const d = await board();
    expect(d.prospects.map((p) => p.boardRank)).toEqual(d.prospects.map((_, i) => i + 1));
    expect(d.total).toBe(d.prospects.length);
  });

  it('still lists the young man, with his figure beside him', async () => {
    const him = (await board()).prospects.find((p) => p.player_id === FOURTEEN);
    expect(him?.boardRank).toBe(1);
    expect(him?.yearsToEligibility).toBe(MIN_DRAFT_AGE - 14);
  });
});

describe('the figure on its own', () => {
  it('is the draft age less his age', () => {
    expect(yearsToEligibility(14, 17)).toBe(3);
    expect(yearsToEligibility(16, 17)).toBe(1);
  });

  it('takes the draft age from the one constant unless it is given another', () => {
    expect(yearsToEligibility(14)).toBe(MIN_DRAFT_AGE - 14);
  });

  it('floors at nothing', () => {
    expect(yearsToEligibility(17, 17)).toBe(0);
    expect(yearsToEligibility(26)).toBe(0);
  });

  it('takes a blank age as eligible', () => {
    expect(yearsToEligibility(0)).toBe(0);
  });

  it('counts to another age when it is given one', () => {
    expect(yearsToEligibility(15, 18)).toBe(3);
  });
});

/**
 * Read from the source rather than rendered, as the rest of the board's page
 * tests are: there is no React renderer in this suite.
 */
describe('the draft page', () => {
  const page = read('src/pages/Draft.tsx');

  it('shows the figure beside the age', () => {
    expect(page).toMatch(/Age\{arrow\('age'\)\}<\/th>\s*<Th/);
    expect(page).toMatch(/<Th\b[\s\S]*?>\s*Eligible in\s*<\/Th>/);
    expect(page).toMatch(/waits\(p\)/);
  });

  it('marks a man who cannot be taken yet on the shortlist as well', () => {
    const marks = page.match(/<NotYet p=\{p\} \/>/g)?.length;
    expect(marks, 'the flag is missing from one of the shortlists').toBe(2);
  });

  it('keeps the table as wide as its header, so the empty row spans it', () => {
    const heads = page.slice(page.indexOf('<thead>'), page.indexOf('</thead>'));
    const columns = (heads.match(/<th[\s>]|<Th[\s>]/g) ?? []).length;
    expect(page).toContain(`<td colSpan={${columns}} className="muted">Nothing matches`);
  });

  it('does not sort on it, since the ranking is not to change', () => {
    expect(page).not.toMatch(/setSort\('wait/);
    expect(page).not.toMatch(/case 'wait'/);
  });
});
