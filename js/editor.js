'use strict';

/* Quiz editor. Edits `edQuiz` in place and auto-saves to localStorage on every change. */
let edQuiz = null;
let edIndex = 0;

function renderEditor(quizId) {
  edQuiz = getQuiz(quizId);
  if (!edQuiz) { location.hash = 'library'; return; }
  edIndex = 0;
  showView('view-editor');
  $('#ed-title').value = edQuiz.title;
  edRenderTabs();
  edRenderQuestion();
}

function edSave() {
  if (edQuiz) upsertQuiz(edQuiz);
}

function edRenderTabs() {
  $('#ed-qlist').innerHTML = edQuiz.questions.map((q, i) => `
    <button class="q-tab ${i === edIndex ? 'sel' : ''}" data-i="${i}">
      <small>${i + 1}</small>${esc(q.text.trim() || 'Untitled question')}
    </button>`).join('');
}

function edRenderQuestion() {
  const q = edQuiz.questions[edIndex];
  if (!q) return;
  $('#ed-qlabel').textContent = `Question ${edIndex + 1} of ${edQuiz.questions.length}`;
  $('#ed-qtext').value = q.text;
  $('#ed-qtime').value = String(q.time);
  $('#ed-qpoints').value = q.points;
  $('#ed-answers').innerHTML = q.answers.map((a, i) => `
    <div class="ans-row" data-i="${i}">
      <div class="ans-swatch c${i}">${SHAPES[i]}</div>
      <input type="text" maxlength="100" placeholder="Answer ${i + 1}${i >= 2 ? ' (optional)' : ''}" value="${esc(a.text)}">
      <input type="checkbox" title="Correct answer" ${a.correct ? 'checked' : ''}>
      ${q.answers.length > 2 ? '<button class="btn sm" data-act="rm" title="Remove">✕</button>' : ''}
    </div>`).join('');
  $('#ed-adda').style.display = q.answers.length < 4 ? '' : 'none';
}

function initEditorEvents() {
  $('#ed-title').addEventListener('input', e => {
    if (!edQuiz) return;
    edQuiz.title = e.target.value;
    edSave();
  });

  $('#ed-qlist').addEventListener('click', e => {
    const tab = e.target.closest('.q-tab');
    if (!tab) return;
    edIndex = +tab.dataset.i;
    edRenderTabs();
    edRenderQuestion();
  });

  $('#ed-addq').addEventListener('click', () => {
    edQuiz.questions.push(blankQuestion());
    edIndex = edQuiz.questions.length - 1;
    edSave(); edRenderTabs(); edRenderQuestion();
  });

  $('#ed-qtext').addEventListener('input', e => {
    edQuiz.questions[edIndex].text = e.target.value;
    edSave(); edRenderTabs();
  });
  $('#ed-qtime').addEventListener('change', e => {
    edQuiz.questions[edIndex].time = +e.target.value;
    edSave();
  });
  $('#ed-qpoints').addEventListener('change', e => {
    edQuiz.questions[edIndex].points = e.target.value;
    edSave();
  });

  $('#ed-answers').addEventListener('input', e => {
    const row = e.target.closest('.ans-row');
    if (!row) return;
    const a = edQuiz.questions[edIndex].answers[+row.dataset.i];
    if (e.target.type === 'text') a.text = e.target.value;
    if (e.target.type === 'checkbox') a.correct = e.target.checked;
    edSave();
  });
  $('#ed-answers').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act="rm"]');
    if (!btn) return;
    const row = btn.closest('.ans-row');
    edQuiz.questions[edIndex].answers.splice(+row.dataset.i, 1);
    edSave(); edRenderQuestion();
  });
  $('#ed-adda').addEventListener('click', () => {
    const q = edQuiz.questions[edIndex];
    if (q.answers.length < 4) q.answers.push({ text: '', correct: false });
    edSave(); edRenderQuestion();
  });

  $('#ed-qup').addEventListener('click', () => edMoveQuestion(-1));
  $('#ed-qdown').addEventListener('click', () => edMoveQuestion(1));
  $('#ed-qdup').addEventListener('click', () => {
    const copy = JSON.parse(JSON.stringify(edQuiz.questions[edIndex]));
    edQuiz.questions.splice(edIndex + 1, 0, copy);
    edIndex++;
    edSave(); edRenderTabs(); edRenderQuestion();
  });
  $('#ed-qdel').addEventListener('click', () => {
    if (edQuiz.questions.length === 1) {
      edQuiz.questions[0] = blankQuestion();
    } else {
      edQuiz.questions.splice(edIndex, 1);
      edIndex = Math.min(edIndex, edQuiz.questions.length - 1);
    }
    edSave(); edRenderTabs(); edRenderQuestion();
  });

  $('#ed-export').addEventListener('click', () => exportQuiz(edQuiz));
  $('#ed-host').addEventListener('click', () => { location.hash = 'host/' + edQuiz.id; });
}

function edMoveQuestion(dir) {
  const to = edIndex + dir;
  if (to < 0 || to >= edQuiz.questions.length) return;
  const [q] = edQuiz.questions.splice(edIndex, 1);
  edQuiz.questions.splice(to, 0, q);
  edIndex = to;
  edSave(); edRenderTabs(); edRenderQuestion();
}
