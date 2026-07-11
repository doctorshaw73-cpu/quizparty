# 🎉 QuizParty

**Free, open-source Kahoot-style live quiz game — with no backend at all.**

Put the host screen on a projector or TV, and everyone in the room joins on their phone with a 6-digit game PIN (or by scanning a QR code). Answer fast, climb the scoreboard, win the podium.

**▶ Play now: https://arvindfroi.github.io/quizparty/**

## How can it work without a server?

The host's browser *is* the game server. QuizParty uses **WebRTC data channels** (via [PeerJS](https://peerjs.com)): every player's phone connects directly to the host's browser, peer-to-peer. The only third-party involvement is PeerJS's free public signaling broker, which is used once per player to *establish* the connection — after that, all game traffic flows directly between the devices. No accounts, no database, no game data ever touches a server.

Your quizzes are stored in your browser's localStorage and can be exported/imported as JSON files.

## Features

- 🎨 Kahoot-style gameplay: colored shape answers, countdown timer, speed-based scoring (500–1000 pts), streak bonuses, scoreboard between questions, podium at the end
- ✏️ Quiz editor: 2–4 answers per question, multiple correct answers, per-question time limit (5–90 s) and point multiplier (standard / double / none)
- 📱 Players join with a PIN or QR code — nothing to install
- 🔁 Play again with the same room, late joiners welcome mid-game
- 📦 Export / import quizzes as JSON — share them however you like
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

If you don't want to rely on the free PeerJS cloud broker, run your own [PeerServer](https://github.com/peers/peerjs-server) and pass its host/port to the two `new Peer(...)` calls in `js/host.js` and `js/player.js`.

## Limitations (honesty corner)

- The host tab must stay open — closing it ends the game (there is no server to keep it alive).
- WebRTC needs a working internet connection for connection setup; very restrictive corporate/school firewalls that block WebRTC entirely will block the game too.
- Tested comfortably with room-sized groups (tens of players). It is not built for 1,000-player arenas.

## Quiz JSON format

```json
{
  "title": "My quiz",
  "questions": [
    {
      "text": "What is 2 + 2?",
      "answers": [
        { "text": "3", "correct": false },
        { "text": "4", "correct": true }
      ],
      "time": 20,
      "points": "standard"
    }
  ]
}
```

## Contributing

Issues and PRs are welcome. The whole app is vanilla HTML/CSS/JS — if you can read a `<script>` tag, you can hack on it.

## License

[MIT](LICENSE) — do whatever you like. QuizParty is not affiliated with Kahoot! in any way; it's an independent open-source homage to the live-quiz format.
