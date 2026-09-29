'use strict';

/* Lightweight, dependency-free tests for the pure logic in js/util.js,
   js/qtypes.js and js/store.js — question validation/normalization,
   per-type correctness checks, and quiz storage/migration. Run with:
     node test/run-tests.js
   These load the actual browser scripts into a small sandbox (with a fake
   localStorage) rather than reimplementing the logic, so they exercise the
   real code the app ships. DOM-only paths (host/player rendering, media
   upload, PeerJS networking) aren't covered here — see the manual
   host+player smoke test in the PR description for those. */

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

function makeLocalStorage() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    clear: () => map.clear(),
  };
}

/* Top-level `const`/`class` in a classic script (browser or vm.runInContext)
   share the realm's global lexical scope but are NOT mirrored onto the
   global object — same reason `window.SHAPES` is undefined in a real
   browser even though bare `SHAPES` resolves everywhere. A `var` bridge
   evaluated last captures those bindings back out as real properties.
   Plain `function`/`var` declarations (saveMediaFromDataUrl, fetch stubs,
   etc.) DO attach to the global object directly, which is what lets tests
   override them on `.ctx` after loading — see loadSandbox(). */
const EXPORTED_NAMES = [
  'QuestionTypes', 'QUESTION_TYPE_LIST', 'questionTypeOf', 'MAX_TILES', 'SHAPES', 'esc', 'clamp', 'uid',
  'safeText', 'safeBool', 'safeNumber', 'safeRows',
  'ORDER_MAX', 'POLL_MAX', 'SCALE_MAX_POINTS', 'TYPED_MAX_ACCEPTED',
  'validateQuiz', 'normalizeQuiz', 'blankQuestion', 'retypeQuestion', 'migrateQuiz', 'sanitizeQuestion',
  'getQuizzes', 'saveQuizzes', 'getQuiz', 'upsertQuiz', 'deleteQuiz', 'newQuiz', 'emptyMedia', 'collectMediaIds',
  'importQuizJson', 'exportQuiz', 'referencedRawMediaIds', 'importMedia', 'remapImportedMedia', 'MAX_IMPORT_QUESTIONS',
  'isMediaReferenced', 'releaseMediaIfUnused', 'releaseUnusedMedia', 'collectMediaRefs',
  'isSafeMediaDataUrl', 'parseDataUrl', 'MEDIA_LIMITS', 'mediaKindForMime', 'validateMediaFile',
  'MEDIA_IMPORT_MAX_ITEMS', 'MEDIA_IMPORT_MAX_TOTAL_BYTES',
  'saveMediaFromDataUrl', 'deleteMedia', 'getMediaUrl', 'getMediaBlob', 'blobToDataUrl',
  'mediaToDataUrl', 'resolveMediaUrls', 'mediaHtml',
];

/* `.ctx` is the raw vm context (the actual global object of that realm) —
   tests use it to override a global function (fetch, saveMediaFromDataUrl,
   deleteMedia, resolveMediaUrls, ...) for that one test, since bare
   identifier lookups inside the loaded scripts resolve through this same
   object for anything declared with `function`/`var`. */
function loadSandbox() {
  const sandbox = { console, alert() {} };
  sandbox.localStorage = makeLocalStorage();
  vm.createContext(sandbox);
  for (const f of ['js/util.js', 'js/media.js', 'js/qtypes.js', 'js/store.js']) {
    const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    vm.runInContext(code, sandbox, { filename: f });
  }
  const bridge = `var __exports = { ${EXPORTED_NAMES.map(n => `${n}: typeof ${n} !== 'undefined' ? ${n} : undefined`).join(', ')} };`;
  vm.runInContext(bridge, sandbox, { filename: 'bridge.js' });
  return Object.assign({ ctx: sandbox }, sandbox.__exports);
}

/* A minimal fake DOM element: plain settable properties plus the handful of
   methods host.js/qtypes.js call on elements (classList, querySelector,
   event wiring). Good enough to run real game logic headlessly — it just
   doesn't render anything. */
function makeFakeEl() {
  return {
    innerHTML: '', className: '', textContent: '', disabled: false, style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    querySelector() { return makeFakeEl(); },
    querySelectorAll() { return []; },
    insertAdjacentHTML() {},
  };
}

const GAME_EXPORTED_NAMES = [...EXPORTED_NAMES, 'HostGame', 'startHost'];

/* Extends loadSandbox() with js/host.js loaded and a fake document/window,
   for tests that need the actual game engine (reconnect identity, question
   timing) rather than just the pure validation/scoring logic. host.js's
   top-level code (class/function declarations) touches no globals by
   itself — only calling its methods does, which is what these stubs are
   for. Real PeerJS connections aren't needed for these tests: a plain
   object with connectionId/open/send()/close() satisfies everything
   HostGame.handleJoin()/broadcast() actually do with a `conn`. */
function loadGameSandbox() {
  const sandbox = { console, setInterval, clearInterval, setTimeout, clearTimeout };
  sandbox.localStorage = makeLocalStorage();
  sandbox.document = { querySelectorAll: () => [], querySelector: () => makeFakeEl() };
  sandbox.window = { scrollTo() {} };
  vm.createContext(sandbox);
  for (const f of ['js/util.js', 'js/media.js', 'js/qtypes.js', 'js/store.js', 'js/host.js']) {
    const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    vm.runInContext(code, sandbox, { filename: f });
  }
  const bridge = `var __exports = { ${GAME_EXPORTED_NAMES.map(n => `${n}: typeof ${n} !== 'undefined' ? ${n} : undefined`).join(', ')} };`;
  vm.runInContext(bridge, sandbox, { filename: 'bridge.js' });
  return Object.assign({ ctx: sandbox }, sandbox.__exports);
}

function fakeConn(connectionId) {
  return { connectionId, open: true, send() {}, close() { this.open = false; } };
}

/* Values built inside the vm context are plain arrays/objects but from a
   different realm, so Node's deepStrictEqual flags them as "not
   reference-equal" even when structurally identical. JSON round-tripping
   sidesteps that (and is all these tests need — everything compared here is
   JSON-safe). */
