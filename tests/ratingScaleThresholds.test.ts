import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { db } from '../server/db.js';
import { tradeSystem } from '../server/ai.js';
import { chooseFielders, type Candidate } from '../server/lineup.js';
import { tradeVoice } from '../server/staff.js';
import {
  clearScaleCache, clearValuationCaches, ratingScaleMax, scaleGrade,
} from '../server/valuation.js';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * Every cut-off the server applies to a rating, on a save that is not 20-80.
 *
 * OOTP lets the user pick 20-80, 1-100, 1-20, 1-10, 2-8 or 1-5, and the export
 * carries whichever they chose. The bars were fixed on their own when a reader
 * on the 1-to-5 scale found his best contact hitter drawn as a sliver; nobody
 * went through the server. The lineup weighed a point of glove at eight points
 * of bat and called 50 an average fielder, the draft board would not advise on
 * a ceiling under 45, and the trade desk was told every grade it was handed was
 * on 20-80. On the 1-to-5 scale not one of those numbers can be reached, so the
 * advice did not fail loudly. It came out quietly wrong: a board with no read
 * on any prospect, a card that benched the best glove in the club for a bat.
 *
 * (docs/review/2026-10-02-front-office-review.md, finding T14.)
 *
 * Each check below puts the same league through two scales and asks for the
 * same answer. The grades are chosen to convert exactly, which is what makes
 * "the same answer" a fair thing to ask: a multiple of sixteen is a whole grade
 * on 1-5 (32 is a 2, 48 a 3, 64 a 4, 80 a 5), a multiple of eight on 1-10 and
 * of four on 1-20.
 */

const CLUB = 80;

/** The scales these checks can convert to exactly; 2-8 is not a whole number of steps. */
const SCALES = [5, 10, 20];

// ── Moving the whole save to another scale ──────────────────────────────────

type Row = Record<string, number | null>;

/** Where this file keeps grades. Velocity is a code for miles an hour, not a grade. */
const RATING_TABLES: Array<{ table: string; columns: string[] }> = [];
const original = new Map<string, Row[]>();

function snapshotRatings(): void {
  for (const table of ['players_batting', 'players_pitching', 'players_fielding']) {
    const names = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((c) => c.name)
      .filter((n) => /^(batting_ratings|running_ratings|pitching_ratings|fielding_rating)/.test(n))
      .filter((n) => !n.endsWith('_velocity'));
    RATING_TABLES.push({ table, columns: names });
    original.set(table, db.prepare(`SELECT rowid AS rid, * FROM ${table}`).all() as Row[]);
  }
}

/**
 * Rewrites every grade in the save onto the scale OOTP would have shown it on.
 *
 * Always from the 20-80 originals rather than from whatever is there now, so
 * going to 1-5 and back loses nothing. Zero stays zero — it is "cannot play
 * there", not a very low grade — and nobody drops below the bottom of the scale.
 */
function useScale(max: number): void {
  for (const { table, columns } of RATING_TABLES) {
    const update = db.prepare(
      `UPDATE ${table} SET ${columns.map((c) => `"${c}" = @${c}`).join(', ')} WHERE rowid = @rid`
    );
    for (const row of original.get(table)!) {
      const next: Row = { rid: row.rid };
      for (const c of columns) {
        const v = row[c];
        next[c] = v === null ? null : v === 0 ? 0 : Math.max(1, Math.round((v * max) / 80));
      }
      update.run(next);
    }
  }
  // The scale is read off the data once and remembered until an import says otherwise
  clearScaleCache();
}

/** Runs one thing on another scale and puts the save back, however it ends. */
async function onScale<T>(max: number, run: () => Promise<T> | T): Promise<T> {
  useScale(max);
  try {
    return await run();
  } finally {
    useScale(80);
  }
}

// ── A club where the glove has to be weighed against the bat ─────────────────

interface Man {
  last: string;
  position: number;
  /** OOTP's offensive value, which is not a rating and does not change with the scale. */
  off: number;
  /** Power, contact, eye and speed: what the traditional order is built from. */
  bat: [number, number, number, number];
  /** His rating at each position he can play; anywhere else he cannot. */
  gloves: Record<number, number>;
}

