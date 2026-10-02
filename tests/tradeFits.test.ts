import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../server/db.js';
import { clearValuationCaches } from '../server/valuation.js';
import { clearTradeCache } from '../server/trade.js';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * Trade Fits: who needs what you have, and who has what you need.
 *
 * "Trade Fits ignores pitchers and offers your starting shortstop to fill your
 * shortstop hole." The page read "your weakest spots: SS, CF, 3B · your
 * tradable surplus: SS", and every club card offered Alex Freeland — who
 * starts at short on the Lineup page. The starter had been taken to be the
 * best-valued man listed there, which was Mookie Betts, on the bench; and a
 * sixteen-year-old signing parked on the club with no roster place was offered
 * beside him. No pitcher appeared anywhere, because pitchers were filtered out.
 *
 * A man is now offered only from the bench, never the one the Lineup page
 * plays; a spot that is a need is never also a surplus; and the rotation and
 * the bullpen are judged by role, on the arms who can pitch now.
 *
 * "Fifth starter below the median starter" then marked twenty-seven clubs of
 * thirty-two as short, because a fifth starter is meant to be below the median
 * one. A rotation is short now when it has fewer than five healthy starters or
 * its fifth is below the analyzer's replacement line; a bullpen when fewer
 * than four of its relievers are above the median reliever.
 */

/**
 * Sets the lines: forty everyday players at 1,000; sixty starters, half at 700
 * and half at 1,100, so the replacement line (the 25th percentile) is 700 and
 * the median starter 1,100; twenty relievers at 700, the median reliever.
 */
const POOL_CLUB = 60;
/** Freeland's case as the spec puts it: a middling shortstop starting, a weak one behind him. */
const SHORT_CLUB = 61;
/** The Dodgers' shape: the same, plus a better-valued shortstop the Lineup page sits. */
const DODGERS_CLUB = 62;
/** Seven starters better than the median one, and seven good relievers. */
const ARMS_CLUB = 63;
/** A fifth starter between the replacement line and the median, and four good relievers. */
const MIDDLING_CLUB = 64;
/** Six good starters, two of them on the injured list. */
const HURT_CLUB = 65;
/** A fifth starter below the replacement line, and three good relievers. */
const THIN_CLUB = 66;
const CLUBS = [POOL_CLUB, SHORT_CLUB, DODGERS_CLUB, ARMS_CLUB, MIDDLING_CLUB, HURT_CLUB, THIN_CLUB];

const FIELD = [2, 3, 4, 5, 7, 8, 9];

const SHORT = { freeland: 6109, backup: 6110 };
const DODGERS = { freeland: 6209, backup: 6210, betts: 6211, teenager: 6212 };
const STARTERS = Array.from({ length: 7 }, (_, i) => 6300 + i);
const RELIEVERS = Array.from({ length: 7 }, (_, i) => 6320 + i);

function addClub(id: number, name: string): void {
  db.prepare(
    `INSERT INTO teams (team_id, name, nickname, abbr, level, league_id, sub_league_id,
                        division_id, parent_team_id, allstar_team, human_team)
     VALUES (?, ?, 'Club', ?, 1, ?, 0, 0, 0, 0, 0)`
  ).run(id, name, name.slice(0, 3).toUpperCase(), IDS.league);
}

/**
 * One man. `off` is his bat against right-handers and `glove` his rating at
 * his own position — the two things the Lineup page decides a job on.
 * `injured` puts him on the injured list: still on the roster, not active.
 */
function addPlayer(
  id: number,
  opts: {
    team: number; position: number; value: number; off?: number; glove?: number;
    role?: number; age?: number; rostered?: boolean; injured?: boolean;
  }
): void {
  db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Fit', ?, ?, ?, ?, 1, 1, 0, ?, ?, 0, 0, 0, 0)`
  ).run(id, `Man${id}`, opts.age ?? 27, opts.position, opts.role ?? 0, opts.team, opts.team);
  const off = opts.off ?? 100;
  db.prepare(
    `INSERT INTO players_value
       (player_id, overall_value, talent_value, offensive_value, offensive_value_vsl,
        offensive_value_vsr, pitching_value, oa_rating, pot_rating, oa, pot)
     VALUES (?, ?, ?, ?, ?, ?, 0, 50, 50, 50, 50)`
  ).run(id, opts.value, opts.value, off, off, off);
  if (opts.glove && opts.position >= 2 && opts.position <= 9) {
    db.prepare(
      `INSERT INTO players_fielding (player_id, position, fielding_rating_pos${opts.position})
       VALUES (?, ?, ?)`
    ).run(id, opts.position, opts.glove);
  }
  if (opts.rostered !== false) {
    const hurt = opts.injured ? 1 : 0;
    db.prepare(
      `INSERT INTO players_roster_status
         (player_id, is_active, is_on_dl, is_on_dl60, is_on_secondary,
          mlb_service_years, mlb_service_days, mlb_service_days_this_year)
       VALUES (?, ?, ?, 0, 1, 3.0, ?, 40)`
    ).run(id, 1 - hurt, hurt, 3 * 172);
  }
  if (opts.injured) {
    db.prepare(`UPDATE players SET injury_is_injured = 1, injury_left = 30 WHERE player_id = ?`).run(id);
  }
}

