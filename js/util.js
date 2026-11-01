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
   (see js/qtypes.js's header comment). Four "providers", scoped to what's
   actually achievable without loading a third-party platform SDK into the
   page (which this app deliberately avoids — see README "Embedded video"):

     youtube  — real, documented clip support: seeks to `start` and the
                player itself halts at `end`, via YouTube's own
                start/end embed URL parameters.
     vimeo    — real seek-to-`start` support, via Vimeo's own documented
                #t= URL fragment. Vimeo has no URL-based way to halt
                playback at `end`, so that's handled generically (see
                CLIP_SEEK_PROVIDERS and js/host.js's clip-end cover).
     facebook — Facebook's official Video Plugin iframe. No documented
                way to seek or trim via URL at all.
     custom   — anything else (Yandex, or any other site): the user's own
                real embeddable URL, used as-is. There's no reliable way
                to seek or trim an arbitrary unknown platform's player
                without a documented API for it, so this is a deliberate
                fallback rather than a guess.

   A provider that can't seek to `start` will always play from the source
   video's own beginning — "trimming" it there is fundamentally not
   possible without that platform's cooperation (a documented URL scheme,
   or loading its SDK), so sanitizeVideoEmbed() below drops start/end
   entirely for such a provider instead of storing a value that would
   silently do nothing, or — worse — cover the WRONG segment once
   js/host.js's generic end-time cover kicks in. */

const CLIP_SEEK_PROVIDERS = ['youtube', 'vimeo'];

function isFacebookVideoUrl(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '').replace(/^m\./, '');
    return h === 'facebook.com' || h === 'fb.watch';
  } catch (e) { return false; }
}

/* Vimeo video ids are numeric. Matches vimeo.com/<id>,
   player.vimeo.com/video/<id>, and vimeo.com/channels/x/<id> shapes. */
function extractVimeoId(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (/^\d{6,}$/.test(s)) return s; // the bare id, as stored in videoEmbed.ref and re-validated from there
  try {
    const u = new URL(s);
    const h = u.hostname.replace(/^www\./, '').replace(/^player\./, '');
    if (h !== 'vimeo.com') return null;
    const m = u.pathname.match(/(\d{6,})/);
    return m ? m[1] : null;
  } catch (e) { return null; }
}

function isHttpsUrl(value) {
  try { return new URL(value).protocol === 'https:'; } catch (e) { return false; }
}

/* Sniffs a single pasted string (URL or bare YouTube id) into a
   { provider, ref } pair, or null if it isn't recognizable as anything
   embeddable at all. `ref` is provider-specific: the bare video id for
   youtube/vimeo, the original page URL for facebook (needed to build the
   plugin href), the embeddable URL itself for custom. */
function parseVideoEmbed(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const s = raw.trim();
  const yt = extractYoutubeId(s);
  if (yt) return { provider: 'youtube', ref: yt };
  const vimeo = extractVimeoId(s);
  if (vimeo) return { provider: 'vimeo', ref: vimeo };
  if (isFacebookVideoUrl(s) && isHttpsUrl(s)) return { provider: 'facebook', ref: s };
  if (isHttpsUrl(s)) return { provider: 'custom', ref: s };
  return null;
}

/* Rebuilds a trusted { provider, ref, start, end } from untrusted input
   (an imported quiz file, or any other caller) — never a structural clone.
   Accepts either the editor's own object shape or a bare string (so a
   hand-written/AI-generated quiz JSON can just supply a URL). start/end
   are non-negative integer seconds or null, and are dropped entirely for
   a provider that can't actually seek (see CLIP_SEEK_PROVIDERS above) —
   storing a value that silently does nothing, or means something
   different than the editor implied, is worse than just not storing it. */
function sanitizeVideoEmbed(raw) {
  if (typeof raw === 'string') return parseVideoEmbed(raw);
  if (!raw || typeof raw !== 'object') return null;
  const parsed = parseVideoEmbed(typeof raw.ref === 'string' ? raw.ref : '');
  if (!parsed) return null;
  if (raw.provider !== parsed.provider) return parsed; // re-detected provider always wins over a claimed one
  if (!CLIP_SEEK_PROVIDERS.includes(parsed.provider)) return parsed; // start/end dropped — this provider can't seek
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
  if (parsed.provider === 'vimeo') {
    const t = Number.isInteger(videoEmbed.start) && videoEmbed.start >= 0 ? `#t=${videoEmbed.start}s` : '';
    return `https://player.vimeo.com/video/${parsed.ref}?title=0&byline=0&portrait=0${t}`;
  }
  if (parsed.provider === 'facebook') {
    return `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(parsed.ref)}&show_text=false`;
  }
  return parsed.ref; // 'custom' — the user's own already-embeddable https URL, used as-is
}

/* Seconds to wait, from the moment the embed is shown, before
   js/host.js's generic "Clip ended" cover should hide it — null if there's
   nothing to cover (no end set, or the provider already halts itself
   natively, like youtube's own `end` param). For a seek-capable provider
   that actually jumped to `start`, what's on screen at wall-clock time T
   is source-video position (start + T), so the cover must fire at
   (end - start) seconds, not at `end` — firing at `end` would leave the
   clip running for `start` seconds too long. */
function clipCoverDelaySec(videoEmbed) {
  if (!videoEmbed || !Number.isInteger(videoEmbed.end) || videoEmbed.provider === 'youtube') return null;
  const start = Number.isInteger(videoEmbed.start) ? videoEmbed.start : 0;
  const delay = videoEmbed.end - start;
  return delay > 0 ? delay : null;
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