/*
 * Two of them are the point. GloveCF is the best centre fielder in the club by
 * a distance and has the worst bat of the outfield; BatCF has the best bat in
 * the club and an ordinary glove. At 20-80 a glove that good is worth more than
 * the bat, so GloveCF plays centre and BatCF goes to left, which squeezes
 * LeftField out. On the 1-to-5 scale the old weights could not see the glove at
 * all, so the best bat took centre and the best glove sat down.
 *
 * ThirdBase and FirstBase are the same question for the traditional order: they
 * are the two that would bat fourth, one on his bat and one on his power.
 */
const MEN: Man[] = [
  { last: 'Backstop',   position: 2, off: 700,  bat: [32, 32, 32, 32], gloves: { 2: 64 } },
  { last: 'Shortstop',  position: 6, off: 850,  bat: [32, 80, 48, 64], gloves: { 6: 64, 4: 48, 5: 48 } },
  { last: 'GloveCF',    position: 8, off: 800,  bat: [32, 32, 48, 80], gloves: { 8: 80, 7: 64, 9: 64 } },
  { last: 'BatCF',      position: 8, off: 1000, bat: [32, 48, 48, 32], gloves: { 8: 48, 7: 48, 9: 48 } },
  { last: 'ThirdBase',  position: 5, off: 900,  bat: [80, 32, 32, 32], gloves: { 5: 64, 3: 48 } },
  { last: 'SecondBase', position: 4, off: 880,  bat: [32, 64, 64, 48], gloves: { 4: 64, 6: 32 } },
  { last: 'RightField', position: 9, off: 860,  bat: [48, 32, 48, 48], gloves: { 9: 64, 7: 48 } },
  { last: 'LeftField',  position: 7, off: 840,  bat: [48, 48, 48, 48], gloves: { 7: 64 } },
  { last: 'FirstBase',  position: 3, off: 950,  bat: [32, 48, 32, 32], gloves: { 3: 64 } },
  { last: 'Utility',    position: 4, off: 600,  bat: [32, 32, 32, 32], gloves: { 3: 32, 4: 32, 5: 32 } },
];

const manId = (last: string): number => 8001 + MEN.findIndex((m) => m.last === last);

function addClub(): void {
  db.prepare(
    `INSERT INTO teams (team_id, name, nickname, abbr, level, league_id, sub_league_id,
                        division_id, parent_team_id, allstar_team, human_team)
     VALUES (?, 'Glove', 'First', 'GLF', 1, ?, 0, 0, 0, 0, 0)`
  ).run(CLUB, IDS.league);

  for (const m of MEN) {
    const id = manId(m.last);
    db.prepare(
      `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                            uniform_number, team_id, organization_id, retired, hidden,
                            draft_eligible, college)
       VALUES (?, 'Scale', ?, 27, ?, 0, 1, 1, ?, ?, ?, 0, 0, 0, 0)`
    ).run(id, m.last, m.position, id - 8000, CLUB, CLUB);
    db.prepare(
      `INSERT INTO players_roster_status
         (player_id, is_active, is_on_dl, is_on_dl60, is_on_secondary,
          mlb_service_years, mlb_service_days, mlb_service_days_this_year)
       VALUES (?, 1, 0, 0, 0, 3, 516, 40)`
    ).run(id);
    // Offence is read from here, so it is the one thing set directly
    db.prepare(
      `INSERT INTO players_value
         (player_id, overall_value, talent_value, offensive_value, offensive_value_vsl,
          offensive_value_vsr, pitching_value, oa_rating, pot_rating, oa, pot)
       VALUES (?, ?, ?, ?, ?, ?, 0, 50, 50, 50, 50)`
    ).run(id, m.off, m.off, m.off, m.off, m.off);

    const [power, contact, eye, speed] = m.bat;
    db.prepare(`INSERT INTO players_batting VALUES (?, ?, 48, ?, ?, 48, ?, 55, 55, 55, 55, 55)`)
      .run(id, contact, power, eye, speed);
    const row: Record<string, number> = { player_id: id, position: m.position };
    for (let pos = 1; pos <= 9; pos++) row[`fielding_rating_pos${pos}`] = m.gloves[pos] ?? 0;
    const keys = Object.keys(row);
    db.prepare(
      `INSERT INTO players_fielding (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})`
    ).run(row);
  }
}

interface Card {
  lineup: Array<{
    slot: number; player_id: number; name: string; positionName: string; defRating: number | null;
  }>;
}

const card = (style: string, dh: string): Promise<Card> =>
  request(`/api/lineup/${CLUB}?vs=r&style=${style}&dh=${dh}`);

/** Who plays where, which is what a manager reads off the card. */
const fielded = (c: Card): Record<string, string> =>
  Object.fromEntries(c.lineup.map((l) => [l.positionName, l.name.replace('Scale ', '')]));

