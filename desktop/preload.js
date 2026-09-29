'use strict';

/* Minimal preload bridge — runs with contextIsolation on, so this is the
   ONLY thing exposed to the page. It sets three plain string globals the
   page's own js/transport/config.js already knows how to read (see that
   file) and nothing else: no filesystem, no shell, no IPC, no Node APIs of
   any kind reach the renderer. This is what makes the desktop host use the
   Cloudflare relay (js/transport/ws-transport.js) instead of the default
   PeerJS/LAN path the plain web app uses. */

const { contextBridge } = require('electron');

/* Fill in RELAY_URL with your deployed Worker's URL after following
   relay/README.md, and PLAYER_URL with your GitHub Pages player.html URL
   after following the "GitHub Pages" section of the root README. Until
   both are filled in, hosting will fail with a clear "could not reach the
   relay" error rather than silently doing the wrong thing. */
const RELAY_URL = process.env.QUIZPARTY_RELAY_URL || 'https://REPLACE-ME.workers.dev';
const PLAYER_URL = process.env.QUIZPARTY_PLAYER_URL || 'https://doctorshaw73-cpu.github.io/quizparty/player.html';
/* The env var overrides exist solely so this can be smoke-tested against a
   local `wrangler dev` relay without editing the constants above — the
   packaged Windows app is always launched without them set, so end users
   always get the real values baked in. */

contextBridge.exposeInMainWorld('QUIZPARTY_TRANSPORT', 'ws');
contextBridge.exposeInMainWorld('QUIZPARTY_RELAY_URL', RELAY_URL);
contextBridge.exposeInMainWorld('QUIZPARTY_PLAYER_URL', PLAYER_URL);
