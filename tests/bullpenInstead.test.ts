import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import { standInFor } from '../server/pitching.js';
import type { Health } from '../server/health.js';
import request from './request.js';
import { IDS, SEASON } from './fixture.js';

/**
 * Who to use instead, next to a reliever who cannot go tonight.
 *
 * The bullpen table said which arms were limited — a red "Third straight day"
 * beside the closer, an amber "Pitched yesterday (22 pitches)" further down —
 * and then left the next step to the reader: scan the rest of the column for
 * somebody green, remember which of them throws left, and work out whose
 * innings he would be taking. That scan is the reason the page is opened on a
 * night like that one, and it was the part the page did not do.
 *
 * Every limited or unavailable arm now carries `instead`: the best available
 * reliever to use in his place, or null when nobody can take the innings. The
 * choice has three parts, and a test apiece below. The same hand comes first;
 * then the next man down the pecking order, which is the order the table is
 * already in (closer first, then by ERA+); and so the closer's cover is the best
 * arm that is not a closer himself, and a man at the bottom with nobody behind
 * him is covered from above, with the closer the last place anyone is sent.
 *
 * The rule is checked on hand-built pens, where one fact can be changed at a
 * time, and the wiring on three clubs built from real game logs, so the colours
 * that decide who is "available" are the ones the page itself computes.
 */

type Tone = 'ok' | 'warn' | 'bad';

let ids = 0;
/** A reliever as the bullpen row describes him, with only what the choice reads. */
const arm = (
  name: string,
  tone: Tone,
  opts: { throws?: string; closer?: boolean; injury?: Health | null } = {}
) => ({
  player_id: ++ids,
  name,
  throws: opts.throws ?? 'R',
  isCloser: opts.closer ?? false,
  // Distinct per man, so a test can say which one it was handed back
  status: `${name} is ${tone}`,
  tone,
  injury: opts.injury ?? null,
});

const DAY_TO_DAY: Health = { status: 'Day-to-day', daysLeft: 2, durationUnknown: false, playable: true };
const ON_THE_IL: Health = { status: 'IL', daysLeft: 30, durationUnknown: false, playable: false };

describe('a closer who cannot go', () => {
  it('is covered by the best available setup man', () => {
    const closer = arm('Closer', 'bad', { closer: true });
    const setup = arm('Setup', 'ok');
    const middle = arm('Middle', 'ok');
    expect(standInFor(closer, [closer, setup, middle])?.name).toBe('Setup');
  });

  it('passes over a setup man who is limited himself', () => {
    const closer = arm('Closer', 'bad', { closer: true });
    const tired = arm('Tired', 'warn');
    const spent = arm('Spent', 'bad');
    const fresh = arm('Fresh', 'ok');
    expect(standInFor(closer, [closer, tired, spent, fresh])?.name).toBe('Fresh');
  });

  it('is not covered by a second closer', () => {
    // Two arms carry the closer role in some saves; the cover is somebody who does not
    const closer = arm('Closer', 'bad', { closer: true });
    const other = arm('Other', 'ok', { closer: true });
    const middle = arm('Middle', 'ok');
    expect(standInFor(closer, [closer, other, middle])?.name).toBe('Middle');
  });

  it('is covered when he is on the injured list, which is when it matters most', () => {
    const closer = arm('Closer', 'bad', { closer: true, injury: ON_THE_IL });
    const setup = arm('Setup', 'ok');
    expect(standInFor(closer, [closer, setup])?.name).toBe('Setup');
  });
});