function jsonEqual(actual, expected, message) {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

const tests = [];
function test(name, fn, opts) { tests.push({ name, fn, loader: (opts && opts.loader) || loadSandbox }); }

/* ---------- qtypes: validation ---------- */

test('mc: valid question has no problems', ({ QuestionTypes }) => {
  const q = { answers: [{ text: 'A', correct: true }, { text: 'B', correct: false }] };
  assert.strictEqual(QuestionTypes.mc.validate(q).length, 0);
});

test('mc: needs at least 2 filled answers', ({ QuestionTypes }) => {
  const q = { answers: [{ text: 'A', correct: true }, { text: '', correct: false }] };
  assert.ok(QuestionTypes.mc.validate(q).length > 0);
});

test('mc: needs a correct answer marked', ({ QuestionTypes }) => {
  const q = { answers: [{ text: 'A', correct: false }, { text: 'B', correct: false }] };
  assert.ok(QuestionTypes.mc.validate(q).length > 0);
});

test('tf: always valid', ({ QuestionTypes }) => {
  assert.strictEqual(QuestionTypes.tf.validate({ correct: true }).length, 0);
  assert.strictEqual(QuestionTypes.tf.validate({ correct: false }).length, 0);
});

test('order: needs at least 2 filled items', ({ QuestionTypes }) => {
  assert.ok(QuestionTypes.order.validate({ items: [{ text: 'Only one' }] }).length > 0);
  assert.strictEqual(QuestionTypes.order.validate({ items: [{ text: 'A' }, { text: 'B' }] }).length, 0);
});

test('typed: needs at least one accepted answer', ({ QuestionTypes }) => {
  assert.ok(QuestionTypes.typed.validate({ accepted: [''] }).length > 0);
  assert.strictEqual(QuestionTypes.typed.validate({ accepted: ['Paris'] }).length, 0);
});

test('slider: min must be less than max, correct must be in range', ({ QuestionTypes }) => {
  assert.ok(QuestionTypes.slider.validate({ min: 10, max: 5, correct: 7 }).length > 0);
  assert.ok(QuestionTypes.slider.validate({ min: 0, max: 10, correct: 99 }).length > 0);
  assert.strictEqual(QuestionTypes.slider.validate({ min: 0, max: 10, correct: 5 }).length, 0);
});

test('poll: needs at least 2 filled options', ({ QuestionTypes }) => {
  assert.ok(QuestionTypes.poll.validate({ options: [{ text: 'Only one' }] }).length > 0);
});

test('scale: rejects a scale wider than the tile palette', ({ QuestionTypes, MAX_TILES }) => {
  assert.ok(QuestionTypes.scale.validate({ min: 1, max: MAX_TILES + 5 }).length > 0);
  assert.strictEqual(QuestionTypes.scale.validate({ min: 1, max: 5 }).length, 0);
});

test('wordcloud / open: no extra fields required', ({ QuestionTypes }) => {
  assert.strictEqual(QuestionTypes.wordcloud.validate({}).length, 0);
  assert.strictEqual(QuestionTypes.open.validate({}).length, 0);
});

test('imagepin: needs an uploaded image', ({ QuestionTypes }) => {
  assert.ok(QuestionTypes.imagepin.validate({ media: { image: null } }).length > 0);
  assert.strictEqual(QuestionTypes.imagepin.validate({ media: { image: 'abc' } }).length, 0);
});

/* ---------- qtypes: correctness / scoring ---------- */

test('mc: isCorrect matches the flagged answer only', ({ QuestionTypes }) => {
  const q = { answers: [{ text: 'A', correct: false }, { text: 'B', correct: true }] };
  assert.strictEqual(QuestionTypes.mc.isCorrect(q, { c: 1 }), true);
  assert.strictEqual(QuestionTypes.mc.isCorrect(q, { c: 0 }), false);
});

test('mc: malformed submissions are rejected, not thrown', ({ QuestionTypes }) => {
  const q = { answers: [{ text: 'A', correct: true }] };
  assert.strictEqual(QuestionTypes.mc.isCorrect(q, null), false);
  assert.strictEqual(QuestionTypes.mc.isCorrect(q, {}), false);
  assert.strictEqual(QuestionTypes.mc.isCorrect(q, { c: 'x' }), false);
  assert.strictEqual(QuestionTypes.mc.isCorrect(q, { c: 99 }), false);
});

test('tf: 0 means True, 1 means False', ({ QuestionTypes }) => {
  assert.strictEqual(QuestionTypes.tf.isCorrect({ correct: true }, { c: 0 }), true);
  assert.strictEqual(QuestionTypes.tf.isCorrect({ correct: true }, { c: 1 }), false);
  assert.strictEqual(QuestionTypes.tf.isCorrect({ correct: false }, { c: 1 }), true);
});

test('order: exact identity permutation is correct, anything else is not', ({ QuestionTypes }) => {
  const q = { items: [{ text: 'A' }, { text: 'B' }, { text: 'C' }] };
  assert.strictEqual(QuestionTypes.order.isCorrect(q, { order: [0, 1, 2] }), true);
  assert.strictEqual(QuestionTypes.order.isCorrect(q, { order: [1, 0, 2] }), false);
  assert.strictEqual(QuestionTypes.order.isCorrect(q, { order: [0, 1] }), false); // wrong length
});

test('typed: case-insensitive, trimmed match against any accepted answer', ({ QuestionTypes }) => {
  const q = { accepted: ['Paris', 'paris, france'] };
  assert.strictEqual(QuestionTypes.typed.isCorrect(q, { text: '  PARIS  ' }), true);
  assert.strictEqual(QuestionTypes.typed.isCorrect(q, { text: 'London' }), false);
  assert.strictEqual(QuestionTypes.typed.isCorrect(q, { text: '' }), false);
});

test('slider: within tolerance counts, outside does not', ({ QuestionTypes }) => {
  const q = { min: 0, max: 100, step: 1, correct: 50 };
  assert.strictEqual(QuestionTypes.slider.isCorrect(q, { value: 50 }), true);
  assert.strictEqual(QuestionTypes.slider.isCorrect(q, { value: 51 }), true);   // within 3% tolerance
  assert.strictEqual(QuestionTypes.slider.isCorrect(q, { value: 10 }), false);
});

test('poll / scale / wordcloud / open: never graded', ({ QuestionTypes }) => {
  assert.strictEqual(QuestionTypes.poll.isCorrect({}, { c: 0 }), null);
  assert.strictEqual(QuestionTypes.scale.isCorrect({}, { c: 2 }), null);
  assert.strictEqual(QuestionTypes.wordcloud.isCorrect({}, { text: 'x' }), null);
  assert.strictEqual(QuestionTypes.open.isCorrect({}, { text: 'x' }), null);
});

test('imagepin: within the pin tolerance radius counts as correct', ({ QuestionTypes }) => {
  const q = { pin: { x: 0.5, y: 0.5 }, tolerance: 0.1 };
  assert.strictEqual(QuestionTypes.imagepin.isCorrect(q, { x: 0.52, y: 0.51 }), true);
  assert.strictEqual(QuestionTypes.imagepin.isCorrect(q, { x: 0.9, y: 0.9 }), false);
});

/* ---------- qtypes: player payload never leaks question/answer text ---------- */

test('mc/tf/order/poll/scale player payloads carry no text fields', ({ QuestionTypes }) => {
  const cases = [
    ['mc', { answers: [{ text: 'Paris', correct: true }, { text: 'London', correct: false }] }],
    ['tf', { correct: true }],
    ['order', { items: [{ text: 'First' }, { text: 'Second' }] }],
    ['poll', { options: [{ text: 'Yes' }, { text: 'No' }] }],
    ['scale', { min: 1, max: 5 }],
  ];
  for (const [type, q] of cases) {
    const payload = QuestionTypes[type].playerPayload(q, {});
    const json = JSON.stringify(payload).toLowerCase();
    for (const banned of ['paris', 'london', 'first', 'second', 'yes', 'no']) {
      assert.ok(!json.includes(banned), `${type} payload leaked "${banned}": ${json}`);
    }
  }
});

test('typed/slider/wordcloud/open player payloads carry no accepted-answer data', ({ QuestionTypes }) => {
  jsonEqual(QuestionTypes.typed.playerPayload({ accepted: ['secret'] }, {}), {});
  jsonEqual(QuestionTypes.wordcloud.playerPayload({}, {}), {});
  jsonEqual(QuestionTypes.open.playerPayload({}, {}), {});
  const sliderPayload = QuestionTypes.slider.playerPayload({ min: 0, max: 10, step: 1, correct: 7 }, {});
  assert.strictEqual(sliderPayload.correct, undefined);
});

test('imagepin payload carries the image (the one documented exception)', ({ QuestionTypes }) => {
  const payload = QuestionTypes.imagepin.playerPayload({ tolerance: 0.1 }, { imageDataUrl: 'data:image/png;base64,AAA' });
  assert.strictEqual(payload.image, 'data:image/png;base64,AAA');
  assert.strictEqual(payload.pin, undefined); // the correct location itself must never be sent
});

/* ---------- store.js: quiz-level validation, normalization, migration ---------- */

test('validateQuiz: flags missing title and per-question problems', (sb) => {
  const quiz = { title: '', questions: [{ type: 'mc', text: '', answers: [{ text: '', correct: false }] }] };
  const problems = sb.validateQuiz(quiz);
  assert.ok(problems.some(p => p.includes('title')));
  assert.ok(problems.some(p => p.includes('Question 1')));
});

test('validateQuiz: a well-formed quiz has no problems', (sb) => {
  const quiz = {
    title: 'Demo',
    questions: [{ type: 'mc', text: 'Q1', answers: [{ text: 'A', correct: true }, { text: 'B', correct: false }] }],
  };
  assert.strictEqual(sb.validateQuiz(quiz).length, 0);
});

test('normalizeQuiz strips empty mc answer slots', (sb) => {
  const quiz = {
    title: 'Demo',
    questions: [{ type: 'mc', text: 'Q1', answers: [{ text: 'A', correct: true }, { text: '', correct: false }] }],
  };
  const clean = sb.normalizeQuiz(quiz);
  assert.strictEqual(clean.questions[0].answers.length, 1);
});

test('blankQuestion: unknown type falls back to mc', (sb) => {
  const q = sb.blankQuestion('not-a-real-type');
  assert.strictEqual(q.type, 'mc');
  assert.ok(Array.isArray(q.media) === false && q.media && 'image' in q.media);
});

test('retypeQuestion keeps common fields, drops old type-specific ones', (sb) => {
  const mc = sb.blankQuestion('mc');
  mc.text = 'Capital of France?';
  mc.time = 30;
  mc.points = 'double';
  mc.answers = [{ text: 'Paris', correct: true }];
  const asTf = sb.retypeQuestion(mc, 'tf');
  assert.strictEqual(asTf.type, 'tf');
  assert.strictEqual(asTf.text, 'Capital of France?');
  assert.strictEqual(asTf.time, 30);
  assert.strictEqual(asTf.points, 'double');
  assert.strictEqual(asTf.answers, undefined);
  assert.strictEqual(typeof asTf.correct, 'boolean');
});

test('migrateQuiz: fills in type/media on legacy questions', (sb) => {
  const legacy = {
    title: 'Old quiz',
    questions: [{ text: 'Q1', answers: [{ text: 'A', correct: true }], time: 20, points: 'standard' }],
  };
  const migrated = sb.migrateQuiz(legacy);
  assert.strictEqual(migrated.questions[0].type, 'mc');
  jsonEqual(migrated.questions[0].media, { image: null, video: null, audio: null });
});

test('sanitizeQuestion: unknown/malformed input falls back to safe defaults', (sb) => {
  const q = sb.sanitizeQuestion({ type: 'bogus', text: 'x'.repeat(999), time: 999, points: 'nope', answers: 'not-an-array' });
  assert.strictEqual(q.type, 'mc');
  assert.strictEqual(q.text.length, 200);
  assert.strictEqual(q.time, 20);
  assert.strictEqual(q.points, 'standard');
  assert.ok(Array.isArray(q.answers));
});

/* ---------- store.js: localStorage-backed CRUD (fake localStorage) ---------- */

test('getQuizzes seeds a sample quiz on first run, upsert/delete round-trip', (sb) => {
  const seeded = sb.getQuizzes();
  assert.ok(seeded.length >= 1);

  const quiz = sb.newQuiz();
  quiz.title = 'My Quiz';
  sb.upsertQuiz(quiz);
  assert.ok(sb.getQuiz(quiz.id));
  assert.strictEqual(sb.getQuiz(quiz.id).title, 'My Quiz');

  sb.deleteQuiz(quiz.id);
  assert.strictEqual(sb.getQuiz(quiz.id), null);
});

test('QUESTION_TYPE_LIST covers all ten required question types', (sb) => {
  const expected = ['mc', 'tf', 'order', 'typed', 'slider', 'poll', 'scale', 'wordcloud', 'open', 'imagepin'];
  assert.deepStrictEqual([...sb.QUESTION_TYPE_LIST].sort(), [...expected].sort());
});

/* ================= regression: scale shows real min..max (issue #5) ================= */

test('scale: player payload carries the real min, not an assumed 1', ({ QuestionTypes }) => {
  const payload = QuestionTypes.scale.playerPayload({ min: 3, max: 7 }, {});
  assert.strictEqual(payload.min, 3);
  assert.strictEqual(payload.count, 5);
});

test('scale: playerControl renders actual min..max labels (regression for a 3-7 scale showing 1-5)', (sb) => {
  const el = makeFakeEl();
  sb.QuestionTypes.scale.playerControl(el, { count: 5, min: 3 }, () => {});
  assert.ok(el.innerHTML.includes('>3<'), 'lowest tile should read 3');
  assert.ok(el.innerHTML.includes('>7<'), 'highest tile should read 7 (min + count - 1)');
  assert.ok(!el.innerHTML.includes('>1<'), 'must not fall back to a 1-based label');
});

test('scale: playerControl falls back to 1-based only for a legacy payload missing min', (sb) => {
  const el = makeFakeEl();
  sb.QuestionTypes.scale.playerControl(el, { count: 5 }, () => {});
  assert.ok(el.innerHTML.includes('>1<'));
});

/* ================= regression: deep per-type import sanitization (issue #1) ================= */

test('mc.sanitize: wrong field types and oversized arrays are rebuilt safely, capped at 4', ({ QuestionTypes }) => {
  const raw = { answers: Array.from({ length: 20 }, (_, i) => ({ text: i, correct: i === 0 ? 'yes' : 12345 })) };
  const out = QuestionTypes.mc.sanitize(raw);
  assert.strictEqual(out.answers.length, 4);
  out.answers.forEach(a => {
    assert.strictEqual(typeof a.text, 'string');
    assert.strictEqual(typeof a.correct, 'boolean');
  });
});

test('order.sanitize / poll.sanitize: capped at ORDER_MAX / POLL_MAX', ({ QuestionTypes, ORDER_MAX, POLL_MAX }) => {
  const many = Array.from({ length: 50 }, (_, i) => ({ text: 'item' + i }));
  assert.strictEqual(QuestionTypes.order.sanitize({ items: many }).items.length, ORDER_MAX);
  assert.strictEqual(QuestionTypes.poll.sanitize({ options: many }).options.length, POLL_MAX);
});

test('typed.sanitize: accepted answers coerced to strings, capped at a reasonable maximum', ({ QuestionTypes, TYPED_MAX_ACCEPTED }) => {
  const out = QuestionTypes.typed.sanitize({ accepted: Array.from({ length: 50 }, (_, i) => (i % 2 ? i : { toString: () => 'x' })) });
  assert.ok(out.accepted.length <= TYPED_MAX_ACCEPTED);
  out.accepted.forEach(a => assert.strictEqual(typeof a, 'string'));
});

test('slider.sanitize: NaN/Infinity/string-object garbage never survives, min<max always holds', ({ QuestionTypes }) => {
  const out = QuestionTypes.slider.sanitize({ min: 'abc', max: Infinity, step: NaN, correct: {} });
  assert.ok(Number.isFinite(out.min) && Number.isFinite(out.max) && Number.isFinite(out.step) && Number.isFinite(out.correct));
  assert.ok(out.min < out.max);
  assert.ok(out.correct >= out.min && out.correct <= out.max);
});

test('scale.sanitize: an absurd range collapses to a safe default within the tile palette', ({ QuestionTypes, SCALE_MAX_POINTS }) => {
  const out = QuestionTypes.scale.sanitize({ min: 1, max: 999999 });
  assert.ok(out.max - out.min + 1 <= SCALE_MAX_POINTS);
  assert.ok(Number.isInteger(out.min) && Number.isInteger(out.max));
});

test('imagepin.sanitize: pin coordinates and tolerance are clamped to sane ranges', ({ QuestionTypes }) => {
  const out = QuestionTypes.imagepin.sanitize({ pin: { x: 'left', y: null }, tolerance: -50 });
  assert.ok(out.pin.x >= 0 && out.pin.x <= 1);
  assert.ok(out.pin.y >= 0 && out.pin.y <= 1);
  assert.ok(out.tolerance >= 0.01 && out.tolerance <= 0.5);
});

test('importQuizJson: malformed/hostile question entries never throw downstream', async (sb) => {
  const raw = {
    title: 'x'.repeat(500),
    questions: [
      null, 42, 'garbage', [1, 2, 3],
      { type: 'slider', min: 'abc', max: Infinity, step: NaN, correct: {} },
      { type: 'scale', min: 1, max: 999999 },
      { type: 'imagepin', pin: { x: 'left', y: null }, tolerance: -50 },
      { type: 'typed', accepted: Array.from({ length: 50 }, (_, i) => 'answer' + i) },
      { type: 'mc', answers: 'not-an-array' },
      { type: 'order', items: { not: 'an array either' } },
    ],
  };
  const quiz = await sb.importQuizJson(JSON.stringify(raw));
  assert.strictEqual(quiz.title.length, 80);
  assert.strictEqual(quiz.questions.length, raw.questions.length);
  for (const q of quiz.questions) {
    const single = { title: 't', questions: [q] };
    assert.doesNotThrow(() => sb.validateQuiz(single), `validateQuiz threw on a ${q.type} question`);
    assert.doesNotThrow(() => sb.normalizeQuiz(single), `normalizeQuiz threw on a ${q.type} question`);
    assert.doesNotThrow(() => sb.questionTypeOf(q).isCorrect(q, { c: 0, order: [0], value: 1, x: 0.5, y: 0.5, text: 'x' }),
      `isCorrect threw on a ${q.type} question`);
  }
});

test('importQuizJson: caps the total number of imported questions', async (sb) => {
  const raw = {
    title: 'Huge',
    questions: Array.from({ length: 500 }, (_, i) => ({ type: 'mc', text: 'Q' + i, answers: [{ text: 'a', correct: true }, { text: 'b', correct: false }] })),
  };
  const quiz = await sb.importQuizJson(JSON.stringify(raw));
  assert.strictEqual(quiz.questions.length, sb.MAX_IMPORT_QUESTIONS);
});

/* ================= regression: secure/bounded media import (issue #2) ================= */

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

test('isSafeMediaDataUrl: only a well-formed, allow-listed, size-bounded data: URL passes', (sb) => {
  assert.strictEqual(sb.isSafeMediaDataUrl(`data:image/png;base64,${TINY_PNG_BASE64}`), true);
  assert.strictEqual(sb.isSafeMediaDataUrl('https://evil.example/x.png'), false);
  assert.strictEqual(sb.isSafeMediaDataUrl('http://example.com/a.png'), false);
  assert.strictEqual(sb.isSafeMediaDataUrl('blob:http://localhost/uuid'), false);
  assert.strictEqual(sb.isSafeMediaDataUrl('file:///etc/passwd'), false);
  assert.strictEqual(sb.isSafeMediaDataUrl('javascript:alert(1)'), false);
  assert.strictEqual(sb.isSafeMediaDataUrl('data:text/html;base64,PHNjcmlwdD4='), false, 'disallowed MIME type');
  assert.strictEqual(sb.isSafeMediaDataUrl('data:image/png,not-base64-data'), false, 'not base64-encoded');
  assert.strictEqual(sb.isSafeMediaDataUrl(null), false);
  assert.strictEqual(sb.isSafeMediaDataUrl(undefined), false);
  assert.strictEqual(sb.isSafeMediaDataUrl(12345), false);
  assert.strictEqual(sb.isSafeMediaDataUrl({}), false);
});

test('isSafeMediaDataUrl: rejects a payload larger than that kind\'s limit', (sb) => {
  const hugeBase64 = 'A'.repeat(Math.ceil(sb.MEDIA_LIMITS.image.maxBytes / 3) * 4 + 100);
  assert.strictEqual(sb.isSafeMediaDataUrl(`data:image/png;base64,${hugeBase64}`), false);
});

test('isSafeMediaDataUrl: SVG is not an allowed image MIME (excluded to limit active-content ambiguity)', (sb) => {
  const svgBase64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64');
  assert.strictEqual(sb.isSafeMediaDataUrl(`data:image/svg+xml;base64,${svgBase64}`, 'image'), false);
  assert.strictEqual(sb.isSafeMediaDataUrl(`data:image/svg+xml;base64,${svgBase64}`), false);
});

test('isSafeMediaDataUrl: a kind argument rejects a MIME from the wrong kind', (sb) => {
  const audioAsImage = `data:audio/mpeg;base64,${TINY_PNG_BASE64}`;
  assert.strictEqual(sb.isSafeMediaDataUrl(audioAsImage, 'image'), false);
  assert.strictEqual(sb.isSafeMediaDataUrl(audioAsImage, 'audio'), true);
});

test('mediaKindForMime: maps every allow-listed MIME to its kind, rejects the rest', (sb) => {
  assert.strictEqual(sb.mediaKindForMime('image/png'), 'image');
  assert.strictEqual(sb.mediaKindForMime('audio/mpeg'), 'audio');
  assert.strictEqual(sb.mediaKindForMime('video/mp4'), 'video');
  assert.strictEqual(sb.mediaKindForMime('image/svg+xml'), null);
  assert.strictEqual(sb.mediaKindForMime('text/html'), null);
  assert.strictEqual(sb.mediaKindForMime('application/octet-stream'), null);
});

test('validateMediaFile: boundary size, wrong MIME for the slot, and SVG are all rejected', (sb) => {
  assert.strictEqual(sb.validateMediaFile({ type: 'image/png', size: sb.MEDIA_LIMITS.image.maxBytes }, 'image'), null,
    'exactly at the limit must be accepted');
  assert.ok(sb.validateMediaFile({ type: 'image/png', size: sb.MEDIA_LIMITS.image.maxBytes + 1 }, 'image'),
    'one byte over the limit must be rejected');
  assert.ok(sb.validateMediaFile({ type: 'audio/mpeg', size: 1000 }, 'image'),
    'an audio file must be rejected from the image slot');
  assert.ok(sb.validateMediaFile({ type: 'image/svg+xml', size: 1000 }, 'image'),
    'SVG must be rejected for the image slot');
  assert.strictEqual(sb.validateMediaFile({ type: 'audio/ogg', size: sb.MEDIA_LIMITS.audio.maxBytes }, 'audio'), null);
  assert.ok(sb.validateMediaFile({ type: 'audio/ogg', size: sb.MEDIA_LIMITS.audio.maxBytes + 1 }, 'audio'));
  assert.strictEqual(sb.validateMediaFile({ type: 'video/webm', size: sb.MEDIA_LIMITS.video.maxBytes }, 'video'), null);
  assert.ok(sb.validateMediaFile({ type: 'video/webm', size: sb.MEDIA_LIMITS.video.maxBytes + 1 }, 'video'));
});

test('saveMediaFromDataUrl: throws before fetch for an unsafe URL, never calls fetch', async (sb) => {
  const fetchCalls = [];
  sb.ctx.fetch = async (url) => { fetchCalls.push(url); throw new Error('network call attempted: ' + url); };
  await assert.rejects(() => sb.saveMediaFromDataUrl('https://evil.example/x.png'));
  assert.deepStrictEqual(fetchCalls, [], 'fetch must never be reached for a non-data: URL');
});

test('importQuizJson: an https:// media entry never reaches fetch or saveMediaFromDataUrl', async (sb) => {
  const fetchCalls = [];
  sb.ctx.fetch = async (url) => { fetchCalls.push(url); throw new Error('network call attempted: ' + url); };
  const saveCalls = [];
  sb.ctx.saveMediaFromDataUrl = async (dataUrl) => { saveCalls.push(dataUrl); return 'fake-id'; };

  const raw = {
    title: 'Media quiz',
    questions: [
      { type: 'imagepin', media: { image: 'good' }, pin: { x: 0.5, y: 0.5 }, tolerance: 0.1 },
      { type: 'imagepin', media: { image: 'bad' }, pin: { x: 0.5, y: 0.5 }, tolerance: 0.1 },
    ],
    media: {
      good: `data:image/png;base64,${TINY_PNG_BASE64}`,
      bad: 'https://evil.example/steal.png',
    },
  };
  const quiz = await sb.importQuizJson(JSON.stringify(raw));

  assert.deepStrictEqual(fetchCalls, [], 'fetch must never be called during import');
  assert.deepStrictEqual(saveCalls, [`data:image/png;base64,${TINY_PNG_BASE64}`], 'only the safe data: URL may reach saveMediaFromDataUrl');
  assert.strictEqual(quiz.questions[0].media.image, 'fake-id');
  assert.strictEqual(quiz.questions[1].media.image, null, 'the https: entry must be omitted, not imported');
});

test('importQuizJson: only decodes media ids actually referenced by a question', async (sb) => {
  const saveCalls = [];
  sb.ctx.saveMediaFromDataUrl = async (dataUrl) => { saveCalls.push(dataUrl); return 'fake-id'; };
  const raw = {
    title: 'Sparse media',
    questions: [{ type: 'mc', text: 'Q', answers: [{ text: 'a', correct: true }, { text: 'b', correct: false }] }],
    media: { unreferenced: `data:image/png;base64,${TINY_PNG_BASE64}` },
  };
  await sb.importQuizJson(JSON.stringify(raw));
  assert.deepStrictEqual(saveCalls, [], 'an unreferenced media entry must never be decoded');
});

test('importQuizJson: enforces a max media item count', async (sb) => {
  let calls = 0;
  sb.ctx.saveMediaFromDataUrl = async () => { calls++; return 'id' + calls; };
  const media = {};
  const questions = [];
  for (let i = 0; i < sb.MEDIA_IMPORT_MAX_ITEMS + 10; i++) {
    const id = 'img' + i;
    media[id] = `data:image/png;base64,${TINY_PNG_BASE64}`;
    questions.push({ type: 'imagepin', media: { image: id }, pin: { x: 0.5, y: 0.5 }, tolerance: 0.1 });
  }
  await sb.importQuizJson(JSON.stringify({ title: 'Many media', questions, media }));
  assert.strictEqual(calls, sb.MEDIA_IMPORT_MAX_ITEMS);
});

test('importQuizJson: a media entry whose real MIME does not match its slot is rejected', async (sb) => {
  const saveCalls = [];
  sb.ctx.saveMediaFromDataUrl = async (dataUrl, kind) => { saveCalls.push({ dataUrl, kind }); return 'fake-id'; };
  const raw = {
    title: 'Mismatched slot',
    questions: [{
      type: 'imagepin',
      media: { image: 'not-really-an-image' },
      pin: { x: 0.5, y: 0.5 }, tolerance: 0.1,
    }],
    // The id is referenced from the *image* slot, but the bytes are audio.
    media: { 'not-really-an-image': `data:audio/mpeg;base64,${TINY_PNG_BASE64}` },
  };
  const quiz = await sb.importQuizJson(JSON.stringify(raw));
  assert.deepStrictEqual(saveCalls, [], 'audio bytes referenced from the image slot must never be imported');
  assert.strictEqual(quiz.questions[0].media.image, null);
});

test('export -> import round trip: everything the exporter includes, the importer accepts', async (sb) => {
  sb.ctx.document = { createElement: () => ({ click() {} }) };
  sb.ctx.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL() {} };
  let captured = null;
  sb.ctx.Blob = class { constructor(parts) { captured = parts[0]; } };

  const fakeBlobs = {
    'img-ok': { type: 'image/png', size: 1000 },
    'aud-ok': { type: 'audio/mpeg', size: 2000 },
    'vid-ok': { type: 'video/mp4', size: 3000 },
    'img-big': { type: 'image/png', size: sb.MEDIA_LIMITS.image.maxBytes + 1 },
    'img-wrong-mime': { type: 'application/octet-stream', size: 1000 },
  };
  sb.ctx.getMediaBlob = async id => fakeBlobs[id] || null;
  sb.ctx.blobToDataUrl = async blob => `data:${blob.type};base64,${TINY_PNG_BASE64}`;

  const mkQ = (i, media) => ({ type: 'mc', text: 'Q' + i, media, time: 20, points: 'standard', answers: [{ text: 'a', correct: true }, { text: 'b', correct: false }] });
  const quiz = {
    id: 'q1', title: 'Round Trip',
    questions: [
      mkQ(1, { image: 'img-ok', video: null, audio: null }),
      mkQ(2, { image: null, video: 'vid-ok', audio: 'aud-ok' }),
      mkQ(3, { image: 'img-big', video: null, audio: null }),
      mkQ(4, { image: 'img-wrong-mime', video: null, audio: null }),
    ],
  };

  await sb.exportQuiz(quiz);
  assert.ok(captured, 'export should have produced a JSON payload');
  const exportedJson = captured;
  const exported = JSON.parse(exportedJson);
  assert.ok(exported.media['img-ok']);
  assert.ok(exported.media['vid-ok']);
  assert.ok(exported.media['aud-ok']);
  assert.ok(!exported.media['img-big'], 'an oversized image must be left out of the export, not silently included');
  assert.ok(!exported.media['img-wrong-mime'], 'a blob whose MIME is not an allowed image type must be left out');

  // Feed the export straight back into the importer and confirm every media
  // item the export DID include is one the importer accepts.
  let saveCount = 0;
  sb.ctx.saveMediaFromDataUrl = async () => { saveCount++; return 'new-id-' + saveCount; };
  const imported = await sb.importQuizJson(exportedJson);
  assert.strictEqual(saveCount, 3, 'all three exported media items must be accepted by import');
  assert.ok(imported.questions[0].media.image);
  assert.ok(imported.questions[1].media.video);
  assert.ok(imported.questions[1].media.audio);
  assert.strictEqual(imported.questions[2].media.image, null, 'the item the export excluded was never in the file to import');
});

