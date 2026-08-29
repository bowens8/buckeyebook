// ============================================================
// SHARED BOOTSTRAP — runs on every page except login.html.
// Real password accounts (Firebase Auth email/password under a
// synthetic address), live balance chip, nav highlighting,
// online/offline indicator, and safe balance transactions.
// ============================================================
import { db, auth } from "./firebase-config.js?v=20260828q";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, getDoc, onSnapshot, runTransaction, collection,
  addDoc, serverTimestamp, updateDoc, increment, setDoc
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const STARTING_BALANCE = 0;

export let currentUser = null;   // { uid, displayName, balance, isCommissioner, leafStickers }

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}
window.toast = toast;

// ---------- defeat bfcache so every tab click is a genuine fresh load ----------
// Modern browsers can restore a page from a frozen "back/forward cache"
// snapshot instead of truly re-running its scripts, which means nav
// clicks (and back/forward) can silently skip re-subscribing all the
// live Firestore listeners and the engine's immediate poll-on-load —
// data just sits stale until something else triggers a refresh. Forcing
// a real reload whenever a page is restored from bfcache guarantees
// every tab click actually re-runs everything, every time.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});

// ---------- auth guard: every page (but login.html) requires a session ----------
export function initAuth(onReady) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      if (!location.pathname.endsWith("login.html")) location.href = "login.html";
      return;
    }
    const ref = doc(db, "players", user.uid);
    let snap;
    try {
      snap = await getDoc(ref);
    } catch (err) {
      console.error("Couldn't read player doc:", err);
      toast(`Account load failed (${err.code}). Check that Firestore rules are published.`);
      return;
    }

    if (!snap.exists()) {
      // Self-heal instead of bouncing to login.html: an auth account can
      // exist without a matching profile if the signup's Firestore write
      // failed at the time (e.g. rules weren't published yet) even though
      // the auth account itself was created successfully. Redirecting to
      // login.html in that case just ping-pongs forever, since login.html
      // sees a valid session and immediately redirects back here. Creating
      // the missing profile on the spot breaks that loop for good.
      try {
        await setDoc(ref, {
          displayName: "New Player", // rename anytime by clicking your name in the header
          balance: STARTING_BALANCE,
          startingBalance: STARTING_BALANCE,
          allTimeNet: 0,
          isCommissioner: false,
          leafStickers: 0,
          createdAt: serverTimestamp()
        });
        toast("Recovered your account profile.");
      } catch (err) {
        console.error("Couldn't self-heal player doc:", err);
        toast(`Account setup failed (${err.code}). Check that Firestore rules are published.`);
        return;
      }
    }

    onSnapshot(ref, (s) => {
      currentUser = { uid: user.uid, ...s.data() };
      renderBalanceChip();
      // Runs on ANY signed-in user's device — the app relies on
      // whoever happens to have it open, rather than one specific
      // commissioner tab. See live-data-engine.js for the trade-off
      // this implies for the security rules.
      import("./live-data-engine.js?v=20260828q").then(m => m.startLiveDataEngine());
      if (onReady) onReady(currentUser);
    }, (err) => {
      // Without this, a Firestore permission error (e.g. rules not
      // published) fails completely silently — the page just stays
      // blank forever with no indication why. This turns that into
      // something diagnosable.
      console.error("Player doc listener failed:", err);
      toast(`Couldn't load your account (${err.code}). Check that Firestore rules are published.`);
    });
  });
}

export async function logOut() {
  await signOut(auth);
  location.href = "login.html";
}
window.logOut = logOut;

function renderBalanceChip() {
  const chip = document.getElementById("balance-chip");
  if (chip && currentUser) {
    const bal = currentUser.balance;
    const avatarHtml = currentUser.avatarUrl
      ? `<img src="${currentUser.avatarUrl}" style="width:24px;height:24px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:6px;cursor:pointer;" onclick="triggerAvatarUpload();" title="Click to change photo" />`
      : `<span onclick="triggerAvatarUpload();" style="display:inline-block;width:24px;height:24px;border-radius:50%;background:var(--gray);vertical-align:middle;margin-right:6px;cursor:pointer;" title="Click to add a photo"></span>`;
    chip.innerHTML = `${avatarHtml}<a href="#" onclick="editName();return false;" style="color:inherit;text-decoration:none;" title="Click to rename">${currentUser.displayName}</a> ·
      <span class="amt" style="color:${bal < 0 ? "#ff8a8a" : "var(--buckeye-shine)"};">${bal < 0 ? "-" : ""}$${Math.abs(bal)}</span>
      <a href="#" onclick="logOut();return false;" style="font-family:'Inter';font-size:11px;color:var(--gray-light);margin-left:10px;">Log out</a>`;
  }
}

async function editName() {
  if (!currentUser) return;
  const name = prompt("Your name:", currentUser.displayName);
  if (!name || !name.trim() || name.trim() === currentUser.displayName) return;
  const { updateDoc, doc: docRef } = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js");
  await updateDoc(docRef(db, "players", currentUser.uid), { displayName: name.trim() });
  toast("Name updated.");
}
window.editName = editName;

