import { Router } from 'express';
import { db, tableColumns, tableExists } from './db.js';
import {
  LEVEL_NAMES, ON_ROSTER, ROLE_STARTER, contractsByPlayer, leagueRules, mlbPercentiler, usesDH,
  valuesByPlayer, type PlayerValue,
} from './valuation.js';
import { controlAfterThisSeason, serviceRemainingThisSeason } from './contracts.js';
import { padDate } from './rosterops.js';
import { contactProfiles } from './battedball.js';
import { POSITION_CODES, glovesLine } from './gloves.js';
import { computeBatting, computePitching, leagueBaseline } from './stats.js';
import { blockedIds } from './tradingblock.js';
import { chooseFielders, type Candidate } from './lineup.js';
import { countsAsBatterSql } from './twoway.js';
import { healthOf, type HealthFields } from './health.js';

export const tradeRoutes = Router();

const POSITION_NAMES: Record<number, string> = {
  1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF', 10: 'DH',
};
/**
 * A pitcher as SP or RP rather than P, the way Trade Fits names him: a deal is
 * judged against his own group's pool, so which group he is in is worth seeing.
 */
const positionLabel = (position: number, role: number | null): string =>
  position === 1 ? (role === ROLE_STARTER ? 'SP' : 'RP') : (POSITION_NAMES[position] ?? '?');
const FIELD_SPOTS = [2, 3, 4, 5, 6, 7, 8, 9];
/** Hardest position first, the order the Lineup page fills them in. */
const LINEUP_ORDER = [2, 6, 8, 5, 4, 9, 7, 3];
const DH_POS = 10;
const teamLabel = `CASE WHEN t.name = t.nickname THEN t.name ELSE t.name || ' ' || t.nickname END`;

/**
 * Which pool a man is measured against: the same three valuation.ts ranks
 * percentiles in. OOTP's overall_value is value to the club with playing time
 * baked in, so a closer can never total what an everyday player does however
 * good he is. Measured against everybody at once relievers sink, and anything
 * built on a raw sum inherits that.
 */
type Group = 'pos' | 'sp' | 'rp';
const groupOf = (position: number, role: number | null): Group =>
  position !== 1 ? 'pos' : role === ROLE_STARTER ? 'sp' : 'rp';

/**
 * Replacement level: what a club can get for nothing, read as the 25th
 * percentile of the major leaguers in his group.
 *
 * The usual reading puts it somewhere between the 20th and the 30th. The
 * bottom fifth to third of a major-league roster is the bench bat, the mop-up
 * arm and the up-and-down man that any club can find on waivers or at
 * Triple-A, and the middle of that range keeps the answer from turning on the
 * choice. On the save this was built against it is 1,007 for position players,
 * 1,119 for starters and 706 for relievers: a 34th-percentile shortstop clears
 * it by a little, and a teenager parked on the roster not at all.
 */
const REPLACEMENT_PCT = 25;
/** Under this share of the bigger side's surplus, a gap is noise rather than a verdict. */
const EVEN_SHARE = 0.1;
/** How far below the other side's best man a side's best can sit before depth is all it offers. */
const QUALITY_GAP = 15;
/** A bullpen with fewer relievers than this above the median one is short. */
const PEN_SHORT = 4;
/**
 * A rotation has a hole when its fifth man sits this low among every rostered
 * starter in the majors. The replacement line (the 25th percentile) is not the
 * bar: on the save this was calibrated against it sat above the median club's
 * fifth starter, so 21 of 32 clubs "needed" a starter and every fit card said
 * the same thing. The worst tenth marks 7 clubs there, which is what a scout
 * would call a hole rather than a weakness.
 */
const ROTATION_HOLE_PCT = 10;
/** The late-inning core a club keeps; good arms beyond it are the ones it can spare. */
const PEN_CORE = 5;
/** A rotation is five; the sixth and seventh men are depth. */
const ROTATION = 5;

interface FitPlayer { player_id: number; name: string; value: number; age: number; positionName: string }

interface OrgProfile {
  orgId: number;
  label: string;
  /**
   * The jobs held most weakly: the three field positions whose starters are
   * worth least, plus the rotation or the bullpen when either is short.
   * `bestValue` is what a newcomer has to beat to help — the starter, the
   * fifth starter, or the third-best reliever.
   */
  weakest: Array<{ position: number; positionName: string; bestValue: number; detail?: string }>;
  /** Men a club can spare: good backups and spare arms, never the man holding the job. */
  surplus: Array<{ position: number; positionName: string; players: FitPlayer[] }>;
}

let poolCache: Record<Group, number[]> | null = null;

/**
 * Every major leaguer's value, sorted, in the three groups percentiles use.
 *
 * Roster membership rather than the club's id, for the reason valuation.ts
 * gives: OOTP parks unassigned teenage signings on the parent club, and a
 * yardstick partly made of them reads long. The median the depth rule used
 * to be measured against was taken across every man carrying a major-league
 * club's id, pitchers and teenagers included, and came out at 849 on the save
 * this was built against — below the tenth percentile of real major-league
 * position players. Against that, two weak men at a position looked like depth.
 */
function mlbPools(values: Map<number, PlayerValue>): Record<Group, number[]> {
  if (poolCache) return poolCache;
  const pools: Record<Group, number[]> = { pos: [], sp: [], rp: [] };
  if (tableExists('players_roster_status')) {
    const rows = db
      .prepare(
        `SELECT p.player_id, p.position, p.role FROM players p
         JOIN teams t ON t.team_id = p.team_id
         JOIN players_roster_status rs ON rs.player_id = p.player_id
         WHERE t.level = 1 AND t.allstar_team = 0 AND p.retired = 0 AND ${ON_ROSTER}`
      )
      .all() as Array<{ player_id: number; position: number; role: number }>;
    for (const r of rows) {
      const v = values.get(r.player_id);
      if (v) pools[groupOf(r.position, r.role)].push(v.overall);
    }
  }
  for (const g of ['pos', 'sp', 'rp'] as const) pools[g].sort((a, b) => a - b);
  poolCache = pools;
  return pools;
}

