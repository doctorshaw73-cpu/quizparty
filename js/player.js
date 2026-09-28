'use strict';

/* Player side: connects to the host peer over WebRTC and turns the phone
   into a Kahoot-style controller. */

const player = {
  peer: null, conn: null, name: '', qIndex: 0, ticker: null, gameOver: false,
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
  if (player.peer) { player.peer.destroy(); player.peer = null; }
  player.conn = null;
  player.gameOver = false;
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

  const peer = new Peer({ debug: 1 });
  player.peer = peer;
  player.name = name;

  const fail = msg => {
    playerTeardown();
    showSub('view-play', 'play-join');
    $('#p-join').disabled = false;
    errEl.textContent = msg;
  };

  peer.on('open', () => {
    const conn = peer.connect(PEER_PREFIX + pin, { reliable: true });
    player.conn = conn;
    conn.on('open', () => conn.send({ t: 'join', name }));
    conn.on('data', d => playerOnMessage(d));
    conn.on('close', () => {
      if (!player.gameOver && player.peer) {
        showSub('view-play', 'play-dropped');
      }
    });
  });
  peer.on('error', err => {
    if (err.type === 'peer-unavailable') fail('Game not found — check the PIN.');
    else fail('Connection failed (' + err.type + '). Are you online?');
  });
}

function playerOnMessage(d) {
  if (!d || typeof d !== 'object') return;
  switch (d.t) {
    case 'welcome':
      $('#p-join').disabled = false;
      $('#pw-name').textContent = d.name;
      showSub('view-play', 'play-wait');
      if (d.inGame) $('#play-wait .muted').textContent = 'Game in progress — you join at the next question!';
      break;

    case 'q': {
      player.qIndex = d.i;
      $('#pq-progress').textContent = `${d.i + 1} / ${d.n}`;
      /* No question/answer text is sent to players — just the shape/color
         tile for each answer index. See the big screen for the question. */
      $('#pq-grid').innerHTML = Array.from({ length: d.count }, (_, k) => `
        <button class="answer-tile c${k}" data-c="${k}">
          <span class="shape">${SHAPES[k]}</span>
        </button>`).join('');
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
      box.classList.remove('good', 'bad');
      box.classList.add(d.gotIt ? 'good' : 'bad');
      $('#pr-verdict').textContent = d.gotIt ? 'Correct! ✔' : (d.answered ? 'Wrong ✘' : 'Too slow ⌛');
      $('#pr-points').textContent = '+' + d.points;
      $('#pr-streak').textContent = d.streak >= 2 ? `🔥 Answer streak: ${d.streak}` : '';
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
      showSub('view-play', 'play-dropped');
      break;
  }
}

function initPlayerEvents() {
  $('#p-join').addEventListener('click', playerJoin);
  $('#p-name').addEventListener('keydown', e => { if (e.key === 'Enter') playerJoin(); });

  $('#pq-grid').addEventListener('click', e => {
    const btn = e.target.closest('button[data-c]');
    if (!btn || !player.conn || !player.conn.open) return;
    player.conn.send({ t: 'a', i: player.qIndex, c: +btn.dataset.c });
    showSub('view-play', 'play-answered');
  });
}