/**
 * A lineup good everywhere but short: seven regulars at 1,300 with real bats
 * and gloves, and a designated hitter who can only hit. Freeland's glove wins
 * him short over anybody else who could stand there.
 */
function addShortstopClub(team: number, ids: { freeland: number; backup: number }, base: number): void {
  FIELD.forEach((position, i) =>
    addPlayer(base + i, { team, position, value: 1300, off: 1100, glove: 60 })
  );
  addPlayer(base + 7, { team, position: 10, value: 1250, off: 1200 });
  addPlayer(ids.freeland, { team, position: 6, value: 1150, off: 900, glove: 60 });
  addPlayer(ids.backup, { team, position: 6, value: 700, off: 500, glove: 50 });
}

type Fits = {
  myWeakest: Array<{ positionName: string; bestValue: number }>;
  mySurplus: Array<{ positionName: string; players: Array<{ player_id: number }> }>;
  fits: Array<{
    orgId: number;
    theyNeed: Array<{ positionName: string; myCandidates: Array<{ player_id: number }> }>;
    theyOffer: Array<{ positionName: string; players: Array<{ player_id: number }> }>;
  }>;
};

const fitsFor = (club: number): Promise<Fits> => request(`/api/trade/fits/${club}`);

/** Everyone the page would put forward from this club, on its own screen or anybody else's. */
async function offeredFrom(club: number): Promise<number[]> {
  const mine = await fitsFor(club);
  const ids = mine.mySurplus.flatMap((s) => s.players.map((p) => p.player_id));
  ids.push(...mine.fits.flatMap((f) => f.theyNeed.flatMap((n) => n.myCandidates.map((p) => p.player_id))));
  for (const other of CLUBS.filter((c) => c !== club)) {
    const theirs = await fitsFor(other);
    for (const f of theirs.fits.filter((x) => x.orgId === club)) {
      ids.push(...f.theyOffer.flatMap((o) => o.players.map((p) => p.player_id)));
    }
  }
  return ids;
}

beforeAll(() => {
  addClub(POOL_CLUB, 'Pool');
  for (let i = 0; i < 40; i++) {
    addPlayer(6000 + i, { team: POOL_CLUB, position: 2 + (i % 8), value: 1000, off: 800, glove: 50 });
  }
  for (let i = 0; i < 60; i++) {
    addPlayer(6400 + i, { team: POOL_CLUB, position: 1, role: 11, value: i < 30 ? 700 : 1100 });
  }
  for (let i = 0; i < 20; i++) addPlayer(6070 + i, { team: POOL_CLUB, position: 1, role: 12, value: 700 });

  addClub(SHORT_CLUB, 'Short');
  addShortstopClub(SHORT_CLUB, SHORT, 6100);

  addClub(DODGERS_CLUB, 'Dodge');
  addShortstopClub(DODGERS_CLUB, DODGERS, 6200);
  // Worth more than Freeland and listed at short, with a glove the Lineup page
  // will not play there and a bat that cannot take the DH's place
  addPlayer(DODGERS.betts, { team: DODGERS_CLUB, position: 6, value: 1165, off: 1000, glove: 45 });
  // Sixteen, signed, and on no roster at all
  addPlayer(DODGERS.teenager, { team: DODGERS_CLUB, position: 6, value: 355, age: 16, rostered: false });

  addClub(ARMS_CLUB, 'Arms');
  STARTERS.forEach((id, i) => addPlayer(id, { team: ARMS_CLUB, position: 1, role: 11, value: 1300 - 10 * i }));
  RELIEVERS.forEach((id, i) => addPlayer(id, { team: ARMS_CLUB, position: 1, role: 12, value: 960 - 10 * i }));

  addClub(MIDDLING_CLUB, 'Middling');
  [1250, 1240, 1230, 1220, 900].forEach((value, i) =>
    addPlayer(6500 + i, { team: MIDDLING_CLUB, position: 1, role: 11, value })
  );
  for (let i = 0; i < 4; i++) addPlayer(6510 + i, { team: MIDDLING_CLUB, position: 1, role: 12, value: 800 });

  addClub(HURT_CLUB, 'Hurt');
  for (let i = 0; i < 6; i++) {
    addPlayer(6520 + i, { team: HURT_CLUB, position: 1, role: 11, value: 1300, injured: i < 2 });
  }

  addClub(THIN_CLUB, 'Thin');
  [1250, 1240, 1230, 1220, 600].forEach((value, i) =>
    addPlayer(6530 + i, { team: THIN_CLUB, position: 1, role: 11, value })
  );
  [800, 800, 800, 650, 650].forEach((value, i) =>
    addPlayer(6540 + i, { team: THIN_CLUB, position: 1, role: 12, value })
  );

  clearValuationCaches();
  clearTradeCache();
});