/* ================= regression: orphaned IndexedDB media cleanup (issue #6) ================= */

test('isMediaReferenced reflects live storage, not a point-in-time snapshot', (sb) => {
  sb.saveQuizzes([{
    id: 'q1', title: 'T',
    questions: [{ type: 'mc', text: 'Q', media: { image: 'm1', video: null, audio: null }, time: 20, points: 'standard', answers: [{ text: 'a', correct: true }, { text: 'b', correct: false }] }],
  }]);
  assert.strictEqual(sb.isMediaReferenced('m1'), true);
  assert.strictEqual(sb.isMediaReferenced('missing'), false);
  sb.deleteQuiz('q1');
  assert.strictEqual(sb.isMediaReferenced('m1'), false);
});

test('releaseMediaIfUnused only deletes once the LAST reference disappears (shared media)', async (sb) => {
  const deleted = [];
  sb.ctx.deleteMedia = async (id) => { deleted.push(id); };

  const mkQuiz = (id, title) => ({
    id, title,
    questions: [{ type: 'mc', text: 'Q', media: { image: 'shared-img', video: null, audio: null }, time: 20, points: 'standard', answers: [{ text: 'a', correct: true }, { text: 'b', correct: false }] }],
  });
  sb.saveQuizzes([mkQuiz('qa', 'A'), mkQuiz('qb', 'B')]);  // two quizzes share one media id

  await sb.releaseMediaIfUnused('shared-img');
  assert.deepStrictEqual(deleted, [], 'quiz B still references it — must not delete');

  sb.deleteQuiz('qb');
  await sb.releaseMediaIfUnused('shared-img');
  assert.deepStrictEqual(deleted, [], 'quiz A still references it — must not delete yet');

  sb.deleteQuiz('qa');
  await sb.releaseMediaIfUnused('shared-img');
  assert.deepStrictEqual(deleted, ['shared-img'], 'last reference gone — now it should be deleted');
});

