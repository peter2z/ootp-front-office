import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS, SEASON } from './fixture.js';

/**
 * The second half of a call-up: a place on the 40-man.
 *
 * Following a prospect from the farm page to his card, a reader found his
 * ratings, his history and "0 yrs MLB service" — and not whether he was on the
 * 40-man, how many options he had, or who would come off. The 40-Man page was
 * linked from neither, and the farm page's "The move" never looked at roster
 * space at all, though the assistant's own tool description tells it to check
 * the roster crunch before suggesting a call-up. He opened the 40-Man page by
 * hand to finish the job the app had started.
 *
 * Both now read the 40-Man Roster page's own count, so the three cannot
 * disagree about whether the roster is full.
 */

const ORG = 90;
const FARM = 91;

const MAN = {
  /** The weakest right fielder on the big club, and the man the call-up replaces. */
  weakRight: 9001,
  /** Every option used and six years of service: he can refuse the assignment, so it costs nothing. */
  settled: 9002,
  /** Every option used and two years of service: he cannot go down without waivers. */
  spent: 9003,
  /** On the 60-day IL: listed with the 40-man and not counted on it. */
  sixty: 9004,
  /** The call-up. Not on the 40-man. */
  ready: 9005,
} as const;

/** Twenty-four arms on the 26 beside the right fielder and the veteran, thirteen more on the 40 below. */
const ACTIVE_ARM = (i: number) => 9100 + i;
const DEPTH_ARM = (i: number) => 9200 + i;
const AAA_FIELD = (i: number) => 9300 + i;

const DAYS = 172;

/** The real export carries these; the base fixture's short table does not. */
const OPTION_COLUMNS = [
  'options_used', 'years_protected_from_rule_5', 'pro_service_years', 'days_on_waivers_left',
];

interface Status {
  active?: number; secondary?: number; dl?: number; dl60?: number; options: number; years: number;
}

function man(id: number, last: string, pos: number, team: number, grade: [number, number], s?: Status): void {
  db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Crunch', ?, 27, ?, 0, 1, 1, ?, ?, ?, 0, 0, 0, 0)`
  ).run(id, last, pos, id % 100, team, ORG);
  db.prepare(
    `INSERT INTO players_value
       (player_id, overall_value, talent_value, offensive_value, offensive_value_vsl,
        offensive_value_vsr, pitching_value, oa_rating, pot_rating, oa, pot)
     VALUES (?, 500, 500, 100, 100, 100, 0, ?, ?, ?, ?)`
  ).run(id, grade[0], grade[1], grade[0], grade[1]);
  db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(team, id);
  if (!s) return;
  db.prepare(
    `INSERT INTO players_roster_status
       (player_id, is_active, is_on_dl, is_on_dl60, is_on_secondary,
        mlb_service_years, mlb_service_days, mlb_service_days_this_year,
        options_used, years_protected_from_rule_5, pro_service_years)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 4, 3)`
  ).run(
    id, s.active ?? 0, s.dl ?? 0, s.dl60 ?? 0, s.secondary ?? 0, s.years, s.years * DAYS + 20, s.options
  );
}

function bat(id: number, line: [pa: number, ab: number, h: number, d: number, t: number, hr: number, bb: number]): void {
  db.prepare(
    `INSERT INTO players_career_batting_stats
       (player_id, year, team_id, league_id, level_id, split_id, pa, ab, h, d, t, hr,
        bb, ibb, hp, sf, k, sb, cs, r, rbi, war)
     VALUES (?, ?, ?, ?, 2, 1, ?, ?, ?, ?, ?, ?, ?, 0, 3, 2, 50, 0, 0, 30, 30, 1.0)`
  ).run(id, SEASON, FARM, IDS.league, ...line);
}

