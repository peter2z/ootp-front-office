import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../server/db.js';
import { historyDb } from '../server/history.js';
import { loadConfig } from '../server/config.js';
import { recentTransactions } from '../server/transactions.js';
import request from './request.js';
import { IDS, SEASON } from './fixture.js';

/**
 * Getting past the first two hundred deals.
 *
 * The Transactions page stopped at "200 of 200": the newest two hundred, a count
 * that read as if it were the whole of the league's paperwork, and no way to
 * load an older deal or to go to a date. A reader looking for what a club did at
 * last season's deadline could only scroll to the bottom of the newest two
 * hundred and stop.
 *
 * The feed is now served a page at a time. What these pin down is the thing that
 * makes "load more" trustworthy, which is that a page is the same slice of the
 * same list however much of it was asked for: laid end to end, pages must give
 * back the feed exactly, with no deal repeated and none skipped. That has to
 * hold across a date that several deals share and across a feed built from three
 * different tables, which is where an order that depends on the size of the
 * window goes wrong.
 *
 * Twenty deals stand in for the league's two hundred and more, and the page sizes
 * below are small ones so that every boundary is crossed.
 */

const OTHER = IDS.otherMlbTeam;
const SAVE = loadConfig().saveName ?? 'unknown';

/**
 * OOTP writes dates unpadded, and several deals share a day: three trades on
 * the ninth of May, two on the second and on the twenty-third, which is what a
 * page boundary lands inside.
 */
const TRADE_DATES = [
  '5-1', '5-2', '5-2', '5-9', '5-9', '5-9', '5-23', '5-23', '6-1', '6-2', '6-2', '6-15',
];

