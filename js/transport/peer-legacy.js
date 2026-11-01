'use strict';

/* Legacy/dev transport adapter: a thin pass-through to the real PeerJS
   client (loaded via the CDN <script> tag in index.html), used when
   getTransportConfig().mode === 'peer'. This is the original, unmodified
   direct-WebRTC behavior — kept as a fallback for local development and
   for the plain web app's existing LAN/PeerJS joining path. It exists so
   js/host.js and js/player.js never call `new Peer(...)` directly; both
   transport adapters are called identically (see js/transport/index.js). */

function createHostPeerLegacy(id, opts) {
  return new Peer(id, opts);
}

function createPlayerPeerLegacy(opts) {
  return new Peer(opts);
}
