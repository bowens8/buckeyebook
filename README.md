# The Buckeye Book

A real-time college football picks + live wagering app for the group.
Firestore backend, static frontend, deploys straight to GitHub Pages.

## What's built

- **Weekly ATS picks** — pari-mutuel pot, tiered + margin-scaled payouts
  (upset covers pay the most, capped at 3x scaling so no one game can drain
  the pot). Outright upset calls also earn a 🌰 buckeye sticker. Picks can be
  freely changed or cancelled (full refund) anytime before kickoff, then
  lock automatically — enforced both in the UI and in the Firestore rules
  themselves, so it can't be bypassed from a modified client.
- **CFBD sync** — commissioner pulls the week's FBS matchups + Vegas spreads
  straight from CollegeFootballData.com with one click; re-running it just
  updates spreads, never duplicates games.
- **Live in-game bets** — propose against the whole group (open pool) or a
  specific set of people (must individually accept), odds-based or 50/50.
- **Real password accounts** — Firebase Auth email/password under the hood
  (a synthetic address built from the name you choose, so nobody has to
  think about email). A player types a name + password once and can log
  in from any device from then on.
- **Commissioner unlock code** — `buns`. Entered at signup, or later from
  the Standings page's "Commissioner Access" box for an existing account.
  Change it in `js/firebase-config.js` (`COMMISSIONER_CODE`) before you
  hand the app to the group if you want it to stay private.
- **All-time leaderboard** — permanent, never reset by a settle-up. See
  the two-figure money model note below for how this differs from your
  current balance.
- **Offline commissioner entry** — a dedicated Offline Entry page (visible
  only to commissioners) for logging bets and outcomes by hand with no
  signal. Firestore's offline persistence queues those writes on the
  device and syncs them automatically the moment it reconnects — no manual
  "upload" step needed.
- **Real-time everywhere** — every page uses Firestore `onSnapshot` listeners,
  and every balance-changing action runs through a `runTransaction` (or,
  offline, an `increment()` field update — see note below) so two players
  acting at the same moment can never corrupt each other's balance.
- **Two-figure money model** — your current balance (can go negative,
  shown in the header) tracks what you actually owe or are owed right
  now, while a separate all-time net figure (Standings leaderboard) is a
  permanent running total that's never reset. The commissioner can
  "Settle Up" any player once real-world payment happens — that zeroes
  their current balance only, leaving their all-time leaderboard
  position untouched.
- **Profile pictures** — click your avatar in the header to upload one;
  it's resized and compressed client-side to a small square, stored
  directly on your player doc (no separate storage service needed).
- **Automatic games, scores, and settlement — driven by any signed-in
  user, not just the commissioner.** A background engine
  (`js/live-data-engine.js`) runs on whichever player's device happens
  to have the app open: it pulls each week's games and spreads, polls
  live scores, locks each spread 48 hours before its kickoff, and
  settles finished games — no commissioner tab required, just *someone*
  in the group logged in. This works because the Firestore rules trust
  any signed-in player to drive these writes — see the trade-off note
  in that file. (A real always-on Cloud Functions version also exists
  in `functions/` as an optional upgrade — not required by default.)
- **Automatic spread lock, 48 hours before kickoff** — lines move freely
  with the market until the 48-hour window, then freeze permanently. A
  commissioner re-syncing a week afterward can't accidentally move a
  locked line; the sync explicitly skips any game already locked.
- **Pregame vs. in-game odds are fully separate systems, on purpose.**
  The weekly pick spread (`games/{id}.spread`) is what the 24-hour lock
  applies to — it's the one number every pregame pick settles against, so
  it has to stop moving. Live side bet odds (`live_bets/{id}.odds`) are a
  completely different field on a completely different collection, set by
  whoever proposes the bet, and they're allowed to move for as long as the
  bet stays open — the proposer can post a new number anytime before it's
  resolved, the same way a sportsbook line moves during a game. The two
  never touch: nothing in the live-data engine writes to `live_bets`, and
  nothing in the sidebet flow reads `games.spread`.
