// ============================================================
// PICKS — weekly ATS picks, pari-mutuel pot, tiered+margin scoring.
// Each player's action (placing a pick) is its own transaction,
// so simultaneous picks from different players never collide.
// ============================================================
import { db } from "./firebase-config.js";
import {
  collection, doc, addDoc, onSnapshot, query, where,
  serverTimestamp, runTransaction, getDocs
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { currentUser, debitBalance, creditBalance, awardLeaf } from "./app.js";

const gamesEl = document.getElementById("games-list");

// ---------- render live games + this player's existing picks ----------
export function renderGames() {
  onSnapshot(collection(db, "games"), (gamesSnap) => {
    onSnapshot(collection(db, "picks"), (picksSnap) => {
      const allPicks = picksSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      gamesEl.innerHTML = "";
      gamesSnap.forEach(g => {
        const game = { id: g.id, ...g.data() };
        const myPick = allPicks.find(p => p.gameId === game.id && p.playerId === currentUser?.uid);
        gamesEl.appendChild(renderMatchupCard(game, myPick, allPicks.filter(p => p.gameId === game.id)));
      });
      if (!gamesSnap.size) {
        gamesEl.innerHTML = `<div class="empty-state">No games loaded yet. Commissioner: add matchups in Firestore → games.</div>`;
      }
    });
  });
}

function renderMatchupCard(game, myPick, gamePicks) {
  const div = document.createElement("div");
  div.className = "card";
  const locked = Date.now() > (game.kickoffMs || 0);
  const pot = gamePicks.reduce((s, p) => s + p.wagerAmount, 0);
  const lineTag = game.spreadLocked
    ? `<span class="tier-tag pending" style="margin-left:6px;">line locked</span>`
    : game.spread != null ? `<span class="tier-tag" style="margin-left:6px;background:rgba(255,255,255,0.08);color:var(--gray-light);">line moving</span>` : "";

  div.innerHTML = `
    <div class="matchup">
      <div class="team-block">
        <div class="team-name">${game.awayTeam}</div>
        <div class="spread">${spreadLabel(game, "away")}</div>
      </div>
      <div class="vs">@</div>
      <div class="team-block" style="text-align:right">
        <div class="team-name">${game.homeTeam}</div>
        <div class="spread">${spreadLabel(game, "home")}</div>
      </div>
    </div>
    <div class="meta" style="color:var(--gray-light);font-size:12px;margin-top:6px;">
      Pool so far: $${pot} · ${gamePicks.length} pick(s) ${locked ? "· LOCKED" : ""} ${lineTag}
    </div>
    ${myPick ? renderMyPick(myPick, game, locked) : (locked ? `<div class="empty-state">Picks closed at kickoff.</div>` : renderPickForm(game))}
  `;

  if (!myPick && !locked) {
    div.querySelector("form.pick-form")?.addEventListener("submit", (e) => handleSubmitPick(e, game));
  }
  if (myPick && !locked) {
    div.querySelector("[data-edit-pick]")?.addEventListener("click", () => {
      const holder = div.querySelector(".my-pick-holder");
      holder.innerHTML = renderPickForm(game, myPick);
      holder.querySelector("form.pick-form").addEventListener("submit", (e) => handleSubmitPick(e, game, myPick));
      holder.querySelector("[data-cancel-edit]").addEventListener("click", () => {
        holder.outerHTML = renderMyPick(myPick, game, locked);
      });
    });
    div.querySelector("[data-cancel-pick]")?.addEventListener("click", () => cancelPick(myPick));
  }
  return div;
}

function spreadLabel(game, side) {
  if (game.spread == null) return "pick 'em";
  const fav = game.spread < 0 ? "home" : "away";
  const val = Math.abs(game.spread);
  return side === fav ? `-${val}` : `+${val}`;
}

// existingPick, if passed, pre-fills the form for an edit rather than a fresh pick.
function renderPickForm(game, existingPick = null) {
  return `
    <form class="pick-form" style="display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap;">
      <select name="side">
        <option value="away" ${existingPick?.side === "away" ? "selected" : ""}>${game.awayTeam} ${spreadLabel(game,"away")}</option>
        <option value="home" ${existingPick?.side === "home" ? "selected" : ""}>${game.homeTeam} ${spreadLabel(game,"home")}</option>
      </select>
      <input type="number" name="wager" min="1" placeholder="Wager $" value="${existingPick?.wagerAmount ?? ""}" required style="width:100px" />
      <button type="submit" class="small">${existingPick ? "Save Change" : "Lock Pick"}</button>
      ${existingPick ? `<button type="button" class="small ghost" data-cancel-edit>Cancel</button>` : ""}
    </form>
  `;
}

function renderMyPick(pick, game, locked) {
  const tagClass = pick.settled ? (pick.result === "push" ? "push" : pick.payout > 0 ? "win" : "loss") : "pending";
  const tagText = pick.settled ? (pick.result === "push" ? "PUSH" : pick.payout > 0 ? `WON $${pick.payout.toFixed(0)}` : "LOST") : "PENDING";
  return `
    <div class="my-pick-holder" style="margin-top:10px;font-size:13px;">
      You picked <strong>${pick.side === "home" ? game.homeTeam : game.awayTeam}</strong> for $${pick.wagerAmount}
      <span class="tier-tag ${tagClass}">${tagText}</span>
      ${!locked && !pick.settled ? `
        <div style="margin-top:8px;display:flex;gap:6px;">
          <button type="button" class="small ghost" data-edit-pick>Change Pick</button>
          <button type="button" class="small ghost" data-cancel-pick>Cancel Pick</button>
        </div>
      ` : ""}
      ${!locked ? `<div style="font-size:11px;color:var(--gray-light);margin-top:4px;">Editable until kickoff — locks automatically once the game starts.</div>` : ""}
    </div>
  `;
}

async function handleSubmitPick(e, game, existingPick = null) {
  e.preventDefault();
  if (Date.now() > (game.kickoffMs || 0)) { toast("Kickoff already passed — this game is locked."); return; }

  const form = e.target;
  const side = form.side.value;
  const wager = parseInt(form.wager.value, 10);
  if (!wager || wager < 1) return;

  // Editing: refund the old wager first so the balance check below is
  // against the player's true available balance, not double-counting
  // the amount already tied up in their existing pick.
  const availableBalance = existingPick ? currentUser.balance + existingPick.wagerAmount : currentUser.balance;
  // No balance ceiling — going negative is allowed (you settle up in
  // the real world later), so there's nothing to block here beyond a
  // sane positive number.

  try {
    if (existingPick) {
      await creditBalance(currentUser.uid, existingPick.wagerAmount, "pick_edit_refund", game.id);
      await debitBalance(currentUser.uid, wager, "pick_wager", game.id);
      await runTransaction(db, async (tx) => {
        tx.update(doc(db, "picks", existingPick.id), { side, wagerAmount: wager });
      });
      toast(`Pick updated: $${wager} on ${side === "home" ? game.homeTeam : game.awayTeam}`);
    } else {
      await debitBalance(currentUser.uid, wager, "pick_wager", game.id);
      await addDoc(collection(db, "picks"), {
        gameId: game.id,
        playerId: currentUser.uid,
        playerName: currentUser.displayName,
        side, wagerAmount: wager,
        settled: false,
        createdAt: serverTimestamp()
      });
      toast(`Pick locked: $${wager} on ${side === "home" ? game.homeTeam : game.awayTeam}`);
    }
  } catch (err) {
    toast("Couldn't save pick — try again.");
  }
}

async function cancelPick(pick) {
  await creditBalance(pick.playerId, pick.wagerAmount, "pick_cancelled_refund", pick.gameId);
  await deleteDocSafe(doc(db, "picks", pick.id));
  toast("Pick cancelled and refunded.");
}

async function deleteDocSafe(ref) {
  const { deleteDoc } = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js");
  await deleteDoc(ref);
}

// ============================================================
// SETTLEMENT (commissioner-triggered, from ledger.html)
// Tiered + margin-scaled pari-mutuel, per the pool's house rules:
//   Tier 1: dog covers, loses outright        base 1.0x
//   Tier 2: dog covers AND wins outright      base 2.0x
//   Tier 3: favorite covers and wins          base 1.0x
//   Tier 4: favorite wins, fails to cover     base 0.5x
//   scaling = 1 + (cover_margin / |spread|), capped at 3.0x
// Payout = pot * (my weighted stake / sum of all winning weighted stakes)
// ============================================================
export async function settleGame(gameId, homeScore, awayScore) {
  const picksSnap = await getDocs(query(collection(db, "picks"), where("gameId", "==", gameId)));
  const gameSnap = await getDocs(query(collection(db, "games"), where("__name__", "==", gameId)));
  const game = gameSnap.docs[0].data();
  const spread = game.spread ?? 0; // negative = home favored
  const actualMargin = homeScore - awayScore; // positive = home won by X

  // Only ever process picks that haven't been paid out yet. This guards
  // against double-settlement if the auto-settle engine and a manual
  // "Force Settle" both end up touching the same game — without this,
  // re-running settlement would recompute the pot from already-paid
  // picks and pay everyone twice.
  const picks = picksSnap.docs.map(d => ({ ref: d.ref, ...d.data() })).filter(p => !p.settled);
  if (!picks.length) {
    console.warn(`settleGame(${gameId}) called with nothing left to settle — skipping.`);
    return;
  }
  const pot = picks.reduce((s, p) => s + p.wagerAmount, 0);

  const scored = picks.map(p => {
    const pickedHome = p.side === "home";
    // margin from the picked team's perspective
    const teamMargin = pickedHome ? actualMargin : -actualMargin;
    const teamSpread = pickedHome ? -spread : spread; // points picked team is getting/giving
    const coverMargin = teamMargin + teamSpread; // >0 = covered, 0 = push, <0 = missed

    if (coverMargin === 0) return { ...p, result: "push", payout: p.wagerAmount, weighted: 0 };

    const wonOutright = teamMargin > 0;

    if (coverMargin < 0) {
      // Missed the cover. If the pick's team still won the game outright
      // (only possible for a favorite — an underdog that wins always
      // covers by definition), that's Tier 4: partial credit at a flat
      // 0.5x rather than a total loss. Genuinely lost outright = 0x.
      if (wonOutright) {
        return { ...p, result: "win", multiplier: 0.5, weighted: p.wagerAmount * 0.5 };
      }
      return { ...p, result: "loss", payout: 0, weighted: 0 };
    }

    // Covered the spread — tiers 1-3.
    const isDog = teamSpread > 0;
    const base = (isDog && wonOutright) ? 2.0 : 1.0; // dog-covers-and-wins, or any other cover (dog surviving, or favorite covering — which always means winning outright)

    const spreadAbs = Math.abs(teamSpread) || 1;
    const scale = Math.min(1 + coverMargin / spreadAbs, 3.0);
    const multiplier = base * scale;
    return { ...p, result: "win", multiplier, weighted: p.wagerAmount * multiplier };
  });

  const totalWeighted = scored.reduce((s, p) => s + (p.weighted || 0), 0);
  const pushRefunds = scored.filter(p => p.result === "push").reduce((s, p) => s + p.wagerAmount, 0);
  const distributable = pot - pushRefunds;

  for (const p of scored) {
    if (p.result === "push") {
      await creditBalance(p.playerId, p.wagerAmount, "pick_push_refund", gameId);
    } else if (p.result === "win") {
      const payout = totalWeighted > 0 ? distributable * (p.weighted / totalWeighted) : 0;
      await creditBalance(p.playerId, payout, "pick_payout", gameId);
      if (p.multiplier >= 2) await awardLeaf(p.playerId); // upset callers get a leaf sticker
      await updatePickResult(p.ref, "win", payout);
      continue;
    }
    await updatePickResult(p.ref, p.result, p.result === "push" ? p.wagerAmount : 0);
  }
}

async function updatePickResult(ref, result, payout) {
  await runTransaction(db, async (tx) => {
    tx.update(ref, { settled: true, result, payout });
  });
}
