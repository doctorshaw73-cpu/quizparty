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
  const v = q.videoEmbed;
  $('#ed-embed-url').value = v ? v.ref : '';
  $('#ed-embed-start').value = v && Number.isInteger(v.start) ? v.start : '';
  $('#ed-embed-end').value = v && Number.isInteger(v.end) ? v.end : '';
  $('#ed-embed-hint').textContent = v && v.provider === 'youtube' ? 'YouTube — start/end trim a real clip; playback halts itself at End.'
    : v && v.provider === 'vimeo' ? 'Vimeo — Start seeks to that point; End covers the screen once the clip length has played (Vimeo has no way to halt itself, so the video may keep running hidden behind the cover).'
    : v && v.provider === 'facebook' ? 'Facebook — can’t seek or trim at all; the full video always plays from its own beginning.'
    : v && v.provider === 'custom' ? 'This site can’t seek or trim either — the full video plays from its own beginning. (If its own share link already includes a start time, pasting that may help.)'
    : 'Paste a YouTube or Vimeo URL for real clip trimming, a Facebook video URL, or any other site’s own embeddable URL (e.g. its "Share → Embed" link).';
  const seekable = v && CLIP_SEEK_PROVIDERS.includes(v.provider);
  $('#ed-embed-start').disabled = !seekable;
  $('#ed-embed-end').disabled = !seekable;
  resolveMediaUrls(q.media).then(urls => { $('#ed-media-preview').innerHTML = mediaHtml(urls, q.videoEmbed); });
}

async function edRenderPreview() {
  const q = edQuiz.questions[edIndex];
  if (!q) return;
  const type = questionTypeOf(q);
  const media = await resolveMediaUrls(q.media);

  const hostEl = $('#ed-preview-host');
  hostEl.innerHTML = `<div class="q-media">${mediaHtml(media, q.videoEmbed)}</div><h4>${esc(q.text || '(question text)')}</h4><div class="preview-body"></div>`;
  type.hostRender(hostEl.querySelector('.preview-body'), q, media);

  const ctx = type.sendsMediaToPlayer
    ? { imageDataUrl: q.media.image ? await mediaToDataUrl(q.media.image) : null, image2DataUrl: q.media.image2 ? await mediaToDataUrl(q.media.image2) : null }
    : {};
  const payload = { type: q.type, secs: q.time, ...type.playerPayload(q, ctx) };
  const playerEl = $('#ed-preview-player');
  playerEl.innerHTML = '';
  type.playerControl(playerEl, payload, () => {}); // preview only — submissions go nowhere
}

async function edSetMedia(kind, file) {
  const error = validateMediaFile(file, kind);
  if (error) { alert(error); return; }
  const q = edQuiz.questions[edIndex];
  const oldId = q.media[kind];
  q.media[kind] = await saveMedia(file);
  edSave(); edRenderMediaPreview(); edRenderPreview();
  await releaseMediaIfUnused(oldId);
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
  $('#ed-media-clear').addEventListener('click', async () => {
    const oldIds = Object.values(edQuiz.questions[edIndex].media || {});
    edQuiz.questions[edIndex].media = emptyMedia();
    edQuiz.questions[edIndex].videoEmbed = null;
    edSave(); edRenderMediaPreview(); edRenderPreview();
    await releaseUnusedMedia(oldIds);
  });
  const edUpdateVideoEmbed = () => {
    const url = $('#ed-embed-url').value;
    const q = edQuiz.questions[edIndex];
    if (!url.trim()) { q.videoEmbed = null; edSave(); edRenderMediaPreview(); edRenderPreview(); return; }
    const parsed = parseVideoEmbed(url);
    if (!parsed) { alert("That doesn't look like a YouTube/Facebook video URL or a valid https embeddable URL."); return; }
    const start = $('#ed-embed-start').value === '' ? null : Math.max(0, Math.round(+$('#ed-embed-start').value));
    const end = $('#ed-embed-end').value === '' ? null : Math.max(0, Math.round(+$('#ed-embed-end').value));
    q.videoEmbed = sanitizeVideoEmbed({ ...parsed, start, end });
    edSave(); edRenderMediaPreview(); edRenderPreview();
  };
  $('#ed-embed-url').addEventListener('change', edUpdateVideoEmbed);
  $('#ed-embed-start').addEventListener('change', edUpdateVideoEmbed);
  $('#ed-embed-end').addEventListener('change', edUpdateVideoEmbed);

  $('#ed-qup').addEventListener('click', () => edMoveQuestion(-1));
  $('#ed-qdown').addEventListener('click', () => edMoveQuestion(1));
  $('#ed-qdup').addEventListener('click', () => {
    const copy = JSON.parse(JSON.stringify(edQuiz.questions[edIndex]));
    edQuiz.questions.splice(edIndex + 1, 0, copy);
    edIndex++;
    edSave(); edRenderTabs(); edRenderQuestion();
  });
  $('#ed-qdel').addEventListener('click', async () => {
    const oldIds = Object.values(edQuiz.questions[edIndex].media || {});
    if (edQuiz.questions.length === 1) {
      edQuiz.questions[0] = blankQuestion('mc');
    } else {
      edQuiz.questions.splice(edIndex, 1);
      edIndex = Math.min(edIndex, edQuiz.questions.length - 1);
    }
    edSave(); edRenderTabs(); edRenderQuestion();
    await releaseUnusedMedia(oldIds);
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
