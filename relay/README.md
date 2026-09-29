# QuizParty relay

A small Cloudflare Worker + Durable Object that lets a phone on Wi-Fi *or*
cellular data join a game hosted on a Windows PC, with no LAN address, no
inbound port, and no TURN server. It is **not** a quiz server: it never
sees quiz content, never scores anything, and never stores a player's
answer beyond the instant it takes to forward it to the host. See the
header comments in `src/room.js` and `src/worker.js` for the exact wire
protocol, which mirrors `js/transport/ws-transport.js` on the client.

Free-tier compatible: Cloudflare's Workers + Durable Objects free plan is
enough for personal/small-scale use. No paid product, no domain, and no
database are required — Durable Object in-memory + storage state is
sufficient.

## Local development (no Cloudflare account needed)

```
cd relay
npm install
npm run dev          # wrangler dev --local, serves http://localhost:8787
```

`relay/test/protocol-test.js` and `relay/test/client-transport-test.js`
exercise the real running dev server (not a mock) — see the repo root's
final report for what was actually run.

## Deploying for real (manual step — not performed by this change)

This environment has no Cloudflare account credentials, so deployment was
**not** attempted here. To deploy it yourself:

1. `npm install -g wrangler` (or use `npx wrangler` from `relay/`).
2. `npx wrangler login` — opens a browser to authorize Wrangler against
   your (free) Cloudflare account.
3. From `relay/`: `npx wrangler deploy`.
4. Wrangler prints your Worker's URL, e.g.
   `https://quizparty-relay.<your-subdomain>.workers.dev`.
5. Put that URL in **two** places:
   - `js/transport/config.js` — `QUIZPARTY_DEFAULT_RELAY_URL` (used by the
     public `player.html` page and by the plain web app if you ever switch
     its default transport to `'ws'`).
   - `desktop/preload.js` — `RELAY_URL` (used by the Windows desktop app).
6. Rebuild the desktop app (see the root README's "Windows build" section)
   so the new URL is baked into the installer.

No secrets or environment variables are needed — the per-room host
credential is generated randomly by the Durable Object itself at room
creation time and is never logged.

## What it does and does not do

Does:
- Create/claim a short-lived room per 6-digit PIN (`POST /api/rooms`).
- Distinguish the one authenticated host connection (a random per-room
  token, generated server-side, never included in the QR/join URL) from
  player connections.
- Forward host→player and player→host messages, and support host
  broadcast (the host just sends to each connection it knows about, same
  as it did with PeerJS).
- Reject a second host without the right token, reject oversized/malformed
  messages, rate-limit both directions, and give every room a hard TTL
  (`ROOM_TTL_MS` in `src/room.js`) so an abandoned room's PIN is eventually
  reclaimable.

Does not:
- Compute scores, know correct answers, or store quiz content.
- Store a player's answer beyond the moment it's relayed to the host.
- Allow a player to message another player — there is no such wire path.
- Require TURN, a database, or a paid plan.