- **Moving a live bet's odds never changes what someone already agreed
  to.** Each accepted response freezes the odds that were posted at the
  moment that player joined (`acceptedOdds` on their own response doc).
  If the proposer moves the line afterward, it only affects whoever joins
  next — settlement always pays each accepter at their own locked-in
  number, never the bet's current (possibly since-moved) odds.
- **Active Sidebets page** — a dedicated, sectioned view: bets waiting on
  your response, open pools you can still join, your own active bets, and
  everything currently open across the whole group.

## 1. Create the Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project**.
2. Enable **Firestore Database** (start in production mode — the rules file
   below locks it down properly).
3. Enable **Authentication → Sign-in method → Email/Password**. Players get
   a real password-protected account; they never see or type an actual
   email address — the app builds one behind the scenes from their name.
4. Project Settings → General → scroll to **Your apps** → click the `</>` web icon
   → register an app → copy the `firebaseConfig` object.
5. Paste those values into `js/firebase-config.js`.

## 1b. Get a free CollegeFootballData.com API key

1. Register at [collegefootballdata.com/key](https://collegefootballdata.com/key)
   (free, instant).
2. Paste it into `CFBD_API_KEY` in `js/firebase-config.js`. This is used
   by the manual "backup" sync button on the Standings page.
3. On the Standings page (as commissioner) you can now pull any week's
   games + spreads with one click — but see 1c below for the version
   that runs automatically without you doing this at all.

## 1c. (Optional, skip by default) Cloud Functions backend

The default setup — what you get by just following steps 1-5 below —
runs entirely client-side: **any signed-in player's device** keeps games,
scores, spread locks, and settlements refreshing automatically as long
as *someone* in the group has the app open. No billing, no deploy step,
nothing beyond the steps below. This is what the trade-off note in
`js/live-data-engine.js` and the loosened Firestore rules are about —
see that file for details.

If you later want this running on Google's actual servers instead —
genuinely 24/7 with zero dependency on anyone having a tab open, at the
cost of enabling Firebase's Blaze plan and running `firebase deploy` —
the code for that already exists in `functions/`. It's not required and
isn't part of the default setup path; ask if you want to switch to it.

## 2. Deploy Firestore rules

Install the Firebase CLI once: `npm install -g firebase-tools`

```bash
firebase login
firebase init firestore   # point it at this project, keep the default rules filename
firebase deploy --only firestore:rules
```

(Or paste `firestore.rules`'s contents directly into Console → Firestore →
Rules → publish, if you'd rather skip the CLI.)

## 3. Make yourself commissioner

Easiest path: when you create your account on `login.html`, enter `buns`
in the "Commissioner code" field — you're commissioner immediately, no
Firestore console needed. Anyone can also unlock it later from an existing
account via the box at the bottom of the Standings page.

Commissioner-only powers:
- Sync the week's games + spreads from CFBD, or add matchups by hand
- Settle a game (enter final score → payouts run automatically)
- Resolve live bets once an outcome is known
- Use the Offline Entry page to log bets/outcomes with no connection

## 4. Host on GitHub Pages

```bash
git init
git add .
git commit -m "Buckeye Book v1"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/buckeye-book-repo.git
git push -u origin main
```

Then: repo **Settings → Pages → Source → main branch → / (root)** → Save.
Your app will be live at `https://YOUR_USERNAME.github.io/buckeye-book-repo/`.

## 5. Add this week's games

Easiest path for now: commissioner adds matchups by hand via the form on
`ledger.html` (spread, kickoff time). If you want to wire in live spreads
automatically, `cfbd_betting_lines` from CollegeFootballData.com's free API
is the natural next step — same shape as the ESPN score pull your other
apps already use, just a different endpoint and an API key.

## Notes on what's simplified for v1

- **Settlement is automatic, driven by any signed-in user's device.**
  `live-data-engine.js` settles a game itself the moment CFBD reports it
  final — no clicking required in normal operation, and it doesn't need
  to be specifically the commissioner's device, just anyone's. The catch:
  it only runs while *someone's* device has a tab open (see below), and
  it relies on Firestore rules trusting any signed-in player to write
  these results — there's no server backstop verifying the math. A
  "Force Settle" button remains on Standings as a manual backup.
- **Odds-based group bets don't yet cap the proposer's total exposure**
  if many people accept — worth adding a check in `live.js`'s `proposeBet`
  before you run a big group challenge with real money.
- **Live win-probability-based odds** (the "next drive" prop idea) isn't
  wired in yet — right now odds are whatever the proposer types in. The
  field-position lookup table discussed earlier is the natural v2.
- Push/void handling for live bets with zero opposing action is basic —
  test with small stakes before a real game night.
- **Account security is friend-group-grade, not bank-grade.** Passwords
  are real Firebase Auth passwords (properly hashed by Firebase, not
  stored in plaintext), but the "email" behind each account is guessable
  from a player's name — fine for a closed group betting drinks/side
  cash, not something to reuse a real password on.
- **Offline entries skip the balance check.** Online actions verify a
  player can afford a wager before it goes through; offline entries use
  `increment()` instead of a transaction (transactions require a live
  connection), which means there's no automatic block on a commissioner
  accidentally sending someone negative. Worth a quick glance at the
  Standings page after reconnecting.
- **Multiple offline devices at once isn't reconciled.** If two different
  phones both go offline and log conflicting entries for the same bet,
  both sets of writes will sync and apply — there's no conflict detection
  across devices, only within a single device's queue.
- **The security rules trust any signed-in player, not just the
  commissioner, to write scores/spreads/settlements.** This is what
  makes "any user's device keeps things fresh" possible without a real
  backend — but it also means there's no server-side check stopping a
  player from directly editing another player's balance if they wanted
  to. Fine for a closed, trusted friend group; genuinely worth
  reconsidering (via the optional `functions/` Cloud Functions path
  instead) if the group ever grows past people you'd trust with that.
- **This engine needs *someone's* device open somewhere** — not
  specifically the commissioner's anymore, but still not a real 24/7
  server job. If literally everyone closes the app, data stops
  refreshing until someone reopens it (existing data stays visible, it
  just stops updating in the meantime).

## Cache-busting on every deploy

Every internal `import` in this project (in every `.html` and `.js` file)
carries a `?v=20260828d` query string. Browsers cache ES modules
aggressively — sometimes even surviving a hard refresh — so without this,
redeploying a fixed file doesn't guarantee anyone's browser actually picks
it up.

**Bump this version string every time you deploy a change**, or browsers
may keep serving the old cached version of whatever you just fixed. The
easiest way: find-and-replace every `20260828d` in the project with a new
value (today's date + a letter works fine, e.g. `20260901a`) before
copying files into your repo. A one-liner from the project root:

```bash
grep -rl "20260828d" . --include="*.html" --include="*.js" | xargs sed -i '' 's/20260828d/YOUR_NEW_VERSION/g'
```

(On Linux, drop the empty `''` after `-i`.)

## File map

```
index.html           hub — live scores, money flow, quick stats
picks.html            weekly ATS picks + pari-mutuel pot
live.html             propose + respond to live in-game bets
sidebets.html          sectioned view of everything currently open
ledger.html            all-time leaderboard, personal history, commissioner tools
offline.html            commissioner-only offline bet entry
rules.html              full house rules — scoring math, line locking, everything explained
login.html             account creation / sign in
css/style.css          OSU scarlet/black scoreboard design system
js/firebase-config.js    ← put your Firebase + CFBD keys here
js/app.js              auth, live balance chip, transaction helpers, offline balance adjust
js/cfbd.js              CollegeFootballData sync (used by both the manual backup button and live-data-engine.js)
js/picks.js             picks UI + settlement math
js/live.js              live bet propose/accept/resolve logic + reusable feed renderer
js/hub.js               home page live scores + money flow (reads only — engine writes)
js/ledger.js            leaderboard + commissioner tools
js/offline.js           offline entry form logic
js/live-data-engine.js   background: continuous score polling, 48h spread lock, auto-settle — runs on any signed-in user's device
functions/               optional: real always-on Cloud Functions alternative, not used by default
firestore.rules         security rules — deploy these before real money (note the trust trade-off documented inline)
```
