// ============================================================
// THE BUCKEYE BOOK — SCHEDULED BACKEND
//
// This runs on Google's infrastructure on a fixed schedule, completely
// independent of whether anyone has the app open. It replaces what used
// to be a client-side "live data engine" that only worked while a
// commissioner had a browser tab open — everything here happens
// whether or not a single person is looking at the site.
//
// Two scheduled jobs:
//   syncWeeklyGames  — once a day, pulls the current + next CFBD week's
//                       matchups and spreads, so games appear on their
//                       own without a commissioner ever running a sync.
//   pollLiveData     — every 5 minutes, refreshes scores, locks any
//                       spread that's crossed the 48-hour-before-kickoff
//                       window, and auto-settles any game CFBD reports
//                       as final.
//
// Uses the Firebase Admin SDK, which bypasses Firestore security rules
// entirely — that's expected and correct for trusted server code.
// ============================================================
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const CFBD_API_KEY = defineSecret("CFBD_API_KEY");
const LOCK_WINDOW_MS = 48 * 60 * 60 * 1000; // house rule: lines freeze 48h before kickoff

async function cfbdGet(path, apiKey) {
  const res = await fetch(`https://api.collegefootballdata.com${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!res.ok) throw new Error(`CFBD ${path} failed: ${res.status}`);
  return res.json();
}

// ---------- figure out which weeks matter right now ----------
async function getActiveWeeks(apiKey) {
  const year = new Date().getUTCFullYear();
  const calendar = await cfbdGet(`/calendar?year=${year}`, apiKey);
  const now = Date.now();
  const regular = calendar
    .filter(w => w.seasonType === "regular")
    .sort((a, b) => new Date(a.firstGameStart) - new Date(b.firstGameStart));

  // "Current" = whichever week's date range we're inside (with a few
  // days of slack on both ends), or the nearest upcoming one if we're
  // between weeks. We also grab the week after it, so games appear with
  // enough lead time to matter before the 48h lock is even relevant.
  let current = regular.find(w => {
    const start = new Date(w.firstGameStart).getTime() - 3 * 24 * 60 * 60 * 1000;
    const end = new Date(w.lastGameStart).getTime() + 24 * 60 * 60 * 1000;
    return now >= start && now <= end;
  });
  if (!current) {
    current = regular.find(w => new Date(w.firstGameStart).getTime() > now) || regular[regular.length - 1];
  }
  const idx = regular.indexOf(current);
  const weeks = [current, regular[idx + 1]].filter(Boolean);
  return { year, weeks };
}

// ---------- sync games + lines (skips any already-locked spread) ----------
async function syncWeeks(apiKey) {
  const { year, weeks } = await getActiveWeeks(apiKey);
  let total = 0;

  for (const w of weeks) {
    const week = w.week;
    const [games, lines, existingSnap] = await Promise.all([
      cfbdGet(`/games?year=${year}&week=${week}&seasonType=regular&division=fbs`, apiKey),
      cfbdGet(`/lines?year=${year}&week=${week}&seasonType=regular`, apiKey),
      db.collection("games").where("year", "==", year).where("week", "==", week).get()
    ]);

    const lockedIds = new Set(existingSnap.docs.filter(d => d.data().spreadLocked).map(d => d.data().cfbdId));
    const lineByGame = {};
    lines.forEach(l => {
      const preferred = l.lines?.find(ln => ln.provider === "consensus") || l.lines?.[0];
      if (preferred?.spread != null) lineByGame[l.id] = parseFloat(preferred.spread);
    });

    const batch = db.batch();
    for (const g of games) {
      if (!g.homeTeam || !g.awayTeam) continue;
      const ref = db.collection("games").doc(String(g.id));
      const payload = {
        cfbdId: g.id, year, week, seasonType: "regular",
        homeTeam: g.homeTeam, awayTeam: g.awayTeam,
        kickoffMs: g.startDate ? new Date(g.startDate).getTime() : null,
        venue: g.venue || null,
        status: "scheduled", source: "cfbd-auto",
        syncedAt: FieldValue.serverTimestamp()
      };
      if (!lockedIds.has(g.id)) payload.spread = lineByGame[g.id] ?? null;
      batch.set(ref, payload, { merge: true });
      total++;
    }
    await batch.commit();
  }
  return total;
}

// ---------- score polling + 48h lock + auto-settle ----------
async function pollScoresAndSettle(apiKey) {
  const now = Date.now();
  const gamesSnap = await db.collection("games").get();
  const games = gamesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const trackedByWeek = {};
  games.forEach(g => {
    if (!g.year || !g.week) return;
    const key = `${g.year}-${g.week}-${g.seasonType || "regular"}`;
    (trackedByWeek[key] ||= []).push(g);
  });

  for (const [key, groupGames] of Object.entries(trackedByWeek)) {
    const [year, week, seasonType] = key.split("-");
    const needsLines = groupGames.some(g => !g.spreadLocked);
    const [liveGames, lines] = await Promise.all([
      cfbdGet(`/games?year=${year}&week=${week}&seasonType=${seasonType}&division=fbs`, apiKey),
      needsLines ? cfbdGet(`/lines?year=${year}&week=${week}&seasonType=${seasonType}`, apiKey) : Promise.resolve([])
    ]);

    const scoreMap = {};
    liveGames.forEach(g => {
      scoreMap[g.id] = {
        homePoints: g.homePoints, awayPoints: g.awayPoints,
        status: g.completed ? "final" : (g.homePoints != null || g.awayPoints != null ? "live" : "scheduled"),
        period: g.period, clock: g.clock
      };
    });
    const lineMap = {};
    lines.forEach(l => {
      const preferred = l.lines?.find(ln => ln.provider === "consensus") || l.lines?.[0];
      if (preferred?.spread != null) lineMap[l.id] = parseFloat(preferred.spread);
    });

    for (const g of groupGames) {
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
          updates.spreadLockedAt = FieldValue.serverTimestamp();
        } else if (marketSpread != null && marketSpread !== g.spread) {
          updates.spread = marketSpread;
        }
      }

      if (live?.status === "final" && !g.autoSettled && live.homePoints != null && live.awayPoints != null) {
        try {
          await settleGame(g.id, live.homePoints, live.awayPoints);
          updates.autoSettled = true;
          updates.autoSettledAt = FieldValue.serverTimestamp();
        } catch (err) {
          console.warn("Auto-settle failed for", g.id, err);
        }
      }

      if (Object.keys(updates).length) {
        updates.lastPolledAt = FieldValue.serverTimestamp();
        await db.collection("games").doc(g.id).update(updates).catch(err => console.warn("Score write failed", g.id, err));
      }
    }
  }
}

// ---------- settlement math (mirrors js/picks.js exactly — same house rules) ----------
async function settleGame(gameId, homeScore, awayScore) {
  const picksSnap = await db.collection("picks").where("gameId", "==", gameId).get();
  const gameDoc = await db.collection("games").doc(gameId).get();
  const game = gameDoc.data();
  const spread = game.spread ?? 0;
  const actualMargin = homeScore - awayScore;

  const picks = picksSnap.docs.map(d => ({ ref: d.ref, ...d.data() })).filter(p => !p.settled);
  if (!picks.length) return;
  const pot = picks.reduce((s, p) => s + p.wagerAmount, 0);

  const scored = picks.map(p => {
    const pickedHome = p.side === "home";
    const teamMargin = pickedHome ? actualMargin : -actualMargin;
    const teamSpread = pickedHome ? -spread : spread;
    const coverMargin = teamMargin + teamSpread;
    if (coverMargin === 0) return { ...p, result: "push", payout: p.wagerAmount, weighted: 0 };

    const wonOutright = teamMargin > 0;

    if (coverMargin < 0) {
      // Missed the cover. Still won outright (only possible for a
      // favorite) = Tier 4, flat 0.5x. Genuinely lost outright = 0x.
      if (wonOutright) return { ...p, result: "win", multiplier: 0.5, weighted: p.wagerAmount * 0.5 };
      return { ...p, result: "loss", payout: 0, weighted: 0 };
    }

    const isDog = teamSpread > 0;
    const base = (isDog && wonOutright) ? 2.0 : 1.0;
    const spreadAbs = Math.abs(teamSpread) || 1;
    const scale = Math.min(1 + coverMargin / spreadAbs, 3.0);
    return { ...p, result: "win", multiplier: base * scale, weighted: p.wagerAmount * base * scale };
  });

  const totalWeighted = scored.reduce((s, p) => s + (p.weighted || 0), 0);
  const pushRefunds = scored.filter(p => p.result === "push").reduce((s, p) => s + p.wagerAmount, 0);
  const distributable = pot - pushRefunds;

  for (const p of scored) {
    if (p.result === "push") {
      await creditBalance(p.playerId, p.wagerAmount, "pick_push_refund", gameId);
      await p.ref.update({ settled: true, result: "push", payout: p.wagerAmount });
    } else if (p.result === "win") {
      const payout = totalWeighted > 0 ? distributable * (p.weighted / totalWeighted) : 0;
      await creditBalance(p.playerId, payout, "pick_payout", gameId);
      if (p.multiplier >= 2) await awardLeaf(p.playerId);
      await p.ref.update({ settled: true, result: "win", payout });
    } else {
      await p.ref.update({ settled: true, result: "loss", payout: 0 });
    }
  }
}

async function creditBalance(uid, amount, reason, refId) {
  const ref = db.collection("players").doc(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const bal = snap.data().balance;
    const net = snap.data().allTimeNet || 0;
    tx.update(ref, { balance: bal + amount, allTimeNet: net + amount });
  });
  await db.collection("ledger").add({
    playerId: uid, amount, reason, refId, createdAt: FieldValue.serverTimestamp()
  });
}

async function awardLeaf(uid) {
  const ref = db.collection("players").doc(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    tx.update(ref, { leafStickers: (snap.data().leafStickers || 0) + 1 });
  });
}

// ---------- scheduled triggers ----------
exports.syncWeeklyGames = onSchedule(
  { schedule: "every 24 hours", secrets: [CFBD_API_KEY] },
  async () => {
    const count = await syncWeeks(CFBD_API_KEY.value());
    console.log(`Auto-synced ${count} games.`);
  }
);

exports.pollLiveData = onSchedule(
  { schedule: "every 5 minutes", secrets: [CFBD_API_KEY] },
  async () => {
    await pollScoresAndSettle(CFBD_API_KEY.value());
  }
);
