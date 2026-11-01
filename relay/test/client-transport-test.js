'use strict';

/* Loads the REAL client-side transport files (js/transport/*.js, js/util.js)
   into a Node vm sandbox with a real WebSocket global pointed at a running
   `wrangler dev` relay, and drives js/host.js's createTransportHostPeer /
   js/player.js's createTransportPlayerPeer through an actual host<->relay
   <->player round trip — this is the client code that will really ship,
   not a re-implementation of it. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BASE = process.argv[2] || 'http://localhost:8787';
let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log('  ok  -', name); } else { failed++; console.log('  FAIL -', name); } }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadSandbox() {
  const sandbox = {
    window: {}, WebSocket, fetch, console,
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  sandbox.window.QUIZPARTY_TRANSPORT = 'ws';
  sandbox.window.QUIZPARTY_RELAY_URL = BASE;
  vm.createContext(sandbox);
  const root = path.join(__dirname, '..', '..');
  for (const f of ['js/transport/config.js', 'js/util.js', 'js/transport/ws-transport.js', 'js/transport/index.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
  }
  // Top-level `const`/function declarations across separate runInContext
  // calls share this context's global lexical scope, but aren't properties
  // of the sandbox object itself — bridge the handful this test needs.
  vm.runInContext('var __b = { PEER_PREFIX, createTransportHostPeer, createTransportPlayerPeer };', sandbox);
  sandbox.PEER_PREFIX = sandbox.__b.PEER_PREFIX;
  sandbox.createTransportHostPeer = sandbox.__b.createTransportHostPeer;
  sandbox.createTransportPlayerPeer = sandbox.__b.createTransportPlayerPeer;
  return sandbox;
}

async function main() {
  const host = loadSandbox();
  const player = loadSandbox();

  const pin = String(Math.floor(100000 + Math.random() * 900000));
  const hostPeer = host.createTransportHostPeer(host.PEER_PREFIX + pin, {});

  const hostOpen = new Promise(resolve => hostPeer.on('open', resolve));
  const connEvt = new Promise(resolve => hostPeer.on('connection', resolve));
  await hostOpen;
  ok('host transport peer reaches "open" via the real relay', true);

  const playerPeer = player.createTransportPlayerPeer({});
  await new Promise(resolve => playerPeer.on('open', resolve));
  const conn = playerPeer.connect(player.PEER_PREFIX + pin);
  const playerConnOpen = new Promise(resolve => conn.on('open', resolve));

  const hostConn = await connEvt;
  await playerConnOpen;
  ok('player connects to the host through the relay and both sides see it', !!hostConn && conn.open);

  const gotJoin = new Promise(resolve => hostConn.on('data', d => { if (d.t === 'join') resolve(d); }));
  conn.send({ t: 'join', name: 'Bob', pid: 'pid-x' });
  const joinMsg = await gotJoin;
  ok('player -> host app message round-trips through the relay unchanged', joinMsg.name === 'Bob');

  const gotWelcome = new Promise(resolve => conn.on('data', d => { if (d.t === 'welcome') resolve(d); }));
  hostConn.send({ t: 'welcome', name: 'Bob', inGame: false });
  const welcome = await gotWelcome;
  ok('host -> player app message round-trips through the relay unchanged', welcome.name === 'Bob');

  // image-pin preload/ready timing over the relay
  const preloadImg = 'data:image/png;base64,AAAA';
  const gotReady = new Promise(resolve => hostConn.on('data', d => { if (d.t === 'ready') resolve(d); }));
  let readySentAt = null;
  const playerGotPreload = new Promise(resolve => {
    conn.on('data', d => { if (d.t === 'preload') resolve(d); });
  });
  hostConn.send({ t: 'preload', i: 0, image: preloadImg });
  const preloadMsg = await playerGotPreload;
  ok('image-pin preload crosses the relay with the image payload intact', preloadMsg.image === preloadImg);
  await wait(20); // simulate phone decode time before acking, like js/player.js really does
  readySentAt = Date.now();
  conn.send({ t: 'ready', i: 0 });
  const readyMsg = await gotReady;
  ok('phone READY for the exact question index reaches the host only after decode/ack, via the relay', readyMsg.i === 0 && Date.now() >= readySentAt);

  // stale ready for a different question index is just an ordinary app
  // message as far as the transport is concerned (host.js's own
  // qIndex-check ignores it — already covered by the Node test suite);
  // here we only confirm the relay itself doesn't special-case or drop it.
  const gotStale = new Promise(resolve => hostConn.on('data', d => { if (d.t === 'ready' && d.i === 99) resolve(d); }));
  conn.send({ t: 'ready', i: 99 });
  const stale = await gotStale;
  ok('the relay forwards every app message opaquely, including one host.js will itself ignore as stale', stale.i === 99);

  conn.close();
  hostPeer.destroy();
  playerPeer.destroy();

  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('TEST SCRIPT FAILED:', e); process.exit(1); });
