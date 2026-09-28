'use strict';

const PEER_PREFIX = 'quizparty-v1-';
/* Shared tile glyphs/colors used by every "pick a tile" question type
   (multiple choice, true/false, order, poll, scale). Colors c0-c7 are
   defined in style.css. */
const SHAPES = ['▲', '◆', '●', '■', '★', '⬟', '⬢', '✚'];
const MAX_TILES = SHAPES.length;

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

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