describe('a man in the middle of the order', () => {
  it('is covered by the next man down, and not by the closer', () => {
    const closer = arm('Closer', 'ok', { closer: true });
    const setup = arm('Setup', 'ok');
    const tired = arm('Tired', 'warn');
    const long = arm('Long', 'ok');
    expect(standInFor(tired, [closer, setup, tired, long])?.name).toBe('Long');
  });

  it('is covered from above when nobody below him can go, nearest first', () => {
    // The man at the bottom of the order has nobody behind him: the arm just
    // above him is the one to send, and the closer is the last to be asked
    const closer = arm('Closer', 'ok', { closer: true });
    const setup = arm('Setup', 'ok');
    const middle = arm('Middle', 'ok');
    const tired = arm('Tired', 'warn');
    expect(standInFor(tired, [closer, setup, middle, tired])?.name).toBe('Middle');
  });

  it('turns to the closer only when he is all there is', () => {
    const closer = arm('Closer', 'ok', { closer: true });
    const setup = arm('Setup', 'bad');
    const tired = arm('Tired', 'warn');
    expect(standInFor(tired, [closer, setup, tired])?.name).toBe('Closer');

    const rested = arm('Rested', 'ok');
    expect(standInFor(tired, [closer, rested, setup, tired])?.name).toBe('Rested');
  });
});

describe('the same hand', () => {
  it('comes before the next man down', () => {
    // A tired lefty is wanted for a left-handed batter: the lefty two places
    // down is the better answer than the righty in the very next place
    const closer = arm('Closer', 'ok', { closer: true });
    const lefty = arm('Lefty', 'warn', { throws: 'L' });
    const righty = arm('Righty', 'ok', { throws: 'R' });
    const otherLefty = arm('OtherLefty', 'ok', { throws: 'L' });
    expect(standInFor(lefty, [closer, lefty, righty, otherLefty])?.name).toBe('OtherLefty');
  });

  it('still has a man of his own hand below him ahead of one nearer above', () => {
    // Hand narrows the field; within it, down the order is still before up,
    // however much nearer the one above happens to be
    const closer = arm('Closer', 'ok', { closer: true });
    const above = arm('Above', 'ok', { throws: 'R' });
    const righty = arm('Righty', 'bad', { throws: 'R' });
    const lefty = arm('Lefty', 'ok', { throws: 'L' });
    const below = arm('Below', 'ok', { throws: 'R' });
    expect(standInFor(righty, [closer, above, righty, lefty, below])?.name).toBe('Below');
  });

  it('comes before a nearer man of the other hand, above him as well as below', () => {
    // The lefty is the nearest arm and the wrong hand for him; the closer is further up and right
    const closer = arm('Closer', 'ok', { closer: true });
    const lefty = arm('Lefty', 'ok', { throws: 'L' });
    const righty = arm('Righty', 'bad', { throws: 'R' });
    expect(standInFor(righty, [closer, lefty, righty])?.name).toBe('Closer');
  });

  it('gives way to the other hand when nobody of his own can go', () => {
    const closer = arm('Closer', 'ok', { closer: true });
    const lefty = arm('Lefty', 'bad', { throws: 'L' });
    const righty = arm('Righty', 'ok', { throws: 'R' });
    expect(standInFor(lefty, [closer, lefty, righty])?.name).toBe('Righty');
  });

  it('does not match two men whose hand is not known', () => {
    // "?" is the page saying it could not read a hand; two of them are not a pair
    const closer = arm('Closer', 'ok', { closer: true });
    const unknown = arm('Unknown', 'warn', { throws: '?' });
    const righty = arm('Righty', 'ok', { throws: 'R' });
    const otherUnknown = arm('OtherUnknown', 'ok', { throws: '?' });
    expect(standInFor(unknown, [closer, unknown, righty, otherUnknown])?.name).toBe('Righty');
  });
});

