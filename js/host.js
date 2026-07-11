'use strict';

/* The host's browser IS the game server. It opens a PeerJS peer whose id encodes
   the 6-digit game PIN; players connect directly over WebRTC data channels. */

let hostGame = null;

function startHost(quizId) {
  const stored = getQuiz(quizId);
  if (!stored) { location.hash = 'library'; return; }
  const problems = validateQuiz(stored);
  if (problems.length) {
    alert('Fix this before hosting:\n\n' + problems.join('\n'));
    location.hash = 'editor/' + stored.id;
    return;
  }
  showView('view-host');
  hostGame = new HostGame(normalizeQuiz(stored));
  hostGame.openRoom();
  setCleanup(() => { if (hostGame) { hostGame.destroy(); hostGame = null; } });
}

class HostGame {
  constructor(quiz) {
    this.quiz = quiz;
    this.players = new Map();   // conn.connectionId -> {conn, name, score, streak, choice, answerMs}
    this.qIndex = -1;
    this.phase = 'lobby';
    this.peer = null;
    this.ticker = null;
    this.idTries = 0;
    this.destroyed = false;
  }

  /* ---------- room / connections ---------- */

  openRoom() {
    this.pin = String(Math.floor(100000 + Math.random() * 900000));
    showSub('view-host', 'host-connecting');
    const peer = new Peer(PEER_PREFIX + this.pin, { debug: 1 });
    this.peer = peer;
    peer.on('open', () => this.renderLobby());
    peer.on('connection', conn => this.onConnection(conn));
    peer.on('error', err => {
      if (this.destroyed) return;
      if (err.type === 'unavailable-id' && this.idTries++ < 4) {
        peer.destroy();
        this.openRoom();               // PIN collision — roll a new one
      } else if (err.type === 'peer-unavailable') {
        /* a player vanished mid-handshake; harmless */
      } else {
        this.fatal(`Could not reach the signaling service (${err.type}). Check your internet connection and try again.`);
      }
    });
    peer.on('disconnected', () => {
      if (!this.destroyed) peer.reconnect();  // keep the room joinable
    });
  }

  fatal(msg) {
    $('#host-error-msg').textContent = msg;
    showSub('view-host', 'host-error');
  }

  onConnection(conn) {
    conn.on('data', d => this.onMessage(conn, d));
    conn.on('close', () => {
      if (this.players.delete(conn.connectionId)) {
        if (this.phase === 'lobby') this.renderPlayerChips();
        if (this.phase === 'question') this.checkAllAnswered();
      }
    });
  }

  onMessage(conn, d) {
    if (!d || typeof d !== 'object') return;
    if (d.t === 'join') this.handleJoin(conn, d);
    else if (d.t === 'a') this.handleAnswer(conn, d);
  }

  handleJoin(conn, d) {
    let name = String(d.name || '').trim().slice(0, 20);
    if (!name) { conn.send({ t: 'kick', reason: 'Please pick a nickname.' }); return; }
    const taken = new Set([...this.players.values()].map(p => p.name.toLowerCase()));
    let final = name, n = 2;
    while (taken.has(final.toLowerCase())) final = `${name.slice(0, 17)} ${n++}`;
    this.players.set(conn.connectionId, {
      conn, name: final, score: 0, streak: 0, choice: null, answerMs: 0, joinedAtQ: this.qIndex,
    });
    conn.send({ t: 'welcome', name: final, inGame: this.phase !== 'lobby' });
    if (this.phase === 'lobby') this.renderPlayerChips();
  }

  handleAnswer(conn, d) {
    const p = this.players.get(conn.connectionId);
    if (!p || this.phase !== 'question' || d.i !== this.qIndex) return;
    if (p.choice !== null || p.joinedAtQ === this.qIndex) return;  // already answered / joined mid-question
    const choice = Number(d.c);
    if (!Number.isInteger(choice) || choice < 0 || choice >= this.question().answers.length) return;
    p.choice = choice;
    p.answerMs = Date.now() - this.qStartedAt;
    $('#hq-answered').textContent = this.answeredCount();
    this.checkAllAnswered();
  }

