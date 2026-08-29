// ============================================================
// OFFLINE ENTRY — commissioner-only. Lets the commissioner log a
// bet and its outcome by hand (no signal at the tailgate/bar/stadium),
// applying balance deltas via increment() so the writes queue locally
// and sync automatically the moment the device reconnects.
// ============================================================
import { db } from "./firebase-config.js?v=20260828p";
import { collection, addDoc, getDocs, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { currentUser, adjustBalanceOffline } from "./app.js?v=20260828p";

const rowsEl = document.getElementById("entry-rows");
const rosterCache = [];

export async function loadRosterForOffline() {
  const snap = await getDocs(collection(db, "players"));
  snap.forEach(d => rosterCache.push({ uid: d.id, name: d.data().displayName }));
  addRow();
}

export function addRow() {
  const row = document.createElement("div");
  row.className = "offline-row";
  row.style.cssText = "display:flex;gap:8px;margin-top:8px;align-items:center;";
  const opts = rosterCache.map(p => `<option value="${p.uid}">${p.name}</option>`).join("");
  row.innerHTML = `
    <select class="row-player">${opts}</select>
    <input class="row-amount" type="number" placeholder="+/- amount" style="width:120px;" />
    <button type="button" class="small ghost remove-row">✕</button>
  `;
  row.querySelector(".remove-row").addEventListener("click", () => row.remove());
  rowsEl.appendChild(row);
}
document.getElementById("add-row-btn")?.addEventListener("click", addRow);

export async function submitOfflineEntry(description) {
  const rows = [...rowsEl.querySelectorAll(".offline-row")].map(r => ({
    uid: r.querySelector(".row-player").value,
    name: r.querySelector(".row-player").selectedOptions[0].textContent,
    amount: parseFloat(r.querySelector(".row-amount").value)
  })).filter(r => r.amount);

  if (!rows.length) { toast("Add at least one player + amount."); return; }

  const logRef = await addDoc(collection(db, "live_bets"), {
    description,
    mode: "manual", scope: "offline",
    proposedBy: currentUser.uid,
    proposerName: currentUser.displayName,
    status: "settled",
    source: "offline_manual",
    entries: rows,
    createdAt: serverTimestamp()
  });

  // Each of these queues locally if there's no connection right now —
  // they'll all flush to the server together once the device is back online.
  for (const r of rows) {
    await adjustBalanceOffline(r.uid, r.amount, "offline_manual_entry", logRef.id);
  }

  toast(navigator.onLine
    ? "Entry saved and synced."
    : "Saved offline — will sync automatically when you're back online.");
  rowsEl.innerHTML = "";
  addRow();
  document.getElementById("offline-desc").value = "";
}
