// client.js — Imposter Game
const socket = io();

// ─────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────
function showToast(msg, duration = 2500) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), duration);
}

function updatePhaseBadge(phase) {
  const b = document.getElementById('phaseBadge');
  if (!b) return;
  const labels = { lobby: 'Lobby', hinting: 'Hinweise', voting: 'Voting', reveal: 'Reveal' };
  b.textContent = labels[phase] || phase;
  b.className = 'phase-badge ' + (phase || '');
}

function renderRevealVotes(data, container) {
  const tally = {};
  (data.players || []).forEach(p => { tally[p.name] = p.votesReceived || 0; });
  container.innerHTML = '';
  Object.entries(tally).sort((a, b) => b[1] - a[1]).forEach(([name, count]) => {
    const isImp = data.imposter && name === data.imposter.name;
    const row = document.createElement('div');
    row.className = 'vote-bar';
    row.innerHTML = `
      <span class="vote-count" style="${isImp ? 'color:var(--accent2)' : ''}">${count}</span>
      <span style="font-size:14px;font-weight:600;${isImp ? 'color:var(--accent2)' : ''}">${isImp ? '🎭 ' : ''}${name}</span>
    `;
    container.appendChild(row);
  });
}

function renderRevealPlayers(data, container) {
  container.innerHTML = '';
  (data.players || []).forEach(p => {
    const isImp = data.imposter && p.name === data.imposter.name;
    const row = document.createElement('div');
    row.className = 'player-row';
    row.innerHTML = `
      <div>
        <div class="player-name" style="${isImp ? 'color:var(--accent2)' : ''}">${isImp ? '🎭 ' : ''}${p.name}</div>
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">
          ${(p.hints || []).map(h => `<span class="hint-tag">${h}</span>`).join('') || '<span style="color:var(--text-dim);font-size:12px">Keine Hinweise</span>'}
        </div>
      </div>
      <div style="text-align:right;font-size:13px">${p.votesReceived > 0 ? `<span style="color:var(--accent2);font-weight:700">${p.votesReceived}×</span>` : ''}</div>
    `;
    container.appendChild(row);
  });
}

// ─────────────────────────────────────────────
//  RANDOM WORD LOADER
// ─────────────────────────────────────────────
let _wordsData = null;

async function loadWords() {
  if (_wordsData) return _wordsData;
  const res = await fetch('/words.json');
  _wordsData = await res.json();
  return _wordsData;
}

async function pickRandomWord() {
  const data = await loadWords();
  const cats = data.categories;
  const cat = cats[Math.floor(Math.random() * cats.length)];
  const word = cat.words[Math.floor(Math.random() * cat.words.length)];
  return { category: cat.name, word };
}