beforeAll(() => {
  const trade = db.prepare(
    `INSERT INTO trade_history (date, summary, message_id, team_id_0, team_id_1,
                                player_id_0_0, player_id_1_0)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const message = db.prepare(
    `INSERT INTO messages (message_id, subject, date, message_type, team_id_0, team_id_1,
                           player_id_0, league_id_0)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  TRADE_DATES.forEach((day, i) => {
    const n = i + 1;
    trade.run(
      `${SEASON}-${day}`,
      `The <Test Nine:team#${IDS.mlbTeam}> trade <Reg Ular:player#${IDS.starter}> to the ` +
        `<Other Club:team#${OTHER}> in deal ${n}.`,
      1000 + n, IDS.mlbTeam, OTHER, IDS.starter, 0
    );
  });
  // Every trade is a message as well; three of them here, which the feed must
  // not print a second time on any page
  for (const n of [1, 4, 12]) {
    message.run(1000 + n, `Deal ${n} swap`, `${SEASON}-${TRADE_DATES[n - 1]}`, 1,
                IDS.mlbTeam, OTHER, IDS.starter, IDS.league);
  }

  // The news: signings, and claims, which are a different kind of row
  const news: Array<[id: number, subject: string, day: string, type: number]> = [
    [2100, 'Signing one: Reg Ular agrees to terms', '5-2', 2],
    [2101, 'Waiver claim one finished and executed successfully', '5-9', 1],
    [2102, 'Signing two: Lefty Swinger agrees to terms', '5-9', 2],
    [2103, 'Signing three: Switch Hitter agrees to terms', '5-20', 2],
    [2104, 'Waiver claim two finished and executed successfully', '5-23', 1],
    [2105, 'Signing four: Locked Up agrees to terms', '6-2', 2],
    [2106, 'Signing five: Paid Off agrees to terms', '6-10', 2],
    [2107, 'Waiver claim three finished and executed successfully', '6-15', 1],
  ];
  for (const [id, subject, day, type] of news) {
    message.run(id, subject, `${SEASON}-${day}`, type, OTHER, 0, 0, IDS.league);
  }
});

interface Txn { date: string | null; kind: string; plain: string; yours: boolean }
interface Feed { transactions: Txn[]; yours: number; available: boolean; hasMore: boolean }

const page = (query = ''): Promise<Feed> => request(`/api/transactions/${IDS.mlbTeam}${query}`);
const everything = async (extra = ''): Promise<Txn[]> =>
  (await page(`?limit=500${extra}`)).transactions;
/** Which deal it is, in a form two lists can be compared by. */
const key = (t: Txn): string => `${t.date}|${t.kind}|${t.plain}`;

/** Reads the feed the way the page does: a page, then the next, until it says it is done. */
async function walk(size: number, extra = ''): Promise<Txn[]> {
  const seen: Txn[] = [];
  for (let offset = 0; offset < 10_000; offset += size) {
    const p = await page(`?limit=${size}&offset=${offset}${extra}`);
    seen.push(...p.transactions);
    if (!p.hasMore) return seen;
  }
  throw new Error('the pages never ran out');
}

describe('the feed, a page at a time', () => {
  it('is still the newest two hundred when nothing is asked for', async () => {
    const d = await page();
    expect(d.transactions).toHaveLength(20);
    expect(d.hasMore).toBe(false);
    expect(d.transactions.map(key)).toEqual((await everything()).map(key));
  });

  it('holds to the limit and says there are older deals behind it', async () => {
    const all = await everything();
    const d = await page('?limit=5');
    expect(d.transactions.map(key)).toEqual(all.slice(0, 5).map(key));
    expect(d.hasMore).toBe(true);
  });

  it('starts the next page where the last one stopped', async () => {
    const all = await everything();
    const d = await page('?limit=5&offset=5');
    expect(d.transactions.map(key)).toEqual(all.slice(5, 10).map(key));
  });

  it('knows exactly when it has reached the end', async () => {
    // Twenty deals: a page that ends on the twentieth has nothing behind it,
    // and one that ends on the nineteenth has one
    expect((await page('?limit=5&offset=15')).hasMore).toBe(false);
    expect((await page('?limit=5&offset=14')).hasMore).toBe(true);
    expect((await page('?limit=6&offset=14')).hasMore).toBe(false);
    expect((await page('?limit=20')).hasMore).toBe(false);
    expect((await page('?limit=19')).hasMore).toBe(true);
  });

  it('gives back nothing, without failing, past the end', async () => {
    const d = await page('?limit=5&offset=100');
    expect(d.transactions).toEqual([]);
    expect(d.hasMore).toBe(false);
  });

  it('never repeats a deal or skips one when the pages are laid end to end', async () => {
    /*
     * The thing "load more" depends on. Sizes chosen to land a boundary inside
     * the three deals of the ninth, the two of the second, and on either side of
     * the end of the feed.
     */
    const all = (await everything()).map(key);
    expect(new Set(all).size, 'the feed itself has a deal twice').toBe(all.length);
    for (const size of [1, 2, 3, 4, 7, 19, 20, 21]) {
      expect((await walk(size)).map(key), `pages of ${size}`).toEqual(all);
    }
  });

  it('runs newest first from one page to the next', async () => {
    const dates = (await walk(3)).map((t) => t.date ?? '');
    expect(dates).toEqual([...dates].sort().reverse());
    expect(dates[0]).toBe(`${SEASON}-06-15`);
  });

  it('counts the reader\'s own deals on the page it sends', async () => {
    const d = await page('?limit=7&offset=3');
    expect(d.yours).toBe(d.transactions.filter((t) => t.yours).length);
  });

  it('does not print a trade twice because the news carried it too', async () => {
    // Deals 1, 4 and 12 are also messages. Dropped before the limit and not
    // after it, or a page would be short by however many of them it held
    const all = await everything();
    expect(all.filter((t) => /Deal \d+ swap/.test(t.plain))).toEqual([]);
    expect((await page('?limit=3')).transactions).toHaveLength(3);
  });
});

describe('jumping to a date', () => {
  // Nine deals are on or before the ninth of May: six trades (three on the ninth
  // itself, two on the second, one on the first) and three from the news (a
  // signing on the second, a claim and a signing on the ninth)
  const NINTH = `${SEASON}-05-09`;

  it('stops at the day asked for, and keeps that day', async () => {
    const d = (await everything(`&before=${NINTH}`)).map((t) => t.date ?? '');
    expect(d).toHaveLength(9);
    expect(d[0]).toBe(NINTH);
    expect(d.every((x) => x <= NINTH)).toBe(true);
  });

  it('takes the date padded or as OOTP writes it', async () => {
    const padded = (await everything(`&before=${NINTH}`)).map(key);
    const unpadded = (await everything(`&before=${SEASON}-5-9`)).map(key);
    expect(unpadded).toEqual(padded);
  });

  it('pages within the day it stopped at', async () => {
    const all = (await everything(`&before=${NINTH}`)).map(key);
    for (const size of [1, 2, 4]) {
      expect((await walk(size, `&before=${NINTH}`)).map(key), `pages of ${size}`).toEqual(all);
    }
  });

  it('says whether there is more behind the day, too', async () => {
    expect((await page(`?limit=5&before=${NINTH}`)).hasMore).toBe(true);
    expect((await page(`?limit=9&before=${NINTH}`)).hasMore).toBe(false);
  });

  it('ignores a date it cannot read rather than answering with nothing', async () => {
    const all = (await everything()).map(key);
    expect((await everything('&before=yesterday')).map(key)).toEqual(all);
    expect((await everything('&before=')).map(key)).toEqual(all);
  });

  it('is empty before anything happened', async () => {
    const d = await page('?before=2000-01-01');
    expect(d.transactions).toEqual([]);
    expect(d.hasMore).toBe(false);
  });
});

describe('the numbers it is given', () => {
  it('falls back to the defaults for ones that make no sense', async () => {
    const all = (await everything()).map(key);
    for (const q of ['?limit=abc', '?limit=', '?offset=abc', '?offset=-4', '?offset=', '?limit=1e9x']) {
      expect((await page(q)).transactions.map(key), q).toEqual(all);
    }
  });

  it('hands over at least one deal however small the limit', async () => {
    const d = await page('?limit=-3');
    expect(d.transactions).toHaveLength(1);
    expect(d.hasMore).toBe(true);
  });

  it('keeps the short lists the AI prompts ask for', () => {
    // The recap and the paper read the newest few, which is all they ever did
    return everything().then((all) => {
      expect(recentTransactions(IDS.mlbTeam, 3).map(key)).toEqual(all.slice(0, 3).map(key));
      expect(recentTransactions(IDS.mlbTeam)).toHaveLength(all.length);
    });
  });
});

describe('asking for a great many', () => {
  const BULK = '2001-3-';

  beforeAll(() => {
    // Five hundred and twenty trades from long before anything else here
    const trade = db.prepare(
      `INSERT INTO trade_history (date, summary, message_id, team_id_0, team_id_1, player_id_0_0)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    db.transaction(() => {
      for (let i = 0; i < 520; i++) {
        trade.run(`${BULK}${1 + (i % 28)}`, `Old deal ${i}.`, 5000 + i, IDS.mlbTeam, OTHER, IDS.starter);
      }
    })();
  });
  afterAll(() => {
    db.prepare(`DELETE FROM trade_history WHERE date LIKE ?`).run(`${BULK}%`);
  });

  it('will not hand over more than five hundred at once', async () => {
    // A stray number in the address must not be a way to read out the league
    const d = await page('?limit=100000');
    expect(d.transactions).toHaveLength(500);
    expect(d.hasMore).toBe(true);
  });

  it('can still be walked to the very end', async () => {
    expect((await walk(500)).length).toBe(20 + 520);
  });
});

/**
 * A contract line for a deal the news already told.
 *
 * The news is the better account where there is one, so a man whose signing it
 * reported does not also get a line recovered from comparing two exports. That
 * check used to be made against whichever stories had been loaded. On the first
 * page his story was not among them, so his contract line stood there; on the
 * second it was, so the line vanished and every deal below it moved up one place
 * — one deal skipped at the boundary, and the same signing printed twice.
 */
describe('a contract line for a man the news already told of', () => {
  const REPORTED = 9900; // the news wrote a story about his signing, a month back
  const QUIET = 9901;    // it did not
  const EARLIER = `${SEASON}-6-16`;
  const LATER = `${SEASON}-6-20`;

  beforeAll(() => {
    db.prepare(
      `INSERT INTO messages (message_id, subject, date, message_type, team_id_0, team_id_1,
                             player_id_0, league_id_0)
       VALUES (2200, 'Pat Reported: Contract Signed', ?, 2, ?, 0, ?, ?)`
    ).run(`${SEASON}-5-3`, IDS.mlbTeam, REPORTED, IDS.league);

    const snap = historyDb.prepare(
      `INSERT OR REPLACE INTO contract_snapshots
         (save_name, game_date, player_id, name, team_id, org_id, years, total, salary0)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const [id, name] of [[REPORTED, 'Pat Reported'], [QUIET, 'Quinn Quiet']] as Array<[number, string]>) {
      snap.run(SAVE, EARLIER, id, name, IDS.mlbTeam, IDS.mlbTeam, 1, 500_000, 500_000);
      snap.run(SAVE, LATER, id, name, IDS.mlbTeam, IDS.mlbTeam, 5, 2_000_000, 400_000);
    }
  });
  afterAll(() => {
    historyDb.prepare(`DELETE FROM contract_snapshots WHERE game_date IN (?, ?)`).run(EARLIER, LATER);
    db.prepare(`DELETE FROM messages WHERE message_id = 2200`).run();
  });

  it('is left out, so he is not reported twice', async () => {
    const all = await everything();
    const him = all.filter((t) => t.plain.includes('Pat Reported'));
    expect(him).toHaveLength(1);
    expect(him[0].kind).toBe('signing');
  });

  it('is left out on every page, not only where his story is loaded', async () => {
    /*
     * Pages of three put the signing of the third of May well beyond the first
     * page's window of newest stories. It must make no difference.
     */
    for (const size of [1, 2, 3, 5]) {
      const him = (await walk(size)).filter((t) => t.plain.includes('Pat Reported'));
      expect(him.map((t) => t.kind), `pages of ${size}`).toEqual(['signing']);
    }
  });

  it('still reports the man the news said nothing about, once', async () => {
    for (const size of [1, 3, 7]) {
      const him = (await walk(size)).filter((t) => t.plain.includes('Quinn Quiet'));
      expect(him.map((t) => t.kind), `pages of ${size}`).toEqual(['contract']);
    }
  });

  it('lays the pages end to end exactly as the whole feed', async () => {
    const all = (await everything()).map(key);
    for (const size of [1, 2, 3, 4, 6]) {
      expect((await walk(size)).map(key), `pages of ${size}`).toEqual(all);
    }
  });

  it('dates it the day it was noticed, so an earlier day leaves it out', async () => {
    // Only the window is known, and the line is filed under the end of it
    const all = await everything();
    expect(all[0].plain).toContain('Quinn Quiet');
    const before = await everything(`&before=${SEASON}-06-19`);
    expect(before.some((t) => t.kind === 'contract')).toBe(false);
  });
});
