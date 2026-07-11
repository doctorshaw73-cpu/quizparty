'use strict';

const LS_KEY = 'quizparty.quizzes.v1';

function sampleQuiz() {
  const q = (text, answers, correct, time = 20) => ({
    text,
    answers: answers.map((a, i) => ({ text: a, correct: correct.includes(i) })),
    time,
    points: 'standard',
  });
  return {
    id: uid(),
    title: 'Demo: General Knowledge',
    questions: [
      q('What is the largest planet in our solar system?', ['Jupiter', 'Saturn', 'Earth', 'Neptune'], [0]),
      q('Which of these are primary colors of light?', ['Red', 'Green', 'Yellow', 'Blue'], [0, 1, 3]),
      q('The Great Wall is located in…', ['Japan', 'China'], [1], 10),
      q('How many continents are there?', ['5', '6', '7', '8'], [2], 10),
      q('Which language runs natively in web browsers?', ['Python', 'JavaScript', 'C++', 'Java'], [1]),
    ],
  };
}

function getQuizzes() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw);
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

function blankQuestion() {
  return {
    text: '',
    answers: [
      { text: '', correct: false }, { text: '', correct: false },
      { text: '', correct: false }, { text: '', correct: false },
    ],
    time: 20,
    points: 'standard',
  };
}

function newQuiz() {
  return { id: uid(), title: '', questions: [blankQuestion()] };
}

/* Returns a list of human-readable problems; empty list = ready to host. */
function validateQuiz(quiz) {
  const problems = [];
  if (!quiz.title.trim()) problems.push('• The quiz needs a title.');
  if (!quiz.questions.length) problems.push('• Add at least one question.');
  quiz.questions.forEach((q, i) => {
    const n = i + 1;
    if (!q.text.trim()) problems.push(`• Question ${n} has no text.`);
    const filled = q.answers.filter(a => a.text.trim());
    if (filled.length < 2) problems.push(`• Question ${n} needs at least 2 answers.`);
    if (!q.answers.some(a => a.correct && a.text.trim())) problems.push(`• Question ${n} has no correct answer marked.`);
  });
  return problems;
}

/* Strip empty answer slots before playing/exporting. */
function normalizeQuiz(quiz) {
  return {
    ...quiz,
    questions: quiz.questions.map(q => ({
      ...q,
      answers: q.answers.filter(a => a.text.trim()),
    })),
  };
}

function importQuizJson(text) {
  const data = JSON.parse(text);
  if (!data || typeof data.title !== 'string' || !Array.isArray(data.questions)) {
    throw new Error('Not a QuizParty quiz file');
  }
  const quiz = {
    id: uid(),
    title: String(data.title).slice(0, 80),
    questions: data.questions.map(q => ({
      text: String(q.text || '').slice(0, 200),
      answers: (Array.isArray(q.answers) ? q.answers : []).slice(0, 4).map(a => ({
        text: String(a.text || '').slice(0, 100),
        correct: !!a.correct,
      })),
      time: [5, 10, 20, 30, 60, 90].includes(+q.time) ? +q.time : 20,
      points: ['standard', 'double', 'none'].includes(q.points) ? q.points : 'standard',
    })),
  };
  if (!quiz.questions.length) throw new Error('Quiz has no questions');
  return quiz;
}

function exportQuiz(quiz) {
  const clean = normalizeQuiz(quiz);
  delete clean.id;
  const blob = new Blob([JSON.stringify(clean, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (quiz.title.trim() || 'quiz').replace(/[^\w\- ]+/g, '').replace(/ +/g, '-').toLowerCase() + '.quizparty.json';
  a.click();
  URL.revokeObjectURL(a.href);
}
