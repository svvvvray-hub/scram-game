# Scram — GPS hide & seek in the phone browser

Multiplayer hide-and-seek: hunters only see hiders' positions at each server "ping".
No install, no accounts. Works in Chrome (Android) and Safari (iOS) over HTTPS.

## How to play
1. Host opens the URL, enters a name, taps **Create game**. Share the 5-letter code, link or QR.
2. Friends open the link, enter a name, **Join**, and allow location (green "GPS ±Nm" pill = good).
3. Host sets roles (tap a role pill, or 🎲 randomize), game length / ping interval / head start, then **Start**.
4. Hiders run during the head start (hunters' map is covered). Every ping, hunters see each hider's last
   location + accuracy circle. Tap **Mark caught** (or hider taps **I got caught**). Hiders win if anyone is
   left when the clock hits 0; hunters win if everyone's caught. End screen shows each hider's ping trail.

Keep the screen on and the tab in front — browsers (esp. iOS Safari) pause GPS when the screen is off/locked.
The app requests a Screen Wake Lock where supported (Chrome Android, Safari iOS 16.4+).

## Design
- `server.js` — Express + `ws`. Server is authoritative for the timer, head start and ping schedule.
  Every message is built per-recipient by `viewFor()`: hider coordinates are only ever sent to hunters as
  **snapshots taken at ping time** (`L.pings`); live hider positions never leave the server.
  Hunters see each other live; hiders see only themselves (+ "you were revealed X s ago").
- Reconnect: each player gets a secret token (localStorage); refresh / screen-lock reconnects to the same
  player. Clients re-sync on `visibilitychange`, heartbeat their location every 15 s; >45 s without an
  update = "stale" warning.
- Rounds: **Play again** puts the same lobby (same code/link/QR, same players, settings, pre-game roles)
  back in the waiting room; caught flags, pings and trails are wiped. Any player can trigger it; others keep
  seeing their summary until they tap Play again. **Leave lobby** (waiting room / end screen; small button with
  confirm during play) removes you for everyone and clears your saved session; host passes to the next player.
- Privacy: everything is in memory. A lobby is deleted as soon as the last player leaves, or after 1 h with no
  game running (a running round is capped at 6 h). Trails are kept only until the next round starts.
- Frontend: plain JS + Leaflet (bundled in `public/vendor`) + OpenStreetMap tiles.


## Power-ups (v3) — all server-authoritative, host toggles in the lobby (“Power-ups”), all on by default
Timings below are for a 20-min game and **scale with game length** (`scale = gameMin / 20`), measured from the end of the head start.
1. **👻 Ghost decoy** — each hider has 2 charges/round. Tapping it arms the *next scheduled* ping: hunters get a
   fake coordinate 30–150 m from the hider's real spot (random bearing), indistinguishable from a real ping.
   Charges / “ARMED” shown in the hider panel. (The end-of-game summary trail includes the decoy point.)
2. **🔔 Cold-ping chime** — at each scheduled ping, any hider within 40 m of any hunter gets a 1.5 s Web Audio
   oscillator chime (+ vibrate) and “You chimed!”. Hunters get “A hider chimed nearby!” with no location.
   Audio is unlocked on the first tap (Create / Join / Ready / any tap).
3. **💰 Bounty** — every 5 min a waypoint spawns 50–250 m from the players' centroid, shown to everyone with a
   15 m circle. Walk within 15 m to claim (checked on every GPS update). Hider claims → their next scheduled
   ping is wiped (hunters see nothing for them that cycle). Hunter claims → immediate out-of-cycle ping of all
   hiders (regular schedule unchanged). Despawns on claim or when the next one spawns (and at sudden death).
4. **📷 Hider cam sneak peek** — hiders tap **Ready — allow camera** in the lobby (clear notice: hunters see one
   photo at minute 10) or **Ready without camera**. At minute 10 the server asks each consenting, connected
   hider's page for one rear-camera frame (`facingMode: 'environment'`, ≤640 px JPEG q 0.6). Denied, background
   tab, or no reply within ~15 s → hunters see “photo unavailable”. Photos are relayed **only to hunters**, carry
   no GPS, are kept in memory only for that round (wiped at Play again / lobby deletion, never written to disk).
   Hunters see thumbnails; tap to enlarge.
5. **🧭 Sudden-death compass** — 18:00–20:00: map pings stop and bounties end. Every ~2 s each hunter gets
   `{bearing, band}` to the nearest uncaught hider (bands: scorching <25 m, hot <75, warm <150, cool <300,
   cold) — never coordinates. Red pulsing arrow; rotates with phone heading via DeviceOrientation (iOS
   `requestPermission` via “Enable phone compass”), falls back to north-up.

**Quick testing:** lobby button **⚡ Quick test: 2-min game** (pings 10 s, bounty every 30 s, cam at 1:00, compass
from 1:48), or type any game length (e.g. 1 min), or start the server with `GAME_MIN=2 node server.js` to change
the default length.

### Tests
```
npm test                                  # 18 unit tests (node:test, fake WebSocket clients + fake GPS)
node test/e2e.js http://localhost:3000    # original 3-player browser e2e (rounds, rematch, leave, privacy)
node test/e2e_features.js http://localhost:3000   # power-ups e2e (fake GPS + fake camera) → shots/*.png
```
Screenshots: `shots/lobby_toggles.png`, `hider_lobby_camera_notice.png`, `hider_decoy.png`, `hider_decoy_used.png`,
`hunter_bounty.png`, `hunter_cam_peek.png`, `hunter_cam_peek_open.png`, `compass.png`.

**Limitations:** camera capture only works with the page open in the foreground (browsers block background
camera access); iOS needs the camera permission granted in Safari. Chime sound needs the phone not on silent
(iOS mutes Web Audio in silent mode); vibration isn't supported on iOS. Compass heading needs a magnetometer;
desktop browsers show north-up. GPS accuracy (±5–20 m) makes the 15 m claim and 40 m chime radii approximate.

## Run
```
npm install
npm start            # http://localhost:3000 (geolocation needs HTTPS except on localhost)
npm test             # 18 multi-client tests with fake GPS: ping timing, privacy/no-leak, catching, end, reconnect, TTL
node test/e2e.js URL # headless Chromium, Pixel 7 emulation, 3 players, 2-min game, 10-s pings, writes shots/*.png
```

## Public URL from this box (temporary, anonymous)
`./run.sh` starts the server (auto-restart loop) and `tunnel.sh` (anonymous **Pinggy** tunnel, SSH carried
inside TLS on port 443 because this box only allows 80/443 egress — Cloudflare quick tunnels need port 7844,
which is blocked here). Current URL: `PUBLIC_URL.txt`; history: `logs/urls.log`.
- Free anonymous Pinggy tunnels expire after **60 minutes**; the script reconnects automatically but the
  **URL changes** each time (and on any restart). Ongoing games are lost only if the server restarts, not
  the tunnel — players just need the new URL (their session token is per-domain, so they rejoin by code).
- First visit shows a Pinggy "Enter site" warning page — tap **Enter site**.
- Elsewhere (no port block) you can use `cloudflared tunnel --url http://localhost:3000` instead.

## Permanent free hosting (with Murray's own account — not done here)
**Render (recommended, free web service, WebSockets supported):**
1. Push this folder to a GitHub repo (`git init && git add . && git commit -m scram && gh repo create`).
2. render.com → New → **Web Service** → connect the repo.
3. Runtime Node, Build `npm install`, Start `node server.js`, Instance type **Free**. Deploy.
4. Share `https://<name>.onrender.com`. Free instances sleep after ~15 min idle (first load ~30-60 s);
   since state is in memory, a sleeping/restarting instance drops lobbies — open it a minute before playing.

**Fly.io:** `fly launch` (uses the Dockerfile), `fly deploy`; set `min_machines_running = 1` and a single
machine (state is in memory). Requires a card on file. **Railway:** New Project → Deploy from GitHub; trial
credit then paid. **Glitch** ended project hosting in 2025, so it's no longer an option.
Run only **one instance** — lobbies live in that process's memory.

## Docker
```
docker build -t scram . && docker run -p 3000:3000 scram
```
