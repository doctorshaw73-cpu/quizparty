'use strict';

/* Local media store for images/audio/video attached to questions. Blobs live
   in IndexedDB (localStorage is too small for media) and are referenced from
   quiz JSON only by a small string id — nothing here ever leaves the host's
   browser except when a question type explicitly needs to send bytes to
   players (image pin/drop-pin sends the target image; see qtypes.js). */

const MEDIA_DB_NAME = 'quizparty-media-v1';
const MEDIA_STORE = 'blobs';

let _dbPromise = null;

function mediaDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(MEDIA_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(MEDIA_STORE)) {
        req.result.createObjectStore(MEDIA_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(mode) {
  return mediaDb().then(db => db.transaction(MEDIA_STORE, mode).objectStore(MEDIA_STORE));
}

/* Stores a Blob/File under a fresh id and returns that id. */
async function saveMedia(blob) {
  const store = await tx('readwrite');
  const id = uid();
  await new Promise((resolve, reject) => {
    const req = store.put(blob, id);
    req.onsuccess = resolve;
    req.onerror = () => reject(req.error);
  });
  return id;
}

async function getMediaBlob(id) {
  if (!id) return null;
  const store = await tx('readonly');
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function deleteMedia(id) {
  if (!id) return;
  const store = await tx('readwrite');
  await new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = resolve;
    req.onerror = () => reject(req.error);
  });
}

/* Object URLs are cached per id for the life of the tab — callers never need
   to revoke them individually; they die with the page. */
const _urlCache = new Map();

async function getMediaUrl(id) {
  if (!id) return null;
  if (_urlCache.has(id)) return _urlCache.get(id);
  const blob = await getMediaBlob(id);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  _urlCache.set(id, url);
  return url;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

/* For export: turn a stored media id into a self-contained data: URL. */
async function mediaToDataUrl(id) {
  const blob = await getMediaBlob(id);
  return blob ? blobToDataUrl(blob) : null;
}

/* For import: store an embedded data: URL and return its new local id. */
async function saveMediaFromDataUrl(dataUrl) {
  const blob = await dataUrlToBlob(dataUrl);
  return saveMedia(blob);
}

/* Shared by host.js (live game) and editor.js (preview): resolve a question's
   optional media block to object URLs, and render them as host-only markup.
   Never sent to players — see qtypes.js for the one exception (image pin). */
async function resolveMediaUrls(media) {
  const out = {};
  if (media) {
    if (media.image) out.imageUrl = await getMediaUrl(media.image);
    if (media.video) out.videoUrl = await getMediaUrl(media.video);
    if (media.audio) out.audioUrl = await getMediaUrl(media.audio);
  }
  return out;
}

function mediaHtml(urls) {
  const parts = [];
  if (urls.imageUrl) parts.push(`<img src="${urls.imageUrl}" class="q-media-img" alt="">`);
  if (urls.videoUrl) parts.push(`<video src="${urls.videoUrl}" class="q-media-vid" controls></video>`);
  if (urls.audioUrl) parts.push(`<audio src="${urls.audioUrl}" class="q-media-aud" controls></audio>`);
  return parts.join('');
}