/** The value at a percentile of a sorted pool; nothing at all for an empty one. */
const valueAt = (sorted: number[], pct: number): number =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((pct / 100) * sorted.length))] : 0;

/**
 * Forgets the pools, and with them every median and replacement level. Called
 * after an import: they were measured on the league that has just been
 * replaced, and a different save has different players.
 */
export function clearTradeCache(): void {
  poolCache = null;
}

/**
 * Who holds each job on the field, decided the way the Lineup page decides it.
 *
 * Fits used to call the best-valued man at a position its starter, which is
 * not who plays there. Mookie Betts is the Dodgers' highest-valued shortstop
 * and the Lineup page sits him for Alex Freeland's glove, so Freeland read as
 * the backup and was offered round the league to fill the club's own weakest
 * spot. Asking the same optimiser the Lineup page uses keeps the two pages
 * from disagreeing about who plays.
 *
 * Two deliberate differences from tonight's card. A man on the injured list
 * still holds his job: a trade is about the season, and leaving him out would
 * make his backup the starter and the regular himself a spare. And it reads
 * the card against right-handers, which is most of the season's plate
 * appearances.
 */
function fieldJobs(teamId: number, values: Map<number, PlayerValue>):
  { starters: Map<number, Candidate>; bench: Candidate[] } {
  const rows = db
    .prepare(
      `SELECT p.player_id, p.first_name || ' ' || p.last_name AS name, p.age, p.position,
              f.fielding_rating_pos2 AS d2, f.fielding_rating_pos3 AS d3,
              f.fielding_rating_pos4 AS d4, f.fielding_rating_pos5 AS d5,
              f.fielding_rating_pos6 AS d6, f.fielding_rating_pos7 AS d7,
              f.fielding_rating_pos8 AS d8, f.fielding_rating_pos9 AS d9
       FROM players p
       LEFT JOIN players_fielding f ON f.player_id = p.player_id
       LEFT JOIN players_roster_status rs ON rs.player_id = p.player_id
       WHERE p.team_id = ? AND p.retired = 0 AND ${countsAsBatterSql()} AND ${ON_ROSTER}`
    )
    .all(teamId) as Array<Record<string, number | string | null>>;
  const candidates: Candidate[] = rows
    .map((p) => {
      const id = p.player_id as number;
      const v = values.get(id);
      const d = (k: string) => (p[k] as number | null) ?? 0;
      return {
        player_id: id,
        name: p.name as string,
        age: p.age as number,
        position: p.position as number,
        positionName: POSITION_NAMES[p.position as number] ?? '?',
        bats: 0,
        dayToDay: false,
        off: v?.offenseVsR ?? v?.offense ?? 0,
        rank: 0,
        contact: 0,
        power: 0,
        eye: 0,
        speed: 0,
        defense: {
          2: d('d2'), 3: d('d3'), 4: d('d4'), 5: d('d5'),
          6: d('d6'), 7: d('d7'), 8: d('d8'), 9: d('d9'),
          // Anyone can DH and nobody fields it, as on the Lineup page
          [DH_POS]: 50,
        },
      };
    })
    // A tie for a job goes to the man worth more, rather than to row order
    .sort((a, b) => (values.get(b.player_id)?.overall ?? 0) - (values.get(a.player_id)?.overall ?? 0));
  const starters = chooseFielders(candidates, usesDH(teamId) ? [...LINEUP_ORDER, DH_POS] : LINEUP_ORDER);
  const playing = new Set([...starters.values()].map((c) => c.player_id));
  return { starters, bench: candidates.filter((c) => !playing.has(c.player_id)) };
}

/**
 * Positional strength/surplus for one org's MLB club. Surplus requires a
 * quality backup (within 85% of the starter AND above the MLB median) —
 * two equally weak players at a spot is a hole, not depth.
 *
 * The man offered is always the backup. The starter is whoever the Lineup
 * page plays there, and nobody it plays anywhere — the designated hitter
 * included — is ever offered. A spot that is one of the club's needs is not
 * also its surplus: "your weakest spot is shortstop; you could spare a
 * shortstop" is the sentence this used to produce.
 *
 * Pitchers are judged by role, on the arms who can pitch now. A rotation is
 * short when it has fewer than five healthy starters, or when its fifth is
 * below the replacement line the analyzer prices deals on — the 25th
 * percentile of major-league starters. It used to be the median starter, which
 * a fifth starter is meant to be below, and twenty-seven clubs of thirty-two
 * came out short of one. It has a man to spare when its sixth-best is above
 * the median. A bullpen is short when fewer than four of its relievers are
 * above the median reliever, and can spare the good arms beyond its best five.
 */
