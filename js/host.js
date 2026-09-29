'use strict';

/* The host's browser IS the game server. It opens a PeerJS peer whose id encodes
   the 6-digit game PIN; players connect directly over WebRTC data channels.
   Question-type-specific behavior (scoring, rendering, player payloads) is
   delegated to js/qtypes.js — this file just drives the game's phases. */

let hostGame = null;

/* How long the host waits for every eligible phone to acknowledge a
   required preload (currently just image-pin's image) before starting the
   question anyway — long enough for a slow decode, short enough that one
   broken device can't stall the room. Overridable per-instance (see
   HostGame.preloadTimeoutMs) so tests don't have to wait for real timeouts. */
const PRELOAD_TIMEOUT_MS = 6000;

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
    this.players = new Map();   // conn.connectionId -> player state (active connections)
    this.roster = new Map();    // pid -> player state (persists across a reconnect)
    this.qIndex = -1;
    this.phase = 'lobby';
    this.peer = null;
    this.ticker = null;
    this.idTries = 0;
    this.destroyed = false;
    this.preloadTimeoutMs = PRELOAD_TIMEOUT_MS;
    this.pendingReady = null;  // { qIndex, pending: Set<connectionId>, resolve }
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
      this.removeFromPendingReady(conn.connectionId);
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
    else if (d.t === 'ready') this.handleReady(conn, d);
  }

  /* ---------- content preload (e.g. image-pin's image) ---------- */

  /* A connection that's gone (real disconnect, or superseded by a
     reconnect) can never send its 'ready' ack — drop it from whatever
     preload wait is active so it can't stall the game until the timeout. */
  removeFromPendingReady(connId) {
    const pr = this.pendingReady;
    if (pr && pr.pending.delete(connId) && pr.pending.size === 0) pr.resolve();
  }

  handleReady(conn, d) {
    const pr = this.pendingReady;
    if (!pr || d.i !== pr.qIndex) return;  // stale ack for a question we've moved past — ignore
    pr.pending.delete(conn.connectionId);
    if (pr.pending.size === 0) pr.resolve();
  }

  /* Resolves once every connectionId in `connIds` has ack'd question `i`,
     or after this.preloadTimeoutMs, whichever comes first. */
  waitForReady(i, connIds) {
    if (!connIds.length) return Promise.resolve();
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        this.pendingReady = null;
        resolve();
      };
      const timer = setTimeout(finish, this.preloadTimeoutMs);
      this.pendingReady = { qIndex: i, pending: new Set(connIds), resolve: finish };
    });
  }

  handleJoin(conn, d) {
    let name = String(d.name || '').trim().slice(0, 20);
    if (!name) { conn.send({ t: 'kick', reason: 'Please pick a nickname.' }); return; }
    const pid = d.pid ? String(d.pid).slice(0, 40) : null;
    const taken = new Set([...this.players.values()].map(p => p.name.toLowerCase()));
    let final = name, n = 2;
    while (taken.has(final.toLowerCase())) final = `${name.slice(0, 17)} ${n++}`;

    /* A known pid reconnecting mid-game gets its score/streak back — it's
       treated as a fresh join for the *current* question only (there's no
       mid-question resume of remaining time/state), but nothing earned is
       lost. See README "Known limitations". */
    let state = pid && this.roster.get(pid);
    if (state) {
      /* One pid must never have more than one live entry in this.players —
         if the old connection is still sitting in the map (it hasn't fired
         'close' yet, or never will on a half-dead network path), drop it
         now and close it. Its own close handler is keyed by *its*
         connectionId, so it can't later delete the new entry we're about
         to install. */
      for (const [connId, p] of this.players) {
        if (p !== state) continue;
        this.players.delete(connId);
        this.removeFromPendingReady(connId);
        if (p.conn && p.conn !== conn && p.conn.open) {
          try { p.conn.close(); } catch (e) { /* already gone — fine */ }
        }
      }
      state.conn = conn;
      state.name = final;
      state.submission = null;
      state.answerMs = 0;
      state.joinedAtQ = this.qIndex;
    } else {
      state = { conn, pid, name: final, score: 0, streak: 0, submission: null, answerMs: 0, joinedAtQ: this.qIndex };
      if (pid) this.roster.set(pid, state);
    }
    this.players.set(conn.connectionId, state);
    conn.send({ t: 'welcome', name: final, inGame: this.phase !== 'lobby' });
    if (this.phase === 'lobby') this.renderPlayerChips();
  }

  handleAnswer(conn, d) {
    const p = this.players.get(conn.connectionId);
    if (!p || this.phase !== 'question' || d.i !== this.qIndex) return;
    if (p.submission !== null || p.joinedAtQ === this.qIndex) return;  // already answered / joined mid-question

    /* The phone's own HTML controls (maxlength, range min/max, a disabled
       button) are not validation — a modified client can send anything.
       Every submission is rebuilt into a trusted shape by the question
       type itself before it's ever stored; a submission that can't be made
       safe is rejected outright and simply isn't recorded (the player can
       still answer again until time runs out). */
    const q = this.question();
    const type = questionTypeOf(q);
    let submission = null;
    try { submission = type.sanitizeSubmission ? type.sanitizeSubmission(q, d.a) : null; }
    catch (e) { submission = null; }
    if (!submission || typeof submission !== 'object') return;

    p.submission = submission;
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
  answeredCount() { return [...this.players.values()].filter(p => p.submission !== null).length; }

  checkAllAnswered() {
    const eligible = [...this.players.values()].filter(p => p.joinedAtQ !== this.qIndex);
    if (eligible.length && eligible.every(p => p.submission !== null)) this.endQuestion();
  }

  /* ---------- media ---------- */

  /* The only media ever sent to a player: image-pin's target image, which
     the phone can't do anything useful without. Every other question type
     keeps its media host-only (see js/media.js resolveMediaUrls/mediaHtml,
     shared with the editor's live preview). */
  async resolvePlayerCtx(q, type) {
    if (!type.sendsMediaToPlayer) return {};
    const imageDataUrl = q.media && q.media.image ? await mediaToDataUrl(q.media.image) : null;
    return { imageDataUrl };
  }

  renderHostMedia(elId, media) {
    $('#' + elId).innerHTML = mediaHtml(media);
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
        if (p.pid) this.roster.delete(p.pid);
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

  async startQuestion(i) {
    this.qIndex = i;
    this.phase = 'question';
    const q = this.question();
    const type = questionTypeOf(q);
    for (const p of this.players.values()) {
      p.submission = null;
      p.answerMs = 0;
      if (p.joinedAtQ >= i) p.joinedAtQ = i - 1;   // never exclude players from future questions
    }
    /* players who joined during the lobby are eligible immediately */
    if (i === 0) for (const p of this.players.values()) p.joinedAtQ = -1;

    /* Resolve media/player-context *before* the clock starts — a large
       image-pin image can take a moment to base64-encode, and none of that
       should eat into the player's answer time. qStartedAt is only set once
       everything needed to actually show and answer the question is ready. */
    const [hostMedia, playerCtx] = await Promise.all([resolveMediaUrls(q.media), this.resolvePlayerCtx(q, type)]);
    if (this.destroyed || this.qIndex !== i) return;  // torn down / skipped while media resolved

    /* Content a phone must have before it can answer at all (currently just
       image-pin's target image) is sent ahead of the timed question and
       acknowledged before the clock starts — otherwise a slow transfer/
       decode over the data channel would eat into the player's answer time
       exactly like the media-resolve delay above. Question types with
       nothing required on the phone (the vast majority) skip this
       entirely, so they incur no extra wait. */
    if (type.sendsMediaToPlayer && playerCtx.imageDataUrl) {
      const eligible = [...this.players.entries()].filter(([, p]) => p.joinedAtQ !== i && p.conn.open);
      for (const [, p] of eligible) p.conn.send({ t: 'preload', i, image: playerCtx.imageDataUrl });
      await this.waitForReady(i, eligible.map(([connId]) => connId));
      if (this.destroyed || this.qIndex !== i) return;  // torn down / skipped while waiting
    }

    this.qStartedAt = Date.now();
    this.broadcast({
      t: 'q', i, n: this.quiz.questions.length, secs: q.time, type: q.type,
      ...type.playerPayload(q, playerCtx),
    });

    showSub('view-host', 'host-question');
    $('#hq-progress').textContent = `Question ${i + 1} of ${this.quiz.questions.length}`;
    $('#hq-text').textContent = q.text;
    this.renderHostMedia('hq-media', hostMedia);
    $('#hq-answered').textContent = '0';
    type.hostRender($('#hq-body'), q, hostMedia);
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

  async endQuestion() {
    if (this.phase !== 'question') return;
    this.phase = 'reveal';
    clearInterval(this.ticker);
    const qIndexAtCall = this.qIndex;

    const q = this.question();
    const type = questionTypeOf(q);
    const timeMs = q.time * 1000;
    const mult = q.points === 'double' ? 2 : q.points === 'none' ? 0 : 1;

    for (const p of this.players.values()) {
      let gotIt = null, pts = 0;
      if (type.graded) {
        let correct = false;
        try { correct = p.submission !== null && !!type.isCorrect(q, p.submission); }
        catch (e) { correct = false; }
        gotIt = correct;
        if (correct) {
          p.streak++;
          const speed = 1 - Math.min(p.answerMs, timeMs) / timeMs / 2;  // Kahoot-style: 500–1000 base
          pts = Math.round(1000 * speed) * mult;
          pts += Math.min(p.streak - 1, 5) * 100 * (mult ? 1 : 0);      // streak bonus
        } else {
          p.streak = 0;
        }
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
        graded: type.graded,
        gotIt: p.lastGotIt,
        answered: p.submission !== null,
        points: p.lastPts,
        score: p.score,
        streak: p.streak,
        rank: ranked.indexOf(p) + 1,
        total: ranked.length,
      });
    }

    $('#hr-text').textContent = q.text;
    const media = await resolveMediaUrls(q.media);
    if (this.destroyed || this.qIndex !== qIndexAtCall) return;
    this.renderHostMedia('hr-media', media);
    type.hostReveal($('#hr-body'), q, [...this.players.values()], media);
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
      const all = new Set([...this.players.values(), ...this.roster.values()]);
      for (const p of all) { p.score = 0; p.streak = 0; }
      this.qIndex = -1;
      this.renderLobby();
    };
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this.ticker);
    if (this.pendingReady) this.pendingReady.resolve();
    if (this.peer) this.peer.destroy();
  }
}
