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
   evaluated last captures those bindings back out as real properties. */
const EXPORTED_NAMES = [
  'QuestionTypes', 'QUESTION_TYPE_LIST', 'questionTypeOf', 'MAX_TILES', 'SHAPES', 'esc', 'clamp', 'uid',
  'validateQuiz', 'normalizeQuiz', 'blankQuestion', 'retypeQuestion', 'migrateQuiz', 'sanitizeQuestion',
  'getQuizzes', 'saveQuizzes', 'getQuiz', 'upsertQuiz', 'deleteQuiz', 'newQuiz', 'emptyMedia', 'collectMediaIds',
];

function loadSandbox() {
  const sandbox = { console };
  sandbox.localStorage = makeLocalStorage();
  vm.createContext(sandbox);
  for (const f of ['js/util.js', 'js/qtypes.js', 'js/store.js']) {
    const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    vm.runInContext(code, sandbox, { filename: f });
  }
  const bridge = `var __exports = { ${EXPORTED_NAMES.map(n => `${n}: typeof ${n} !== 'undefined' ? ${n} : undefined`).join(', ')} };`;
  vm.runInContext(bridge, sandbox, { filename: 'bridge.js' });
  return sandbox.__exports;
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
function test(name, fn) { tests.push({ name, fn }); }

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

/* ---------- runner ---------- */

let pass = 0, fail = 0;
for (const { name, fn } of tests) {
  const sandbox = loadSandbox();  // fresh state per test — no cross-test leakage
  try {
    fn(sandbox);
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
