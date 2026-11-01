'use strict';

/* Exercises the relay's actual HTTP + WebSocket protocol against a running
   `wrangler dev` instance (see README.md) — this is a real client speaking
   the exact wire protocol js/transport/ws-transport.js speaks, not a mock
   of the Worker. Run: node relay/test/protocol-test.js [baseUrl] */

const BASE = process.argv[2] || 'http://localhost:8787';
const WS_BASE = BASE.replace(/^http/, 'ws');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('  ok  -', name); }
  else { failed++; console.log('  FAIL -', name); }
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

/* Every socket gets a permanent listener from the moment it's created,
   queuing every message it ever receives — otherwise a message that
   arrives between connect() resolving and a later nextMessage() call
   attaching its own listener would be silently lost (a real client would
   have the same listener attached throughout its whole lifetime; this is
   purely a test-harness concern). */
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.__queue = [];
    ws.__waiters = [];
    ws.addEventListener('message', evt => {
      const msg = JSON.parse(evt.data);
      const waiterIdx = ws.__waiters.findIndex(w => !w.predicate || w.predicate(msg));
      if (waiterIdx !== -1) { const [w] = ws.__waiters.splice(waiterIdx, 1); clearTimeout(w.timer); w.resolve(msg); }
      else ws.__queue.push(msg);
    });
    const timer = setTimeout(() => reject(new Error('connect timeout: ' + url)), 5000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); });
    ws.addEventListener('error', e => { clearTimeout(timer); reject(e); });
  });
}

function nextMessage(ws, predicate, timeoutMs = 5000) {
  const idx = ws.__queue.findIndex(m => !predicate || predicate(m));
  if (idx !== -1) return Promise.resolve(ws.__queue.splice(idx, 1)[0]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
    ws.__waiters.push({ predicate, resolve, timer });
  });
}

async function createRoom(pin) {
  const res = await fetch(BASE + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pin ? { pin } : {}) });
  return res;
}

