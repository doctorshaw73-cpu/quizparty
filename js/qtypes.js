'use strict';

/* Question-type registry — the one place that knows how each question type
   behaves, so host.js/player.js/editor.js stay generic dispatchers instead
   of growing a nested conditional per feature. Every entry implements the
   same contract:
   {
     label, icon, graded, sendsMediaToPlayer,
     defaults()                          -> type-specific fields for a new question
     sanitize(raw)                       -> type-specific fields rebuilt from untrusted
                                             import JSON using only trusted primitives
                                             (capped counts/lengths, coerced types) —
                                             never a structural clone of `raw`
     validate(q)                         -> [problem strings], type-specific only
     normalize(q)                        -> cleaned copy for hosting/export
     playerPayload(q, ctx)               -> minimal object broadcast to players
     isCorrect(q, submission)            -> true/false (graded types only)
     hostRender(el, q, media)            -> fills the host's live question body
     hostReveal(el, q, players, media)   -> fills the host's reveal body
     playerControl(el, payload, submit)  -> renders the phone control; submit(data) once
     editorRender(el, q, onChange)       -> renders/wires type-specific editor fields
   }
   `media` on the host side is { imageUrl, videoUrl, audioUrl } object URLs for
   the question's optional illustrative attachment (see js/host.js renderHostMedia) —
   nothing here sends that attachment to players. The one exception is
   image-pin, which needs its image on the phone to be usable at all; it opts
   in via `sendsMediaToPlayer` and receives a data: URL through `ctx.imageDataUrl`. */

const ORDER_MAX = 6;
const POLL_MAX = 6;
const SCALE_MAX_POINTS = MAX_TILES;
const TYPED_MAX_ACCEPTED = 10;
const NUMERIC_BOUND = 1e9;   // sane absolute ceiling for imported min/max/step/correct

function tileGridHtml(labels, opts) {
  /* labels: array of strings (host, shows text) or null-per-item (player, shape only) */
  opts = opts || {};
  return labels.map((label, k) => `
    <button type="button" class="answer-tile c${k}" data-c="${k}" ${opts.disabled ? 'disabled' : ''}>
      <span class="shape">${SHAPES[k]}</span>
      ${label != null ? `<span class="atext">${esc(label)}</span>` : ''}
    </button>`).join('');
}

function fireOnce(fn) {
  let done = false;
  return (...args) => { if (done) return; done = true; fn(...args); };
}

/* ---------- shared row editor (answers / options / items / accepted) ---------- */
function editRowsHtml(rows, opts) {
  return rows.map((r, i) => `
    <div class="ans-row" data-i="${i}">
      <div class="ans-swatch c${i}">${opts.shapes ? SHAPES[i] : i + 1}</div>
      <input type="text" maxlength="${opts.maxlen || 100}" placeholder="${opts.placeholder(i)}" value="${esc(r.text)}">
      ${opts.checkbox ? `<input type="checkbox" title="Correct answer" ${r.correct ? 'checked' : ''}>` : ''}
      ${rows.length > opts.min ? '<button type="button" class="btn sm" data-act="rm" title="Remove">✕</button>' : ''}
    </div>`).join('');
}

function wireEditRows(el, q, field, onChange, opts) {
  el.querySelector('.rows').addEventListener('input', e => {
    const row = e.target.closest('.ans-row');
    if (!row) return;
    const item = q[field][+row.dataset.i];
    if (e.target.type === 'text') item.text = e.target.value;
    if (e.target.type === 'checkbox') item.correct = e.target.checked;
    onChange();
  });
  el.querySelector('.rows').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act="rm"]');
    if (!btn) return;
    q[field].splice(+btn.closest('.ans-row').dataset.i, 1);
    onChange(true);
  });
  const addBtn = el.querySelector('[data-act="add"]');
  if (addBtn) addBtn.addEventListener('click', () => {
    if (q[field].length < opts.max) q[field].push(opts.checkbox ? { text: '', correct: false } : { text: '' });
    onChange(true);
  });
}

