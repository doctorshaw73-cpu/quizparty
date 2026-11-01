'use strict';

/* Hash router. Each route may register a cleanup (e.g. tear down peer connections)
   that runs before the next route renders. */
let routeCleanup = null;
function setCleanup(fn) { routeCleanup = fn; }

function route() {
  if (routeCleanup) { try { routeCleanup(); } catch (e) {} routeCleanup = null; }
  const h = decodeURIComponent(location.hash.slice(1));
  if (h === 'library') renderLibrary();
  else if (h.startsWith('editor/')) renderEditor(h.slice(7));
  else if (h.startsWith('host/')) startHost(h.slice(5));
  else if (h.startsWith('join')) renderJoin(h.split('/')[1] || '');
  else renderHome();
}

function renderHome() {
  showView('view-home');
  $('#home-pin').value = '';
}

function renderLibrary() {
  showView('view-library');
  const list = $('#lib-list');
  const quizzes = getQuizzes();
  if (!quizzes.length) {
    list.innerHTML = '<p class="empty-note">No quizzes yet — create one!</p>';
    return;
  }
  list.innerHTML = quizzes.map(q => `
    <div class="quiz-item" data-id="${q.id}">
      <div class="qi-info">
        <b>${esc(q.title.trim() || 'Untitled quiz')}</b>
        <small>${q.questions.length} question${q.questions.length === 1 ? '' : 's'}</small>
      </div>
      <button class="btn primary" data-act="host">Host ▶</button>
      <button class="btn" data-act="edit">Edit</button>
      <button class="btn" data-act="export">Export</button>
      <button class="btn danger" data-act="del">Delete</button>
    </div>`).join('');
}

function renderJoin(pin) {
  showView('view-play');
  playerShowJoinForm(pin);
}

document.addEventListener('DOMContentLoaded', () => {
  /* Home */
  const goJoin = () => {
    const pin = $('#home-pin').value.replace(/\D/g, '');
    location.hash = 'join' + (pin ? '/' + pin : '');
  };
  $('#home-join').addEventListener('click', goJoin);
  $('#home-pin').addEventListener('keydown', e => { if (e.key === 'Enter') goJoin(); });
  $('#home-host').addEventListener('click', () => { location.hash = 'library'; });

  /* Library */
  $('#lib-new').addEventListener('click', () => {
    const quiz = newQuiz();
    upsertQuiz(quiz);
    location.hash = 'editor/' + quiz.id;
  });
  $('#lib-import').addEventListener('click', () => $('#lib-file').click());
  $('#lib-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const quiz = await importQuizJson(await file.text());
      upsertQuiz(quiz);
      renderLibrary();
    } catch (err) {
      alert('Could not import: ' + err.message);
    }
  });
  $('#lib-list').addEventListener('click', async e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.closest('.quiz-item').dataset.id;
    const act = btn.dataset.act;
    if (act === 'host') location.hash = 'host/' + id;
    else if (act === 'edit') location.hash = 'editor/' + id;
    else if (act === 'export') await exportQuiz(getQuiz(id));
    else if (act === 'del') {
      const quiz = getQuiz(id);
      if (confirm(`Delete "${quiz.title.trim() || 'Untitled quiz'}"?`)) {
        const mediaIds = collectMediaIds(quiz);
        deleteQuiz(id);
        renderLibrary();
        await releaseUnusedMedia(mediaIds);
      }
    }
  });

  initEditorEvents();
  initPlayerEvents();

  window.addEventListener('hashchange', route);
  route();
});