function orgProfile(orgId: number, values: Map<number, PlayerValue>): OrgProfile | null {
  const team = db.prepare(`SELECT ${teamLabel} AS label FROM teams t WHERE team_id = ?`).get(orgId) as
    | { label: string }
    | undefined;
  if (!team) return null;
  const pools = mlbPools(values);
  const valueOf = (id: number) => values.get(id)?.overall ?? 0;
  const fit = (p: { player_id: number; name: string; age: number }, positionName: string): FitPlayer => ({
    player_id: p.player_id, name: p.name, value: valueOf(p.player_id), age: p.age, positionName,
  });

  // ── The field ──
  const { starters, bench } = fieldJobs(orgId, values);
  const strength = FIELD_SPOTS.map((pos) => {
    const holder = starters.get(pos);
    return { position: pos, positionName: POSITION_NAMES[pos], best: holder ? valueOf(holder.player_id) : 0 };
  });
  const fieldNeeds = [...strength].sort((a, b) => a.best - b.best).slice(0, 3);
  const needed = new Set(fieldNeeds.map((s) => s.position));
  const posMedian = valueAt(pools.pos, 50);
  const fieldSurplus = strength
    .filter((s) => s.best > 0 && !needed.has(s.position))
    .map((s) => {
      const bar = Math.max(s.best * 0.85, posMedian);
      return {
        position: s.position,
        positionName: s.positionName,
        players: bench
          .filter((c) => c.position === s.position)
          .map((c) => fit(c, s.positionName))
          .filter((p) => p.value >= bar)
          .sort((a, b) => b.value - a.value)
          .slice(0, 2),
      };
    })
    .filter((s) => s.players.length > 0);

  // ── The staff ──
  const arms = (
    db
      .prepare(
        `SELECT p.player_id, p.first_name || ' ' || p.last_name AS name, p.age, p.role,
                p.injury_is_injured, p.injury_dtd_injury, p.injury_left,
                rs.is_on_dl, rs.is_on_dl60, rs.is_active
         FROM players p
         LEFT JOIN players_roster_status rs ON rs.player_id = p.player_id
         WHERE p.team_id = ? AND p.retired = 0 AND p.position = 1 AND ${ON_ROSTER}`
      )
      .all(orgId) as Array<HealthFields & { player_id: number; name: string; age: number; role: number }>
  )
    // A starter on the injured list is no help to a rotation that is short
    // now, and is not the man to offer either. Day-to-day arms still pitch,
    // by the judgement the Pitching page uses.
    .filter((p) => healthOf(p)?.playable !== false)
    .map((p) => ({ player_id: p.player_id, name: p.name, age: p.age, role: p.role, value: valueOf(p.player_id) }))
    .sort((a, b) => b.value - a.value);
  const rotation = arms.filter((a) => a.role === ROLE_STARTER);
  const pen = arms.filter((a) => a.role !== ROLE_STARTER);
  const spHole = valueAt(pools.sp, ROTATION_HOLE_PCT);
  const spMedian = valueAt(pools.sp, 50);
  const rpMedian = valueAt(pools.rp, 50);
  const fifth = rotation[ROTATION - 1]?.value ?? 0;
  const goodRelievers = pen.filter((a) => a.value > rpMedian);

  const weakest: OrgProfile['weakest'] = fieldNeeds.map((s) => ({
    position: s.position, positionName: s.positionName, bestValue: s.best,
  }));
  if (rotation.length < ROTATION || fifth < spHole) {
    weakest.push({
      position: 1, positionName: 'SP', bestValue: fifth,
      detail: rotation.length < ROTATION
        ? `${rotation.length} healthy starters`
        : 'fifth starter among the worst tenth of big-league starters',
    });
  }
  if (goodRelievers.length < PEN_SHORT) {
    weakest.push({
      position: 1, positionName: 'RP', bestValue: pen[PEN_SHORT - 1]?.value ?? 0,
      detail: `${goodRelievers.length} relievers above the median reliever`,
    });
  }

  const surplus: OrgProfile['surplus'] = [...fieldSurplus];
  const spareStarters = rotation.slice(ROTATION).filter((a) => a.value >= spMedian).slice(0, 2);
  if (spareStarters.length > 0) {
    surplus.push({ position: 1, positionName: 'SP', players: spareStarters.map((a) => fit(a, 'SP')) });
  }
  const spareRelievers = goodRelievers.slice(PEN_CORE, PEN_CORE + 2);
  if (spareRelievers.length > 0) {
    surplus.push({ position: 1, positionName: 'RP', players: spareRelievers.map((a) => fit(a, 'RP')) });
  }
  return { orgId, label: team.label, weakest, surplus };
}

tradeRoutes.get('/trade/fits/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  // Jobs are read off the rosters, as the Lineup page reads them
  if (!tableExists('players_value') || !tableExists('players_roster_status')) {
    return res.status(400).json({ error: 'No data imported yet' });
  }
  const values = valuesByPlayer();
  const mine = orgProfile(orgId, values);
  if (!mine) return res.status(404).json({ error: 'Unknown org' });

  const otherOrgs = (
    db
      .prepare(
        `SELECT team_id FROM teams WHERE level = 1 AND allstar_team = 0 AND team_id != ?`
      )
      .all(orgId) as Array<{ team_id: number }>
  ).map((r) => r.team_id);

  const fits = otherOrgs
    .map((id) => orgProfile(id, values))
    .filter((p): p is OrgProfile => p !== null)
    .map((theirs) => {
      // They're weak where I have surplus; they have surplus where I'm weak.
      // Keyed on the job's name, since a starter and a reliever share position 1.
      // A man counts only if he would beat whoever holds the job now: a spare
      // shortstop worse than yours fills nothing.
      let gain = 0;
      const theyNeed = theirs.weakest.flatMap((w) => {
        const spare = mine.surplus.find((s) => s.positionName === w.positionName)?.players ?? [];
        const better = spare.filter((p) => p.value > w.bestValue);
        if (better.length === 0) return [];
        gain += better[0].value - w.bestValue;
        return [{ positionName: w.positionName, myCandidates: better }];
      });
      const theyOffer = theirs.surplus.flatMap((s) => {
        const need = mine.weakest.find((w) => w.positionName === s.positionName);
        const better = need ? s.players.filter((p) => p.value > need.bestValue) : [];
        if (!need || better.length === 0) return [];
        gain += better[0].value - need.bestValue;
        return [{ positionName: s.positionName, players: better }];
      });
      const fit = {
        orgId: theirs.orgId,
        label: theirs.label,
        score: theyNeed.length + theyOffer.length,
        theyNeed,
        theyOffer,
      };
      return { fit, gain };
    })
    .filter(({ fit }) => fit.score > 0)
    // Most matches first. Most clubs' fifth starter is below the median one,
    // so a spare starter matches nearly everybody, and among equal matches the
    // clubs the swap would improve most are the ones worth a call
    .sort((a, b) => b.fit.score - a.fit.score || b.gain - a.gain)
    .map(({ fit }) => fit);

  res.json({ myWeakest: mine.weakest, mySurplus: mine.surplus, fits: fits.slice(0, 10) });
});

