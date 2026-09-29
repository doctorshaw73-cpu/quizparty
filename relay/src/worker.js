'use strict';

import { Room } from './room.js';

/* This Worker is deliberately tiny: it is the front door for two things,
   both delegated straight to the per-pin Durable Object (see room.js) —
     POST /api/rooms         create/claim a room, returns {pin, token}
     GET  /room/:pin?role=…  upgrade to the host or player WebSocket
   Everything about the actual game protocol lives in js/host.js,
   js/player.js and js/qtypes.js on the client, completely unaware this
   relay exists (see js/transport/). The Worker itself never sees quiz
   content, never scores anything, and never stores a player's answer
   beyond the moment it takes to forward it to the host. */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body, init) {
  return new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...(init && init.headers) } });
}

function randomPin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch (e) { /* pin below defaults if missing/invalid */ }
      let pin = /^\d{6}$/.test(String(body.pin || '')) ? String(body.pin) : randomPin();

      /* Mirrors the client's own PeerJS-era collision handling: try the
         host-chosen pin, and if that Durable Object says it's already
         claimed, roll a fresh one — a handful of attempts is plenty for a
         6-digit space that's essentially never fully booked. */
      for (let attempt = 0; attempt < 5; attempt++) {
        const stub = env.ROOMS.get(env.ROOMS.idFromName(pin));
        const res = await stub.fetch('https://room/init', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
        });
        if (res.status === 409) { pin = randomPin(); continue; }
        if (!res.ok) return json({ error: 'room-init-failed' }, { status: 502 });
        const { token } = await res.json();
        return json({ pin, token });
      }
      return json({ error: 'no-pin-available' }, { status: 503 });
    }

    if (url.pathname.startsWith('/room/')) {
      const pin = url.pathname.slice('/room/'.length);
      if (!/^\d{6}$/.test(pin)) return new Response('bad pin', { status: 400 });
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(pin));
      return stub.fetch(new Request('https://room/ws' + url.search, request));
    }

    if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true, service: 'quizparty-relay' });

    return new Response('not found', { status: 404 });
  },
};

export { Room };