  broadcast(msg) {
    for (const p of this.players.values()) {
      if (p.conn.open) p.conn.send(msg);
    }
  }

  question() { return this.quiz.questions[this.qIndex]; }
  answeredCount() { return [...this.players.values()].filter(p => p.choice !== null).length; }

  checkAllAnswered() {
    const eligible = [...this.players.values()].filter(p => p.joinedAtQ !== this.qIndex);
    if (eligible.length && eligible.every(p => p.choice !== null)) this.endQuestion();
  }

  /* ---------- lobby ---------- */

  renderLobby() {
    this.phase = 'lobby';
    showSub('view-host', 'host-lobby');
    $('#h-pin').textContent = this.pin;
    $('#h-quiz-title').textContent = this.quiz.title;
    $('#h-url').textContent = location.host + location.pathname.replace(/index\.html$/, '');
    const qr = qrcode(0, 'M');
    qr.addData(joinUrl(this.pin));
    qr.make();
    $('#h-qr').innerHTML = qr.createSvgTag({ cellSize: 3, margin: 2 });
    this.renderPlayerChips();

    $('#h-start').onclick = () => this.startQuestion(0);
    $('#h-players').onclick = e => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const p = this.players.get(chip.dataset.id);
      if (p && confirm(`Remove ${p.name}?`)) {
        p.conn.send({ t: 'kick', reason: 'The host removed you from the game.' });
        setTimeout(() => p.conn.close(), 200);
        this.players.delete(chip.dataset.id);
        this.renderPlayerChips();
      }
    };
  }

  renderPlayerChips() {
    const chips = [...this.players.entries()]
      .map(([id, p]) => `<span class="chip" data-id="${id}">${esc(p.name)}</span>`).join('');
    $('#h-players').innerHTML = chips;
    $('#h-count').textContent = this.players.size;
    $('#h-start').disabled = this.players.size === 0;
  }

  /* ---------- question flow ---------- */

  startQuestion(i) {
    this.qIndex = i;
    this.phase = 'question';
    const q = this.question();
    for (const p of this.players.values()) {
      p.choice = null;
      p.answerMs = 0;
      if (p.joinedAtQ >= i) p.joinedAtQ = i - 1;   // never exclude players from future questions
    }
    /* players who joined during the lobby are eligible immediately */
    if (i === 0) for (const p of this.players.values()) p.joinedAtQ = -1;

    this.qStartedAt = Date.now();
    this.broadcast({
      t: 'q', i, n: this.quiz.questions.length,
      text: q.text, answers: q.answers.map(a => a.text), secs: q.time,
    });

    showSub('view-host', 'host-question');
    $('#hq-progress').textContent = `Question ${i + 1} of ${this.quiz.questions.length}`;
    $('#hq-text').textContent = q.text;
    $('#hq-answered').textContent = '0';
    $('#hq-grid').innerHTML = q.answers.map((a, k) => `
      <div class="answer-tile c${k}"><span class="shape">${SHAPES[k]}</span>${esc(a.text)}</div>`).join('');
    $('#hq-skip').onclick = () => this.endQuestion();

    const timerEl = $('#hq-timer');
    const endAt = this.qStartedAt + q.time * 1000;
    const tick = () => {
      const left = Math.max(0, endAt - Date.now());
      timerEl.textContent = Math.ceil(left / 1000);
      timerEl.classList.toggle('low', left < 5100);
      if (left <= 0) this.endQuestion();
    };
    tick();
    this.ticker = setInterval(tick, 100);
  }

  endQuestion() {
    if (this.phase !== 'question') return;
    this.phase = 'reveal';
    clearInterval(this.ticker);

    const q = this.question();
    const correctSet = new Set(q.answers.map((a, k) => a.correct ? k : -1).filter(k => k >= 0));
    const timeMs = q.time * 1000;
    const mult = q.points === 'double' ? 2 : q.points === 'none' ? 0 : 1;

    for (const p of this.players.values()) {
      const gotIt = p.choice !== null && correctSet.has(p.choice);
      let pts = 0;
      if (gotIt) {
        p.streak++;
        const speed = 1 - Math.min(p.answerMs, timeMs) / timeMs / 2;  // Kahoot-style: 500–1000 base
        pts = Math.round(1000 * speed) * mult;
        pts += Math.min(p.streak - 1, 5) * 100 * (mult ? 1 : 0);      // streak bonus
      } else {
        p.streak = 0;
      }
      p.lastPts = pts;
      p.lastGotIt = gotIt;
      p.score += pts;
    }

    const ranked = this.ranking();
    for (const p of this.players.values()) {
      if (!p.conn.open) continue;
      p.conn.send({
        t: 'reveal',
        gotIt: p.lastGotIt,
        answered: p.choice !== null,
        points: p.lastPts,
        score: p.score,
        streak: p.streak,
        rank: ranked.indexOf(p) + 1,
        total: ranked.length,
      });
    }

    /* host reveal screen: histogram + correct answers */
    const counts = q.answers.map((_, k) => [...this.players.values()].filter(p => p.choice === k).length);
    const max = Math.max(1, ...counts);
    $('#hr-text').textContent = q.text;
    $('#hr-histo').innerHTML = counts.map((c, k) => `
      <div class="bar-wrap">
        <span class="bar-count">${c}</span>
        <div class="bar c${k}" style="height:${Math.round(120 * c / max) + 6}px"></div>
        <span class="bar-shape">${SHAPES[k]}${correctSet.has(k) ? ' ✓' : ''}</span>
      </div>`).join('');
    $('#hr-grid').innerHTML = q.answers.map((a, k) => `
      <div class="answer-tile c${k} ${correctSet.has(k) ? '' : 'faded'}">
        <span class="shape">${SHAPES[k]}</span>${esc(a.text)}
        ${correctSet.has(k) ? '<span class="mark">✓</span>' : ''}
      </div>`).join('');
    showSub('view-host', 'host-reveal');

    const last = this.qIndex === this.quiz.questions.length - 1;
    $('#hr-next').textContent = last ? 'Podium 🏆' : 'Scoreboard';
    $('#hr-next').onclick = () => last ? this.showPodium() : this.showScoreboard();
  }

  ranking() {
    return [...this.players.values()].sort((a, b) => b.score - a.score);
  }

  showScoreboard() {
    this.phase = 'board';
    const ranked = this.ranking().slice(0, 5);
    $('#hb-rows').innerHTML = ranked.map((p, i) => `
      <div class="board-row ${i === 0 ? 'gold' : ''}">
        <span class="rank">${i + 1}</span><span class="name">${esc(p.name)}</span>
        <span class="pts">${p.score}</span>
      </div>`).join('');
    showSub('view-host', 'host-board');
    $('#hb-next').onclick = () => this.startQuestion(this.qIndex + 1);
  }

  showPodium() {
    this.phase = 'end';
    const ranked = this.ranking();
    for (const p of ranked) {
      if (p.conn.open) p.conn.send({
        t: 'end', rank: ranked.indexOf(p) + 1, total: ranked.length, score: p.score,
      });
    }
    const step = (p, cls, place) => p ? `
      <div class="step ${cls}">
        <span class="p-name">${esc(p.name)}</span>
        <span class="p-pts">${p.score}</span>
        <div class="block">${place}</div>
      </div>` : '';
    $('#hp-podium').innerHTML =
      step(ranked[1], 's2', '2') + step(ranked[0], 's1', '1') + step(ranked[2], 's3', '3');
    $('#hp-rest').innerHTML = ranked.slice(3).map((p, i) => `
      <div class="board-row">
        <span class="rank">${i + 4}</span><span class="name">${esc(p.name)}</span>
        <span class="pts">${p.score}</span>
      </div>`).join('');
    showSub('view-host', 'host-podium');
    $('#hp-again').onclick = () => {
      for (const p of this.players.values()) { p.score = 0; p.streak = 0; }
      this.qIndex = -1;
      this.renderLobby();
    };
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this.ticker);
    if (this.peer) this.peer.destroy();
  }
}
