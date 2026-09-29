'use strict';

/* Player side: connects to the host peer over WebRTC and turns the phone
   into a Kahoot-style controller. Rendering of the actual answer control is
   delegated per question type to js/qtypes.js — this file only handles the
   connection lifecycle and message plumbing. */

const RECONNECT_DELAYS = [1000, 2000, 4000];

function getPlayerId() {
  try {
    let pid = localStorage.getItem('quizparty.playerId');
    if (!pid) { pid = uid(); localStorage.setItem('quizparty.playerId', pid); }
    return pid;
  } catch (e) { return uid(); }  // storage unavailable — still works, just won't survive a reload
}

const player = {
  peer: null, conn: null, name: '', pin: '', pid: getPlayerId(),
  qIndex: 0, ticker: null, gameOver: false, reconnectAttempt: 0, reconnectTimer: null,
};

function playerShowJoinForm(pin) {
  playerTeardown();
  showSub('view-play', 'play-join');
  $('#p-pin').value = (pin || '').replace(/\D/g, '').slice(0, 6);
  $('#p-name').value = $('#p-name').value || '';
  $('#p-join-err').textContent = '';
  setCleanup(playerTeardown);
  ($('#p-pin').value ? $('#p-name') : $('#p-pin')).focus();
}

function playerTeardown() {
  clearInterval(player.ticker);
  clearTimeout(player.reconnectTimer);
  if (player.peer) { player.peer.destroy(); player.peer = null; }
  player.conn = null;
  player.gameOver = false;
  player.reconnectAttempt = 0;
  $('#view-play').querySelectorAll('.psub').forEach(s => s.classList.remove('active'));
}

function playerJoin() {
  const pin = $('#p-pin').value.replace(/\D/g, '');
  const name = $('#p-name').value.trim();
  const errEl = $('#p-join-err');
  if (pin.length !== 6) { errEl.textContent = 'The game PIN is 6 digits.'; return; }
  if (!name) { errEl.textContent = 'Pick a nickname!'; return; }
  errEl.textContent = '';
  $('#p-join').disabled = true;
  player.pin = pin;
  player.name = name;
  player.reconnectAttempt = 0;
  connectToHost();
}

function connectToHost() {
  if (player.peer) player.peer.destroy();  // drop any still-open peer from a previous attempt
  const peer = createTransportPlayerPeer({ debug: 1 });
  player.peer = peer;

  const fail = msg => {
    playerTeardown();
    showSub('view-play', 'play-join');
    $('#p-join').disabled = false;
    $('#p-join-err').textContent = msg;
  };

  peer.on('open', () => {
    const conn = peer.connect(PEER_PREFIX + player.pin, { reliable: true });
    player.conn = conn;
    conn.on('open', () => {
      player.reconnectAttempt = 0;
      conn.send({ t: 'join', name: player.name, pid: player.pid });
    });
    conn.on('data', d => playerOnMessage(d));
    conn.on('close', handleDisconnect);
  });
  peer.on('error', err => {
    if (err.type === 'peer-unavailable') fail('Game not found — check the PIN.');
    else fail('Connection failed (' + err.type + '). Are you online?');
  });
}

/* A dropped connection (wifi hiccup, phone lock) gets a few automatic retries
   — reusing the same persistent pid, so the host restores the player's score
   — before giving up and offering a manual retry. */
function handleDisconnect() {
  if (player.gameOver || !player.peer) return;
  if (player.reconnectAttempt < RECONNECT_DELAYS.length) {
    const delay = RECONNECT_DELAYS[player.reconnectAttempt++];
    showSub('view-play', 'play-reconnecting');
    player.reconnectTimer = setTimeout(() => { if (!player.gameOver) connectToHost(); }, delay);
  } else {
    $('#pd-retry').style.display = '';
    showSub('view-play', 'play-dropped');
  }
}

function playerOnMessage(d) {
  if (!d || typeof d !== 'object') return;
  switch (d.t) {
    /* Sent ahead of a question whose type needs something on the phone
       before it can be answered (currently just image-pin's image). We
       decode it now and ack, so the host's timer — which waits for this ack
       — doesn't start until the image is actually ready to show. */
    case 'preload': {
      const ack = () => { if (player.conn && player.conn.open) player.conn.send({ t: 'ready', i: d.i }); };
      const img = new Image();
      img.src = d.image;
      if (img.decode) img.decode().then(ack).catch(ack);
      else { img.onload = ack; img.onerror = ack; }
      break;
    }

    case 'welcome':
      $('#p-join').disabled = false;
      $('#pw-name').textContent = d.name;
      showSub('view-play', 'play-wait');
      if (d.inGame) $('#play-wait .muted').textContent = 'Game in progress — you join at the next question!';
      break;

    case 'q': {
      player.qIndex = d.i;
      $('#pq-progress').textContent = `${d.i + 1} / ${d.n}`;
      const type = QuestionTypes[d.type] || QuestionTypes.mc;
      const body = $('#pq-body');
      body.innerHTML = '';
      type.playerControl(body, d, submission => {
        if (player.conn && player.conn.open) player.conn.send({ t: 'a', i: player.qIndex, a: submission });
        showSub('view-play', 'play-answered');
      });
      const endAt = Date.now() + d.secs * 1000;
      clearInterval(player.ticker);
      const tick = () => {
        const left = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
        $('#pq-timer').textContent = left;
        if (left <= 0) clearInterval(player.ticker);
      };
      tick();
      player.ticker = setInterval(tick, 250);
      showSub('view-play', 'play-question');
      break;
    }

    case 'reveal': {
      clearInterval(player.ticker);
      const box = $('#play-result');
      box.classList.remove('good', 'bad', 'neutral');
      if (d.graded) {
        box.classList.add(d.gotIt ? 'good' : 'bad');
        $('#pr-verdict').textContent = d.gotIt ? 'Correct! ✔' : (d.answered ? 'Wrong ✘' : 'Too slow ⌛');
        $('#pr-points').textContent = '+' + d.points;
        $('#pr-streak').textContent = d.streak >= 2 ? `🔥 Answer streak: ${d.streak}` : '';
      } else {
        box.classList.add('neutral');
        $('#pr-verdict').textContent = d.answered ? 'Thanks! 🎉' : 'Time’s up ⌛';
        $('#pr-points').textContent = '';
        $('#pr-streak').textContent = '';
      }
      $('#pr-rank').textContent = `You're in ${ordinal(d.rank)} place of ${d.total}`;
      showSub('view-play', 'play-result');
      break;
    }

    case 'end': {
      player.gameOver = true;
      const medal = d.rank === 1 ? '🥇' : d.rank === 2 ? '🥈' : d.rank === 3 ? '🥉' : '🎉';
      $('#pe-medal').textContent = medal;
      $('#pe-rank').textContent = `${ordinal(d.rank)} place, ${player.name}!`;
      $('#pe-score').textContent = `Final score: ${d.score} points`;
      showSub('view-play', 'play-end');
      break;
    }

    case 'kick':
      player.gameOver = true;
      $('#pd-msg').textContent = d.reason || 'You were removed from the game.';
      $('#pd-retry').style.display = 'none';
      showSub('view-play', 'play-dropped');
      break;
  }
}

function initPlayerEvents() {
  $('#p-join').addEventListener('click', playerJoin);
  $('#p-name').addEventListener('keydown', e => { if (e.key === 'Enter') playerJoin(); });

  $('#pd-retry').addEventListener('click', () => {
    player.gameOver = false;
    player.reconnectAttempt = 0;
    connectToHost();
  });
}