tradeRoutes.get('/search-players', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2 || !tableExists('players')) return res.json([]);
  const rows = db
    .prepare(
      `SELECT p.player_id, p.first_name || ' ' || p.last_name AS name, p.age, p.position, p.role,
              ${teamLabel} AS team, t.level
       FROM players p LEFT JOIN teams t ON t.team_id = p.team_id
       WHERE p.retired = 0 AND p.team_id > 0
         AND (p.first_name || ' ' || p.last_name) LIKE ?
       ORDER BY t.level, p.age LIMIT 20`
    )
    .all(`%${q}%`) as Array<Record<string, unknown>>;
  const values = valuesByPlayer();
  res.json(
    rows.map((r) => ({
      ...r,
      positionName: positionLabel(r.position as number, r.role as number | null),
      value: values.get(r.player_id as number)?.overall ?? 0,
    }))
  );
});


/**
 * The trade talk sitting in your OOTP inbox.
 *
 * Trade traffic reaches a manager as messages, and the export carries the
 * structured part of them: who wrote, which club, and which player. That is
 * enough to list them — "Would it make sense to target Luis Castillo?" is a
 * question the app can already answer better than the message can.
 *
 * `sender_type = 0` with `recipient_id = 1` is mail written to the human
 * manager rather than league news broadcast to everyone; requiring both clubs
 * and a named player then separates the trade talk from the owner's PMs and
 * the waiver notices, which share the same sender.
 *
 * Note these name one player each — the export has no message carrying both
 * sides of a deal, so this is interest in a player rather than an offer with a
 * price on it. The analyser below is where the price gets worked out.
 */
/**
 * Actual offers sitting in the OOTP inbox.
 *
 * These were missed for a long time because of how they are stored. A proposal
 * looks almost exactly like the "would it make sense to target X?" notes from
 * your own staff — same message_type, same sender_type, same recipient — and
 * the earlier reader keyed on `team_id_0` and `team_id_1`, which a proposal
 * leaves empty. So every real offer was filtered out and only the suggestions
 * came through.
 *
 * What identifies a proposal is `sender_id` naming a club and `trade_id`
 * naming a deal. Which players go which way is not stored at all: the message
 * lists them together, and the sides are recovered by asking who each man
 * currently plays for. That reconstruction is checked against OOTP's own
 * wording — a Braves offer of Dylan Lee and Ivan Gomez for Henry Lalane comes
 * back exactly that way.
 *
 * Deliberately structural rather than textual. Reading the subject line would
 * work in English and quietly fail in every other language OOTP ships.
 */
tradeRoutes.get('/trade-proposals/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  if (!tableExists('messages') || !tableExists('players')) return res.json({ proposals: [] });

  const msgs = db
    .prepare(
      `SELECT m.message_id, m.subject, m.date, m.sender_id, m.trade_id,
              m.player_id_0, m.player_id_1, m.player_id_2, m.player_id_3, m.player_id_4,
              m.player_id_5, m.player_id_6, m.player_id_7, m.player_id_8, m.player_id_9,
              ${teamLabel} AS sender_label
       FROM messages m
       LEFT JOIN teams t ON t.team_id = m.sender_id
       WHERE m.recipient_id = 1 AND m.deleted = 0
         AND m.sender_id > 0 AND m.trade_id != 0 AND m.player_id_0 != 0`
    )
    .all() as Array<Record<string, number | string | null>>;

  const orgOf = db.prepare(`SELECT organization_id AS org FROM players WHERE player_id = ?`);

  const proposals = msgs
    .map((m) => {
      const sender = Number(m.sender_id);
      const ids = Array.from({ length: 10 }, (_, i) => Number(m[`player_id_${i}`] ?? 0)).filter(Boolean);
      const theirs: number[] = [];
      const ours: number[] = [];
      for (const id of ids) {
        const org = (orgOf.get(id) as { org: number } | undefined)?.org;
        if (org === sender) theirs.push(id);
        else if (org === orgId) ours.push(id);
      }
      // A message naming players on only one side is not an offer to weigh
      if (theirs.length === 0 || ours.length === 0) return null;
      return {
        message_id: Number(m.message_id),
        trade_id: Number(m.trade_id),
        subject: String(m.subject ?? ''),
        date: padDate(m.date),
        from: { team_id: sender, label: String(m.sender_label ?? 'Unknown') },
        theySend: summarizeSide(theirs),
        weSend: summarizeSide(ours),
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .map((p) => ({
      ...p,
      // The same figures the analyser reports, so an offer read here and one
      // pasted into the builder can never disagree
      valueDiff: p.weSend.totalValue - p.theySend.totalValue,
      salaryDiff: p.weSend.totalSalary - p.theySend.totalSalary,
      ...judgeDeal(p.weSend, p.theySend),
    }))
    .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));

  res.json({ proposals });
});

