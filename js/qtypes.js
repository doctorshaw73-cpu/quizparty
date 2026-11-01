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
     sanitizeSubmission(q, raw)          -> the trusted shape for a player's answer, or
                                             null to reject it outright — called by
                                             js/host.js handleAnswer() BEFORE a submission
                                             is ever stored, so a modified/hostile phone
                                             client can't get an out-of-range index, an
                                             oversized string, or a non-numeric value past
                                             the host into scoring/hostReveal()/rendering.
                                             Never trusts the phone's own HTML controls
                                             (maxlength, range min/max, ...) as validation.
     validate(q)                         -> [problem strings], type-specific only
     normalize(q)                        -> cleaned copy for hosting/export
     playerPayload(q, ctx)               -> minimal object broadcast to players
     isCorrect(q, submission)            -> true/false (graded types only)
     hostRender(el, q, media)            -> fills the host's live question body
     hostReveal(el, q, players, media)   -> fills the host's reveal body
     playerControl(el, payload, submit)  -> renders the phone control; submit(data) once
     editorRender(el, q, onChange)       -> renders/wires type-specific editor fields

     Three more are OPTIONAL, only implemented by a type that keeps media
     ids somewhere other than the common `media` object (currently just
     completepicture's per-option images) or needs to send players more
     than the common `media.image`/`image2` (currently also just
     completepicture's option images) — every other type leaves all three
     undefined and js/store.js/host.js/editor.js skip them entirely:
     extraMediaRefs(q)                   -> extra [{id, kind}] for a SANITIZED
                                             question — js/store.js
                                             collectMediaRefs calls this for
                                             IndexedDB GC and export
     rawExtraMediaIds(raw)               -> same, but for RAW untrusted import
                                             JSON — js/store.js
                                             referencedRawMediaIds calls this
                                             so import knows which ids are
                                             safe to decode
     remapExtraMedia(q, raw, idRemap)    -> mutates q in place, filling in the
                                             post-import local ids (mirrors
                                             what remapImportedMedia does for
                                             q.media) — called once by
                                             js/store.js importQuizJson
     buildPlayerCtx(q)                   -> extra async ctx fields merged into
                                             what js/host.js/editor.js resolve
                                             for sendsMediaToPlayer types
   }
   `media` on the host side is { imageUrl, videoUrl, audioUrl } object URLs for
   the question's optional illustrative attachment (see js/host.js renderHostMedia) —
   nothing here sends that attachment to players. The exceptions are
   image-pin and spot-the-difference, which need their image(s) on the phone
   to be usable at all (via ctx.imageDataUrl/image2DataUrl), and
   complete-the-picture, whose answer OPTIONS are themselves images (via
   ctx.optionImages, built by its own buildPlayerCtx above) — all three opt
   in via `sendsMediaToPlayer`. */

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

/* Shared by every tile-choice type (mc/tf/order/poll/scale): a submitted
   tile index must be a real integer strictly within [0, count) — NaN,
   Infinity, strings, objects, negative and out-of-range values are all
   rejected outright (returns null) rather than coerced, since an index has
   no safe "clamped" meaning. */
function safeTileIndex(raw, count) {
  const c = raw && raw.c;
  return Number.isInteger(c) && c >= 0 && c < count ? { c } : null;
}

/* ---------- shared "type an answer, matched against an accepted list"
   behavior — used by typed, scramble, guesssong, and guesssound. Every
   one of these is, underneath, "show the player a text box; match
   case-insensitively against one or more accepted strings"; only what's
   shown on the HOST screen (plain prompt, scrambled letters, or an audio
   clip) actually differs between them. */

function acceptedAnswerSanitize(raw) {
  return {
    accepted: (Array.isArray(raw && raw.accepted) ? raw.accepted : [])
      .slice(0, TYPED_MAX_ACCEPTED).map(a => safeText(a, 100)),
  };
}

function acceptedAnswerValidate(q) {
  return q.accepted.filter(a => a.trim()).length < 1 ? ['needs at least one accepted answer'] : [];
}

function acceptedAnswerNormalize(q) {
  return { ...q, accepted: q.accepted.filter(a => a.trim()) };
}

function acceptedAnswerIsCorrect(q, s) {
  if (!s || typeof s.text !== 'string') return false;
  const norm = s.text.trim().toLowerCase();
  return norm !== '' && q.accepted.some(a => a.trim().toLowerCase() === norm);
}

// 60 matches the phone's own <input maxlength="60"> — never trust that
// control alone, since a modified client can send anything.
function acceptedAnswerSanitizeSubmission(q, raw) {
  return (raw && typeof raw.text === 'string') ? { text: raw.text.trim().slice(0, 60) } : null;
}

// Called as `type.hostReveal(...)`, so `this` resolves to whichever
// registry entry it's shared by — `this.isCorrect` always means that
// entry's own isCorrect, even though this one function body is reused
// across several types.
function acceptedAnswerHostReveal(el, q, players) {
  const rows = players.filter(p => p.submission).map(p => `
    <div class="response-row ${this.isCorrect(q, p.submission) ? 'good' : ''}">${esc(p.name)}: <b>${esc(p.submission.text || '')}</b></div>`).join('');
  el.innerHTML = `<p class="on-dark" style="text-align:center">Accepted: ${q.accepted.map(esc).join(', ')}</p><div class="response-list">${rows || '<p class="muted">No answers submitted.</p>'}</div>`;
}

function acceptedAnswerPlayerControl(el, payload, submit) {
  el.className = 'input-control';
  el.innerHTML = `<input type="text" id="pc-typed" maxlength="60" placeholder="Type your answer…" autocomplete="off">
    <button type="button" class="btn primary big full" id="pc-typed-go">Submit</button>`;
  const send = fireOnce(() => submit({ text: el.querySelector('#pc-typed').value }));
  el.querySelector('#pc-typed-go').addEventListener('click', send);
  el.querySelector('#pc-typed').addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
}

// Renders just the accepted-answer-list editor UI into `el` — callers that
// need more (guesssong/guesssound's clip-length field) append their own
// markup/wiring after calling this.
function acceptedAnswerEditorRender(el, q, onChange) {
  const rows = q.accepted.map(a => ({ text: a }));
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
}

/* Scrambles each word's letters independently (keeping word count/spacing
   visible, same convention as other Kahoot-style word-scramble features) —
   words of length <= 1 are left as-is, and a word that happens to shuffle
   back to itself is reshuffled once (best-effort; not worth looping
   forever over a 2-letter word where that's the only other arrangement). */
function scrambleWords(text) {
  const shuffle = word => {
    const letters = word.split('');
    for (let i = letters.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [letters[i], letters[j]] = [letters[j], letters[i]];
    }
    return letters.join('');
  };
  return text.split(' ').map(word => {
    if (word.length <= 1) return word;
    let scrambled = shuffle(word);
    if (scrambled === word) scrambled = shuffle(word);
    return scrambled;
  }).join(' ');
}

const AUDIO_CLIP_MAX_SEC = 30;

function sanitizeClipSeconds(raw) {
  const n = safeNumber(raw, null);
  return n !== null && Number.isInteger(n) && n >= 1 && n <= AUDIO_CLIP_MAX_SEC ? n : null;
}

// Wires a "▶ Play clip" button's click handler: plays media.audioUrl,
// auto-pausing after audioClipSeconds if set, and disabling the button
// for the clip's duration so it can't be re-triggered mid-playback.
// Shared by makeAudioGuessType and finishlyrics.
function wireClipPlayButton(btn, media, audioClipSeconds) {
  btn.addEventListener('click', () => {
    btn.disabled = true;
    const audio = new Audio(media.audioUrl);
    audio.play().catch(() => {}); // host interaction just happened — a play() rejection here is non-actionable
    if (audioClipSeconds) setTimeout(() => audio.pause(), audioClipSeconds * 1000);
    audio.addEventListener('ended', () => { btn.disabled = false; });
    setTimeout(() => { btn.disabled = false; }, (audioClipSeconds || 9999) * 1000 + 300);
  });
}

/* guesssong/guesssound: identical mechanic (attach an audio clip, players
   type what they heard), differing only in label/icon/placeholder
   wording — a shared factory avoids maintaining two near-duplicate
   registry entries by hand. Audio is REQUIRED, like image-pin requires an
   image: the question is unanswerable without it. */
function makeAudioGuessType(label, icon, prompt) {
  return {
    label, icon, graded: true,
    defaults: () => ({ accepted: [''], audioClipSeconds: null }),
    sanitize: raw => ({ ...acceptedAnswerSanitize(raw), audioClipSeconds: sanitizeClipSeconds(raw && raw.audioClipSeconds) }),
    validate(q) {
      const problems = acceptedAnswerValidate(q);
      if (!q.media || !q.media.audio) problems.push('needs an audio clip uploaded');
      return problems;
    },
    normalize: q => ({ ...acceptedAnswerNormalize(q), audioClipSeconds: q.audioClipSeconds }),
    playerPayload: () => ({}),
    isCorrect: acceptedAnswerIsCorrect,
    sanitizeSubmission: acceptedAnswerSanitizeSubmission,
    hostRender(el, q, media) {
      el.className = '';
      if (!media || !media.audioUrl) { el.innerHTML = `<p class="muted" style="text-align:center">${icon} Audio unavailable.</p>`; return; }
      const clipNote = q.audioClipSeconds ? ` (first ${q.audioClipSeconds}s)` : '';
      el.innerHTML = `<p class="muted" style="text-align:center">${prompt}${clipNote}</p>
        <button type="button" class="btn primary big qh-play-clip">▶ Play clip</button>`;
      wireClipPlayButton(el.querySelector('.qh-play-clip'), media, q.audioClipSeconds);
    },
    hostReveal: acceptedAnswerHostReveal,
    playerControl: acceptedAnswerPlayerControl,
    editorRender(el, q, onChange) {
      acceptedAnswerEditorRender(el, q, onChange);
      const clipRow = document.createElement('div');
      clipRow.className = 'q-opts';
      clipRow.innerHTML = `<label>Clip length in seconds (optional — blank plays the whole file)
        <input type="number" id="qt-clipsec" min="1" max="${AUDIO_CLIP_MAX_SEC}" step="1" value="${q.audioClipSeconds || ''}"></label>`;
      el.appendChild(clipRow);
      el.querySelector('#qt-clipsec').addEventListener('change', e => {
        q.audioClipSeconds = e.target.value === '' ? null : sanitizeClipSeconds(+e.target.value);
        onChange();
      });
    },
  };
}

/* ---------- shared "progressive image reveal" behavior ----------
   Puzzle Piece Reveal, Blurred Picture, Zoomed-In Picture, and Silhouette
   Reveal are all the same mechanic underneath: an attached image,
   obscured, that becomes clear over the course of the question's own
   timer (q.time) — players type a guess the same way as typed/scramble,
   matched against an accepted list. Only what's visually applied to the
   image differs (a CSS filter/transform transition for the three
   filter-based ones, a tile grid for the puzzle one — see puzzlereveal's
   own entry below, which doesn't fit this factory).

   These require hiding the generic host-only media area (#hq-media) for
   the live question: that pipeline (js/media.js resolveMediaUrls/
   mediaHtml, driven generically for every type from js/host.js) would
   otherwise show the SAME image fully clear right next to the obscured
   one, defeating the entire point. It's deliberately left alone again for
   the reveal phase (#hr-media), where showing the real, clear image is
   exactly correct. This is the one place a question type reaches outside
   its own hostRender() container — a pragmatic, narrowly-scoped exception
   kept entirely inside this file, not a js/host.js change. */

function hideGenericHostMedia() {
  const el = document.querySelector('#hq-media');
  if (el) el.innerHTML = '';
}

/* Two nested requestAnimationFrame calls so the browser actually paints
   the STARTING (obscured) style before the transition to the end state is
   triggered — setting both styles in the same tick would just collapse
   into the end state with no visible animation at all. */
function nextPaint(fn) {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

function makeImageRevealType(label, icon, setupReveal) {
  return {
    label, icon, graded: true,
    defaults: () => ({ accepted: [''] }),
    sanitize: acceptedAnswerSanitize,
    validate(q) {
      const problems = acceptedAnswerValidate(q);
      if (!q.media || !q.media.image) problems.push('needs an image uploaded');
      return problems;
    },
    normalize: acceptedAnswerNormalize,
    playerPayload: () => ({}),
    isCorrect: acceptedAnswerIsCorrect,
    sanitizeSubmission: acceptedAnswerSanitizeSubmission,
    hostRender(el, q, media) {
      el.className = '';
      hideGenericHostMedia();
      if (!media || !media.imageUrl) { el.innerHTML = `<p class="muted" style="text-align:center">${icon} Image unavailable.</p>`; return; }
      el.innerHTML = `<div class="reveal-wrap"><img class="reveal-img" src="${media.imageUrl}" alt=""></div>`;
      setupReveal(el.querySelector('.reveal-img'), q.time);
    },
    hostReveal: acceptedAnswerHostReveal,
    playerControl: acceptedAnswerPlayerControl,
    editorRender: acceptedAnswerEditorRender,
  };
}

/* ---------- shared "pick one of up to 4 text-answer tiles" behavior ----------
   used by mc and finishlyrics: both show the answer text on the HOST screen
   and shape-only tiles on the phone, graded by tile index exactly the same
   way; only what else the host screen shows (nothing, vs. a "Play clip"
   button above the tiles) differs between them. */
function mcAnswerValidate(q) {
  const problems = [];
  const filled = q.answers.filter(a => a.text.trim());
  if (filled.length < 2) problems.push('needs at least 2 answers');
  if (!q.answers.some(a => a.correct && a.text.trim())) problems.push('has no correct answer marked');
  return problems;
}
function mcAnswerNormalize(q) { return { ...q, answers: q.answers.filter(a => a.text.trim()) }; }
function mcAnswerPlayerPayload(q) { return { count: q.answers.length }; }
function mcAnswerIsCorrect(q, s) { return !!s && Number.isInteger(s.c) && !!q.answers[s.c] && !!q.answers[s.c].correct; }
function mcAnswerSanitizeSubmission(q, raw) { return safeTileIndex(raw, q.answers.length); }
function mcAnswerHostReveal(el, q, players) {
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
}
function mcAnswerPlayerControl(el, payload, submit) {
  el.className = 'answer-grid player';
  el.innerHTML = tileGridHtml(Array(payload.count).fill(null));
  const send = fireOnce(c => submit({ c }));
  el.addEventListener('click', e => {
    const btn = e.target.closest('button[data-c]');
    if (btn) send(+btn.dataset.c);
  });
}
function mcAnswerEditorRender(el, q, onChange) {
  el.innerHTML = `<div class="rows">${editRowsHtml(q.answers, { shapes: true, checkbox: true, min: 2, placeholder: i => `Answer ${i + 1}${i >= 2 ? ' (optional)' : ''}` })}</div>
    ${q.answers.length < 4 ? '<button type="button" class="btn full" data-act="add">+ Add answer</button>' : ''}
    <p class="muted hint">Tick the checkbox on every correct answer (at least one).</p>`;
  wireEditRows(el, q, 'answers', onChange, { max: 4, checkbox: true });
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

/* ---------- shared "tap the correct spot on an image" behavior ----------
   used by imagepin and spotdifference: both grade a submitted (x,y)
   fraction of the image against a stored correct pin within a tolerance
   radius. Only how many images get shown/sent (one vs. two) differs. */
function pinSanitize(raw) {
  const r = raw || {};
  const p = r.pin || {};
  return {
    pin: { x: clamp(safeNumber(p.x, 0.5), 0, 1), y: clamp(safeNumber(p.y, 0.5), 0, 1) },
    tolerance: clamp(safeNumber(r.tolerance, 0.08), 0.01, 0.5),
  };
}
function pinIsCorrect(q, s) {
  if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y)) return false;
  return Math.hypot(s.x - q.pin.x, s.y - q.pin.y) <= q.tolerance;
}
function pinSanitizeSubmission(q, raw) {
  const x = raw && raw.x, y = raw && raw.y;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
}

const QuestionTypes = {

  /* ================= multiple choice ================= */
  mc: {
    label: 'Multiple choice', icon: '🔘', graded: true,
    defaults: () => ({ answers: [{ text: '', correct: false }, { text: '', correct: false }, { text: '', correct: false }, { text: '', correct: false }] }),
    sanitize: raw => ({ answers: safeRows(raw && raw.answers, { max: 4, maxLen: 100, checkbox: true }) }),
    validate: mcAnswerValidate,
    normalize: mcAnswerNormalize,
    playerPayload: mcAnswerPlayerPayload,
    isCorrect: mcAnswerIsCorrect,
    sanitizeSubmission: mcAnswerSanitizeSubmission,
    hostRender(el, q) { el.innerHTML = tileGridHtml(q.answers.map(a => a.text)); el.className = 'answer-grid'; },
    hostReveal: mcAnswerHostReveal,
    playerControl: mcAnswerPlayerControl,
    editorRender: mcAnswerEditorRender,
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
    sanitizeSubmission: (q, raw) => safeTileIndex(raw, 2),
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
    /* Exact length, every entry a real integer in range, and no duplicates
       (a repeated index would otherwise let a submission dodge ever
       including some other tile while still passing a naive length check). */
    sanitizeSubmission(q, raw) {
      const order = raw && raw.order;
      if (!Array.isArray(order) || order.length !== q.items.length) return null;
      const seen = new Set();
      for (const v of order) {
        if (!Number.isInteger(v) || v < 0 || v >= q.items.length || seen.has(v)) return null;
        seen.add(v);
      }
      return { order: order.slice() };
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
    sanitize: acceptedAnswerSanitize,
    validate: acceptedAnswerValidate,
    normalize: acceptedAnswerNormalize,
    playerPayload: () => ({}),
    isCorrect: acceptedAnswerIsCorrect,
    sanitizeSubmission: acceptedAnswerSanitizeSubmission,
    hostRender(el) { el.className = ''; el.innerHTML = `<p class="muted" style="text-align:center">⌨️ Players are typing their answer on their phones…</p>`; },
    hostReveal: acceptedAnswerHostReveal,
    playerControl: acceptedAnswerPlayerControl,
    editorRender: acceptedAnswerEditorRender,
  },

  /* ================= word scramble ================= */
  scramble: {
    label: 'Word Scramble', icon: '🔤', graded: true,
    defaults: () => ({ accepted: [''] }),
    sanitize: acceptedAnswerSanitize,
    validate: acceptedAnswerValidate,
    normalize: acceptedAnswerNormalize,
    playerPayload: () => ({}),
    isCorrect: acceptedAnswerIsCorrect,
    sanitizeSubmission: acceptedAnswerSanitizeSubmission,
    // Scrambled fresh on every call rather than cached — hostRender is only
    // ever called once per live question (see js/host.js startQuestion),
    // so this never re-shuffles mid-question; the harmless exception is
    // the editor's own live preview, which may re-shuffle as the host
    // types the answer, which is fine since it's not a real game.
    hostRender(el, q) {
      el.className = '';
      const word = (q.accepted[0] || '').trim();
      if (!word) { el.innerHTML = `<p class="muted" style="text-align:center">🔤 Add an accepted answer to scramble.</p>`; return; }
      const scrambled = scrambleWords(word.toUpperCase());
      el.innerHTML = `<p class="muted" style="text-align:center">🔤 Unscramble:</p>
        <div class="scramble-letters">${scrambled.split('').map(ch => ch === ' '
          ? '<span class="scramble-space"></span>'
          : `<span class="scramble-letter">${esc(ch)}</span>`).join('')}</div>`;
    },
    hostReveal: acceptedAnswerHostReveal,
    playerControl: acceptedAnswerPlayerControl,
    editorRender: acceptedAnswerEditorRender,
  },

  /* ================= guess the song ================= */
  guesssong: makeAudioGuessType('Guess the Song', '🎵', '🎵 Players are listening for the song…'),

  /* ================= guess the sound ================= */
  guesssound: makeAudioGuessType('Guess the Sound', '🔊', '🔊 Players are listening for the sound…'),

  /* ================= finish the lyrics ================= */
  // Plays an audio clip (song, paused where the host stops it, same
  // "Play clip" control as guesssong/guesssound) then players choose the
  // next line from up to 4 answer tiles — same text-answer-tile mechanic
  // and grading as mc, just shared via the mcAnswer* helpers above.
  finishlyrics: {
    label: 'Finish the Lyrics', icon: '🎤', graded: true,
    defaults: () => ({
      answers: [{ text: '', correct: false }, { text: '', correct: false }, { text: '', correct: false }, { text: '', correct: false }],
      audioClipSeconds: null,
    }),
    sanitize: raw => ({
      answers: safeRows(raw && raw.answers, { max: 4, maxLen: 100, checkbox: true }),
      audioClipSeconds: sanitizeClipSeconds(raw && raw.audioClipSeconds),
    }),
    validate(q) {
      const problems = mcAnswerValidate(q);
      if (!q.media || !q.media.audio) problems.push('needs an audio clip uploaded');
      return problems;
    },
    normalize: q => ({ ...mcAnswerNormalize(q), audioClipSeconds: q.audioClipSeconds }),
    playerPayload: mcAnswerPlayerPayload,
    isCorrect: mcAnswerIsCorrect,
    sanitizeSubmission: mcAnswerSanitizeSubmission,
    hostRender(el, q, media) {
      el.className = 'answer-grid';
      if (!media || !media.audioUrl) { el.innerHTML = `<p class="muted" style="text-align:center">🎤 Audio unavailable.</p>`; return; }
      const clipNote = q.audioClipSeconds ? ` (first ${q.audioClipSeconds}s)` : '';
      el.innerHTML = `<div class="finishlyrics-clip">
          <button type="button" class="btn primary big qh-play-clip">▶ Play clip${clipNote}</button>
        </div>${tileGridHtml(q.answers.map(a => a.text))}`;
      wireClipPlayButton(el.querySelector('.qh-play-clip'), media, q.audioClipSeconds);
    },
    hostReveal: mcAnswerHostReveal,
    playerControl: mcAnswerPlayerControl,
    editorRender(el, q, onChange) {
      mcAnswerEditorRender(el, q, onChange);
      const clipRow = document.createElement('div');
      clipRow.className = 'q-opts';
      clipRow.innerHTML = `<label>Clip length in seconds (optional — blank plays the whole file)
        <input type="number" id="qt-clipsec" min="1" max="${AUDIO_CLIP_MAX_SEC}" step="1" value="${q.audioClipSeconds || ''}"></label>`;
      el.appendChild(clipRow);
      el.querySelector('#qt-clipsec').addEventListener('change', e => {
        q.audioClipSeconds = e.target.value === '' ? null : sanitizeClipSeconds(+e.target.value);
        onChange();
      });
    },
  },

  /* ================= blurred picture ================= */
  blur: makeImageRevealType('Blurred Picture', '🌫️', (imgEl, seconds) => {
    imgEl.style.filter = 'blur(28px)';
    imgEl.style.transition = `filter ${seconds}s linear`;
    nextPaint(() => { imgEl.style.filter = 'blur(0px)'; });
  }),

  /* ================= zoomed-in picture ================= */
  zoom: makeImageRevealType('Zoomed-In Picture', '🔍', (imgEl, seconds) => {
    imgEl.style.transform = 'scale(3)';
    imgEl.style.transformOrigin = 'center';
    imgEl.style.transition = `transform ${seconds}s linear`;
    nextPaint(() => { imgEl.style.transform = 'scale(1)'; });
  }),

  /* ================= silhouette reveal ================= */
  silhouette: makeImageRevealType('Silhouette Reveal', '🌑', (imgEl, seconds) => {
    imgEl.style.filter = 'brightness(0)';
    imgEl.style.transition = `filter ${seconds}s linear`;
    nextPaint(() => { imgEl.style.filter = 'brightness(1)'; });
  }),

  /* ================= puzzle piece reveal ================= */
  puzzlereveal: {
    label: 'Puzzle Piece Reveal', icon: '🧩', graded: true,
    defaults: () => ({ accepted: [''] }),
    sanitize: acceptedAnswerSanitize,
    validate(q) {
      const problems = acceptedAnswerValidate(q);
      if (!q.media || !q.media.image) problems.push('needs an image uploaded');
      return problems;
    },
    normalize: acceptedAnswerNormalize,
    playerPayload: () => ({}),
    isCorrect: acceptedAnswerIsCorrect,
    sanitizeSubmission: acceptedAnswerSanitizeSubmission,
    // A grid of opaque tiles over the image, each disappearing at its own
    // staggered moment (CSS transition-delay, not a JS timer per tile) so
    // the last tile clears exactly when the question's own timer (q.time)
    // runs out — same "fully revealed right as time's up" pacing as the
    // filter-based reveal types. Tile reveal order is randomized fresh
    // each time hostRender runs (once per live question).
    hostRender(el, q, media) {
      el.className = '';
      hideGenericHostMedia();
      if (!media || !media.imageUrl) { el.innerHTML = `<p class="muted" style="text-align:center">🧩 Image unavailable.</p>`; return; }
      const COLS = 5, ROWS = 4, total = COLS * ROWS;
      const order = Array.from({ length: total }, (_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      el.innerHTML = `<div class="reveal-wrap"><img class="reveal-img" src="${media.imageUrl}" alt="">
        <div class="puzzle-grid" style="grid-template-columns:repeat(${COLS},1fr);grid-template-rows:repeat(${ROWS},1fr)">
          ${Array.from({ length: total }, () => '<div class="puzzle-tile"></div>').join('')}
        </div></div>`;
      const tiles = el.querySelectorAll('.puzzle-tile');
      const perTile = q.time / total;
      order.forEach((tileIndex, revealPos) => {
        tiles[tileIndex].style.transition = 'opacity .3s linear';
        tiles[tileIndex].style.transitionDelay = `${perTile * revealPos}s`;
      });
      nextPaint(() => { tiles.forEach(t => { t.style.opacity = '0'; }); });
    },
    hostReveal: acceptedAnswerHostReveal,
    playerControl: acceptedAnswerPlayerControl,
    editorRender: acceptedAnswerEditorRender,
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
    // A non-finite/non-number value is rejected outright; an in-range-type
    // value outside [min, max] (only reachable by a modified client — a real
    // <input type=range> can't produce one) is clamped into range instead.
    sanitizeSubmission(q, raw) {
      const value = raw && raw.value;
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      return { value: clamp(value, q.min, q.max) };
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
    sanitizeSubmission: (q, raw) => safeTileIndex(raw, q.options.length),
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
    sanitizeSubmission: (q, raw) => safeTileIndex(raw, q.max - q.min + 1),
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
    sanitizeSubmission: (q, raw) => (raw && typeof raw.text === 'string') ? { text: raw.text.trim().slice(0, 24) } : null,
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
    sanitizeSubmission: (q, raw) => (raw && typeof raw.text === 'string') ? { text: raw.text.slice(0, 240) } : null,
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
    sanitize: pinSanitize,
    validate(q) { return (q.media && q.media.image) ? [] : ['needs an image uploaded']; },
    normalize: q => ({ ...q }),
    playerPayload: (q, ctx) => ({ image: ctx.imageDataUrl, tolerance: q.tolerance }),
    isCorrect: pinIsCorrect,
    sanitizeSubmission: pinSanitizeSubmission,
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
        const error = validateMediaFile(file, 'image');
        if (error) { alert(error); e.target.value = ''; return; }
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

  /* ================= spot the difference ================= */
  // Two near-identical images shown side by side; the correct spot (where
  // they differ) is graded exactly like image-pin's single-image pin/
  // tolerance mechanic (shared via pinSanitize/pinIsCorrect/
  // pinSanitizeSubmission) — a tap on EITHER image scores against the
  // same (x,y) fraction, since both images are expected to be the same
  // size/composition. Needs its own upload UI for BOTH images (not the
  // editor's generic single "🖼️ Image" button) so its own live preview
  // stays in sync the instant either one is attached — same self-
  // contained pattern image-pin already uses for its one image.
  spotdifference: {
    label: 'Spot the Difference', icon: '🔎', graded: true, sendsMediaToPlayer: true,
    defaults: () => ({ pin: { x: 0.5, y: 0.5 }, tolerance: 0.08 }),
    sanitize: pinSanitize,
    validate(q) {
      const problems = [];
      if (!q.media || !q.media.image) problems.push('needs a first image uploaded');
      if (!q.media || !q.media.image2) problems.push('needs a second image uploaded');
      return problems;
    },
    normalize: q => ({ ...q }),
    playerPayload: (q, ctx) => ({ image: ctx.imageDataUrl, image2: ctx.image2DataUrl, tolerance: q.tolerance }),
    isCorrect: pinIsCorrect,
    sanitizeSubmission: pinSanitizeSubmission,
    hostRender(el) { el.className = ''; el.innerHTML = `<p class="muted" style="text-align:center">🔎 Players are tapping the difference on their phones…</p>`; },
    hostReveal(el, q, players, media) {
      const dots = players.filter(p => p.submission && Number.isFinite(p.submission.x)).map(p => `
        <div class="pin-dot ${this.isCorrect(q, p.submission) ? 'good' : 'bad'}" style="left:${p.submission.x * 100}%;top:${p.submission.y * 100}%" title="${esc(p.name)}"></div>`).join('');
      const pinOverlay = `<div class="pin-dot correct" style="left:${q.pin.x * 100}%;top:${q.pin.y * 100}%"></div>${dots}`;
      el.innerHTML = (media && media.imageUrl && media.image2Url)
        ? `<div class="spotdiff-wrap">
             <div class="imagepin-wrap"><img src="${media.imageUrl}" alt="">${pinOverlay}</div>
             <div class="imagepin-wrap"><img src="${media.image2Url}" alt="">${pinOverlay}</div>
           </div>`
        : '<p class="muted">Both images are required.</p>';
    },
    playerControl(el, payload, submit) {
      el.className = 'spotdiff-control';
      el.innerHTML = (payload.image && payload.image2)
        ? `<div class="spotdiff-wrap">
             <div class="imagepin-wrap"><img src="${payload.image}" alt=""></div>
             <div class="imagepin-wrap"><img src="${payload.image2}" alt=""></div>
           </div>`
        : '<p class="on-dark">Loading images…</p>';
      const send = fireOnce((x, y) => submit({ x, y }));
      el.querySelectorAll('.imagepin-wrap').forEach(wrap => wrap.addEventListener('click', e => {
        const rect = wrap.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width, y = (e.clientY - rect.top) / rect.height;
        send(x, y);
        el.querySelectorAll('.imagepin-wrap').forEach(w => w.insertAdjacentHTML('beforeend', `<div class="pin-dot good" style="left:${x * 100}%;top:${y * 100}%"></div>`));
      }));
    },
    editorRender(el, q, onChange) {
      el.innerHTML = `
        <label class="muted hint">First image (before)<input type="file" id="qt-img1" accept="image/*"></label>
        <label class="muted hint">Second image (after / changed)<input type="file" id="qt-img2" accept="image/*"></label>
        <div id="qt-imgwrap" class="spotdiff-wrap"></div>
        <label>Tolerance radius <input type="range" id="qt-tol" min="0.02" max="0.3" step="0.01" value="${q.tolerance}"></label>`;
      const renderPreview = async () => {
        const wrap = el.querySelector('#qt-imgwrap');
        if (!q.media.image || !q.media.image2) { wrap.innerHTML = '<p class="muted">Upload both images, then click either one to place the correct pin.</p>'; return; }
        const [url1, url2] = await Promise.all([getMediaUrl(q.media.image), getMediaUrl(q.media.image2)]);
        const pinDot = `<div class="pin-dot correct" style="left:${q.pin.x * 100}%;top:${q.pin.y * 100}%"></div>`;
        wrap.innerHTML = `
          <div class="imagepin-wrap"><img src="${url1}" alt="">${pinDot}</div>
          <div class="imagepin-wrap"><img src="${url2}" alt="">${pinDot}</div>`;
        wrap.querySelectorAll('.imagepin-wrap').forEach(w => w.addEventListener('click', e => {
          const rect = e.currentTarget.getBoundingClientRect();
          q.pin = { x: clamp((e.clientX - rect.left) / rect.width, 0, 1), y: clamp((e.clientY - rect.top) / rect.height, 0, 1) };
          onChange();
          renderPreview();
        }));
      };
      const wireUpload = (inputId, slot) => {
        el.querySelector(inputId).addEventListener('change', async e => {
          const file = e.target.files[0];
          if (!file) return;
          const error = validateMediaFile(file, 'image');
          if (error) { alert(error); e.target.value = ''; return; }
          const oldId = q.media[slot];
          q.media[slot] = await saveMedia(file);
          onChange();
          renderPreview();
          await releaseMediaIfUnused(oldId);
        });
      };
      wireUpload('#qt-img1', 'image');
      wireUpload('#qt-img2', 'image2');
      el.querySelector('#qt-tol').addEventListener('input', e => { q.tolerance = Number(e.target.value); onChange(); });
      renderPreview();
    },
  },

  /* ================= complete the picture ================= */
  // The one type whose answer OPTIONS are themselves images rather than
  // text: the main picture (the common q.media.image slot, shown to the
  // host/player like any other type's illustrative image) plus up to 4
  // candidate "piece" images, graded by tile index exactly like mc. The
  // option images live in their own q.options[].image ids, OUTSIDE the
  // common `media` object — the only type that needs the optional
  // extraMediaRefs/rawExtraMediaIds/remapExtraMedia/buildPlayerCtx hooks
  // (see the registry contract comment at the top of this file) so
  // IndexedDB GC, export/import, and sending them to players all still
  // work through the normal generic machinery.
  completepicture: {
    label: 'Complete the Picture', icon: '🧩', graded: true, sendsMediaToPlayer: true,
    defaults: () => ({ options: [{ image: null, correct: false }, { image: null, correct: false }, { image: null, correct: false }, { image: null, correct: false }] }),
    // Image ids are deliberately left null here, same as media.image/
    // image2 — they're filled in by remapExtraMedia() once import knows
    // which ids are safe (see js/store.js importQuizJson).
    sanitize(raw) {
      const rows = Array.isArray(raw && raw.options) ? raw.options : [];
      return { options: rows.slice(0, 4).map(r => ({ image: null, correct: safeBool(r && r.correct, false) })) };
    },
    validate(q) {
      const problems = [];
      if (!q.media || !q.media.image) problems.push('needs a main image uploaded');
      const filled = (q.options || []).filter(o => o.image);
      if (filled.length < 2) problems.push('needs at least 2 answer-option images');
      if (!filled.some(o => o.correct)) problems.push('has no correct answer-option image marked');
      return problems;
    },
    normalize: q => ({ ...q, options: (q.options || []).filter(o => o.image) }),
    playerPayload: (q, ctx) => ({ image: ctx.imageDataUrl, optionImages: ctx.optionImages }),
    isCorrect: (q, s) => !!s && Number.isInteger(s.c) && !!q.options[s.c] && !!q.options[s.c].correct,
    sanitizeSubmission: (q, raw) => safeTileIndex(raw, q.options.length),
    extraMediaRefs: q => (q.options || []).filter(o => o.image).map(o => ({ id: o.image, kind: 'image' })),
    rawExtraMediaIds: raw => (Array.isArray(raw && raw.options) ? raw.options : []).slice(0, 4)
      .map(r => ({ id: r && r.image, kind: 'image' })).filter(r => typeof r.id === 'string' && r.id),
    remapExtraMedia(q, raw, idRemap) {
      const rawRows = Array.isArray(raw && raw.options) ? raw.options : [];
      q.options.forEach((opt, i) => {
        const oldId = rawRows[i] && rawRows[i].image;
        opt.image = (typeof oldId === 'string' && idRemap[oldId]) ? idRemap[oldId] : null;
      });
    },
    async buildPlayerCtx(q) {
      const optionImages = await Promise.all((q.options || []).map(o => o.image ? mediaToDataUrl(o.image) : null));
      return { optionImages };
    },
    hostRender(el) { el.className = ''; el.innerHTML = `<p class="muted" style="text-align:center">🧩 Players are choosing the missing piece on their phones…</p>`; },
    // Option image URLs aren't in the `media` param (that only covers the
    // common media.image/image2/video/audio slots) — resolved here instead,
    // directly from each option's own stored id, same functions (getMediaUrl)
    // every other type's editorRender already uses for its own previews.
    // Guarded by document.contains(el): the host may have moved on to a
    // different question by the time these (already-local, near-instant)
    // IndexedDB lookups resolve.
    hostReveal(el, q, players) {
      el.innerHTML = '<p class="muted" style="text-align:center">Loading option images…</p>';
      Promise.all((q.options || []).map(o => o.image ? getMediaUrl(o.image) : null)).then(urls => {
        if (!document.contains(el)) return;
        const counts = q.options.map((_, k) => players.filter(p => p.submission && p.submission.c === k).length);
        const max = Math.max(1, ...counts);
        el.innerHTML = `
          <div class="histo">${counts.map((c, k) => `
            <div class="bar-wrap"><span class="bar-count">${c}</span>
              <div class="bar c${k}" style="height:${Math.round(120 * c / max) + 6}px"></div>
              <span class="bar-shape">${SHAPES[k]}${q.options[k].correct ? ' ✓' : ''}</span></div>`).join('')}</div>
          <div class="option-img-grid">${q.options.map((o, k) => `
            <div class="option-img-tile c${k} ${o.correct ? '' : 'faded'}">
              ${urls[k] ? `<img src="${urls[k]}" alt="">` : ''}
              <span class="shape">${SHAPES[k]}</span>${o.correct ? '<span class="mark">✓</span>' : ''}
            </div>`).join('')}</div>`;
      });
    },
    playerControl(el, payload, submit) {
      el.className = 'completepicture-control';
      const mainImg = payload.image ? `<div class="imagepin-wrap" style="cursor:default"><img src="${payload.image}" alt=""></div>` : '';
      const options = (payload.optionImages || []).map((url, k) => `
        <button type="button" class="option-img-tile c${k}" data-c="${k}">
          ${url ? `<img src="${url}" alt="">` : ''}
          <span class="shape">${SHAPES[k]}</span>
        </button>`).join('');
      el.innerHTML = `${mainImg}<div class="option-img-grid player">${options}</div>`;
      const send = fireOnce(c => submit({ c }));
      el.addEventListener('click', e => {
        const btn = e.target.closest('button[data-c]');
        if (btn) send(+btn.dataset.c);
      });
    },
    editorRender(el, q, onChange) {
      el.innerHTML = `<p class="muted hint">Main image: use the "🖼️ Image" button above. Up to 4 candidate "piece" images below — tick the checkbox on every correct one (at least one):</p>
        <div class="rows">${q.options.map((o, i) => `
          <div class="ans-row" data-i="${i}">
            <div class="ans-swatch c${i}">${SHAPES[i]}</div>
            <div class="opt-img-preview" id="opt-preview-${i}"></div>
            <input type="file" accept="image/*" class="opt-img-input" data-i="${i}">
            <input type="checkbox" title="Correct answer" ${o.correct ? 'checked' : ''} class="opt-img-correct" data-i="${i}">
          </div>`).join('')}</div>`;
      const renderPreviews = async () => {
        for (let i = 0; i < q.options.length; i++) {
          const wrap = el.querySelector(`#opt-preview-${i}`);
          if (!wrap) continue;
          wrap.innerHTML = q.options[i].image ? `<img src="${await getMediaUrl(q.options[i].image)}" alt="">` : '<span class="muted">No image</span>';
        }
      };
      el.querySelectorAll('.opt-img-input').forEach(input => {
        input.addEventListener('change', async e => {
          const i = +e.target.dataset.i;
          const file = e.target.files[0];
          if (!file) return;
          const error = validateMediaFile(file, 'image');
          if (error) { alert(error); e.target.value = ''; return; }
          const oldId = q.options[i].image;
          q.options[i].image = await saveMedia(file);
          onChange();
          renderPreviews();
          await releaseMediaIfUnused(oldId);
        });
      });
      el.querySelectorAll('.opt-img-correct').forEach(cb => {
        cb.addEventListener('change', e => {
          q.options[+e.target.dataset.i].correct = e.target.checked;
          onChange();
        });
      });
      renderPreviews();
    },
  },
};

const QUESTION_TYPE_LIST = Object.keys(QuestionTypes);

function questionTypeOf(q) {
  return QuestionTypes[q.type] || QuestionTypes.mc;
}
