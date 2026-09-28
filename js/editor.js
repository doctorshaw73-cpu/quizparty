'use strict';

/* Quiz editor. Edits `edQuiz` in place and auto-saves to localStorage on every
   change. Type-specific fields (answers/options/items/etc.) and the live
   preview are rendered through the js/qtypes.js registry — this file wires
   the common controls (title, type picker, time/points, media) and the
   slide-sorter sidebar. */
let edQuiz = null;
let edIndex = 0;

function renderEditor(quizId) {
  edQuiz = getQuiz(quizId);
  if (!edQuiz) { location.hash = 'library'; return; }
  edIndex = 0;
  showView('view-editor');
  $('#ed-title').value = edQuiz.title;
  if (!$('#ed-qtype').options.length) {
    $('#ed-qtype').innerHTML = QUESTION_TYPE_LIST.map(t =>
      `<option value="${t}">${QuestionTypes[t].icon} ${QuestionTypes[t].label}</option>`).join('');
  }
  edRenderTabs();
  edRenderQuestion();
}

function edSave() {
  if (edQuiz) upsertQuiz(edQuiz);
}

function edRenderTabs() {
  $('#ed-qlist').innerHTML = edQuiz.questions.map((q, i) => `
    <button class="q-tab ${i === edIndex ? 'sel' : ''}" data-i="${i}">
      <small>${i + 1}</small><span class="q-tab-icon">${questionTypeOf(q).icon}</span>${esc(q.text.trim() || 'Untitled question')}
    </button>`).join('');
}

function edRenderQuestion() {
  const q = edQuiz.questions[edIndex];
  if (!q) return;
  $('#ed-qlabel').textContent = `Question ${edIndex + 1} of ${edQuiz.questions.length}`;
  $('#ed-qtype').value = q.type;
  $('#ed-qtext').value = q.text;
  $('#ed-qtime').value = String(q.time);
  $('#ed-qpoints').value = q.points;
  edRenderMediaPreview();
  edRenderTypeBody();
  edRenderPreview();
}

function edRenderTypeBody() {
  const q = edQuiz.questions[edIndex];
  questionTypeOf(q).editorRender($('#ed-type-body'), q, rerender => {
    edSave(); edRenderTabs(); edRenderPreview();
    if (rerender) edRenderTypeBody();
  });
}

function edRenderMediaPreview() {
  const q = edQuiz.questions[edIndex];
  resolveMediaUrls(q.media).then(urls => { $('#ed-media-preview').innerHTML = mediaHtml(urls); });
}

async function edRenderPreview() {
  const q = edQuiz.questions[edIndex];
  if (!q) return;
  const type = questionTypeOf(q);
  const media = await resolveMediaUrls(q.media);

  const hostEl = $('#ed-preview-host');
  hostEl.innerHTML = `<div class="q-media">${mediaHtml(media)}</div><h4>${esc(q.text || '(question text)')}</h4><div class="preview-body"></div>`;
  type.hostRender(hostEl.querySelector('.preview-body'), q, media);

  const ctx = type.sendsMediaToPlayer && q.media.image ? { imageDataUrl: await mediaToDataUrl(q.media.image) } : {};
  const payload = { type: q.type, secs: q.time, ...type.playerPayload(q, ctx) };
  const playerEl = $('#ed-preview-player');
  playerEl.innerHTML = '';
  type.playerControl(playerEl, payload, () => {}); // preview only — submissions go nowhere
}

async function edSetMedia(kind, file) {
  const q = edQuiz.questions[edIndex];
  q.media[kind] = await saveMedia(file);
  edSave(); edRenderMediaPreview(); edRenderPreview();
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
    edQuiz.questions.push(blankQuestion('mc'));
    edIndex = edQuiz.questions.length - 1;
    edSave(); edRenderTabs(); edRenderQuestion();
  });

  $('#ed-qtype').addEventListener('change', e => {
    edQuiz.questions[edIndex] = retypeQuestion(edQuiz.questions[edIndex], e.target.value);
    edSave(); edRenderTabs(); edRenderQuestion();
  });

  $('#ed-qtext').addEventListener('input', e => {
    edQuiz.questions[edIndex].text = e.target.value;
    edSave(); edRenderTabs(); edRenderPreview();
  });
  $('#ed-qtime').addEventListener('change', e => {
    edQuiz.questions[edIndex].time = +e.target.value;
    edSave(); edRenderPreview();
  });
  $('#ed-qpoints').addEventListener('change', e => {
    edQuiz.questions[edIndex].points = e.target.value;
    edSave();
  });

  $('#ed-media-image').addEventListener('change', e => { if (e.target.files[0]) edSetMedia('image', e.target.files[0]); e.target.value = ''; });
  $('#ed-media-video').addEventListener('change', e => { if (e.target.files[0]) edSetMedia('video', e.target.files[0]); e.target.value = ''; });
  $('#ed-media-audio').addEventListener('change', e => { if (e.target.files[0]) edSetMedia('audio', e.target.files[0]); e.target.value = ''; });
  $('#ed-media-clear').addEventListener('click', () => {
    edQuiz.questions[edIndex].media = emptyMedia();
    edSave(); edRenderMediaPreview(); edRenderPreview();
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
      edQuiz.questions[0] = blankQuestion('mc');
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
