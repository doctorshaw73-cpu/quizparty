'use strict';

const PEER_PREFIX = 'quizparty-v1-';
/* Shared tile glyphs/colors used by every "pick a tile" question type
   (multiple choice, true/false, order, poll, scale). Colors c0-c7 are
   defined in style.css. */
const SHAPES = ['▲', '◆', '●', '■', '★', '⬟', '⬢', '✚'];
const MAX_TILES = SHAPES.length;

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

/* ---------- untrusted-input coercion (used by import sanitization) ----------
   Each of these rebuilds a value of the expected primitive type from
   arbitrary/untrusted input, falling back cleanly instead of ever throwing —
   used by js/qtypes.js's per-type sanitize() and js/store.js's import path
   so a malformed quiz file can't reach host/player/editor code with the
   wrong shape (a number where text is expected, an object where an array
   is expected, NaN/Infinity, etc). */

function safeText(value, maxLen) {
  if (value == null) return '';
  if (typeof value !== 'string') {
    if (typeof value === 'number' || typeof value === 'boolean') value = String(value);
    else return '';
  }
  return value.slice(0, maxLen);
}

function safeBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function safeNumber(value, fallback) {
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
  else return fallback;
  return Number.isFinite(n) ? n : fallback;
}

/* Rebuilds an array of `{text}` (optionally `{text, correct}`) rows from
   untrusted input: caps the row count, coerces every field, and never trusts
   the input's own array length or item shapes. */
function safeRows(rawRows, opts) {
  const arr = Array.isArray(rawRows) ? rawRows : [];
  return arr.slice(0, opts.max).map(r => {
    const row = { text: safeText(r && r.text, opts.maxLen) };
    if (opts.checkbox) row.correct = safeBool(r && r.correct, false);
    return row;
  });
}

/* A real YouTube video id is always exactly 11 characters of [A-Za-z0-9_-].
   Accepts either a bare id or a handful of common URL shapes (watch?v=,
   youtu.be/, embed/, shorts/) so pasting a URL straight from the browser's
   address/share bar just works; anything else (including a non-YouTube URL,
   or garbage from a hostile/malformed import) returns null rather than ever
   being trusted as-is — this value ends up in an <iframe src>, so a loose
   match here would be an injection risk, not just a UX nicety. */
function extractYoutubeId(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const m = s.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

/* ---------- embedded video (host-only illustrative media) ----------
   A question can embed a video from an external site to show on the host
   screen — never sent to players, same as every other media attachment
   (see js/qtypes.js's header comment). Three "providers":
     youtube  — a real YouTube video. Reliable, documented support for
                embedding just a clip of it (start/end seconds), via
                YouTube's own privacy-enhanced embed domain.
     facebook — a Facebook video, via Facebook's own official oEmbed-style
                Video Plugin iframe (developers.facebook.com/docs/plugins/
                embedded-video-player). No documented way to trim a clip
                via URL parameters, so start/end are ignored for it.
     custom   — anything else (Yandex, Vimeo, or any other site): the user
                supplies the actual embeddable iframe URL themselves
                (typically from that site's own "Share -> Embed" feature).
                There is no reliable standardized way to detect or trim a
                clip for an arbitrary unknown platform, so this path is
                used as-is, start/end ignored. This is a deliberate choice
                not to fabricate support for a specific site's embed
                format without being confident it's stable/documented. */

function isFacebookVideoUrl(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '').replace(/^m\./, '');
    return h === 'facebook.com' || h === 'fb.watch';
  } catch (e) { return false; }
}

function isHttpsUrl(value) {
  try { return new URL(value).protocol === 'https:'; } catch (e) { return false; }
}

/* Sniffs a single pasted string (URL or bare YouTube id) into a
   { provider, ref } pair, or null if it isn't recognizable as anything
   embeddable at all. `ref` is provider-specific: the bare video id for
   youtube, the original page URL for facebook (needed to build the plugin
   href), the embeddable URL itself for custom. */
function parseVideoEmbed(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const s = raw.trim();
  const yt = extractYoutubeId(s);
  if (yt) return { provider: 'youtube', ref: yt };
  if (isFacebookVideoUrl(s) && isHttpsUrl(s)) return { provider: 'facebook', ref: s };
  if (isHttpsUrl(s)) return { provider: 'custom', ref: s };
  return null;
}

/* Rebuilds a trusted { provider, ref, start, end } from untrusted input
   (an imported quiz file, or any other caller) — never a structural clone.
   Accepts either the editor's own object shape or a bare string (so a
   hand-written/AI-generated quiz JSON can just supply a URL). start/end
   are non-negative integer seconds or null; only ever applied for the
   youtube provider when actually building the embed src. */
function sanitizeVideoEmbed(raw) {
  if (typeof raw === 'string') return parseVideoEmbed(raw);
  if (!raw || typeof raw !== 'object') return null;
  const parsed = parseVideoEmbed(typeof raw.ref === 'string' ? raw.ref : '');
  if (!parsed) return null;
  if (raw.provider !== parsed.provider) return parsed; // re-detected provider always wins over a claimed one
  const toSec = v => {
    const n = safeNumber(v, null);
    return n !== null && Number.isInteger(n) && n >= 0 ? n : null;
  };
  let start = toSec(raw.start), end = toSec(raw.end);
  if (start !== null && end !== null && end <= start) end = null; // nonsensical range — drop rather than guess
  return { ...parsed, start, end };
}

/* The ONLY place a videoEmbed actually becomes an <iframe src> string —
   re-validates from scratch rather than trusting that every caller already
   sanitized it upstream (they do, but this is the one spot a bad value
   would actually become an injection). Returns null if there's nothing
   valid to embed. */
function buildEmbedSrc(videoEmbed) {
  if (!videoEmbed) return null;
  const parsed = parseVideoEmbed(videoEmbed.ref);
  if (!parsed || parsed.provider !== videoEmbed.provider) return null;
  if (parsed.provider === 'youtube') {
    let src = `https://www.youtube-nocookie.com/embed/${parsed.ref}?rel=0`;
    if (Number.isInteger(videoEmbed.start) && videoEmbed.start >= 0) src += `&start=${videoEmbed.start}`;
    if (Number.isInteger(videoEmbed.end) && videoEmbed.end >= 0) src += `&end=${videoEmbed.end}`;
    return src;
  }
  if (parsed.provider === 'facebook') {
    return `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(parsed.ref)}&show_text=false`;
  }
  return parsed.ref; // 'custom' — the user's own already-embeddable https URL, used as-is
}

const $ = sel => document.querySelector(sel);

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === id));
  window.scrollTo(0, 0);
}

function showSub(root, id) {
  document.querySelectorAll(`#${root} > div`).forEach(v => v.classList.toggle('active', v.id === id));
  window.scrollTo(0, 0);
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/* In 'ws' mode (Electron desktop, or any deployment pointed at a relay)
   players join through the public relay-backed player page instead of
   this document's own origin — there is no LAN address or localhost
   involved at all. In the default 'peer' mode this is unchanged from the
   original behavior: the current page's own URL. */
function joinUrl(pin) {
  const cfg = getTransportConfig();
  if (cfg.mode === 'ws') return cfg.publicPlayerBaseUrl + '#join/' + pin;
  return location.origin + location.pathname + '#join/' + pin;
}
