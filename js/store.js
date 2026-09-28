'use strict';

const LS_KEY = 'quizparty.quizzes.v1';

function emptyMedia() { return { image: null, video: null, audio: null }; }

function sampleQuiz() {
  const q = (text, answers, correct, time = 20) => ({
    type: 'mc', text, media: emptyMedia(), time, points: 'standard',
    answers: answers.map((a, i) => ({ text: a, correct: correct.includes(i) })),
  });
  return {
    id: uid(),
    title: 'Demo: General Knowledge',
    questions: [
      q('What is the largest planet in our solar system?', ['Jupiter', 'Saturn', 'Earth', 'Neptune'], [0]),
      q('Which of these are primary colors of light?', ['Red', 'Green', 'Yellow', 'Blue'], [0, 1, 3]),
      { type: 'tf', text: 'The Great Wall of China is visible from space with the naked eye.', media: emptyMedia(), time: 10, points: 'standard', correct: false },
      q('How many continents are there?', ['5', '6', '7', '8'], [2], 10),
      { type: 'poll', text: 'Which topic should we cover next?', media: emptyMedia(), time: 20, points: 'none', options: [{ text: 'History' }, { text: 'Science' }, { text: 'Geography' }] },
      q('Which language runs natively in web browsers?', ['Python', 'JavaScript', 'C++', 'Java'], [1]),
    ],
  };
}

/* Fills in fields added after a quiz was first saved, so quizzes created by
   earlier versions of QuizParty keep working unchanged. */
function migrateQuiz(quiz) {
  quiz.questions.forEach(q => {
    if (!q.type || !QuestionTypes[q.type]) q.type = 'mc';
    if (!q.media) q.media = emptyMedia();
  });
  return quiz;
}

function getQuizzes() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw).map(migrateQuiz);
  } catch (e) { /* corrupted storage — reseed */ }
  const seed = [sampleQuiz()];
  saveQuizzes(seed);
  return seed;
}

function saveQuizzes(quizzes) {
  localStorage.setItem(LS_KEY, JSON.stringify(quizzes));
}

function getQuiz(id) {
  return getQuizzes().find(q => q.id === id) || null;
}

function upsertQuiz(quiz) {
  const all = getQuizzes();
  const i = all.findIndex(q => q.id === quiz.id);
  if (i >= 0) all[i] = quiz; else all.push(quiz);
  saveQuizzes(all);
}

function deleteQuiz(id) {
  saveQuizzes(getQuizzes().filter(q => q.id !== id));
}

function blankQuestion(type) {
  const t = QuestionTypes[type] ? type : 'mc';
  return { type: t, text: '', media: emptyMedia(), time: 20, points: 'standard', ...QuestionTypes[t].defaults() };
}

/* Switches a question to a different type, keeping the fields common to every
   type and discarding the old type's own fields (they'd be meaningless under
   the new type anyway). */
function retypeQuestion(q, newType) {
  const t = QuestionTypes[newType] ? newType : 'mc';
  return { type: t, text: q.text, media: q.media, time: q.time, points: q.points, ...QuestionTypes[t].defaults() };
}

function newQuiz() {
  return { id: uid(), title: '', questions: [blankQuestion('mc')] };
}

/* Returns a list of human-readable problems; empty list = ready to host. */
function validateQuiz(quiz) {
  const problems = [];
  if (!quiz.title.trim()) problems.push('• The quiz needs a title.');
  if (!quiz.questions.length) problems.push('• Add at least one question.');
  quiz.questions.forEach((q, i) => {
    const n = i + 1;
    if (!q.text.trim()) problems.push(`• Question ${n} has no text.`);
    questionTypeOf(q).validate(q).forEach(msg => problems.push(`• Question ${n} ${msg}.`));
  });
  return problems;
}

/* Cleans up each question before playing/exporting (e.g. strips empty answer slots). */
function normalizeQuiz(quiz) {
  return { ...quiz, questions: quiz.questions.map(q => questionTypeOf(q).normalize(q)) };
}

function collectMediaIds(quiz) {
  const ids = [];
  quiz.questions.forEach(q => {
    if (q.media) Object.values(q.media).forEach(id => { if (id) ids.push(id); });
  });
  return ids;
}

