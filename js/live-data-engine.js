// ============================================================
// LIVE DATA ENGINE — runs in the background on ANY signed-in user's
// device, not just a commissioner's. That's the whole point: it means
// data refreshes as long as *someone* — anyone in the group — has the
// app open, instead of depending on one specific commissioner tab.
//
// The trade-off, stated plainly: this only works because the Firestore
// security rules were loosened to let any signed-in player write scores,
// lock spreads, and settle payouts (see firestore.rules) — not just the
// commissioner. For a closed friend group that's a reasonable trade for
// not needing a real backend, but it does mean there's no server-side
// backstop verifying the money math anymore; it's running on trust.
//
// Spread lock rule: once within 48 hours of kickoff, whatever line CFBD
// is showing gets frozen permanently. Before that, it moves with CFBD.
// ============================================================
import { db } from "./firebase-config.js?v=20260828h";
import { collection, onSnapshot, doc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { fetchLiveScores, fetchLines, autoSyncActiveWeeks } from "./cfbd.js?v=20260828h";
import { currentUser } from "./app.js?v=20260828h";
import { settleGame } from "./picks.js?v=20260828h";

const LOCK_WINDOW_MS = 48 * 60 * 60 * 1000;
const AUTO_SYNC_THROTTLE_MS = 12 * 60 * 60 * 1000; // don't re-check the calendar more than twice a day per device
let trackedGames = [];
let engineStarted = false;

export function startLiveDataEngine() {
  if (engineStarted) return;
  engineStarted = true;

  onSnapshot(collection(db, "games"), (snap) => {
    trackedGames = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  });

  scheduleNext();
}

async function scheduleNext() {
  await tick().catch(err => console.warn("Live data tick failed", err));
  setTimeout(scheduleNext, computeDelay());
}

async function tick() {
  // Any signed-in user can drive this now — no isCommissioner check.
  if (!currentUser) return;

  // This runs BEFORE the "any games tracked?" check below — otherwise a
  // brand new pool with zero games would never get past the empty-check
  // to discover any in the first place.
  await maybeAutoSyncWeeks();

  const pollable = trackedGames.filter(g => g.year && g.week);
  if (!pollable.length) return;

  const now = Date.now();
  const unlockedNeedingCheck = pollable.filter(g => !g.spreadLocked && g.kickoffMs);

  const [scoreMap, lineMap] = await Promise.all([
    fetchLiveScores(pollable),
    unlockedNeedingCheck.length ? fetchLines(unlockedNeedingCheck) : Promise.resolve({})
  ]);

  for (const g of pollable) {
    const updates = {};
    const live = scoreMap[g.cfbdId];
    if (live) {
      updates.homeScore = live.homePoints ?? null;
      updates.awayScore = live.awayPoints ?? null;
      updates.liveStatus = live.status;
      updates.period = live.period ?? null;
      updates.clock = live.clock ?? null;
    }

    if (!g.spreadLocked && g.kickoffMs) {
      const marketSpread = lineMap[g.cfbdId];
      const withinLockWindow = now >= (g.kickoffMs - LOCK_WINDOW_MS);
      if (withinLockWindow) {
        updates.spread = marketSpread ?? g.spread ?? null;
        updates.spreadLocked = true;
        updates.spreadLockedAt = serverTimestamp();
      } else if (marketSpread != null && marketSpread !== g.spread) {
        updates.spread = marketSpread;
      }
    }

    // Auto-settle: whoever's client happens to be polling when a game
    // goes final runs the payout math. Guarded by `autoSettled` so it
    // only ever happens once, regardless of how many different players'
    // devices are independently polling at the same time.
    if (live?.status === "final" && !g.autoSettled && live.homePoints != null && live.awayPoints != null) {
      try {
        await settleGame(g.id, live.homePoints, live.awayPoints);
        updates.autoSettled = true;
        updates.autoSettledAt = serverTimestamp();
      } catch (err) {
        console.warn("Auto-settle failed for", g.id, err);
      }
    }

    if (Object.keys(updates).length) {
      updates.lastPolledAt = serverTimestamp();
      updateDoc(doc(db, "games", g.id), updates).catch(err => console.warn("Score write failed for", g.id, err));
    }
  }
}

// Throttled per-device via localStorage — CFBD's calendar endpoint and a
// full games+lines pull is more expensive than a score poll, so this
// only actually runs a couple of times a day per device rather than on
// every single tick. A brand new pool with zero games still gets synced
// on the very first tick, since there's nothing in localStorage yet.
async function maybeAutoSyncWeeks() {
  const last = parseInt(localStorage.getItem("buckeyebook_last_auto_sync") || "0", 10);
  if (Date.now() - last < AUTO_SYNC_THROTTLE_MS) return;
  try {
    const count = await autoSyncActiveWeeks();
    localStorage.setItem("buckeyebook_last_auto_sync", String(Date.now()));
    if (count) console.log(`Auto-synced ${count} games from CFBD.`);
  } catch (err) {
    console.warn("Auto week-sync failed", err);
  }
}

// Adaptive cadence: fast during live games, moderate near kickoff/lock,
// slow otherwise — keeps this "constant" without hammering CFBD's
// free-tier rate limits when nothing's actually changing. With multiple
// players' devices potentially polling at once, this also keeps total
// API usage reasonable even with several tabs open simultaneously.
function computeDelay() {
  const now = Date.now();
  if (trackedGames.some(g => g.liveStatus === "live")) return 30 * 1000;
  if (trackedGames.some(g => g.kickoffMs && !g.spreadLocked && (g.kickoffMs - now) < LOCK_WINDOW_MS + 60 * 60 * 1000)) {
    return 5 * 60 * 1000;
  }
  return 15 * 60 * 1000;
}
