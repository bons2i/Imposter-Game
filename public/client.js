// client.js - Imposter Game

const socket = io();

// =========================================
//  UTILS
// =========================================

// Escape user-provided strings before inserting into innerHTML (XSS prevention)
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(msg, duration) {
  duration = duration || 2500;
  var t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(function() { t.classList.remove('show'); }, duration);
}

function updatePhaseBadge(phase) {
  var b = document.getElementById('phaseBadge');
  if (!b) return;
  var labels = { lobby: 'Lobby', hinting: 'Hinweise', voting: 'Voting', reveal: 'Reveal' };
  b.textContent = labels[phase] || phase;
  b.className = 'phase-badge ' + (phase || '');
}

function renderRevealVotes(data, container) {
  container.innerHTML = '';
  var tally = {};
  (data.players || []).forEach(function(p) { tally[p.name] = p.votesReceived || 0; });

  // Build a map: votedFor → list of voter names
  var votersByTarget = {};
  (data.players || []).forEach(function(p) {
    if (p.votedFor) {
      if (!votersByTarget[p.votedFor]) votersByTarget[p.votedFor] = [];
      votersByTarget[p.votedFor].push(p.name);
    }
  });

  Object.entries(tally).sort(function(a, b) { return b[1] - a[1]; }).forEach(function(entry) {
    var name = entry[0], count = entry[1];
    var isImp = data.imposter && name === data.imposter.name;
    var voters = votersByTarget[name] || [];
    var voterTags = voters.map(function(v) {
      return '<span style="font-size:11px;background:rgba(0,0,0,0.07);border-radius:5px;padding:2px 7px;margin:2px 2px 0 0;display:inline-block">' + esc(v) + '</span>';
    }).join('');

    var row = document.createElement('div');
    row.className = 'vote-bar';
    row.style.flexDirection = 'column';
    row.style.alignItems = 'flex-start';
    row.style.gap = '4px';
    row.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;width:100%">' +
        '<span class="vote-count" style="' + (isImp ? 'color:var(--accent2)' : '') + '">' + count + '</span>' +
        '<span style="font-size:14px;font-weight:700;' + (isImp ? 'color:var(--accent2)' : '') + '">' +
          (isImp ? '🎭 ' : '') + esc(name) +
        '</span>' +
      '</div>' +
      (voterTags ? '<div style="padding-left:44px;line-height:1.8">' + voterTags + '</div>' : '');
    container.appendChild(row);
  });
}

function renderRevealPlayers(data, container) {
  container.innerHTML = '';
  (data.players || []).forEach(function(p) {
    var isImp = data.imposter && p.name === data.imposter.name;
    var row = document.createElement('div');
    row.className = 'player-row';
    var hintsHtml = (p.hints || []).map(function(h) {
      return '<span class="hint-tag">' + esc(h) + '</span>';
    }).join('') || '<span style="color:var(--text-dim);font-size:12px">Keine Hinweise</span>';

    var votedForHtml = p.votedFor
      ? '<div style="font-size:12px;color:var(--text-dim);margin-top:3px">🗳️ hat gewählt: <strong>' + esc(p.votedFor) + '</strong></div>'
      : (isImp ? '' : '<div style="font-size:12px;color:var(--text-dim);margin-top:3px;opacity:0.5">nicht abgestimmt</div>');

    row.innerHTML =
      '<div style="flex:1">' +
        '<div class="player-name" style="' + (isImp ? 'color:var(--accent2)' : '') + '">' +
          (isImp ? '🎭 ' : '') + esc(p.name) +
        '</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">' + hintsHtml + '</div>' +
        votedForHtml +
      '</div>' +
      (p.votesReceived > 0
        ? '<span style="color:var(--accent2);font-weight:700;font-size:13px;flex-shrink:0">' + p.votesReceived + '×</span>'
        : '');
    container.appendChild(row);
  });
}

// =========================================
//  RANDOM WORD LOADER
// =========================================
var _wordsData = null;

function loadWords() {
  if (_wordsData) return Promise.resolve(_wordsData);
  return fetch('/words.json')
    .then(function(r) { return r.json(); })
    .then(function(d) { _wordsData = d; return d; });
}

function pickRandomWord() {
  return loadWords().then(function(data) {
    var cats = data.categories;
    var cat = cats[Math.floor(Math.random() * cats.length)];
    var word = cat.words[Math.floor(Math.random() * cat.words.length)];
    return { category: cat.name, word: word };
  });
}