describe('nobody who can take the innings', () => {
  it('is null when every other arm is limited or out', () => {
    const closer = arm('Closer', 'bad', { closer: true });
    const tired = arm('Tired', 'warn');
    const out = arm('Out', 'bad', { injury: ON_THE_IL });
    const pen = [closer, tired, out];
    for (const man of pen) expect(standInFor(man, pen), `${man.name} was handed a stand-in`).toBeNull();
  });

  it('is null for a man with no one else in the pen', () => {
    const only = arm('Only', 'bad', { closer: true });
    expect(standInFor(only, [only])).toBeNull();
  });

  it('is null when the only green arm is hurt, even day-to-day', () => {
    // OOTP lets a manager use a day-to-day man and the table still reads his
    // workload, so he can be green. Telling the reader to use a man the same
    // page tags as injured would be two answers on one screen.
    const closer = arm('Closer', 'bad', { closer: true });
    const sore = arm('Sore', 'ok', { injury: DAY_TO_DAY });
    expect(standInFor(closer, [closer, sore])).toBeNull();
  });

  it('offers a healthy arm over a day-to-day one who is nearer', () => {
    const closer = arm('Closer', 'bad', { closer: true });
    const sore = arm('Sore', 'ok', { injury: DAY_TO_DAY });
    const healthy = arm('Healthy', 'ok');
    expect(standInFor(closer, [closer, sore, healthy])?.name).toBe('Healthy');
  });
});

describe('what comes back', () => {
  it('names the man, and says how he is doing in his own words', () => {
    const closer = arm('Closer', 'bad', { closer: true });
    const setup = arm('Setup', 'ok');
    const found = standInFor(closer, [closer, setup]);
    expect(found).toEqual({ player_id: setup.player_id, name: 'Setup', label: 'Setup is ok' });
  });

  it('leaves the pen as it found it', () => {
    // The order is the pecking order; choosing from it must not shuffle it
    const closer = arm('Closer', 'bad', { closer: true });
    const pen = [closer, arm('B', 'ok'), arm('A', 'ok')];
    const before = pen.map((p) => p.name);
    standInFor(closer, pen);
    expect(pen.map((p) => p.name)).toEqual(before);
  });
});

/*
 * Three clubs, built from game logs rather than from tones, so the colours are
 * the ones the page computes. The league's date is the 15th of May and the
 * last two games were on the 13th and the 14th: a man who threw on both is on
 * a third straight day (red), one who threw 22 pitches on the 14th only is on
 * back-to-back days (amber), and one who threw 20 on the 13th has rested.
 * Season lines are set so the order below the closer is the order of the
 * names: the lower the earned runs over the same fifty innings, the higher the
 * ERA+.
 */
const GAME_13TH = 7013;
const GAME_14TH = 7014;

/** Mixed: a red closer, a red and an amber arm, three who can go. */
const MIXED = 9301;
/** Nobody: every arm limited, out, or hurt. */
const NOBODY = 9302;
/** The closer is the only arm who can go. */
const ONLY_THE_CLOSER = 9303;

type Log = 'third-day' | 'yesterday' | 'rested' | 'out' | 'sore';

let nextId = 9400;
const roster: Record<string, number> = {};