tradeRoutes.get('/trade-talk/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  if (!tableExists('messages') || !tableExists('players')) return res.json({ items: [] });
  const rows = db
    .prepare(
      `SELECT m.message_id, m.subject, m.date, m.team_id_0 AS other_team, m.player_id_0 AS player_id,
              p.first_name || ' ' || p.last_name AS name, p.age, p.position,
              ${teamLabel} AS other_label, t.level
       FROM messages m
       JOIN players p ON p.player_id = m.player_id_0
       LEFT JOIN teams t ON t.team_id = m.team_id_0
       WHERE m.recipient_id = 1 AND m.sender_type = 0 AND m.deleted = 0
         AND m.team_id_0 != 0 AND m.team_id_1 = ? AND m.player_id_0 != 0
         AND p.retired = 0`
    )
    .all(orgId) as Array<Record<string, unknown>>;

  const values = valuesByPlayer();
  const { overallPct, talentPct } = mlbPercentiler(values);
  const contracts = contractsByPlayer();
  // The same player is asked about more than once as the season goes on; the
  // newest message is the live one, and repeating him is just noise
  const seen = new Set<number>();
  const items = rows
    // OOTP writes dates unpadded, so newest-first has to sort on a padded copy
    .sort((a, b) => String(padDate(b.date) ?? '').localeCompare(String(padDate(a.date) ?? '')))
    .filter((r) => !seen.has(r.player_id as number) && seen.add(r.player_id as number))
    .map((r) => {
      const id = r.player_id as number;
      const c = contracts.get(id);
      return {
        message_id: r.message_id as number,
        subject: r.subject as string,
        date: r.date as string,
        otherTeam: { orgId: r.other_team as number, label: (r.other_label as string) ?? 'Unknown' },
        player: {
          player_id: id,
          name: r.name as string,
          age: r.age as number,
          positionName: POSITION_NAMES[r.position as number] ?? '?',
          levelName: LEVEL_NAMES[r.level as number] ?? 'R',
          overallPct: overallPct(id),
          talentPct: talentPct(id),
          salaryNow: c?.salaryNow ?? 0,
          yearsAfterThis: c?.yearsAfterThis ?? 0,
        },
      };
    });
  res.json({ items });
});

/**
 * One club's whole organisation, ready to pick from.
 *
 * Typing each name is the slow part of judging an offer — a five-man deal is
 * five searches, and you are copying names off another screen while you do it.
 * An offer already names a club, so this hands back that club's players to
 * click through instead. Prospects are included because they are usually what
 * the other side is asking for.
 */
tradeRoutes.get('/trade/roster/:teamId', (req, res) => {
  const teamId = Number(req.params.teamId);
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });
  const rows = db
    .prepare(
      `SELECT p.player_id, p.first_name || ' ' || p.last_name AS name, p.age, p.position, p.role,
              ${teamLabel} AS team, t.level
       FROM players p LEFT JOIN teams t ON t.team_id = p.team_id
       WHERE p.organization_id = ? AND p.retired = 0 AND p.team_id > 0
         AND p.player_id IN (SELECT player_id FROM team_roster WHERE list_id = 1)`
    )
    .all(teamId) as Array<Record<string, unknown>>;
  const values = valuesByPlayer();
  const players = rows
    .map((r) => ({
      player_id: r.player_id as number,
      name: r.name as string,
      age: r.age as number,
      positionName: positionLabel(r.position as number, r.role as number | null),
      team: r.team as string,
      levelName: LEVEL_NAMES[r.level as number] ?? 'R',
      value: values.get(r.player_id as number)?.overall ?? 0,
    }))
    // Best first: the men an offer is actually built around are at the top
    .sort((a, b) => b.value - a.value);
  res.json({ players });
});

export interface TradeSideSummary {
  players: Array<{
    player_id: number; name: string; age: number; positionName: string; team: string | null;
    overallPct: number | null; talentPct: number | null; salaryNow: number; yearsAfterThis: number;
    /** OOTP's overall value, and how much of it is above replacement for his group. */
    value: number; surplus: number;
  }>;
  /** OOTP's value summed: shown, but never the verdict — it rewards bodies and playing time. */
  totalValue: number;
  totalTalent: number;
  totalSalary: number;
  /** The best man on the side, by his percentile among his own group. */
  bestPct: number | null;
  bestName: string | null;
  /** Value above replacement, summed: a throw-in adds nothing to it. */
  surplus: number;
}

/**
 * One side of a deal, priced.
 *
 * The total of OOTP's value is kept, but it cannot be the verdict. It is a sum,
 * so every extra body adds to it: Josh Jung, an 80th-percentile third baseman,
 * lost to Ronny Mauricio and a seventeen-year-old valued at 356, because two
 * numbers add up to more than one. Surplus asks what each man is worth beyond
 * what a club could get for nothing, and a throw-in is worth nothing beyond it.
 */
export function summarizeSide(ids: number[]): TradeSideSummary {
  const values = valuesByPlayer();
  const { overallPct, talentPct } = mlbPercentiler(values);
  const pools = mlbPools(values);
  const contracts = contractsByPlayer();
  const find = db.prepare(
    `SELECT p.player_id, p.first_name || ' ' || p.last_name AS name, p.age, p.position, p.role,
            ${teamLabel} AS team
     FROM players p LEFT JOIN teams t ON t.team_id = p.team_id WHERE p.player_id = ?`
  );
  let totalValue = 0;
  let totalTalent = 0;
  let totalSalary = 0;
  let surplus = 0;
  let bestPct: number | null = null;
  let bestName: string | null = null;
  const players = ids
    .map((id) => {
      const p = find.get(id) as Record<string, unknown> | undefined;
      if (!p) return null;
      const v = values.get(id);
      const c = contracts.get(id);
      const value = v?.overall ?? 0;
      const pool = pools[groupOf(p.position as number, p.role as number | null)];
      const above = Math.max(0, value - valueAt(pool, REPLACEMENT_PCT));
      const pct = overallPct(id);
      totalValue += value;
      totalTalent += v?.talent ?? 0;
      totalSalary += c?.salaryNow ?? 0;
      surplus += above;
      if (pct !== null && (bestPct === null || pct > bestPct)) {
        bestPct = pct;
        bestName = p.name as string;
      }
      return {
        player_id: id,
        name: p.name as string,
        age: p.age as number,
        positionName: positionLabel(p.position as number, p.role as number | null),
        team: (p.team as string) ?? null,
        overallPct: pct,
        talentPct: talentPct(id),
        salaryNow: c?.salaryNow ?? 0,
        yearsAfterThis: c?.yearsAfterThis ?? 0,
        value,
        surplus: Math.round(above),
      };
    })
    .filter(Boolean) as TradeSideSummary['players'];
  return { players, totalValue, totalTalent, totalSalary, bestPct, bestName, surplus: Math.round(surplus) };
}

export type DealVerdict = 'even' | 'sideA' | 'sideB';