test('releaseMediaIfUnused: a duplicated question sharing media is also a valid reference', async (sb) => {
  const deleted = [];
  sb.ctx.deleteMedia = async (id) => { deleted.push(id); };
  const q = { type: 'mc', text: 'Q', media: { image: 'dup-img', video: null, audio: null }, time: 20, points: 'standard', answers: [{ text: 'a', correct: true }, { text: 'b', correct: false }] };
  sb.saveQuizzes([{ id: 'q1', title: 'T', questions: [q, JSON.parse(JSON.stringify(q))] }]);

  await sb.releaseMediaIfUnused('dup-img');
  assert.deepStrictEqual(deleted, [], 'the duplicate question still references it');
});

test('releaseMediaIfUnused: a cleanup failure is swallowed, never thrown', async (sb) => {
  sb.ctx.deleteMedia = async () => { throw new Error('IndexedDB unavailable'); };
  sb.saveQuizzes([]); // media id referenced by nothing
  await assert.doesNotReject(() => sb.releaseMediaIfUnused('orphan'));
});

test('releaseUnusedMedia releases several ids, skipping the ones still referenced', async (sb) => {
  const deleted = [];
  sb.ctx.deleteMedia = async (id) => { deleted.push(id); };
  sb.saveQuizzes([{
    id: 'q1', title: 'T',
    questions: [{ type: 'mc', text: 'Q', media: { image: 'keep-me', video: null, audio: null }, time: 20, points: 'standard', answers: [{ text: 'a', correct: true }, { text: 'b', correct: false }] }],
  }]);
  await sb.releaseUnusedMedia(['keep-me', 'gone-1', 'gone-2']);
  assert.deepStrictEqual(deleted.sort(), ['gone-1', 'gone-2']);
});