beforeAll(() => {
  db.prepare(`UPDATE leagues SET "current_date" = '2028-5-15' WHERE league_id = ?`).run(IDS.league);

  const game = db.prepare(
    `INSERT INTO games (game_id, home_team, away_team, date, played, league_id, game_type)
     VALUES (?, ?, ?, ?, 1, ?, 0)`
  );
  game.run(GAME_13TH, IDS.mlbTeam, IDS.otherMlbTeam, '2028-5-13', IDS.league);
  game.run(GAME_14TH, IDS.mlbTeam, IDS.otherMlbTeam, '2028-5-14', IDS.league);

  const club = db.prepare(
    `INSERT INTO teams (team_id, name, nickname, abbr, level, league_id,
                        sub_league_id, division_id, parent_team_id, allstar_team)
     VALUES (?, ?, ?, ?, 1, ?, 0, 0, 0, 0)`
  );
  club.run(MIXED, 'Mixed', 'Pen', 'MIX', IDS.league);
  club.run(NOBODY, 'Nobody', 'Pen', 'NOB', IDS.league);
  club.run(ONLY_THE_CLOSER, 'Closer', 'Alone', 'CLA', IDS.league);

  const insert = db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Pen', ?, 28, 1, ?, 1, ?, ?, ?, ?, 0, 0, 0, 0)`
  );
  const standing = db.prepare(
    `INSERT INTO players_roster_status
       (player_id, is_active, is_on_dl, is_on_dl60, is_on_secondary,
        mlb_service_years, mlb_service_days, mlb_service_days_this_year)
     VALUES (?, ?, ?, ?, 0, 3.0, 516, 40)`
  );
  const threw = db.prepare(
    `INSERT INTO players_game_pitching_stats (player_id, game_id, pi, outs, gs) VALUES (?, ?, ?, 3, 0)`
  );
  const season = db.prepare(
    `INSERT INTO players_career_pitching_stats
       (player_id, year, team_id, league_id, level_id, split_id, outs, er, ra, ha, bb, k,
        hra, hp, bf, g, gs, w, l, s, hld, war)
     VALUES (?, ?, ?, ?, 1, 1, 150, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)`
  );

  /** One reliever on a club, with the games he worked and the season he has had. */
  const pitcher = (
    team: number, last: string, log: Log, earned: number, opts: { closer?: boolean; left?: boolean } = {}
  ) => {
    const id = nextId++;
    roster[last] = id;
    insert.run(id, last, opts.closer ? 13 : 12, opts.left ? 2 : 1, id % 100, team, team);
    standing.run(id, log === 'out' ? 0 : 1, log === 'out' ? 1 : 0, log === 'out' ? 1 : 0);
    if (log === 'out') {
      db.prepare(`UPDATE players SET injury_is_injured = 1, injury_left = 30 WHERE player_id = ?`).run(id);
    }
    if (log === 'sore') {
      db.prepare(`UPDATE players SET injury_dtd_injury = 1, injury_left = 2 WHERE player_id = ?`).run(id);
    }
    if (log === 'third-day') {
      threw.run(id, GAME_13TH, 10);
      threw.run(id, GAME_14TH, 12);
    }
    if (log === 'yesterday') threw.run(id, GAME_14TH, 22);
    if (log === 'rested' || log === 'sore') threw.run(id, GAME_13TH, 20);
    season.run(id, SEASON, team, IDS.league, earned);
  };

  // The order below the closer is the order they are written in: 5, 8, 10, 12, 15 earned runs
  pitcher(MIXED, 'MixClose', 'third-day', 9, { closer: true });
  pitcher(MIXED, 'MixSetup', 'rested', 5);
  pitcher(MIXED, 'MixLeft', 'rested', 8, { left: true });
  pitcher(MIXED, 'MixTired', 'yesterday', 10);
  pitcher(MIXED, 'MixLeftSpent', 'third-day', 12, { left: true });
  pitcher(MIXED, 'MixLong', 'rested', 15);

  pitcher(NOBODY, 'NobClose', 'third-day', 9, { closer: true });
  pitcher(NOBODY, 'NobTired', 'yesterday', 6);
  pitcher(NOBODY, 'NobSpent', 'third-day', 8);
  pitcher(NOBODY, 'NobSore', 'sore', 10);
  pitcher(NOBODY, 'NobHurt', 'out', 12);

  pitcher(ONLY_THE_CLOSER, 'AloneClose', 'rested', 9, { closer: true });
  pitcher(ONLY_THE_CLOSER, 'AloneTired', 'yesterday', 6);
  pitcher(ONLY_THE_CLOSER, 'AloneLeftSpent', 'third-day', 12, { left: true });
});

interface Row {
  player_id: number;
  name: string;
  status: string;
  tone: Tone;
  isCloser: boolean;
  instead: { player_id: number; name: string; label: string } | null;
}

const pen = async (team: number): Promise<Row[]> =>
  ((await request(`/api/pitching/${team}`)).bullpen as Row[]);

/** The row for a man by last name, with the order the table has him in. */
async function find(team: number, last: string): Promise<Row> {
  const row = (await pen(team)).find((p) => p.player_id === roster[last]);
  expect(row, `${last} never reached the bullpen table`).toBeDefined();
  return row!;
}
const insteadOf = async (team: number, last: string) => (await find(team, last)).instead?.name ?? null;