/**
 * Which side of a deal gives up more, measured in surplus over replacement.
 *
 * "even" when the gap is under a tenth of the bigger side, since a gap that
 * size is inside what the valuation can tell apart. Otherwise the side named
 * is the one giving up more.
 *
 * The warning is for the deal a sum flatters: several lesser men for one
 * better one. It is raised when the side with more surplus has nobody within
 * fifteen percentile points of the other side's best — the bigger number is
 * made of depth, and depth needs roster places a club may not have.
 */
export function judgeDeal(a: TradeSideSummary, b: TradeSideSummary): {
  surplusDiff: number; verdict: DealVerdict; warning: 'quantity-for-quality' | null;
} {
  const surplusDiff = a.surplus - b.surplus;
  const larger = Math.max(a.surplus, b.surplus);
  const verdict: DealVerdict =
    larger <= 0 || Math.abs(surplusDiff) < EVEN_SHARE * larger ? 'even' : surplusDiff > 0 ? 'sideA' : 'sideB';
  const more = surplusDiff > 0 ? a : surplusDiff < 0 ? b : null;
  const other = more === a ? b : a;
  const quantity =
    more !== null && more.players.length > 1 && other.bestPct !== null &&
    (more.bestPct ?? -Infinity) < other.bestPct - QUALITY_GAP;
  return { surplusDiff, verdict, warning: quantity ? 'quantity-for-quality' : null };
}

tradeRoutes.post('/trade/analyze', (req, res) => {
  const { sideA, sideB } = req.body as { sideA: number[]; sideB: number[] };
  if (!Array.isArray(sideA) || !Array.isArray(sideB)) {
    return res.status(400).json({ error: 'sideA and sideB arrays required' });
  }
  const a = summarizeSide(sideA);
  const b = summarizeSide(sideB);
  res.json({
    sideA: a,
    sideB: b,
    valueDiff: a.totalValue - b.totalValue,
    talentDiff: a.totalTalent - b.totalTalent,
    salaryDiff: a.totalSalary - b.totalSalary,
    ...judgeDeal(a, b),
  });
});

// ── Context for judging a trade ─────────────────────────────────────────

const ROLE_NAMES: Record<number, string> = { 11: 'Starter', 12: 'Reliever', 13: 'Closer' };

/**
 * A player as a trade needs him described: what he is, how he is playing, and
 * where he would actually stand on this club.
 */
/**
 * Whether a man is leaving, or merely at the end of a contract.
 *
 * Wrapped rather than called directly so a missing league — a free agent, an
 * unaffiliated club — degrades to saying nothing rather than to guessing at
 * free agency, which is the very mistake this exists to stop.
 */
function controlOf(
  id: number, leagueId: number | null, yearsAfterThis: number, hasExtension: boolean,
  serviceDays: number | null, serviceYears: number | null
) {
  if (leagueId === null) return null;
  const c = controlAfterThisSeason({
    yearsAfterThis,
    hasExtension,
    serviceDays,
    serviceYears,
    serviceLeft: serviceRemainingThisSeason(),
    rules: leagueRules(leagueId),
  });
  return { status: c.status, arbitrationYear: c.arbYear };
}

const BATTING_SUMS = `SUM(s.pa) AS pa, SUM(s.ab) AS ab, SUM(s.h) AS h, SUM(s.d) AS d, SUM(s.t) AS t3,
   SUM(s.hr) AS hr, SUM(s.bb) AS bb, SUM(s.ibb) AS ibb, SUM(s.hp) AS hp, SUM(s.sf) AS sf,
   SUM(s.k) AS k, SUM(s.sb) AS sb, SUM(s.cs) AS cs, SUM(s.r) AS r, SUM(s.rbi) AS rbi,
   SUM(s.war) AS war`;
const PITCHING_SUMS = `SUM(s.outs) AS outs, SUM(s.er) AS er, SUM(s.ra) AS ra, SUM(s.ha) AS ha,
   SUM(s.bb) AS bb, SUM(s.k) AS k, SUM(s.hra) AS hra, SUM(s.hp) AS hp, SUM(s.bf) AS bf,
   SUM(s.g) AS g, SUM(s.gs) AS gs, SUM(s.w) AS w, SUM(s.l) AS l, SUM(s.s) AS sv,
   SUM(s.hld) AS hld, SUM(s.war) AS war`;

/**
 * The season line, at whatever level he played it — a Double-A ERA is not a
 * major-league one and the reader must be able to tell them apart.
 *
 * The baseline has to come from the league he actually played in. Measuring
 * an A-ball arm against the major-league average is how ERA+ came back null
 * for every minor leaguer, which is worse than useless in a comparison the
 * whole point of which is to place him.
 *
 * One line per level, each labelled, the way the trading block reads them.
 * This used to add a man's Triple-A season to his major-league one, measure
 * the total against whichever level he is at now and leave the park out —
 * while the chat was telling the model the figures were park- and
 * league-adjusted. Each line is now read against its own league and level and
 * adjusted for the park of the club he played for there. A man who played for
 * two clubs at one level has the line read in the park where he did most of
 * his work, and `byClub` carries each stint in its own park, which is also
 * what "how has he done since he arrived" needs.
 */