/** Who bats where. */
const order = (c: Card): string[] => c.lineup.map((l) => l.name.replace('Scale ', ''));

// ── The draft class ─────────────────────────────────────────────────────────

/** Ceiling and present grade, written as 20-80 grades, for one prospect each. */
const GRADES = [16, 32, 48, 64, 80];
const FINE_CURRENT = [32, 40, 44, 48, 52, 60];
const FINE_CEILING = [44, 48, 52, 56, 60, 64];

const prospectIds = new Map<string, number>();
const key = (cur: number, pot: number): string => `${cur}/${pot}`;

function addClass(): void {
  const pairs: Array<[number, number]> = [];
  for (const cur of GRADES) for (const pot of GRADES) if (pot >= cur) pairs.push([cur, pot]);
  for (const cur of FINE_CURRENT) for (const pot of FINE_CEILING) if (pot >= cur) pairs.push([cur, pot]);

  for (const [cur, pot] of pairs) {
    if (prospectIds.has(key(cur, pot))) continue;
    const id = 8100 + prospectIds.size;
    prospectIds.set(key(cur, pot), id);
    // Twenty and a college man, so nothing about the age or the school adds a
    // reason of its own to the read
    db.prepare(
      `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                            uniform_number, team_id, organization_id, retired, hidden,
                            draft_eligible, college, picked_in_draft, draft_league_id)
       VALUES (?, 'Class', ?, 20, 6, 0, 1, 1, 0, 0, 0, 0, 0, 1, 1, 0, ?)`
    ).run(id, `P${pot}C${cur}`, IDS.league);
    // All five graded attributes alike, so the board's average is exactly the grade
    db.prepare(
      `INSERT INTO players_batting VALUES (?, ?, ?, ?, ?, ?, 48, ?, ?, ?, ?, ?)`
    ).run(id, cur, cur, cur, cur, cur, pot, pot, pot, pot, pot);
  }
}

interface Board {
  prospects: Array<{
    player_id: number;
    cur: number | null;
    pot: number | null;
    recommendation: { label: string; reasons: string[] } | null;
  }>;
}

/** What the board says about each prospect, by his own grades on the 20-80 scale. */
async function labels(): Promise<Map<string, string | null>> {
  const board = (await request(`/api/draft/${IDS.mlbTeam}`)) as Board;
  const byId = new Map(board.prospects.map((p) => [p.player_id, p]));
  const out = new Map<string, string | null>();
  for (const [k, id] of prospectIds) {
    const p = byId.get(id);
    expect(p, `prospect ${k} is not on the board`).toBeDefined();
    out.set(k, p!.recommendation?.label ?? null);
  }
  return out;
}

/** A grade that survives the trip to this scale without rounding. */
const converts = (grade: number, max: number): boolean => (grade * max) % 80 === 0;

// ── Setup ───────────────────────────────────────────────────────────────────

beforeAll(() => {
  addClub();
  addClass();
  snapshotRatings();
  clearValuationCaches();
});

afterAll(() => useScale(80));

// ── The helper ──────────────────────────────────────────────────────────────

describe('stating a 20-80 cut-off on the save’s own scale', () => {
  it('is the very number it was given on 20-80', async () => {
    // Every existing save is on this scale, and none of them may move
    expect(ratingScaleMax()).toBe(80);
    for (const n of [1, 8, 15, 20, 45, 50, 52, 55, 80]) expect(scaleGrade(n)).toBe(n);
  });

  it('is the same share of the top of the scale on every other one', async () => {
    for (const max of [5, 8, 10, 20]) {
      await onScale(max, () => {
        expect(ratingScaleMax(), `scale 1-${max} was not read off the data`).toBe(max);
        expect(scaleGrade(80)).toBe(max);
        expect(scaleGrade(40)).toBe(max / 2);
        // A gap is carried the same way a level is: 15 of 80 is 15 eightieths
        expect(scaleGrade(15)).toBeCloseTo((15 * max) / 80, 10);
      });
    }
  });
});

// ── The lineup ──────────────────────────────────────────────────────────────

