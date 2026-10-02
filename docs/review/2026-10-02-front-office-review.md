# OOTP Front Office 0.40.1 — usability, trust and actionability review

*Reviewed 2026-10-02 against the installed desktop app (Windows 11) on the user's "New Game 3" save: a 2028 MLB league, human club Los Angeles Dodgers (`team_id 15`), in-game date 2028-05-15, CSV exported the same morning. Live AI features were not exercised (no key configured); the AI layer was reviewed from code.*

Evidence lives next to this file: `evidence/*.json` are raw API responses and analysis outputs, `screenshots/*.jpg` are the pages as they rendered. `file:line` references point into this repository.

## 1. Summary

| | Result |
|---|---|
| Build | `npm ci` clean, `tsc --noEmit` clean |
| Tests | 677 tests pass; **1 suite fails on Windows only** (`tests/ratingDisplay.test.ts` builds `C:\C:\…`, see E8). CI runs the suite on Ubuntu so it has never seen it |
| Check scripts | `check:stats`: all 12 leagues centre on 100; `check:theme`: 64/64 team/mode combinations pass WCAG AA |
| Pages | All 27 pages render with zero console errors; the two heaviest (Player Search, Draft Board) take more than 5 s to paint |
| First run from source | Save picker → one click → 3.15 M rows imported in 37 s with a progress bar → dashboard, no reload needed |
| Findings | 7 P1 (misleads a decision), 20 P2 (wrong in an edge or costs real time), 11 P3 (polish) |

The data plumbing is excellent: the import is fast and tolerant, the first run is the best part of the product, the glossary tooltips are genuinely educational, and every page states its method. The weaknesses are concentrated in three places: a few engines give confident answers that the save contradicts (bullpen, trade value, 40-man, free agents); the pages disagree with each other about the same player; and nothing can be acted on from inside the app.

## 2. Method

- Baseline: `npm ci`, `npx tsc --noEmit`, `npm test`, `npm run check:stats`, `npm run check:theme` in this worktree (`evidence/npm-test.txt`, `evidence/check-scripts.txt`).
- Page walkthrough of the running desktop app (`http://127.0.0.1:61948`) in the built-in browser, read-only: no save switch, refresh or settings change was made in the user's instance.
- Eight GM scenarios (section 5), four of them with API cross-checks.
- Data-backed confirmation of the engine risks found in code review: every `/api` endpoint for the Dodgers was captured, plus league-wide scans of all 32 organizations and 36 level-1 bullpens (`evidence/analysis-*.json`).
- First-run and onboarding tested from source on a second instance (`PORT=5178`, data in the worktree `data/` folder), never touching the desktop app's data.

