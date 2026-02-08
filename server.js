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

// Crypto-strong Fisher–Yates shuffle
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

// When draw pile empties: keep top discard, reshuffle rest into draw pile
function refillDrawPileIfNeeded(room) {
  if (room.drawPile.length > 0) return;
  if (room.discardPile.length <= 1) throw new Error("No cards left to draw");

  const top = room.discardPile.pop();           // keep top discard
  const toShuffle = room.discardPile.splice(0); // everything else
  room.drawPile = shuffle(toShuffle);
  room.discardPile.push(top);
}

// Used power cards should NOT become next discardTop
function buryUsedPower(room, card) {
  // Put under the pile so discardTop doesn't become that same power card
  room.discardPile.unshift(card);
}

/**
room = {
  id,
  players: [{ socketId, name, peeksLeft, hand:[card*4] }],
  started,
  turnIndex,
  drawPile,
  discardPile,
  phase: "LOBBY"|"PEEK"|"TURN_DRAW"|"TURN_DECIDE"|"LAST_TURN"|"ENDED",
  activeDraw: null | { source:"draw"|"discard", card },
  caboCalledBy: null|socketId,
  lastTurnFor: null|socketId,
  skipNextFor: null|socketId,
  pending: null | { type:"KING_CONFIRM", playerSocketId, myIndex, oppIndex },
  log,
  ended
}
*/

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

function computeHandSumForCabo(room, socketId) {
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
  room.discardPile = [room.drawPile.pop()];
  room.started = true;
  room.turnIndex = 0;
  room.phase = "PEEK";
  room.activeDraw = null;
  room.caboCalledBy = null;
  room.lastTurnFor = null;
  room.skipNextFor = null;
  room.pending = null;
  room.log = ["Game started. Each player: peek 2 cards (memory flash)."];
  room.ended = null;
}

function scores(room) {
  const s = room.players.map(p => ({
    name: p.name,
    score: p.hand.reduce((sum, c) => sum + scoreValue(c), 0)
  }));
  s.sort((a,b)=>a.score-b.score);
  return { scores: s, winnerName: s[0].name };
}

/**
 * ✅ PRIVACY FIX:
 * - NEVER include "activeDraw" or any drawn card in room:update
 * - The only drawn-card reveal is private: "turn:drawResult" to the active player
 */
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
      isMe
    };
  });

  const discardTop = room.discardPile[room.discardPile.length - 1] || null;

  return {
    id: room.id,
    started: room.started,
    phase: room.phase,
    players,
    turnSocketId: room.started ? currentTurnSocket(room) : null,
    drawCount: room.drawPile.length,
    discardTop: discardTop ? { ...discardTop, base: baseValue(discardTop), score: scoreValue(discardTop) } : null,
    caboCalledBy: room.caboCalledBy,
    lastTurnFor: room.lastTurnFor,
    log: room.log.slice(-10),
    ended: room.ended || null
  };
}

function emitRoom(room) {
  for (const p of room.players) {
    io.to(p.socketId).emit("room:update", publicState(room, p.socketId));
  }
}

function endRound(room) {
  room.phase = "ENDED";
  room.ended = scores(room);
  room.log.push(`Round ended. Winner: ${room.ended.winnerName}`);
}

