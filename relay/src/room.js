'use strict';

/* One Durable Object instance per game PIN (see worker.js — the DO id is
   derived from the pin itself via idFromName, so "the room for pin X" is
   always the same object). It is NOT a quiz server: it never sees quiz
   content, never computes scores, and never stores player answers beyond
   the instant it takes to forward them to the host. Its only job is to
   multiplex one host WebSocket and many player WebSockets, exactly the way
   PeerJS's signaling server used to broker direct WebRTC connections —
   except here the relay itself carries the game traffic (see README).

   Wire protocol: see the header comment in js/transport/ws-transport.js —
   both sides of this file must be kept in sync with it. */

const ROOM_TTL_MS = 60 * 60 * 1000;        // a room can be claimed for up to an hour of play
const CLAIM_GRACE_MS = 60 * 1000;          // how long a just-created room holds its pin before the host must connect
const MAX_PLAYER_MSG_BYTES = 8 * 1024;     // player -> host: tiny control/answer messages only
const MAX_HOST_MSG_BYTES = 8 * 1024 * 1024; // host -> player: must fit a base64 image-pin preload
const RATE_WINDOW_MS = 1000;
const RATE_MAX_PLAYER = 20;                // messages/second a single player connection may send
const RATE_MAX_HOST = 200;                 // messages/second the host may send (broadcasts to many players)

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function randomId() {
  return crypto.randomUUID();
}

class RateLimiter {
  constructor(max, windowMs) { this.max = max; this.windowMs = windowMs; this.count = 0; this.windowStart = 0; }
  allow() {
    const now = Date.now();
    if (now - this.windowStart > this.windowMs) { this.windowStart = now; this.count = 0; }
    this.count++;
    return this.count <= this.max;
  }
}