/* Clones an imported field, but only if it's at least the right *shape* as
   the type's default for that field (array vs. array, plain object vs.
   plain object) — a malformed field (e.g. a string where `answers` should
   be an array) falls back to the default instead of reaching host/player
   code that assumes the real shape. */
function safeClone(value, fallback) {
  try {
    const cloned = JSON.parse(JSON.stringify(value));
    if (cloned === undefined) return fallback;
    if (Array.isArray(fallback)) return Array.isArray(cloned) ? cloned : fallback;
    if (fallback && typeof fallback === 'object') {
      return (cloned && typeof cloned === 'object' && !Array.isArray(cloned)) ? cloned : fallback;
    }
    return cloned;
  } catch (e) { return fallback; }
}

/* Rebuilds a question from imported (untrusted) JSON: known type + common
   fields are sanitized individually, and every type-specific field falls back
   to that type's default shape if the imported value doesn't parse cleanly. */
function sanitizeQuestion(raw) {
  const type = QUESTION_TYPE_LIST.includes(raw && raw.type) ? raw.type : 'mc';
  const def = QuestionTypes[type].defaults();
  const q = {
    type,
    text: String((raw && raw.text) || '').slice(0, 200),
    time: [5, 10, 20, 30, 60, 90].includes(+(raw && raw.time)) ? +raw.time : 20,
    points: ['standard', 'double', 'none'].includes(raw && raw.points) ? raw.points : 'standard',
    media: emptyMedia(),
  };
  for (const key of Object.keys(def)) {
    q[key] = raw && raw[key] !== undefined ? safeClone(raw[key], def[key]) : def[key];
  }
  return q;
}

/* data: URLs referenced from a quiz's questions become local IndexedDB
   entries under fresh ids, so an imported quiz never trusts ids from the
   file (those only ever mean something in the browser that exported them). */
async function remapImportedMedia(rawMedia, idRemap) {
  const out = emptyMedia();
  if (rawMedia && typeof rawMedia === 'object') {
    for (const k of Object.keys(out)) {
      const oldId = rawMedia[k];
      if (oldId && idRemap[oldId]) out[k] = idRemap[oldId];
    }
  }
  return out;
}

async function importQuizJson(text) {
  const data = JSON.parse(text);
  if (!data || typeof data.title !== 'string' || !Array.isArray(data.questions)) {
    throw new Error('Not a QuizParty quiz file');
  }
  const idRemap = {};
  if (data.media && typeof data.media === 'object') {
    for (const [oldId, dataUrl] of Object.entries(data.media)) {
      try { idRemap[oldId] = await saveMediaFromDataUrl(dataUrl); }
      catch (e) { /* unreadable media entry — leave unmapped, question falls back to no media */ }
    }
  }
  const quiz = {
    id: uid(),
    title: String(data.title).slice(0, 80),
    questions: [],
  };
  for (const raw of data.questions) {
    const q = sanitizeQuestion(raw);
    q.media = await remapImportedMedia(raw && raw.media, idRemap);
    quiz.questions.push(q);
  }
  if (!quiz.questions.length) throw new Error('Quiz has no questions');
  return quiz;
}

/* Plain-text quizzes export exactly as before (no `media` key at all) so the
   format stays compatible with older QuizParty versions and with quizzes
   shared before media support existed. Only quizzes that actually reference
   local media gain an embedded `media` map of id -> data: URL. */
async function exportQuiz(quiz) {
  const clean = normalizeQuiz(quiz);
  delete clean.id;
  const mediaIds = collectMediaIds(clean);
  let payload = clean;
  if (mediaIds.length) {
    const media = {};
    for (const id of mediaIds) {
      const dataUrl = await mediaToDataUrl(id);
      if (dataUrl) media[id] = dataUrl;
    }
    payload = { ...clean, media };
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (quiz.title.trim() || 'quiz').replace(/[^\w\- ]+/g, '').replace(/ +/g, '-').toLowerCase() + '.quizparty.json';
  a.click();
  URL.revokeObjectURL(a.href);
}
