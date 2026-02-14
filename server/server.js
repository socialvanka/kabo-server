import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import crypto from "crypto";

const app = express();
app.use(cors());
app.get("/", (_, res) => res.send("Kabo server running"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;

// =====================
// Deck + Values
// =====================
const suits = ["S", "H", "D", "C"];
const ranks = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];

function makeDeck() {
  const deck = [];
  for (const s of suits) for (const r of ranks) deck.push({ r, s });
  return deck;
}

function baseValue(card) {
  if (card.r === "A") return 1;
  if (card.r === "J") return 11;
  if (card.r === "Q") return 12;
  if (card.r === "K") return 13;
  return parseInt(card.r, 10);
}

// scoring value: K♥ / K♦ is -1 if held in hand
function scoreValue(card) {
  if (card.r === "K" && (card.s === "H" || card.s === "D")) return -1;
  return baseValue(card);
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function roomId() {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

function isPowerCard(card) {
  return ["7","8","9","10","J","Q","K"].includes(card.r);
}

function sameRank(a, b) {
  return a && b && a.r === b.r;
}

/**
 * RULE: draw pile only.
 * If draw pile empty => recycle discard into draw by shuffling.
 */
function refillDrawPileIfNeeded(room) {
  if (room.drawPile.length > 0) return;
  if (room.discardPile.length === 0) throw new Error("No cards left to draw");
  room.drawPile = shuffle(room.discardPile.splice(0));
  room.log.push("Draw pile refilled from center pile (reshuffled).");
}

const rooms = new Map();

function getRoomOrThrow(id) {
  const room = rooms.get(id);
  if (!room) throw new Error("Room not found");
  return room;
}

function ensurePlayer(room, socketId) {
  const idx = room.players.findIndex(p => p.socketId === socketId);
  if (idx < 0) throw new Error("Not in room");
  return idx;
}

function currentTurnSocket(room) {
  return room.players[room.turnIndex]?.socketId ?? null;
}

function ensureTurn(room, socketId) {
  if (currentTurnSocket(room) !== socketId) throw new Error("Not your turn");
}

function computeHandSum(room, socketId) {
  const p = room.players.find(x => x.socketId === socketId);
  if (!p) throw new Error("Not in room");
  return p.hand.reduce((sum, c) => sum + scoreValue(c), 0);
}

function startGame(room) {
  if (room.players.length !== 2) throw new Error("Need 2 players");

  const deck = shuffle(makeDeck());

  for (const p of room.players) {
    p.hand = [deck.pop(), deck.pop(), deck.pop(), deck.pop()];
    p.peeksLeft = 2;
  }

  room.drawPile = deck;
  room.discardPile = [];
  room.started = true;
  room.turnIndex = 0;
  room.phase = "PEEK";
  room.activeDraw = null;
  room.caboCalledBy = null;
  room.lastTurnFor = null;
  room.skipNextFor = null;
  room.pending = null;
  room.log = ["Game started. Each player: peek 2 cards (flip for 3s)."];
  room.ended = null;
  room.centerPower = null;

  room.valentineUnlocked = false;
  room.valState = { noClicks: 0, accepted: false };
}

function scores(room) {
  const s = room.players.map(p => ({
    name: p.name,
    score: p.hand.reduce((sum, c) => sum + scoreValue(c), 0)
  }));
  s.sort((a,b)=>a.score-b.score);
  return { scores: s, winnerName: s[0].name };
}

function publicState(room, viewerSocketId) {
  const players = room.players.map(p => {
    const isMe = p.socketId === viewerSocketId;
    return {
      socketId: p.socketId,
      name: p.name,
      peeksLeft: p.peeksLeft,
      hand: room.phase === "ENDED"
        ? p.hand.map(c => ({ ...c, base: baseValue(c), score: scoreValue(c) }))
        : p.hand.map(() => null),
      handCount: p.hand.length,
      isMe
    };
  });

  const top = room.discardPile.at(-1) || null;

  return {
    id: room.id,
    started: room.started,
    phase: room.phase,
    players,
    turnSocketId: room.started ? currentTurnSocket(room) : null,
    drawCount: room.drawPile.length,
    discardCount: room.discardPile.length,
    discardTop: top ? ({ ...top, base: baseValue(top), score: scoreValue(top) }) : null,
    caboCalledBy: room.caboCalledBy,
    lastTurnFor: room.lastTurnFor,
    log: room.log.slice(-14),
    ended: room.ended || null,

    // valentine
    valentineUnlocked: room.valentineUnlocked,
    valState: room.valState
  };
}

function emitRoom(room) {
  for (const p of room.players) {
    io.to(p.socketId).emit("room:update", publicState(room, p.socketId));
  }
}

function unlockValentine(room) {
  room.valentineUnlocked = true;
  room.log.push("Valentine page unlocked 💜");
  for (const p of room.players) {
    io.to(p.socketId).emit("val:unlocked", { ok: true, valState: room.valState });
  }
}

function endRound(room) {
  room.phase = "ENDED";
  room.ended = scores(room);
  room.log.push(`Round ended. Winner: ${room.ended.winnerName}`);
  unlockValentine(room);
}

function advanceTurn(room) {
  if (room.lastTurnFor && currentTurnSocket(room) === room.lastTurnFor) {
    endRound(room);
    return;
  }

  room.turnIndex = (room.turnIndex + 1) % room.players.length;

  const nextSock = currentTurnSocket(room);
  if (room.skipNextFor && room.skipNextFor === nextSock) {
    room.log.push(`${room.players[room.turnIndex].name} was skipped.`);
    room.skipNextFor = null;
    room.turnIndex = (room.turnIndex + 1) % room.players.length;
  }

  room.phase = "TURN_DRAW";
  room.activeDraw = null;
  room.pending = null;
  room.log.push(`${room.players[room.turnIndex].name}'s turn.`);
}

function maybeEnterCenterPower(room, ownerSocketId, cardJustPlacedOnCenter) {
  if (!isPowerCard(cardJustPlacedOnCenter)) return false;

  room.centerPower = { card: cardJustPlacedOnCenter, ownerSocketId };
  room.phase = "CENTER_POWER";

  io.to(ownerSocketId).emit("center:powerAvailable", {
    card: { ...cardJustPlacedOnCenter, base: baseValue(cardJustPlacedOnCenter), score: scoreValue(cardJustPlacedOnCenter) }
  });

  room.log.push(`Center power available for ${room.players.find(p=>p.socketId===ownerSocketId)?.name}.`);
  return true;
}

io.on("connection", (socket) => {

  socket.on("room:create", ({ name }, cb) => {
    try {
      const id = roomId();
      const room = {
        id,
        players: [],
        started: false,
        turnIndex: 0,
        drawPile: [],
        discardPile: [],
        phase: "LOBBY",
        activeDraw: null,
        caboCalledBy: null,
        lastTurnFor: null,
        skipNextFor: null,
        pending: null,
        log: [],
        ended: null,
        valentineUnlocked: false,
        valState: { noClicks: 0, accepted: false },

        centerPower: null
      };
      rooms.set(id, room);

      room.players.push({
        socketId: socket.id,
        name: (name || "Host").slice(0, 16),
        peeksLeft: 2,
        hand: []
      });

      socket.join(id);
      room.log.push(`${room.players[0].name} created room ${id}.`);
      emitRoom(room);
      cb?.({ ok: true, roomId: id });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on("room:join", ({ roomId, name }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      if (room.players.length >= 2) throw new Error("Room full");

      room.players.push({
        socketId: socket.id,
        name: (name || "Player 2").slice(0, 16),
        peeksLeft: 2,
        hand: []
      });

      socket.join(roomId);
      room.log.push(`${room.players[1].name} joined.`);
      emitRoom(room);
      cb?.({ ok: true });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on("game:start", ({ roomId }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      if (room.players[0]?.socketId !== socket.id) throw new Error("Only host can start");
      startGame(room);
      emitRoom(room);
      cb?.({ ok: true });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  // HOST BYPASS -> unlock valentine for both anytime
  socket.on("room:bypass", ({ roomId }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      if (room.players[0]?.socketId !== socket.id) throw new Error("Only host can bypass");
      room.log.push("Host bypassed → Valentine unlocked.");
      unlockValentine(room);
      emitRoom(room);
      cb?.({ ok: true });
    } catch (e) {
      cb?.({ ok:false, error:e.message });
    }
  });

  // Valentine sync events
  socket.on("val:no", ({ roomId }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      room.valState.noClicks = (room.valState.noClicks || 0) + 1;
      room.log.push(`Valentine: NO clicked (${room.valState.noClicks}).`);
      io.to(roomId).emit("val:update", { valState: room.valState });
      emitRoom(room);
      cb?.({ ok: true, valState: room.valState });
    } catch (e) { cb?.({ ok:false, error:e.message }); }
  });

  socket.on("val:yes", ({ roomId }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      room.valState.accepted = true;
      room.log.push("Valentine: YES clicked 💜");
      io.to(roomId).emit("val:update", { valState: room.valState });
      emitRoom(room);
      cb?.({ ok: true, valState: room.valState });
    } catch (e) { cb?.({ ok:false, error:e.message }); }
  });

  // Peek (dynamic index)
  socket.on("game:peek", ({ roomId, index }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      if (room.phase !== "PEEK") throw new Error("Peek phase ended");
      const pIdx = ensurePlayer(room, socket.id);
      const p = room.players[pIdx];
      if (p.peeksLeft <= 0) throw new Error("No peeks left");
      if (index < 0 || index >= p.hand.length) throw new Error("Bad index");

      p.peeksLeft -= 1;

      socket.emit("peek:result", {
        index,
        card: { ...p.hand[index], base: baseValue(p.hand[index]), score: scoreValue(p.hand[index]) },
        peeksLeft: p.peeksLeft
      });

      room.log.push(`${p.name} peeked a card.`);
      if (room.players.every(x => x.peeksLeft === 0)) {
        room.phase = "TURN_DRAW";
        room.log.push(`Peeks done. ${room.players[room.turnIndex].name}'s turn.`);
      }

      emitRoom(room);
      cb?.({ ok: true });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  // Draw only (no discard take)
  socket.on("turn:take", ({ roomId, source }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      if (!["TURN_DRAW","LAST_TURN"].includes(room.phase)) throw new Error("Not in draw phase");
      ensureTurn(room, socket.id);
      if (room.activeDraw) throw new Error("Already drew a card");
      if (room.pending) throw new Error("Resolve pending action first");
      if (source && source !== "draw") throw new Error("Rule: draw pile only.");

      refillDrawPileIfNeeded(room);
      const card = room.drawPile.pop();

      room.activeDraw = { card };
      room.phase = "TURN_DECIDE";
      room.log.push(`${room.players[room.turnIndex].name} drew a card.`);

      socket.emit("turn:drawResult", {
        card: { ...card, base: baseValue(card), score: scoreValue(card) },
        power: isPowerCard(card)
      });

      emitRoom(room);
      cb?.({ ok: true });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  // Swap drawn into hand -> old card goes to center (discard pile)
  socket.on("turn:swap", ({ roomId, handIndex }, cb) => {
  try {
    const room = getRoomOrThrow(roomId);
    if (room.phase !== "TURN_DECIDE") throw new Error("Not in decide phase");
    ensureTurn(room, socket.id);
    if (!room.activeDraw) throw new Error("No drawn card");
    if (room.pending) throw new Error("Resolve pending action first");

    const p = room.players[room.turnIndex];
    if (handIndex < 0 || handIndex >= p.hand.length) throw new Error("Bad index");

    const old = p.hand[handIndex];
    p.hand[handIndex] = room.activeDraw.card;

    // old card goes to center
    room.discardPile.push(old);
    room.activeDraw = null;

    room.log.push(`${p.name} swapped and played a card to center.`);

    // ✅ NEW: If the CENTER card is a power card, allow power
    const entered = maybeEnterCenterPower(room, socket.id, old);
    emitRoom(room);

    if (!entered) {
      advanceTurn(room);
      emitRoom(room);
    }

    cb?.({ ok: true });
  } catch (e) {
    cb?.({ ok: false, error: e.message });
  }
});

  // Discard drawn -> center pile
  socket.on("turn:discardDrawn", ({ roomId }, cb) => {
  try {
    const room = getRoomOrThrow(roomId);
    if (room.phase !== "TURN_DECIDE") throw new Error("Not in decide phase");
    ensureTurn(room, socket.id);
    if (!room.activeDraw) throw new Error("No drawn card");
    if (room.pending) throw new Error("Resolve pending action first");

    const played = room.activeDraw.card;

    room.discardPile.push(played);
    room.activeDraw = null;

    room.log.push(`${room.players[room.turnIndex].name} played drawn card to center.`);

    // ✅ NEW: allow center power if the played card is power
    const entered = maybeEnterCenterPower(room, socket.id, played);
    emitRoom(room);

    if (!entered) {
      advanceTurn(room);
      emitRoom(room);
    }

    cb?.({ ok: true });
  } catch (e) {
    cb?.({ ok: false, error: e.message });
  }
});

socket.on("centerPower:skip", ({ roomId }, cb) => {
  try {
    const room = getRoomOrThrow(roomId);
    if (room.phase !== "CENTER_POWER") throw new Error("No center power to skip");
    if (!room.centerPower || room.centerPower.ownerSocketId !== socket.id) throw new Error("Not your center power");

    room.centerPower = null;
    room.log.push(`Center power skipped.`);
    advanceTurn(room);
    emitRoom(room);

    cb?.({ ok: true });
  } catch (e) { cb?.({ ok:false, error:e.message }); }
});
socket.on("centerPower:skip", ({ roomId }, cb) => {
  try {
    const room = getRoomOrThrow(roomId);
    if (room.phase !== "CENTER_POWER") throw new Error("No center power to skip");
    if (!room.centerPower || room.centerPower.ownerSocketId !== socket.id) throw new Error("Not your center power");

    room.centerPower = null;
    room.log.push(`Center power skipped.`);
    advanceTurn(room);
    emitRoom(room);

    cb?.({ ok: true });
  } catch (e) { cb?.({ ok:false, error:e.message }); }
});

  // CABO (<10)
  socket.on("turn:cabo", ({ roomId }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      if (room.phase !== "TURN_DRAW") throw new Error("Call Cabo at start of your turn");
      ensureTurn(room, socket.id);

      const sum = computeHandSum(room, socket.id);
      if (sum >= 10) throw new Error("Cabo not allowed (total must be less than 10).");

      room.caboCalledBy = socket.id;
      const opp = room.players.find(p => p.socketId !== socket.id);
      room.lastTurnFor = opp.socketId;

      room.log.push(`${room.players[room.turnIndex].name} called CABO! ${opp.name} gets last turn.`);
      room.turnIndex = room.players.findIndex(p => p.socketId === opp.socketId);
      room.phase = "LAST_TURN";
      room.activeDraw = null;
      room.pending = null;

      emitRoom(room);
      cb?.({ ok: true });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  // =====================
  // BURNING (anytime after center has a card, not in PEEK/ENDED)
  // =====================
  socket.on("burn:attempt", ({ roomId, target, index, giveIndex }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);

      if (["LOBBY","PEEK","ENDED"].includes(room.phase)) {
        throw new Error("Burn not allowed right now.");
      }

      const top = room.discardPile.at(-1);
      if (!top) throw new Error("Nothing to burn on (center pile empty).");

      const burnerIdx = ensurePlayer(room, socket.id);
      const burner = room.players[burnerIdx];
      const victimIdx = (burnerIdx + 1) % 2;
      const victim = room.players[victimIdx];

      if (target === "self") {
        if (index < 0 || index >= burner.hand.length) throw new Error("Bad index.");
        const chosen = burner.hand[index];

        if (sameRank(chosen, top)) {
          burner.hand.splice(index, 1);
          room.discardPile.push(chosen);
          room.log.push(`${burner.name} burned a card!`);
          emitRoom(room);
          cb?.({ ok: true, result: "BURN_OK" });
          return;
        }

        refillDrawPileIfNeeded(room);
        const penalty = room.drawPile.pop();
        burner.hand.push(penalty);
        room.log.push(`${burner.name} tried to burn and missed (+1 penalty).`);
        emitRoom(room);
        cb?.({ ok: true, result: "BURN_WRONG_SELF" });
        return;
      }

      if (target === "opp") {
        if (index < 0 || index >= victim.hand.length) throw new Error("Bad opponent index.");
        if (giveIndex < 0 || giveIndex >= burner.hand.length) throw new Error("Choose a card to give.");

        const chosenVictimCard = victim.hand[index];

        if (sameRank(chosenVictimCard, top)) {
          // remove victim card -> center
          victim.hand.splice(index, 1);
          room.discardPile.push(chosenVictimCard);

          // burner gives one of their cards to victim (face down)
          const gift = burner.hand.splice(giveIndex, 1)[0];
          victim.hand.push(gift);

          room.log.push(`${burner.name} steal-burned successfully!`);
          emitRoom(room);
          cb?.({ ok: true, result: "BURN_OK_STEAL" });
          return;
        }

        // wrong steal burn: reveal victim card to burner + penalty
        socket.emit("burn:revealWrong", {
          index,
          card: { ...chosenVictimCard, base: baseValue(chosenVictimCard), score: scoreValue(chosenVictimCard) }
        });

        refillDrawPileIfNeeded(room);
        const penalty = room.drawPile.pop();
        burner.hand.push(penalty);

        room.log.push(`${burner.name} steal-burned wrongly (+1 penalty, revealed card).`);
        emitRoom(room);
        cb?.({ ok: true, result: "BURN_WRONG_STEAL" });
        return;
      }

      throw new Error("Bad target.");
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  // =====================
  // POWERS (power only from drawn card; power never from burned card)
  // Using a power discards the drawn card to center.
  // =====================
  socket.on("power:peekOwn", ({ roomId, handIndex }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      ensureTurn(room, socket.id);
      if (room.phase !== "TURN_DECIDE") throw new Error("Not in decide phase");
      if (!room.activeDraw) throw new Error("No drawn card");
      const c = room.activeDraw.card;
      if (!["7","8"].includes(c.r)) throw new Error("Not 7/8");

      const p = room.players[room.turnIndex];
      if (handIndex < 0 || handIndex >= p.hand.length) throw new Error("Bad index");

      socket.emit("power:reveal", {
        kind: "own",
        index: handIndex,
        card: { ...p.hand[handIndex], base: baseValue(p.hand[handIndex]), score: scoreValue(p.hand[handIndex]) }
      });

      room.discardPile.push(room.activeDraw.card);
      room.activeDraw = null;

      room.log.push(`${p.name} used 7/8 (peek own).`);
      advanceTurn(room);
      emitRoom(room);
      cb?.({ ok: true });
    } catch (e) { cb?.({ ok:false, error:e.message }); }
  });

  socket.on("power:peekOpp", ({ roomId, oppIndex }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      ensureTurn(room, socket.id);
      if (room.phase !== "TURN_DECIDE") throw new Error("Not in decide phase");
      if (!room.activeDraw) throw new Error("No drawn card");
      const c = room.activeDraw.card;
      if (!["9","10"].includes(c.r)) throw new Error("Not 9/10");

      const meIdx = room.turnIndex;
      const opp = room.players[(meIdx + 1) % 2];
      if (oppIndex < 0 || oppIndex >= opp.hand.length) throw new Error("Bad index");

      socket.emit("power:reveal", {
        kind: "opp",
        index: oppIndex,
        card: { ...opp.hand[oppIndex], base: baseValue(opp.hand[oppIndex]), score: scoreValue(opp.hand[oppIndex]) }
      });

      room.discardPile.push(room.activeDraw.card);
      room.activeDraw = null;

      room.log.push(`${room.players[meIdx].name} used 9/10 (peek opp).`);
      advanceTurn(room);
      emitRoom(room);
      cb?.({ ok: true });
    } catch (e) { cb?.({ ok:false, error:e.message }); }
  });

  socket.on("power:jackSkip", ({ roomId }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      ensureTurn(room, socket.id);
      if (room.phase !== "TURN_DECIDE") throw new Error("Not in decide phase");
      if (!room.activeDraw) throw new Error("No drawn card");
      const c = room.activeDraw.card;
      if (c.r !== "J") throw new Error("Not a Jack");

      const meIdx = room.turnIndex;
      const opp = room.players[(meIdx + 1) % 2];
      room.skipNextFor = opp.socketId;

      room.discardPile.push(room.activeDraw.card);
      room.activeDraw = null;

      room.log.push(`${room.players[meIdx].name} used Jack (skip opp).`);
      advanceTurn(room);
      emitRoom(room);
      cb?.({ ok: true });
    } catch (e) { cb?.({ ok:false, error:e.message }); }
  });

  socket.on("power:queenUnseenSwap", ({ roomId, myIndex, oppIndex }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      ensureTurn(room, socket.id);
      if (room.phase !== "TURN_DECIDE") throw new Error("Not in decide phase");
      if (!room.activeDraw) throw new Error("No drawn card");
      const c = room.activeDraw.card;
      if (c.r !== "Q") throw new Error("Not a Queen");

      const meIdx = room.turnIndex;
      const me = room.players[meIdx];
      const opp = room.players[(meIdx + 1) % 2];

      if (myIndex < 0 || myIndex >= me.hand.length) throw new Error("Bad my index");
      if (oppIndex < 0 || oppIndex >= opp.hand.length) throw new Error("Bad opp index");

      const temp = me.hand[myIndex];
      me.hand[myIndex] = opp.hand[oppIndex];
      opp.hand[oppIndex] = temp;

      room.discardPile.push(room.activeDraw.card);
      room.activeDraw = null;

      room.log.push(`${me.name} used Queen (unseen swap).`);
      advanceTurn(room);
      emitRoom(room);
      cb?.({ ok: true });
    } catch (e) { cb?.({ ok:false, error:e.message }); }
  });

  socket.on("power:kingPreview", ({ roomId, myIndex, oppIndex }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      ensureTurn(room, socket.id);
      if (room.phase !== "TURN_DECIDE") throw new Error("Not in decide phase");
      if (!room.activeDraw) throw new Error("No drawn card");
      if (room.pending) throw new Error("Already pending");
      const c = room.activeDraw.card;
      if (c.r !== "K") throw new Error("Not a King");

      const meIdx = room.turnIndex;
      const me = room.players[meIdx];
      const opp = room.players[(meIdx + 1) % 2];

      if (myIndex < 0 || myIndex >= me.hand.length) throw new Error("Bad my index");
      if (oppIndex < 0 || oppIndex >= opp.hand.length) throw new Error("Bad opp index");

      room.pending = { type: "KING_CONFIRM", playerSocketId: socket.id, myIndex, oppIndex };

      socket.emit("king:preview", {
        myIndex,
        oppIndex,
        myCard: { ...me.hand[myIndex], base: baseValue(me.hand[myIndex]), score: scoreValue(me.hand[myIndex]) },
        oppCard: { ...opp.hand[oppIndex], base: baseValue(opp.hand[oppIndex]), score: scoreValue(opp.hand[oppIndex]) }
      });

      cb?.({ ok: true });
    } catch (e) { cb?.({ ok:false, error:e.message }); }
  });

  socket.on("power:kingConfirm", ({ roomId, confirm }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      ensureTurn(room, socket.id);
      if (room.phase !== "TURN_DECIDE") throw new Error("Not in decide phase");
      if (!room.activeDraw) throw new Error("No drawn card");
      if (!room.pending || room.pending.type !== "KING_CONFIRM") throw new Error("No pending king action");
      if (room.pending.playerSocketId !== socket.id) throw new Error("Not your pending action");

      const { myIndex, oppIndex } = room.pending;
      const meIdx = room.turnIndex;
      const me = room.players[meIdx];
      const opp = room.players[(meIdx + 1) % 2];

      if (confirm) {
        const temp = me.hand[myIndex];
        me.hand[myIndex] = opp.hand[oppIndex];
        opp.hand[oppIndex] = temp;
        room.log.push(`${me.name} used King (seen swap confirmed).`);
      } else {
        room.log.push(`${me.name} cancelled King swap.`);
      }

      room.discardPile.push(room.activeDraw.card);
      room.activeDraw = null;
      room.pending = null;

      advanceTurn(room);
      emitRoom(room);
      cb?.({ ok: true });
    } catch (e) { cb?.({ ok:false, error:e.message }); }
  });
function requireCenterPower(room, socketId) {
  if (room.phase !== "CENTER_POWER") throw new Error("Not in center power phase");
  if (!room.centerPower) throw new Error("No center power");
  if (room.centerPower.ownerSocketId !== socketId) throw new Error("Not your center power");
  return room.centerPower.card;
}

// 7/8 peek own
socket.on("centerPower:peekOwn", ({ roomId, handIndex }, cb) => {
  try {
    const room = getRoomOrThrow(roomId);
    ensureTurn(room, socket.id);

    const c = requireCenterPower(room, socket.id);
    if (!["7","8"].includes(c.r)) throw new Error("Not 7/8");
    const p = room.players[room.turnIndex];
    if (handIndex < 0 || handIndex >= p.hand.length) throw new Error("Bad index");

    socket.emit("power:reveal", {
      kind: "own",
      index: handIndex,
      card: { ...p.hand[handIndex], base: baseValue(p.hand[handIndex]), score: scoreValue(p.hand[handIndex]) }
    });

    room.centerPower = null;
    room.log.push(`${p.name} used CENTER 7/8 (peek own).`);
    advanceTurn(room);
    emitRoom(room);
    cb?.({ ok:true });
  } catch (e) { cb?.({ ok:false, error:e.message }); }
});

// 9/10 peek opp
socket.on("centerPower:peekOpp", ({ roomId, oppIndex }, cb) => {
  try {
    const room = getRoomOrThrow(roomId);
    ensureTurn(room, socket.id);

    const c = requireCenterPower(room, socket.id);
    if (!["9","10"].includes(c.r)) throw new Error("Not 9/10");

    const meIdx = room.turnIndex;
    const opp = room.players[(meIdx + 1) % 2];
    if (oppIndex < 0 || oppIndex >= opp.hand.length) throw new Error("Bad index");

    socket.emit("power:reveal", {
      kind: "opp",
      index: oppIndex,
      card: { ...opp.hand[oppIndex], base: baseValue(opp.hand[oppIndex]), score: scoreValue(opp.hand[oppIndex]) }
    });

    room.centerPower = null;
    room.log.push(`${room.players[meIdx].name} used CENTER 9/10 (peek opp).`);
    advanceTurn(room);
    emitRoom(room);
    cb?.({ ok:true });
  } catch (e) { cb?.({ ok:false, error:e.message }); }
});

// Jack skip
socket.on("centerPower:jackSkip", ({ roomId }, cb) => {
  try {
    const room = getRoomOrThrow(roomId);
    ensureTurn(room, socket.id);

    const c = requireCenterPower(room, socket.id);
    if (c.r !== "J") throw new Error("Not Jack");

    const meIdx = room.turnIndex;
    const opp = room.players[(meIdx + 1) % 2];
    room.skipNextFor = opp.socketId;

    room.centerPower = null;
    room.log.push(`${room.players[meIdx].name} used CENTER Jack (skip).`);
    advanceTurn(room);
    emitRoom(room);
    cb?.({ ok:true });
  } catch (e) { cb?.({ ok:false, error:e.message }); }
});

// Queen unseen swap
socket.on("centerPower:queenUnseenSwap", ({ roomId, myIndex, oppIndex }, cb) => {
  try {
    const room = getRoomOrThrow(roomId);
    ensureTurn(room, socket.id);

    const c = requireCenterPower(room, socket.id);
    if (c.r !== "Q") throw new Error("Not Queen");

    const meIdx = room.turnIndex;
    const meP = room.players[meIdx];
    const opp = room.players[(meIdx + 1) % 2];
    if (myIndex < 0 || myIndex >= meP.hand.length) throw new Error("Bad my index");
    if (oppIndex < 0 || oppIndex >= opp.hand.length) throw new Error("Bad opp index");

    const tmp = meP.hand[myIndex];
    meP.hand[myIndex] = opp.hand[oppIndex];
    opp.hand[oppIndex] = tmp;

    room.centerPower = null;
    room.log.push(`${meP.name} used CENTER Queen (unseen swap).`);
    advanceTurn(room);
    emitRoom(room);
    cb?.({ ok:true });
  } catch (e) { cb?.({ ok:false, error:e.message }); }
});

function requireCenterPower(room, socketId) {
  if (room.phase !== "CENTER_POWER") throw new Error("Not in center power phase");
  if (!room.centerPower) throw new Error("No center power");
  if (room.centerPower.ownerSocketId !== socketId) throw new Error("Not your center power");
  return room.centerPower.card;
}

// 7/8 peek own
socket.on("centerPower:peekOwn", ({ roomId, handIndex }, cb) => {
  try {
    const room = getRoomOrThrow(roomId);
    ensureTurn(room, socket.id);

    const c = requireCenterPower(room, socket.id);
    if (!["7","8"].includes(c.r)) throw new Error("Not 7/8");
    const p = room.players[room.turnIndex];
    if (handIndex < 0 || handIndex >= p.hand.length) throw new Error("Bad index");

    socket.emit("power:reveal", {
      kind: "own",
      index: handIndex,
      card: { ...p.hand[handIndex], base: baseValue(p.hand[handIndex]), score: scoreValue(p.hand[handIndex]) }
    });

    room.centerPower = null;
    room.log.push(`${p.name} used CENTER 7/8 (peek own).`);
    advanceTurn(room);
    emitRoom(room);
    cb?.({ ok:true });
  } catch (e) { cb?.({ ok:false, error:e.message }); }
});

// 9/10 peek opp
socket.on("centerPower:peekOpp", ({ roomId, oppIndex }, cb) => {
  try {
    const room = getRoomOrThrow(roomId);
    ensureTurn(room, socket.id);

    const c = requireCenterPower(room, socket.id);
    if (!["9","10"].includes(c.r)) throw new Error("Not 9/10");

    const meIdx = room.turnIndex;
    const opp = room.players[(meIdx + 1) % 2];
    if (oppIndex < 0 || oppIndex >= opp.hand.length) throw new Error("Bad index");

    socket.emit("power:reveal", {
      kind: "opp",
      index: oppIndex,
      card: { ...opp.hand[oppIndex], base: baseValue(opp.hand[oppIndex]), score: scoreValue(opp.hand[oppIndex]) }
    });

    room.centerPower = null;
    room.log.push(`${room.players[meIdx].name} used CENTER 9/10 (peek opp).`);
    advanceTurn(room);
    emitRoom(room);
    cb?.({ ok:true });
  } catch (e) { cb?.({ ok:false, error:e.message }); }
});

// Jack skip
socket.on("centerPower:jackSkip", ({ roomId }, cb) => {
  try {
    const room = getRoomOrThrow(roomId);
    ensureTurn(room, socket.id);

    const c = requireCenterPower(room, socket.id);
    if (c.r !== "J") throw new Error("Not Jack");

    const meIdx = room.turnIndex;
    const opp = room.players[(meIdx + 1) % 2];
    room.skipNextFor = opp.socketId;

    room.centerPower = null;
    room.log.push(`${room.players[meIdx].name} used CENTER Jack (skip).`);
    advanceTurn(room);
    emitRoom(room);
    cb?.({ ok:true });
  } catch (e) { cb?.({ ok:false, error:e.message }); }
});

// Queen unseen swap
socket.on("centerPower:queenUnseenSwap", ({ roomId, myIndex, oppIndex }, cb) => {
  try {
    const room = getRoomOrThrow(roomId);
    ensureTurn(room, socket.id);

    const c = requireCenterPower(room, socket.id);
    if (c.r !== "Q") throw new Error("Not Queen");

    const meIdx = room.turnIndex;
    const meP = room.players[meIdx];
    const opp = room.players[(meIdx + 1) % 2];
    if (myIndex < 0 || myIndex >= meP.hand.length) throw new Error("Bad my index");
    if (oppIndex < 0 || oppIndex >= opp.hand.length) throw new Error("Bad opp index");

    const tmp = meP.hand[myIndex];
    meP.hand[myIndex] = opp.hand[oppIndex];
    opp.hand[oppIndex] = tmp;

    room.centerPower = null;
    room.log.push(`${meP.name} used CENTER Queen (unseen swap).`);
    advanceTurn(room);
    emitRoom(room);
    cb?.({ ok:true });
  } catch (e) { cb?.({ ok:false, error:e.message }); }
});

  socket.on("disconnect", () => {
    for (const [id, room] of rooms.entries()) {
      const idx = room.players.findIndex(p => p.socketId === socket.id);
      if (idx >= 0) {
        const name = room.players[idx].name;
        room.players.splice(idx, 1);
        room.log.push(`${name} disconnected.`);

        if (room.players.length === 0) {
          rooms.delete(id);
        } else {
          room.started = false;
          room.phase = "LOBBY";
          room.drawPile = [];
          room.discardPile = [];
          room.activeDraw = null;
          room.caboCalledBy = null;
          room.lastTurnFor = null;
          room.skipNextFor = null;
          room.pending = null;
          room.ended = null;
          room.log.push(`Back to lobby.`);
          emitRoom(room);
        }
        break;
      }
    }
  });
});

server.listen(PORT, () => console.log(`Kabo server listening on :${PORT}`));
