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

/* Every {id, kind} a quiz's questions reference — the kind comes from which
   slot (image/video/audio) the id is stored under, which is also the
   expected kind for validating that blob's actual MIME (see exportQuiz). */
function collectMediaRefs(quiz) {
  const refs = [];
  quiz.questions.forEach(q => {
    if (!q.media) return;
    for (const kind of ['image', 'video', 'audio']) {
      if (q.media[kind]) refs.push({ id: q.media[kind], kind });
    }
  });
  return refs;
}

function collectMediaIds(quiz) {
  return collectMediaRefs(quiz).map(r => r.id);
}

/* ---------- media lifecycle (garbage-collecting IndexedDB blobs) ----------
   A media id can be shared by more than one question (duplicating a
   question copies its media ids) or, in principle, by more than one quiz,
   so "unused" is always "not referenced by anything currently stored" —
   never inferred from a single edit in isolation. Callers save their own
   change first (upsertQuiz/deleteQuiz) so this check reflects the post-edit
   truth; these are the only place that decides whether a blob gets deleted,
   so callers should use them rather than calling deleteMedia() directly. */

function isMediaReferenced(mediaId) {
  if (!mediaId) return false;
  return getQuizzes().some(quiz => collectMediaIds(quiz).includes(mediaId));
}

/* Deletes a media blob if (and only if) nothing stored references it
   anymore. Cleanup is a nonfatal, best-effort step: the caller's own save/
   delete has already succeeded by the time this runs, and a failure here
   (e.g. IndexedDB unavailable) is only logged, never thrown. */
async function releaseMediaIfUnused(mediaId) {
  if (!mediaId) return;
  try {
    if (!isMediaReferenced(mediaId)) await deleteMedia(mediaId);
  } catch (e) {
    console.warn('QuizParty: could not clean up unused media', mediaId, e);
  }
}

/* Convenience for releasing several ids at once, e.g. every media id a
   deleted question or quiz held. */
async function releaseUnusedMedia(mediaIds) {
  for (const id of mediaIds || []) await releaseMediaIfUnused(id);
}

/* A quiz file is fully untrusted input — cap how much of it we'll ever
   process, independent of any per-field limits below. */
const MAX_IMPORT_QUESTIONS = 200;

/* Rebuilds a question from imported (untrusted) JSON. Common fields are
   coerced to their expected primitive type and length; every type-specific
   field is rebuilt from scratch by that type's own sanitize() (js/qtypes.js)
   using only trusted primitives — never a structural clone of the input —
   so a malformed nested value (wrong type, oversized array, NaN, an object
   where text is expected, ...) can't reach validate()/normalize()/rendering
   in a shape they don't expect. `media` is intentionally left empty here;
   it's filled in separately by remapImportedMedia() once the caller knows
   which media ids are actually referenced and safe to import (see
   importQuizJson). */
function sanitizeQuestion(raw) {
  const type = QUESTION_TYPE_LIST.includes(raw && raw.type) ? raw.type : 'mc';
  return {
    type,
    text: safeText(raw && raw.text, 200),
    time: [5, 10, 20, 30, 60, 90].includes(+(raw && raw.time)) ? +raw.time : 20,
    points: ['standard', 'double', 'none'].includes(raw && raw.points) ? raw.points : 'standard',
    media: emptyMedia(),
    ...QuestionTypes[type].sanitize(raw),
  };
}

/* Every media id a raw (pre-sanitize) question references, mapped to the
   slot (image/video/audio) it's referenced from — used so import only ever
   decodes media that's actually reachable from a real question (not just
   anything listed in the file's `media` map), and validated against the
   MIME/size limit for that specific slot's kind (see importMedia). The
   first slot seen for a given id wins if a hostile file reuses one id
   across different kinds. */
function referencedRawMediaIds(rawQuestions) {
  const kindById = new Map();
  for (const raw of rawQuestions) {
    const media = raw && raw.media;
    if (!media || typeof media !== 'object') continue;
    for (const kind of ['image', 'video', 'audio']) {
      const id = media[kind];
      if (typeof id === 'string' && id && !kindById.has(id)) kindById.set(id, kind);
    }
  }
  return kindById;
}

/* data: URLs referenced from a quiz's questions become local IndexedDB
   entries under fresh ids, so an imported quiz never trusts ids from the
   file (those only ever mean something in the browser that exported them). */
function remapImportedMedia(rawMedia, idRemap) {
  const out = emptyMedia();
  if (rawMedia && typeof rawMedia === 'object') {
    for (const k of Object.keys(out)) {
      const oldId = rawMedia[k];
      if (oldId && idRemap[oldId]) out[k] = idRemap[oldId];
    }
  }
  return out;
}