Not covered: AI generations (briefing, The Paper, recap, trade desk, Ask), the static website export, and the Settings "Re-import now" path (it mutates the user's live instance).

## 3. Findings by axis

Severity: **P1** misleads a decision · **P2** wrong in an edge case or costs real time · **P3** polish. Effort: S under a day, M a few days, L a week or more.

### 3.1 Trustworthiness

**T1 · P1 · Bullpen availability never flags the third straight day.** League-wide scan (`evidence/analysis-bullpen-scan.json`): 18 relievers pitched on both 5-13 and 5-14, and 12 of them show a green *"Available (N yesterday)"*: Jhoan Duran (POR, 26 pitches over the two days), Rowan Wick (SF, 31), Spencer Schwellenbach (ATL, 38), Jose Butto (SD, 27), Kevin Kelly and Robert Garcia (TB), and six more. Cause: "today" is the league's unplayed date, so `on(0)` is always empty and the two rules that look at it (`server/pitching.ts:110-131`, "Two straight" and "Would be back-to-back") can no longer fire; `tests/bullpenToday.test.ts:87-101` locks in the wording, not the tone. Fix: evaluate consecutive days relative to the last played date (pitched yesterday **and** the day before → red "third straight day"; pitched yesterday → amber). Effort S. Add a test for the two-day case.

**T2 · P1 · The trade analyzer's "value swing" is a raw sum, so a throw-in beats a star.** `POST /api/trade/analyze` with Josh Jung (TEX, 80th-percentile value) against Ronny Mauricio (34th) plus Ted Forrest (0th, value 356): `valueDiff −98`, i.e. the two-player side "wins" (`evidence/trade-analyze-cases.json`). The UI colours that as a verdict (`src/pages/TradeCenter.tsx:331-335`). `server/valuation.ts:545-555` already explains why raw `overall_value` penalises relievers and rewards playing time; `server/trade.ts:337-389` sums it anyway. Fix: show best-player percentile and summed value separately, and compare "surplus over replacement" rather than totals. Effort M. There are no tests for analyze, fits or proposals; add them.

**T3 · P1 · Trade Fits ignores pitchers and offers your starting shortstop to fill your shortstop hole.** The page reads *"Your weakest spots: SS, CF, 3B · your tradable surplus: SS"* and every club card says *"They need SS — you could offer Alex Freeland"*, who starts at SS on the Lineup page (`screenshots/trade-center.jpg`, `evidence/trade_fits_15.json`). All targets offered are 3B/SS/CF; no pitcher appears anywhere because `orgProfile` filters `position != 1` (`server/trade.ts:53-58`). Fix: treat a position as surplus only when the backup is good enough and the starter is not the one being offered; add pitching to needs and surplus by role. Effort M.

**T4 · P1 · 40-man counts are wrong in both directions.** Across the league 41 players on the 60-day IL are counted on the 40-man (Baltimore shows 42/40, Austin Impact 41/40, Boston counts Garrett Crochet), and 255 active players with all three options used carry no flag (Dodgers: Evan Phillips, Blake Snell, Steven Okert, Grant Anderson), because `outOfOptions` requires `!on26` (`server/rosterops.ts:36-42`; `evidence/analysis-rostercrunch-league.json`). The dashboard shows *0 roster issues* while the page shows *6*. Fix: drop IL-60 from the count, flag active out-of-options players with under five years' service (the ones who actually force a DFA), and count the same set on the dashboard. Effort S. No tests exist for roster crunch; add them.

**T5 · P1 · The Free Agents page is mostly the draft pool.** 2,766 players are listed as *available now*; 1,594 of them are in the 2,744-player draft pool, aged 14-22, including Chris Berger (talent 100) who is #12 on the Draft Board (`evidence/analysis-fa-vs-draft.json`). Only 1,172 are real free agents, and the top of that list is thin (Janson Junk 70th pct, Gleyber Torres 59th). The *FILLS HOLE* badge is applied to 471 players, 470 of them below the 25th percentile (Matt Vierling, value 1). Fix: exclude draft-eligible and amateur players, put a value floor on the badge, and show what signing him would cost. Effort S-M. `server/freeagents.ts` has no tests.

**T6 · P1 · "Blocked" prospects are judged by scout grade alone and the other pages disagree.** Emil Morales (21, AA, 1.072 OPS, 10 HR, 2.3 WAR in 147 PA, last year's MVP on his card) is *blocked at 3B — Max Muncy grades 56 to his 41*. The same Max Muncy (37) is cold on the Dashboard, hitting .198/.301/.385 (87 wRC+) on the Lineup page, and gets *Hold off* on Contracts because "the season does not back an extension" (`screenshots/prospects.jpg`, `contracts.jpg`). `server/org.ts:379-489` compares grades only. Fix: let the incumbent's season form and age enter the comparison the same way `server/form.ts` enters contracts. Effort M.

**T7 · P1 · "46 promotion signals" contains zero promotions.** The Dodgers' 46 are 27 watch, 17 blocked, 2 demote (`evidence/prospects_15.json`); league-wide, promote is 20 of 2,054 signals. The chip counts every non-null signal (`server/dashboard.ts:436-438`) and navigates to an unfiltered page. Fix: count promote only (or rename the chip) and pass a filter. Effort S.

**T8 · P2 · The rotation assumes five men and "next start" contradicts the schedule.** The Dodgers run six: Tyler Glasnow started on 5-14 and is listed under *Starting depth — spot starters, long men*. Snell, Sasaki and Yamamoto all read *next start: today*, while the Schedule page names Snell today, Sasaki 5-17, Yamamoto 5-18 (`screenshots/pitching-staff.jpg`, `schedule.jpg`). `nextStartInDays = max(0, 5 − daysRest)` (`server/pitching.ts:286-288`). Fix: take the next start from `projected_starting_pitchers`, and size the rotation from it. Effort S.

**T9 · P2 · Contract advice vetoes on tiny samples and sends mixed messages.** Jackson Holliday (24, 96th-percentile value, 97th talent) gets *Hold off* on 125 PA; Andres Munoz gets *Extend now* and, in the same cell, *"too little to judge, this is the value figure alone"*; Dillon Dingler (80/94, two arbitration years) and Blake Snell get nothing at all. `server/contracts.ts:151-179`. Fix: scale the form veto by age and talent, print a one-line reason when there is no action, and never pair "now" with "too little to judge". Effort S.

**T10 · P2 · Three payroll figures on one page do not reconcile.** *Payroll now $329.4M*, *Committed 2028 $368.8M* (= payroll + $32.7M dead money + about $6.7M more), *Payroll next season $298.5M (OOTP estimate)*, and *Cash for trades $-16.5M* (`screenshots/payroll.jpg`). Fix: one reconciliation line under the cards. Effort S.

**T11 · P2 · The farm-system rank is a headcount.** Spearman correlation between farm rank and players in the system is 0.973: the top ten farms carry 288-310 players, the Dodgers carry 248 and rank #24 (`evidence/org-comparison_15.json`; `server/franchise.ts:148-163` sums talent). Fix: rank by the best N prospects or by count of 50+ grades. Effort S.

**T12 · P2 · "Your tenure" loses the first season.** 2026 shows *0-0 .000 — Won it all*; the season table shows 100-62. The 130-70 total omits it (`screenshots/franchise-history.jpg`; `server/gameplan.ts:328` tenure route). Effort S.

**T13 · P2 (code) · The AI trade desk is told the stats are park- and league-adjusted; they are not.** `server/trade.ts:443-476` sums a player's season across levels and passes `teamId 0` (no park factor), contradicting `server/chat.ts:580-581` and the fix the trading block already made (`server/tradingblock.ts:65-73`). Chat gets no league-rules briefing (`server/chat.ts:494-596`), and when the 12-turn tool loop runs out the verdict can come back empty with no "incomplete" marker (`server/providers.ts:689`). Effort M.

**T14 · P2 (code) · Every server threshold assumes the 20-80 scale.** Promote/"near ceiling" gaps of 5 and 15 (`server/org.ts:561,597`), lineup defence weight and the unmanned-position rating (`server/lineup.ts:172-189`), draft advice (`server/rosterops.ts:478-494`), and the AI prompt (`server/ai.ts:221`); `ratingScaleMax` is read only for the client (`server/api.ts:238`). Saves on 1-5, 1-10 or 1-20 scales get silently wrong advice. Effort M.

**T15 · P2 (code) · Some caches survive a re-import or a save switch.** `server/trade.ts:26-41` (MLB median), `server/playerfile.ts:43` (scouting peers), `server/battedball.ts:111` (never called), `server/org.ts:109-114` (column chosen at module load). `runImport` clears only some (`server/api.ts:143-175`). Effort S.

**T16 · P3 · The coaching-staff card and the promotion table use different numbers for the same man.** Mark Prior: *Teach Pitching 136 / Handle Players 115* on the card, *incumbent 131* in the table. Say which composite is being compared. Effort S.

**T17 · P3 · The Draft Board ranks 14- and 15-year-olds.** 81 fourteen-year-olds and 340 fifteen-year-olds are in the pool (OOTP's own flag, `poolRule: flag`), and the "Who to take" list has a 15-year-old at #5 and a 14-year-old at #11. Verify against OOTP's draft screen; show years to eligibility either way. Effort S.

**T18 · P3 · Injury report columns that are always zero.** *IL days this yr* is 0 for all 16 rows including an IL-60 pitcher; *"~1 days"*. Hide or label the column when the export does not populate it. Effort S.

### 3.2 Ease of use

**E1 · P2 · No URLs.** The page is React state (`src/App.tsx:44-47`): no deep links, no bookmarks, browser Back does nothing, chips and cross-links cannot carry a filter, and a player card cannot be shared. A hash router is the enabling change for most actionability items below. Effort M.

**E2 · P2 · The dashboard chips disagree with the pages they open.** *0 roster issues* vs *Needs attention 6*; *46 promotion signals* vs no promotes (T4, T7; `screenshots/dashboard.jpg`, `forty-man.jpg`). Effort S.

**E3 · P2 · Freshness is wall-clock, and the copy promises an auto-import that does not happen.** The header says *data exported 55 min ago*; nowhere does it say *league date 2028-05-15*, which is the number a GM needs after a sim. The first-run screen and `README.md:283` say the app "picks up changes automatically"; the watcher only raises a banner (`server/watcher.ts:35-58`). Effort S.

**E4 · P2 · Method paragraphs push the table below the fold.** Prospects has two paragraphs before the first row; Trade Fits and Lineup have one each. Keep them, but collapse them behind a *How this works* toggle that remembers its state. Effort S.

**E5 · P3 · Keyboard and screen-reader access.** Every player link has the accessible name *Open player card*, so a list of twenty prospects reads as twenty identical buttons; the player card has no dialog role or focus trap (`src/playerModal.tsx:107-118`); glossary tooltips are hover-only (`src/styles.css:974-997`); dropdown menus have no arrow-key handling; `✕`, `←` and `⚙` have no labels. Effort M.

**E6 · P3 · Settings copy is stale and one mark misleads.** *"Storylines, the GM Briefing, and AI trade verdicts"* (The Paper, Recap and Ask are the real list; Storylines has no page); the *✓* after *Ollama (on this machine)* means "no key needed" (`src/pages/Settings.tsx:297`) but reads as "installed", and Ollama is not installed here. Effort S.

**E7 · P3 · Heavy pages.** Player Search (678 rows) and the Draft Board (100 rows plus a 2,744-player pool in memory) each took more than 5 s to paint in the browser pane. Virtualise or page. Effort M.

**E8 · P3 · Windows contributor friction.** `tests/ratingDisplay.test.ts:21` uses `new URL(...).pathname`, which yields `/C:/…` and then `C:\C:\…` on Windows (use `fileURLToPath`); `npm start` relies on POSIX `NODE_ENV=production …`, which `cmd.exe` (npm's default shell on Windows) does not understand; the server honours the generic `PORT` variable (`server/index.ts:157`), which collides with Vite's 5173 under any tool that sets `PORT` (the browser preview runner did exactly that). Prefer `OOTP_FO_PORT`. Effort S.

**E9 · P3 · Formatting.** *$-16.5M*, *43th pct* (`server/contracts.ts:122`), *~1 days*, flags that run together in text (*EXPIRINGNO-TRADE*), a `/path/to/Your Save.lg` placeholder on Windows, service time as a bare decimal (*11.16*) with no tooltip. Effort S.

**E10 · P3 · Transactions caps at "200 of 200"** with no way to load more or jump to a date. Effort S.

### 3.3 Actionability

**A1 · P1 · Nothing in the app can be acted on, tracked or verified.** There is no "do this in OOTP" step anywhere except the CSV-export path (`src/App.tsx:553`); the assistant is told to point at app pages, not game screens (`server/chat.ts:593-594`); no recommendation has a done, snoozed or dismissed state; every import recomputes everything from scratch; and nothing checks whether a move you made actually happened. The watchlist and notes (`server/history.ts:62-94`) are the only state that survives an import. This is the single largest gap and the subject of the companion memo (`2026-10-02-ootp-write-channels.md`, Tier 0 "action cards"). Effort L.

**A2 · P1 · The call-up flow stops halfway.** Prospects → player card shows ratings, history and *0 yrs MLB service*, but not whether he is on the 40-man, how many options he has, or who comes off; the 40-Man page is not linked from either; *The move* never checks roster space (`server/org.ts:379-489`). The chat tool description even tells the model to check the roster crunch first (`server/chat.ts:337-346`). Effort M.

**A3 · P2 · Contract advice stops at a verb.** No suggested years or dollars, no deadline, no ordering beyond salary, many blank cells (T9). The payroll page already knows the headroom by season; put the two together. Effort M.

**A4 · P2 · The Trade Center makes you re-type what it just told you.** Fit cards have no *load into analyzer* button (`src/pages/TradeCenter.tsx:393-421`); `/api/trade/roster/:teamId` exists but no page uses it (`server/trade.ts:299`); the AI conversation is lost when you leave the page; offers have no accept/reject/handled state. Effort M.

**A5 · P2 · Lineup and bullpen cards cannot leave the app.** No copy, no export, no "who instead" next to a red reliever; the Game Plan is reachable only from the Schedule, not from *Up next* or the Lineup banner. Effort S.

**A6 · P2 · Free agents have no price.** Even after T5 is fixed, the list offers no asking price, years, or "what it would do to next year's room". Effort M.

**A7 · P3 · The assistant can read but never act.** Nineteen read-only tools; it cannot watch a player, file a note or mark a card done; *Stop* cancels the browser request but not the model run (`server/chat.ts:845-1002`). Effort M.

## 4. What is good and should not change

- Import: schema-tolerant, delimiter-sniffing, 37 s for 3.15 M rows with a live progress bar, and a first-run screen that lists every save with its export time.
- Explanations: every page states its method in plain English, and the glossary tooltips are the best stat explanations in any OOTP companion tool I know of.
- Honest empty states: The Paper, Daily Recap, Development and Watchlist all say exactly what will happen and why nothing is there yet.
- Park- and league-calibrated OPS+/wRC+/ERA+ computed from the save, verified by `check:stats`.
- Team-colour theming with a contrast guard, verified by `check:theme`.

## 5. Scenario scorecards

| # | Scenario | Clicks | Outcome | Where it stops |
|---|---|---|---|---|
| S1 | Morning check-in | 1-2 | Dashboard answers "are we good" in one screen (BUY, 99 %, magic number) | Chips count the wrong things; no "what did I decide last time" |
| S2 | Call up a prospect with a 40-man check | 4+ | Found Morales, read his card, opened 40-Man separately | Card shows no roster status; no link; move ignores roster space (A2) |
| S3 | Who can pitch tonight | 1 | Clear labels, colour-coded | Third-straight-day relievers read green (T1); next-start column wrong (T8) |
| S4 | Expiring contracts | 2 | Five expiring deals sorted by salary with reasons | No price, no years, blanks (T9, A3) |
| S5 | 1-for-1 and 2-for-1 trade | API | Analyzer returns totals | 2-for-1 inverts the verdict (T2); fits offer the starting SS (T3) |
| S6 | Stale export vs in-game date | — | Not run (needs the user to sim) | Header shows only wall-clock time (E3) |
| S7 | First run from source | 1 | Picker → import 37 s → dashboard, no reload | Copy promises auto-import (E3) |
| S8 | Switch saves | code | Development/Watchlist are keyed by save name | No explanation on screen when history is empty after a switch |

## 6. Top 10 quick wins (all effort S)

1. Make the dashboard chips count exactly what their pages show, and rename *Promotion signals* to *Farm signals* or count promotes only (T4, T7, E2).
2. Put the league date in the header next to the export time; fix the first-run copy and `README.md:283` to say "offers to reload" (E3).
3. Bullpen: evaluate consecutive days from the last played date and add the two-day test (T1).
4. Next start from `projected_starting_pitchers`; rotation size from the same table (T8).
5. Exclude the draft pool from Free Agents and put a value floor on *FILLS HOLE* (T5).
6. Drop IL-60 from the 40-man count; flag active out-of-options players with under five years' service (T4).
7. Reconciliation line on Payroll; sign and ordinal formatting (T10, E9).
8. Fix the tenure first-season row (T12).
9. `fileURLToPath` in `tests/ratingDisplay.test.ts`; `OOTP_FO_PORT` instead of `PORT`; a `cmd.exe`-safe `start` script (E8).
10. Clear the remaining caches in `runImport` (T15).

## 7. Needs a product decision

- **Value model.** Everything leans on OOTP's `players_value`, which bakes in playing time. Either own a replacement-level model or stop colouring raw sums as verdicts (T2).
- **Decision state.** Done/snoozed/dismissed per recommendation, keyed by save and player, with closed-loop verification on the next import (A1; memo Tier 0).
- **Auto-import.** Either import automatically when a fresh export settles (today's export had a 15-second gap between files, longer than the 3-second debounce) or keep the banner and change the copy.
- **Park and level adjustment in the trade desk.** Match what the trading block already does (T13).
- **Reserve-clause and non-MLB leagues.** Free agency, options, service time and the 20-80 thresholds are MLB assumptions; decide whether to support other rule sets or to say so in the UI (T14, `server/freeagents.ts:56-86`).
- **Whether the assistant may act.** Watch, note and mark-done tools would make Ask the fastest way to run the morning check-in (A7).
- **Draft-pool age rule.** Keep OOTP's flag or add a years-to-eligibility filter (T17).

## 8. Appendix

### Reproduce the headline findings

The desktop app's port is in `%APPDATA%\ootp-front-office\port.json` (61948 at review time).

```bash
P=61948
curl -s http://127.0.0.1:$P/api/dashboard/15     # .pending.crunchIssues = 0, .pending.promoteSignals = 46
curl -s http://127.0.0.1:$P/api/roster-crunch/15 # .counts.issues = 6; Phillips/Snell/Okert/Anderson 3/3 options, no issue
curl -s http://127.0.0.1:$P/api/pitching/15      # bullpen[].status vs each man's pitchingGameLogs in /api/player/<id>
curl -s -X POST http://127.0.0.1:$P/api/trade/analyze -H "Content-Type: application/json" -d "{\"sideA\":[24617],\"sideB\":[21897,133332]}"   # valueDiff -98
curl -s http://127.0.0.1:$P/api/status           # csvExportedAt is wall-clock; the league date only appears inside page payloads
```

### Evidence index

- `evidence/status.json`, `orgs.json`, `settings.json` — instance state at review time.
- `evidence/<endpoint>_15.json` — every Dodgers endpoint captured read-only.
- `evidence/analysis-bullpen-scan.json` — 36 bullpens, the 18 two-day relievers and their labels (T1).
- `evidence/trade-analyze-cases.json` — the 1-for-1 and 2-for-1 cases (T2).
- `evidence/analysis-rostercrunch-league.json` — IL-60 on the 40-man and unflagged out-of-options players, all orgs (T4).
- `evidence/analysis-fa-vs-draft.json` — free agents ∩ draft pool, pool ages (T5, T17).
- `evidence/analysis-prospects-league.json` — signal counts league-wide (T7).
- `evidence/npm-test.txt`, `check-scripts.txt`, `from-source-server.log` — baseline runs.
- `screenshots/` — one capture per page, plus the first-run sequence and a player card.

### Test gaps found

No tests for: trade analyze / fits / proposals, free agents, roster crunch, draft advice labels, negative contract actions (let walk, release), staff promotion, org comparison, posture calibration, lineup defence weighting on non-20-80 scales, bullpen consecutive-day tones.

## 9. Resolution status (same day, uncommitted on branch `claude/ootp-front-office-review-6e2879`)

Every finding was worked through on 2026-10-02 after the review was written. "Fixed" means the change is in the working tree with a test that fails without it; the full suite (112 files, 1,539 tests), `npm run check:stats` and `npm run check:theme` pass. The release notes drafted for 0.41.0 describe each change in user terms.

| Finding | Status | Where it is checked |
|---|---|---|
| T1 bullpen third straight day | Fixed: consecutive days counted back from the last played date; red on two in a row, amber after a 15-pitch outing | `tests/bullpenConsecutive.test.ts` |
| T2 trade value swing | Fixed: summed value, best player and surplus over replacement (25th percentile of the group's MLB pool) shown separately; quantity-for-quality warning | `tests/tradeAnalyze.test.ts` |
| T3 fits ignore pitchers | Fixed: pitching enters needs and surplus; a starter is never the man offered | `tests/tradeFits.test.ts` |
| T4 40-man counts | Fixed: 60-day IL not counted and labelled; active out-of-options men with under five years' service flagged | `tests/rosterCrunch.test.ts` |
| T5 free agents = draft pool | Fixed: amateurs left out with the draft board's rule and the count shown; "fills hole" needs the replacement floor | `tests/freeAgents.test.ts` |
| T6 blocked by grade alone | Fixed: the incumbent's season and age enter the comparison; every promote and watch signal has a reason | `tests/blockedByForm.test.ts` |
| T7 "46 promotion signals" | Fixed: the chip counts promote, blocked and demote, opens the page filtered (`#/prospects?signal=decision`) | `tests/dashboardChips.test.ts` |
| T8 rotation of five / next start | Fixed: rotation sized from OOTP's projection; one `probableStarters()` shared by Schedule, Game Plan, dashboard and Pitching | `tests/rotationFromProjected.test.ts`, `tests/probableStarterSchedule.test.ts` |
| T9 contract advice samples | Fixed: form veto scales with age and talent; "Extend (value only)"; every blank row says why | `tests/contractAdvice.test.ts` |
| T10 payroll figures | Fixed: reconciliation line under the cards | `tests/payrollReconcile.test.ts` |
| T11 farm rank headcount | Fixed: sum of the ten best prospects | `tests/farmRank.test.ts` |
| T12 tenure first season | Fixed: club record used for the takeover year and marked | `tests/tenure.test.ts` |
| T13 trade desk adjustments | Fixed: one line per level against that level's league and park; league-rules briefing; incomplete answers say so | `tests/tradeDesk.test.ts`, `tests/leagueRulesNotes.test.ts`, `tests/chatIncomplete.test.ts` |
| T14 20-80 assumed | Fixed: thresholds scaled to the save's own scale via `scaleGrade()` | `tests/ratingScaleThresholds.test.ts` |
| T15 caches survive import | Fixed: all four cleared on import | `tests/cacheReset.test.ts` |
| T16 coach numbers | Fixed: seat score shown beside the raw ratings | `tests/staff.test.ts` |
| T17 14-year-olds on the board | Partly: years to eligibility shown and the board says who it left out; the in-game draft screen was not checked | `tests/draftEligibility.test.ts` |
| T18 empty injury columns | Fixed: the IL-days column is left out when the export does not fill it; "~1 day" | `tests/formatting.test.ts` |
| E1 no URLs | Fixed: hash router (`src/route.ts`); page, filters and player card in the address | `tests/route.test.ts` |
| E2 chips disagree | Fixed with T4 and T7 | `tests/dashboardChips.test.ts` |
| E3 freshness / auto-import copy | Fixed: league date in the header (`Status.leagueDate`); Settings and README describe what happens | checked by hand in the browser |
| E4 method paragraphs | Fixed: "How this works" fold that remembers its state | `tests/methodNote.test.ts` |
| E5 keyboard and screen readers | Fixed: named player links, dialog role and focus trap, keyboard tooltips, labelled ✕ / ← / ⚙, arrow keys in menus | `tests/accessibility.test.ts` |
| E6 Settings copy | Fixed | checked by hand in the browser |
| E7 heavy pages | Fixed: Player Search and the Draft Board load a page at a time | `tests/playersPaging.test.ts`, `tests/draftPaging.test.ts` |
| E8 Windows friction | Fixed: `fileURLToPath`, `scripts/start.mjs`, `OOTP_FO_PORT` | the full suite now passes on Windows |
| E9 formatting | Fixed | `tests/formatting.test.ts` |
| E10 transactions cap | Fixed: load more and jump to a date | `tests/transactionsPaging.test.ts` |
| A1 nothing can be acted on or tracked | Open: needs the product decision in section 7 (action cards, done/snooze state, verification after import); design in the companion memo | — |
| A2 call-up flow | Fixed: roster standing on the card, who comes off the 40-man, link to the 40-man page | `tests/callUpRoster.test.ts` |
| A3 contract advice stops at a verb | Fixed: terms from comparable deals, deadline, urgency order | `tests/contractTerms.test.ts` |
| A4 Trade Center re-typing | Partly: "Load into analyzer" and "Review this offer" buttons; the conversation is still lost on leaving the page and offers have no handled state (section 7) | `tests/tradeFits.test.ts` |
| A5 lineup and bullpen cards | Fixed: "use X instead" beside a limited reliever, Copy lineup / Copy bullpen plan, Game Plan one click from Up next and the Lineup banner | `tests/bullpenInstead.test.ts`, `tests/lineupCopy.test.ts` |
| A6 free agents have no price | Partly: last salary shown and labelled; OOTP exports no asking price, so a quote would be a model of its own (section 7) | `tests/freeAgents.test.ts` |
| A7 assistant never acts | Fixed: watch, unwatch and note tools; Stop cancels the model run | `tests/chatActions.test.ts` |

Also fixed while here: the chat said "Something went wrong" when Ollama was not running; it now says it could not reach Ollama and what to check, and `docs/OLLAMA.md` says which models support tools.

A browser walk of all 27 pages after the fixes (console clean, no failed requests, every dashboard chip count matching its page, next starts agreeing between the Pitching and Schedule pages) turned up eight smaller things, fixed the same day: percentile colours on the Contracts page and the player card were unreadable on the light theme (1.1-1.9:1; they now mix the theme's own colours, as plus stats already did); long names on the depth chart ran under the age and grades beside them; the widest tables (Rosters, Contracts, Player Search, Prospects, Staff) dragged the whole page sideways instead of scrolling in their own box; the Org Comparison subtitle said "the other 29" in a 32-club league; fourteen filter drop-downs and the five "Plan" buttons had no accessible name; there was no skip link; and the Lineup banner wrote the date as 2028-5-15 where the header writes Mon May 15, 2028. Left as observed: the dashboard payload takes about two seconds (it runs every panel's query on each visit), and a club with several limited relievers may be pointed at the same stand-in for more than one of them, which is the right answer for each man taken alone.