// =========================================
//  HOST
// =========================================
function initHost() {
  var currentRoom = null;
  var hostMode = 'moderator'; // 'moderator' | 'play'
  var wordSource = 'custom';  // 'custom' | 'random'
  var pickedWord = null;
  var myRole = null;
  var myName = '';
  var myHintsGiven = 0;
  var maxHints = 2;
  var isMyTurn = false;

  // Setup elements
  var setupSection    = document.getElementById('setupSection');
  var modeToggle      = document.getElementById('modeToggle');
  var hostNameRow     = document.getElementById('hostNameRow');
  var hostNameInput   = document.getElementById('hostNameInput');
  var customCodeInput = document.getElementById('customCodeInput');
  var maxPlayersInput = document.getElementById('maxPlayers');
  var numHintsSelect  = document.getElementById('numHints');
  var createBtn       = document.getElementById('createBtn');
  var createError     = document.getElementById('createError');

  // Lobby elements
  var hostLobby       = document.getElementById('hostLobby');
  var hostRoomCode    = document.getElementById('hostRoomCode');
  var hostPlayerCount = document.getElementById('hostPlayerCount');
  var hostPlayersList = document.getElementById('hostPlayersList');

  // Word setup
  var wordSetupSection      = document.getElementById('wordSetupSection');
  var wordSourceToggle      = document.getElementById('wordSourceToggle');
  var customWordSection     = document.getElementById('customWordSection');
  var randomWordSection     = document.getElementById('randomWordSection');
  var hostCategory          = document.getElementById('hostCategory');
  var hostWord              = document.getElementById('hostWord');
  var randomCategoryDisplay = document.getElementById('randomCategoryDisplay');
  var randomWordDisplay     = document.getElementById('randomWordDisplay');
  var rerollBtn             = document.getElementById('rerollBtn');
  var setWordBtn            = document.getElementById('setWordBtn');
  var setWordError          = document.getElementById('setWordError');

  // Host-plays word
  var hostPlaysWordSection = document.getElementById('hostPlaysWordSection');
  var hostPlaysCategory    = document.getElementById('hostPlaysCategory');
  var hostPlaysRerollBtn   = document.getElementById('hostPlaysRerollBtn');
  var hostPlaysStartBtn    = document.getElementById('hostPlaysStartBtn');
  var hostPlaysError       = document.getElementById('hostPlaysError');

  // Secret info + turn indicator
  var hostInfoSection   = document.getElementById('hostInfoSection');
  var hostSecretInfo    = document.getElementById('hostSecretInfo');
  var hostTurnIndicator = document.getElementById('hostTurnIndicator');
  var hostActiveName    = document.getElementById('hostActiveName');
  var hostTurnProgress  = document.getElementById('hostTurnProgress');

  // Role + hints (host as player)
  var hostRoleSection   = document.getElementById('hostRoleSection');
  var hostRoleCard      = document.getElementById('hostRoleCard');
  var hostCategoryLabel = document.getElementById('hostCategoryLabel');
  var hostWordDisplay   = document.getElementById('hostWordDisplay');
  var hostRoleLabel     = document.getElementById('hostRoleLabel');
  var hostHintsLeft     = document.getElementById('hostHintsLeft');
  var hostMyHints       = document.getElementById('hostMyHints');
  var hostHintInput     = document.getElementById('hostHintInput');
  var hostHintInputRow  = document.getElementById('hostHintInputRow');
  var hostWaitingMsg    = document.getElementById('hostWaitingMsg');
  var hostSendHintBtn   = document.getElementById('hostSendHintBtn');
  var hostHintDoneMsg   = document.getElementById('hostHintDoneMsg');

  // Voting / guess
  var voteProgressSection = document.getElementById('voteProgressSection');
  var voteProgressCount   = document.getElementById('voteProgressCount');
  var voteProgressTotal   = document.getElementById('voteProgressTotal');
  var voteProgressBar     = document.getElementById('voteProgressBar');
  var voteResultsPreview  = document.getElementById('voteResultsPreview');
  var hostVotingSection   = document.getElementById('hostVotingSection');
  var hostVoteOptions     = document.getElementById('hostVoteOptions');
  var hostVoteDoneMsg     = document.getElementById('hostVoteDoneMsg');
  var hostGuessSection    = document.getElementById('hostGuessSection');
  var hostGuessInput      = document.getElementById('hostGuessInput');
  var hostGuessInputRow   = document.getElementById('hostGuessInputRow');
  var hostGuessBtn        = document.getElementById('hostGuessBtn');
  var hostGuessDoneMsg    = document.getElementById('hostGuessDoneMsg');

  // Control buttons
  var startVoteBtn = document.getElementById('startVoteBtn');
  var revealBtn    = document.getElementById('revealBtn');
  var newRoundBtn  = document.getElementById('newRoundBtn');

  // Reveal
  var revealSection      = document.getElementById('revealSection');
  var revealWord         = document.getElementById('revealWord');
  var revealImposterName = document.getElementById('revealImposterName');
  var revealGuessResult  = document.getElementById('revealGuessResult');
  var revealVotes        = document.getElementById('revealVotes');
  var revealPlayers      = document.getElementById('revealPlayers');

  // --- Mode toggle ---
  modeToggle.querySelectorAll('.mode-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      modeToggle.querySelectorAll('.mode-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      hostMode = btn.dataset.mode;
      hostNameRow.style.display = hostMode === 'play' ? 'block' : 'none';
    });
  });

  // --- Word source toggle (moderator mode) ---
  wordSourceToggle.querySelectorAll('.source-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      wordSourceToggle.querySelectorAll('.source-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      wordSource = btn.dataset.source;
      if (wordSource === 'random') {
        customWordSection.style.display = 'none';
        randomWordSection.style.display = 'block';
        refreshRandomWord();
      } else {
        customWordSection.style.display = 'block';
        randomWordSection.style.display = 'none';
        pickedWord = null;
      }
    });
  });

  rerollBtn.addEventListener('click', refreshRandomWord);
  hostPlaysRerollBtn.addEventListener('click', refreshHostPlaysWord);

  function refreshRandomWord() {
    rerollBtn.disabled = true;
    pickRandomWord().then(function(w) {
      pickedWord = w;
      randomCategoryDisplay.textContent = 'Kategorie: ' + w.category;
      randomWordDisplay.textContent = w.word;
      rerollBtn.disabled = false;
    });
  }

  function refreshHostPlaysWord() {
    hostPlaysRerollBtn.disabled = true;
    pickRandomWord().then(function(w) {
      pickedWord = w;
      // Only show category, not the word (host plays fair)
      hostPlaysCategory.textContent = 'Kategorie: ' + w.category;
      hostPlaysRerollBtn.disabled = false;
    });
  }

  // --- Create Room ---
  createBtn.addEventListener('click', function() {
    var customCode = customCodeInput.value.toUpperCase().trim().replace(/[^A-Z0-9]/g, '');
    var mp = parseInt(maxPlayersInput.value) || 12;
    var nh = parseInt(numHintsSelect.value) || 2;
    var hName = hostNameInput.value.trim();

    if (hostMode === 'play' && !hName) {
      createError.textContent = 'Bitte deinen Namen eingeben';
      createError.style.display = 'block';
      return;
    }
    createError.style.display = 'none';
    createBtn.disabled = true;
    createBtn.textContent = '...';
    myName = hName;
    maxHints = nh;

    socket.emit('create-room', {
      customCode: customCode,
      maxPlayers: mp,
      numHints: nh,
      hostPlays: hostMode === 'play',
      hostName: hName
    }, function(res) {
      createBtn.disabled = false;
      createBtn.textContent = 'Raum erstellen';
      if (!res || !res.ok) {
        createError.textContent = (res && res.err) ? res.err : 'Fehler beim Erstellen';
        createError.style.display = 'block';
        return;
      }
      currentRoom = res.code;
      setupSection.style.display = 'none';
      hostLobby.style.display = 'block';
      hostRoomCode.textContent = res.code;

      if (hostMode === 'play') {
        wordSetupSection.style.display = 'none';
        hostPlaysWordSection.style.display = 'block';
        refreshHostPlaysWord();
      } else {
        wordSetupSection.style.display = 'block';
        hostPlaysWordSection.style.display = 'none';
      }
      showToast('Raum ' + res.code + ' erstellt!');
    });
  });

  // --- Start game: moderator with manual/random word ---
  setWordBtn.addEventListener('click', function() {
    var category, word;
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

    socket.emit('set-word', {
      code: currentRoom,
      category: category,
      word: word,
      numHints: parseInt(numHintsSelect.value) || maxHints
    }, function(res) {
      setWordBtn.disabled = false;
      if (!res || !res.ok) {
        setWordError.textContent = (res && res.err) ? res.err : 'Fehler';
        setWordError.style.display = 'block';
      } else {
        wordSetupSection.style.display = 'none';
        showToast('Spiel gestartet!');
      }
    });
  });

  // --- Start game: host-plays mode ---
  hostPlaysStartBtn.addEventListener('click', function() {
    if (!pickedWord) { hostPlaysError.textContent = 'Kein Wort geladen'; hostPlaysError.style.display = 'block'; return; }
    hostPlaysError.style.display = 'none';
    hostPlaysStartBtn.disabled = true;

    socket.emit('set-word', {
      code: currentRoom,
      category: pickedWord.category,
      word: pickedWord.word,
      numHints: parseInt(numHintsSelect.value) || maxHints
    }, function(res) {
      hostPlaysStartBtn.disabled = false;
      if (!res || !res.ok) {
        hostPlaysError.textContent = (res && res.err) ? res.err : 'Fehler';
        hostPlaysError.style.display = 'block';
      } else {
        hostPlaysWordSection.style.display = 'none';
        showToast('Spiel gestartet!');
      }
    });
  });

  // --- Host hint input ---
  hostSendHintBtn.addEventListener('click', sendHostHint);
  hostHintInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') sendHostHint(); });

  function sendHostHint() {
    var h = hostHintInput.value.trim();
    if (!h || !isMyTurn) return;
    hostSendHintBtn.disabled = true;

    socket.emit('send-hint', { code: currentRoom, hint: h }, function(res) {
      hostSendHintBtn.disabled = false;
      if (res && res.ok) {
        hostHintInput.value = '';
        myHintsGiven++;
        hostHintsLeft.textContent = maxHints - myHintsGiven;
        var tag = document.createElement('span');
        tag.className = 'hint-tag';
        tag.textContent = h; // textContent is safe here
        hostMyHints.appendChild(tag);
        isMyTurn = false;
        hostHintInputRow.style.display = 'none';
        hostWaitingMsg.style.display = 'block';
        showToast('Hinweis gesendet!');
        if (myHintsGiven >= maxHints) hostHintDoneMsg.style.display = 'block';
      } else {
        showToast((res && res.err) ? res.err : 'Fehler', 3000);
      }
    });
  }

  // --- Host vote buttons ---
  function buildHostVoteButtons(players) {
    hostVoteOptions.innerHTML = '';
    players.forEach(function(name) {
      if (name === myName) return;
      var btn = document.createElement('button');
      btn.className = 'btn btn-secondary';
      btn.style.cssText = 'width:100%;text-align:left;padding:12px 14px;font-size:15px;margin-bottom:4px';
      btn.textContent = '👤 ' + name; // textContent is safe
      btn.addEventListener('click', function() {
        socket.emit('submit-vote', { code: currentRoom, voteFor: name }, function(res) {
          if (res && res.ok) {
            hostVoteOptions.querySelectorAll('.btn').forEach(function(b) { b.disabled = true; b.style.opacity = '0.4'; });
            btn.style.opacity = '1';
            btn.style.borderColor = 'var(--green)';
            btn.style.color = 'var(--green)';
            hostVoteDoneMsg.style.display = 'block';
            showToast('Vote abgeschickt!');
          }
        });
      });
      hostVoteOptions.appendChild(btn);
    });
  }

  // --- Host guess ---
  hostGuessBtn.addEventListener('click', function() {
    var g = hostGuessInput.value.trim();
    if (!g) return;
    hostGuessBtn.disabled = true;
    socket.emit('submit-guess', { code: currentRoom, guess: g }, function(res) {
      if (res && res.ok) {
        hostGuessInputRow.style.display = 'none';
        hostGuessDoneMsg.style.display = 'block';
        showToast('Tipp abgeschickt!');
      } else {
        hostGuessBtn.disabled = false;
        showToast((res && res.err) ? res.err : 'Fehler', 3000);
      }
    });
  });

  // --- Control buttons ---
  startVoteBtn.addEventListener('click', function() {
    socket.emit('start-voting', { code: currentRoom }, function(res) {
      if (res && res.ok) { startVoteBtn.style.display = 'none'; showToast('Voting gestartet!'); }
    });
  });

  // guessApproval elements
  var guessApprovalSection = document.getElementById('guessApprovalSection');
  var approvalWord         = document.getElementById('approvalWord');
  var approvalGuessText    = document.getElementById('approvalGuessText');
  var approveCorrectBtn    = document.getElementById('approveCorrectBtn');
  var approveWrongBtn      = document.getElementById('approveWrongBtn');
  var _pendingImposterGuess = null; // stored when imposter submits guess

  // vote-update may carry the imposter's guess — store it
  // (already handled below in vote-update handler)

  revealBtn.addEventListener('click', function() {
    // If there's a pending imposter guess, show approval first
    if (_pendingImposterGuess) {
      approvalWord.textContent = '(wird nach Bestätigung gezeigt)';
      approvalGuessText.textContent = _pendingImposterGuess;
      guessApprovalSection.style.display = 'block';
      revealBtn.style.display = 'none';
      // Scroll to it
      guessApprovalSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      // No guess — just reveal directly
      socket.emit('reveal', { code: currentRoom, imposterGuessCorrect: false }, function() {});
    }
  });

  approveCorrectBtn.addEventListener('click', function() {
    guessApprovalSection.style.display = 'none';
    socket.emit('reveal', { code: currentRoom, imposterGuessCorrect: true }, function() {});
  });

  approveWrongBtn.addEventListener('click', function() {
    guessApprovalSection.style.display = 'none';
    socket.emit('reveal', { code: currentRoom, imposterGuessCorrect: false }, function() {});
  });

  newRoundBtn.addEventListener('click', function() {
    socket.emit('new-round', { code: currentRoom }, function(res) {
      if (!res || !res.ok) return;
      revealSection.style.display = 'none';
      voteProgressSection.style.display = 'none';
      hostInfoSection.style.display = 'none';
      hostTurnIndicator.style.display = 'none';
      hostRoleSection.style.display = 'none';
      hostVotingSection.style.display = 'none';
      hostGuessSection.style.display = 'none';
      startVoteBtn.style.display = 'none';
      revealBtn.style.display = 'none';
      newRoundBtn.style.display = 'none';
      myRole = null; myHintsGiven = 0; isMyTurn = false;
      _pendingImposterGuess = null;
      hostMyHints.innerHTML = '';
      hostHintInput.value = '';
      hostGuessInput.value = '';
      hostGuessBtn.disabled = false;
      hostVoteDoneMsg.style.display = 'none';
      hostGuessDoneMsg.style.display = 'none';
      hostHintDoneMsg.style.display = 'none';
      hostHintInputRow.style.display = 'none';
      hostWaitingMsg.style.display = 'block';
      hostGuessSection.style.display = 'none';
      guessApprovalSection.style.display = 'none';
      updatePhaseBadge('lobby');

      if (hostMode === 'play') {
        hostPlaysWordSection.style.display = 'block';
        refreshHostPlaysWord();
      } else {
        wordSetupSection.style.display = 'block';
        hostWord.value = '';
        hostCategory.value = '';
        if (wordSource === 'random') refreshRandomWord();
      }
      showToast('Neue Runde!');
    });
  });

  // ==========================================
  //  SOCKET EVENTS (HOST)
  // ==========================================

  socket.on('room-state', function(state) {
    if (!state) return;
    updatePhaseBadge(state.phase);
    hostPlayerCount.textContent = state.numPlayers || 0;
    renderHostPlayerList(state.players || [], state.phase, state.activeName);

    if (state.phase === 'hinting') {
      startVoteBtn.style.display = 'block';
      revealBtn.style.display = 'none';
      newRoundBtn.style.display = 'none';
      if (hostMode !== 'play') hostTurnIndicator.style.display = 'block';
    } else if (state.phase === 'voting') {
      startVoteBtn.style.display = 'none';
      revealBtn.style.display = 'block';
      newRoundBtn.style.display = 'none';
      voteProgressSection.style.display = 'block';
      hostTurnIndicator.style.display = 'none';
    } else if (state.phase === 'reveal') {
      startVoteBtn.style.display = 'none';
      revealBtn.style.display = 'none';
      newRoundBtn.style.display = 'block';
    }
  });

  socket.on('turn-state', function(data) {
    // Update turn indicator for moderator
    if (hostMode === 'moderator') {
      hostTurnIndicator.style.display = 'block';
      hostActiveName.textContent = data.activeName; // safe: textContent
      hostTurnProgress.textContent = 'Hinweisrunde ' + data.hintRound + ' von ' + data.totalRounds;
    }
  });

  socket.on('your-turn', function(data) {
    if (hostMode !== 'play' || myHintsGiven >= maxHints) return;
    isMyTurn = true;
    hostWaitingMsg.style.display = 'none';
    hostHintInputRow.style.display = 'flex';
    hostHintInput.focus();
    showToast('Du bist dran! Gib deinen Hinweis ein.', 3000);
  });

  socket.on('role-assigned', function(payload) {
    if (hostMode !== 'play') return;
    myRole = payload.role;
    maxHints = payload.numHints || 2;
    myHintsGiven = 0;
    isMyTurn = false;
    hostMyHints.innerHTML = '';
    hostHintInput.value = '';
    hostHintDoneMsg.style.display = 'none';
    hostHintInputRow.style.display = 'none';
    hostWaitingMsg.style.display = 'block';
    hostVoteDoneMsg.style.display = 'none';
    hostGuessDoneMsg.style.display = 'none';
    hostGuessBtn.disabled = false;
    hostGuessInput.value = '';
    hostGuessInputRow.style.display = 'flex';
    hostHintsLeft.textContent = maxHints;
    hostRoleSection.style.display = 'block';
    hostCategoryLabel.textContent = payload.category ? 'Kategorie: ' + payload.category : 'Ohne Kategorie';

    if (myRole === 'imposter') {
      hostWordDisplay.textContent = '???';
      hostRoleCard.classList.add('imposter');
      hostRoleLabel.textContent = 'Du bist der Imposter!';
      hostRoleLabel.className = 'role-label imposter-label';
    } else {
      hostWordDisplay.textContent = payload.word || '-';
      hostRoleCard.classList.remove('imposter');
      hostRoleLabel.textContent = 'Du kennst das Wort';
      hostRoleLabel.className = 'role-label player-label';
    }
  });

  socket.on('host-info', function(info) {
    // Moderator-only: reveal who the imposter is
    hostInfoSection.style.display = 'block';
    hostSecretInfo.innerHTML =
      '<div>Imposter: <span style="color:var(--accent2);font-size:16px">' + esc(info.imposterName) + '</span></div>' +
      '<div style="margin-top:4px">Begriff: ' + esc(info.word) + '</div>' +
      (info.category ? '<div>Kategorie: ' + esc(info.category) + '</div>' : '');
  });

  socket.on('voting-started', function(data) {
    hostTurnIndicator.style.display = 'none';
    if (hostMode === 'play') {
      // Imposter skips voting — server sends imposter-vote-phase instead
      // This branch only fires for regular player role
      hostVotingSection.style.display = 'block';
      buildHostVoteButtons(data.players || []);
      hostHintInputRow.style.display = 'none';
      hostWaitingMsg.style.display = 'none';
    }
  });

  // Host is the imposter — only show guess, no vote buttons
  socket.on('imposter-vote-phase', function() {
    hostTurnIndicator.style.display = 'none';
    if (hostMode === 'play') {
      hostHintInputRow.style.display = 'none';
      hostWaitingMsg.style.display = 'none';
      hostVotingSection.style.display = 'none';
      hostGuessSection.style.display = 'block';
    }
    updatePhaseBadge('voting');
  });

  socket.on('vote-update', function(data) {
    voteProgressCount.textContent = data.votedCount;
    voteProgressTotal.textContent = data.totalVoters;
    var pct = data.totalVoters > 0 ? (data.votedCount / data.totalVoters) * 100 : 0;
    voteProgressBar.style.width = pct + '%';
    voteResultsPreview.innerHTML = Object.entries(data.tally || {})
      .sort(function(a, b) { return b[1] - a[1]; })
      .map(function(entry) {
        return '<div class="vote-bar">' +
          '<span class="vote-count">' + entry[1] + '</span>' +
          '<span style="font-size:14px;font-weight:600">' + esc(entry[0]) + '</span>' +
        '</div>';
      }).join('');
    // Store imposter's guess for approval before reveal
    if (data.imposterGuess) {
      _pendingImposterGuess = data.imposterGuess;
    }
    if (data.allVoted) showToast('✅ Alle sind fertig!');
  });

  socket.on('reveal', function(data) {
    updatePhaseBadge('reveal');
    voteProgressSection.style.display = 'none';
    hostVotingSection.style.display = 'none';
    hostGuessSection.style.display = 'none';
    hostRoleSection.style.display = 'none';
    hostTurnIndicator.style.display = 'none';
    revealSection.style.display = 'block';
    revealWord.textContent = data.word || '-';
    revealImposterName.textContent = data.imposter ? data.imposter.name : '-';

    if (data.imposterGuess) {
      revealGuessResult.innerHTML = data.imposterGuessCorrect
        ? 'Rateversuch: <span class="guess-correct">&bdquo;' + esc(data.imposterGuess) + '&ldquo; &mdash; RICHTIG!</span>'
        : 'Rateversuch: <span class="guess-wrong">&bdquo;' + esc(data.imposterGuess) + '&ldquo; &mdash; Falsch</span>';
    } else {
      revealGuessResult.textContent = 'Kein Rateversuch abgegeben.';
    }
    renderRevealVotes(data, revealVotes);
    renderRevealPlayers(data, revealPlayers);
  });

  socket.on('player-left', function(d) { showToast((d.name || 'Jemand') + ' hat den Raum verlassen'); });

  function renderHostPlayerList(players, phase, activeName) {
    hostPlayersList.innerHTML = '';
    if (!players.length) {
      hostPlayersList.innerHTML = '<div style="color:var(--text-dim);font-size:13px;text-align:center;padding:10px">Warte auf Spieler...</div>';
      return;
    }
    players.forEach(function(p, idx) {
      var isActive = phase === 'hinting' && p.name === activeName;
      var row = document.createElement('div');
      row.className = 'player-row' + (isActive ? ' player-row-active' : '');

      var hintHtml = (p.hints || []).map(function(h) {
        return '<span class="hint-tag">' + esc(h) + '</span>';
      }).join('');

      var statusHtml = '';
      if (phase === 'hinting') {
        statusHtml = isActive
          ? '<span style="color:var(--green);font-size:13px;font-weight:700">✏️ dran</span>'
          : '<span style="color:var(--text-dim);font-size:12px">warte...</span>';
      } else if (phase === 'voting') {
        statusHtml = p.hasVoted ? '✅' : '⏳';
      }

      // Use textContent for the name to be safe, then set the rest via innerHTML
      row.innerHTML =
        '<div>' +
          '<div class="player-name">' + (idx + 1) + '. ' + esc(p.name) + '</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">' + hintHtml + '</div>' +
        '</div>' +
        '<div>' + statusHtml + '</div>';
      hostPlayersList.appendChild(row);
    });
  }
}

