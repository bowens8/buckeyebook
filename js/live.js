// ============================================================
// LIVE BETS — proposed against a chosen group (must accept) or
// open to anyone; odds-based or 50/50. Each response is its own
// document, so players accept/decline independently in parallel
// with zero write contention on the parent bet doc.
// ============================================================
import { db } from "./firebase-config.js?v=20260828m";
import {
  collection, doc, addDoc, getDocs, getDoc, onSnapshot, query, where,
  serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { currentUser, debitBalance, creditBalance } from "./app.js?v=20260828m";

const playerPickerEl = document.getElementById("invite-players");

// ---------- load roster for the invite picker ----------
export async function loadRoster() {
  const snap = await getDocs(collection(db, "players"));
  playerPickerEl.innerHTML = "";
  snap.forEach(d => {
    if (d.id === currentUser.uid) return;
    const opt = document.createElement("label");
    opt.style.cssText = "display:flex;align-items:center;gap:6px;font-size:13px;";
    opt.innerHTML = `<input type="checkbox" value="${d.id}" data-name="${d.data().displayName}"> ${d.data().displayName}`;
    playerPickerEl.appendChild(opt);
  });
}

// ---------- propose a bet ----------
export async function proposeBet({ gameId, description, mode, scope, odds, invited }) {
  // mode: "odds" | "even"   scope: "group" | "open"
  const wager = parseInt(document.getElementById("propose-wager").value, 10);
  if (!wager) { toast("Enter a wager amount."); return; }

  const betRef = await addDoc(collection(db, "live_bets"), {
    gameId: gameId || null,
    description,
    mode, scope,
    odds: mode === "odds" ? odds : null,
    proposedBy: currentUser.uid,
    proposerName: currentUser.displayName,
    proposerWager: wager,
    status: "open",
    expiresAt: Date.now() + 2 * 60 * 1000, // 2 min live window
    createdAt: serverTimestamp()
  });

  // Lock the proposer's own stake immediately.
  await debitBalance(currentUser.uid, wager, "live_bet_propose", betRef.id);

  if (scope === "group") {
    const batch = writeBatch(db);
    invited.forEach(({ uid, name }) => {
      const rref = doc(collection(db, "live_bet_responses"));
      batch.set(rref, {
        betId: betRef.id, playerId: uid, playerName: name,
        response: "pending", side: null, wagerAmount: null,
        respondedAt: null
      });
    });
    await batch.commit();
  }
  toast("Bet proposed.");
}

// ---------- accept / decline (each player only touches their own doc) ----------
// The odds a player locks in are whatever's posted on the bet AT THE
// MOMENT they accept, frozen onto their own response doc. This is what
// lets the proposer freely move the posted odds afterward for anyone
// who joins later — same as a sportsbook line moving — without ever
// retroactively changing a deal someone already agreed to.
export async function respondToBet(responseId, betId, decision, side, wagerAmount, currentOdds) {
  const rref = doc(db, "live_bet_responses", responseId);
  if (decision === "declined") {
    await updateDocSafe(rref, { response: "declined", respondedAt: serverTimestamp() });
    return;
  }
  await debitBalance(currentUser.uid, wagerAmount, "live_bet_accept", betId);
  await updateDocSafe(rref, {
    response: "accepted", side, wagerAmount,
    acceptedOdds: currentOdds ?? null,
    respondedAt: serverTimestamp()
  });
  toast("Bet accepted" + (currentOdds != null ? ` at ${currentOdds}:1.` : "."));
}

async function updateDocSafe(ref, data) {
  const { updateDoc } = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js");
  await updateDoc(ref, data);
}

// ---------- open pool join (no invite needed) ----------
export async function joinOpenPool(betId, side, wagerAmount, currentOdds) {
  await debitBalance(currentUser.uid, wagerAmount, "open_pool_join", betId);
  await addDoc(collection(db, "live_bet_responses"), {
    betId, playerId: currentUser.uid, playerName: currentUser.displayName,
    response: "accepted", side, wagerAmount,
    acceptedOdds: currentOdds ?? null,
    respondedAt: serverTimestamp()
  });
}

// ---------- proposer moves the posted odds on an open bet ----------
// Only affects people who accept AFTER this point — anyone already
// accepted keeps whatever odds got frozen onto their response doc.
export async function updatePostedOdds(betId, newOdds) {
  const { updateDoc } = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js");
  await updateDoc(doc(db, "live_bets", betId), { odds: newOdds });
  toast(`Line moved to ${newOdds}:1 for anyone joining from here.`);
}

// ---------- resolve a bet (commissioner) ----------
// winningSide: "proposer" | "field"  (which side of the description won)
export async function resolveBet(betId, winningSide) {
  const betDoc = await getDoc(doc(db, "live_bets", betId));
  const bet = betDoc.data();
  const respSnap = await getDocs(query(collection(db, "live_bet_responses"), where("betId", "==", betId)));
  const responses = respSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => r.response === "accepted");

  if (bet.mode === "even" || bet.scope === "open") {
    // pari-mutuel: pot = proposer stake (if scope=group, proposer is the "field" side) + all accepted stakes
    const pot = bet.proposerWager + responses.reduce((s, r) => s + r.wagerAmount, 0);
    const winners = responses.filter(r => r.side === winningSide);
    const winnerPool = winners.reduce((s, r) => s + r.wagerAmount, 0)
      + (winningSide === "proposer" ? bet.proposerWager : 0);
    if (winningSide === "proposer" && winners.length === 0) {
      await creditBalance(bet.proposedBy, pot, "live_bet_payout", betId);
    } else {
      for (const w of winners) {
        const payout = pot * (w.wagerAmount / winnerPool);
        await creditBalance(w.playerId, payout, "live_bet_payout", betId);
      }
      if (winningSide === "proposer") {
        const payout = pot * (bet.proposerWager / winnerPool);
        await creditBalance(bet.proposedBy, payout, "live_bet_payout", betId);
      }
    }
  } else {
    // Odds mode: proposer is the counterparty to every accepter on the
    // "field" side. Each response settles at ITS OWN acceptedOdds — the
    // odds that were posted the moment that person joined — never the
    // bet's current (possibly since-moved) odds field.
    let totalPaidOut = 0;
    for (const r of responses) {
      const rOdds = r.acceptedOdds ?? bet.odds; // fallback for pre-migration data
      if (r.side === winningSide) {
        const payout = r.wagerAmount * (1 + rOdds);
        await creditBalance(r.playerId, payout, "live_bet_payout", betId);
        totalPaidOut += payout;
      }
    }
    if (winningSide === "proposer") {
      const totalStaked = bet.proposerWager + responses.reduce((s, r) => s + r.wagerAmount, 0);
      const proposerTake = totalStaked - totalPaidOut;
      await creditBalance(bet.proposedBy, Math.max(proposerTake, 0), "live_bet_payout", betId);
    }
  }
  const { updateDoc } = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js");
  await updateDoc(doc(db, "live_bets", betId), { status: "settled", winningSide });
}

