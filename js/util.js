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

function joinUrl(pin) {
  return location.origin + location.pathname + '#join/' + pin;
}