describe('the lineup on a save that is not 20-80', () => {
  it('on 20-80 plays the best glove in centre and moves the best bat to left', async () => {
    // The reference the other scales are held to, and a check that it says
    // what the club was built to say
    const c = await card('saber', 'off');
    expect(ratingScaleMax()).toBe(80);
    expect(fielded(c).CF, 'the best glove in the club should play centre').toBe('GloveCF');
    expect(fielded(c).LF, 'the best bat moves to left to make room').toBe('BatCF');
    expect(order(c), 'LeftField was squeezed out').not.toContain('LeftField');
  });

  for (const max of SCALES) {
    for (const [style, dh] of [['saber', 'off'], ['saber', 'on'], ['trad', 'off'], ['trad', 'on']]) {
      it(`fills every position with the same men on 1-${max}: ${style}, dh ${dh}`, async () => {
        const eighty = await card(style, dh);
        const there = await onScale(max, async () => {
          expect(ratingScaleMax()).toBe(max);
          return card(style, dh);
        });

        expect(fielded(there)).toEqual(fielded(eighty));
        // The batting order too: the traditional card adds power to offensive
        // value, which is the other place a bare 20-80 weight was hiding
        expect(order(there)).toEqual(order(eighty));
        expect(there.lineup.length).toBe(eighty.lineup.length);
      });
    }

    it(`shows the glove as the save's own grade on 1-${max}`, async () => {
      const eighty = await card('saber', 'off');
      const there = await onScale(max, () => card('saber', 'off'));
      for (const l of there.lineup) {
        const was = eighty.lineup.find((e) => e.player_id === l.player_id);
        expect(was, `${l.name} was not in the 20-80 card`).toBeDefined();
        expect(l.defRating, l.name).toBe(Math.round(((was!.defRating ?? 0) * max) / 80));
      }
    });
  }

  it('picks the cleanup hitter on his power when the save is 1-5', async () => {
    /*
     * The traditional order adds a man's power to his offensive value for the
     * cleanup spot. Written for 20-80 grades, on the 1-to-5 scale it added at
     * most ten points to a value near a thousand, so power never decided
     * anything and the spot went to the next best bat. ThirdBase has the
     * power and FirstBase the bigger bat.
     */
    const eighty = await card('trad', 'off');
    const five = await onScale(5, () => card('trad', 'off'));
    expect(eighty.lineup.find((l) => l.slot === 4)?.name).toBe('Scale ThirdBase');
    expect(five.lineup.find((l) => l.slot === 4)?.name).toBe('Scale ThirdBase');
  });
});

describe('a roster too short to man every position, on 1-5', () => {
  const man = (name: string, off: number, defense: Record<number, number>): Candidate => ({
    player_id: name.length * 1000 + off, name, age: 27, position: 6, positionName: '', bats: 1,
    dayToDay: false, off, rank: off, contact: 3, power: 3, eye: 3, speed: 3, defense,
  });

  it('puts the lone shortstop at short, not at a spot nobody can field', async () => {
    /*
     * Nobody is rated at catcher, so catcher is "unmanned": anyone can be put
     * there at a last-resort rating. That rating was 20, which on a 1-to-5
     * save is better than any real fielder, and with one man for two spots the
     * card stood the shortstop behind the plate rather than at short.
     *
     * His grade is written out for each scale rather than converted, because
     * converting it with the helper under test would agree with the helper
     * whatever it did: 64 on 20-80 is a 4 on 1-5.
     */
    for (const [max, glove] of [[80, 64], [5, 4]]) {
      const assigned = await onScale(max, () =>
        chooseFielders([man('Only', 900, { 6: glove })], [6, 2])
      );
      expect(assigned.size).toBe(1);
      expect(assigned.get(6)?.name, `1-${max}`).toBe('Only');
    }
  });
});

// ── The draft board ─────────────────────────────────────────────────────────