// ═════════════════════════════════════════════════════════════
//  HOST
// ═════════════════════════════════════════════════════════════
async function initHost() {
  let currentRoom = null;
  let hostMode = 'moderator'; // 'moderator' | 'play'
  let wordSource = 'custom';   // 'custom' | 'random' (moderator only)
  let pickedWord = null;       // { category, word } — used in random / hostPlays modes
  let myRole = null;
  let myHintsCount = 0;
  let maxHints = 2;

  // ── Setup elements ──
  const setupSection     = document.getElementById('setupSection');
  const modeToggle       = document.getElementById('modeToggle');
  const hostNameRow      = document.getElementById('hostNameRow');
  const hostNameInput    = document.getElementById('hostNameInput');
  const maxPlayersInput  = document.getElementById('maxPlayers');
  const numHintsSelect   = document.getElementById('numHints');
  const createBtn        = document.getElementById('createBtn');
  const createError      = document.getElementById('createError');

  // ── Lobby elements ──
  const hostLobby        = document.getElementById('hostLobby');
  const hostRoomCode     = document.getElementById('hostRoomCode');
  const hostPlayerCount  = document.getElementById('hostPlayerCount');
  const hostPlayersList  = document.getElementById('hostPlayersList');

  // ── Moderator word setup ──
  const wordSetupSection   = document.getElementById('wordSetupSection');
  const wordSourceToggle   = document.getElementById('wordSourceToggle');
  const customWordSection  = document.getElementById('customWordSection');
  const randomWordSection  = document.getElementById('randomWordSection');
  const hostCategory       = document.getElementById('hostCategory');
  const hostWord           = document.getElementById('hostWord');
  const randomCategoryDisplay = document.getElementById('randomCategoryDisplay');
  const randomWordDisplay  = document.getElementById('randomWordDisplay');
  const rerollBtn          = document.getElementById('rerollBtn');
  const setWordBtn         = document.getElementById('setWordBtn');
  const setWordError       = document.getElementById('setWordError');

  // ── Host-plays word section ──
  const hostPlaysWordSection = document.getElementById('hostPlaysWordSection');
  const hostPlaysCategory    = document.getElementById('hostPlaysCategory');
  const hostPlaysWordHidden  = document.getElementById('hostPlaysWordHidden');
  const hostPlaysRerollBtn   = document.getElementById('hostPlaysRerollBtn');
  const hostPlaysStartBtn    = document.getElementById('hostPlaysStartBtn');
  const hostPlaysError       = document.getElementById('hostPlaysError');

  // ── Secret info (moderator) ──
  const hostInfoSection  = document.getElementById('hostInfoSection');
  const hostSecretInfo   = document.getElementById('hostSecretInfo');

  // ── Host role card + hints ──
  const hostRoleSection   = document.getElementById('hostRoleSection');
  const hostRoleCard      = document.getElementById('hostRoleCard');
  const hostCategoryLabel = document.getElementById('hostCategoryLabel');
  const hostWordDisplay   = document.getElementById('hostWordDisplay');
  const hostRoleLabel     = document.getElementById('hostRoleLabel');
  const hostHintsLeft     = document.getElementById('hostHintsLeft');
  const hostMyHints       = document.getElementById('hostMyHints');
  const hostHintInput     = document.getElementById('hostHintInput');
  const hostHintInputRow  = document.getElementById('hostHintInputRow');
  const hostSendHintBtn   = document.getElementById('hostSendHintBtn');
  const hostHintDoneMsg   = document.getElementById('hostHintDoneMsg');

  // ── Voting ──
  const voteProgressSection = document.getElementById('voteProgressSection');
  const voteProgressCount   = document.getElementById('voteProgressCount');
  const voteProgressTotal   = document.getElementById('voteProgressTotal');
  const voteProgressBar     = document.getElementById('voteProgressBar');
  const voteResultsPreview  = document.getElementById('voteResultsPreview');
  const hostVotingSection   = document.getElementById('hostVotingSection');
  const hostVoteOptions     = document.getElementById('hostVoteOptions');
  const hostVoteDoneMsg     = document.getElementById('hostVoteDoneMsg');

  // ── Guess (host as imposter) ──
  const hostGuessSection  = document.getElementById('hostGuessSection');
  const hostGuessInput    = document.getElementById('hostGuessInput');
  const hostGuessInputRow = document.getElementById('hostGuessInputRow');
  const hostGuessBtn      = document.getElementById('hostGuessBtn');
  const hostGuessDoneMsg  = document.getElementById('hostGuessDoneMsg');

  // ── Action buttons ──
  const startVoteBtn = document.getElementById('startVoteBtn');
  const revealBtn    = document.getElementById('revealBtn');
  const newRoundBtn  = document.getElementById('newRoundBtn');

  // ── Reveal ──
  const revealSection      = document.getElementById('revealSection');
  const revealWord         = document.getElementById('revealWord');
  const revealImposterName = document.getElementById('revealImposterName');
  const revealGuessResult  = document.getElementById('revealGuessResult');
  const revealVotes        = document.getElementById('revealVotes');
  const revealPlayers      = document.getElementById('revealPlayers');

  // ══════════════════════════════════════
  //  MODE TOGGLE (Setup Screen)
  // ══════════════════════════════════════
  modeToggle.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      modeToggle.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      hostMode = btn.dataset.mode;
      hostNameRow.style.display = hostMode === 'play' ? 'block' : 'none';
    });
  });

  // ══════════════════════════════════════
  //  WORD SOURCE TOGGLE (Moderator)
  // ══════════════════════════════════════
  wordSourceToggle.querySelectorAll('.source-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      wordSourceToggle.querySelectorAll('.source-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      wordSource = btn.dataset.source;
      if (wordSource === 'random') {
        customWordSection.style.display = 'none';
        randomWordSection.style.display = 'block';
        await refreshRandomWord();
      } else {
        customWordSection.style.display = 'block';
        randomWordSection.style.display = 'none';
        pickedWord = null;
      }
    });
  });

  rerollBtn.addEventListener('click', refreshRandomWord);

  async function refreshRandomWord() {
    rerollBtn.disabled = true;
    pickedWord = await pickRandomWord();
    randomCategoryDisplay.textContent = '📂 ' + pickedWord.category;
    randomWordDisplay.textContent = pickedWord.word;
    rerollBtn.disabled = false;
  }

  // ══════════════════════════════════════
  //  HOST-PLAYS: pre-load random word
  // ══════════════════════════════════════
  async function refreshHostPlaysWord() {
    hostPlaysRerollBtn.disabled = true;
    pickedWord = await pickRandomWord();
    hostPlaysCategory.textContent = '📂 ' + pickedWord.category;
    // Hide the actual word — host only sees category (to keep it fair)
    hostPlaysWordHidden.textContent = '••••••';
    hostPlaysRerollBtn.disabled = false;
  }

  hostPlaysRerollBtn.addEventListener('click', refreshHostPlaysWord);

  // ══════════════════════════════════════
  //  CREATE ROOM
  // ══════════════════════════════════════
  createBtn.addEventListener('click', async () => {
    const mp = parseInt(maxPlayersInput.value) || 12;
    const nh = parseInt(numHintsSelect.value) || 2;
    const hName = hostNameInput.value.trim();

    if (hostMode === 'play' && !hName) {
      createError.textContent = 'Bitte deinen Namen eingeben';
      createError.style.display = 'block';
      return;
    }
    createError.style.display = 'none';
    createBtn.disabled = true;
    createBtn.textContent = '…';

    socket.emit('create-room', {
      maxPlayers: mp, numHints: nh,
      hostPlays: hostMode === 'play',
      hostName: hName
    }, async (res) => {
      createBtn.disabled = false;
      createBtn.textContent = '🎮 Raum erstellen';
      if (!res || !res.ok) { createError.textContent = 'Fehler'; createError.style.display = 'block'; return; }

      currentRoom = res.code;
      maxHints = nh;
      setupSection.style.display = 'none';
      hostLobby.style.display = 'block';
      hostRoomCode.textContent = res.code;

      // Show the right word-entry section
      if (hostMode === 'play') {
        wordSetupSection.style.display = 'none';
        hostPlaysWordSection.style.display = 'block';
        await refreshHostPlaysWord();
      } else {
        wordSetupSection.style.display = 'block';
        hostPlaysWordSection.style.display = 'none';
      }

      showToast('✅ Raum ' + res.code + ' erstellt');
    });
  });

  // ══════════════════════════════════════
  //  START GAME — Moderator mode
  // ══════════════════════════════════════
  setWordBtn.addEventListener('click', () => {
    let category, word;

    if (wordSource === 'random') {
      if (!pickedWord) { setWordError.textContent = 'Kein Wort geladen'; setWordError.style.display = 'block'; return; }
      category = pickedWord.category;
      word = pickedWord.word;
    } else {
      word = hostWord.value.trim();
      category = hostCategory.value.trim();
      if (!word) { setWordError.textContent = 'Bitte einen Begriff eingeben'; setWordError.style.display = 'block'; return; }
    }

    setWordError.style.display = 'none';
    setWordBtn.disabled = true;

    const event = wordSource === 'random' ? 'set-word-random' : 'set-word';
    socket.emit(event, {
      code: currentRoom,
      category, word,
      numHints: parseInt(numHintsSelect.value) || maxHints
    }, (res) => {
      setWordBtn.disabled = false;
      if (!res || !res.ok) {
        setWordError.textContent = res && res.err ? res.err : 'Fehler';
        setWordError.style.display = 'block';
      } else {
        wordSetupSection.style.display = 'none';
        showToast('✅ Spiel gestartet!');
      }
    });
  });

  // ══════════════════════════════════════
  //  START GAME — Host-plays mode
  // ══════════════════════════════════════
  hostPlaysStartBtn.addEventListener('click', () => {
    if (!pickedWord) { hostPlaysError.textContent = 'Kein Wort geladen'; hostPlaysError.style.display = 'block'; return; }
    hostPlaysError.style.display = 'none';
    hostPlaysStartBtn.disabled = true;

    socket.emit('set-word-random', {
      code: currentRoom,
      category: pickedWord.category,
      word: pickedWord.word,
      numHints: parseInt(numHintsSelect.value) || maxHints
    }, (res) => {
      hostPlaysStartBtn.disabled = false;
      if (!res || !res.ok) {
        hostPlaysError.textContent = res && res.err ? res.err : 'Fehler';
        hostPlaysError.style.display = 'block';
      } else {
        hostPlaysWordSection.style.display = 'none';
        showToast('✅ Spiel gestartet!');
      }
    });
  });

  // ══════════════════════════════════════
  //  HOST-PLAYS: Hints
  // ══════════════════════════════════════
  hostSendHintBtn.addEventListener('click', () => {
    const h = hostHintInput.value.trim();
    if (!h) return;
    hostSendHintBtn.disabled = true;

    socket.emit('send-hint', { code: currentRoom, hint: h }, (res) => {
      hostSendHintBtn.disabled = false;
      if (res && res.ok) {
        hostHintInput.value = '';
        myHintsCount++;
        const left = maxHints - myHintsCount;
        hostHintsLeft.textContent = left;
        const tag = document.createElement('span');
        tag.className = 'hint-tag';
        tag.textContent = h;
        hostMyHints.appendChild(tag);
        if (left <= 0) {
          hostHintInputRow.style.display = 'none';
          hostHintDoneMsg.style.display = 'block';
        }
        showToast('💬 Hinweis gesendet');
      } else {
        showToast('❌ ' + (res && res.err ? res.err : 'Fehler'), 3000);
      }
    });
  });

  hostHintInput.addEventListener('keydown', e => { if (e.key === 'Enter') hostSendHintBtn.click(); });

  // ══════════════════════════════════════
  //  HOST-PLAYS: Vote
  // ══════════════════════════════════════
  function buildHostVoteButtons(players) {
    hostVoteOptions.innerHTML = '';
    players.forEach(name => {
      // In host-plays mode, host has a name → can't vote for themselves
      const hostName = document.getElementById('hostNameInput') ? hostNameInput.value.trim() : '';
      if (hostMode === 'play' && name === hostName) return;

      const btn = document.createElement('button');
      btn.className = 'btn btn-secondary';
      btn.style.cssText = 'width:100%; text-align:left; padding:12px 14px; font-size:15px; margin-bottom:4px';
      btn.textContent = '👤 ' + name;
      btn.addEventListener('click', () => {
        socket.emit('submit-vote', { code: currentRoom, voteFor: name }, (res) => {
          if (res && res.ok) {
            hostVoteOptions.querySelectorAll('.btn').forEach(b => { b.disabled = true; b.style.opacity = '0.4'; });
            btn.style.opacity = '1';
            btn.style.borderColor = 'var(--green)';
            btn.style.color = 'var(--green)';
            hostVoteDoneMsg.style.display = 'block';
            showToast('✅ Vote abgeschickt');
          }
        });
      });
      hostVoteOptions.appendChild(btn);
    });
  }

  // ══════════════════════════════════════
  //  HOST-PLAYS: Guess (as imposter)
  // ══════════════════════════════════════
  hostGuessBtn.addEventListener('click', () => {
    const g = hostGuessInput.value.trim();
    if (!g) return;
    hostGuessBtn.disabled = true;
    socket.emit('submit-guess', { code: currentRoom, guess: g }, (res) => {
      if (res && res.ok) {
        hostGuessInputRow.style.display = 'none';
        hostGuessDoneMsg.style.display = 'block';
        showToast('🎯 Tipp abgeschickt!');
      } else {
        hostGuessBtn.disabled = false;
        showToast('❌ ' + (res && res.err ? res.err : 'Fehler'), 3000);
      }
    });
  });

  // ══════════════════════════════════════
  //  VOTING CONTROLS
  // ══════════════════════════════════════
  startVoteBtn.addEventListener('click', () => {
    socket.emit('start-voting', { code: currentRoom }, (res) => {
      if (res && res.ok) {
        startVoteBtn.style.display = 'none';
        showToast('🗳️ Voting gestartet!');
      } else {
        showToast('❌ ' + (res && res.err ? res.err : 'Fehler'));
      }
    });
  });

  revealBtn.addEventListener('click', () => {
    socket.emit('reveal', { code: currentRoom }, (res) => {
      if (!res || !res.ok) showToast('❌ ' + (res && res.err ? res.err : 'Fehler'));
    });
  });

  newRoundBtn.addEventListener('click', async () => {
    socket.emit('new-round', { code: currentRoom }, async (res) => {
      if (res && res.ok) {
        // Reset UI
        revealSection.style.display = 'none';
        voteProgressSection.style.display = 'none';
        hostInfoSection.style.display = 'none';
        hostRoleSection.style.display = 'none';
        hostVotingSection.style.display = 'none';
        hostGuessSection.style.display = 'none';
        startVoteBtn.style.display = 'none';
        revealBtn.style.display = 'none';
        newRoundBtn.style.display = 'none';
        myRole = null;
        myHintsCount = 0;
        hostMyHints.innerHTML = '';
        hostHintInput.value = '';
        hostGuessInput.value = '';
        hostVoteDoneMsg.style.display = 'none';
        hostGuessDoneMsg.style.display = 'none';
        hostHintDoneMsg.style.display = 'none';
        hostHintInputRow.style.display = 'flex';
        hostGuessInputRow.style.display = 'flex';

        if (hostMode === 'play') {
          hostPlaysWordSection.style.display = 'block';
          await refreshHostPlaysWord();
        } else {
          wordSetupSection.style.display = 'block';
          hostWord.value = '';
          hostCategory.value = '';
          if (wordSource === 'random') await refreshRandomWord();
        }
        updatePhaseBadge('lobby');
        showToast('🔄 Neue Runde — bereit!');
      }
    });
  });

  // ══════════════════════════════════════
  //  SOCKET EVENTS
  // ══════════════════════════════════════
  socket.on('room-state', (state) => {
    if (!state) return;
    updatePhaseBadge(state.phase);
    hostPlayerCount.textContent = state.numPlayers || 0;
    renderHostPlayers(state.players || [], state.phase);

    if (state.phase === 'hinting') {
      startVoteBtn.style.display = 'block';
      revealBtn.style.display = 'none';
      newRoundBtn.style.display = 'none';
    } else if (state.phase === 'voting') {
      startVoteBtn.style.display = 'none';
      revealBtn.style.display = 'block';
      newRoundBtn.style.display = 'none';
      voteProgressSection.style.display = 'block';
    } else if (state.phase === 'reveal') {
      startVoteBtn.style.display = 'none';
      revealBtn.style.display = 'none';
      newRoundBtn.style.display = 'block';
    }
  });

  // Host gets their own role (when host plays)
  socket.on('role-assigned', (payload) => {
    if (hostMode !== 'play') return; // moderator doesn't play
    myRole = payload.role;
    maxHints = payload.numHints || 2;
    myHintsCount = 0;
    hostMyHints.innerHTML = '';
    hostHintDoneMsg.style.display = 'none';
    hostHintInputRow.style.display = 'flex';
    hostVoteDoneMsg.style.display = 'none';
    hostGuessDoneMsg.style.display = 'none';
    hostGuessInputRow.style.display = 'flex';
    hostHintsLeft.textContent = maxHints;

    hostRoleSection.style.display = 'block';

    if (myRole === 'imposter') {
      hostWordDisplay.textContent = '???';
      hostRoleCard.classList.add('imposter');
      hostRoleLabel.textContent = '🎭 Du bist der Imposter!';
      hostRoleLabel.className = 'role-label imposter-label';
    } else {
      hostWordDisplay.textContent = payload.word || '—';
      hostRoleCard.classList.remove('imposter');
      hostRoleLabel.textContent = '✅ Du kennst das Wort';
      hostRoleLabel.className = 'role-label player-label';
    }

    if (payload.category) {
      hostCategoryLabel.textContent = 'Kategorie: ' + payload.category;
    } else {
      hostCategoryLabel.textContent = 'Ohne Kategorie';
    }
  });

  // Moderator-only: who is the imposter
  socket.on('host-info', (info) => {
    hostInfoSection.style.display = 'block';
    hostSecretInfo.innerHTML = `
      <div>🎭 <strong>Imposter:</strong> <span style="color:var(--accent2); font-size:16px">${info.imposterName}</span></div>
      <div style="margin-top:4px">📝 <strong>Begriff:</strong> ${info.word}</div>
      ${info.category ? `<div>🏷️ <strong>Kategorie:</strong> ${info.category}</div>` : ''}
    `;
  });

  socket.on('voting-started', (data) => {
    if (hostMode === 'play') {
      // Host votes too
      hostVotingSection.style.display = 'block';
      buildHostVoteButtons(data.players || []);
      if (myRole === 'imposter') {
        hostGuessSection.style.display = 'block';
      }
      // Hide hint section
      hostHintInputRow.style.display = 'none';
      hostHintDoneMsg.style.display = myHintsCount >= maxHints
        ? 'block' : 'none';
    }
  });

  socket.on('vote-update', (data) => {
    voteProgressCount.textContent = data.votedCount;
    voteProgressTotal.textContent = data.totalVoters;
    const pct = data.totalVoters > 0 ? (data.votedCount / data.totalVoters) * 100 : 0;
    voteProgressBar.style.width = pct + '%';

    voteResultsPreview.innerHTML = Object.entries(data.tally || {})
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `
        <div class="vote-bar">
          <span class="vote-count">${count}</span>
          <span style="font-size:14px;font-weight:600">${name}</span>
        </div>
      `).join('');

    if (data.allVoted) showToast('✅ Alle haben gevotet!');
  });

  socket.on('reveal', (data) => {
    updatePhaseBadge('reveal');
    voteProgressSection.style.display = 'none';
    hostVotingSection.style.display = 'none';
    hostGuessSection.style.display = 'none';
    hostRoleSection.style.display = 'none';
    revealSection.style.display = 'block';

    revealWord.textContent = data.word || '—';
    revealImposterName.textContent = data.imposter ? data.imposter.name : '—';

    if (data.imposterGuess) {
      revealGuessResult.innerHTML = data.imposterGuessCorrect
        ? `Rateversuch: <span class="guess-correct">„${data.imposterGuess}" — RICHTIG! 🎉</span>`
        : `Rateversuch: <span class="guess-wrong">„${data.imposterGuess}" — Falsch</span>`;
    } else {
      revealGuessResult.textContent = 'Kein Rateversuch.';
    }

    renderRevealVotes(data, revealVotes);
    renderRevealPlayers(data, revealPlayers);
  });

  socket.on('new-round', () => {
    // handled in button click above
  });

  socket.on('player-left', (data) => {
    showToast(`👋 ${data.name} hat den Raum verlassen`);
  });

  function renderHostPlayers(players, phase) {
    hostPlayersList.innerHTML = '';
    if (players.length === 0) {
      hostPlayersList.innerHTML = '<div style="color:var(--text-dim);font-size:13px;text-align:center;padding:10px">Warte auf Spieler…</div>';
      return;
    }
    players.forEach(p => {
      const row = document.createElement('div');
      row.className = 'player-row';
      const hintHtml = (p.hints || []).map(h => `<span class="hint-tag">${h}</span>`).join('');
      let statusHtml = '';
      if (phase === 'voting') {
        statusHtml = p.hasVoted
          ? '<span style="color:var(--green);font-size:12px;font-weight:700">✅</span>'
          : '<span style="color:var(--yellow);font-size:12px">⏳</span>';
      }
      row.innerHTML = `
        <div>
          <div class="player-name">${p.name}</div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">${hintHtml}</div>
        </div>
        <div>${statusHtml}</div>
      `;
      hostPlayersList.appendChild(row);
    });
  }
}