/* ================= regression: host engine — timing & reconnect (issues #3, #4) ================= */
/* These load js/host.js itself (via loadGameSandbox) with a fake DOM, so the
   real HostGame class runs headlessly — no PeerJS/browser needed. */

test('startQuestion: qStartedAt is set only after media/player-context resolves, not before', async (sb) => {
  const quiz = {
    title: 'T',
    questions: [{ type: 'mc', text: 'Q', media: sb.emptyMedia(), time: 20, points: 'standard', answers: [{ text: 'A', correct: true }, { text: 'B', correct: false }] }],
  };
  const game = new sb.HostGame(quiz);
  game.players.set('c1', { conn: fakeConn('c1'), pid: null, name: 'X', score: 0, streak: 0, submission: null, answerMs: 0, joinedAtQ: -1 });

  const realResolve = sb.ctx.resolveMediaUrls;
  sb.ctx.resolveMediaUrls = async (media) => { await new Promise(r => setTimeout(r, 60)); return realResolve(media); };

  const before = Date.now();
  await game.startQuestion(0);
  sb.ctx.resolveMediaUrls = realResolve;
  game.destroy();

  assert.ok(game.qStartedAt - before >= 55,
    `qStartedAt must be set after the simulated 60ms media delay, was only ${game.qStartedAt - before}ms in`);
}, { loader: loadGameSandbox });

