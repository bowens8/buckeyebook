// ============================================================
// HUB — live scoreboard strip + "where the money is" view.
// Scores come straight from Firestore via onSnapshot — the background
// live data engine (js/live-data-engine.js), running on whichever
// signed-in user's device happens to be open, is what keeps those
// fields fresh, so every viewer here gets true real-time updates with
// zero CFBD calls of their own.
// ============================================================
import { db } from "./firebase-config.js?v=20260828h";
import { collection, doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const scoresEl = document.getElementById("live-scores");
const flowEl = document.getElementById("money-flow");

let latestGames = [];
let latestPicks = [];
let latestBets = [];
let latestResponses = [];
let latestSyncSettings = null; // null = not loaded yet, show everything rather than hide games prematurely

const LOCK_WINDOW_MS = 48 * 60 * 60 * 1000; // matches the engine's actual lock rule + picks.js
function isWithinLockWindow(game) {
  return game.kickoffMs && Date.now() >= (game.kickoffMs - LOCK_WINDOW_MS);
}

// Only show games that match what the commissioner currently has synced.
// Games missing division/conference tags (synced before this feature, or
// added manually) are always shown — no way to know if they'd match, and
// hiding them by default would be a worse failure mode than showing an
// occasional extra game.
function matchesSyncScope(game) {
  if (!latestSyncSettings) return true;
  if (!game.division) return true;
  if (!latestSyncSettings.divisions.includes(game.division)) return false;
  if (latestSyncSettings.conferences.length && !latestSyncSettings.conferences.includes(game.conference)) return false;
  return true;
}

// ---------- live scores ----------
export function renderLiveScores() {
  onSnapshot(collection(db, "games"), (snap) => {
    latestGames = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.kickoffMs ?? Infinity) - (b.kickoffMs ?? Infinity));
    drawScores();
  });
  onSnapshot(doc(db, "settings", "sync"), (snap) => {
    latestSyncSettings = snap.exists()
      ? { divisions: snap.data().divisions?.length ? snap.data().divisions : ["fbs"], conferences: snap.data().conferences || [] }
      : { divisions: ["fbs"], conferences: [] };
    drawScores();
  }, (err) => {
    console.warn("Couldn't load sync settings for hub filtering:", err);
  });
}

function drawScores() {
  const visibleGames = latestGames.filter(matchesSyncScope);
  if (!visibleGames.length) {
    scoresEl.innerHTML = `<div class="empty-state">No games tracked yet — sync a week from the Standings page.</div>`;
    return;
  }
  scoresEl.innerHTML = visibleGames.map(g => {
    const statusLabel = g.liveStatus === "final" ? "FINAL"
      : g.liveStatus === "live" ? `Q${g.period ?? "?"} ${g.clock ?? ""}`
      : new Date(g.kickoffMs || 0).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
    const lineTag = (g.spreadLocked || isWithinLockWindow(g))
      ? `<span class="pill" style="margin-left:4px;">line locked</span>`
      : g.spread != null ? `<span class="pill" style="margin-left:4px;">line moving</span>` : "";
    return `
      <div class="score-card">
        <div class="score-status">${statusLabel}${lineTag}</div>
        <div class="score-row">
          <span>${g.awayTeam}</span>
          <span class="score-num">${g.awayScore ?? "-"}</span>
        </div>
        <div class="score-row">
          <span>${g.homeTeam}</span>
          <span class="score-num">${g.homeScore ?? "-"}</span>
        </div>
      </div>
    `;
  }).join("");
}

// ---------- money flow ----------
export function renderMoneyFlow() {
  onSnapshot(collection(db, "picks"), (snap) => {
    latestPicks = snap.docs.map(d => d.data());
    drawFlow();
  });
  onSnapshot(collection(db, "live_bets"), (snap) => {
    latestBets = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    drawFlow();
  });
  onSnapshot(collection(db, "live_bet_responses"), (snap) => {
    latestResponses = snap.docs.map(d => d.data());
    drawFlow();
  });
}

function drawFlow() {
  if (!latestGames.length && !latestBets.length) {
    flowEl.innerHTML = `<div class="empty-state">No money in play yet.</div>`;
    return;
  }

  // Pot per weekly pick game
  const gamePots = latestGames.map(g => {
    const pot = latestPicks.filter(p => p.gameId === g.id).reduce((s, p) => s + p.wagerAmount, 0);
    return { label: `${g.awayTeam} @ ${g.homeTeam}`, amount: pot };
  }).filter(x => x.amount > 0);

  // Pot per open/live side bet
  const betPots = latestBets.filter(b => b.status !== "settled" || true).map(b => {
    const responseTotal = latestResponses.filter(r => r.betId === b.id && r.response === "accepted")
      .reduce((s, r) => s + (r.wagerAmount || 0), 0);
    return {
      label: b.description,
      amount: (b.proposerWager || 0) + responseTotal,
      settled: b.status === "settled"
    };
  }).filter(x => x.amount > 0);

  const all = [...gamePots.map(x => ({ ...x, type: "Weekly Pick" })), ...betPots.map(x => ({ ...x, type: x.settled ? "Side Bet · settled" : "Side Bet · open" }))]
    .sort((a, b) => b.amount - a.amount);

  const max = Math.max(...all.map(x => x.amount), 1);
  const total = all.reduce((s, x) => s + x.amount, 0);

  flowEl.innerHTML = `
    <div style="font-family:'Anton';font-size:28px;color:var(--buckeye-shine);margin-bottom:14px;">
      $${total.toFixed(0)} <span style="font-family:'Oswald';font-size:12px;color:var(--gray-light);">total in play</span>
    </div>
    ${all.map(x => `
      <div class="money-row">
        <div class="money-label">${x.label} <span class="money-type">${x.type}</span></div>
        <div class="money-bar-track"><div class="money-bar-fill" style="width:${(x.amount / max) * 100}%"></div></div>
        <div class="money-amt">$${x.amount.toFixed(0)}</div>
      </div>
    `).join("") || `<div class="empty-state">No money in play yet.</div>`}
  `;
}
