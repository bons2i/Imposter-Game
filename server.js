// server.js
const express = require('express');
const http = require('http');
const { nanoid } = require('nanoid'); // optional; fallback if not installed we'll use simple generator
const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server);

app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// Simple room storage in memory
const rooms = {}; // { roomCode: { hostId, config:{numHints}, category, word, players: {socketId: {name, hints:[] , role}}, phase, votes: {}, guesses: {} } }

// small room code generator
function makeCode(len = 5) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i=0;i<len;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  // Host creates room
  socket.on('create-room', (data, cb) => {
    const code = makeCode(5);
    rooms[code] = {
      hostId: socket.id,
      config: { numHints: data.numHints || 2, maxPlayers: data.maxPlayers || 12 },
      category: null,
      word: null,
      players: {}, // socketId -> {name, hints:[], role}
      phase: 'lobby',
      votes: {},
      guesses: {}
    };
    socket.join(code);
    cb && cb({ ok: true, code });
    io.to(code).emit('room-state', sanitizeRoomForClients(code));
    console.log('room created', code);
  });

  // Player joins
  socket.on('join-room', ({ code, name }, cb) => {
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, err: 'Raum existiert nicht' });
    if (Object.keys(room.players).length >= room.config.maxPlayers) return cb && cb({ ok:false, err: 'Raum voll' });

    room.players[socket.id] = { name: name || 'Spieler', hints: [], role: 'player' };
    socket.join(code);
    cb && cb({ ok: true, code });
    io.to(code).emit('room-state', sanitizeRoomForClients(code));
    console.log(`${name} joined ${code}`);
  });

  // Host sets word + category + assign roles
  socket.on('set-word', ({ code, category, word, numHints }, cb) => {
    const room = rooms[code];
    if (!room) return cb && cb({ ok:false, err:'Raum fehlt' });
    if (socket.id !== room.hostId) return cb && cb({ ok:false, err:'Nur Host' });

    room.category = category || '';
    room.word = word || '';
    room.config.numHints = numHints || room.config.numHints;
    room.phase = 'hinting';
    room.votes = {};
    room.guesses = {};

    // pick random imposter from players
    const playerIds = Object.keys(room.players);
    if (playerIds.length === 0) {
      return cb && cb({ ok:false, err: 'Keine Spieler im Raum' });
    }
    const impIdx = Math.floor(Math.random() * playerIds.length);
    const impSocketId = playerIds[impIdx];

    // set roles
    playerIds.forEach(pid => {
      room.players[pid].hints = []; // reset hints
      room.players[pid].role = pid === impSocketId ? 'imposter' : 'player';
    });

    // notify each client of their role and the word (imposter gets no word)
    playerIds.forEach(pid => {
      const payload = {
        role: room.players[pid].role,
        category: room.category,
        word: room.players[pid].role === 'imposter' ? null : room.word,
        numHints: room.config.numHints
      };
      io.to(pid).emit('role-assigned', payload);
    });

    // Host should be able to see who is imposter
    io.to(room.hostId).emit('host-info', { imposterId: impSocketId, imposterName: room.players[impSocketId].name });

    io.to(code).emit('room-state', sanitizeRoomForClients(code));
    cb && cb({ ok:true });
    console.log(`Word set in ${code} (category: ${category})`);
  });

  // Player sends a hint
  socket.on('send-hint', ({ code, hint }, cb) => {
    const room = rooms[code];
    if (!room) return cb && cb({ ok:false, err:'Raum fehlt' });
    if (!room.players[socket.id]) return cb && cb({ ok:false, err:'Nicht im Raum' });

    // add hint only if not exceeded
    const p = room.players[socket.id];
    if (p.hints.length >= room.config.numHints) {
      return cb && cb({ ok:false, err:'Maximale Hinweise erreicht' });
    }
    p.hints.push(String(hint || '').trim());
    io.to(code).emit('room-state', sanitizeRoomForClients(code));
    cb && cb({ ok:true });
  });

  // Host starts voting phase
  socket.on('start-voting', ({ code }, cb) => {
    const room = rooms[code];
    if (!room) return cb && cb({ ok:false, err:'Raum fehlt' });
    if (socket.id !== room.hostId) return cb && cb({ ok:false, err:'Nur Host' });

    room.phase = 'voting';
    room.votes = {}; // reset
    room.guesses = {};
    io.to(code).emit('voting-started', { numHints: room.config.numHints });
    io.to(code).emit('room-state', sanitizeRoomForClients(code));
    cb && cb({ ok:true });
    console.log('Voting started in', code);
  });

  // Player submits vote (targets a player name)
  socket.on('submit-vote', ({ code, voteFor }, cb) => {
    const room = rooms[code];
    if (!room) return cb && cb({ ok:false, err:'Raum fehlt' });
    if (!room.players[socket.id]) return cb && cb({ ok:false, err:'Nicht im Raum' });

    room.votes[socket.id] = String(voteFor || '').trim();
    io.to(code).emit('room-state', sanitizeRoomForClients(code));
    cb && cb({ ok:true });
  });

  // Imposter submits guess for the word
  socket.on('submit-guess', ({ code, guess }, cb) => {
    const room = rooms[code];
    if (!room) return cb && cb({ ok:false, err:'Raum fehlt' });
    if (!room.players[socket.id]) return cb && cb({ ok:false, err:'Nicht im Raum' });

    if (room.players[socket.id].role !== 'imposter') {
      return cb && cb({ ok:false, err:'Nur Imposter darf raten' });
    }
    room.guesses[socket.id] = String(guess || '').trim();
    io.to(code).emit('room-state', sanitizeRoomForClients(code));
    cb && cb({ ok:true });
  });

  // Host reveal