// ---------- live feed rendering ----------
// containerId lets both live.html (full feed) and sidebets.html
// (filtered views) reuse this same renderer. filterFn, if given,
// narrows which bets are shown without touching the underlying data.
export function renderFeed(containerId = "live-feed", filterFn = null) {
  const feedEl = document.getElementById(containerId);
  if (!feedEl) return;
  onSnapshot(query(collection(db, "live_bets")), (betsSnap) => {
    onSnapshot(collection(db, "live_bet_responses"), (respSnap) => {
      const allResponses = respSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      let sorted = betsSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

      if (filterFn) sorted = sorted.filter(bet => filterFn(bet, allResponses.filter(r => r.betId === bet.id)));

      feedEl.innerHTML = "";
      sorted.forEach(bet => {
        feedEl.appendChild(renderBetItem(bet, allResponses.filter(r => r.betId === bet.id)));
      });
      if (!sorted.length) feedEl.innerHTML = `<div class="empty-state">Nothing here right now.</div>`;
    });
  });
}

export function renderBetItem(bet, responses) {
  const div = document.createElement("div");
  div.className = "bet-item";
  const myResp = responses.find(r => r.playerId === currentUser?.uid);
  const isCommish = currentUser?.isCommissioner;

  let responseHtml = "";
  if (bet.scope === "group" || bet.mode === "odds") {
    responseHtml = `<div class="responses">` + responses.map(r =>
      `<span class="pill ${r.response}">${r.playerName}: ${r.response}${r.acceptedOdds != null ? ` @ ${r.acceptedOdds}:1` : ""}</span>`
    ).join("") + `</div>`;
  }

  let actionHtml = "";
  if (bet.status === "open" && myResp?.response === "pending") {
    actionHtml = `
      <div style="margin-top:8px;display:flex;gap:6px;">
        <button class="small" data-accept="field">Take the field</button>
        <button class="small ghost" data-decline="1">Decline</button>
      </div>`;
  } else if (bet.status === "open" && bet.scope === "open" && !myResp && bet.proposedBy !== currentUser?.uid) {
    actionHtml = `
      <div style="margin-top:8px;display:flex;gap:6px;">
        <input type="number" class="join-wager" placeholder="$" style="width:70px" />
        <button class="small" data-join="field">Join vs proposer</button>
      </div>`;
  }
  if (bet.status === "open" && bet.mode === "odds" && bet.proposedBy === currentUser?.uid) {
    actionHtml += `
      <div style="margin-top:8px;display:flex;gap:6px;align-items:center;">
        <span style="font-size:11px;color:var(--gray-light);">Move the line:</span>
        <input type="number" step="0.1" class="new-odds" placeholder="New odds" style="width:100px" />
        <button class="small ghost" data-move-odds="1">Update</button>
      </div>`;
  }
  if (isCommish && bet.status === "open") {
    actionHtml += `
      <div style="margin-top:8px;display:flex;gap:6px;">
        <button class="small ghost" data-resolve="proposer">Resolve: proposer won</button>
        <button class="small ghost" data-resolve="field">Resolve: field won</button>
      </div>`;
  }

  div.innerHTML = `
    <div><strong>${bet.proposerName}</strong> proposed: "${bet.description}"</div>
    <div class="meta">
      ${bet.mode === "odds" ? `Odds: ${bet.odds}:1 ${bet.status === "open" ? '<span class="pill">line can still move</span>' : ""}` : "Even money"} ·
      ${bet.scope === "group" ? "Group challenge" : "Open pool"} ·
      Stake: $${bet.proposerWager} ·
      ${bet.status === "settled" ? `<strong>SETTLED — ${bet.winningSide} won</strong>` : "OPEN"}
    </div>
    ${responseHtml}
    ${actionHtml}
  `;

  div.querySelector("[data-accept]")?.addEventListener("click", () => {
    respondToBet(myResp.id, bet.id, "accepted", "field", bet.proposerWager, bet.odds);
  });
  div.querySelector("[data-decline]")?.addEventListener("click", () => {
    respondToBet(myResp.id, bet.id, "declined");
  });
  div.querySelector("[data-join]")?.addEventListener("click", () => {
    const amt = parseInt(div.querySelector(".join-wager").value, 10);
    if (amt) joinOpenPool(bet.id, "field", amt, bet.odds);
  });
  div.querySelector("[data-move-odds]")?.addEventListener("click", () => {
    const val = parseFloat(div.querySelector(".new-odds").value);
    if (!isNaN(val)) updatePostedOdds(bet.id, val);
  });
  div.querySelectorAll("[data-resolve]").forEach(btn => {
    btn.addEventListener("click", () => resolveBet(bet.id, btn.dataset.resolve));
  });

  return div;
}
