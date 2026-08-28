// ============================================================
// SHARED BOOTSTRAP — runs on every page except login.html.
// Real password accounts (Firebase Auth email/password under a
// synthetic address), live balance chip, nav highlighting,
// online/offline indicator, and safe balance transactions.
// ============================================================
import { db, auth } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, getDoc, onSnapshot, runTransaction, collection,
  addDoc, serverTimestamp, updateDoc, increment, setDoc
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const STARTING_BALANCE = 500;

export let currentUser = null;   // { uid, displayName, balance, isCommissioner, leafStickers }

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}
window.toast = toast;

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
          displayName: user.email?.split("@")[0] || "Player",
          balance: STARTING_BALANCE,
          startingBalance: STARTING_BALANCE,
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
      // Runs continuously in the background from here on, on whichever
      // commissioner device happens to have a tab open — see
      // live-data-engine.js for why this isn't tied to any one page.
      if (currentUser.isCommissioner) {
        import("./live-data-engine.js").then(m => m.startLiveDataEngine());
      }
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
    const net = currentUser.balance - (currentUser.startingBalance ?? 500);
    const sign = net >= 0 ? "+" : "";
    chip.innerHTML = `${currentUser.displayName} · <span class="amt">$${currentUser.balance}</span>
      <span style="font-family:'Inter';font-size:11px;color:${net >= 0 ? "#6fd39a" : "#ff8a8a"};margin-left:6px;">${sign}${net}</span>
      <a href="#" onclick="logOut();return false;" style="font-family:'Inter';font-size:11px;color:var(--gray-light);margin-left:10px;">Log out</a>`;
  }
}

// ---------- nav highlight ----------
export function highlightNav() {
  const path = location.pathname.split("/").pop() || "index.html";
  document.querySelectorAll("nav.tabs a").forEach(a => {
    if (a.getAttribute("href") === path) a.classList.add("active");
  });
}

// ---------- online/offline indicator ----------
export function initNetworkStatus() {
  const badge = document.createElement("div");
  badge.id = "net-status";
  badge.style.cssText = "position:fixed;top:70px;right:8px;font-family:'Oswald';font-size:10px;padding:4px 8px;border-radius:10px;z-index:200;letter-spacing:0.05em;";
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

// ---------- safe balance transaction (prevents overdraft races) ----------
// Works identically online or offline: Firestore queues the transaction
// locally when there's no connection and replays it the moment the
// device reconnects, so commissioner offline entries settle correctly
// without any special-case code here.
export async function debitBalance(uid, amount, reason, refId) {
  const ref = doc(db, "players", uid);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const bal = snap.data().balance;
    if (bal < amount) throw new Error("insufficient_balance");
    tx.update(ref, { balance: bal - amount });
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
    tx.update(ref, { balance: bal + amount });
  });
  await addDoc(collection(db, "ledger"), {
    playerId: uid, amount, reason, refId, createdAt: serverTimestamp()
  });
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
  await updateDoc(ref, { balance: increment(delta) });
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