// ═════════════════════════════════════════════════════════════
//  PLAYER
// ═════════════════════════════════════════════════════════════
function initPlayer() {
  let currentRoom = null;
  let myRole = null;
  let myHintsCount = 0;
  let maxHints = 2;
  let myName = '';

  // Elements
  const joinSection   = document.getElementById('joinSection');
  const gameArea      = document.getElementById('gameArea');
  const nameInput     = document.getElementById('nameInput');
  const codeInput     = document.getElementById('codeInput');
  const joinBtn       = document.getElementById('joinBtn');
  const joinError     = document.getElementById('joinError');
  const roomCodeDisplay = document.getElementById('roomCodeDisplay');
  const playerCount   = document.getElementById('playerCount');
  const playersList   = document.getElementById('playersList');

  const roleSection   = document.getElementById('roleSection');
  const roleCard      = document.getElementById('roleCard');
  const categoryLabel = document.getElementById('categoryLabel');
  const wordDisplay   = document.getElementById('wordDisplay');
  const roleLabel     = document.getElementById('roleLabel');

  const hintSection   = document.getElementById('hintSection');
  const hintsLeft     = document.getElementById('hintsLeft');
  const myHintsEl     = document.getElementById('myHints');
  const hintInput     = document.getElementById('hintInput');
  const hintInputRow  = document.getElementById('hintInputRow');
  const sendHintBtn   = document.getElementById('sendHintBtn');
  const hintDoneMsg   = document.getElementById('hintDoneMsg');

  const votingSection = document.getElementById('votingSection');
  const voteOptions   = document.getElementById('voteOptions');
  const voteDoneMsg   = document.getElementById('voteDoneMsg');

  const guessSection  = document.getElementById('guessSection');
  const guessInput    = document.getElementById('guessInput');
  const guessInputRow = document.getElementById('guessInputRow');
  const guessBtn      = document.getElementById('guessBtn');
  const guessDoneMsg  = document.getElementById('guessDoneMsg');

  const revealSection      = document.getElementById('revealSection');
  const revealWord         = document.getElementById('revealWord');
  const revealImposterName = document.getElementById('revealImposterName');
  const revealGuessResult  = document.getElementById('revealGuessResult');
  const revealVotes        = document.getElementById('revealVotes');
  const revealPlayers      = document.getElementById('revealPlayers');

  // ── Join ──
  joinBtn.addEventListener('click', doJoin);
  codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase(); });

  function doJoin() {
    const name = nameInput.value.trim();
    const code = codeInput.value.toUpperCase().trim();
    if (!name) { showErr('Bitte deinen Namen eingeben'); return; }
    if (!code) { showErr('Bitte den Raumcode eingeben'); return; }

    joinBtn.disabled = true;
    joinBtn.textContent = '…';

    socket.emit('join-room', { code, name }, (res) => {
      joinBtn.disabled = false;
      joinBtn.textContent = 'Beitreten →';
      if (!res || !res.ok) { showErr(res && res.err ? res.err : 'Fehler'); return; }
      currentRoom = code;
      myName = name;
      joinError.style.display = 'none';
      joinSection.style.display = 'none';
      gameArea.style.display = 'block';
      roomCodeDisplay.textContent = code;
    });
  }

  function showErr(msg) {
    joinError.textContent = msg;
    joinError.style.display = 'block';
  }

  // ── Room state ──
  socket.on('room-state', (state) => {
    if (!state) return;
    if (currentRoom && state.code !== currentRoom) return;
    if (state.code) roomCodeDisplay.textContent = state.code;
    playerCount.textContent = state.numPlayers || 0;
    updatePhaseBadge(state.phase);
    renderPlayers(state.players || []);
  });

  // ── Role assigned ──
  socket.on('role-assigned', (payload) => {
    myRole = payload.role;
    maxHints = payload.numHints || 2;
    myHintsCount = 0;

    revealSection.style.display = 'none';
    votingSection.style.display = 'none';
    guessSection.style.display = 'none';
    voteDoneMsg.style.display = 'none';
    guessDoneMsg.style.display = 'none';
    hintDoneMsg.style.display = 'none';
    hintInputRow.style.display = 'flex';
    guessInputRow.style.display = 'flex';
    hintInput.value = '';
    guessInput.value = '';
    myHintsEl.innerHTML = '';

    roleSection.style.display = 'block';
    categoryLabel.textContent = payload.category ? 'Kategorie: ' + payload.category : 'Ohne Kategorie';

    if (myRole === 'imposter') {
      wordDisplay.textContent = '???';
      roleCard.classList.add('imposter');
      roleLabel.textContent = '🎭 Du bist der Imposter!';
      roleLabel.className = 'role-label imposter-label';
    } else {
      wordDisplay.textContent = payload.word || '—';
      roleCard.classList.remove('imposter');
      roleLabel.textContent = '✅ Du kennst das Wort';
      roleLabel.className = 'role-label player-label';
    }

    hintSection.style.display = 'block';
    hintsLeft.textContent = maxHints;
    updatePhaseBadge('hinting');
  });

  // ── Voting started ──
  socket.on('voting-started', (data) => {
    hintSection.style.display = 'none';
    votingSection.style.display = 'block';
    voteDoneMsg.style.display = 'none';
    voteOptions.innerHTML = '';

    (data.players || []).forEach(name => {
      if (name === myName) return;
      const btn = document.createElement('button');
      btn.className = 'btn btn-secondary';
      btn.style.cssText = 'width:100%; text-align:left; padding:12px 14px; font-size:15px; margin-bottom:4px';
      btn.textContent = '👤 ' + name;
      btn.addEventListener('click', () => {
        socket.emit('submit-vote', { code: currentRoom, voteFor: name }, (res) => {
          if (res && res.ok) {
            voteOptions.querySelectorAll('.btn').forEach(b => { b.disabled = true; b.style.opacity = '0.4'; });
            btn.style.opacity = '1';
            btn.style.borderColor = 'var(--green)';
            btn.style.color = 'var(--green)';
            voteDoneMsg.style.display = 'block';
            showToast('✅ Vote für ' + name + ' abgeschickt');
          } else {
            showToast('❌ ' + (res && res.err ? res.err : 'Fehler'), 3000);
          }
        });
      });
      voteOptions.appendChild(btn);
    });

    if (myRole === 'imposter') {
      guessSection.style.display = 'block';
    }
    updatePhaseBadge('voting');
  });

  // ── Hints ──
  sendHintBtn.addEventListener('click', () => {
    const h = hintInput.value.trim();
    if (!h) return;
    sendHintBtn.disabled = true;
    socket.emit('send-hint', { code: currentRoom, hint: h }, (res) => {
      sendHintBtn.disabled = false;
      if (res && res.ok) {
        hintInput.value = '';
        myHintsCount++;
        const left = maxHints - myHintsCount;
        hintsLeft.textContent = left;
        const tag = document.createElement('span');
        tag.className = 'hint-tag';
        tag.textContent = h;
        myHintsEl.appendChild(tag);
        if (left <= 0) { hintInputRow.style.display = 'none'; hintDoneMsg.style.display = 'block'; }
        showToast('💬 Hinweis gesendet');
      } else {
        showToast('❌ ' + (res && res.err ? res.err : 'Fehler'), 3000);
      }
    });
  });

  hintInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendHintBtn.click(); });

  // ── Guess ──
  guessBtn.addEventListener('click', () => {
    const g = guessInput.value.trim();
    if (!g) return;
    guessBtn.disabled = true;
    socket.emit('submit-guess', { code: currentRoom, guess: g }, (res) => {
      if (res && res.ok) {
        guessInputRow.style.display = 'none';
        guessDoneMsg.style.display = 'block';
        showToast('🎯 Tipp abgeschickt!');
      } else {
        guessBtn.disabled = false;
        showToast('❌ ' + (res && res.err ? res.err : 'Fehler'), 3000);
      }
    });
  });

  // ── Reveal ──
  socket.on('reveal', (data) => {
    updatePhaseBadge('reveal');
    hintSection.style.display = 'none';
    votingSection.style.display = 'none';
    guessSection.style.display = 'none';
    revealSection.style.display = 'block';

    revealWord.textContent = data.word || '—';
    revealImposterName.textContent = data.imposter ? data.imposter.name : '—';

    if (data.imposterGuess) {
      revealGuessResult.innerHTML = data.imposterGuessCorrect
        ? `Rateversuch: <span class="guess-correct">„${data.imposterGuess}" — RICHTIG! 🎉</span>`
        : `Rateversuch: <span class="guess-wrong">„${data.imposterGuess}" — Falsch</span>`;
    } else {
      revealGuessResult.textContent = 'Kein Rateversuch abgegeben.';
    }

    renderRevealVotes(data, revealVotes);
    renderRevealPlayers(data, revealPlayers);
  });

  // ── New Round ──
  socket.on('new-round', () => {
    roleSection.style.display = 'none';
    hintSection.style.display = 'none';
    votingSection.style.display = 'none';
    guessSection.style.display = 'none';
    revealSection.style.display = 'none';
    myRole = null;
    myHintsCount = 0;
    updatePhaseBadge('lobby');
    showToast('🔄 Neue Runde — warte auf den Host');
  });

  socket.on('player-left', (d) => { showToast(`👋 ${d.name} hat den Raum verlassen`); });
  socket.on('room-closed', (d) => { alert(d && d.reason ? d.reason : 'Raum geschlossen.'); location.reload(); });

  function renderPlayers(players) {
    if (!playersList) return;
    playersList.innerHTML = '';
    players.forEach(p => {
      const row = document.createElement('div');
      row.className = 'player-row';
      const hintHtml = (p.hints || []).map(h => `<span class="hint-tag">${h}</span>`).join('') || '<span style="color:var(--text-dim);font-size:12px">Wartet…</span>';
      row.innerHTML = `<div class="player-name">${p.name}</div><div style="display:flex;flex-wrap:wrap;gap:4px">${hintHtml}</div>`;
      playersList.appendChild(row);
    });
  }
}

const ClientApp = { initHost, initPlayer };
