'use strict';

/* The only two functions js/host.js and js/player.js call — everything
   about which transport actually moves the bytes (direct PeerJS/WebRTC, or
   the Cloudflare relay over wss://) is decided here, once, from
   getTransportConfig(). Both adapters expose the same tiny Peer/
   DataConnection-shaped API (see js/transport/ws-transport.js's header
   comment), so nothing else in the game engine needs to change. */

function createTransportHostPeer(id, opts) {
  return getTransportConfig().mode === 'ws' ? createHostPeerWs(id, opts) : createHostPeerLegacy(id, opts);
}

function createTransportPlayerPeer(opts) {
  return getTransportConfig().mode === 'ws' ? createPlayerPeerWs(opts) : createPlayerPeerLegacy(opts);
}