function seasonLines(id: number, isPitcher: boolean, statYear: number | null):
  Array<Record<string, unknown>> {
  const table = isPitcher ? 'players_career_pitching_stats' : 'players_career_batting_stats';
  if (statYear === null || !tableExists(table)) return [];
  const rows = db
    .prepare(
      `SELECT s.level_id, s.league_id, s.team_id, t.abbr, ${isPitcher ? PITCHING_SUMS : BATTING_SUMS}
       FROM ${table} s LEFT JOIN teams t ON t.team_id = s.team_id
       WHERE s.player_id = ? AND s.year = ? AND s.split_id = 1 AND s.league_id != 0
       GROUP BY s.level_id, s.league_id, s.team_id`
    )
    .all(id, statYear) as Array<Record<string, number | string | null>>;
  const compute = isPitcher ? computePitching : computeBatting;
  const workOf = (r: Record<string, unknown>) => Number(isPitcher ? r.outs : r.pa) || 0;

  const byLevel = new Map<string, typeof rows>();
  for (const r of rows) {
    if (workOf(r) <= 0) continue;
    const key = `${r.level_id}:${r.league_id}`;
    byLevel.set(key, [...(byLevel.get(key) ?? []), r]);
  }
  return [...byLevel.values()]
    .map((clubs) => {
      const level = Number(clubs[0].level_id);
      const base = leagueBaseline(Number(clubs[0].league_id), statYear, level);
      const total: Record<string, number> = {};
      for (const r of clubs) {
        for (const [k, v] of Object.entries(r)) {
          if (typeof v === 'number' && !['level_id', 'league_id', 'team_id'].includes(k)) {
            total[k] = (total[k] ?? 0) + v;
          }
        }
      }
      const main = [...clubs].sort((x, y) => workOf(y) - workOf(x))[0];
      const line: Record<string, unknown> = {
        level: LEVEL_NAMES[level] ?? `L${level}`,
        club: clubs.map((r) => r.abbr ?? '?').join(', '),
        ...compute(total, base, Number(main.team_id)),
      };
      if (clubs.length > 1) {
        line.byClub = clubs.map((r) => {
          const s = compute(r as Record<string, number>, base, Number(r.team_id));
          return isPitcher
            ? { club: r.abbr ?? '?', ip: s.ip, era: s.era, fip: s.fip, eraPlus: s.eraPlus }
            : { club: r.abbr ?? '?', pa: s.pa, ops: s.ops, opsPlus: s.opsPlus, wrcPlus: s.wrcPlus };
        });
      }
      return { level, line };
    })
    // The highest level first: it is the one a trade is usually about
    .sort((a, b) => a.level - b.level)
    .map((x) => x.line);
}

function tradePlayer(id: number, statYear: number | null) {
  const p = db
    .prepare(
      `SELECT p.player_id, p.first_name || ' ' || p.last_name AS name, p.age, p.position, p.role,
              p.bats, p.throws, ${teamLabel} AS team, t.level, t.league_id, p.organization_id,
              rs.mlb_service_years AS service_years, rs.mlb_service_days AS service_days
       FROM players p
       LEFT JOIN teams t ON t.team_id = p.team_id
       LEFT JOIN players_roster_status rs ON rs.player_id = p.player_id
       WHERE p.player_id = ?`
    )
    .get(id) as Record<string, number | string | null> | undefined;
  if (!p) return null;

  const values = valuesByPlayer();
  const contracts = contractsByPlayer();
  const v = values.get(id);
  const c = contracts.get(id);
  const level = p.level as number | null;
  const isPitcher = p.position === 1;

  return {
    player_id: id,
    name: p.name,
    age: p.age,
    position: POSITION_NAMES[p.position as number] ?? '?',
    role: isPitcher ? (ROLE_NAMES[p.role as number] ?? 'Pitcher') : null,
    bats: ({ 1: 'R', 2: 'L', 3: 'S' } as Record<number, string>)[p.bats as number] ?? '?',
    throws: ({ 1: 'R', 2: 'L' } as Record<number, string>)[p.throws as number] ?? '?',
    currentClub: p.team,
    level: LEVEL_NAMES[level ?? 0] ?? 'unknown',
    isMajorLeaguer: level === 1,
    oaRating: v?.oaRating ?? null,
    potRating: v?.potRating ?? null,
    salaryNow: c?.salaryNow ?? 0,
    yearsAfterThis: c?.yearsAfterThis ?? 0,
    seasonLines: seasonLines(id, isPitcher, statYear),
    /*
     * What happens to him when the deal ends, not merely that it ends.
     *
     * The desk was handed yearsAfterThis and nothing else, so a man with two
     * arbitration years left read as one about to reach the market — and the
     * verdict priced him as a rental. A reader spotted it in the prose: talk
     * of a player being in his last year when arbitration was still to come.
     */
    control: controlOf(id, p.league_id as number | null, c?.yearsAfterThis ?? 0, !!c?.extension,
                       p.service_days as number | null, p.service_years as number | null),
    contact: isPitcher ? null : (contactProfiles([id]).get(id) ?? null),
    /*
     * Where he can play, and how well. Without this the desk was judging men
     * on their bats alone — and said so when asked whether a second baseman
     * could be moved to short, which is exactly the question a trade raises.
     */
    fielding: glovesLine(id),
    fieldingStats: fieldingRecord(id, statYear),
  };
}

/**
 * What he has actually done in the field, position by position.
 *
 * The ratings say what he is; this says what happened. A man rated 60 at short
 * who has made fourteen errors in forty games is a different proposition from
 * one who has not, and only one of those two facts is in the ratings.
 *
 * The current season is stored under split 0 and completed ones under split 1,
 * which is worth knowing: filtering on split 1 alone returns every year except
 * the one being asked about. Last season is carried too, because a handful of
 * games at a position he no longer plays is the strongest evidence there is
 * that he can — which is the question a trade actually raises.
 */