test('startQuestion: the host tears down mid-resolve without crashing or starting a stale question', async (sb) => {
  const quiz = {
    title: 'T',
    questions: [
      { type: 'mc', text: 'Q1', media: sb.emptyMedia(), time: 20, points: 'standard', answers: [{ text: 'A', correct: true }, { text: 'B', correct: false }] },
      { type: 'mc', text: 'Q2', media: sb.emptyMedia(), time: 20, points: 'standard', answers: [{ text: 'A', correct: true }, { text: 'B', correct: false }] },
    ],
  };
  const game = new sb.HostGame(quiz);
  const realResolve = sb.ctx.resolveMediaUrls;
  sb.ctx.resolveMediaUrls = async (media) => { await new Promise(r => setTimeout(r, 30)); return realResolve(media); };

  const p = game.startQuestion(0);
  game.destroy(); // torn down while question 0's media is still resolving
  await assert.doesNotReject(() => p);
  sb.ctx.resolveMediaUrls = realResolve;
}, { loader: loadGameSandbox });

test('reconnect: a known pid never leaves two live entries in players', (sb) => {
  const quiz = {
    title: 'T',
    questions: [{ type: 'mc', text: 'Q', media: sb.emptyMedia(), time: 20, points: 'standard', answers: [{ text: 'A', correct: true }, { text: 'B', correct: false }] }],
  };
  const game = new sb.HostGame(quiz);
  const connA = fakeConn('connA');
  game.handleJoin(connA, { name: 'Alice', pid: 'pid-1' });
  assert.strictEqual(game.players.size, 1);
  const state = game.players.get('connA');
  state.score = 500; state.streak = 2; // simulate progress earned before the drop

  /* connA is never closed here — simulating a half-dead connection that
     never fires its own 'close' event — while the same pid reconnects on a
     brand-new connection. */
  const connB = fakeConn('connB');
  game.handleJoin(connB, { name: 'Alice', pid: 'pid-1' });

  assert.strictEqual(game.players.size, 1, 'the stale connA entry must be removed on reconnect');
  assert.ok(!game.players.has('connA'), 'the old connectionId must no longer be present');
  assert.ok(game.players.has('connB'), 'the new connectionId must be installed');
  const newState = game.players.get('connB');
  assert.strictEqual(newState.score, 500, 'score must survive the reconnect');
  assert.strictEqual(newState.streak, 2, 'streak must survive the reconnect');
  assert.strictEqual(connA.open, false, 'the stale connection must be closed');

  /* The stale connection's close handler (js/host.js onConnection) is keyed
     by *its own* connectionId, so it can never remove the new entry even if
     it fires late. */
  assert.ok(game.players.delete('connA') === false, 'connA was already removed, deleting it again is a no-op');
  assert.strictEqual(game.players.size, 1);
  assert.ok(game.players.has('connB'));
}, { loader: loadGameSandbox });

test('reconnect: an unrelated player already in the game is unaffected', (sb) => {
  const quiz = {
    title: 'T',
    questions: [{ type: 'mc', text: 'Q', media: sb.emptyMedia(), time: 20, points: 'standard', answers: [{ text: 'A', correct: true }, { text: 'B', correct: false }] }],
  };
  const game = new sb.HostGame(quiz);
  game.handleJoin(fakeConn('bobConn'), { name: 'Bob', pid: 'pid-bob' });
  game.handleJoin(fakeConn('aliceConn1'), { name: 'Alice', pid: 'pid-alice' });
  game.handleJoin(fakeConn('aliceConn2'), { name: 'Alice', pid: 'pid-alice' }); // Alice reconnects

  assert.strictEqual(game.players.size, 2);
  assert.ok(game.players.has('bobConn'), 'Bob must be untouched by Alice reconnecting');
  assert.ok(!game.players.has('aliceConn1'));
  assert.ok(game.players.has('aliceConn2'));
}, { loader: loadGameSandbox });

test('reconnect: repeated reconnects of the same pid still leave exactly one entry', (sb) => {
  const quiz = {
    title: 'T',
    questions: [{ type: 'mc', text: 'Q', media: sb.emptyMedia(), time: 20, points: 'standard', answers: [{ text: 'A', correct: true }, { text: 'B', correct: false }] }],
  };
  const game = new sb.HostGame(quiz);
  for (let i = 0; i < 5; i++) {
    game.handleJoin(fakeConn('conn' + i), { name: 'Alice', pid: 'pid-1' });
  }
  assert.strictEqual(game.players.size, 1);
  assert.ok(game.players.has('conn4'));
}, { loader: loadGameSandbox });

/* ================= regression: host-side submission sanitization (issue #1) ================= */
/* handleAnswer() is called directly with hostile/malformed payloads — the
   phone's own HTML controls (maxlength, range, a disabled button) are not
   validation, so the host must never trust d.a as-is. */

function mkPlayer(conn) {
  return { conn, pid: null, name: 'X', score: 0, streak: 0, submission: null, answerMs: 0, joinedAtQ: -1 };
}

/* A permanent second player who never answers keeps checkAllAnswered() from
   ever completing, so a valid answer in these tests can't trigger a
   fire-and-forget endQuestion() (which would flip `phase` away from
   'question' mid-test, and — for image-pin — touch real IndexedDB). */
function addNonAnsweringDummy(game) {
  game.players.set('dummy', mkPlayer(fakeConn('dummy')));
}

test('handleAnswer/mc: rejects NaN/Infinity/strings/objects/negative/out-of-range indexes', (sb) => {
  const quiz = { title: 'T', questions: [{ type: 'mc', text: 'Q', media: sb.emptyMedia(), time: 20, points: 'standard', answers: [{ text: 'A', correct: true }, { text: 'B', correct: false }] }] };
  const game = new sb.HostGame(quiz);
  addNonAnsweringDummy(game);
  game.qIndex = 0; game.phase = 'question'; game.qStartedAt = Date.now();
  const conn = fakeConn('c1');
  for (const bad of [NaN, Infinity, -Infinity, 'x', {}, [], -1, 2, 1.5, null, undefined]) {
    const p = mkPlayer(conn);
    game.players.set('c1', p);
    game.handleAnswer(conn, { t: 'a', i: 0, a: { c: bad } });
    assert.strictEqual(p.submission, null, `mc must reject c=${JSON.stringify(bad)}`);
  }
  const good = mkPlayer(conn);
  game.players.set('c1', good);
  game.handleAnswer(conn, { t: 'a', i: 0, a: { c: 1 } });
  jsonEqual(good.submission, { c: 1 });
}, { loader: loadGameSandbox });

