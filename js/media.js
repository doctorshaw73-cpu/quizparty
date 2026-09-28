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

/* ---------- import media safety ----------
   A quiz file is untrusted input. Everything below is pure string/length
   inspection — no fetch, no DOM, no I/O — so it can gate an imported media
   entry *before* it ever reaches dataUrlToBlob()'s fetch() call below. */

const MEDIA_MIME_ALLOWLIST = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm',
  'video/mp4', 'video/webm', 'video/ogg',
];
const MEDIA_MAX_BYTES = 8 * 1024 * 1024;              // per item
const MEDIA_IMPORT_MAX_ITEMS = 30;                    // per import
const MEDIA_IMPORT_MAX_TOTAL_BYTES = 60 * 1024 * 1024; // per import

const DATA_URL_RE = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+)(;[^,]*)?,(.*)$/s;

/* Parses a strict `data:<mime>;base64,<payload>` URL without decoding the
   payload (only its length, to compute the decoded byte size). Returns null
   for anything else — including http(s):, blob:, file:, javascript:, a bare
   string, or a data: URL that isn't base64-encoded. */
function parseDataUrl(value) {
  if (typeof value !== 'string') return null;
  const m = DATA_URL_RE.exec(value);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const isBase64 = /(^|;)\s*base64\s*(;|$)/i.test(m[2] || '');
  const payload = m[3] || '';
  if (!isBase64) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 !== 0) return null;
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  const decodedBytes = (payload.length / 4) * 3 - padding;
  if (!(decodedBytes > 0)) return null;
  return { mime, decodedBytes };
}

/* True only for a well-formed data: URL with an allow-listed MIME type and a
   decoded size within MEDIA_MAX_BYTES. This is the single gate every
   imported media entry must pass before it can reach fetch()/IndexedDB —
   http:, https:, blob:, file:, javascript:, and any other scheme are always
   rejected here since parseDataUrl() only recognizes `data:`. */
function isSafeMediaDataUrl(value) {
  if (typeof value !== 'string' || value.length > MEDIA_MAX_BYTES * 2) return false; // cheap pre-check
  const parsed = parseDataUrl(value);
  return !!parsed && MEDIA_MIME_ALLOWLIST.includes(parsed.mime) && parsed.decodedBytes <= MEDIA_MAX_BYTES;
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

/* For import: store an embedded data: URL and return its new local id.
   Guarded by isSafeMediaDataUrl so this (and the fetch() it triggers) never
   runs on anything but a validated data: URL, even if called directly. */
async function saveMediaFromDataUrl(dataUrl) {
  if (!isSafeMediaDataUrl(dataUrl)) throw new Error('Unsafe or invalid media data URL');
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