function advanceTurn(room) {
  // If this was the last-turn player finishing, end immediately
  if (room.lastTurnFor && currentTurnSocket(room) === room.lastTurnFor) {
    endRound(room);
    return;
  }

  room.turnIndex = (room.turnIndex + 1) % room.players.length;

  // apply skip once
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
        ended: null
      };
      rooms.set(id, room);

      room.players.push({
        socketId: socket.id,
        name: (name || "Player 1").slice(0, 16),
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

  // Initial peek (2 flashes)
  socket.on("game:peek", ({ roomId, index }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      if (room.phase !== "PEEK") throw new Error("Peek phase ended");
      const pIdx = ensurePlayer(room, socket.id);
      const p = room.players[pIdx];
      if (p.peeksLeft <= 0) throw new Error("No peeks left");
      if (![0,1,2,3].includes(index)) throw new Error("Bad index");

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

  // Take from draw/discard
  socket.on("turn:take", ({ roomId, source }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      if (!["TURN_DRAW","LAST_TURN"].includes(room.phase)) throw new Error("Not in draw phase");
      ensureTurn(room, socket.id);
      if (room.activeDraw) throw new Error("Already took a card");
      if (room.pending) throw new Error("Resolve pending action first");

      let card;
      if (source === "draw") {
        refillDrawPileIfNeeded(room);
        card = room.drawPile.pop();
      } else if (source === "discard") {
        if (room.discardPile.length === 0) throw new Error("Discard empty");
        card = room.discardPile.pop();
      } else throw new Error("Bad source");

      room.activeDraw = { source, card };
      room.phase = "TURN_DECIDE";
      room.log.push(`${room.players[room.turnIndex].name} took a card.`);

      // ✅ PRIVATE reveal to the active player ONLY
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

  // Swap drawn into hand (normal discard goes to TOP)
  socket.on("turn:swap", ({ roomId, handIndex }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      if (room.phase !== "TURN_DECIDE") throw new Error("Not in decide phase");
      ensureTurn(room, socket.id);
      if (!room.activeDraw) throw new Error("No drawn card");
      if (![0,1,2,3].includes(handIndex)) throw new Error("Bad index");
      if (room.pending) throw new Error("Resolve pending action first");

      const p = room.players[room.turnIndex];
      const old = p.hand[handIndex];
      p.hand[handIndex] = room.activeDraw.card;

      room.discardPile.push(old);      // old card becomes discardTop
      room.activeDraw = null;

      room.log.push(`${p.name} swapped a card.`);
      advanceTurn(room);
      emitRoom(room);
      cb?.({ ok: true });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  // Discard drawn (normal discard goes to TOP)
  socket.on("turn:discardDrawn", ({ roomId }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      if (room.phase !== "TURN_DECIDE") throw new Error("Not in decide phase");
      ensureTurn(room, socket.id);
      if (!room.activeDraw) throw new Error("No drawn card");
      if (room.pending) throw new Error("Resolve pending action first");

      room.discardPile.push(room.activeDraw.card); // becomes discardTop
      room.activeDraw = null;

      room.log.push(`${room.players[room.turnIndex].name} discarded drawn card.`);
      advanceTurn(room);
      emitRoom(room);
      cb?.({ ok: true });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  // CABO only allowed if sum <= 5
  socket.on("turn:cabo", ({ roomId }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      if (room.phase !== "TURN_DRAW") throw new Error("Call Cabo at start of your turn");
      ensureTurn(room, socket.id);

      const sum = computeHandSumForCabo(room, socket.id);
      if (sum > 5) throw new Error("Cabo not allowed (total must be 5 or less).");

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
  // POWERS (Option B): Use power then discard the drawn card
  // ✅ FIX: bury used power cards (unshift) so they don't become discardTop
  // =====================

  socket.on("power:peekOwn", ({ roomId, handIndex }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      ensureTurn(room, socket.id);
      if (room.phase !== "TURN_DECIDE") throw new Error("Not in decide phase");
      if (!room.activeDraw) throw new Error("No drawn card");
      const c = room.activeDraw.card;
      if (!["7","8"].includes(c.r)) throw new Error("Not 7/8");
      if (![0,1,2,3].includes(handIndex)) throw new Error("Bad index");

      const p = room.players[room.turnIndex];

      socket.emit("power:reveal", {
        kind: "own",
        index: handIndex,
        card: { ...p.hand[handIndex], base: baseValue(p.hand[handIndex]), score: scoreValue(p.hand[handIndex]) }
      });

      buryUsedPower(room, room.activeDraw.card);
      room.activeDraw = null;

      room.log.push(`${p.name} used 7/8 to peek own card.`);
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
      if (![0,1,2,3].includes(oppIndex)) throw new Error("Bad index");

      const meIdx = room.turnIndex;
      const opp = room.players[(meIdx + 1) % 2];

      socket.emit("power:reveal", {
        kind: "opp",
        index: oppIndex,
        card: { ...opp.hand[oppIndex], base: baseValue(opp.hand[oppIndex]), score: scoreValue(opp.hand[oppIndex]) }
      });

      buryUsedPower(room, room.activeDraw.card);
      room.activeDraw = null;

      room.log.push(`${room.players[meIdx].name} used 9/10 to peek opponent.`);
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

      buryUsedPower(room, room.activeDraw.card);
      room.activeDraw = null;

      room.log.push(`${room.players[meIdx].name} used Jack: ${opp.name} will be skipped.`);
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
      if (![0,1,2,3].includes(myIndex) || ![0,1,2,3].includes(oppIndex)) throw new Error("Bad index");

      const meIdx = room.turnIndex;
      const me = room.players[meIdx];
      const opp = room.players[(meIdx + 1) % 2];

      const temp = me.hand[myIndex];
      me.hand[myIndex] = opp.hand[oppIndex];
      opp.hand[oppIndex] = temp;

      buryUsedPower(room, room.activeDraw.card);
      room.activeDraw = null;

      room.log.push(`${me.name} used Queen: unseen swap.`);
      advanceTurn(room);
      emitRoom(room);
      cb?.({ ok: true });
    } catch (e) { cb?.({ ok:false, error:e.message }); }
  });

  // King seen swap (K1): preview both then confirm
  socket.on("power:kingPreview", ({ roomId, myIndex, oppIndex }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      ensureTurn(room, socket.id);
      if (room.phase !== "TURN_DECIDE") throw new Error("Not in decide phase");
      if (!room.activeDraw) throw new Error("No drawn card");
      if (room.pending) throw new Error("Already pending");
      const c = room.activeDraw.card;
      if (c.r !== "K") throw new Error("Not a King");
      if (![0,1,2,3].includes(myIndex) || ![0,1,2,3].includes(oppIndex)) throw new Error("Bad index");

      room.pending = { type: "KING_CONFIRM", playerSocketId: socket.id, myIndex, oppIndex };

      const meIdx = room.turnIndex;
      const me = room.players[meIdx];
      const opp = room.players[(meIdx + 1) % 2];

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
        room.log.push(`${me.name} used King: seen swap confirmed.`);
      } else {
        room.log.push(`${me.name} used King: swap cancelled.`);
      }

      buryUsedPower(room, room.activeDraw.card);
      room.activeDraw = null;
      room.pending = null;

      advanceTurn(room);
      emitRoom(room);
      cb?.({ ok: true });
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
