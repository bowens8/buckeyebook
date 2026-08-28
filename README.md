# The Shoe Pool

A real-time college football picks + live wagering app for the group.
Firestore backend, static frontend, deploys straight to GitHub Pages.

## What's built

- **Weekly ATS picks** — pari-mutuel pot, tiered + margin-scaled payouts
  (upset covers pay the most, capped at 3x scaling so no one game can drain
  the pot). Outright upset calls also earn a 🍁 leaf sticker. Picks can be
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
- **Continuous live data engine** — while any commissioner device has a tab
  open, scores refresh every 20 seconds during live games (5 minutes
  otherwise) and write straight to Firestore, so everyone sees updates in
  real time no matter which page they're on — not per-tab polling.
- **Automatic spread lock, 24 hours before kickoff** — lines move freely
  with the market until the 24-hour window, then freeze permanently. A
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
2. Paste it into `CFBD_API_KEY` in `js/firebase-config.js`.
3. On the Standings page (as commissioner) you can now pull any week's
   games + spreads with one click.

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
git commit -m "Shoe Pool v1"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/shoe-pool.git
git push -u origin main
```

Then: repo **Settings → Pages → Source → main branch → / (root)** → Save.
Your app will be live at `https://YOUR_USERNAME.github.io/shoe-pool/`.

## 5. Add this week's games

Easiest path for now: commissioner adds matchups by hand via the form on
`ledger.html` (spread, kickoff time). If you want to wire in live spreads
automatically, `cfbd_betting_lines` from CollegeFootballData.com's free API
is the natural next step — same shape as the ESPN score pull your other
apps already use, just a different endpoint and an API key.

## Notes on what's simplified for v1

- **Settlement is client-triggered, not a Cloud Function.** Since this is
  static hosting (no server), the commissioner's browser runs the payout
  math directly against Firestore. That's fine for a closed friend-group
  app; it just means the commissioner needs to actually click "Settle" —
  nothing resolves itself automatically off a live score feed yet.
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
- **The live data engine needs one commissioner tab open somewhere** —
  it's not a real server job, just a background loop in whichever
  commissioner browser session is active. If every commissioner closes
  their tab, scores/spreads stop refreshing until one reopens the app
  (existing data stays visible, it just stops updating). Moving this to
  a scheduled Cloud Function is the natural next step if that matters.

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
js/cfbd.js              CollegeFootballData sync + live score polling
js/picks.js             picks UI + settlement math
js/live.js              live bet propose/accept/resolve logic + reusable feed renderer
js/hub.js               home page live scores + money flow (reads only — engine writes)
js/live-data-engine.js   background: continuous score polling + 24h spread lock
js/ledger.js            leaderboard + commissioner tools
js/offline.js           offline entry form logic
firestore.rules         security rules — deploy these before real money
```
