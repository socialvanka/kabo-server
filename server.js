import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors());
app.get("/", (_, res) => res.send("Kabo server running"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;

// -------- Game rules (MVP) --------
// Use standard deck mapped to values (Ace=1, 2-10 as is, J=11, Q=12, K=13)
// 4 cards per player, initial peek 2 cards.
function makeDeck() {
  const suits = ["S", "H", "D", "C"];
  const ranks = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
  const deck = [];
  for (const s of suits) for (const r of ranks) deck.push({ r, s });
  return deck;
}

function valueOf(card) {
  if (card.r === "A") return 1;
  if (card.r === "J") return 11;
  if (card.r === "Q") return 12;
  if (card.r === "K") return 13;
  return parseInt(card.r, 10);
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function roomId() {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

const rooms = new Map();
/**
room = {
  id,
  players: [{ socketId, name, peeksLeft, hand:[card,card,card,card] }],
  started,
  turnIndex,
  drawPile: [card...],
  discardPile: [card...],
  phase: "PEEK"|"TURN_DRAW"|"TURN_DECIDE"|"LAST_TURN"|"ENDED",
  activeDraw: null | { source:"draw"|"discard", card },
  caboCalledBy: null | socketId,
  lastTurnFor: null | socketId,
  log: [string...],
  ended: { scores: [{name,score}], winnerName }
}
*/

function publicState(room, viewerSocketId) {
  const players = room.players.map(p => {
    const isMe = p.socketId === viewerSocketId;
    return {
      socketId: p.socketId,
      name: p.name,
      peeksLeft: p.peeksLeft,
      // hide hand values unless game ended; if ended reveal all
      hand: room.phase === "ENDED"
        ? p.hand.map(c => ({ ...c, v: valueOf(c) }))
        : p.hand.map(() => null),
      // during PEEK only reveal for self by separate event; so keep null here
      isMe
    };
  });

  return {
    id: room.id,
    started: room.started,
    phase: room.phase,
    players,
    turnSocketId: room.started ? room.players[room.turnIndex]?.socketId : null,
    drawCount: room.drawPile.length,
    discardTop: room.discardPile[room.discardPile.length - 1] || null,
    activeDraw: room.activeDraw
      ? { source: room.activeDraw.source, card: (room.activeDraw.source === "discard" ? room.activeDraw.card : null) }
      : null,
    caboCalledBy: room.caboCalledBy,
    lastTurnFor: room.lastTurnFor,
    log: room.log.slice(-8),
    ended: room.ended || null
  };
}

function emitRoom(room) {
  for (const p of room.players) {
    io.to(p.socketId).emit("room:update", publicState(room, p.socketId));
  }
}

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

function ensureTurn(room, socketId) {
  if (room.players[room.turnIndex]?.socketId !== socketId) {
    throw new Error("Not your turn");
  }
}

// Start game when 2 players are present and host triggers
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
  room.log = ["Game started. Each player: peek 2 cards."];
}

function scores(room) {
  const s = room.players.map(p => ({
    name: p.name,
    score: p.hand.reduce((sum, c) => sum + valueOf(c), 0)
  }));
  s.sort((a,b)=>a.score-b.score);
  return { scores: s, winnerName: s[0].name };
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
        log: []
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

  socket.on("game:peek", ({ roomId, index }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      if (room.phase !== "PEEK") throw new Error("Peek phase ended");
      const pIdx = ensurePlayer(room, socket.id);
      const p = room.players[pIdx];
      if (p.peeksLeft <= 0) throw new Error("No peeks left");
      if (![0,1,2,3].includes(index)) throw new Error("Bad index");
      p.peeksLeft -= 1;

      // Send only to that player (private info)
      socket.emit("peek:result", { index, card: { ...p.hand[index], v: valueOf(p.hand[index]) }, peeksLeft: p.peeksLeft });

      room.log.push(`${p.name} peeked a card.`);
      // If both players done peeking, move to turn phase
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

  socket.on("turn:take", ({ roomId, source }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      if (!["TURN_DRAW","LAST_TURN"].includes(room.phase)) throw new Error("Not in draw phase");
      ensureTurn(room, socket.id);
      if (room.activeDraw) throw new Error("Already drew a card");

      let card;
      if (source === "draw") {
        if (room.drawPile.length === 0) throw new Error("Draw pile empty");
        card = room.drawPile.pop();
      } else if (source === "discard") {
        if (room.discardPile.length === 0) throw new Error("Discard empty");
        card = room.discardPile.pop();
      } else throw new Error("Bad source");

      room.activeDraw = { source, card };
      room.phase = "TURN_DECIDE";
      room.log.push(`${room.players[room.turnIndex].name} took a card.`);
      emitRoom(room);
      cb?.({ ok: true, card: source === "discard" ? { ...card, v: valueOf(card) } : null });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on("turn:discardDrawn", ({ roomId }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      if (room.phase !== "TURN_DECIDE") throw new Error("Not in decide phase");
      ensureTurn(room, socket.id);
      if (!room.activeDraw) throw new Error("No drawn card");

      room.discardPile.push(room.activeDraw.card);
      room.activeDraw = null;
      room.log.push(`${room.players[room.turnIndex].name} discarded drawn card.`);
      advanceTurn(room);
      emitRoom(room);
      cb?.({ ok: true });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on("turn:swap", ({ roomId, handIndex }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      if (room.phase !== "TURN_DECIDE") throw new Error("Not in decide phase");
      ensureTurn(room, socket.id);
      if (!room.activeDraw) throw new Error("No drawn card");
      if (![0,1,2,3].includes(handIndex)) throw new Error("Bad index");

      const p = room.players[room.turnIndex];
      const old = p.hand[handIndex];
      p.hand[handIndex] = room.activeDraw.card;
      room.discardPile.push(old);
      room.activeDraw = null;

      room.log.push(`${p.name} swapped a card.`);
      advanceTurn(room);
      emitRoom(room);
      cb?.({ ok: true });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on("turn:cabo", ({ roomId }, cb) => {
    try {
      const room = getRoomOrThrow(roomId);
      if (!["TURN_DRAW","TURN_DECIDE"].includes(room.phase)) throw new Error("Can't call cabo now");
      ensureTurn(room, socket.id);

      room.caboCalledBy = socket.id;
      const opponent = room.players.find(p => p.socketId !== socket.id);
      room.lastTurnFor = opponent.socketId;
      room.phase = "LAST_TURN";
      room.activeDraw = null; // force fresh draw step
      room.log.push(`${room.players[room.turnIndex].name} called CABO! ${opponent.name} gets last turn.`);
      // give last turn to opponent
      room.turnIndex = room.players.findIndex(p => p.socketId === opponent.socketId);

      emitRoom(room);
      cb?.({ ok: true });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on("disconnect", () => {
    // remove player from room
    for (const [id, room] of rooms.entries()) {
      const idx = room.players.findIndex(p => p.socketId === socket.id);
      if (idx >= 0) {
        const name = room.players[idx].name;
        room.players.splice(idx, 1);
        room.log.push(`${name} disconnected.`);
        // If room empty, delete it
        if (room.players.length === 0) {
          rooms.delete(id);
        } else {
          // reset game if someone leaves
          room.started = false;
          room.phase = "LOBBY";
          room.drawPile = [];
          room.discardPile = [];
          room.activeDraw = null;
          room.caboCalledBy = null;
          room.lastTurnFor = null;
          room.log.push(`Back to lobby.`);
          emitRoom(room);
        }
        break;
      }
    }
  });
});

function advanceTurn(room) {
  // if last turn finished, end game
  if (room.lastTurnFor && room.players[room.turnIndex]?.socketId === room.lastTurnFor) {
    // just completed last turn -> end
    room.phase = "ENDED";
    room.ended = scores(room);
    room.log.push(`Round ended. Winner: ${room.ended.winnerName}`);
    return;
  }

  // normal next turn
  room.turnIndex = (room.turnIndex + 1) % room.players.length;
  room.phase = "TURN_DRAW";
  room.log.push(`${room.players[room.turnIndex].name}'s turn.`);
}

server.listen(PORT, () => {
  console.log(`Kabo server listening on :${PORT}`);
});
