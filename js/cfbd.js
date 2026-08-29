// ============================================================
// CFBD SYNC — pulls this week's FBS matchups + Vegas spreads from
// CollegeFootballData.com and writes them into Firestore `games`,
// keyed by CFBD's own game id so re-syncing never duplicates.
// Commissioner-only action, triggered from ledger.html.
// ============================================================
import { db, CFBD_API_KEY } from "./firebase-config.js?v=20260828n";
import { doc, getDoc, setDoc, getDocs, collection, query, where, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const BASE = "https://api.collegefootballdata.com";

async function cfbdGet(path) {
  const res = await fetch(BASE + path, {
    headers: { Authorization: `Bearer ${CFBD_API_KEY}` }
  });
  if (!res.ok) throw new Error(`CFBD request failed: ${res.status}`);
  return res.json();
}

// ---------- fetch the real list of conferences from CFBD ----------
// Used to build an actual checkbox list in the commissioner UI instead
// of making someone type in cryptic short codes from memory.
let conferenceListCache = null;
export async function fetchConferenceList() {
  if (conferenceListCache) return conferenceListCache;
  const list = await cfbdGet(`/conferences`);
  conferenceListCache = list.map(c => ({
    abbreviation: c.abbreviation || c.name,
    name: c.name,
    classification: (c.classification || "fbs").toLowerCase()
  })).sort((a, b) => a.name.localeCompare(b.name));
  return conferenceListCache;
}

// ---------- commissioner-controlled sync scope ----------
// Which divisions (and optionally specific conferences within them) get
// pulled in, both by the manual sync button and the auto-discovery
// engine. Defaults to FBS/all-conferences if nothing's been configured.
export async function getSyncSettings() {
  const snap = await getDoc(doc(db, "settings", "sync"));
  if (!snap.exists()) return { divisions: ["fbs"], conferences: [], tvOnly: false, tvNetworks: [] };
  const d = snap.data();
  return {
    divisions: d.divisions?.length ? d.divisions : ["fbs"],
    conferences: d.conferences || [], // empty = no conference filter within the chosen division(s)
    tvOnly: d.tvOnly || false, // when true, only games with a known national broadcast/stream get synced
    tvNetworks: d.tvNetworks || [] // empty = any outlet counts; otherwise only these specific ones
  };
}

export async function saveSyncSettings(divisions, conferences, tvOnly, tvNetworks) {
  await setDoc(doc(db, "settings", "sync"), { divisions, conferences, tvOnly, tvNetworks, updatedAt: serverTimestamp() });
}

// Builds the division/conference query-string combos to fetch. Multiple
// divisions and/or conferences mean multiple CFBD calls merged together,
// since the API only accepts one of each per request.
function buildScopeCombos({ divisions, conferences }) {
  const divs = divisions.length ? divisions : ["fbs"];
  if (!conferences.length) return divs.map(division => ({ division, conference: null }));
  return divs.flatMap(division => conferences.map(conference => ({ division, conference })));
}

// year/week: numbers, e.g. syncWeek(2026, 5)
export async function syncWeek(year, week, seasonType = "regular") {
  const settings = await getSyncSettings();
  const combos = buildScopeCombos(settings);

  const [gameResults, lineResults, existingSnap] = await Promise.all([
    Promise.all(combos.map(c => cfbdGet(
      `/games?year=${year}&week=${week}&seasonType=${seasonType}&division=${c.division}${c.conference ? `&conference=${c.conference}` : ""}`
    ))),
    Promise.all(combos.map(c => cfbdGet(
      `/lines?year=${year}&week=${week}&seasonType=${seasonType}${c.conference ? `&conference=${c.conference}` : ""}`
    ))),
    getDocs(query(collection(db, "games"), where("year", "==", year), where("week", "==", week)))
  ]);

  // Broadcast data is fetched separately from games/lines above, in its
  // own try/catch — if CFBD's media endpoint errors out or the response
  // shape doesn't match what's expected, that must NOT take down the
  // whole sync (games/lines already succeeded and shouldn't be lost).
  // Field names are also read defensively (a couple of plausible
  // variants tried for both the game id and the outlet name) since this
  // endpoint's exact schema wasn't verified against the live API.
  let outletByGame = {};
  let tvFetchOk = true;
  if (settings.tvOnly) {
    try {
      const mediaResults = await cfbdGet(`/games/media?year=${year}&week=${week}&seasonType=${seasonType}`);
      mediaResults.forEach(m => {
        const gameId = m.id ?? m.gameId ?? m.game_id;
        const outlet = m.outlet ?? m.network ?? m.mediaType ?? m.media_type ?? m.name;
        if (gameId != null && outlet && !outletByGame[gameId]) outletByGame[gameId] = outlet;
      });
      if (!Object.keys(outletByGame).length) tvFetchOk = false; // suspicious — likely a schema mismatch, not "no TV games this week"
    } catch (err) {
      console.warn("TV/media fetch failed, skipping TV filter for this sync:", err);
      tvFetchOk = false;
    }
  }

  // Merge + de-dupe by game id, since overlapping combos (e.g. two
  // conferences within the same division call) can return the same game.
  // Also tag each game with which combo actually matched it, so the
  // display layer (Home hub) can filter against CURRENT settings even
  // if this game was originally synced under a looser/different scope.
  const gameById = new Map();
  gameResults.forEach((games, i) => {
    const combo = combos[i];
    games.forEach(g => {
      if (!gameById.has(g.id)) gameById.set(g.id, { ...g, _syncDivision: combo.division, _syncConference: combo.conference });
    });
  });
  let games = [...gameById.values()];

  // "Big ticket" filter: only keep games with a known broadcast outlet,
  // optionally narrowed further to a specific list of networks. Skipped
  // entirely (rather than zeroing out every game) if the broadcast data
  // itself couldn't be fetched or parsed this time.
  if (settings.tvOnly && tvFetchOk) {
    games = games.filter(g => {
      const outlet = outletByGame[g.id];
      if (!outlet) return false;
      if (!settings.tvNetworks.length) return true;
      return settings.tvNetworks.some(n => outlet.toUpperCase().includes(n.toUpperCase()));
    });
  }

  const lines = lineResults.flat();

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
      division: g._syncDivision,
      conference: g._syncConference || g.homeConference || null,
      tvOutlet: outletByGame[g.id] || null,
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
  return { count, tvFilterApplied: !settings.tvOnly || tvFetchOk };
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
    total += (await syncWeek(year, w.week, "regular")).count;
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
//
// Deliberately doesn't filter by division here — it just pulls every
// game for that year/week/seasonType and looks up scores by cfbdId, so
// whatever divisions the commissioner chose to sync (see syncWeek) all
// get their scores refreshed correctly without this needing to know
// the sync settings itself.
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
    const games = await cfbdGet(`/games?year=${year}&week=${week}&seasonType=${seasonType}`);
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