describe('the club with a red closer and arms who can go', () => {
  it('has the pen in the order the choice is made from', async () => {
    // Closer first, then by ERA+: the pecking order, and the table's own order
    expect((await pen(MIXED)).map((p) => p.name.replace('Pen ', ''))).toEqual([
      'MixClose', 'MixSetup', 'MixLeft', 'MixTired', 'MixLeftSpent', 'MixLong',
    ]);
  });

  it('has the colours the cases below need', async () => {
    const [close, tired, spent, setup] = await Promise.all(
      ['MixClose', 'MixTired', 'MixLeftSpent', 'MixSetup'].map((n) => find(MIXED, n))
    );
    expect(close.tone, close.status).toBe('bad');
    expect(close.status).toMatch(/third straight day/i);
    expect(tired.tone, tired.status).toBe('warn');
    expect(spent.tone, spent.status).toBe('bad');
    expect(setup.tone, setup.status).toBe('ok');
  });

  it('gives the red closer the best available setup man', async () => {
    expect(await insteadOf(MIXED, 'MixClose')).toBe('Pen MixSetup');
  });

  it('gives an amber man the next man down, of his own hand', async () => {
    // MixSetup is higher up and throws right too; MixLong is the next man down
    expect(await insteadOf(MIXED, 'MixTired')).toBe('Pen MixLong');
  });

  it('gives a red lefty the lefty, not the righty who is next down', async () => {
    // MixLong is the next man down and throws right; MixLeft is above him and throws left
    expect(await insteadOf(MIXED, 'MixLeftSpent')).toBe('Pen MixLeft');
  });

  it('says how the stand-in is doing, in the words the table uses for him', async () => {
    const closer = await find(MIXED, 'MixClose');
    const setup = await find(MIXED, 'MixSetup');
    expect(closer.instead).toEqual({
      player_id: setup.player_id,
      name: setup.name,
      label: setup.status,
    });
    expect(setup.status).toBe('Rested 2d');
  });

  it('gives nobody who is already green a stand-in', async () => {
    for (const last of ['MixSetup', 'MixLeft', 'MixLong']) {
      const row = await find(MIXED, last);
      expect(row.tone).toBe('ok');
      expect(row.instead, `${last} is available and was handed a stand-in`).toBeNull();
    }
  });

  it('never names a man who is not green', async () => {
    const rows = await pen(MIXED);
    const byId = new Map(rows.map((r) => [r.player_id, r]));
    for (const row of rows) {
      if (row.instead) expect(byId.get(row.instead.player_id)?.tone).toBe('ok');
    }
  });
});

describe('the club where nobody can go', () => {
  it('has a red closer, an amber man, a red one, a sore one and a hurt one', async () => {
    const tones = await Promise.all(
      ['NobClose', 'NobTired', 'NobSpent', 'NobSore', 'NobHurt'].map(async (n) => (await find(NOBODY, n)).tone)
    );
    expect(tones).toEqual(['bad', 'warn', 'bad', 'ok', 'bad']);
  });

  it('gives every limited arm null, which is what "nobody is available" is', async () => {
    for (const last of ['NobClose', 'NobTired', 'NobSpent', 'NobHurt']) {
      const row = await find(NOBODY, last);
      expect(row, last).toHaveProperty('instead', null);
    }
  });

  it('does not send the closer to a man who is day-to-day', async () => {
    // NobSore reads green — rested, and OOTP lets him pitch — and is hurt all the same
    const sore = await find(NOBODY, 'NobSore');
    expect(sore.tone).toBe('ok');
    expect(await insteadOf(NOBODY, 'NobClose')).toBeNull();
  });
});

describe('the club whose closer is the only arm who can go', () => {
  it('sends the amber man to him, there being nobody else', async () => {
    expect(await insteadOf(ONLY_THE_CLOSER, 'AloneTired')).toBe('Pen AloneClose');
  });

  it('sends a red man of the other hand to him too', async () => {
    expect(await insteadOf(ONLY_THE_CLOSER, 'AloneLeftSpent')).toBe('Pen AloneClose');
  });
});