// =========================================
//  PLAYER
// =========================================
function initPlayer() {
  var currentRoom = null;
  var myRole = null;
  var myName = '';
  var myHintsGiven = 0;
  var maxHints = 2;
  var isMyTurn = false;

  // Join form
  var joinSection     = document.getElementById('joinSection');
  var gameArea        = document.getElementById('gameArea');
  var nameInput       = document.getElementById('nameInput');
  var codeInput       = document.getElementById('codeInput');
  var joinBtn         = document.getElementById('joinBtn');
  var joinError       = document.getElementById('joinError');
  var roomCodeDisplay = document.getElementById('roomCodeDisplay');
  var playerCount     = document.getElementById('playerCount');

  // Game sections
  var turnOrderCard      = document.getElementById('turnOrderCard');
  var turnOrderList      = document.getElementById('turnOrderList');
  var hintRoundDisplay   = document.getElementById('hintRoundDisplay');
  var hintRoundTotal     = document.getElementById('hintRoundTotal');
  var lobbyPlayersCard   = document.getElementById('lobbyPlayersCard');
  var lobbyPlayersList   = document.getElementById('lobbyPlayersList');

  var roleSection   = document.getElementById('roleSection');
  var roleCard      = document.getElementById('roleCard');
  var categoryLabel = document.getElementById('categoryLabel');
  var wordDisplay   = document.getElementById('wordDisplay');
  var roleLabel     = document.getElementById('roleLabel');

  var hintSection   = document.getElementById('hintSection');
  var myHintRound   = document.getElementById('myHintRound');
  var myHintsSoFar  = document.getElementById('myHintsSoFar');
  var hintInput     = document.getElementById('hintInput');
  var sendHintBtn   = document.getElementById('sendHintBtn');

  var waitingSection     = document.getElementById('waitingSection');
  var waitingText        = document.getElementById('waitingText');
  var waitingSubtext     = document.getElementById('waitingSubtext');
  var hintsCompleteSection = document.getElementById('hintsCompleteSection');

  var votingSection = document.getElementById('votingSection');
  var voteOptions   = document.getElementById('voteOptions');
  var voteDoneMsg   = document.getElementById('voteDoneMsg');

  var guessSection  = document.getElementById('guessSection');
  var guessInput    = document.getElementById('guessInput');
  var guessInputRow = document.getElementById('guessInputRow');
  var guessBtn      = document.getElementById('guessBtn');
  var guessDoneMsg  = document.getElementById('guessDoneMsg');

  var revealSection      = document.getElementById('revealSection');
  var revealWord         = document.getElementById('revealWord');
  var revealImposterName = document.getElementById('revealImposterName');
  var revealGuessResult  = document.getElementById('revealGuessResult');
  var revealVotes        = document.getElementById('revealVotes');
  var revealPlayers      = document.getElementById('revealPlayers');

  // --- Join ---
  joinBtn.addEventListener('click', doJoin);
  codeInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') doJoin(); });
  codeInput.addEventListener('input', function() { codeInput.value = codeInput.value.toUpperCase(); });

  function doJoin() {
    var name = nameInput.value.trim();
    var code = codeInput.value.toUpperCase().trim();
    if (!name) { showJoinErr('Bitte deinen Namen eingeben'); return; }
    if (!code) { showJoinErr('Bitte den Raumcode eingeben'); return; }
    joinBtn.disabled = true;
    joinBtn.textContent = '...';

    socket.emit('join-room', { code: code, name: name }, function(res) {
      joinBtn.disabled = false;
      joinBtn.textContent = 'Beitreten';
      if (!res || !res.ok) { showJoinErr((res && res.err) ? res.err : 'Fehler'); return; }
      currentRoom = code;
      myName = name;
      joinError.style.display = 'none';
      joinSection.style.display = 'none';
      gameArea.style.display = 'block';
      roomCodeDisplay.textContent = code;
    });
  }

  function showJoinErr(msg) {
    joinError.textContent = msg;
    joinError.style.display = 'block';
  }

  // --- Room state ---
  socket.on('room-state', function(state) {
    if (!state || (currentRoom && state.code !== currentRoom)) return;
    if (state.code) roomCodeDisplay.textContent = state.code;
    playerCount.textContent = state.numPlayers || 0;
    updatePhaseBadge(state.phase);
    if (state.phase === 'lobby') {
      renderLobbyPlayers(state.players || []);
    }
  });

  // --- Turn state: render ordered player list ---
  socket.on('turn-state', function(data) {
    lobbyPlayersCard.style.display = 'none';
    turnOrderCard.style.display = 'block';
    hintRoundDisplay.textContent = data.hintRound;
    hintRoundTotal.textContent = data.totalRounds;

    turnOrderList.innerHTML = '';
    data.turnOrder.forEach(function(p, idx) {
      var isActive = p.name === data.activeName;
      var isMe = p.name === myName;
      var row = document.createElement('div');
      row.className = 'player-row' + (isActive ? ' player-row-active' : '');

      var hintHtml = (p.hints || []).map(function(h) {
        return '<span class="hint-tag">' + esc(h) + '</span>';
      }).join('');

      row.innerHTML =
        '<div style="flex:1">' +
          '<div class="player-name" style="' + (isActive ? 'color:var(--green)' : '') + '">' +
            (idx + 1) + '. ' + esc(p.name) + (isMe ? ' <span style="font-size:12px;opacity:0.6">(du)</span>' : '') +
          '</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">' + hintHtml + '</div>' +
        '</div>' +
        '<div style="font-size:18px">' + (isActive ? '✏️' : '') + '</div>';
      turnOrderList.appendChild(row);
    });

    // Show waiting message if not currently my turn
    if (!isMyTurn && myHintsGiven < maxHints && data.activeName !== myName) {
      hintSection.style.display = 'none';
      waitingSection.style.display = 'block';
      waitingText.textContent = data.activeName + ' gibt gerade einen Hinweis...'; // textContent: safe
      waitingSubtext.textContent = 'Runde ' + data.hintRound + ' von ' + data.totalRounds;
    }
  });

  // --- Your turn ---
  socket.on('your-turn', function(data) {
    if (myHintsGiven >= maxHints) return;
    isMyTurn = true;
    waitingSection.style.display = 'none';
    hintsCompleteSection.style.display = 'none';
    hintSection.style.display = 'block';
    myHintRound.textContent = data.hintRound;
    hintInput.focus();
    showToast('Du bist dran!', 3000);
  });

  // --- Role assigned ---
  socket.on('role-assigned', function(payload) {
    myRole = payload.role;
    maxHints = payload.numHints || 2;
    myHintsGiven = 0;
    isMyTurn = false;
    myHintsSoFar.innerHTML = '';
    hintInput.value = '';

    revealSection.style.display = 'none';
    votingSection.style.display = 'none';
    guessSection.style.display = 'none';
    voteDoneMsg.style.display = 'none';
    guessDoneMsg.style.display = 'none';
    guessBtn.disabled = false;
    guessInput.value = '';
    guessInputRow.style.display = 'flex';
    hintsCompleteSection.style.display = 'none';
    hintSection.style.display = 'none';
    waitingSection.style.display = 'block';
    waitingText.textContent = 'Warte auf die Reihenfolge...';
    waitingSubtext.textContent = '';
    guessInputRow.style.display = 'flex';

    roleSection.style.display = 'block';
    categoryLabel.textContent = payload.category ? 'Kategorie: ' + payload.category : 'Ohne Kategorie';

    if (myRole === 'imposter') {
      wordDisplay.textContent = '???';
      roleCard.classList.add('imposter');
      roleLabel.textContent = 'Du bist der Imposter!';
      roleLabel.className = 'role-label imposter-label';
    } else {
      wordDisplay.textContent = payload.word || '-';
      roleCard.classList.remove('imposter');
      roleLabel.textContent = 'Du kennst das Wort';
      roleLabel.className = 'role-label player-label';
    }
    updatePhaseBadge('hinting');
  });

  // --- Send hint ---
  sendHintBtn.addEventListener('click', doSendHint);
  hintInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') doSendHint(); });

  function doSendHint() {
    var h = hintInput.value.trim();
    if (!h || !isMyTurn) return;
    sendHintBtn.disabled = true;

    socket.emit('send-hint', { code: currentRoom, hint: h }, function(res) {
      sendHintBtn.disabled = false;
      if (res && res.ok) {
        hintInput.value = '';
        myHintsGiven++;
        isMyTurn = false;
        var tag = document.createElement('span');
        tag.className = 'hint-tag';
        tag.textContent = h; // textContent: XSS-safe
        myHintsSoFar.appendChild(tag);
        hintSection.style.display = 'none';
        if (myHintsGiven >= maxHints) {
          hintsCompleteSection.style.display = 'block';
          waitingSection.style.display = 'none';
        } else {
          waitingSection.style.display = 'block';
          waitingText.textContent = 'Warte auf die anderen...';
          waitingSubtext.textContent = '';
        }
        showToast('Hinweis gesendet!');
      } else {
        showToast((res && res.err) ? res.err : 'Fehler', 3000);
      }
    });
  }

  // --- Voting ---
  socket.on('voting-started', function(data) {
    turnOrderCard.style.display = 'none';
    hintSection.style.display = 'none';
    waitingSection.style.display = 'none';
    hintsCompleteSection.style.display = 'none';
    votingSection.style.display = 'block';
    voteDoneMsg.style.display = 'none';
    voteOptions.innerHTML = '';

    (data.players || []).forEach(function(name) {
      if (name === myName) return;
      var btn = document.createElement('button');
      btn.className = 'btn btn-secondary';
      btn.style.cssText = 'width:100%;text-align:left;padding:12px 14px;font-size:15px;margin-bottom:4px';
      btn.textContent = '👤 ' + name; // textContent: XSS-safe
      btn.addEventListener('click', function() {
        socket.emit('submit-vote', { code: currentRoom, voteFor: name }, function(res) {
          if (res && res.ok) {
            voteOptions.querySelectorAll('.btn').forEach(function(b) { b.disabled = true; b.style.opacity = '0.4'; });
            btn.style.opacity = '1';
            btn.style.borderColor = 'var(--green)';
            btn.style.color = 'var(--green)';
            voteDoneMsg.style.display = 'block';
            showToast('Vote abgeschickt!');
          }
        });
      });
      voteOptions.appendChild(btn);
    });

    // Normal players only — imposter gets imposter-vote-phase instead
    updatePhaseBadge('voting');
  });

  // Player is the imposter — only show guess, no vote buttons
  socket.on('imposter-vote-phase', function() {
    turnOrderCard.style.display = 'none';
    hintSection.style.display = 'none';
    waitingSection.style.display = 'none';
    hintsCompleteSection.style.display = 'none';
    votingSection.style.display = 'none'; // no vote buttons for imposter!
    guessSection.style.display = 'block';
    updatePhaseBadge('voting');
    showToast('Du bist der Imposter — rate das Wort!', 3500);
  });

  // --- Guess ---
  guessBtn.addEventListener('click', function() {
    var g = guessInput.value.trim();
    if (!g) return;
    guessBtn.disabled = true;
    socket.emit('submit-guess', { code: currentRoom, guess: g }, function(res) {
      if (res && res.ok) {
        guessInputRow.style.display = 'none';
        guessDoneMsg.style.display = 'block';
        showToast('Tipp abgeschickt!');
      } else {
        guessBtn.disabled = false;
        showToast((res && res.err) ? res.err : 'Fehler', 3000);
      }
    });
  });

  // --- Reveal ---
  socket.on('reveal', function(data) {
    updatePhaseBadge('reveal');
    turnOrderCard.style.display = 'none';
    hintSection.style.display = 'none';
    waitingSection.style.display = 'none';
    hintsCompleteSection.style.display = 'none';
    votingSection.style.display = 'none';
    guessSection.style.display = 'none';
    revealSection.style.display = 'block';

    revealWord.textContent = data.word || '-';
    revealImposterName.textContent = data.imposter ? data.imposter.name : '-';

    if (data.imposterGuess) {
      revealGuessResult.innerHTML = data.imposterGuessCorrect
        ? 'Rateversuch: <span class="guess-correct">&bdquo;' + esc(data.imposterGuess) + '&ldquo; &mdash; RICHTIG!</span>'
        : 'Rateversuch: <span class="guess-wrong">&bdquo;' + esc(data.imposterGuess) + '&ldquo; &mdash; Falsch</span>';
    } else {
      revealGuessResult.textContent = 'Kein Rateversuch abgegeben.';
    }
    renderRevealVotes(data, revealVotes);
    renderRevealPlayers(data, revealPlayers);
  });

  // --- New round ---
  socket.on('new-round', function() {
    roleSection.style.display = 'none';
    hintSection.style.display = 'none';
    waitingSection.style.display = 'none';
    hintsCompleteSection.style.display = 'none';
    votingSection.style.display = 'none';
    guessSection.style.display = 'none';
    revealSection.style.display = 'none';
    turnOrderCard.style.display = 'none';
    lobbyPlayersCard.style.display = 'block';
    // Full reset of all state and inputs
    myRole = null; myHintsGiven = 0; isMyTurn = false;
    guessInput.value = '';
    guessBtn.disabled = false;
    guessInputRow.style.display = 'flex';
    guessDoneMsg.style.display = 'none';
    voteDoneMsg.style.display = 'none';
    voteOptions.innerHTML = '';
    myHintsSoFar.innerHTML = '';
    hintInput.value = '';
    sendHintBtn.disabled = false;
    roleCard.classList.remove('imposter');
    updatePhaseBadge('lobby');
    showToast('🔄 Neue Runde — warte auf den Host');
  });

  socket.on('player-left', function(d) { showToast((d.name || 'Jemand') + ' hat den Raum verlassen'); });
  socket.on('room-closed', function(d) { alert((d && d.reason) ? d.reason : 'Raum geschlossen.'); location.reload(); });

  function renderLobbyPlayers(players) {
    lobbyPlayersList.innerHTML = '';
    if (!players.length) {
      lobbyPlayersList.innerHTML = '<div style="color:var(--text-dim);font-size:13px;text-align:center;padding:10px">Warte auf Spieler...</div>';
      return;
    }
    players.forEach(function(p) {
      var row = document.createElement('div');
      row.className = 'player-row';
      var isMe = p.name === myName;
      // Use textContent-based approach for safety
      var nameEl = document.createElement('div');
      nameEl.className = 'player-name';
      nameEl.textContent = p.name + (isMe ? ' (du)' : '');
      row.appendChild(nameEl);
      lobbyPlayersList.appendChild(row);
    });
  }
}

var ClientApp = { initHost: initHost, initPlayer: initPlayer };
