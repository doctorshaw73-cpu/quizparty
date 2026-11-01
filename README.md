# 🎉 QuizParty

**Free, open-source Kahoot-style live quiz game — with no backend at all.**

Put the host screen on a projector or TV, and everyone in the room joins on their phone with a 6-digit game PIN (or by scanning a QR code). Answer fast, climb the scoreboard, win the podium.

**▶ Play now: https://arvindfroi.github.io/quizparty/**

## How can it work without a server?

The host's browser *is* the game server. Quiz content, scoring, and media never leave it.

There are two ways player messages actually travel, chosen automatically by which page loaded the app (see `js/transport/`, both speak the exact same message protocol — `js/host.js`/`js/player.js`/`js/qtypes.js` don't know or care which one is active):

- **Plain web app (this GitHub Pages site)**: **WebRTC data channels** via [PeerJS](https://peerjs.com) — every phone connects directly to the host's browser, peer-to-peer, over the same Wi-Fi or the open internet. PeerJS's free public broker is used once per player to *establish* the connection; after that, traffic flows directly between devices.
- **Windows desktop app + public player page** (`player.html`): a small self-hostable Cloudflare Worker relay (`relay/`) forwards messages over `wss://`, so a phone can join from a completely different network — cellular data included — with no LAN address, no port forwarding, and no firewall prompt. The relay only ever sees the same minimal, privacy-preserving player-control messages a phone would otherwise send directly; see `relay/README.md` for exactly what it can and can't do.

Either way: your quizzes live in your browser's localStorage, attached media in IndexedDB, and nothing is ever uploaded to a server.

Your quizzes are stored in your browser's localStorage; attached images/audio/video are stored in your browser's IndexedDB. Quizzes can be exported/imported as JSON files, media and all.

## Features

- 🎨 Kahoot-style gameplay: colored shape answer controls, countdown timer, speed-based scoring (500–1000 pts), streak bonuses, scoreboard between questions, podium at the end
- 📵 **Player-privacy by design**: for multiple-choice, true/false, order, poll and scale questions, phones never receive the question or answer text — only shape/color tiles matched to what's shown on the shared screen. The host/projector screen always shows the full question, media, and answer text.
- 🧩 **Ten question types**: multiple choice, true/false, order/puzzle, typed answer, slider/numeric, poll, scale, word cloud, open-ended, and image pin (drop-a-pin on an image)
- 🖼️ **Local media**: attach an image, video, or audio clip to any question. Media lives in your browser's IndexedDB and is shown on the host screen only — never sent to players, except image-pin's target image, which a phone genuinely needs to answer
- 🎬 PowerPoint/Slides-style editor: a slide-sorter sidebar with per-type icons, a type picker, time limit and point multiplier per question, and a live host+phone preview of exactly what each screen will show
- 📱 Players join with a PIN or QR code — nothing to install
- 🔁 Play again with the same room, late joiners welcome mid-game, and a dropped connection auto-reconnects with your score intact
- 📦 Export / import quizzes as JSON — media-free quizzes export as plain, portable JSON; quizzes with attached media embed it in the same file so nothing is lost
- 🆓 100% free and static: fork it, host it on any static file host (GitHub Pages works out of the box)

## Run it yourself

It's a plain static site — no build step, no dependencies to install:

```bash
git clone https://github.com/arvindfroi/quizparty.git
cd quizparty
python -m http.server 8080   # or any static file server
```

Then open http://localhost:8080. Note that players on *other devices* need to reach your page over HTTPS (or your LAN IP) — the easiest path is enabling GitHub Pages on your fork.

### Self-hosting the signaling too

If you don't want to rely on the free PeerJS cloud broker, run your own [PeerServer](https://github.com/peers/peerjs-server) and pass its host/port to `createHostPeerLegacy`/`createPlayerPeerLegacy` in `js/transport/peer-legacy.js`.

### Running the tests

```bash
node test/run-tests.js
```

A dependency-free Node script that exercises the real validation, normalization, scoring/correctness, and quiz-storage/migration logic (see "Architecture" below). It doesn't cover DOM rendering or networking — those are checked by hand (two browser tabs/devices, or the relay's own tests in `relay/test/`) before each release.

## Windows desktop app

A packaged Windows app (`QuizParty Setup <version>.exe`) that opens straight to the QuizParty host UI — no Python, Node, Git, or command line needed to *use* it. It's the same app code as the web version, running inside [Electron](https://www.electronjs.org/) with a minimal, locked-down preload bridge (`nodeIntegration: false`, `contextIsolation: true`, no filesystem/shell access exposed to the page) and no local HTTP server, LAN detection, or inbound port at all — the desktop app always joins games through the relay described above, so QR codes always show a public HTTPS URL, never `localhost` or a LAN address.

To build it yourself:

```bash
npm install
npm run dist:win
```

This produces `dist/QuizParty Setup <version>.exe` (an NSIS installer) via [electron-builder](https://www.electron.build/). Building a Windows target from Linux/macOS requires [Wine](https://www.winehq.org/) (`apt-get install --no-install-recommends wine64 wine32:i386` on Debian/Ubuntu, after `dpkg --add-architecture i386`); on Windows itself, no Wine is needed.

The installer is unsigned (no code-signing certificate) — Windows SmartScreen will show an "unrecognized app" warning on first run. This is expected and safe to bypass (More info → Run anyway) for a personal build; it's not a defect in the app.

Before your own build's QR codes point anywhere real, deploy the relay (`relay/README.md`) and fill in its URL in `desktop/preload.js` and `js/transport/config.js`, and enable GitHub Pages for `player.html` (below).

## Question types

Every question type follows the same rule: **the host screen always shows everything** (question text, media, answer text); **the phone shows only what it needs to answer**.

| Type | Phone shows | Notes |
|---|---|---|
| Multiple choice | Colored shape tiles, no text | 2–4 answers, one or more correct |
| True / False | ✓ / ✗ tiles | |
| Order / puzzle | Colored shape tiles, tapped in sequence | Correct order = the order items are listed in the editor |
| Typed answer | A text box | Case-insensitive match against one or more accepted answers |
| Slider / numeric | A range slider (min/max only, no correct value) | Scored within a small tolerance |
| Poll | Colored shape tiles, no text | Ungraded — just shows the distribution |
| Scale | Numbered tiles (e.g. 1–5) | Ungraded rating/Likert-style question |
| Word cloud | A short text box | Ungraded; responses aggregate into a word cloud on the host screen |
| Open-ended | A text box | Ungraded; responses are listed on the host screen |
| Image pin | The question's image, tap to drop a pin | The one type that sends an image to the phone — it can't be answered otherwise |

## Local media

Attach an image, video, or audio clip to any question from the editor. Media is stored as a Blob in your browser's IndexedDB (not localStorage, which is too small) and rendered on the host/projector screen only. It's never uploaded anywhere and never sent to players — the sole exception is image-pin questions, where the target image is sent to the phone because the question can't be answered without it.

## Quiz JSON format

A plain quiz (no media) exports exactly as before, plus a `type` field per question:

```json
{
  "title": "My quiz",
  "questions": [
    {
      "type": "mc",
      "text": "What is 2 + 2?",
      "media": { "image": null, "video": null, "audio": null },
      "time": 20,
      "points": "standard",
      "answers": [
        { "text": "3", "correct": false },
        { "text": "4", "correct": true }
      ]
    }
  ]
}
```

A quiz with attached media additionally carries a `media` map at the top level (id → `data:` URL), so nothing is lost on export:

```json
{
  "title": "My quiz",
  "questions": [ { "type": "imagepin", "media": { "image": "abc123" }, "pin": { "x": 0.5, "y": 0.3 }, "tolerance": 0.08, "...": "..." } ],
  "media": { "abc123": "data:image/png;base64,..." }
}
```

Importing a quiz never trusts media ids from the file directly — each embedded `data:` URL is re-saved into your browser's IndexedDB under a fresh id.

## GitHub Pages (for the public player page)

`player.html` needs to be reachable over plain HTTPS so a phone on cellular data can load it. If you fork this repo:

1. On GitHub, open your fork → **Settings** → **Pages**.
2. Under **Build and deployment** → **Source**, choose **Deploy from a branch**.
3. Under **Branch**, choose your default branch and **/ (root)**, then **Save**.
4. GitHub publishes the whole repo root, so `player.html` becomes reachable at `https://<your-username>.github.io/<your-repo>/player.html` (usually live within a minute or two).
5. Put that exact URL into `js/transport/config.js`'s `QUIZPARTY_DEFAULT_PLAYER_URL` and into `desktop/preload.js`'s `PLAYER_URL`, then rebuild the desktop app.

This step was **not** performed as part of this change (this environment has no access to your GitHub account's repository settings) — the steps above are exactly what to click.

## Architecture

- `js/qtypes.js` is the single place that knows how each question type behaves — validation, scoring, host rendering, the phone control, and the editor fields — so `host.js`/`player.js`/`editor.js` stay generic dispatchers instead of growing a conditional per feature. Adding an eleventh question type means adding one entry here.
- `js/transport/` is the one boundary that knows how a message physically gets from host to player: `config.js` picks a mode (`'peer'` — direct WebRTC, the original behavior — or `'ws'` — the Cloudflare relay), `peer-legacy.js` and `ws-transport.js` each imitate the same tiny PeerJS-shaped API (`Peer`/`DataConnection`: `.on()`, `.send()`, `.close()`, `.destroy()`), and `index.js` picks between them. Neither `host.js` nor `player.js` knows or cares which one is live.
- `js/media.js` is the IndexedDB-backed media store, shared by the live game (`host.js`) and the editor's live preview.
- `js/store.js` owns quiz CRUD (localStorage), validation, normalization, and import/export — including migrating quizzes created by earlier versions of QuizParty (a missing `type` defaults to multiple choice; a missing `media` block defaults to empty).
- `js/host.js` drives the game's phases (lobby → question → reveal → scoreboard → podium) and is the sole source of truth for scoring; it never trusts a player's claim of correctness.
- `js/player.js` is a thin connection/message dispatcher — all rendering is delegated to `js/qtypes.js`.
- `player.html` is the public, relay-only entry point a phone actually opens — a trimmed page with none of the editor/host/library code, so it stays small and works from any static HTTPS host.
- `relay/` is the Cloudflare Worker + Durable Object relay for the `'ws'` transport — see `relay/README.md`.
- `desktop/` is the Electron wrapper for the Windows app — see "Windows desktop app" above.

## Known limitations

- **Reconnecting mid-question**: a dropped phone auto-reconnects with its score and streak intact (matched by a persistent id in `localStorage`), but it re-joins as of the *next* question — there's no mid-question resume of remaining time or the current answer state.
- **Very large media**: image-pin sends its target image to players (over WebRTC directly, or as one relay message in `'ws'` mode), so a very large image will be slow to reach phones on a poor connection. Keep image-pin images reasonably sized (the centralized media policy in `js/media.js` already caps this).
- **The host must stay running** — closing it ends the game (there is no server to keep it alive).
- A working internet connection is needed for connection setup either way (PeerJS's broker, or the relay); very restrictive corporate/school firewalls that block WebRTC or WebSockets entirely will block the game too.
- Tested comfortably with room-sized groups (tens of players). It is not built for 1,000-player arenas.
- The relay (`relay/`) has no mid-game host-reconnect: if the host's connection to the relay drops, connected players are told the host disconnected and the room ends — there's no resume, only rejoining a new room.
- The Windows installer is unsigned; Windows SmartScreen will warn on first run (see "Windows desktop app" above).

## Contributing

Issues and PRs are welcome. The whole app is vanilla HTML/CSS/JS — if you can read a `<script>` tag, you can hack on it.

## License

[MIT](LICENSE) — do whatever you like. QuizParty is not affiliated with Kahoot! in any way; it's an independent open-source homage to the live-quiz format.