function addClub(): void {
  const have = new Set(
    (db.prepare(`PRAGMA table_info(players_roster_status)`).all() as Array<{ name: string }>).map((c) => c.name)
  );
  for (const col of OPTION_COLUMNS) {
    if (!have.has(col)) db.exec(`ALTER TABLE players_roster_status ADD COLUMN ${col} INTEGER DEFAULT 0`);
  }

  const team = db.prepare(
    `INSERT INTO teams (team_id, name, nickname, abbr, level, league_id, sub_league_id,
                        division_id, parent_team_id, allstar_team)
     VALUES (?, 'Crunch', ?, ?, ?, ?, 0, 0, ?, 0)`
  );
  team.run(ORG, 'Club', 'CRC', 1, IDS.league, 0);
  team.run(FARM, 'Farm', 'CRF', 2, IDS.league, ORG);

  // The 26: a right fielder, a veteran arm, and twenty-four more
  man(MAN.weakRight, 'Weakright', 9, ORG, [40, 40], { active: 1, options: 1, years: 4 });
  man(MAN.settled, 'Settled', 1, ORG, [35, 35], { active: 1, options: 3, years: 6 });
  for (let i = 0; i < 24; i++) {
    man(ACTIVE_ARM(i), `Arm${i}`, 1, ORG, [50, 50], { active: 1, options: 1, years: 3 });
  }
  // The rest of the 40, at Triple-A: thirteen with options, and one without
  for (let i = 0; i < 13; i++) {
    man(DEPTH_ARM(i), `Depth${i}`, 1, FARM, [45, 50], { secondary: 1, options: 1, years: 0 });
  }
  man(MAN.spent, 'Spent', 1, FARM, [38, 38], { secondary: 1, options: 3, years: 2 });
  /*
   * Graded lowest of all, and on the 60-day list: moving him frees nothing,
   * because he stopped counting the day he went on it. The page that names a
   * man to come off must not name him.
   */
  man(MAN.sixty, 'Sixty', 1, ORG, [30, 30], { dl: 1, dl60: 1, options: 0, years: 5 });

  // A Triple-A field, so the level average is real
  for (let i = 0; i < 4; i++) {
    man(AAA_FIELD(i), `Field${i}`, 3, FARM, [35, 40]);
    bat(AAA_FIELD(i), [300, 270, 68, 13, 1, 6, 25]);
  }
  // .327/.403/.585 at Triple-A, graded above the weakest right fielder, and off the 40-man
  man(MAN.ready, 'Ready', 9, FARM, [50, 55], { options: 0, years: 0 });
  bat(MAN.ready, [300, 260, 85, 18, 2, 15, 32]);
}

interface Standing {
  on40: boolean; on26: boolean; il60: boolean;
  optionsUsed: number | null; optionsLeft: number | null; outOfOptions: boolean;
  fortyMan: { count: number; limit: number } | null;
}

interface Row {
  player_id: number;
  signal: string | null;
  move: {
    blocked: boolean;
    note: string;
    fortyMan: {
      count: number; limit: number;
      comesOff: { player_id: number; name: string; why: string } | null;
    } | null;
  } | null;
}

const card = async (id: number): Promise<Standing | null> =>
  ((await request(`/api/player/${id}`)) as { rosterStatus: Standing | null }).rosterStatus;

const callUp = async (): Promise<Row> => {
  const d = await request(`/api/prospects/${ORG}`);
  const row = ([...(d.batters ?? []), ...(d.pitchers ?? [])] as Row[]).find((r) => r.player_id === MAN.ready);
  expect(row, 'the call-up never reached the farm page').toBeDefined();
  return row!;
};

/** Changes one thing about the roster for the length of a check, then puts it back. */
async function withChange(apply: string, undo: string, args: unknown[], check: () => Promise<void>): Promise<void> {
  db.prepare(apply).run(...args);
  try {
    await check();
  } finally {
    db.prepare(undo).run(...args);
  }
}

describe('a card from an export without the option columns', () => {
  /*
   * Runs before the columns are added. The base fixture's roster-status table
   * is that shape, and a card should say it does not know his options rather
   * than print a confident "3 options left" for a man who may have none.
   */
  it('leaves the options unsaid', async () => {
    const r = await card(IDS.starter);
    expect(r, 'no roster status at all for a man on a roster').not.toBeNull();
    expect(r!.on26).toBe(true);
    expect(r!.optionsUsed).toBeNull();
    expect(r!.optionsLeft).toBeNull();
    expect(r!.outOfOptions).toBe(false);
  });
});

