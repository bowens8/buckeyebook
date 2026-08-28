// ============================================================
// CFBD SYNC — pulls this week's FBS matchups + Vegas spreads from
// CollegeFootballData.com and writes them into Firestore `games`,
// keyed by CFBD's own game id so re-syncing never duplicates.
// Commissioner-only action, triggered from ledger.html.
// ============================================================
import { db, CFBD_API_KEY } from "./firebase-config.js";
import { doc, setDoc, getDocs, collection, query, where, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const BASE = "https://api.collegefootballdata.com";

async function cfbdGet(path) {
  const res = await fetch(BASE + path, {
    headers: { Authorization: `Bearer ${CFBD_API_KEY}` }
  });
  if (!res.ok) throw new Error(`CFBD request failed: ${res.status}`);
  return res.json();
}

// year/week: numbers, e.g. syncWeek(2026, 5)
export async function syncWeek(year, week, seasonType = "regular") {
  const [games, lines, existingSnap] = await Promise.all([
    cfbdGet(`/games?year=${year}&week=${week}&seasonType=${seasonType}&division=fbs`),
    cfbdGet(`/lines?year=${year}&week=${week}&seasonType=${seasonType}`),
    getDocs(query(collection(db, "games"), where("year", "==", year), where("week", "==", week)))
  ]);

  // Once the background engine has locked a line, a manual re-sync must
  // never overwrite it — otherwise "the odds lock 48h out" would be a lie
  // the moment someone re-syncs the week for a score refresh.
  const lockedIds = new Set(
    existingSnap.docs.filter(d => d.data().spreadLocked).map(d => d.data().cfbdId)
  );

  const lineByGame = {};
  lines.forEach(l => {
    // Prefer a consensus/major-book line if present, else the first available.
    const preferred = l.lines?.find(ln => ln.provider === "consensus") || l.lines?.[0];
    if (preferred?.spread != null) lineByGame[l.id] = parseFloat(preferred.spread);
  });

  let count = 0;
  for (const g of games) {
    if (!g.homeTeam || !g.awayTeam) continue;
    const payload = {
      cfbdId: g.id,
      year, week, seasonType,
      homeTeam: g.homeTeam,
      awayTeam: g.awayTeam,
      kickoffMs: g.startDate ? new Date(g.startDate).getTime() : null,
      venue: g.venue || null,
      status: "scheduled",
      source: "cfbd",
      syncedAt: serverTimestamp()
    };
    // CFBD's spread convention: negative means home team favored — same
    // convention the settlement math in picks.js already expects.
    if (!lockedIds.has(g.id)) payload.spread = lineByGame[g.id] ?? null;

    await setDoc(doc(db, "games", String(g.id)), payload, { merge: true });
    count++;
  }
  return count;
}

// ---------- auto-discover and sync the current + next CFBD week ----------
// Uses CFBD's own calendar data to figure out which week it actually is —
// no one has to know or enter a week number. Called automatically by
// live-data-engine.js so games appear without any manual sync click.
export async function autoSyncActiveWeeks() {
  const year = new Date().getUTCFullYear();
  const calendar = await cfbdGet(`/calendar?year=${year}`);
  const now = Date.now();
  const regular = calendar
    .filter(w => w.seasonType === "regular")
    .sort((a, b) => new Date(a.firstGameStart) - new Date(b.firstGameStart));

  // "Current" = the week whose date range we're inside (with a few days
  // of slack), or the nearest upcoming one if we're between weeks.
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

  let total = 0;
  for (const w of weeks) {
    total += await syncWeek(year, w.week, "regular");
  }
  return total;
}

// ---------- line polling (read-only, client-side) ----------
// Same grouping trick as fetchLiveScores — one call per distinct
// year/week rather than one per game. Returns cfbdId -> spread.
export async function fetchLines(trackedGames) {
  const byWeek = {};
  trackedGames.forEach(g => {
    if (!g.year || !g.week) return;
    const key = `${g.year}-${g.week}-${g.seasonType || "regular"}`;
    (byWeek[key] ||= []).push(g);
  });

  const lineMap = {};
  await Promise.all(Object.entries(byWeek).map(async ([key]) => {
    const [year, week, seasonType] = key.split("-");
    const lines = await cfbdGet(`/lines?year=${year}&week=${week}&seasonType=${seasonType}`);
    lines.forEach(l => {
      const preferred = l.lines?.find(ln => ln.provider === "consensus") || l.lines?.[0];
      if (preferred?.spread != null) lineMap[l.id] = parseFloat(preferred.spread);
    });
  }));
  return lineMap;
}

// ---------- live score polling (read-only wrapper around CFBD) ----------
// Groups tracked games by year/week so a poll of many games only costs
// one API call per distinct week. Returns a map keyed by cfbdId. Used
// by live-data-engine.js for continuous score refresh.
export async function fetchLiveScores(trackedGames) {
  const byWeek = {};
  trackedGames.forEach(g => {
    if (!g.year || !g.week) return;
    const key = `${g.year}-${g.week}-${g.seasonType || "regular"}`;
    (byWeek[key] ||= []).push(g);
  });

  const scoreMap = {};
  await Promise.all(Object.entries(byWeek).map(async ([key, groupGames]) => {
    const [year, week, seasonType] = key.split("-");
    const games = await cfbdGet(`/games?year=${year}&week=${week}&seasonType=${seasonType}&division=fbs`);
    games.forEach(g => {
      scoreMap[g.id] = {
        homePoints: g.homePoints, awayPoints: g.awayPoints,
        status: g.completed ? "final" : (g.homePoints != null || g.awayPoints != null ? "live" : "scheduled"),
        period: g.period, clock: g.clock
      };
    });
  }));
  return scoreMap;
}
