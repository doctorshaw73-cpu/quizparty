'use strict';

/* Centralized transport configuration.
   Default mode is 'peer' (the original direct PeerJS/WebRTC behavior),
   so the plain web app (e.g. GitHub Pages) keeps working exactly as before
   with zero config. Two callers override these via window.QUIZPARTY_*
   globals set BEFORE this script runs:
     - player.html (the public relay-only page) always forces 'ws'.
     - the Electron desktop app's preload script forces 'ws' and points
       relayUrl at a deployed Cloudflare Worker.
   See relay/README.md for how to deploy a relay and fill in the URL below. */

const QUIZPARTY_DEFAULT_RELAY_URL = 'https://REPLACE-ME.workers.dev';
const QUIZPARTY_DEFAULT_PLAYER_URL = 'https://doctorshaw73-cpu.github.io/quizparty/player.html';

function getTransportConfig() {
  const w = typeof window !== 'undefined' ? window : {};
  return {
    mode: w.QUIZPARTY_TRANSPORT || 'peer',                        // 'peer' | 'ws'
    relayUrl: w.QUIZPARTY_RELAY_URL || QUIZPARTY_DEFAULT_RELAY_URL,
    publicPlayerBaseUrl: w.QUIZPARTY_PLAYER_URL || QUIZPARTY_DEFAULT_PLAYER_URL,
  };
}