describe('the player card', () => {
  beforeAll(addClub);

  it('says a prospect is off the 40-man, how full it is, and his options', async () => {
    const r = await card(MAN.ready);
    expect(r).toEqual({
      on40: false, on26: false, il60: false,
      optionsUsed: 0, optionsLeft: 3, outOfOptions: false,
      fortyMan: { count: 40, limit: 40 },
    });
  });

  it('counts the 40-man exactly as the 40-Man Roster page does', async () => {
    const page = (await request(`/api/roster-crunch/${ORG}`)) as { counts: { fortyMan: number } };
    expect((await card(MAN.ready))!.fortyMan!.count).toBe(page.counts.fortyMan);
  });

  it('flags a man out of options under five years of service', async () => {
    const r = (await card(MAN.spent))!;
    expect(r.on40).toBe(true);
    expect(r.on26).toBe(false);
    expect(r.optionsLeft).toBe(0);
    expect(r.outOfOptions).toBe(true);
  });

  it('does not flag a veteran with every option used', async () => {
    // Past five years he can refuse the assignment; the missing option costs nothing
    const r = (await card(MAN.settled))!;
    expect(r.on26).toBe(true);
    expect(r.optionsLeft).toBe(0);
    expect(r.outOfOptions).toBe(false);
    // A major leaguer is already there; the count is for men who would need a place
    expect(r.fortyMan).toBeNull();
  });

  it('marks the 60-day IL as listed but not counted', async () => {
    const r = (await card(MAN.sixty))!;
    expect(r.on40).toBe(true);
    expect(r.il60).toBe(true);
  });
});

describe('a call-up onto a full 40-man', () => {
  it('is still the right move, and says it needs a place', async () => {
    const him = await callUp();
    expect(him.signal).toBe('promote');
    expect(him.move?.note).toBe(
      "would take Crunch Weakright's spot at RF — 50 to his 40; " +
      'needs a 40-man spot: Crunch Spent (out of options)'
    );
    expect(him.move?.fortyMan).toEqual({
      count: 40, limit: 40,
      comesOff: { player_id: MAN.spent, name: 'Crunch Spent', why: 'out of options' },
    });
  });

  it('never names a man on the 60-day IL, who frees nothing', async () => {
    // Graded 30, the lowest on the list: lowest is not the question
    expect((await callUp()).move?.note).not.toMatch(/Sixty/);
  });

  it('never names a veteran whose missing options cost the club nothing', async () => {
    expect((await callUp()).move?.note).not.toMatch(/Settled/);
  });

  it('names a man out long enough for the 60-day list first, since moving him costs nothing', async () => {
    const hurt = ACTIVE_ARM(0);
    await withChange(
      `UPDATE players_roster_status SET is_active = 0, is_on_dl = 1 WHERE player_id = ?`,
      `UPDATE players_roster_status SET is_active = 1, is_on_dl = 0 WHERE player_id = ?`,
      [hurt],
      async () => {
        db.prepare(`UPDATE players SET injury_is_injured = 1, injury_left = 90 WHERE player_id = ?`).run(hurt);
        try {
          expect((await callUp()).move?.note).toMatch(/needs a 40-man spot: Crunch Arm0 \(to the 60-day IL\)$/);
          // Back in three weeks, he is not going on a sixty-day list
          db.prepare(`UPDATE players SET injury_left = 20 WHERE player_id = ?`).run(hurt);
          expect((await callUp()).move?.note).toMatch(/Crunch Spent \(out of options\)$/);
        } finally {
          db.prepare(`UPDATE players SET injury_is_injured = 0, injury_left = 0 WHERE player_id = ?`).run(hurt);
        }
      }
    );
  });

  it('says the roster is full when nobody obviously comes off', async () => {
    /*
     * With every man on it holding options, whom to drop is the reader's
     * judgment about his own club, not a fact the save holds.
     */
    await withChange(
      `UPDATE players_roster_status SET options_used = 2 WHERE player_id = ?`,
      `UPDATE players_roster_status SET options_used = 3 WHERE player_id = ?`,
      [MAN.spent],
      async () => {
        const him = await callUp();
        expect(him.move?.note).toMatch(/; 40-man is full$/);
        expect(him.move?.fortyMan?.comesOff).toBeNull();
      }
    );
  });
});

describe('a call-up with room for him', () => {
  it('says nothing about the 40-man when it has a place', async () => {
    await withChange(
      `UPDATE players_roster_status SET is_on_secondary = 0 WHERE player_id = ?`,
      `UPDATE players_roster_status SET is_on_secondary = 1 WHERE player_id = ?`,
      [DEPTH_ARM(0)],
      async () => {
        const him = await callUp();
        expect(him.move?.note).toBe("would take Crunch Weakright's spot at RF — 50 to his 40");
        expect(him.move?.fortyMan).toBeNull();
      }
    );
  });

  it('or when he is on it already', async () => {
    await withChange(
      `UPDATE players_roster_status SET is_on_secondary = 1 WHERE player_id = ?`,
      `UPDATE players_roster_status SET is_on_secondary = 0 WHERE player_id = ?`,
      [MAN.ready],
      async () => {
        expect((await callUp()).move?.fortyMan).toBeNull();
      }
    );
  });
});
