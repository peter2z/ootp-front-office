import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import { gloves, glovesLine } from '../server/gloves.js';

/**
 * What a man can play, and how well.
 *
 * This exists because the trade desk was asked whether a second baseman could
 * be moved to shortstop and answered that it had no fielding ratings in front
 * of it. It was right not to guess. The ratings were in the save the whole
 * time; nothing was reading them.
 *
 * The rule that shapes the code is OOTP's own. The game prints a number at a
 * position it has revealed and a dash everywhere else, and a current rating
 * above zero is exactly that flag. Trent Grisham's card in the game shows 60
 * in center and a dash at all eight others, while his row here holds a 75
 * ceiling in left, a 65 in right and a 70 as a pitcher — and right field is
 * the case that settles it, because he has two hundred experience there and
 * the game still prints a dash. Having played somewhere does not reveal it.
 *
 * So the app shows what the game shows. Printing a withheld ceiling would hand
 * over a scouting report that has not been earned, in an app whose purpose is
 * to read the save rather than to play it for you.
 */

const STOTT = 90_001;   // a second baseman with a shortstop's ceiling
const CATCHER = 90_002;
const PITCHER = 90_003;
const SHORTSTOP = 90_004; // plays short and third, with far more games at short

const insert = (row: Record<string, number>): void => {
  const keys = Object.keys(row);
  db.prepare(
    `INSERT INTO players_fielding (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})`
  ).run(row);
};

beforeAll(() => {
  // 60 at second, 35 at short with a 55 ceiling — the real shape of the case
  insert({
    player_id: STOTT, position: 4,
    fielding_rating_pos4: 60, fielding_rating_pos4_pot: 60,
    fielding_rating_pos6: 35, fielding_rating_pos6_pot: 55,
    fielding_rating_pos5: 0, fielding_rating_pos5_pot: 60, fielding_experience4: 200,
    fielding_rating_pos1: 0, fielding_rating_pos1_pot: 80,
    fielding_ratings_infield_range: 60, fielding_ratings_infield_arm: 60,
    fielding_ratings_turn_doubleplay: 60, fielding_ratings_infield_error: 65,
    fielding_ratings_catcher_framing: 20,
  });
  // OOTP's experience counters are indexed by position number: a catcher's
  // games live in fielding_experience2, and the 3 in _experience1 is a decoy
  // the old zero-based read would have picked up instead
  insert({
    player_id: CATCHER, position: 2,
    fielding_rating_pos2: 65, fielding_rating_pos2_pot: 65,
    fielding_experience2: 149, fielding_experience1: 3,
    fielding_ratings_catcher_arm: 55, fielding_ratings_catcher_framing: 70,
  });
  // The shape from the design's worked example: 170 games at short in
  // _experience6, 29 at third in _experience5
  insert({
    player_id: SHORTSTOP, position: 6,
    fielding_rating_pos6: 50, fielding_rating_pos6_pot: 55,
    fielding_rating_pos5: 55, fielding_rating_pos5_pot: 65,
    fielding_experience6: 170, fielding_experience5: 29,
    fielding_ratings_infield_range: 55, fielding_ratings_infield_arm: 60,
  });
  insert({
    player_id: PITCHER, position: 1,
    fielding_rating_pos1: 70, fielding_rating_pos1_pot: 70,
    fielding_ratings_catcher_framing: 20,
  });
});

describe('a second baseman asked about shortstop', () => {
  it('reports both, current and ceiling', () => {
    const line = glovesLine(STOTT)!;
    expect(line).toContain('60 at 2B');
    expect(line).toContain('35 at SS (ceiling 55)');
  });

  it('says nothing about a position the game has not revealed', () => {
    // 3B carries a 60 ceiling and 200 experience, and OOTP still prints a dash
    const g = gloves(STOTT)!;
    expect(g.positions.some((p) => p.code === '3B')).toBe(false);
    expect(glovesLine(STOTT)).not.toContain('3B');
  });

  it('never calls a position player a pitcher', () => {
    // The 80 he carries there is a default, and unrevealed besides
    const g = gloves(STOTT)!;
    expect(g.positions.some((p) => p.code === 'P')).toBe(false);
    expect(glovesLine(STOTT)).not.toContain('at P');
  });

  it('leaks no withheld ceiling into the line at all', () => {
    // The ceilings behind the dashes: 60 at third, 80 as a pitcher
    const line = glovesLine(STOTT)!;
    expect(line).not.toContain('80');
    expect(line).not.toContain('unrated');
  });

  it('leads with the position he is listed at', () => {
    expect(gloves(STOTT)!.positions[0]).toMatchObject({ code: '2B', isPrimary: true });
  });

  it('carries the infield components and not the catcher ones', () => {
    const c = gloves(STOTT)!.components;
    expect(c.infieldRange).toBe(60);
    expect(c.infieldTurnDoublePlay).toBe(60);
    expect(c).not.toHaveProperty('catcherFraming');
  });
});

describe('experience is read from the position’s own column', () => {
  it('gives a shortstop his games at short, not the third baseman’s count', () => {
    // fielding_experience6 holds his 170 at short; _experience5 holds 29 at third
    const g = gloves(SHORTSTOP)!;
    expect(g.positions.find((p) => p.code === 'SS')!.experience).toBe(170);
    expect(g.positions.find((p) => p.code === '3B')!.experience).toBe(29);
  });

  it('gives a catcher his games behind the plate from fielding_experience2', () => {
    expect(gloves(CATCHER)!.positions.find((p) => p.code === 'C')!.experience).toBe(149);
  });

  it('gives a second baseman his games at second from fielding_experience4', () => {
    expect(gloves(STOTT)!.positions.find((p) => p.code === '2B')!.experience).toBe(200);
  });
});

describe('the other shapes', () => {
  it('gives a catcher his framing', () => {
    expect(gloves(CATCHER)!.components.catcherFraming).toBe(70);
  });

  it('keeps the pitcher slot for an actual pitcher', () => {
    expect(glovesLine(PITCHER)).toContain('70 at P');
  });

  it('does not hand a pitcher a catcher’s framing', () => {
    expect(gloves(PITCHER)!.components).not.toHaveProperty('catcherFraming');
  });

  it('says nothing at all about a man with no fielding row', () => {
    expect(gloves(99_999_999)).toBeNull();
    expect(glovesLine(99_999_999)).toBeNull();
  });
});