describe('a shortstop who starts', () => {
  it('makes short a need when the man behind him is weak, not a surplus', async () => {
    const r = await fitsFor(SHORT_CLUB);
    expect(r.myWeakest.map((w) => w.positionName)).toContain('SS');
    expect(r.mySurplus.map((s) => s.positionName)).not.toContain('SS');
  });

  it('is never offered, here or on anybody else\'s card', async () => {
    expect(await offeredFrom(SHORT_CLUB)).not.toContain(SHORT.freeland);
  });

  it('is never offered even when a better-valued shortstop sits behind him', async () => {
    /*
     * The case as it reached the page. Ranked by value, Betts is the
     * shortstop and Freeland the spare; the Lineup page plays Freeland. The
     * club's need at short is real either way, so short is not its surplus,
     * and neither man is put forward to fill somebody else's hole.
     */
    const r = await fitsFor(DODGERS_CLUB);
    expect(r.myWeakest.map((w) => w.positionName)).toContain('SS');
    expect(r.mySurplus.map((s) => s.positionName)).not.toContain('SS');
    const offered = await offeredFrom(DODGERS_CLUB);
    expect(offered).not.toContain(DODGERS.freeland);
    expect(offered).not.toContain(DODGERS.betts);
  });

  it('takes the shortstop to be the man the Lineup page plays there', async () => {
    // The two pages disagreeing about who plays short was the bug, so the
    // check is against the Lineup page itself rather than a copy of its rule
    const card = await request(`/api/lineup/${DODGERS_CLUB}`);
    const atShort = card.lineup.find((s: { positionName: string }) => s.positionName === 'SS');
    expect(atShort.player_id).toBe(DODGERS.freeland);
    const r = await fitsFor(DODGERS_CLUB);
    expect(r.myWeakest.find((w) => w.positionName === 'SS')?.bestValue).toBe(1150);
  });

  it('does not offer a teenager who is on no roster', async () => {
    expect(await offeredFrom(DODGERS_CLUB)).not.toContain(DODGERS.teenager);
  });
});

describe('pitching', () => {
  it('offers a starter when the club has seven better than the median', async () => {
    const r = await fitsFor(ARMS_CLUB);
    const sp = r.mySurplus.find((s) => s.positionName === 'SP');
    expect(sp).toBeDefined();
    // The sixth and seventh men: the rotation itself is never put forward
    expect(sp!.players.map((p) => p.player_id)).toEqual([STARTERS[5], STARTERS[6]]);
  });

  it('never offers one of the five who make the rotation', async () => {
    const offered = await offeredFrom(ARMS_CLUB);
    for (const id of STARTERS.slice(0, 5)) expect(offered).not.toContain(id);
  });

  it('marks a club with no rotation to speak of as needing starters', async () => {
    const r = await fitsFor(SHORT_CLUB);
    expect(r.myWeakest.map((w) => w.positionName)).toContain('SP');
  });

  it('matches the spare starter to a club that needs one', async () => {
    const r = await fitsFor(ARMS_CLUB);
    const match = r.fits.find((f) => f.orgId === SHORT_CLUB);
    const need = match?.theyNeed.find((n) => n.positionName === 'SP');
    expect(need?.myCandidates.map((p) => p.player_id)).toContain(STARTERS[5]);
  });

  it('offers the good relievers beyond the best five, and a thin bullpen needs them', async () => {
    const arms = await fitsFor(ARMS_CLUB);
    const rp = arms.mySurplus.find((s) => s.positionName === 'RP');
    expect(rp?.players.map((p) => p.player_id)).toEqual([RELIEVERS[5], RELIEVERS[6]]);
    const short = await fitsFor(SHORT_CLUB);
    expect(short.myWeakest.map((w) => w.positionName)).toContain('RP');
  });
});

describe('how short a staff has to be', () => {
  const needs = async (club: number) => (await fitsFor(club)).myWeakest.map((w) => w.positionName);

  it('does not call a rotation short because its fifth starter is below the median one', async () => {
    // 900: under the median starter, as most fifth starters are, and well clear
    // of the worst tenth. On the real save the median club's fifth starter sat
    // under the replacement line, so measuring against replacement called 21 of
    // 32 rotations short; the bar is the worst tenth of rostered starters.
    expect(await needs(MIDDLING_CLUB)).not.toContain('SP');
  });

  it('calls a rotation short when its fifth starter is among the worst tenth of starters', async () => {
    expect(await needs(THIN_CLUB)).toContain('SP');
  });

  it('counts only the starters who can pitch', async () => {
    // Six good starters, two of them hurt: four is not a rotation
    const r = await fitsFor(HURT_CLUB);
    const sp = r.myWeakest.find((w) => w.positionName === 'SP');
    expect(sp?.detail).toBe('4 healthy starters');
    // ...and the two who are hurt are not why it has none to spare
    expect(r.mySurplus.map((s) => s.positionName)).not.toContain('SP');
  });

  it('calls a bullpen short at three relievers above the median, not at four', async () => {
    expect(await needs(THIN_CLUB)).toContain('RP');
    expect(await needs(MIDDLING_CLUB)).not.toContain('RP');
  });
});
