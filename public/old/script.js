const socket = io();

const login = document.getElementById('login');
const game = document.getElementById('game');

const nameInput = document.getElementById('nameInput');
const joinBtn = document.getElementById('joinBtn');

const playerList = document.getElementById('playerList');
const wordInput = document.getElementById('wordInput');
const startBtn = document.getElementById('startBtn');
const yourWord = document.getElementById('yourWord');

joinBtn.onclick = () => {
    const name = nameInput.value.trim();
    if (!name) return;
    socket.emit('joinGame', name);
    login.classList.add('hidden');
    game.classList.remove('hidden');
};

socket.on('playerList', (players) => {
    playerList.innerHTML = '';
    players.forEach(p => {
        const li = document.createElement('li');
        li.textContent = p.name;
        playerList.appendChild(li);
    });
});

startBtn.onclick = () => {
    const word = wordInput.value.trim();
    if (word) socket.emit('setWord', word);
};

socket.on('wordAssigned', (data) => {
    if (data.isImpostor) {
        yourWord.textContent = "Du bist der IMPOSTOR 🤫";
    } else {
        yourWord.textContent = "Dein Wort: " + data.word;
    }
});
