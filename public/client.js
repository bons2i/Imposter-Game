// client.js - simple orchestrator for both host and player pages
const socket = io();

const ClientApp = (function(){
  let role = null; // 'host' or 'player'
  let currentRoom = null;
  let myName = null;

  // helper to update players list UI (both pages)
  function renderPlayers(playersArr, containerId) {
    const c = document.getElementById(containerId);
    if (!c) return;
    c.innerHTML = '';
    playersArr.forEach(p => {
      const div = document.createElement('div');
      div.className = 'playerRow';
      div.innerHTML = `<div>${p.name}</div><div class="small">${(p.hints||[]).join(' • ')}</div>`;
      c.appendChild(div);
    });
  }

  // -------- PLAYER ----------
function initPlayer() {
    role = 'player';

    // Elemente
    const joinBtn = document.getElementById('joinBtn');
    const nameInp = document.getElementById('name');
    const codeInp = document.getElementById('code');
    const lobbyArea = document.getElementById('lobbyArea');
    const roomCodeEl = document.getElementById('roomCode');
    const playersList = document.getElementById('playersList');
    const categoryEl = document.getElementById('category');
    const roleTop = document.getElementById('roleTop');
    const mainWord = document.getElementById('mainWord');
    const numHintsEl = document.getElementById('numHints');
    const hintInput = document.getElementById('hintInput');
    const sendHint = document.getElementById('sendHint');
    const hintMsg = document.getElementById('hintMsg');
    const phaseEl = document.getElementById('phase');

    const votingCard = document.getElementById('votingCard');
    const voteInput = document.getElementById('voteInput');
    const voteBtn = document.getElementById('voteBtn');
    const guessBox = document.getElementById('guessBox');
    const guessInput = document.getElementById('guessInput');
    const guessBtn = document.getElementById('guessBtn');

    const revealArea = document.getElementById('revealArea');
    const playersReveal = document.getElementById('players');
    const hostInfo = document.getElementById('hostInfo');

    // Spieler beitreten
    joinBtn.addEventListener('click', () => {
        const name = nameInp.value || 'Spieler';
        const code = (codeInp.value || '').toUpperCase().trim();
        if (!code) { showJoinErr('Gib einen Raumcode ein'); return; }
        socket.emit('join-room', { code, name }, (res) => {
            if (!res || !res.ok) { showJoinErr(res && res.err ? res.err : 'Fehler'); return; }
            currentRoom = code;
            myName = name;
            document.getElementById('joinError').style.display = 'none';
            lobbyArea.style.display = 'block';
            roomCodeEl.textContent = code;
        });
    });

    function showJoinErr(msg) {
        const e = document.getElementById('joinError');
        e.textContent = msg;
        e.style.display = 'block';
    }

    // Hilfsfunktion: Spielerliste rendern
    function renderPlayers(playersArr, containerId) {
        const c = document.getElementById(containerId);
        if (!c) return;
        c.innerHTML = '';
        playersArr.forEach(p => {
            const div = document.createElement('div');
            div.className = 'playerRow';
            div.innerHTML = `<div>${p.name}</div><div class="small">${(p.hints || []).join(' • ')}</div>`;
            c.appendChild(div);
        });
    }

    // ----------------- Socket Events -----------------

    // Raumstatus aktualisieren
    socket.on('room-state', (state) => {
        if (!state) return;
        if (state.code && state.code !== currentRoom && currentRoom) return; // andere Räume ignorieren
        if (state.code) currentRoom = state.code;
        phaseEl.textContent = state.phase || '—';
        renderPlayers(state.players || [], 'playersList');
        categoryEl.textContent = state.category || '—';
    });

    // Rollen & Wort zugewiesen
    socket.on('role-assigned', (payload) => {
        roleTop.textContent = payload.category || '';

        role = payload.role;

        if (payload.role === 'imposter') {
            mainWord.textContent = 'Du bist der Imposter!';
            document.querySelector('.bigCard').classList.add('imposter');
            guessBox.style.display = 'block';
        } else {
            mainWord.textContent = payload.word || '—';
            document.querySelector('.bigCard').classList.remove('imposter');
            guessBox.style.display = 'none';
        }

        numHintsEl.textContent = payload.numHints || 2;

        // --- Eingabefelder zurücksetzen ---
        // Hinweisfelder einblenden
        hintInput.style.display = 'block';
         hintInput.value = '';  
        sendHint.style.display = 'block';
        voteInput.value = '';            // alte Votes löschen
        guessInput.value = '';  
        hintInput.value = '';
        hintMsg.style.display = 'none';

        // Voting-Felder ausblenden
        votingCard.style.display = 'none';
        voteInput.style.display = 'none';
        voteBtn.style.display = 'none';

        // Reveal-Bereich zurücksetzen
        revealArea.style.display = 'none';
        playersReveal.innerHTML = '';
        hostInfo.textContent = '';

        // Tipp-Feld nur für Impostor zurücksetzen
        if (role === 'imposter') {
            guessInput.value = '';
        }
        
    });

    // Voting starten
    socket.on('voting-started', (data) => {
        // Hinweisfelder ausblenden
        hintInput.style.display = 'none';
        sendHint.style.display = 'none';

         if (role === 'imposter') {
          // Impostor sieht nur sein Tipp-Feld
          votingCard.style.display = 'block';
          guessBox.style.display = 'block';
          //votingCard.style.display = 'none'; // kein Spieler-Votingfeld
        } else {
        // Normale Spieler sehen Voting-Feld
          votingCard.style.display = 'block';
          voteInput.style.display = 'block';
          voteBtn.style.display = 'block';
          guessBox.style.display = 'none'; // Impostor-Feld ausblenden
    }

        /* Voting-Felder einblenden
        votingCard.style.display = 'block';
        voteInput.style.display = 'block';
        voteBtn.style.display = 'block';*/
    });

    // Reveal anzeigen
// Reveal-Ergebnis anzeigen (PLAYER)
socket.on('reveal', (data) => {
  console.log('Reveal event received:', data);

  const roomId = data.code;
  if (!roomId) {
    console.error('Reveal: Kein Raum angegeben');
    return;
  }

  // Reveal-Bereich vorbereiten
  revealArea.style.display = 'block';
  revealArea.scrollIntoView({ behavior: 'smooth' });
  playersReveal.innerHTML = '';
  hostInfo.textContent = '';

  // Eingaben/Controls ausblenden & resetten
  hintInput.style.display = 'none';
  sendHint.style.display = 'none';
  votingCard.style.display = 'none';
  voteInput.value = '';
  guessInput.value = '';

  // sichere defaults
  const players = data.players || {};     // keyed by socketId -> { name, hints, role? }
  const votes = data.votes || {};         // keyed by voterSocketId -> votedForName
  const guesses = data.guesses || {};     // keyed by playerSocketId -> guessString
  const word = data.word || data.roomWord || '—';
  const imposter = data.imposter || null; // maybe { id, name }

  // Anzeige: gesuchtes Wort + Imposter (falls bekannt)
  const header = document.createElement('div');
  header.innerHTML = `<strong>Gesuchtes Wort:</strong> ${word}`;
  playersReveal.appendChild(header);

  const impDiv = document.createElement('div');
  const impName = imposter && (imposter.name || imposter) ? (imposter.name || imposter) : 'Unbekannt';
  impDiv.innerHTML = `<strong>Impostor:</strong> ${impName}`;
  playersReveal.appendChild(impDiv);

  // Spieler + ihre Hinweise
  const playersHeader = document.createElement('h4');
  playersHeader.textContent = 'Spieler & Hinweise:';
  playersReveal.appendChild(playersHeader);

  Object.entries(players).forEach(([pid, p]) => {
    const pDiv = document.createElement('div');
    const hintText = (p.hints && p.hints.length > 0) ? p.hints.join(' • ') : '(keine Hinweise)';
    pDiv.textContent = `${p.name}: ${hintText}`;
    playersReveal.appendChild(pDiv);
  });

  // Votes: voterName -> votedFor
  if (Object.keys(votes).length > 0) {
    const vH = document.createElement('h4');
    vH.textContent = 'Votes:';
    playersReveal.appendChild(vH);

    Object.entries(votes).forEach(([voterPid, votedForName]) => {
      const voterName = (players[voterPid] && players[voterPid].name) ? players[voterPid].name : voterPid;
      const line = document.createElement('div');
      line.textContent = `${voterName} → ${votedForName || '(leer)'}`;
      playersReveal.appendChild(line);
    });
  }

  // Guesses: playerName -> guess
  if (Object.keys(guesses).length > 0) {
    const gH = document.createElement('h4');
    gH.textContent = 'Impostor-Tipps:';
    playersReveal.appendChild(gH);

    Object.entries(guesses).forEach(([playerPid, guessStr]) => {
      const playerName = (players[playerPid] && players[playerPid].name) ? players[playerPid].name : playerPid;
      const line = document.createElement('div');
      line.textContent = `${playerName}: ${guessStr || '(leer)'}`;
      playersReveal.appendChild(line);
    });
  }

  // opt. visuelle Rücksetzung von Buttons
  document.querySelectorAll('button').forEach(btn => btn.style.backgroundColor = '');
});



    // ----------------- Aktionen -----------------

    sendHint.addEventListener('click', () => {
    const h = hintInput.value.trim();
    if (!h) return;
    socket.emit('send-hint', { code: currentRoom, hint: h }, (res) => {
        if (res && res.ok) {
            // Button kurz grün aufleuchten lassen
            sendHint.style.backgroundColor = '#4CAF50'; // Grün
            sendHint.textContent = 'Gesendet!';
            hintInput.value = '';

            setTimeout(() => {
                sendHint.style.backgroundColor = ''; // ursprüngliche Farbe
                sendHint.textContent = 'Senden';
            }, 1200);
        } else {
            alert(res && res.err ? res.err : 'Fehler');
        }
    });
});


    voteBtn.addEventListener('click', () => {
    const v = voteInput.value.trim();
    if (!v) return alert('Gib einen Namen ein');
    socket.emit('submit-vote', { code: currentRoom, voteFor: v }, (res) => {
        if (res && res.ok) {
            voteBtn.style.backgroundColor = '#4CAF50';
            voteBtn.textContent = 'Vote gesendet!';
            setTimeout(() => {
                voteBtn.style.backgroundColor = '';
                voteBtn.textContent = 'Vote';
            }, 1200);
        } else {
            alert(res && res.err ? res.err : 'Fehler');
        }
    });
});

guessBtn.addEventListener('click', () => {
    const g = guessInput.value.trim();
    if (!g) return alert('Gib einen Tipp ein');
    socket.emit('submit-guess', { code: currentRoom, guess: g }, (res) => {
        if (res && res.ok) {
            guessBtn.style.backgroundColor = '#4CAF50';
            guessBtn.textContent = 'Tipp gesendet!';
            setTimeout(() => {
                guessBtn.style.backgroundColor = '';
                guessBtn.textContent = 'Absenden';
            }, 1200);
        } else {
            alert(res && res.err ? res.err : 'Fehler');
        }
    });
});


    socket.on('room-closed', () => {
        alert('Host hat den Raum geschlossen');
        location.reload();
    });
}


  // -------- HOST ----------
  function initHost(){
    role = 'host';
    // elements
    const createBtn = document.getElementById('createBtn');
    const createdCode = document.getElementById('createdCode');
    const maxPlayers = document.getElementById('maxPlayers');
    const numHints = document.getElementById('numHints');
    const hostLobby = document.getElementById('hostLobby');
    const hostRoomCode = document.getElementById('hostRoomCode');
    const hostPlayers = document.getElementById('hostPlayers');
    const setWordBtn = document.getElementById('setWordBtn');
    const hostCategory = document.getElementById('hostCategory');
    const hostWord = document.getElementById('hostWord');
    const startVote = document.getElementById('startVote');
    const revealBtn = document.getElementById('revealBtn');
    const hostInfo = document.getElementById('hostInfo');
    const hostPhase = document.getElementById('hostPhase');
    const hostReveal = document.getElementById('hostReveal');

    createBtn.addEventListener('click', () => {
      const np = parseInt(maxPlayers.value) || 12;
      const nh = parseInt(numHints.value) || 2;
      socket.emit('create-room', { maxPlayers: np, numHints: nh }, (res) => {
        if (res && res.ok) {
          createdCode.textContent = res.code;
          hostRoomCode.textContent = res.code;
          hostLobby.style.display = 'block';
        } else {
          alert('Fehler beim Erstellen');
        }
      });
    });

    socket.on('room-state', (state) => {
      if (!state) return;
      hostPhase.textContent = state.phase || '—';
      hostRoomCode.textContent = state.code || hostRoomCode.textContent;
      renderPlayers(state.players || [], 'hostPlayers');
    });

    setWordBtn.addEventListener('click', () => {
      const code = hostRoomCode.textContent;
      const category = hostCategory.value.trim();
      const word = hostWord.value.trim();
      const nh = parseInt(numHints.value) || 2;
      if (!code) return alert('Kein Raum');
      socket.emit('set-word', { code, category, word, numHints: nh }, (res) => {
        if (!(res && res.ok)) alert(res && res.err ? res.err : 'Fehler');
      });
    });

    socket.on('host-info', (info) => {
      hostInfo.textContent = `${info.imposterName} ist der Imposter (intern)`;
    });

    startVote.addEventListener('click', () => {
      const code = hostRoomCode.textContent;
      socket.emit('start-voting', { code }, (res) => {
        if (!(res && res.ok)) alert(res && res.err ? res.err : 'Fehler');
      });
    });

    revealBtn.addEventListener('click', () => {
      const code = hostRoomCode.textContent;
      socket.emit('reveal', { code }, (res) => {
        if (!(res && res.ok)) alert(res && res.err ? res.err : 'Fehler');
      });
    });

// Reveal für Host: sauber und übersichtlich
socket.on('reveal', (data) => {
  const hostReveal = document.getElementById('hostReveal');
  hostReveal.innerHTML = ''; // clear previous

  const players = data.players || {};
  const votes = data.votes || {};
  const guesses = data.guesses || {};
  const word = data.word || data.roomWord || '—';
  const imp = data.imposter || null;

  // Wort + Imposter
  const w = document.createElement('div');
  w.innerHTML = `<strong>Wort:</strong> ${word}`;
  hostReveal.appendChild(w);

  const impDiv = document.createElement('div');
  const impName = imp && (imp.name || imp) ? (imp.name || imp) : 'Unbekannt';
  impDiv.innerHTML = `<strong>Imposter:</strong> ${impName}`;
  hostReveal.appendChild(impDiv);

  // Votes
  const votesDiv = document.createElement('div');
  votesDiv.innerHTML = '<strong>Votes:</strong>';
  const votesList = document.createElement('ul');
  Object.entries(votes).forEach(([voterPid, votedFor]) => {
    const li = document.createElement('li');
    const voterName = (players[voterPid] && players[voterPid].name) ? players[voterPid].name : voterPid;
    li.textContent = `${voterName} -> ${votedFor || '(leer)'}`;
    votesList.appendChild(li);
  });
  votesDiv.appendChild(votesList);
  hostReveal.appendChild(votesDiv);

  // Guesses
  const guessesDiv = document.createElement('div');
  guessesDiv.innerHTML = '<strong>Imposter Guesses:</strong>';
  const guessesList = document.createElement('ul');
  Object.entries(guesses).forEach(([playerPid, guess]) => {
    const li = document.createElement('li');
    const playerName = (players[playerPid] && players[playerPid].name) ? players[playerPid].name : playerPid;
    li.textContent = `${playerName}: ${guess || '(leer)'}`;
    guessesList.appendChild(li);
  });
  guessesDiv.appendChild(guessesList);
  hostReveal.appendChild(guessesDiv);
});



    socket.on('room-closed', () => {
      alert('Ein Spieler hat verlassen - Raum geschlossen');
      location.reload();
    });
  }

  return {
    initPlayer,
    initHost
  };
})();
