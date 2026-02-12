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

/**
 * RULE: draw pile only.
 * if draw pile is empty, recycle discard pile into draw pile by shuffling.
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

function isHost(room, socketId) {
  return room.players[0]?.socketId === socketId;
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
  room.discardPile = []; // "center pile"
  room.started = true;
  room.turnIndex = 0;
  room.phase = "PEEK";
  room.activeDraw = null; // private drawn card for current player
  room.caboCalledBy = null;
  room.lastTurnFor = null;
  room.skipNextFor = null;
  room.pending = null;
  room.log = ["Game started. Each player: peek 2 cards (memory flip)."];
  room.ended = null;

  room.val = { active:false, accepted:false, noStep:0, yesScale:1 };
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
 * Public state:
 * - No drawn card leak
 * - Center pile top is visible to both (like real game center)
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

  const top = room.discardPile.length ? room.discardPile[room.discardPile.length - 1] : null;

  return {
    id: room.id,
    started: room.started,
    phase: room.phase,
    players,
    turnSocketId: room.started ? currentTurnSocket(room) : null,
    drawCount: room.drawPile.length,
    centerTop: top ? { ...top, base: baseValue(top), score: scoreValue(top) } : null,
    caboCalledBy: room.caboCalledBy,
    lastTurnFor: room.lastTurnFor,
    log: room.log.slice(-12),
    ended: room.ended || null,
    val: room.val || { active:false, accepted:false, noStep:0, yesScale:1 }
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

function emitToRoom(room, event, payload) {
  io.to(room.id).emit(event, payload);
}

io.on("connection", (socket) => {

  // -----------------------
  // Rooms
  // -----------------------
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
        val: { active:false, accepted:false, noStep:0, yesScale:1 }
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
      if (!isHost(room, socket.id)) throw new Error("Only host can start");
      startGame(room);
      emitRoom(room);
      cb?.({ ok: true });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  // -----------------------
  // Host bypass (ANYTIME)
  // -----------------------
  socket.on("nav:bypass", ({ roomId }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      if (!isHost(room, socket.id)) throw new Error("Only host can bypass");

      room.val.active = true;
      room.val.accepted = false;
      room.val.noStep = 0;
      room.val.yesScale = 1;
      room.log.push("Host BYPASS → Valentine page.");

      emitRoom(room);
      emitToRoom(room, "nav:valentine", { reason: "BYPASS" });

      cb?.({ ok:true });
    } catch (e) {
      cb?.({ ok:false, error:e.message });
    }
  });

  // Non-host unlock (or anyone)
  socket.on("nav:unlockValentine", ({ roomId }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      ensurePlayer(room, socket.id);

      room.val.active = true;
      room.log.push("Valentine unlocked.");
      emitRoom(room);
      emitToRoom(room, "nav:valentine", { reason: "UNLOCK" });

      cb?.({ ok:true });
    } catch (e) {
      cb?.({ ok:false, error:e.message });
    }
  });

  // Valentine actions sync
  socket.on("val:action", ({ roomId, action }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      ensurePlayer(room, socket.id);
      if (!room.val.active) throw new Error("Valentine not active");

      if (action?.type === "NO_STEP") {
        room.val.noStep = action.noStep ?? room.val.noStep;
        room.val.yesScale = action.yesScale ?? room.val.yesScale;
      }
      if (action?.type === "YES_ACCEPT") {
        room.val.accepted = true;
      }

      emitToRoom(room, "val:update", {
        from: socket.id,
        action,
        snapshot: room.val
      });

      cb?.({ ok:true });
    } catch (e) {
      cb?.({ ok:false, error:e.message });
    }
  });

  // -----------------------
  // Peek: reveal only to that player
  // (client shows flip for 3 seconds)
  // -----------------------
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

      room.log.push(`${p.name} peeked.`);
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

  // -----------------------
  // Draw (draw pile only)
  // -----------------------
  socket.on("turn:draw", ({ roomId }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      if (!["TURN_DRAW","LAST_TURN"].includes(room.phase)) throw new Error("Not in draw phase");
      ensureTurn(room, socket.id);
      if (room.activeDraw) throw new Error("Already drew a card");
      if (room.pending) throw new Error("Resolve pending action first");

      refillDrawPileIfNeeded(room);
      const card = room.drawPile.pop();

      room.activeDraw = { card };
      room.phase = "TURN_DECIDE";
      room.log.push(`${room.players[room.turnIndex].name} drew a card.`);

      // Send drawn only to current player
      socket.emit("turn:drawResult", {
        card: { ...card, base: baseValue(card), score: scoreValue(card) },
        power: isPowerCard(card)
      });

      emitRoom(room);
      cb?.({ ok:true });
    } catch (e) {
      cb?.({ ok:false, error:e.message });
    }
  });

  // -----------------------
  // Swap drawn into hand
  // Old card goes to center pile (visible)
  // -----------------------
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

      // center pile gets the swapped-out card
      room.discardPile.push(old);

      room.activeDraw = null;
      room.log.push(`${p.name} swapped and placed a card in center.`);
      advanceTurn(room);
      emitRoom(room);
      cb?.({ ok:true });
    } catch (e) {
      cb?.({ ok:false, error:e.message });
    }
  });

  // -----------------------
  // Discard drawn to center pile
  // -----------------------
  socket.on("turn:discardDrawn", ({ roomId }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      if (room.phase !== "TURN_DECIDE") throw new Error("Not in decide phase");
      ensureTurn(room, socket.id);
      if (!room.activeDraw) throw new Error("No drawn card");
      if (room.pending) throw new Error("Resolve pending action first");

      room.discardPile.push(room.activeDraw.card);
      const c = room.activeDraw.card;
      room.activeDraw = null;

      room.log.push(`${room.players[room.turnIndex].name} placed drawn card in center (${c.r}${c.s}).`);
      advanceTurn(room);
      emitRoom(room);
      cb?.({ ok:true });
    } catch (e) {
      cb?.({ ok:false, error:e.message });
    }
  });

  // -----------------------
  // CABO (<10)
  // -----------------------
  socket.on("turn:cabo", ({ roomId }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      if (room.phase !== "TURN_DRAW") throw new Error("Call CABO at start of your turn");
      ensureTurn(room, socket.id);

      const sum = computeHandSumForCabo(room, socket.id);
      if (sum >= 10) throw new Error("CABO not allowed (total must be < 10).");

      room.caboCalledBy = socket.id;
      const opp = room.players.find(p => p.socketId !== socket.id);
      room.lastTurnFor = opp.socketId;

      room.log.push(`${room.players[room.turnIndex].name} called CABO! ${opp.name} gets last turn.`);
      room.turnIndex = room.players.findIndex(p => p.socketId === opp.socketId);
      room.phase = "LAST_TURN";
      room.activeDraw = null;
      room.pending = null;

      emitRoom(room);
      cb?.({ ok:true });
    } catch (e) {
      cb?.({ ok:false, error:e.message });
    }
  });

  // ======================
  // POWERS (consume drawn)
  // NOTE: Power is ONLY from the drawn card.
  // Client enables power only for drawn card.
  // When a power is used, the drawn card is discarded to center pile.
  // ======================

  function consumeDrawnToCenter(room) {
    if (!room.activeDraw) throw new Error("No drawn card");
    room.discardPile.push(room.activeDraw.card);
    room.activeDraw = null;
  }

  // 7/8 peek own
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

      consumeDrawnToCenter(room);
      room.log.push(`${p.name} used 7/8 to peek own.`);
      advanceTurn(room);
      emitRoom(room);
      cb?.({ ok:true });
    } catch (e) { cb?.({ ok:false, error:e.message }); }
  });

  // 9/10 peek opponent
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

      consumeDrawnToCenter(room);
      room.log.push(`${room.players[meIdx].name} used 9/10 to peek opponent.`);
      advanceTurn(room);
      emitRoom(room);
      cb?.({ ok:true });
    } catch (e) { cb?.({ ok:false, error:e.message }); }
  });

  // Jack skip
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

      consumeDrawnToCenter(room);
      room.log.push(`${room.players[meIdx].name} used Jack: ${opp.name} skipped.`);
      advanceTurn(room);
      emitRoom(room);
      cb?.({ ok:true });
    } catch (e) { cb?.({ ok:false, error:e.message }); }
  });

  // Queen unseen swap
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

      consumeDrawnToCenter(room);
      room.log.push(`${me.name} used Queen: unseen swap.`);
      advanceTurn(room);
      emitRoom(room);
      cb?.({ ok:true });
    } catch (e) { cb?.({ ok:false, error:e.message }); }
  });

  // King preview -> confirm
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

      cb?.({ ok:true });
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
        room.log.push(`${me.name} used King: swap confirmed.`);
      } else {
        room.log.push(`${me.name} used King: swap cancelled.`);
      }

      consumeDrawnToCenter(room);
      room.pending = null;

      advanceTurn(room);
      emitRoom(room);
      cb?.({ ok:true });
    } catch (e) { cb?.({ ok:false, error:e.message }); }
  });

  // -----------------------
  // Disconnect cleanup
  // -----------------------
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
