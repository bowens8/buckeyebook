// ============================================================
// PICKS — weekly ATS picks, pari-mutuel pot, tiered+margin scoring.
// Each player's action (placing a pick) is its own transaction,
// so simultaneous picks from different players never collide.
// ============================================================
import { db } from "./firebase-config.js?v=20260828p";
import {
  collection, doc, addDoc, onSnapshot, query, where,
  serverTimestamp, runTransaction, getDocs
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { currentUser, debitBalance, creditBalance, awardLeaf } from "./app.js?v=20260828p";

const gamesEl = document.getElementById("games-list");
const LOCK_WINDOW_MS = 48 * 60 * 60 * 1000; // matches the engine's actual lock rule

let currentView = "upcoming"; // or "live"
let latestGames = [];
let latestPicks = [];
let latestSyncSettings = null; // null = not loaded yet, show everything rather than hide games prematurely

// Only show games that match what the commissioner currently has synced
// — same logic as the Home hub. This is what makes unchecking a
// conference actually remove its games from this page, instead of just
// affecting future syncs while old games from it linger forever.
function matchesSyncScope(game) {
  if (game.hidden) return false;
  if (!latestSyncSettings) return true;
  if (!game.division) return true; // no tag yet (pre-dates this feature or manually added) — show by default
  if (!latestSyncSettings.divisions.includes(game.division)) return false;
  if (latestSyncSettings.conferences.length && !latestSyncSettings.conferences.includes(game.conference)) return false;
  return true;
}

// True once a game is inside its 48-hour lock window, regardless of
// whether the background engine has actually flipped spreadLocked yet —
// there's an unavoidable gap between crossing the threshold and the next
// poll landing, and the UI shouldn't claim the line is "moving" during
// that gap even if the stored value technically hasn't been frozen yet.
function isWithinLockWindow(game) {
  return game.kickoffMs && Date.now() >= (game.kickoffMs - LOCK_WINDOW_MS);
}

const isFinished = g => g.liveStatus === "final" || g.autoSettled === true;
// Kickoff time is the primary signal for "no longer pickable" — not
// liveStatus alone. liveStatus only updates when the background engine
// actually polls, which needs someone signed in; a game could sit at
// "scheduled" indefinitely if nobody was around right after it ended.
const hasStarted = g => g.kickoffMs && Date.now() >= g.kickoffMs;
const isOngoing = g => !isFinished(g) && hasStarted(g);
const isPickable = g => !isFinished(g) && !hasStarted(g);
const byKickoff = (a, b) => (a.kickoffMs ?? Infinity) - (b.kickoffMs ?? Infinity);

// ---------- render live games + this player's existing picks ----------
// Two segmented views (switched via the pill control in picks.html):
//   Upcoming   — pickable games only. Marquee (nationally televised)
//                games surface as their own group at the top, then
//                everything else groups by conference.
//   Live/Final — games currently in progress (top) and finished games
//                (bottom), using the compact scoreline card.
export function renderGames() {
  let rawGames = [];

  const applyFilterAndRender = () => {
    latestGames = rawGames.filter(matchesSyncScope);
    renderCurrentView();
  };

  onSnapshot(collection(db, "games"), (gamesSnap) => {
    rawGames = gamesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    applyFilterAndRender();
  });
  onSnapshot(collection(db, "picks"), (picksSnap) => {
    latestPicks = picksSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderCurrentView();
  });
  onSnapshot(doc(db, "settings", "sync"), (snap) => {
    latestSyncSettings = snap.exists()
      ? { divisions: snap.data().divisions?.length ? snap.data().divisions : ["fbs"], conferences: snap.data().conferences || [] }
      : { divisions: ["fbs"], conferences: [] };
    applyFilterAndRender(); // re-run the filter against whatever games we already have
  }, (err) => {
    console.warn("Couldn't load sync settings for Weekly Picks filtering:", err);
  });
}

export function setView(view) {
  currentView = view;
  document.querySelectorAll(".segmented button").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  renderCurrentView();
}
window.setPicksView = setView;

function renderCurrentView() {
  gamesEl.innerHTML = "";
  if (!latestGames.length) {
    gamesEl.innerHTML = `<div class="empty-state">No games loaded yet. Commissioner: add matchups in Firestore → games.</div>`;
    return;
  }
  if (currentView === "live") renderLiveFinalView();
  else renderUpcomingView();
}

function renderSection(games, headerHtml) {
  if (!games.length) return;
  if (headerHtml) {
    const header = document.createElement("div");
    header.innerHTML = headerHtml;
    gamesEl.appendChild(header.firstElementChild);
  }
  games.forEach(game => {
    const myPick = latestPicks.find(p => p.gameId === game.id && p.playerId === currentUser?.uid);
    gamesEl.appendChild(renderMatchupCard(game, myPick, latestPicks.filter(p => p.gameId === game.id)));
  });
}

// ---------- Upcoming: marquee games first, then grouped by conference ----------
function renderUpcomingView() {
  const pickable = latestGames.filter(isPickable);
  if (!pickable.length) {
    gamesEl.innerHTML = `<div class="empty-state">Nothing upcoming right now — check the Live/Final tab.</div>`;
    return;
  }

  const marquee = pickable.filter(g => g.tvOutlet).sort(byKickoff);
  const rest = pickable.filter(g => !g.tvOutlet);

  renderSection(marquee, `<div class="marquee-group-header">📺 Marquee Matchups</div>`);

  const byConference = {};
  rest.forEach(g => {
    const key = g.conference || "Other";
    (byConference[key] ||= []).push(g);
  });
  Object.keys(byConference).sort().forEach(conf => {
    renderSection(byConference[conf].sort(byKickoff), `<div class="conference-group-header">${conf}</div>`);
  });
}

// ---------- Live/Final: in-progress on top, finished below ----------
function renderLiveFinalView() {
  // Games with any picks on them (by anyone in the pool, not just you)
  // surface first within each section — those are the ones that
  // actually matter to check on. Chronological order is the tiebreaker
  // within each group.
  const hasAnyPicks = g => latestPicks.some(p => p.gameId === g.id);
  const byPicksThenKickoff = (a, b) => {
    const aHas = hasAnyPicks(a), bHas = hasAnyPicks(b);
    if (aHas !== bHas) return aHas ? -1 : 1;
    return byKickoff(a, b);
  };

  const ongoing = latestGames.filter(isOngoing).sort(byPicksThenKickoff);
  const finished = latestGames.filter(isFinished).sort(byPicksThenKickoff);
  if (!ongoing.length && !finished.length) {
    gamesEl.innerHTML = `<div class="empty-state">Nothing live or finished yet — check the Upcoming tab.</div>`;
    return;
  }
  renderSection(ongoing, `<div class="section-title"><h2 style="font-size:18px;">In Progress</h2></div>`);
  renderSection(finished, `<div class="section-title"><h2 style="font-size:18px;">Finished</h2></div>`);
}

function formatKickoff(kickoffMs) {
  if (!kickoffMs) return "Kickoff TBD";
  const d = new Date(kickoffMs);
  const datePart = d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const timePart = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${datePart} · ${timePart}`;
}

function renderMatchupCard(game, myPick, gamePicks) {
  const div = document.createElement("div");
  div.className = "card";
  const locked = Date.now() > (game.kickoffMs || 0);
  const isFinished = game.liveStatus === "final" || game.autoSettled === true;
  const isOngoing = !isFinished && game.kickoffMs && Date.now() >= game.kickoffMs;
  const showScore = isFinished || isOngoing;
  const pot = gamePicks.reduce((s, p) => s + p.wagerAmount, 0);
  const lineTag = (game.spreadLocked || isWithinLockWindow(game))
    ? `<span class="tier-tag pending" style="margin-left:6px;">line locked</span>`
    : game.spread != null ? `<span class="tier-tag" style="margin-left:6px;background:rgba(255,255,255,0.08);color:var(--gray-light);">line moving</span>` : "";

  const scoreline = () => {
    const awayScore = game.awayScore;
    const homeScore = game.homeScore;
    const awayWon = isFinished && awayScore != null && homeScore != null && awayScore > homeScore;
    const homeWon = isFinished && awayScore != null && homeScore != null && homeScore > awayScore;
    return `
      <div class="scoreline">
        <div class="score-team-row ${awayWon ? "winner" : ""}">
          <span class="score-team-name">${game.awayTeam}</span>
          <span class="score-team-num">${awayScore ?? "-"}</span>
        </div>
        <div class="score-team-row ${homeWon ? "winner" : ""}">
          <span class="score-team-name">${game.homeTeam}</span>
          <span class="score-team-num">${homeScore ?? "-"}</span>
        </div>
      </div>
    `;
  };

  const statusLabel = isFinished ? "FINAL"
    : isOngoing ? (game.period ? `Q${game.period} ${game.clock ?? ""}` : "In Progress")
    : formatKickoff(game.kickoffMs);
  const tvBadge = game.tvOutlet ? `<span class="tier-tag" style="margin-left:6px;background:rgba(255,255,255,0.08);color:var(--buckeye-shine);">📺 ${game.tvOutlet}</span>` : "";

  const footerNote = isFinished
    ? `Final · $${pot} pot · ${gamePicks.length} pick(s) settled`
    : isOngoing
      ? `In progress · $${pot} pot · ${gamePicks.length} pick(s) locked in`
      : `Pool so far: $${pot} · ${gamePicks.length} pick(s) ${locked ? "· LOCKED" : ""} ${lineTag}`;

  div.innerHTML = showScore ? `
    <div style="font-family:'Oswald';font-size:11px;color:${isFinished ? "var(--scarlet)" : "#6fd39a"};letter-spacing:0.05em;text-transform:uppercase;">
      ${statusLabel}${tvBadge}
    </div>
    <div style="font-family:'Oswald';font-size:13px;color:var(--gray-light);margin-top:2px;">
      ${game.awayTeam} @ ${game.homeTeam}
    </div>
    ${scoreline()}
    <div class="meta" style="color:var(--gray-light);font-size:12px;margin-top:8px;">
      ${footerNote}
    </div>
    ${myPick ? renderMyPick(myPick, game, true) : `<div class="empty-state" style="padding:12px 0;">You didn't pick this one.</div>`}
  ` : `
    <div style="font-family:'Oswald';font-size:11px;color:var(--buckeye-shine);letter-spacing:0.05em;text-transform:uppercase;">
      ${statusLabel}${tvBadge}
    </div>
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
      ${footerNote}
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