async function main() {
  // 1. create room
  const r1 = await createRoom('111111');
  const { pin, token } = await r1.json();
  ok('create room returns 200 with pin+token', r1.status === 200 && pin && token);

  // 2. collision -> different pin
  const r2 = await createRoom(pin);
  const body2 = await r2.json();
  ok('creating the same pin again rolls a different pin instead of 409-ing the caller', body2.pin !== pin);

  // 3. host auth
  const hostWs = await connect(`${WS_BASE}/room/${pin}?role=host`);
  hostWs.send(JSON.stringify({ __t: 'auth', token: 'wrong-token' }));
  const authfail = await nextMessage(hostWs, m => m.__t === 'authfail');
  ok('wrong host token is rejected', !!authfail);
  await wait(100);
  ok('host socket is closed after auth failure', hostWs.readyState === WebSocket.CLOSING || hostWs.readyState === WebSocket.CLOSED);

  const hostWs2 = await connect(`${WS_BASE}/room/${pin}?role=host`);
  hostWs2.send(JSON.stringify({ __t: 'auth', token }));
  const ready = await nextMessage(hostWs2, m => m.__t === 'ready');
  ok('correct host token is accepted', !!ready);

  // 4. invalid pin player join
  const badPlayerWs = await connect(`${WS_BASE}/room/999999?role=player`);
  const err = await nextMessage(badPlayerWs, m => m.__t === 'err');
  ok('joining a nonexistent pin gets a clear error', err.reason === 'no-room');

  // 5. two players coexist, host sees both connect
  const p1 = await connect(`${WS_BASE}/room/${pin}?role=player`);
  const conn1 = await nextMessage(hostWs2, m => m.__t === 'conn');
  const p1ready = await nextMessage(p1, m => m.__t === 'ready');
  ok('player 1 gets ready and host is told a player connected', !!conn1.id && !!p1ready);

  const p2 = await connect(`${WS_BASE}/room/${pin}?role=player`);
  const conn2 = await nextMessage(hostWs2, m => m.__t === 'conn');
  await nextMessage(p2, m => m.__t === 'ready');
  ok('a second, distinct player can join the same room', conn2.id !== conn1.id);

  // 6. player -> host answer routing (privacy: only join/answer protocol, never question text)
  p1.send(JSON.stringify({ t: 'join', name: 'Alice', pid: 'pid-1' }));
  const joinMsg = await nextMessage(hostWs2, m => m.__t === 'msg' && m.id === conn1.id);
  ok('player message reaches host tagged with the right connection id', joinMsg.d.t === 'join' && joinMsg.d.name === 'Alice');

  // 7. host -> one player only (never the other)
  let p2GotIt = false;
  const p2Guard = new Promise(resolve => { p2.addEventListener('message', () => { p2GotIt = true; resolve(); }); setTimeout(resolve, 400); });
  hostWs2.send(JSON.stringify({ __t: 'send', id: conn1.id, d: { t: 'welcome', name: 'Alice', inGame: false } }));
  const welcome = await nextMessage(p1, m => m.t === 'welcome');
  await p2Guard;
  ok('a targeted host message reaches only the addressed player', welcome.name === 'Alice' && !p2GotIt);

  // 8. host broadcast (mc question) reaches both, contains no text (privacy)
  const q = { t: 'q', i: 0, n: 3, secs: 20, type: 'mc', count: 4 };
  hostWs2.send(JSON.stringify({ __t: 'send', id: conn1.id, d: q }));
  hostWs2.send(JSON.stringify({ __t: 'send', id: conn2.id, d: q }));
  const q1 = await nextMessage(p1, m => m.t === 'q');
  const q2 = await nextMessage(p2, m => m.t === 'q');
  ok('broadcast question reaches both players', q1.type === 'mc' && q2.type === 'mc');
  ok('mc question payload carries no question/answer text, only shape metadata', !JSON.stringify(q1).match(/text|answer/i));

  // 9. player cannot impersonate host (a raw __t:'send' from a player is not a valid app message and is just forwarded opaquely to the host as data, never treated as host authority)
  p1.send(JSON.stringify({ __t: 'send', id: conn2.id, d: { t: 'kick', reason: 'spoofed' } }));
  const spoofed = await nextMessage(hostWs2, m => m.__t === 'msg' && m.id === conn1.id);
  ok('a player-sent envelope arrives at the host as an ordinary opaque player message, never executed as a relay command', spoofed.d.__t === 'send');

  // 10. player cannot message another player directly — there is no such wire path;
  // confirm p2 never receives anything unless the HOST explicitly addressed it.
  let p2GotSpoofed = false;
  p2.addEventListener('message', () => { p2GotSpoofed = true; });
  await wait(300);
  ok('a player has no path to send another player anything directly', !p2GotSpoofed);

  // 11. oversized / malformed message rejected
  const hugeWs = await connect(`${WS_BASE}/room/${pin}?role=player`);
  await nextMessage(hugeWs, m => m.__t === 'ready');
  const closedPromise = new Promise(resolve => hugeWs.addEventListener('close', resolve));
  hugeWs.send('x'.repeat(9 * 1024));
  await closedPromise;
  ok('an oversized player message gets the connection closed rather than forwarded', true);

  // 12. reconnect: a fresh player socket gets a new connection id and the host is told the old one left
  p1.close();
  const left = await nextMessage(hostWs2, m => m.__t === 'left' && m.id === conn1.id);
  ok('host is notified when a player socket closes', !!left);

  // 13. host disconnect -> players get kicked cleanly
  hostWs2.close();
  const kicked = await nextMessage(p2, m => m.t === 'kick');
  ok('all remaining players are told the host disconnected', /disconnected/i.test(kicked.reason));

  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('TEST SCRIPT FAILED:', e); process.exit(1); });