test('handleAnswer/tf & poll & scale: same tile-index rules as mc', (sb) => {
  const quiz = {
    title: 'T',
    questions: [
      { type: 'tf', text: 'Q1', media: sb.emptyMedia(), time: 20, points: 'standard', correct: true },
      { type: 'poll', text: 'Q2', media: sb.emptyMedia(), time: 20, points: 'none', options: [{ text: 'A' }, { text: 'B' }, { text: 'C' }] },
      { type: 'scale', text: 'Q3', media: sb.emptyMedia(), time: 20, points: 'none', min: 3, max: 7, lowLabel: '', highLabel: '' },
    ],
  };
  const game = new sb.HostGame(quiz);
  addNonAnsweringDummy(game);
  const conn = fakeConn('c1');

  game.qIndex = 0; game.phase = 'question'; game.qStartedAt = Date.now();
  for (const bad of [2, -1, 'x', {}]) {
    const p = mkPlayer(conn); game.players.set('c1', p);
    game.handleAnswer(conn, { t: 'a', i: 0, a: { c: bad } });
    assert.strictEqual(p.submission, null, `tf must reject c=${JSON.stringify(bad)}`);
  }

  game.qIndex = 1; game.phase = 'question'; game.qStartedAt = Date.now();
  const pollBad = mkPlayer(conn); game.players.set('c1', pollBad);
  game.handleAnswer(conn, { t: 'a', i: 1, a: { c: 99 } });
  assert.strictEqual(pollBad.submission, null);

  game.qIndex = 2; game.phase = 'question'; game.qStartedAt = Date.now();
  const scaleBad = mkPlayer(conn); game.players.set('c1', scaleBad);
  game.handleAnswer(conn, { t: 'a', i: 2, a: { c: 5 } }); // scale has only 5 tiles (indexes 0..4)
  assert.strictEqual(scaleBad.submission, null);
  const scaleGood = mkPlayer(conn); game.players.set('c1', scaleGood);
  game.handleAnswer(conn, { t: 'a', i: 2, a: { c: 4 } });
  jsonEqual(scaleGood.submission, { c: 4 });
}, { loader: loadGameSandbox });

test('handleAnswer/order: exact length, integer indexes in range, no duplicates', (sb) => {
  const quiz = { title: 'T', questions: [{ type: 'order', text: 'Q', media: sb.emptyMedia(), time: 20, points: 'standard', items: [{ text: 'A' }, { text: 'B' }, { text: 'C' }] }] };
  const game = new sb.HostGame(quiz);
  addNonAnsweringDummy(game);
  game.qIndex = 0; game.phase = 'question'; game.qStartedAt = Date.now();
  const conn = fakeConn('c1');
  const hostile = [
    'not-an-array', { 0: 0, 1: 1, 2: 2 }, [0, 1], [0, 1, 2, 3], [0, 1, 1],
    [0, 1, '2'], [0, 1, 99], [0, -1, 2], [0.5, 1, 2], null,
  ];
  for (const bad of hostile) {
    const p = mkPlayer(conn); game.players.set('c1', p);
    game.handleAnswer(conn, { t: 'a', i: 0, a: { order: bad } });
    assert.strictEqual(p.submission, null, `order must reject ${JSON.stringify(bad)}`);
  }
  const good = mkPlayer(conn); game.players.set('c1', good);
  game.handleAnswer(conn, { t: 'a', i: 0, a: { order: [2, 0, 1] } });
  jsonEqual(good.submission, { order: [2, 0, 1] });
}, { loader: loadGameSandbox });

test('handleAnswer/typed & wordcloud & open: only real strings, coerced and capped to the phone\'s own limits', (sb) => {
  const quiz = {
    title: 'T',
    questions: [
      { type: 'typed', text: 'Q1', media: sb.emptyMedia(), time: 20, points: 'standard', accepted: ['answer'] },
      { type: 'wordcloud', text: 'Q2', media: sb.emptyMedia(), time: 20, points: 'none' },
      { type: 'open', text: 'Q3', media: sb.emptyMedia(), time: 20, points: 'none' },
    ],
  };
  const game = new sb.HostGame(quiz);
  const conn = fakeConn('c1');

  game.qIndex = 0; game.phase = 'question'; game.qStartedAt = Date.now();
  for (const bad of [{}, [], 123, null, undefined, true]) {
    const p = mkPlayer(conn); game.players.set('c1', p);
    game.handleAnswer(conn, { t: 'a', i: 0, a: { text: bad } });
    assert.strictEqual(p.submission, null, `typed must reject text=${JSON.stringify(bad)}`);
  }
  const longTyped = mkPlayer(conn); game.players.set('c1', longTyped);
  game.handleAnswer(conn, { t: 'a', i: 0, a: { text: 'x'.repeat(500) } });
  assert.strictEqual(longTyped.submission.text.length, 60, 'typed must cap to the phone\'s 60-char maxlength');

  game.qIndex = 1; game.phase = 'question'; game.qStartedAt = Date.now();
  const wcBad = mkPlayer(conn); game.players.set('c1', wcBad);
  game.handleAnswer(conn, { t: 'a', i: 1, a: { text: {} } });
  assert.strictEqual(wcBad.submission, null);
  const wcLong = mkPlayer(conn); game.players.set('c1', wcLong);
  game.handleAnswer(conn, { t: 'a', i: 1, a: { text: 'y'.repeat(500) } });
  assert.strictEqual(wcLong.submission.text.length, 24, 'word cloud must cap to 24 characters');

  game.qIndex = 2; game.phase = 'question'; game.qStartedAt = Date.now();
  const openBad = mkPlayer(conn); game.players.set('c1', openBad);
  game.handleAnswer(conn, { t: 'a', i: 2, a: { text: [] } });
  assert.strictEqual(openBad.submission, null);
  const openLong = mkPlayer(conn); game.players.set('c1', openLong);
  game.handleAnswer(conn, { t: 'a', i: 2, a: { text: 'z'.repeat(1000) } });
  assert.strictEqual(openLong.submission.text.length, 240, 'open-ended must cap to 240 characters');
}, { loader: loadGameSandbox });

test('handleAnswer/slider: rejects non-numbers/NaN/Infinity, clamps out-of-range to min/max', (sb) => {
  const quiz = { title: 'T', questions: [{ type: 'slider', text: 'Q', media: sb.emptyMedia(), time: 20, points: 'standard', min: 0, max: 10, step: 1, correct: 5 }] };
  const game = new sb.HostGame(quiz);
  addNonAnsweringDummy(game);
  game.qIndex = 0; game.phase = 'question'; game.qStartedAt = Date.now();
  const conn = fakeConn('c1');
  for (const bad of ['5', {}, [], NaN, Infinity, -Infinity, null, undefined, true]) {
    const p = mkPlayer(conn); game.players.set('c1', p);
    game.handleAnswer(conn, { t: 'a', i: 0, a: { value: bad } });
    assert.strictEqual(p.submission, null, `slider must reject value=${JSON.stringify(bad)}`);
  }
  const over = mkPlayer(conn); game.players.set('c1', over);
  game.handleAnswer(conn, { t: 'a', i: 0, a: { value: 999 } });
  assert.strictEqual(over.submission.value, 10, 'out-of-range value must be clamped to max');
  const under = mkPlayer(conn); game.players.set('c1', under);
  game.handleAnswer(conn, { t: 'a', i: 0, a: { value: -999 } });
  assert.strictEqual(under.submission.value, 0, 'out-of-range value must be clamped to min');
}, { loader: loadGameSandbox });