const QuestionTypes = {

  /* ================= multiple choice ================= */
  mc: {
    label: 'Multiple choice', icon: '🔘', graded: true,
    defaults: () => ({ answers: [{ text: '', correct: false }, { text: '', correct: false }, { text: '', correct: false }, { text: '', correct: false }] }),
    sanitize: raw => ({ answers: safeRows(raw && raw.answers, { max: 4, maxLen: 100, checkbox: true }) }),
    validate(q) {
      const problems = [];
      const filled = q.answers.filter(a => a.text.trim());
      if (filled.length < 2) problems.push('needs at least 2 answers');
      if (!q.answers.some(a => a.correct && a.text.trim())) problems.push('has no correct answer marked');
      return problems;
    },
    normalize: q => ({ ...q, answers: q.answers.filter(a => a.text.trim()) }),
    playerPayload: q => ({ count: q.answers.length }),
    isCorrect: (q, s) => !!s && Number.isInteger(s.c) && !!q.answers[s.c] && !!q.answers[s.c].correct,
    hostRender(el, q) { el.innerHTML = tileGridHtml(q.answers.map(a => a.text)); el.className = 'answer-grid'; },
    hostReveal(el, q, players) {
      const correctSet = new Set(q.answers.map((a, k) => a.correct ? k : -1).filter(k => k >= 0));
      const counts = q.answers.map((_, k) => players.filter(p => p.submission && p.submission.c === k).length);
      const max = Math.max(1, ...counts);
      el.innerHTML = `
        <div class="histo">${counts.map((c, k) => `
          <div class="bar-wrap"><span class="bar-count">${c}</span>
            <div class="bar c${k}" style="height:${Math.round(120 * c / max) + 6}px"></div>
            <span class="bar-shape">${SHAPES[k]}${correctSet.has(k) ? ' ✓' : ''}</span></div>`).join('')}</div>
        <div class="answer-grid">${q.answers.map((a, k) => `
          <div class="answer-tile c${k} ${correctSet.has(k) ? '' : 'faded'}">
            <span class="shape">${SHAPES[k]}</span>${esc(a.text)}${correctSet.has(k) ? '<span class="mark">✓</span>' : ''}
          </div>`).join('')}</div>`;
    },
    playerControl(el, payload, submit) {
      el.className = 'answer-grid player';
      el.innerHTML = tileGridHtml(Array(payload.count).fill(null));
      const send = fireOnce(c => submit({ c }));
      el.addEventListener('click', e => {
        const btn = e.target.closest('button[data-c]');
        if (btn) send(+btn.dataset.c);
      });
    },
    editorRender(el, q, onChange) {
      el.innerHTML = `<div class="rows">${editRowsHtml(q.answers, { shapes: true, checkbox: true, min: 2, placeholder: i => `Answer ${i + 1}${i >= 2 ? ' (optional)' : ''}` })}</div>
        ${q.answers.length < 4 ? '<button type="button" class="btn full" data-act="add">+ Add answer</button>' : ''}
        <p class="muted hint">Tick the checkbox on every correct answer (at least one).</p>`;
      wireEditRows(el, q, 'answers', onChange, { max: 4, checkbox: true });
    },
  },

  /* ================= true / false ================= */
  tf: {
    label: 'True / False', icon: '☑️', graded: true,
    defaults: () => ({ correct: true }),
    sanitize: raw => ({ correct: safeBool(raw && raw.correct, true) }),
    validate: () => [],
    normalize: q => ({ ...q }),
    playerPayload: () => ({}),
    isCorrect: (q, s) => !!s && Number.isInteger(s.c) && (s.c === 0) === !!q.correct,
    hostRender(el, q) {
      el.className = 'answer-grid';
      el.innerHTML = `
        <div class="answer-tile c3"><span class="shape">✓</span>True</div>
        <div class="answer-tile c0"><span class="shape">✗</span>False</div>`;
    },
    hostReveal(el, q, players) {
      const counts = [0, 1].map(k => players.filter(p => p.submission && p.submission.c === k).length);
      const correctIdx = q.correct ? 0 : 1;
      el.innerHTML = `
        <div class="histo">
          <div class="bar-wrap"><span class="bar-count">${counts[0]}</span><div class="bar c3" style="height:${20 + counts[0] * 20}px"></div><span class="bar-shape">✓${correctIdx === 0 ? ' ✓' : ''}</span></div>
          <div class="bar-wrap"><span class="bar-count">${counts[1]}</span><div class="bar c0" style="height:${20 + counts[1] * 20}px"></div><span class="bar-shape">✗${correctIdx === 1 ? ' ✓' : ''}</span></div>
        </div>
        <p class="on-dark" style="text-align:center">Correct answer: <b>${q.correct ? 'True' : 'False'}</b></p>`;
    },
    playerControl(el, payload, submit) {
      el.className = 'answer-grid player';
      el.innerHTML = `
        <button type="button" class="answer-tile c3" data-c="0"><span class="shape">✓</span></button>
        <button type="button" class="answer-tile c0" data-c="1"><span class="shape">✗</span></button>`;
      const send = fireOnce(c => submit({ c }));
      el.addEventListener('click', e => {
        const btn = e.target.closest('button[data-c]');
        if (btn) send(+btn.dataset.c);
      });
    },
    editorRender(el, q, onChange) {
      el.innerHTML = `
        <div class="tf-toggle">
          <button type="button" class="btn ${q.correct ? 'primary' : ''}" data-v="true">True is correct</button>
          <button type="button" class="btn ${!q.correct ? 'danger' : ''}" data-v="false">False is correct</button>
        </div>`;
      el.querySelector('.tf-toggle').addEventListener('click', e => {
        const btn = e.target.closest('button[data-v]');
        if (!btn) return;
        q.correct = btn.dataset.v === 'true';
        onChange(true);
      });
    },
  },

  /* ================= order / sequence ================= */
  order: {
    label: 'Order / puzzle', icon: '🔀', graded: true,
    defaults: () => ({ items: [{ text: '' }, { text: '' }, { text: '' }] }),
    sanitize: raw => ({ items: safeRows(raw && raw.items, { max: ORDER_MAX, maxLen: 100, checkbox: false }) }),
    validate(q) {
      const filled = q.items.filter(it => it.text.trim());
      return filled.length < 2 ? ['needs at least 2 items to order'] : [];
    },
    normalize: q => ({ ...q, items: q.items.filter(it => it.text.trim()) }),
    playerPayload: q => ({ count: q.items.length }),
    isCorrect(q, s) {
      if (!s || !Array.isArray(s.order) || s.order.length !== q.items.length) return false;
      return s.order.every((v, i) => v === i);
    },
    hostRender(el, q) {
      el.className = '';
      el.innerHTML = `<p class="muted" style="text-align:center;margin-bottom:.5rem">Players tap the shapes on their phone in this order:</p>
        <div class="tile-list">${q.items.map((it, k) => `
          <div class="tile-list-row"><span class="shape c${k}">${SHAPES[k]}</span>${esc(it.text)}</div>`).join('')}</div>`;
    },
    hostReveal(el, q, players) {
      const eligible = players.filter(p => p.submission !== null);
      const right = eligible.filter(p => this.isCorrect(q, p.submission)).length;
      el.innerHTML = `
        <div class="tile-list">${q.items.map((it, k) => `
          <div class="tile-list-row"><span class="shape c${k}">${SHAPES[k]}</span>${esc(it.text)}</div>`).join('')}</div>
        <p class="on-dark" style="text-align:center">${right} / ${eligible.length} players got the full order right</p>`;
    },
    playerControl(el, payload, submit) {
      el.className = 'answer-grid player';
      el.innerHTML = tileGridHtml(Array(payload.count).fill(null));
      const order = [];
      const send = fireOnce(() => submit({ order }));
      el.addEventListener('click', e => {
        const btn = e.target.closest('button[data-c]:not(:disabled)');
        if (!btn) return;
        const c = +btn.dataset.c;
        order.push(c);
        btn.disabled = true;
        btn.classList.add('faded');
        btn.querySelector('.shape').textContent = String(order.length);
        if (order.length === payload.count) send();
      });
    },
    editorRender(el, q, onChange) {
      el.innerHTML = `<p class="muted hint">The order you list items in below is the correct order.</p>
        <div class="rows">${editRowsHtml(q.items, { shapes: true, checkbox: false, min: 2, placeholder: i => `Item ${i + 1}` })}</div>
        ${q.items.length < ORDER_MAX ? '<button type="button" class="btn full" data-act="add">+ Add item</button>' : ''}`;
      wireEditRows(el, q, 'items', onChange, { max: ORDER_MAX, checkbox: false });
    },
  },

  /* ================= typed answer ================= */
  typed: {
    label: 'Typed answer', icon: '⌨️', graded: true,
    defaults: () => ({ accepted: [''] }),
    sanitize: raw => ({
      accepted: (Array.isArray(raw && raw.accepted) ? raw.accepted : [])
        .slice(0, TYPED_MAX_ACCEPTED).map(a => safeText(a, 100)),
    }),
    validate(q) {
      return q.accepted.filter(a => a.trim()).length < 1 ? ['needs at least one accepted answer'] : [];
    },
    normalize: q => ({ ...q, accepted: q.accepted.filter(a => a.trim()) }),
    playerPayload: () => ({}),
    isCorrect(q, s) {
      if (!s || typeof s.text !== 'string') return false;
      const norm = s.text.trim().toLowerCase();
      return norm !== '' && q.accepted.some(a => a.trim().toLowerCase() === norm);
    },
    hostRender(el) { el.className = ''; el.innerHTML = `<p class="muted" style="text-align:center">⌨️ Players are typing their answer on their phones…</p>`; },
    hostReveal(el, q, players) {
      const rows = players.filter(p => p.submission).map(p => `
        <div class="response-row ${this.isCorrect(q, p.submission) ? 'good' : ''}">${esc(p.name)}: <b>${esc(p.submission.text || '')}</b></div>`).join('');
      el.innerHTML = `<p class="on-dark" style="text-align:center">Accepted: ${q.accepted.map(esc).join(', ')}</p><div class="response-list">${rows || '<p class="muted">No answers submitted.</p>'}</div>`;
    },
    playerControl(el, payload, submit) {
      el.className = 'input-control';
      el.innerHTML = `<input type="text" id="pc-typed" maxlength="60" placeholder="Type your answer…" autocomplete="off">
        <button type="button" class="btn primary big full" id="pc-typed-go">Submit</button>`;
      const send = fireOnce(() => submit({ text: el.querySelector('#pc-typed').value }));
      el.querySelector('#pc-typed-go').addEventListener('click', send);
      el.querySelector('#pc-typed').addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
    },
    editorRender(el, q, onChange) {
      const rows = q.accepted.map((a, i) => ({ text: a }));
      el.innerHTML = `<p class="muted hint">Accepted answers (case-insensitive, any one matches):</p>
        <div class="rows">${editRowsHtml(rows, { checkbox: false, min: 1, placeholder: i => `Accepted answer ${i + 1}` })}</div>
        <button type="button" class="btn full" data-act="add">+ Add accepted answer</button>`;
      el.querySelector('.rows').addEventListener('input', e => {
        const row = e.target.closest('.ans-row');
        if (row) q.accepted[+row.dataset.i] = e.target.value;
        onChange();
      });
      el.querySelector('.rows').addEventListener('click', e => {
        const btn = e.target.closest('button[data-act="rm"]');
        if (btn) { q.accepted.splice(+btn.closest('.ans-row').dataset.i, 1); onChange(true); }
      });
      el.querySelector('[data-act="add"]').addEventListener('click', () => { q.accepted.push(''); onChange(true); });
    },
  },

  /* ================= slider / numeric ================= */
  slider: {
    label: 'Slider / numeric', icon: '🎚️', graded: true,
    defaults: () => ({ min: 0, max: 100, step: 1, correct: 50 }),
    sanitize(raw) {
      const r = raw || {};
      let min = clamp(safeNumber(r.min, 0), -NUMERIC_BOUND, NUMERIC_BOUND);
      let max = clamp(safeNumber(r.max, 100), -NUMERIC_BOUND, NUMERIC_BOUND);
      if (!(min < max)) { min = 0; max = 100; }  // inverted/equal — fall back to sane defaults
      const step = clamp(Math.abs(safeNumber(r.step, 1)) || 1, 1e-6, NUMERIC_BOUND);
      const correct = clamp(safeNumber(r.correct, (min + max) / 2), min, max);
      return { min, max, step, correct };
    },
    validate(q) {
      const problems = [];
      if (!(q.min < q.max)) problems.push('min must be less than max');
      if (!Number.isFinite(q.correct) || q.correct < q.min || q.correct > q.max) problems.push('correct value must be within min/max');
      return problems;
    },
    normalize: q => ({ ...q }),
    playerPayload: q => ({ min: q.min, max: q.max, step: q.step }),
    isCorrect(q, s) {
      if (!s || !Number.isFinite(s.value)) return false;
      const tol = Math.max(q.step, (q.max - q.min) * 0.03);
      return Math.abs(s.value - q.correct) <= tol;
    },
    hostRender(el, q) { el.className = ''; el.innerHTML = `<p class="muted" style="text-align:center">🎚️ Answer between <b>${q.min}</b> and <b>${q.max}</b></p>`; },
    hostReveal(el, q, players) {
      const vals = players.filter(p => p.submission && Number.isFinite(p.submission.value)).map(p => p.submission.value);
      const avg = vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : '—';
      el.innerHTML = `<p class="on-dark" style="text-align:center">Correct value: <b>${q.correct}</b> · Average guess: <b>${avg}</b> (${vals.length} responses)</p>`;
    },
    playerControl(el, payload, submit) {
      el.className = 'input-control';
      const mid = Math.round((payload.min + payload.max) / 2);
      el.innerHTML = `
        <output id="pc-slider-val">${mid}</output>
        <input type="range" id="pc-slider" min="${payload.min}" max="${payload.max}" step="${payload.step}" value="${mid}">
        <button type="button" class="btn primary big full" id="pc-slider-go">Submit</button>`;
      const range = el.querySelector('#pc-slider'), out = el.querySelector('#pc-slider-val');
      range.addEventListener('input', () => { out.textContent = range.value; });
      el.querySelector('#pc-slider-go').addEventListener('click', fireOnce(() => submit({ value: Number(range.value) })));
    },
    editorRender(el, q, onChange) {
      el.innerHTML = `
        <div class="q-opts">
          <label>Min <input type="number" id="qt-min" value="${q.min}"></label>
          <label>Max <input type="number" id="qt-max" value="${q.max}"></label>
          <label>Step <input type="number" id="qt-step" value="${q.step}" min="0.001" step="0.001"></label>
          <label>Correct value <input type="number" id="qt-correct" value="${q.correct}"></label>
        </div>`;
      const bind = (id, field, parse) => el.querySelector(id).addEventListener('input', e => { q[field] = parse(e.target.value); onChange(); });
      bind('#qt-min', 'min', Number); bind('#qt-max', 'max', Number);
      bind('#qt-step', 'step', Number); bind('#qt-correct', 'correct', Number);
    },
  },

  /* ================= poll (ungraded choice) ================= */
  poll: {
    label: 'Poll', icon: '📊', graded: false,
    defaults: () => ({ options: [{ text: '' }, { text: '' }] }),
    sanitize: raw => ({ options: safeRows(raw && raw.options, { max: POLL_MAX, maxLen: 100, checkbox: false }) }),
    validate(q) {
      return q.options.filter(o => o.text.trim()).length < 2 ? ['needs at least 2 options'] : [];
    },
    normalize: q => ({ ...q, options: q.options.filter(o => o.text.trim()) }),
    playerPayload: q => ({ count: q.options.length }),
    isCorrect: () => null,
    hostRender(el, q) { el.innerHTML = tileGridHtml(q.options.map(o => o.text)); el.className = 'answer-grid'; },
    hostReveal(el, q, players) {
      const counts = q.options.map((_, k) => players.filter(p => p.submission && p.submission.c === k).length);
      const total = Math.max(1, counts.reduce((a, b) => a + b, 0));
      el.innerHTML = `<div class="answer-grid">${q.options.map((o, k) => `
        <div class="answer-tile c${k}"><span class="shape">${SHAPES[k]}</span>${esc(o.text)}
          <span class="mark">${Math.round(100 * counts[k] / total)}%</span></div>`).join('')}</div>`;
    },
    playerControl(el, payload, submit) {
      el.className = 'answer-grid player';
      el.innerHTML = tileGridHtml(Array(payload.count).fill(null));
      const send = fireOnce(c => submit({ c }));
      el.addEventListener('click', e => { const btn = e.target.closest('button[data-c]'); if (btn) send(+btn.dataset.c); });
    },
    editorRender(el, q, onChange) {
      el.innerHTML = `<div class="rows">${editRowsHtml(q.options, { shapes: true, checkbox: false, min: 2, placeholder: i => `Option ${i + 1}` })}</div>
        ${q.options.length < POLL_MAX ? '<button type="button" class="btn full" data-act="add">+ Add option</button>' : ''}`;
      wireEditRows(el, q, 'options', onChange, { max: POLL_MAX, checkbox: false });
    },
  },

  /* ================= scale (rating, ungraded) ================= */
  scale: {
    label: 'Scale', icon: '📈', graded: false,
    defaults: () => ({ min: 1, max: 5, lowLabel: '', highLabel: '' }),
    sanitize(raw) {
      const r = raw || {};
      let min = Math.round(clamp(safeNumber(r.min, 1), -1000, 1000));
      let max = Math.round(clamp(safeNumber(r.max, 5), -1000, 1000));
      if (!(min < max) || (max - min + 1) > SCALE_MAX_POINTS) { min = 1; max = 5; }
      return { min, max, lowLabel: safeText(r.lowLabel, 30), highLabel: safeText(r.highLabel, 30) };
    },
    validate(q) {
      const problems = [];
      if (!(q.min < q.max)) problems.push('min must be less than max');
      if (q.max - q.min + 1 > SCALE_MAX_POINTS) problems.push(`scale can have at most ${SCALE_MAX_POINTS} points`);
      return problems;
    },
    normalize: q => ({ ...q }),
    // `min` rides along so the phone can label its tiles with the real
    // scale values (e.g. 3..7) instead of assuming a 1-based scale.
    playerPayload: q => ({ count: q.max - q.min + 1, min: q.min }),
    isCorrect: () => null,
    hostRender(el, q) {
      el.className = '';
      const n = q.max - q.min + 1;
      el.innerHTML = `
        ${q.lowLabel || q.highLabel ? `<div class="scale-labels"><span>${esc(q.lowLabel)}</span><span>${esc(q.highLabel)}</span></div>` : ''}
        <div class="answer-grid">${Array.from({ length: n }, (_, k) => `
          <div class="answer-tile c${k % MAX_TILES}">${q.min + k}</div>`).join('')}</div>`;
    },
    hostReveal(el, q, players) {
      const n = q.max - q.min + 1;
      const counts = Array.from({ length: n }, (_, k) => players.filter(p => p.submission && p.submission.c === k).length);
      const vals = players.filter(p => p.submission).map(p => q.min + p.submission.c);
      const avg = vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : '—';
      const max = Math.max(1, ...counts);
      el.innerHTML = `<div class="histo">${counts.map((c, k) => `
          <div class="bar-wrap"><span class="bar-count">${c}</span><div class="bar c${k % MAX_TILES}" style="height:${Math.round(120 * c / max) + 6}px"></div><span class="bar-shape">${q.min + k}</span></div>`).join('')}</div>
        <p class="on-dark" style="text-align:center">Average: <b>${avg}</b> (${vals.length} responses)</p>`;
    },
    playerControl(el, payload, submit) {
      el.className = 'answer-grid player';
      const min = Number.isFinite(payload.min) ? payload.min : 1;  // legacy hosts pre-dating this field
      el.innerHTML = Array.from({ length: payload.count }, (_, k) => `
        <button type="button" class="answer-tile c${k % MAX_TILES}" data-c="${k}">${min + k}</button>`).join('');
      const send = fireOnce(c => submit({ c }));
      el.addEventListener('click', e => { const btn = e.target.closest('button[data-c]'); if (btn) send(+btn.dataset.c); });
    },
    editorRender(el, q, onChange) {
      el.innerHTML = `
        <div class="q-opts">
          <label>Min <input type="number" id="qt-min" value="${q.min}"></label>
          <label>Max <input type="number" id="qt-max" value="${q.max}"></label>
        </div>
        <div class="q-opts">
          <label>Low-end label <input type="text" id="qt-low" maxlength="30" value="${esc(q.lowLabel)}"></label>
          <label>High-end label <input type="text" id="qt-high" maxlength="30" value="${esc(q.highLabel)}"></label>
        </div>`;
      el.querySelector('#qt-min').addEventListener('input', e => { q.min = Number(e.target.value); onChange(); });
      el.querySelector('#qt-max').addEventListener('input', e => { q.max = Number(e.target.value); onChange(); });
      el.querySelector('#qt-low').addEventListener('input', e => { q.lowLabel = e.target.value; onChange(); });
      el.querySelector('#qt-high').addEventListener('input', e => { q.highLabel = e.target.value; onChange(); });
    },
  },

  /* ================= word cloud (ungraded, aggregated) ================= */
  wordcloud: {
    label: 'Word cloud', icon: '☁️', graded: false,
    defaults: () => ({}),
    sanitize: () => ({}),
    validate: () => [],
    normalize: q => ({ ...q }),
    playerPayload: () => ({}),
    isCorrect: () => null,
    hostRender(el) { el.className = ''; el.innerHTML = `<p class="muted" style="text-align:center">☁️ Players are submitting a word or short phrase…</p>`; },
    hostReveal(el, q, players) {
      const freq = new Map();
      players.forEach(p => {
        const w = p.submission && String(p.submission.text || '').trim().toLowerCase();
        if (w) freq.set(w, (freq.get(w) || 0) + 1);
      });
      const entries = [...freq.entries()].sort((a, b) => b[1] - a[1]);
      const max = Math.max(1, ...entries.map(e => e[1]));
      el.innerHTML = entries.length
        ? `<div class="wordcloud">${entries.map(([w, c]) => `<span style="font-size:${0.9 + 1.6 * (c / max)}rem">${esc(w)}</span>`).join(' ')}</div>`
        : '<p class="muted" style="text-align:center">No responses submitted.</p>';
    },
    playerControl(el, payload, submit) {
      el.className = 'input-control';
      el.innerHTML = `<input type="text" id="pc-word" maxlength="24" placeholder="One word or short phrase…" autocomplete="off">
        <button type="button" class="btn primary big full" id="pc-word-go">Submit</button>`;
      const send = fireOnce(() => submit({ text: el.querySelector('#pc-word').value }));
      el.querySelector('#pc-word-go').addEventListener('click', send);
      el.querySelector('#pc-word').addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
    },
    editorRender(el) { el.innerHTML = `<p class="muted hint">No extra setup — players each submit one word or short phrase, aggregated into a word cloud.</p>`; },
  },

  /* ================= open-ended (ungraded, listed) ================= */
  open: {
    label: 'Open-ended', icon: '📝', graded: false,
    defaults: () => ({}),
    sanitize: () => ({}),
    validate: () => [],
    normalize: q => ({ ...q }),
    playerPayload: () => ({}),
    isCorrect: () => null,
    hostRender(el) { el.className = ''; el.innerHTML = `<p class="muted" style="text-align:center">📝 Players are writing a response on their phones…</p>`; },
    hostReveal(el, q, players) {
      const rows = players.filter(p => p.submission && p.submission.text).map(p => `
        <div class="response-row"><b>${esc(p.name)}:</b> ${esc(p.submission.text)}</div>`).join('');
      el.innerHTML = `<div class="response-list">${rows || '<p class="muted">No responses submitted.</p>'}</div>`;
    },
    playerControl(el, payload, submit) {
      el.className = 'input-control';
      el.innerHTML = `<textarea id="pc-open" maxlength="240" rows="4" placeholder="Write your response…"></textarea>
        <button type="button" class="btn primary big full" id="pc-open-go">Submit</button>`;
      el.querySelector('#pc-open-go').addEventListener('click', fireOnce(() => submit({ text: el.querySelector('#pc-open').value })));
    },
    editorRender(el) { el.innerHTML = `<p class="muted hint">No extra setup — players each write a free-text response, listed for the host to read out.</p>`; },
  },

  /* ================= image pin / drop-pin ================= */
  imagepin: {
    label: 'Image pin', icon: '📍', graded: true, sendsMediaToPlayer: true,
    defaults: () => ({ pin: { x: 0.5, y: 0.5 }, tolerance: 0.08 }),
    sanitize(raw) {
      const r = raw || {};
      const p = r.pin || {};
      return {
        pin: { x: clamp(safeNumber(p.x, 0.5), 0, 1), y: clamp(safeNumber(p.y, 0.5), 0, 1) },
        tolerance: clamp(safeNumber(r.tolerance, 0.08), 0.01, 0.5),
      };
    },
    validate(q) { return (q.media && q.media.image) ? [] : ['needs an image uploaded']; },
    normalize: q => ({ ...q }),
    playerPayload: (q, ctx) => ({ image: ctx.imageDataUrl, tolerance: q.tolerance }),
    isCorrect(q, s) {
      if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y)) return false;
      return Math.hypot(s.x - q.pin.x, s.y - q.pin.y) <= q.tolerance;
    },
    hostRender(el) { el.className = ''; el.innerHTML = `<p class="muted" style="text-align:center">📍 Players are tapping their guess on their phones…</p>`; },
    hostReveal(el, q, players, media) {
      const dots = players.filter(p => p.submission && Number.isFinite(p.submission.x)).map(p => `
        <div class="pin-dot ${this.isCorrect(q, p.submission) ? 'good' : 'bad'}" style="left:${p.submission.x * 100}%;top:${p.submission.y * 100}%" title="${esc(p.name)}"></div>`).join('');
      el.innerHTML = media && media.imageUrl
        ? `<div class="imagepin-wrap"><img src="${media.imageUrl}" alt="">
             <div class="pin-dot correct" style="left:${q.pin.x * 100}%;top:${q.pin.y * 100}%"></div>${dots}</div>`
        : '<p class="muted">Image unavailable.</p>';
    },
    playerControl(el, payload, submit) {
      el.className = 'imagepin-control';
      el.innerHTML = payload.image ? `<div class="imagepin-wrap"><img src="${payload.image}" alt=""></div>` : '<p class="on-dark">Loading image…</p>';
      const send = fireOnce((x, y) => submit({ x, y }));
      const wrap = el.querySelector('.imagepin-wrap');
      if (wrap) wrap.addEventListener('click', e => {
        const rect = wrap.getBoundingClientRect();
        send((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
        wrap.insertAdjacentHTML('beforeend', `<div class="pin-dot good" style="left:${(e.clientX - rect.left) / rect.width * 100}%;top:${(e.clientY - rect.top) / rect.height * 100}%"></div>`);
      });
    },
    editorRender(el, q, onChange) {
      el.innerHTML = `
        <input type="file" id="qt-img" accept="image/*">
        <div id="qt-imgwrap"></div>
        <label>Tolerance radius <input type="range" id="qt-tol" min="0.02" max="0.3" step="0.01" value="${q.tolerance}"></label>`;
      const renderPreview = async () => {
        const wrap = el.querySelector('#qt-imgwrap');
        if (!q.media.image) { wrap.innerHTML = '<p class="muted">Upload an image, then click it to place the correct pin.</p>'; return; }
        const url = await getMediaUrl(q.media.image);
        wrap.innerHTML = `<div class="imagepin-wrap"><img src="${url}" alt=""><div class="pin-dot correct" style="left:${q.pin.x * 100}%;top:${q.pin.y * 100}%"></div></div>`;
        wrap.querySelector('.imagepin-wrap').addEventListener('click', e => {
          const rect = e.currentTarget.getBoundingClientRect();
          q.pin = { x: clamp((e.clientX - rect.left) / rect.width, 0, 1), y: clamp((e.clientY - rect.top) / rect.height, 0, 1) };
          onChange();
          renderPreview();
        });
      };
      el.querySelector('#qt-img').addEventListener('change', async e => {
        const file = e.target.files[0];
        if (!file) return;
        const oldId = q.media.image;
        q.media.image = await saveMedia(file);
        onChange();
        renderPreview();
        await releaseMediaIfUnused(oldId);
      });
      el.querySelector('#qt-tol').addEventListener('input', e => { q.tolerance = Number(e.target.value); onChange(); });
      renderPreview();
    },
  },
};

const QUESTION_TYPE_LIST = Object.keys(QuestionTypes);

function questionTypeOf(q) {
  return QuestionTypes[q.type] || QuestionTypes.mc;
}