socket.on('reveal', (data) => {
  // Raum aus den Daten ziehen
  console.log('Reveal event received:', data);
  const roomId = data.code;
  
  if (!roomId) {
    console.error('Reveal: Kein Raum angegeben');
    return;
  }

  const room = rooms[roomId];
  if (!room) {
    console.error('Reveal: Raum existiert nicht', roomId);
    return;
  }

  // Daten vorbereiten
  const revealData = {
    players: {},   // Name, Hinweise etc.
    votes: room.votes || {},
    guesses: room.guesses || {},
    imposter: room.imposter || null,
    hostView: true
  };

  // Spieler-Daten strukturieren
  for (const playerId in room.players) {
    const player = room.players[playerId];
    revealData.players[playerId] = {
      name: player.name,
      hints: player.hints || []
    };
  }

  // Emit an alle im Raum
  io.to(roomId).emit('reveal', revealData);
});

  // disconnect handling
  socket.on('disconnect', () => {
    // remove from rooms
    for (const code of Object.keys(rooms)) {
      const room = rooms[code];
      if (room.hostId === socket.id) {
        // if host leaves, destroy room
        io.to(code).emit('room-closed');
        delete rooms[code];
        console.log('Host left, room closed', code);
      } else if (room.players && room.players[socket.id]) {
        delete room.players[socket.id];
        io.to(code).emit('room-state', sanitizeRoomForClients(code));
        console.log('Player left', socket.id, 'from', code);
      }
    }
  });

});

// helpers
function sanitizeRoomForClients(code) {
  const room = rooms[code];
  if (!room) return null;
  return {
    code,
    category: room.category,
    phase: room.phase,
    players: Object.values(room.players).map(p => ({ name: p.name, hints: p.hints })),
    numPlayers: Object.keys(room.players).length,
    config: room.config
  };
}
function simplifyPlayers(players) {
  const o = {};
  Object.keys(players).forEach(k => {
    o[k] = { name: players[k].name, role: players[k].role, hints: players[k].hints };
  });
  return o;
}
function findImposter(room) {
  for (const k of Object.keys(room.players)) {
    if (room.players[k].role === 'imposter') return { id: k, name: room.players[k].name };
  }
  return null;
}

server.listen(PORT, () => console.log('Server running on', PORT));
