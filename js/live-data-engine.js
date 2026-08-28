// ============================================================
// LIVE DATA ENGINE — runs continuously in the background (adaptive
// interval, not tied to any one page) for whichever commissioner
// device has a tab open. It's the ONE thing writing scores/spreads
// back to Firestore; everyone else just reads via onSnapshot, so
// scores update live for the whole group regardless of what page
// they're looking at — no per-tab polling needed on their end.
//
// Spread lock rule: once we're within 24 hours of kickoff, whatever
// line CFBD is showing gets frozen permanently as `spread` and
// `spreadLocked` flips true. Before that window the line is free to
// keep moving with the market, same as a real sportsbook's opening
// line vs. closing line.
// ============================================================
import { db } from "./firebase-config.js";
import { collection, onSnapshot, doc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { fetchLiveScores, fetchLines } from "./cfbd.js";
import { currentUser } from "./app.js";

const LOCK_WINDOW_MS = 24 * 60 * 60 * 1000;
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
  // Only a commissioner's session is trusted to write; everyone else's
  // engine call (if it ever ran) would just skip the write step below.
  if (!currentUser?.isCommissioner) return;
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
        updates.spread = marketSpread; // line still moving pre-lock
      }
    }

    if (Object.keys(updates).length) {
      updates.lastPolledAt = serverTimestamp();
      updateDoc(doc(db, "games", g.id), updates).catch(err => console.warn("Score write failed for", g.id, err));
    }
  }
}

// Adaptive cadence: fast during live games, moderate as kickoff/lock
// approaches, slow otherwise — keeps this "constant" without hammering
// CFBD's free-tier rate limits when nothing's actually changing.
function computeDelay() {
  const now = Date.now();
  if (trackedGames.some(g => g.liveStatus === "live")) return 20 * 1000;
  if (trackedGames.some(g => g.kickoffMs && !g.spreadLocked && (g.kickoffMs - now) < LOCK_WINDOW_MS + 60 * 60 * 1000)) {
    return 5 * 60 * 1000;
  }
  return 15 * 60 * 1000;
}
