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

function shuffle(arr) {
  const a = [...arr];
  // Double-pass Fisher-Yates to avoid same-sequence repeats
  for (let pass = 0; pass < 2; pass++) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
  }
  return a;
}

io.on('connection', (socket) => {
  console.log('connected', socket.id);

  // ── Create Room ──────────────────────────────────────────────
  socket.on('create-room', (data, cb) => {
    // Allow custom code or generate one
    let code = (data.customCode || '').toUpperCase().trim().replace(/[^A-Z0-9]/g, '').substring(0, 8);
    if (!code) {
      do { code = makeCode(4); } while (rooms[code]);
    } else if (rooms[code]) {
      return cb && cb({ ok: false, err: `Code "${code}" ist bereits vergeben` });
    }

    const hostPlays = !!data.hostPlays;
    const hostName  = hostPlays ? (data.hostName || 'Host').trim().substring(0, 20) : null;

    rooms[code] = {
      hostId: socket.id,
      hostPlays,
      hostName,
      config: { numHints: data.numHints || 2, maxPlayers: data.maxPlayers || 12 },
      category: null, word: null,
      players: {},       // socketId → { name, hints[], role, hasVoted, hasGuessed, order }
      turnOrder: [],     // array of socketIds in randomised hint order
      currentTurnIdx: 0, // which index in turnOrder is currently active
      hintRound: 0,      // which hint round we're in (0-indexed, max config.numHints-1)
      phase: 'lobby',
      votes: {}, guesses: {}
    };

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

  // ── Join Room ─────────────────────────────────────────────────
  socket.on('join-room', ({ code, name }, cb) => {
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, err: 'Raum existiert nicht' });
    if (room.phase !== 'lobby') return cb && cb({ ok: false, err: 'Spiel läuft bereits' });
    if (Object.keys(room.players).length >= room.config.maxPlayers) {
      return cb && cb({ ok: false, err: 'Raum ist voll' });
    }

    const trimmedName = (name || 'Spieler').trim().substring(0, 20);
    // Check duplicate names
    const namesTaken = Object.values(room.players).map(p => p.name.toLowerCase());
    if (namesTaken.includes(trimmedName.toLowerCase())) {
      return cb && cb({ ok: false, err: `Name "${trimmedName}" ist bereits vergeben` });
    }

    room.players[socket.id] = {
      name: trimmedName, hints: [], role: 'player', hasVoted: false, hasGuessed: false
    };
    socket.join(code);
    cb && cb({ ok: true, code });
    io.to(code).emit('room-state', sanitizeRoom(code));
    console.log(`${trimmedName} joined ${code}`);
  });

  // ── Set Word (host provides word — works for moderator manual, moderator random, AND host-plays mode) ──
  socket.on('set-word', ({ code, category, word, numHints }, cb) => {
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, err: 'Raum nicht gefunden' });
    if (socket.id !== room.hostId) return cb && cb({ ok: false, err: 'Nur der Host' });
    if (!word || !word.trim()) return cb && cb({ ok: false, err: 'Bitte einen Begriff eingeben' });
    if (Object.keys(room.players).length < 2) return cb && cb({ ok: false, err: 'Mindestens 2 Spieler benoetigt' });

    room.category = (category || '').trim();
    room.word = word.trim();
    room.config.numHints = parseInt(numHints) || room.config.numHints;
    startGame(code, cb);
  });

  // ── Core: start game, assign roles, set turn order ───────────
  function startGame(code, cb) {
    const room = rooms[code];
    room.phase = 'hinting';
    room.votes = {};
    room.guesses = {};

    const playerIds = Object.keys(room.players);

    // Random imposter
    const impIdx = Math.floor(Math.random() * playerIds.length);
    const impSocketId = playerIds[impIdx];

    // Random turn order for hints
    room.turnOrder = shuffle(playerIds);
    room.currentTurnIdx = 0;
    room.hintRound = 0;

    playerIds.forEach(pid => {
      room.players[pid].hints = [];
      room.players[pid].role = pid === impSocketId ? 'imposter' : 'player';
      room.players[pid].hasVoted = false;
      room.players[pid].hasGuessed = false;
    });

    // Tell each player their role
    playerIds.forEach(pid => {
      io.to(pid).emit('role-assigned', {
        role: room.players[pid].role,
        category: room.category,
        word: room.players[pid].role === 'imposter' ? null : room.word,
        numHints: room.config.numHints,
        isHostPlayer: pid === room.hostId && room.hostPlays
      });
    });

    // Moderator gets secret info
    if (!room.hostPlays) {
      io.to(room.hostId).emit('host-info', {
        imposterId: impSocketId,
        imposterName: room.players[impSocketId].name,
        word: room.word,
        category: room.category
      });
    }

    // Broadcast the full turn order and first active player
    broadcastTurnState(code);
    io.to(code).emit('room-state', sanitizeRoom(code));
    cb && cb({ ok: true });
    console.log(`Game started in ${code}: "${room.word}" imposter=${room.players[impSocketId].name}`);
    console.log(`Turn order: ${room.turnOrder.map(id => room.players[id].name).join(' → ')}`);
  }

  // ── Send Hint (only active player can do this) ───────────────
  socket.on('send-hint', ({ code, hint }, cb) => {
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, err: 'Raum nicht gefunden' });
    if (!room.players[socket.id]) return cb && cb({ ok: false, err: 'Nicht im Raum' });
    if (room.phase !== 'hinting') return cb && cb({ ok: false, err: 'Falsche Phase' });

    // Check it's this player's turn
    const activeId = room.turnOrder[room.currentTurnIdx];
    if (socket.id !== activeId) {
      return cb && cb({ ok: false, err: 'Du bist noch nicht dran' });
    }

    const trimmed = String(hint || '').trim();
    if (!trimmed) return cb && cb({ ok: false, err: 'Leerer Hinweis' });

    room.players[socket.id].hints.push(trimmed);
    cb && cb({ ok: true });

    // Advance turn
    advanceTurn(code);
  });

  function advanceTurn(code) {
    const room = rooms[code];
    room.currentTurnIdx++;

    // End of one pass through all players
    if (room.currentTurnIdx >= room.turnOrder.length) {
      room.hintRound++;
      room.currentTurnIdx = 0;

      // All hint rounds done → auto-start voting
      if (room.hintRound >= room.config.numHints) {
        startVoting(code);
        return;
      }
    }

    broadcastTurnState(code);
    io.to(code).emit('room-state', sanitizeRoom(code));
  }

  function startVoting(code) {
    const room = rooms[code];
    room.phase = 'voting';
    room.votes = {};
    room.guesses = {};

    const playerNames = room.turnOrder.map(id => room.players[id].name);
    const imposter = findImposter(room);

    // Each player gets voting-started OR imposter-vote-phase — never both
    room.turnOrder.forEach(pid => {
      if (room.players[pid].role === 'imposter') {
        io.to(pid).emit('imposter-vote-phase', {});
      } else {
        io.to(pid).emit('voting-started', { players: playerNames });
      }
    });

    // Moderator host (not a player) gets the player list too for vote-progress display
    if (!room.hostPlays) {
      io.to(room.hostId).emit('voting-started', { players: playerNames });
    }

    io.to(code).emit('room-state', sanitizeRoom(code));
    console.log(`Voting auto-started in ${code}`);
  }

  // Host can also manually start voting early (moderator mode)
  socket.on('start-voting', ({ code }, cb) => {
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, err: 'Raum nicht gefunden' });
    if (socket.id !== room.hostId) return cb && cb({ ok: false, err: 'Nur der Host' });
    startVoting(code);
    cb && cb({ ok: true });
  });

  function broadcastTurnState(code) {
    const room = rooms[code];
    const activeId = room.turnOrder[room.currentTurnIdx];
    if (!activeId || !room.players[activeId]) return; // safety: player may have just disconnected
    const activeName = room.players[activeId].name;

    // Send personalised 'your-turn' to active player
    io.to(activeId).emit('your-turn', {
      hintRound: room.hintRound + 1,
      totalRounds: room.config.numHints
    });

    // Send turn state to everyone — omit socket IDs for cleanliness
    io.to(code).emit('turn-state', {
      activeName,
      hintRound: room.hintRound + 1,
      totalRounds: room.config.numHints,
      turnOrder: room.turnOrder
        .filter(id => room.players[id]) // skip any stale IDs
        .map(id => ({
          name: room.players[id].name,
          hints: room.players[id].hints,
          isMe: false // client will match by name
        }))
    });
  }

  // ── Submit Vote ───────────────────────────────────────────────
  socket.on('submit-vote', ({ code, voteFor }, cb) => {
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, err: 'Raum nicht gefunden' });
    if (!room.players[socket.id]) return cb && cb({ ok: false, err: 'Nicht im Raum' });
    if (room.phase !== 'voting') return cb && cb({ ok: false, err: 'Voting nicht aktiv' });
    if (room.votes[socket.id]) return cb && cb({ ok: false, err: 'Du hast bereits gevotet' });

    room.votes[socket.id] = String(voteFor || '').trim();
    room.players[socket.id].hasVoted = true;

    const allPlayerIds = Object.keys(room.players);
    const imposterIds = allPlayerIds.filter(pid => room.players[pid].role === 'imposter');
    const nonImposterIds = allPlayerIds.filter(pid => room.players[pid].role !== 'imposter');
    const votedCount = nonImposterIds.filter(pid => room.votes[pid]).length
                     + imposterIds.filter(pid => room.guesses[pid]).length;
    const totalVoters = allPlayerIds.length;
    const allVoted = nonImposterIds.every(pid => room.votes[pid])
                  && imposterIds.every(pid => room.guesses[pid]);
    const tally = {};
    Object.values(room.votes).forEach(n => { tally[n] = (tally[n] || 0) + 1; });

    io.to(code).emit('room-state', sanitizeRoom(code));
    io.to(room.hostId).emit('vote-update', {
      votes: room.votes, totalVoters, votedCount, allVoted, tally
    });
    cb && cb({ ok: true });
  });

  // ── Submit Guess (imposter) ───────────────────────────────────
  socket.on('submit-guess', ({ code, guess }, cb) => {
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, err: 'Raum nicht gefunden' });
    if (!room.players[socket.id]) return cb && cb({ ok: false, err: 'Nicht im Raum' });
    if (room.phase !== 'voting') return cb && cb({ ok: false, err: 'Nur während des Votings möglich' });
    if (room.players[socket.id].role !== 'imposter') return cb && cb({ ok: false, err: 'Nur der Imposter' });
    if (room.guesses[socket.id]) return cb && cb({ ok: false, err: 'Du hast bereits geraten' });

    const trimmed = String(guess || '').trim();
    if (!trimmed) return cb && cb({ ok: false, err: 'Leerer Tipp' });
    room.guesses[socket.id] = trimmed;
    room.players[socket.id].hasGuessed = true;

    // Count progress: non-imposters vote, imposter guesses — both count toward allDone
    const allPlayerIds = Object.keys(room.players);
    const imposterIds = allPlayerIds.filter(pid => room.players[pid].role === 'imposter');
    const nonImposterIds = allPlayerIds.filter(pid => room.players[pid].role !== 'imposter');
    const votedCount = nonImposterIds.filter(pid => room.votes[pid]).length
                     + imposterIds.filter(pid => room.guesses[pid]).length;
    const totalVoters = allPlayerIds.length;
    const allDone = nonImposterIds.every(pid => room.votes[pid])
                 && imposterIds.every(pid => room.guesses[pid]);

    const tally = {};
    Object.values(room.votes).forEach(n => { tally[n] = (tally[n] || 0) + 1; });

    io.to(code).emit('room-state', sanitizeRoom(code));
    // Notify host of updated progress
    io.to(room.hostId).emit('vote-update', {
      votes: room.votes, totalVoters, votedCount, allVoted: allDone, tally,
      imposterGuessed: true, imposterGuess: trimmed
    });
    cb && cb({ ok: true });
  });

  // ── Reveal ────────────────────────────────────────────────────
  // Host calls this with imposterGuessCorrect = true/false (manual approval)
  socket.on('reveal', ({ code, imposterGuessCorrect }, cb) => {
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
      // Host decided manually — fall back to auto if no guess
      imposterGuessCorrect: imposterGuess ? !!imposterGuessCorrect : false,
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

  // ── New Round ─────────────────────────────────────────────────
  socket.on('new-round', ({ code }, cb) => {
    const room = rooms[code];
    if (!room || socket.id !== room.hostId) return cb && cb({ ok: false });

    room.phase = 'lobby';
    room.votes = {};
    room.guesses = {};
    room.word = null;
    room.category = null;
    room.turnOrder = [];
    room.currentTurnIdx = 0;
    room.hintRound = 0;

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

  // ── Disconnect ────────────────────────────────────────────────
  socket.on('disconnect', () => {
    for (const code of Object.keys(rooms)) {
      const room = rooms[code];
      if (room.hostId === socket.id) {
        io.to(code).emit('room-closed', { reason: 'Host hat den Raum verlassen' });
        delete rooms[code];
      } else if (room.players && room.players[socket.id]) {
        const name = room.players[socket.id].name;
        // Remove from turn order too
        room.turnOrder = room.turnOrder.filter(id => id !== socket.id);
        if (room.currentTurnIdx >= room.turnOrder.length) room.currentTurnIdx = 0;
        delete room.players[socket.id];
        io.to(code).emit('player-left', { name });
        io.to(code).emit('room-state', sanitizeRoom(code));
        // If mid-game and still hinting, re-broadcast turn state
        if (room.phase === 'hinting' && room.turnOrder.length > 0) {
          broadcastTurnState(code);
        }
      }
    }
  });
});

// ── Helpers ───────────────────────────────────────────────────
function sanitizeRoom(code) {
  const room = rooms[code];
  if (!room) return null;
  const activeId = room.turnOrder[room.currentTurnIdx] || null;
  return {
    code, category: room.category, phase: room.phase,
    config: room.config, hostPlays: room.hostPlays,
    activeName: activeId ? room.players[activeId]?.name : null,
    hintRound: room.hintRound + 1,
    players: room.turnOrder.length > 0
      // During game: use turn order
      ? room.turnOrder.map(id => ({
          name: room.players[id]?.name,
          hints: room.players[id]?.hints || [],
          hasVoted: room.players[id]?.hasVoted || false,
          isActive: id === activeId && room.phase === 'hinting'
        }))
      // Lobby: unordered
      : Object.values(room.players).map(p => ({
          name: p.name, hints: p.hints,
          hasVoted: p.hasVoted, isActive: false
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