// ---------- profile picture ----------
// Stored directly on the player doc as a small compressed data URL —
// no Firebase Storage setup needed. Resized to 128x128 and re-encoded
// as JPEG before upload, so even a large phone photo ends up a few KB,
// well under Firestore's 1MB document limit.
export function triggerAvatarUpload() {
  if (!currentUser) return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const dataUrl = await resizeImageToDataUrl(file, 128);
      const { updateDoc, doc: docRef } = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js");
      await updateDoc(docRef(db, "players", currentUser.uid), { avatarUrl: dataUrl });
      toast("Photo updated.");
    } catch (err) {
      console.error("Avatar upload failed:", err);
      toast("Couldn't update photo — try a smaller image.");
    }
  };
  input.click();
}
window.triggerAvatarUpload = triggerAvatarUpload;

function resizeImageToDataUrl(file, size) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
    reader.onerror = reject;
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      // Center-crop to a square before scaling down.
      const min = Math.min(img.width, img.height);
      const sx = (img.width - min) / 2;
      const sy = (img.height - min) / 2;
      ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size);
      resolve(canvas.toDataURL("image/jpeg", 0.7));
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---------- nav highlight ----------
export function highlightNav() {
  const path = location.pathname.split("/").pop() || "index.html";
  document.querySelectorAll("nav.tabs a").forEach(a => {
    if (a.getAttribute("href") === path) a.classList.add("active");
  });
}

// ---------- online/offline indicator ----------
// Fixed to the bottom-right corner, out of the way of the header/nav.
export function initNetworkStatus() {
  const badge = document.createElement("div");
  badge.id = "net-status";
  badge.style.cssText = "position:fixed;bottom:14px;right:14px;font-family:'Oswald';font-size:10px;padding:4px 10px;border-radius:10px;z-index:200;letter-spacing:0.05em;box-shadow:var(--shadow);";
  document.body.appendChild(badge);
  const update = () => {
    const online = navigator.onLine;
    badge.textContent = online ? "● LIVE" : "● OFFLINE — QUEUED";
    badge.style.background = online ? "rgba(46,125,79,0.25)" : "rgba(138,0,0,0.3)";
    badge.style.color = online ? "#6fd39a" : "#ff8a8a";
    badge.style.border = `1px solid ${online ? "#2e7d4f" : "#8a0000"}`;
  };
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
}

// ---------- balance transactions ----------
// `balance` is the current amount owed/owing right now — it CAN go
// negative (you can lose more than you've put in) and gets zeroed out
// by the commissioner once real-world payment happens. `allTimeNet` is
// a permanent running total that only ever accumulates and is never
// touched by a settle-up — that's what the all-time leaderboard ranks
// on, so bragging rights survive every payout cycle.
export async function debitBalance(uid, amount, reason, refId) {
  const ref = doc(db, "players", uid);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const bal = snap.data().balance;
    const net = snap.data().allTimeNet || 0;
    tx.update(ref, { balance: bal - amount, allTimeNet: net - amount });
  });
  await addDoc(collection(db, "ledger"), {
    playerId: uid, amount: -amount, reason, refId, createdAt: serverTimestamp()
  });
}

export async function creditBalance(uid, amount, reason, refId) {
  const ref = doc(db, "players", uid);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const bal = snap.data().balance;
    const net = snap.data().allTimeNet || 0;
    tx.update(ref, { balance: bal + amount, allTimeNet: net + amount });
  });
  await addDoc(collection(db, "ledger"), {
    playerId: uid, amount, reason, refId, createdAt: serverTimestamp()
  });
}

// ---------- settle up (commissioner) ----------
// Zeroes out a player's current balance once real-world payment has
// happened — WITHOUT touching allTimeNet, so the leaderboard keeps the
// full history of wins and losses forever, independent of payout cycles.
export async function settleUp(uid) {
  const ref = doc(db, "players", uid);
  let priorBalance = 0;
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    priorBalance = snap.data().balance;
    tx.update(ref, { balance: 0 });
  });
  await addDoc(collection(db, "ledger"), {
    playerId: uid, amount: -priorBalance, reason: "settled_up_irl", refId: null, createdAt: serverTimestamp()
  });
  return priorBalance;
}

// ---------- offline-safe balance adjustment ----------
// runTransaction() needs a live round trip to read-then-write, so it
// CANNOT be queued while offline. increment() is a special Firestore
// field value that the SDK can queue locally and apply atomically once
// synced, so this is what commissioner offline entries use instead.
// Trade-off: there's no "insufficient balance" check available offline —
// the commissioner is trusted to enter correct numbers when off the grid.
export async function adjustBalanceOffline(uid, delta, reason, refId) {
  const ref = doc(db, "players", uid);
  await updateDoc(ref, { balance: increment(delta), allTimeNet: increment(delta) });
  await addDoc(collection(db, "ledger"), {
    playerId: uid, amount: delta, reason, refId, createdAt: serverTimestamp(), enteredOffline: true
  });
}

export async function awardLeaf(uid) {
  const ref = doc(db, "players", uid);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    tx.update(ref, { leafStickers: (snap.data().leafStickers || 0) + 1 });
  });
}