class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.pin = null;
    this.hostToken = null;
    this.hostWs = null;
    this.createdAt = 0;
    this.players = new Map(); // id -> { ws, limiter }
    this.hostLimiter = new RateLimiter(RATE_MAX_HOST, RATE_WINDOW_MS);
    this.loaded = this.state.blockConcurrencyWhile(async () => {
      const saved = await this.state.storage.get(['pin', 'hostToken', 'createdAt']);
      this.pin = saved.get('pin') || null;
      this.hostToken = saved.get('hostToken') || null;
      this.createdAt = saved.get('createdAt') || 0;
    });
  }

  async fetch(request) {
    await this.loaded;
    const url = new URL(request.url);
    if (url.pathname === '/init' && request.method === 'POST') return this.handleInit(request);
    if (url.pathname === '/ws') return this.handleWs(request, url);
    return new Response('not found', { status: 404 });
  }

  /* A room is claimable if it's never been used, or its claim window/play
     window has fully lapsed with no host attached — otherwise the pin is
     "in use" and the worker should roll a different one (mirrors PeerJS's
     own unavailable-id collision behavior, which host.js already retries). */
  async handleInit(request) {
    const now = Date.now();
    const stillClaimed = this.hostToken && (this.hostWs || now - this.createdAt < CLAIM_GRACE_MS) && now - this.createdAt < ROOM_TTL_MS;
    if (stillClaimed) return new Response('conflict', { status: 409 });

    const { pin } = await request.json().catch(() => ({}));
    if (!/^\d{6}$/.test(String(pin || ''))) return new Response('bad request', { status: 400 });

    this.pin = String(pin);
    this.hostToken = randomToken();
    this.createdAt = now;
    this.hostWs = null;
    this.players.clear();
    await this.state.storage.put({ pin: this.pin, hostToken: this.hostToken, createdAt: this.createdAt });
    await this.state.storage.setAlarm(now + ROOM_TTL_MS);
    return Response.json({ token: this.hostToken });
  }

  handleWs(request, url) {
    const role = url.searchParams.get('role');
    if (role !== 'host' && role !== 'player') return new Response('bad role', { status: 400 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    if (role === 'host') this.attachHost(server);
    else this.attachPlayer(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) { /* socket already gone */ } }

  /* ---------- host socket ---------- */

  attachHost(ws) {
    let authed = false;
    ws.addEventListener('message', evt => {
      if (typeof evt.data !== 'string' || evt.data.length > MAX_HOST_MSG_BYTES) { try { ws.close(1009, 'message too large'); } catch (e) {} return; }
      if (!this.hostLimiter.allow()) { try { ws.close(1013, 'rate limit'); } catch (e) {} return; }
      let msg;
      try { msg = JSON.parse(evt.data); } catch (e) { return; }
      if (!msg || typeof msg !== 'object') return;

      if (!authed) {
        if (msg.__t !== 'auth' || typeof msg.token !== 'string' || msg.token !== this.hostToken) {
          this.send(ws, { __t: 'authfail' });
          try { ws.close(4401, 'auth failed'); } catch (e) {}
          return;
        }
        authed = true;
        /* A previous host socket for this room (e.g. the desktop app
           reconnecting after a network blip) is superseded, never both
           kept alive — there is exactly one authoritative host. */
        if (this.hostWs && this.hostWs !== ws) { try { this.hostWs.close(4000, 'superseded'); } catch (e) {} }
        this.hostWs = ws;
        this.send(ws, { __t: 'ready' });
        return;
      }

      if (msg.__t === 'send' && typeof msg.id === 'string') {
        const p = this.players.get(msg.id);
        if (p) this.send(p.ws, msg.d);
      } else if (msg.__t === 'drop' && typeof msg.id === 'string') {
        const p = this.players.get(msg.id);
        if (p) { try { p.ws.close(4000, 'dropped by host'); } catch (e) {} }
      }
      /* Anything else (unrecognized __t, malformed envelope) is silently
         ignored rather than crashing the room — the relay only forwards a
         well-formed envelope, never guesses at intent. */
    });
    ws.addEventListener('close', () => {
      if (this.hostWs === ws) this.hostWs = null;
      /* No mid-game host resume in this MVP: tell every connected player
         plainly (reusing the game's own existing 'kick' message, which
         player.js already renders as "Connection lost") and let them go,
         rather than holding sockets open against a host that may never
         come back. */
      for (const [, p] of this.players) {
        this.send(p.ws, { t: 'kick', reason: 'The host disconnected.' });
        try { p.ws.close(4000, 'host gone'); } catch (e) {}
      }
      this.players.clear();
    });
  }

  /* ---------- player sockets ---------- */

  attachPlayer(ws) {
    if (!this.hostToken) { this.send(ws, { __t: 'err', reason: 'no-room' }); try { ws.close(4404, 'no room'); } catch (e) {} return; }
    if (!this.hostWs) { this.send(ws, { __t: 'err', reason: 'host-unavailable' }); try { ws.close(4404, 'host unavailable'); } catch (e) {} return; }

    const id = randomId();
    const limiter = new RateLimiter(RATE_MAX_PLAYER, RATE_WINDOW_MS);
    this.players.set(id, { ws, limiter });
    this.send(this.hostWs, { __t: 'conn', id });
    this.send(ws, { __t: 'ready' });

    ws.addEventListener('message', evt => {
      if (typeof evt.data !== 'string' || evt.data.length > MAX_PLAYER_MSG_BYTES) { try { ws.close(1009, 'message too large'); } catch (e) {} return; }
      if (!limiter.allow()) { try { ws.close(1013, 'rate limit'); } catch (e) {} return; }
      let body;
      try { body = JSON.parse(evt.data); } catch (e) { return; }
      if (!body || typeof body !== 'object') return;
      /* A player message is forwarded to the host as-is (it is already the
         existing app-level protocol — join/a/ready) — the relay never
         inspects or trusts its contents, it only tags the sender's id so
         the host's transport shim can route it to the right virtual
         connection, exactly like a PeerJS DataConnection. It can never
         reach another player: this relay has no player-to-player path. */
      if (this.hostWs) this.send(this.hostWs, { __t: 'msg', id, d: body });
    });
    ws.addEventListener('close', () => {
      this.players.delete(id);
      if (this.hostWs) this.send(this.hostWs, { __t: 'left', id });
    });
  }

  /* Scheduled when the room is created; by the time it fires the room has
     either finished (host and all players gone) or overstayed its welcome
     — either way, reclaim the pin so a stale abandoned room can't squat on
     it forever. */
  async alarm() {
    if (this.hostWs) { try { this.hostWs.close(4000, 'room expired'); } catch (e) {} }
    for (const [, p] of this.players) { try { p.ws.close(4000, 'room expired'); } catch (e) {} }
    this.players.clear();
    this.hostWs = null;
    this.hostToken = null;
    this.pin = null;
    await this.state.storage.deleteAll();
  }
}

export { Room, ROOM_TTL_MS, CLAIM_GRACE_MS };