test('handleAnswer/imagepin: requires finite numeric x/y, constrains both to [0,1]', (sb) => {
  const quiz = { title: 'T', questions: [{ type: 'imagepin', text: 'Q', media: { image: 'img1', video: null, audio: null }, time: 20, points: 'standard', pin: { x: 0.5, y: 0.5 }, tolerance: 0.1 }] };
  const game = new sb.HostGame(quiz);
  addNonAnsweringDummy(game);  // also matters here: a valid answer would otherwise trigger endQuestion -> resolveMediaUrls -> real IndexedDB
  game.qIndex = 0; game.phase = 'question'; game.qStartedAt = Date.now();
  const conn = fakeConn('c1');
  for (const bad of [{ x: '0.5', y: 0.5 }, { x: NaN, y: 0.5 }, { x: Infinity, y: 0.5 }, { x: {}, y: 0.5 }, { x: 0.5 }, {}]) {
    const p = mkPlayer(conn); game.players.set('c1', p);
    game.handleAnswer(conn, { t: 'a', i: 0, a: bad });
    assert.strictEqual(p.submission, null, `imagepin must reject ${JSON.stringify(bad)}`);
  }
  const over = mkPlayer(conn); game.players.set('c1', over);
  game.handleAnswer(conn, { t: 'a', i: 0, a: { x: 5, y: -5 } });
  jsonEqual(over.submission, { x: 1, y: 0 }, 'out-of-range coordinates must be clamped to [0,1]');
}, { loader: loadGameSandbox });

test('handleAnswer: every type rejects pure garbage without throwing or storing anything', (sb) => {
  for (const type of sb.QUESTION_TYPE_LIST) {
    const quiz = { title: 'T', questions: [{ type, text: 'Q', media: type === 'imagepin' ? { image: 'img1', video: null, audio: null } : sb.emptyMedia(), time: 20, points: 'standard', ...sb.QuestionTypes[type].defaults() }] };
    const game = new sb.HostGame(quiz);
    game.qIndex = 0; game.phase = 'question'; game.qStartedAt = Date.now();
    const conn = fakeConn('c1');
    const p = mkPlayer(conn);
    game.players.set('c1', p);
    for (const garbage of [42, 'str', [1, 2, 3], { c: {}, order: 'x', text: {}, value: {}, x: {}, y: {} }, null]) {
      assert.doesNotThrow(() => game.handleAnswer(conn, { t: 'a', i: 0, a: garbage }), `${type} handleAnswer threw on ${JSON.stringify(garbage)}`);
    }
    assert.strictEqual(p.submission, null, `${type} must not have stored any garbage submission`);
  }
}, { loader: loadGameSandbox });

test('handleAnswer: a rejected submission still leaves endQuestion/hostReveal safe to run', async (sb) => {
  const quiz = { title: 'T', questions: [{ type: 'mc', text: 'Q', media: sb.emptyMedia(), time: 20, points: 'standard', answers: [{ text: 'A', correct: true }, { text: 'B', correct: false }] }] };
  const game = new sb.HostGame(quiz);
  game.qIndex = 0; game.phase = 'question'; game.qStartedAt = Date.now();
  const conn = fakeConn('c1');
  const p = mkPlayer(conn);
  game.players.set('c1', p);
  game.handleAnswer(conn, { t: 'a', i: 0, a: { c: 'garbage' } });
  assert.strictEqual(p.submission, null);
  await assert.doesNotReject(() => game.endQuestion());
  game.destroy();
}, { loader: loadGameSandbox });

/* ================= regression: image-pin preload/ready protocol (issue #2) ================= */

function imagepinQuiz() {
  return { title: 'T', questions: [{ type: 'imagepin', text: 'Q', media: { image: 'img1', video: null, audio: null }, time: 20, points: 'standard', pin: { x: 0.5, y: 0.5 }, tolerance: 0.1 }] };
}

/* startQuestion resolves BOTH the host's own display media (resolveMediaUrls
   -> getMediaUrl, an object URL) and the player's payload (resolvePlayerCtx
   -> mediaToDataUrl, a data: URL) — both touch IndexedDB for a real image id,
   so both need stubbing to keep these tests headless. */
function stubImagepinMedia(sb) {
  sb.ctx.mediaToDataUrl = async () => 'data:image/png;base64,FAKE';
  sb.ctx.getMediaUrl = async () => 'blob:fake-host-url';
}

test('imagepin: startQuestion waits for a READY ack before starting the clock', async (sb) => {
  stubImagepinMedia(sb);
  const game = new sb.HostGame(imagepinQuiz());
  game.preloadTimeoutMs = 5000;  // long enough that only an explicit ready, not the timeout, should resolve this
  const conn = fakeConn('c1');
  game.players.set('c1', mkPlayer(conn));

  const p = game.startQuestion(0);
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(game.qStartedAt, undefined, 'must not start the clock before the ready ack arrives');

  game.handleReady(conn, { i: 0 });
  await p;
  game.destroy();
  assert.ok(Number.isFinite(game.qStartedAt), 'clock should start once the ack arrives');
}, { loader: loadGameSandbox });

test('imagepin: proceeds after a timeout if a player never acknowledges', async (sb) => {
  stubImagepinMedia(sb);
  const game = new sb.HostGame(imagepinQuiz());
  game.preloadTimeoutMs = 50;  // short, for the test
  game.players.set('c1', mkPlayer(fakeConn('c1')));
  const before = Date.now();
  await game.startQuestion(0);
  game.destroy();
  assert.ok(Date.now() - before >= 45, 'should wait roughly the timeout before proceeding without the ack');
  assert.ok(Number.isFinite(game.qStartedAt));
}, { loader: loadGameSandbox });

test('mc: startQuestion never incurs the image-pin preload/ready wait', async (sb) => {
  const quiz = { title: 'T', questions: [{ type: 'mc', text: 'Q', media: sb.emptyMedia(), time: 20, points: 'standard', answers: [{ text: 'A', correct: true }, { text: 'B', correct: false }] }] };
  const game = new sb.HostGame(quiz);
  game.preloadTimeoutMs = 5000;  // if mc wrongly entered the wait path, this test would be slow
  game.players.set('c1', mkPlayer(fakeConn('c1')));
  const before = Date.now();
  await game.startQuestion(0);
  game.destroy();
  assert.ok(Date.now() - before < 200, 'a normal question type must not wait for any preload ack');
}, { loader: loadGameSandbox });

test('imagepin: a stale READY for a different question index is ignored', async (sb) => {
  stubImagepinMedia(sb);
  const game = new sb.HostGame(imagepinQuiz());
  game.preloadTimeoutMs = 5000;
  const conn = fakeConn('c1');
  game.players.set('c1', mkPlayer(conn));

  const p = game.startQuestion(0);
  await new Promise(r => setTimeout(r, 20));
  game.handleReady(conn, { i: 99 });  // stale/irrelevant index
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(game.qStartedAt, undefined, 'a ready ack for a different index must not resolve the wait');

  game.handleReady(conn, { i: 0 });  // the real one
  await p;
  game.destroy();
  assert.ok(Number.isFinite(game.qStartedAt));
}, { loader: loadGameSandbox });

test('preload/ready: a disconnect during the wait is dropped from pending, not left to time out', async (sb) => {
  stubImagepinMedia(sb);
  const game = new sb.HostGame(imagepinQuiz());
  game.preloadTimeoutMs = 5000;
  const connA = fakeConn('connA'), connB = fakeConn('connB');
  game.players.set('connA', mkPlayer(connA));
  game.players.set('connB', mkPlayer(connB));

  const p = game.startQuestion(0);
  await new Promise(r => setTimeout(r, 20));
  game.removeFromPendingReady('connA');  // simulate connA's own close handler firing
  game.handleReady(connB, { i: 0 });
  await p;
  game.destroy();
  assert.ok(Number.isFinite(game.qStartedAt), 'should proceed once the only remaining eligible player acks');
}, { loader: loadGameSandbox });

/* ---------- runner ---------- */

async function runTests() {
  let pass = 0, fail = 0;
  for (const { name, fn, loader } of tests) {
    const sandbox = loader();  // fresh state per test — no cross-test leakage
    try {
      await fn(sandbox);  // awaiting a non-promise return resolves immediately, so sync tests are unaffected
      pass++;
      console.log(`  ok  - ${name}`);
    } catch (err) {
      fail++;
      console.log(`FAIL  - ${name}`);
      console.log('        ' + err.message);
    }
  }
  console.log(`\n${pass} passed, ${fail} failed, ${tests.length} total`);
  process.exit(fail ? 1 : 0);
}

runTests();