/* Decodes and stores only the media entries that sanitized questions
   actually reference, each gated by isSafeMediaDataUrl for the SLOT it's
   referenced from (data: URL only, MIME must match that slot's kind,
   size-capped per kind — see MEDIA_LIMITS in js/media.js) and bounded by an
   overall count/size budget so an import can't be used to smuggle
   unbounded or unreferenced blobs into IndexedDB. Never touches the
   network: a rejected/oversized/wrong-MIME/non-data: entry is just skipped,
   and the rest of the quiz still imports. Returns oldId -> newId. */
async function importMedia(rawMediaMap, kindById) {
  const idRemap = {};
  if (!rawMediaMap || typeof rawMediaMap !== 'object') return idRemap;
  let totalBytes = 0, count = 0;
  for (const [oldId, kind] of kindById) {
    if (count >= MEDIA_IMPORT_MAX_ITEMS || totalBytes >= MEDIA_IMPORT_MAX_TOTAL_BYTES) break;
    if (!Object.prototype.hasOwnProperty.call(rawMediaMap, oldId)) continue;
    const dataUrl = rawMediaMap[oldId];
    const parsed = parseDataUrl(dataUrl);
    if (!parsed || mediaKindForMime(parsed.mime) !== kind || parsed.decodedBytes > MEDIA_LIMITS[kind].maxBytes) continue;
    if (totalBytes + parsed.decodedBytes > MEDIA_IMPORT_MAX_TOTAL_BYTES) continue;
    try {
      idRemap[oldId] = await saveMediaFromDataUrl(dataUrl, kind);
      totalBytes += parsed.decodedBytes;
      count++;
    } catch (e) { /* unreadable media entry — omit it, keep importing the rest */ }
  }
  return idRemap;
}

async function importQuizJson(text) {
  const data = JSON.parse(text);
  if (!data || typeof data.title !== 'string' || !Array.isArray(data.questions)) {
    throw new Error('Not a QuizParty quiz file');
  }
  const rawQuestions = data.questions.slice(0, MAX_IMPORT_QUESTIONS);
  const idRemap = await importMedia(data.media, referencedRawMediaIds(rawQuestions));

  const quiz = {
    id: uid(),
    title: safeText(data.title, 80),
    questions: rawQuestions.map(raw => {
      const q = sanitizeQuestion(raw);
      q.media = remapImportedMedia(raw && raw.media, idRemap);
      return q;
    }),
  };
  if (!quiz.questions.length) throw new Error('Quiz has no questions');

  /* Sanitization above is what actually keeps this safe; this call is a
     belt-and-suspenders proof that the sanitized output never crashes the
     same validation a normal quiz goes through before hosting. Any problems
     found (e.g. an mc question with no correct answer marked) are left for
     the user to fix in the editor, same as importing always worked. */
  validateQuiz(quiz);
  return quiz;
}

/* Plain-text quizzes export exactly as before (no `media` key at all) so the
   format stays compatible with older QuizParty versions and with quizzes
   shared before media support existed. Only quizzes that actually reference
   local media gain an embedded `media` map of id -> data: URL.

   Every item is checked against the exact same MEDIA_LIMITS/kind rules
   importMedia() will apply on the other end, so an export can never produce
   a package its own importer would later reject — anything that wouldn't
   survive that round trip is left out and the user is told plainly what and
   why, instead of it silently vanishing. */
async function exportQuiz(quiz) {
  const clean = normalizeQuiz(quiz);
  delete clean.id;
  const refs = collectMediaRefs(clean);
  let payload = clean;
  if (refs.length) {
    const media = {};
    const skipped = [];
    let totalBytes = 0;
    const done = new Set();
    for (const { id, kind } of refs) {
      if (done.has(id)) continue;  // shared media (a duplicated question) — encode once
      done.add(id);
      const blob = await getMediaBlob(id);
      const limits = MEDIA_LIMITS[kind];
      if (!blob) continue;
      if (!limits.mimes.includes(blob.type)) { skipped.push(`${kind} (unsupported type ${blob.type || 'unknown'})`); continue; }
      if (blob.size > limits.maxBytes) { skipped.push(`${kind} (over the ${(limits.maxBytes / 1024 / 1024).toFixed(0)} MB limit)`); continue; }
      if (totalBytes + blob.size > MEDIA_IMPORT_MAX_TOTAL_BYTES) { skipped.push(`${kind} (export size limit reached)`); continue; }
      media[id] = await blobToDataUrl(blob);
      totalBytes += blob.size;
    }
    if (skipped.length) {
      alert(`This export won't include ${skipped.length} media file(s) that can't be portably re-imported:\n\n` +
        skipped.map(s => '• ' + s).join('\n') +
        `\n\nEverything else — including the rest of the quiz — was exported normally. Those questions will need their media re-attached after importing elsewhere.`);
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