describe('the draft board on a save that is not 20-80', () => {
  const EXPECTED: Array<[cur: number, pot: number, label: string | null]> = [
    // Under the floor: not worth advising on
    [32, 32, null],
    [40, 44, null],
    // A ceiling that clears the floor but not a regular's
    [32, 48, 'Depth piece'],
    [44, 48, 'Depth piece'],
    // Nearly there already
    [48, 48, 'Close to ready'],
    [48, 52, 'Close to ready'],
    [52, 60, 'Close to ready'],
    // Not close to ready (his present grade is under 45), so by ceiling
    [44, 52, 'Everyday-regular ceiling'],
    [40, 52, 'Everyday-regular ceiling'],
    [44, 56, 'Everyday-regular ceiling'],
    // A long way to go, and a long way up
    [40, 60, 'High ceiling, long wait'],
    [64, 80, 'High ceiling, long wait'],
  ];

  it('says what it always said on 20-80', async () => {
    const eighty = await labels();
    for (const [cur, pot, label] of EXPECTED) {
      expect(eighty.get(key(cur, pot)), `${cur} now, ${pot} ceiling`).toBe(label);
    }
  });

  it('is not silent on a save with no grade anywhere near 45', async () => {
    /*
     * The failure that was visible: a ceiling can never reach 45 on 1-5, so
     * `pot < 45` returned nothing for every prospect and the board's read was
     * a column of blanks.
     */
    const five = await onScale(5, labels);
    for (const [k, label] of five) {
      const [cur, pot] = k.split('/').map(Number);
      if (!converts(cur, 5) || !converts(pot, 5) || pot < 45) continue;
      expect(label, `${cur} now, ${pot} ceiling, on 1-5`).not.toBeNull();
    }
    expect([...five.values()].filter((l) => l !== null).length).toBeGreaterThan(0);
  });

  for (const max of SCALES) {
    it(`gives the same read for the same relative grades on 1-${max}`, async () => {
      const eighty = await labels();
      const there = await onScale(max, async () => {
        expect(ratingScaleMax()).toBe(max);
        return labels();
      });

      const compared = new Map<string, string | null>();
      for (const [k, label] of eighty) {
        const [cur, pot] = k.split('/').map(Number);
        if (!converts(cur, max) || !converts(pot, max)) continue;
        compared.set(k, label);
        expect(there.get(k), `${cur} now, ${pot} ceiling, on 1-${max}`).toBe(label);
      }
      // A comparison over nothing would pass whatever the board did, and so
      // would one over prospects that all get the same answer
      expect(compared.size, `no prospect converts exactly to 1-${max}`).toBeGreaterThan(10);
      expect(new Set(compared.values()).size, 'every prospect got the same read').toBeGreaterThanOrEqual(4);
    });
  }

  it('does not say "1 points" when the gap is a single grade', async () => {
    const board = await onScale(5, async () => (await request(`/api/draft/${IDS.mlbTeam}`)) as Board);
    // 64 now and 80 ceiling is a 4 and a 5, a single point of it still projection
    const him = board.prospects.find((p) => p.player_id === prospectIds.get(key(64, 80)));
    const first = him?.recommendation?.reasons[0] ?? '';
    expect(first).toBe('5 ceiling, but 1 point of it is still projection');
  });
});

// ── The trade desk's prompt ─────────────────────────────────────────────────

describe('the trade desk’s prompt on a save that is not 20-80', () => {
  const prompt = (): string => tradeSystem(tradeVoice(IDS.mlbTeam), 'Test Nine');

  it('still names 20-80 on a 20-80 save, with the example it always had', () => {
    const p = prompt();
    expect(p).toContain('the 20-80 scale this save uses (about 50 is average and 70 or more is elite)');
    expect(p).toContain('"60 at 2B, 35 at SS (ceiling 55)"');
    expect(p).toContain('A 48-overall reliever and a 48-overall shortstop');
  });

  it('names 1-5 on a 1-5 save, and what an average and an elite grade are on it', async () => {
    const p = await onScale(5, prompt);
    expect(p).toContain('the 1-5 scale this save uses (about 3 is average and 5 is elite)');
    // Not a single mention of the scale it is no longer on
    expect(p, 'the prompt still says 20-80').not.toContain('20-80');
  });

  it('gives an example that a 1-5 save could actually contain', async () => {
    const p = await onScale(5, prompt);
    expect(p).toContain('"4 at 2B, 2 at SS (ceiling 3)"');
    expect(p).not.toContain('60 at 2B');
  });

  it('names the other scales by their own range', async () => {
    const wanted: Array<[number, string]> = [
      [10, 'the 1-10 scale this save uses (about 5 is average and 9 or more is elite)'],
      [8, 'the 2-8 scale this save uses (about 5 is average and 7 or more is elite)'],
      [20, 'the 1-20 scale this save uses (about 10 is average and 17 or more is elite)'],
    ];
    for (const [max, sentence] of wanted) {
      expect(await onScale(max, prompt), `1-${max}`).toContain(sentence);
    }
  });

  it('keeps a ceiling under the grade it caps', async () => {
    // 55 over 60 on 2-8 is 5.5 over 6; rounding both to the nearest would make
    // the ceiling the grade itself, and the example would stop making its point
    const p = await onScale(8, prompt);
    expect(p).toContain('"6 at 2B, 4 at SS (ceiling 5)"');
  });
});
