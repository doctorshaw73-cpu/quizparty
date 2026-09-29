'use strict';

/* Production transport: a Cloudflare Worker + Durable Object relay reached
   over wss:// (see relay/). This file's whole job is to imitate the tiny
   slice of the PeerJS API that js/host.js and js/player.js already use
   (Peer: .on('open'|'connection'|'error'|'disconnected'), .reconnect(),
   .destroy(); DataConnection: .connectionId, .open, .on('data'|'close'),
   .send(), .close()) so neither file needs to know which transport is
   actually moving its messages. See js/transport/index.js for the switch,
   and relay/src/room.js for the exact wire protocol this speaks.

   Wire protocol (JSON text frames), reserved key `__t` distinguishes a
   transport control frame from an ordinary app message (which always uses
   `t`, never `__t`, so the two can never collide):
     host  -> relay : {__t:'auth', token}
                      {__t:'send', id, d}   deliver app message d to player id
                      {__t:'drop', id}      forcibly close player id's socket
     relay -> host  : {__t:'ready'}         auth accepted
                      {__t:'authfail'}      bad/expired token
                      {__t:'conn', id}      a player connected
                      {__t:'left', id}      that player's socket closed
                      {__t:'msg', id, d}    player id sent app message d
     player-> relay : plain app message d (e.g. {t:'join',...}) — the room
                      is implicit (one player socket only ever talks to
                      "the host of this room"), so no envelope is needed.
     relay -> player: plain app message d, OR a control frame:
                      {__t:'ready'}  connected, room has a live host
                      {__t:'err', reason} room missing / no host / rejected */

function tinyEmitter() {
  const handlers = {};
  return {
    on(evt, cb) { (handlers[evt] = handlers[evt] || []).push(cb); },
    emit(evt, ...args) { (handlers[evt] || []).slice().forEach(cb => { try { cb(...args); } catch (e) { /* one bad handler shouldn't break the rest */ } }); },
  };
}

function wsUrl(relayUrl, pin, role) {
  return relayUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/room/' + encodeURIComponent(pin) + '?role=' + role;
}

/* ---------- host ---------- */

function createHostPeerWs(id, opts) {
  const cfg = getTransportConfig();
  const pin = String(id).replace(PEER_PREFIX, '');
  const peer = tinyEmitter();
  peer.id = id;
  let ws = null;
  let token = null;
  let destroyed = false;
  const conns = new Map(); // connId -> conn

  function makeConn(connId) {
    const conn = tinyEmitter();
    conn.connectionId = connId;
    conn.open = true;
    conn.send = data => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ __t: 'send', id: connId, d: data })); };
    conn.close = () => {
      if (!conn.open) return;
      conn.open = false;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ __t: 'drop', id: connId }));
    };
    conns.set(connId, conn);
    return conn;
  }

  function openSocket() {
    ws = new WebSocket(wsUrl(cfg.relayUrl, pin, 'host'));
    ws.addEventListener('open', () => ws.send(JSON.stringify({ __t: 'auth', token })));
    ws.addEventListener('message', evt => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch (e) { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.__t === 'ready') peer.emit('open');
      else if (msg.__t === 'authfail') peer.emit('error', { type: 'unavailable-id' });
      else if (msg.__t === 'conn') peer.emit('connection', makeConn(msg.id));
      else if (msg.__t === 'left') {
        const conn = conns.get(msg.id);
        if (conn) { conn.open = false; conns.delete(msg.id); conn.emit('close'); }
      } else if (msg.__t === 'msg') {
        const conn = conns.get(msg.id);
        if (conn) conn.emit('data', msg.d);
      }
    });
    ws.addEventListener('close', () => { if (!destroyed) peer.emit('disconnected'); });
    ws.addEventListener('error', () => { /* the close handler that follows carries the real signal */ });
  }

  /* Claim `pin` as this room's id via the relay's HTTP room-creation
     endpoint — mirrors PeerJS's own "ask the signaling server to reserve
     this peer id" step, including the same unavailable-id error shape
     host.js's openRoom() already retries on with a freshly rolled pin. */
  fetch(cfg.relayUrl.replace(/\/$/, '') + '/api/rooms', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
  }).then(async res => {
    if (destroyed) return;
    if (res.status === 409) { peer.emit('error', { type: 'unavailable-id' }); return; }
    if (!res.ok) { peer.emit('error', { type: 'server-error' }); return; }
    const body = await res.json();
    token = body.token;
    openSocket();
  }).catch(() => { if (!destroyed) peer.emit('error', { type: 'network' }); });

  peer.reconnect = () => { if (!destroyed && token) openSocket(); };
  peer.destroy = () => {
    destroyed = true;
    conns.forEach(c => { c.open = false; });
    conns.clear();
    if (ws) { try { ws.close(); } catch (e) { /* already gone */ } }
  };
  return peer;
}

/* ---------- player ---------- */

function createPlayerPeerWs(opts) {
  const cfg = getTransportConfig();
  const peer = tinyEmitter();
  let destroyed = false;

  peer.connect = id => {
    const pin = String(id).replace(PEER_PREFIX, '');
    const conn = tinyEmitter();
    conn.open = false;
    const ws = new WebSocket(wsUrl(cfg.relayUrl, pin, 'player'));
    conn.send = data => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); };
    conn.close = () => { conn.open = false; try { ws.close(); } catch (e) { /* already gone */ } };
    ws.addEventListener('open', () => { /* wait for the relay's {__t:'ready'} before announcing 'open' */ });
    ws.addEventListener('message', evt => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch (e) { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.__t === 'ready') { conn.open = true; conn.emit('open'); }
      else if (msg.__t === 'err') { if (!destroyed) peer.emit('error', { type: msg.reason === 'no-room' ? 'peer-unavailable' : 'network' }); }
      else if (!msg.__t) conn.emit('data', msg);
    });
    ws.addEventListener('close', () => { if (conn.open) { conn.open = false; conn.emit('close'); } });
    return conn;
  };

  peer.destroy = () => { destroyed = true; };
  /* PeerJS fires 'open' once the client has its own peer id; there's no
     equivalent handshake needed before calling .connect() here, so fire it
     on the next tick to keep the async shape identical for callers. */
  setTimeout(() => { if (!destroyed) peer.emit('open'); }, 0);
  return peer;
}
