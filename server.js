// server.js
const express = require('express');
const http = require('http');
const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server);

app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const rooms = {};

function makeCode(len = 4) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  // ── Create Room ──────────────────────────────────────────
  socket.on('create-room', (data, cb) => {
    let code;
    do { code = makeCode(4); } while (rooms[code]);

    const hostPlays = !!data.hostPlays;
    const hostName  = hostPlays ? (data.hostName || 'Host').trim().substring(0, 20) : null;

    rooms[code] = {
      hostId: socket.id,
      hostPlays,
      hostName,
      config: { numHints: data.numHints || 2, maxPlayers: data.maxPlayers || 12 },
      category: null, word: null,
      players: {}, phase: 'lobby', votes: {}, guesses: {}
    };

    // If host plays, register them as a player immediately
    if (hostPlays) {
      rooms[code].players[socket.id] = {
        name: hostName, hints: [], role: 'player', hasVoted: false, hasGuessed: false
      };
    }

    socket.join(code);
    cb && cb({ ok: true, code });
    io.to(code).emit('room-state', sanitizeRoom(code));
    console.log(`Room created: ${code} (hostPlays=${hostPlays})`);
  });

  // ── Join Room (regular players) ───────────────────────────
  socket.on('join-room', ({ code, name }, cb) => {
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, err: 'Raum existiert nicht' });
    if (room.phase !== 'lobby') return cb && cb({ ok: false, err: 'Spiel läuft bereits' });
    if (Object.keys(room.players).length >= room.config.maxPlayers) {
      return cb && cb({ ok: false, err: 'Raum ist voll' });
    }

    const trimmedName = (name || 'Spieler').trim().substring(0, 20);
    room.players[socket.id] = {
      name: trimmedName, hints: [], role: 'player', hasVoted: false, hasGuessed: false
    };
    socket.join(code);
    cb && cb({ ok: true, code });
    io.to(code).emit('room-state', sanitizeRoom(code));
    console.log(`${trimmedName} joined ${code}`);
  });

  // ── Set Word (host-only mode, host types the word) ────────
  socket.on('set-word', ({ code, category, word, numHints }, cb) => {
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, err: 'Raum nicht gefunden' });
    if (socket.id !== room.hostId) return cb && cb({ ok: false, err: 'Nur der Host' });
    if (!word || !word.trim()) return cb && cb({ ok: false, err: 'Bitte einen Begriff eingeben' });
    if (Object.keys(room.players).length < 2) return cb && cb({ ok: false, err: 'Mindestens 2 Spieler benötigt' });

    room.category = (category || '').trim();
    room.word = word.trim();
    room.config.numHints = parseInt(numHints) || room.config.numHints;
    startGame(code, cb);
  });

  // ── Set Word (random – client picked the word, host ALSO plays) ───
  socket.on('set-word-random', ({ code, category, word, numHints }, cb) => {
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, err: 'Raum nicht gefunden' });
    if (socket.id !== room.hostId) return cb && cb({ ok: false, err: 'Nur der Host' });
    if (!word || !word.trim()) return cb && cb({ ok: false, err: 'Kein Wort' });
    if (Object.keys(room.players).length < 2) return cb && cb({ ok: false, err: 'Mindestens 2 Spieler benötigt' });

    room.category = (category || '').trim();
    room.word = word.trim();
    room.config.numHints = parseInt(numHints) || room.config.numHints;
    startGame(code, cb);
  });

  // ── Core: assign roles and start hinting phase ────────────
  function startGame(code, cb) {
    const room = rooms[code];
    room.phase = 'hinting';
    room.votes = {};
    room.guesses = {};

    const playerIds = Object.keys(room.players);
    const impIdx = Math.floor(Math.random() * playerIds.length);
    const impSocketId = playerIds[impIdx];

    playerIds.forEach(pid => {
      room.players[pid].hints = [];
      room.players[pid].role = pid === impSocketId ? 'imposter' : 'player';
      room.players[pid].hasVoted = false;
      room.players[pid].hasGuessed = false;
    });

    // Tell every player their role
    playerIds.forEach(pid => {
      io.to(pid).emit('role-assigned', {
        role: room.players[pid].role,
        category: room.category,
        word: room.players[pid].role === 'imposter' ? null : room.word,
        numHints: room.config.numHints,
        isHostPlayer: pid === room.hostId && room.hostPlays
      });
    });

    // If host is a pure moderator, tell them who the imposter is
    if (!room.hostPlays) {
      io.to(room.hostId).emit('host-info', {
        imposterId: impSocketId,
        imposterName: room.players[impSocketId].name,
        word: room.word,
        category: room.category
      });
    }

    io.to(code).emit('room-state', sanitizeRoom(code));
    cb && cb({ ok: true });
    console.log(`Game started in ${code}: "${room.word}" imposter=${room.players[impSocketId].name}`);
  }

  // ── Hints ─────────────────────────────────────────────────
  socket.on('send-hint', ({ code, hint }, cb) => {
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, err: 'Raum nicht gefunden' });
    if (!room.players[socket.id]) return cb && cb({ ok: false, err: 'Nicht im Raum' });
    if (room.phase !== 'hinting') return cb && cb({ ok: false, err: 'Falsche Phase' });

    const p = room.players[socket.id];
    if (p.hints.length >= room.config.numHints) {
      return cb && cb({ ok: false, err: 'Maximale Hinweise erreicht' });
    }
    const trimmed = String(hint || '').trim();
    if (!trimmed) return cb && cb({ ok: false, err: 'Leerer Hinweis' });
    p.hints.push(trimmed);

    io.to(code).emit('room-state', sanitizeRoom(code));
    cb && cb({ ok: true, hintsLeft: room.config.numHints - p.hints.length });
  });

  // ── Start Voting ──────────────────────────────────────────
  socket.on('start-voting', ({ code }, cb) => {
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, err: 'Raum nicht gefunden' });
    if (socket.id !== room.hostId) return cb && cb({ ok: false, err: 'Nur der Host' });

    room.phase = 'voting';
    room.votes = {};
    room.guesses = {};

    const playerNames = Object.values(room.players).map(p => p.name);
    io.to(code).emit('voting-started', { players: playerNames });
    io.to(code).emit('room-state', sanitizeRoom(code));
    cb && cb({ ok: true });
  });

  // ── Submit Vote ───────────────────────────────────────────
  socket.on('submit-vote', ({ code, voteFor }, cb) => {
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, err: 'Raum nicht gefunden' });
    if (!room.players[socket.id]) return cb && cb({ ok: false, err: 'Nicht im Raum' });
    if (room.phase !== 'voting') return cb && cb({ ok: false, err: 'Voting nicht aktiv' });

    room.votes[socket.id] = String(voteFor || '').trim();
    room.players[socket.id].hasVoted = true;

    const playerIds = Object.keys(room.players);
    const votedCount = Object.keys(room.votes).length;
    const allVoted = playerIds.every(pid => room.votes[pid]);
    const tally = {};
    Object.values(room.votes).forEach(n => { tally[n] = (tally[n] || 0) + 1; });

    io.to(code).emit('room-state', sanitizeRoom(code));
    io.to(room.hostId).emit('vote-update', { votes: room.votes, totalVoters: playerIds.length, votedCount, allVoted, tally });
    cb && cb({ ok: true });
  });

  // ── Submit Guess (imposter) ───────────────────────────────
  socket.on('submit-guess', ({ code, guess }, cb) => {
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, err: 'Raum nicht gefunden' });
    if (!room.players[socket.id]) return cb && cb({ ok: false, err: 'Nicht im Raum' });
    if (room.players[socket.id].role !== 'imposter') return cb && cb({ ok: false, err: 'Nur der Imposter' });

    const trimmed = String(guess || '').trim();
    if (!trimmed) return cb && cb({ ok: false, err: 'Leerer Tipp' });
    room.guesses[socket.id] = trimmed;
    room.players[socket.id].hasGuessed = true;
    io.to(code).emit('room-state', sanitizeRoom(code));
    cb && cb({ ok: true });
  });

  // ── Reveal ────────────────────────────────────────────────
  socket.on('reveal', ({ code }, cb) => {
    const room = rooms[code];
    if (!room || socket.id !== room.hostId) return;

    room.phase = 'reveal';
    const imposter = findImposter(room);
    const imposterGuess = imposter ? room.guesses[imposter.id] : null;
    const tally = {};
    Object.values(room.votes).forEach(n => { tally[n] = (tally[n] || 0) + 1; });

    const revealData = {
      word: room.word, category: room.category, imposter,
      imposterGuess,
      imposterGuessCorrect: !!(imposterGuess && imposterGuess.toLowerCase() === room.word.toLowerCase()),
      players: Object.entries(room.players).map(([id, p]) => ({
        id, name: p.name, role: p.role, hints: p.hints,
        votedFor: room.votes[id] || null,
        votesReceived: tally[p.name] || 0
      })),
      voteTally: tally
    };

    io.to(code).emit('reveal', revealData);
    io.to(code).emit('room-state', sanitizeRoom(code));
    cb && cb({ ok: true });
  });

  // ── New Round ─────────────────────────────────────────────
  socket.on('new-round', ({ code }, cb) => {
    const room = rooms[code];
    if (!room || socket.id !== room.hostId) return cb && cb({ ok: false });

    room.phase = 'lobby';
    room.votes = {};
    room.guesses = {};
    room.word = null;
    room.category = null;

    Object.keys(room.players).forEach(pid => {
      room.players[pid].hints = [];
      room.players[pid].role = 'player';
      room.players[pid].hasVoted = false;
      room.players[pid].hasGuessed = false;
    });

    io.to(code).emit('new-round');
    io.to(code).emit('room-state', sanitizeRoom(code));
    cb && cb({ ok: true });
  });

  // ── Disconnect ────────────────────────────────────────────
  socket.on('disconnect', () => {
    for (const code of Object.keys(rooms)) {
      const room = rooms[code];
      if (room.hostId === socket.id) {
        io.to(code).emit('room-closed', { reason: 'Host hat den Raum verlassen' });
        delete rooms[code];
      } else if (room.players && room.players[socket.id]) {
        const name = room.players[socket.id].name;
        delete room.players[socket.id];
        io.to(code).emit('player-left', { name });
        io.to(code).emit('room-state', sanitizeRoom(code));
      }
    }
  });
});

// ── Helpers ───────────────────────────────────────────────────
function sanitizeRoom(code) {
  const room = rooms[code];
  if (!room) return null;
  return {
    code, category: room.category, phase: room.phase,
    config: room.config, hostPlays: room.hostPlays,
    players: Object.values(room.players).map(p => ({
      name: p.name, hints: p.hints, hasVoted: p.hasVoted, hasGuessed: p.hasGuessed
    })),
    numPlayers: Object.keys(room.players).length,
    votedCount: Object.keys(room.votes).length
  };
}

function findImposter(room) {
  for (const [id, p] of Object.entries(room.players)) {
    if (p.role === 'imposter') return { id, name: p.name };
  }
  return null;
}

server.listen(PORT, () => console.log('Server running on port', PORT));