function fieldingRecord(id: number, statYear: number | null): string | null {
  if (statYear === null || !tableExists('players_career_fielding_stats')) return null;
  // Zone rating is not in every export, and a record without it is still worth reading
  const zr = tableColumns('players_career_fielding_stats').includes('zr') ? 'AVG(zr)' : 'NULL';
  const rows = db
    .prepare(
      `SELECT year, position, level_id, SUM(g) AS g, SUM(po) AS po, SUM(a) AS a,
              SUM(e) AS e, SUM(dp) AS dp, ${zr} AS zr
       FROM players_career_fielding_stats
       -- The season in progress is split 0; the ones behind it are split 1
       --
       -- Level is in the grouping rather than the filter. A man who spent half
       -- the year at Triple-A has two records at the same position and they are
       -- two different pieces of evidence: a clean glove in the minors is not a
       -- clean glove in the majors, and merging them says he has one when the
       -- desk cannot tell which
       WHERE player_id = ? AND year >= ? AND split_id IN (0, 1)
       GROUP BY year, position, level_id HAVING g > 0
       ORDER BY year DESC, g DESC`
    )
    .all(id, statYear - 1) as Array<Record<string, number>>;
  if (rows.length === 0) return null;
  return rows
    .slice(0, 5)
    .map((r) => {
      const chances = (r.po ?? 0) + (r.a ?? 0) + (r.e ?? 0);
      const pct = chances > 0 ? ((r.po + r.a) / chances).toFixed(3).replace(/^0/, '') : '—';
      const zr = r.zr ? `, ${r.zr > 0 ? '+' : ''}${r.zr.toFixed(2)} ZR` : '';
      const when = r.year === statYear ? 'this year' : `${r.year}`;
      // Named, so a Triple-A glove is never read as a major-league one
      const where = LEVEL_NAMES[r.level_id] ?? `L${r.level_id}`;
      return `${POSITION_CODES[(r.position ?? 1) - 1] ?? '?'} ${when} (${where}): ` +
        `${r.g}g, ${r.e}E, ${pct} fpct${zr}`;
    })
    .join('; ');
}

/**
 * Everything needed to judge a trade rather than merely price it.
 *
 * Value percentiles alone produce a verdict about numbers: this man grades
 * higher than that one, accept. A club does not run on percentiles — it runs on
 * a roster with a fixed number of places, each already occupied by somebody.
 * So the incoming players arrive with their season line at the level they
 * played it, and beside them the men they would actually have to displace,
 * with theirs, plus what the club is short of and what it has spare.
 */
export function tradeContext(orgId: number, giveIds: number[], getIds: number[]) {
  const statYear = tableExists('players_career_batting_stats')
    ? ((db.prepare(`SELECT MAX(year) AS y FROM players_career_batting_stats`).get() as { y: number }).y ?? null)
    : null;

  const give = giveIds.map((id) => tradePlayer(id, statYear)).filter(Boolean);
  const get = getIds.map((id) => tradePlayer(id, statYear)).filter(Boolean);

  // Who already holds the jobs the incoming men would want. Only the
  // major-league roster: a prospect is not competing with anybody yet.
  /*
   * Grouped by the job, which for a pitcher is his role rather than "P".
   * Listing Max Fried as a man a relief arm would displace is not a comparison
   * anybody would make: a reliever competes with relievers.
   */
  const jobOf = (p: { position: string; role: string | null }): string => p.role ?? p.position;
  const incomingPositions = new Set(
    get.filter((p) => p && p.isMajorLeaguer).map((p) => jobOf(p!))
  );
  const leaving = new Set(giveIds);
  const incumbents: Record<string, unknown[]> = {};
  if (incomingPositions.size > 0 && tableExists('team_roster')) {
    const roster = db
      .prepare(
        `SELECT p.player_id FROM players p
         WHERE p.organization_id = ? AND p.retired = 0
           AND p.player_id IN (SELECT player_id FROM team_roster WHERE team_id = ? AND list_id = 1)`
      )
      .all(orgId, orgId) as Array<{ player_id: number }>;
    for (const { player_id } of roster) {
      if (leaving.has(player_id)) continue;
      const man = tradePlayer(player_id, statYear);
      if (!man || !man.isMajorLeaguer) continue;
      if (!incomingPositions.has(jobOf(man))) continue;
      (incumbents[jobOf(man)] ??= []).push(man);
    }
    // Best first, so the man actually holding the job leads the list
    for (const pos of Object.keys(incumbents)) {
      (incumbents[pos] as Array<{ oaRating: number | null }>).sort(
        (a, b) => (b.oaRating ?? 0) - (a.oaRating ?? 0)
      );
      incumbents[pos] = (incumbents[pos] as unknown[]).slice(0, 4);
    }
  }

  const values = valuesByPlayer();
  const mine = orgProfile(orgId, values);

  /*
   * Whether the men in this deal are actually on the market.
   *
   * It changes the read entirely and the desk had no way to know it. A club
   * that has listed a player is telling you it wants to move him and the price
   * starts lower; a club that has not is being asked for a favour. The save
   * has carried this in the trading block all along.
   */
  const listed = blockedIds();
  const onTheBlock = {
    weGive: give.filter((p) => p && listed.has(p.player_id)).map((p) => p!.name),
    weReceive: get.filter((p) => p && listed.has(p.player_id)).map((p) => p!.name),
  };

  // The same totals the Compare cards put on screen, so a verdict citing a
  // number and the panel beside it can never disagree
  const giveTotals = summarizeSide(giveIds);
  const getTotals = summarizeSide(getIds);
  const judged = judgeDeal(giveTotals, getTotals);

  return {
    weGive: give,
    weReceive: get,
    totals: {
      valueSent: Math.round(giveTotals.totalValue),
      valueReceived: Math.round(getTotals.totalValue),
      talentSent: Math.round(giveTotals.totalTalent),
      talentReceived: Math.round(getTotals.totalTalent),
      salarySent: giveTotals.totalSalary,
      salaryReceived: getTotals.totalSalary,
      // Value above replacement and the best man each way: the figures the
      // page's verdict is drawn from, which the summed value is not
      surplusSent: giveTotals.surplus,
      surplusReceived: getTotals.surplus,
      bestPctSent: giveTotals.bestPct,
      bestPctReceived: getTotals.bestPct,
      verdict: judged.verdict === 'sideA'
        ? 'we give up more surplus'
        : judged.verdict === 'sideB' ? 'we receive more surplus' : 'even on surplus',
      quantityForQuality: judged.warning !== null,
    },
    whoTheyWouldDisplace: incumbents,
    /** Named here are the men their own clubs have listed for trade. */
    onTheBlock,
    clubNeeds: mine
      ? { weakestPositions: mine.weakest, surplusPositions: mine.surplus }
      : null,
  };
}
