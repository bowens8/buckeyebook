// ============================================================
// LEDGER — live all-time leaderboard (net $ won/lost), personal
// transaction history, and commissioner tools: CFBD weekly sync,
// manual matchup entry, game settlement, commissioner grants.
// ============================================================
import { db } from "./firebase-config.js";
import {
  collection, addDoc, doc, updateDoc, onSnapshot, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { currentUser } from "./app.js";
import { settleGame } from "./picks.js";
import { syncWeek } from "./cfbd.js";
import { COMMISSIONER_CODE } from "./firebase-config.js";

const standingsEl = document.getElementById("standings");
const historyEl = document.getElementById("history");
const commishEl = document.getElementById("commish-tools");

// ---------- all-time leaderboard, sorted by net (not raw balance) ----------
export function renderStandings() {
  onSnapshot(collection(db, "players"), (snap) => {
    const players = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .map(p => ({ ...p, net: p.balance - (p.startingBalance ?? 500) }))
      .sort((a, b) => b.net - a.net);

    standingsEl.innerHTML = players.map((p, i) => `
      <div class="helmet-row">
        <div style="width:20px;font-family:'Anton';color:var(--gray-light);">${i + 1}</div>
        <div class="helmet"></div>
        <div class="player-name">${p.displayName}${p.isCommissioner ? " 🎖️" : ""}</div>
        <div class="leaf-stickers">${"🍁".repeat(Math.min(p.leafStickers || 0, 12))}</div>
        <div class="player-net ${p.net >= 0 ? "pos" : "neg"}">${p.net >= 0 ? "+" : ""}$${p.net.toFixed(0)}</div>
      </div>
    `).join("") || `<div class="empty-state">No players yet.</div>`;
  }, (err) => {
    console.error("Standings listener failed:", err);
    standingsEl.innerHTML = `<div class="empty-state">Couldn't load standings (${err.code}). Check that Firestore rules are published.</div>`;
  });
}

export function renderHistory() {
  if (!currentUser) return;
  onSnapshot(query(collection(db, "ledger"), where("playerId", "==", currentUser.uid)), (snap) => {
    const rows = snap.docs.map(d => d.data())
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    historyEl.innerHTML = rows.map(r => `
      <div class="matchup" style="padding:8px 0;">
        <div class="team-block">
          <div class="team-name" style="font-size:13px;">${r.reason.replaceAll("_", " ")}${r.enteredOffline ? " (offline)" : ""}</div>
        </div>
        <div class="player-net ${r.amount >= 0 ? "pos" : "neg"}">${r.amount >= 0 ? "+" : ""}$${r.amount.toFixed(2)}</div>
      </div>
    `).join("") || `<div class="empty-state">No transactions yet.</div>`;
  }, (err) => {
    console.error("History listener failed:", err);
    historyEl.innerHTML = `<div class="empty-state">Couldn't load history (${err.code}).</div>`;
  });
}

// ---------- commissioner tools ----------
export function renderCommishTools() {
  if (!currentUser?.isCommissioner) {
    renderBecomeCommissioner();
    return;
  }
  commishEl.style.display = "block";
  commishEl.innerHTML = `
    <h3>Commissioner Tools</h3>

    <h4 style="font-family:'Oswald';font-size:13px;color:var(--buckeye-shine);margin-top:16px;">Sync This Week from CFBD</h4>
    <form id="sync-form" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
      <input name="year" type="number" placeholder="Year" value="${new Date().getFullYear()}" style="width:90px;" required />
      <input name="week" type="number" placeholder="Week #" style="width:90px;" required />
      <button type="submit" class="small">Pull Games + Spreads</button>
    </form>
    <p id="sync-status" style="font-size:12px;color:var(--gray-light);margin-top:6px;"></p>

    <h4 style="font-family:'Oswald';font-size:13px;color:var(--buckeye-shine);margin-top:20px;">Add a Matchup Manually</h4>
    <form id="add-game-form" style="display:grid;gap:8px;max-width:360px;">
      <input name="away" placeholder="Away team" required />
      <input name="home" placeholder="Home team" required />
      <input name="spread" type="number" step="0.5" placeholder="Spread (negative = home favored)" required />
      <input name="kickoff" type="datetime-local" required />
      <button type="submit" class="small">Add Matchup</button>
    </form>

    <h4 style="font-family:'Oswald';font-size:13px;color:var(--buckeye-shine);margin-top:20px;">Settle a Game</h4>
    <form id="settle-form" style="display:grid;gap:8px;max-width:360px;">
      <input name="gameId" placeholder="Game ID (from Weekly Picks page)" required />
      <input name="homeScore" type="number" placeholder="Home score" required />
      <input name="awayScore" type="number" placeholder="Away score" required />
      <button type="submit" class="small">Settle Game</button>
    </form>
  `;

  document.getElementById("sync-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const statusEl = document.getElementById("sync-status");
    statusEl.textContent = "Pulling from CollegeFootballData...";
    try {
      const count = await syncWeek(parseInt(f.year.value), parseInt(f.week.value));
      statusEl.textContent = `Synced ${count} games. Re-run anytime — it updates spreads, never duplicates.`;
      toast(`${count} games synced.`);
    } catch (err) {
      statusEl.textContent = "Sync failed — check your CFBD_API_KEY in firebase-config.js.";
    }
  });

  document.getElementById("add-game-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    await addDoc(collection(db, "games"), {
      awayTeam: f.away.value, homeTeam: f.home.value,
      spread: parseFloat(f.spread.value),
      kickoffMs: new Date(f.kickoff.value).getTime(),
      status: "scheduled", source: "manual", createdAt: serverTimestamp()
    });
    toast("Matchup added.");
    f.reset();
  });

  document.getElementById("settle-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    await settleGame(f.gameId.value, parseInt(f.homeScore.value), parseInt(f.awayScore.value));
    toast("Game settled and payouts distributed.");
    f.reset();
  });
}

// ---------- non-commissioners can unlock it with the code ----------
function renderBecomeCommissioner() {
  commishEl.style.display = "block";
  commishEl.innerHTML = `
    <h3>Commissioner Access</h3>
    <form id="unlock-form" style="display:flex;gap:8px;">
      <input id="unlock-code" placeholder="Enter commissioner code" />
      <button type="submit" class="small">Unlock</button>
    </form>
  `;
  document.getElementById("unlock-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = document.getElementById("unlock-code").value.trim();
    if (code === COMMISSIONER_CODE) {
      await updateDoc(doc(db, "players", currentUser.uid), { isCommissioner: true });
      toast("Commissioner access granted.");
    } else {
      toast("Wrong code.");
    }
  });
}
