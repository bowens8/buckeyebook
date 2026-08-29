// ============================================================
// LEDGER — live all-time leaderboard (net $ won/lost), personal
// transaction history, and commissioner tools: CFBD weekly sync,
// manual matchup entry, game settlement, commissioner grants.
// ============================================================
import { db } from "./firebase-config.js?v=20260828u";
import {
  collection, addDoc, doc, updateDoc, onSnapshot, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { currentUser, settleUp } from "./app.js?v=20260828u";
import { settleGame } from "./picks.js?v=20260828u";
import { syncWeek, getSyncSettings, saveSyncSettings, fetchConferenceList } from "./cfbd.js?v=20260828u";
import { COMMISSIONER_CODE } from "./firebase-config.js?v=20260828u";

const standingsEl = document.getElementById("standings");
const historyEl = document.getElementById("history");
const commishEl = document.getElementById("commish-tools");

// ---------- all-time leaderboard (permanent) + current balance (settleable) ----------
export function renderStandings() {
  onSnapshot(collection(db, "players"), (snap) => {
    const players = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.allTimeNet || 0) - (a.allTimeNet || 0));

    standingsEl.innerHTML = players.map((p, i) => {
      const allTimeNet = p.allTimeNet || 0;
      const bal = p.balance || 0;
      return `
      <div class="helmet-row">
        <div style="width:20px;font-family:'Anton';color:var(--gray-light);">${i + 1}</div>
        ${p.avatarUrl
          ? `<img src="${p.avatarUrl}" style="width:34px;height:34px;border-radius:50%;object-fit:cover;flex-shrink:0;" />`
          : `<div class="helmet"></div>`}
        <div class="player-name">${p.displayName}${p.isCommissioner ? " 🎖️" : ""}
          <div style="font-size:10px;color:var(--gray-light);font-family:'Inter';">
            currently ${bal < 0 ? "owes" : "is owed"} <strong style="color:${bal < 0 ? "#ff8a8a" : "#6fd39a"};">$${Math.abs(bal).toFixed(0)}</strong>
          </div>
        </div>
        <div class="leaf-stickers">${"🌰".repeat(Math.min(p.leafStickers || 0, 12))}</div>
        <div style="text-align:right;">
          <div class="player-net ${allTimeNet >= 0 ? "pos" : "neg"}">${allTimeNet >= 0 ? "+" : ""}$${allTimeNet.toFixed(0)}</div>
          <div style="font-size:9px;color:var(--gray-light);font-family:'Inter';">all-time</div>
          ${currentUser?.isCommissioner && bal !== 0 ? `<button class="small ghost" style="margin-top:4px;font-size:10px;padding:3px 8px;" data-settle="${p.id}" data-name="${p.displayName}" data-bal="${bal}">Settle Up</button>` : ""}
        </div>
      </div>
    `;
    }).join("") || `<div class="empty-state">No players yet.</div>`;

    standingsEl.querySelectorAll("[data-settle]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const name = btn.dataset.name;
        const bal = parseFloat(btn.dataset.bal);
        const verb = bal < 0 ? "owes" : "is owed";
        if (!confirm(`${name} currently ${verb} $${Math.abs(bal).toFixed(0)}. Confirm you've settled this in the real world and reset their balance to $0? (Their all-time leaderboard record is unaffected.)`)) return;
        await settleUp(btn.dataset.settle);
        toast(`${name} settled up.`);
      });
    });
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
export async function renderCommishTools() {
  if (!currentUser?.isCommissioner) {
    renderBecomeCommissioner();
    return;
  }
  commishEl.style.display = "block";

  // If either of these reads fails (e.g. rules not published yet, or a
  // CFBD hiccup), fall back to sensible defaults rather than letting the
  // whole panel fail to render.
  let settings = { divisions: ["fbs"], conferences: [] };
  let conferenceList = [];
  try {
    settings = await getSyncSettings();
  } catch (err) {
    console.warn("Couldn't load sync settings (using defaults):", err);
  }
  try {
    conferenceList = await fetchConferenceList();
  } catch (err) {
    console.warn("Couldn't load conference list from CFBD:", err);
  }

  const DIVISIONS = [
    { id: "fbs", label: "FBS" },
    { id: "fcs", label: "FCS" },
    { id: "ii", label: "Division II" },
    { id: "iii", label: "Division III" }
  ];

  function renderConferenceCheckboxes(checkedDivisions) {
    const relevant = conferenceList.filter(c => checkedDivisions.includes(c.classification));
    if (!relevant.length) {
      return conferenceList.length
        ? `<p style="font-size:11px;color:var(--gray-light);">No conferences found for the selected division(s).</p>`
        : `<p style="font-size:11px;color:var(--gray-light);">Couldn't load the conference list from CFBD — leave this blank to include every conference in the checked division(s) above.</p>`;
    }
    return `
      <div style="max-height:180px;overflow-y:auto;border:1px solid #2a2a2a;border-radius:var(--radius);padding:8px;display:grid;grid-template-columns:1fr 1fr;gap:4px;">
        ${relevant.map(c => `
          <label style="font-size:12px;display:flex;align-items:center;gap:5px;">
            <input type="checkbox" name="conference" value="${c.abbreviation}" ${settings.conferences.includes(c.abbreviation) ? "checked" : ""} /> ${c.name}
          </label>
        `).join("")}
      </div>
    `;
  }

  commishEl.innerHTML = `
    <h3>Commissioner Tools</h3>

    <h4 style="font-family:'Oswald';font-size:13px;color:var(--buckeye-shine);margin-top:16px;">What Gets Synced</h4>
    <p style="font-size:11px;color:var(--gray-light);">Controls both the manual sync below AND the automatic background sync.</p>
    <form id="scope-form" style="display:grid;gap:10px;max-width:460px;">
      <div>
        <div style="font-size:11px;color:var(--gray-light);margin-bottom:4px;">Divisions</div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;">
          ${DIVISIONS.map(d => `
            <label style="font-size:12px;display:flex;align-items:center;gap:5px;">
              <input type="checkbox" name="division" value="${d.id}" ${settings.divisions.includes(d.id) ? "checked" : ""} /> ${d.label}
            </label>
          `).join("")}
        </div>
      </div>
      <div>
        <div style="font-size:11px;color:var(--gray-light);margin-bottom:4px;">Conferences (leave all unchecked to include every conference in the divisions above)</div>
        <div id="conference-checkboxes">${renderConferenceCheckboxes(settings.divisions)}</div>
      </div>
      <div>
        <label style="font-size:12px;display:flex;align-items:center;gap:6px;">
          <input type="checkbox" name="tvOnly" ${settings.tvOnly ? "checked" : ""} /> Only sync games with national TV/streaming coverage
        </label>
        <p style="font-size:10px;color:var(--gray-light);margin:4px 0 0;">This is the real "big ticket game" filter — most weeks, only a fraction of games actually get broadcast nationally. Combine with the division/conference filter above for the tightest list.</p>
        <input name="tvNetworks" placeholder="Optional: specific networks only (comma-separated, e.g. ABC, ESPN, FOX)" value="${(settings.tvNetworks || []).join(", ")}" style="width:100%;margin-top:6px;" />
        <p style="font-size:10px;color:var(--gray-light);margin:4px 0 0;">Leave blank to include any broadcast/streaming outlet CFBD has listed for the game.</p>
      </div>
      <button type="submit" class="small" style="width:fit-content;">Save Sync Settings</button>
    </form>
    <p id="scope-status" style="font-size:12px;color:var(--gray-light);margin-top:6px;"></p>
    <p style="font-size:11px;color:var(--gray-light);margin-top:2px;">Note: these filters only affect games synced from now on. Anything already sitting on Weekly Picks from before you enabled a filter needs to be cleaned up once using "Show/Hide Specific Games" below.</p>

    <h4 style="font-family:'Oswald';font-size:13px;color:var(--buckeye-shine);margin-top:20px;">Show/Hide Specific Games</h4>
    <p style="font-size:11px;color:var(--gray-light);">Beyond the filters above, uncheck any individual game to hide it from Weekly Picks and the Home hub entirely — it stays in the database, just out of sight everywhere players look.</p>
    <div id="game-visibility-list" style="max-height:260px;overflow-y:auto;border:1px solid #2a2a2a;border-radius:var(--radius);padding:8px;"></div>

    <h4 style="font-family:'Oswald';font-size:13px;color:var(--buckeye-shine);margin-top:16px;">Sync This Week from CFBD (manual backup)</h4>
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

    <h4 style="font-family:'Oswald';font-size:13px;color:var(--buckeye-shine);margin-top:20px;">Manual Settle (backup only)</h4>
    <p style="font-size:11px;color:var(--gray-light);">Games settle themselves automatically the moment CFBD reports a final score — you shouldn't normally need this. Use it only if a game somehow never auto-settles (e.g. CFBD data issue, or no one had a tab open when it finished).</p>
    <form id="settle-form" style="display:grid;gap:8px;max-width:360px;">
      <input name="gameId" placeholder="Game ID (from Weekly Picks page)" required />
      <input name="homeScore" type="number" placeholder="Home score" required />
      <input name="awayScore" type="number" placeholder="Away score" required />
      <button type="submit" class="small ghost">Force Settle</button>
    </form>
  `;

  document.getElementById("scope-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const divisions = [...f.querySelectorAll('input[name="division"]:checked')].map(cb => cb.value);
    if (!divisions.length) { toast("Pick at least one division."); return; }
    const conferences = [...f.querySelectorAll('input[name="conference"]:checked')].map(cb => cb.value);
    const tvOnly = f.tvOnly.checked;
    const tvNetworks = f.tvNetworks.value.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    await saveSyncSettings(divisions, conferences, tvOnly, tvNetworks);
    document.getElementById("scope-status").textContent = "Saved — takes effect on the next sync (manual or automatic).";
    toast("Sync settings saved.");
  });

  // Re-render the conference list live as divisions are toggled, so it
  // only ever shows conferences actually relevant to what's checked.
  document.querySelectorAll('#scope-form input[name="division"]').forEach(cb => {
    cb.addEventListener("change", () => {
      const checkedDivisions = [...document.querySelectorAll('#scope-form input[name="division"]:checked')].map(c => c.value);
      const previouslyChecked = [...document.querySelectorAll('#scope-form input[name="conference"]:checked')].map(c => c.value);
      document.getElementById("conference-checkboxes").innerHTML = renderConferenceCheckboxes(checkedDivisions);
      // Preserve whatever was already checked, in case it's still relevant.
      document.querySelectorAll('#scope-form input[name="conference"]').forEach(c => {
        if (previouslyChecked.includes(c.value)) c.checked = true;
      });
    });
  });

  document.getElementById("sync-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const statusEl = document.getElementById("sync-status");
    statusEl.textContent = "Pulling from CollegeFootballData...";
    try {
      const { count, tvFilterApplied } = await syncWeek(parseInt(f.year.value), parseInt(f.week.value));
      if (!tvFilterApplied) {
        statusEl.textContent = `Synced ${count} games, but the TV filter couldn't be applied this time (CollegeFootballData's broadcast data didn't come back as expected) — every game in scope was synced instead. Check the console for details, or try again.`;
        toast("Synced, but TV filter didn't apply — see status message.");
      } else {
        statusEl.textContent = `Synced ${count} games. Re-run anytime — it updates spreads, never duplicates.`;
        toast(`${count} games synced.`);
      }
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

  renderGameVisibilityList();
}

// ---------- per-game show/hide toggles ----------
// Live list, sorted chronologically. Checked = visible everywhere,
// unchecked = hidden from Weekly Picks and the Home hub (but the game
// stays in Firestore — nothing is deleted, existing picks on an already-
// hidden game are unaffected, just not shown to new pickers).
function renderGameVisibilityList() {
  const listEl = document.getElementById("game-visibility-list");
  if (!listEl) return;
  onSnapshot(collection(db, "games"), (snap) => {
    const games = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.kickoffMs ?? Infinity) - (b.kickoffMs ?? Infinity));

    listEl.innerHTML = games.map(g => `
      <label style="display:flex;align-items:center;gap:8px;font-size:12px;padding:4px 0;border-top:1px solid #262626;">
        <input type="checkbox" data-game-id="${g.id}" ${g.hidden ? "" : "checked"} />
        <span style="flex:1;">${g.awayTeam} @ ${g.homeTeam}</span>
        ${g.tvOutlet ? `<span class="pill">${g.tvOutlet}</span>` : ""}
        <span style="color:var(--gray-light);font-size:10px;">${g.kickoffMs ? new Date(g.kickoffMs).toLocaleDateString([], { month: "short", day: "numeric" }) : ""}</span>
      </label>
    `).join("") || `<div class="empty-state">No games yet.</div>`;

    listEl.querySelectorAll("input[data-game-id]").forEach(cb => {
      cb.addEventListener("change", async () => {
        await updateDoc(doc(db, "games", cb.dataset.gameId), { hidden: !cb.checked });
        toast(cb.checked ? "Game shown." : "Game hidden.");
      });
    });
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
