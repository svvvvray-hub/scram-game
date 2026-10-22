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


## Playing field (v4) — host picks the boundary in the lobby
Under **Playing field** in the lobby the host chooses (everyone else sees the result on a lobby map):
- **No boundary** (default) — same as before, play anywhere.
- **Radius preset** — 0.25 mi (402 m), 0.5 mi (805 m) or 1 mi (1609 m) circle, centered on the host's GPS. Drag the
  📍 pin to move it, or tap **📍 Center on me**.
- **✏️ Draw shape** — tap the map to drop corners (touch-friendly; double-tap zoom is off so fast taps add points),
  **↩ Undo point**, **Clear**, **✅ Finish** (3–50 points). **Remove shape** / **Redraw shape** afterwards.
- Circle **and** shape together → the field is the **intersection** (inside both). The server rejects shapes that
  don't overlap the circle.

Server (`public/field.js`, shared by server and browser): validates the field (circle radius 50–5000 m; polygon
3–50 points, |lat| ≤ 85, |lng| ≤ 180, 20 m–20 km across; non-empty intersection), stores it on the lobby and
broadcasts it. Only the host can change it, in the waiting room or on the end screen; it **persists across Play
again** and can be edited between rounds. All maps (lobby, in-game, end summary) draw a yellow outline and darken
everything outside.
- **Start:** if any player is outside (or has no GPS fix), the host gets "Outside the playing field: Bob… Start
  anyway?" — OK force-starts, Cancel keeps the lobby. The lobby list shows an "outside field" pill.
- **During the game** the server checks every GPS fix (each tick). A player outside gets a red pulsing
  **OUT OF BOUNDS** banner + `navigator.vibrate` (repeats every 10 s while outside; no vibration on iOS), and
  their map zooms out to show the field. Everyone sees "⚠️ Name is out of bounds" (an in/out flag only —
  never coordinates).
- **Penalty:** a hider who stays outside for **30 s** (scaled with game length like the power-ups:
  `30 s × gameMin/20`, minimum 2 s; e.g. 3 s in the 2-min quick test) is flagged ("revealed at the next ping")
  and the next ping — scheduled or bounty — shows hunters their **true** position, ignoring an armed ghost decoy
  or bounty wipe (those stay saved for a later ping). Walking back in clears the flag. Hunters only get the
  warning. During head start a hider can be out without penalty (warning only); in sudden death there are no map
  pings, so the penalty is just the warning (the compass already points at them).
- **Bounties** spawn 50–250 m from the players' centroid, re-rolled until inside the field; if that fails
  (e.g. everyone is outside), a random point inside the field is used.

## Recording (v5) — client-only clips, never uploaded
- Floating **⏺ Record** button (top-right in the lobby, right edge mid-map in game). Records the back camera (`facingMode: environment`) + mic with `MediaRecorder`; mimeType picked from `video/mp4`, `video/webm;codecs=vp9`, `vp8`.
- While recording (v6 **radar layout**, mockup option 3): one view is full screen and the other sits in a round bubble (~45% width) in a corner. Default: camera full screen, map in the bubble (85% opaque, auto-centered on you, bold markers/boundary). **Tap the bubble** to swap instantly (camera ↔ map): the existing `<video>` and Leaflet map are just restyled with a 180 ms CSS transition — the camera isn't re-opened and the map isn't re-created; `map.invalidateSize()` runs after each swap. **Drag** the bubble (10 px drag-vs-tap threshold) to snap it to any corner. The choice and corner are remembered for the session (`sessionStorage`). HUD (timer, ping countdown, banners, REC bar with 🔄 Flip / ⏹ Stop, decoy/caught buttons) stays solid and the bubble is sized/placed so it never overlaps it. In dual-camera mode the front camera stays a small PiP. Stop returns the map to full screen. The old split-screen layout is gone.
- **Flip** stops and saves the current clip and starts a new one with the other camera. Each clip is a file `scram_<code>_<role>_<back|front>_<HHMMSS>.<webm|mp4>`.
- **Dual attempt**: on start it also opens the other camera; if both tracks stay `live` and deliver frames within ~1.5 s, two recorders run (back big, front picture-in-picture) and two files are saved. Otherwise it falls back to one camera with the toast “This phone allows one camera at a time; use Flip”.
- Clips are auto-downloaded when finished and listed in **🎞 My clips** (Download blob link + Share via `navigator.share` files where supported). Nothing goes to the server. Leaving the page warns if recording or a clip wasn't saved.
- GPS and the WebSocket keep running. The minute-10 cam peek reuses the recording's back-camera stream instead of opening the camera again.
- Denied camera → friendly toast; denied mic → video-only.
- **Limitations**: most phones (all iPhones, most Android) allow only one camera at a time, so dual mode usually falls back. iOS Safari records MP4 and may not auto-download (use Share / Download → Save to Files). Clips live in memory until saved; closing the tab or the phone killing the background tab loses them. Long clips use lots of RAM. Recording stops if the browser backgrounds the page.

### Tests
- `node test/e2e_record.js` — fake camera/mic: denied permission, record → flip → stop (2 clips, names, size>0, auto-download, nothing uploaded), radar bubble (tap swap, invalidateSize, drag snap, HUD clear of bubble, 5 rapid swaps with no new getUserMedia and recording uninterrupted; shots/radar_camera_big.png, shots/radar_map_big.png), cam peek while recording, dual attempt.
```
npm test                                  # 25 unit tests (node:test, fake WebSocket clients + fake GPS)
node test/e2e.js http://localhost:3000    # original 3-player browser e2e (rounds, rematch, leave, privacy)
node test/e2e_features.js http://localhost:3000   # power-ups e2e (fake GPS + fake camera) → shots/*.png
node test/e2e_field.js http://localhost:3000      # playing-field e2e: 0.25 mi circle + touch-drawn polygon, start prompt, out of bounds
```
Screenshots: `shots/lobby_toggles.png`, `hider_lobby_camera_notice.png`, `hider_decoy.png`, `hider_decoy_used.png`,
`hunter_bounty.png`, `hunter_cam_peek.png`, `hunter_cam_peek_open.png`, `compass.png`, `field_radius.png`, `field_draw.png`,
`ingame_boundary.png`, `out_of_bounds.png`.

**Limitations:** camera capture only works with the page open in the foreground (browsers block background
camera access); iOS needs the camera permission granted in Safari. Chime sound needs the phone not on silent
(iOS mutes Web Audio in silent mode); vibration isn't supported on iOS. Compass heading needs a magnetometer;
desktop browsers show north-up. GPS accuracy (±5–20 m) makes the 15 m claim and 40 m chime radii approximate.

## Run
```
npm install
npm start            # http://localhost:3000 (geolocation needs HTTPS except on localhost)
npm test             # 25 multi-client tests with fake GPS: ping timing, privacy/no-leak, catching, end, reconnect, TTL
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

## v5 — teams, catch confirmation, recap, reels, sharing

**Roles & teams.** The host taps role pills (any number of hunters, at least 1) or 🎲 *Randomize roles* with a chosen
hunter count. *🧟 Caught hiders join the hunters* (infection, on by default): the caught hider becomes a hunter,
gets a toast and starts receiving pings. Each hunter's ping marks *their* nearest uncaught hider (🎯), and the
sudden-death compass points each hunter at their own nearest uncaught hider. The game ends when every hider is caught
or time runs out.

**Catch confirmation.** A hider taps *I got caught* → the nearest hunter within ~30 m (any hunter if there's no GPS
fix) gets a Confirm / No prompt. A hunter taps a hider under *🙌 I caught someone* → that hider confirms. The other side
confirming (or also claiming) within 20 s finalizes it; unanswered claims expire. The host can confirm/cancel any claim,
and the host's own catches are immediate (override).

**Screen wake lock.** Requested when a round starts and while recording, re-acquired on `visibilitychange`, released
when the round ends (and recording stops). A warning shows if the browser has no Wake Lock API.

**Recap (end screen).** The server records each player's GPS trail (~every 5 s, memory only) and a structured event log
(pings incl. decoy fake points flagged as decoys, decoys armed, bounty claims, chimes, out-of-bounds in/out, catches
with who caught whom, the cam-peek photo, compass phase). Trails are **only sent after the round ends** (`recap`
message) — never during play — and are wiped at Play again / next start. The recap has:
- animated replay of everyone's path (▶ / scrubber; a whole round plays in 8–30 s, 20 min ≈ 30 s), event markers;
- 🔥 heat-map toggle (own canvas layer): blue = where hiders spent time, red = where hunters searched;
- awards: longest survivor, closest call, most distance walked, decoy master, bounty hunter, fastest catch, most out of bounds;
- **close calls**: a hunter within 20 m of an uncaught hider who then wasn't caught for 60 s
  (“Ana walked right past Bob, 12 m, at 07:42”) — in the timeline and on the replay (😱);
- 🏆 trophies: Ghost, Bloodhound, Close Shave, Decoy Master, Bounty Hunter, Marathoner, Escape Artist, First Blood, Zombie, Rule Bender;
- timeline of every event; *📤 Share recap* renders a 1080×1350 PNG (paths, awards, trophies, lobby code/date,
  opted-in Instagram handles, “Game by @mmmmmray”) and shares it via `navigator.share({files})`, else downloads it.
Math lives in `public/recap.js` (shared by server and browser, unit-tested).

**Recording.** Default *Standard* preset: 1280×720 ideal, ≤30 fps, 1.5 Mbps video, 64 kbps mono audio
(≈11.7 MB/min). ⚙ Quality: Saver 480p/0.8 Mbps (≈6.5 MB/min), High 1080p/4 Mbps (≈30.5 MB/min). MediaRecorder runs
with a 1 s timeslice and auto-saves a new file every 3 min (`…_part2`, `…_part3`); the next recorder starts on the same
stream before the old one stops, so there's no gap. Once a clip is downloaded/shared its blob is freed (during a round
clips are kept until the highlight reel is built or Play again). A one-time-per-session notice asks you to get
permission from anyone you record.

**Highlight reel (in the browser, no server video work).** At game end each recording phone picks moments from its
*own* clips by matching recording timestamps to event times (catches, close calls involving you, decoys, bounty claims,
chimes, the final seconds), cuts ~4 s around each and re-records them through a canvas + MediaRecorder at 720p ~2 Mbps:
title card (code, date, your name/role), captions (“CLOSE CALL - 12 m”, “CAUGHT!”), quick crossfades, final trophy card
with handles and creator credit. Preview → Save / Share. Phones without clips are skipped.
*Group reel (opt-in):* *📨 Send my highlights to host* uploads only your short cuts (each <10 s, ≤15 MB total) over the
WebSocket; held in server memory for that lobby only, deleted after 30 min or at Play again. The host's phone stitches
everyone's cuts in event-time order.
**🔥 Make it viral** (every player): vertical 720×1280, 15–30 s, ~2.5 Mbps — opens with your best moment
(catch > close call < 15 m > decoy > bounty > final seconds), big animated captions (“HE WAS 12 M AWAY 😳”,
“DECOY WORKED 👻”, “CAUGHT AT 19:58”), punch-in zoom, round mini-map bubble + countdown, beat-length cuts, optional
procedurally generated Web Audio beat ducked under the clip audio, end card “Play free → SHARE_LINK”, “Game by
@mmmmmray” and your handle. Shared with the text “Play free at <link>”.
*Limitations:* the page must stay in the foreground while building; building takes about real time (a 15 s reel takes
~15 s); iOS Safari records MP4 only, may refuse autoplaying/seeking blob video until you tap, may not capture audio
from `<video>` into the canvas stream, and `navigator.share` with video files needs iOS 15+; huge clips can run phones
out of memory — prefer Saver/Standard.

**Share links.** `SHARE_LINK` (top of `app.js`, default `location.origin + '/play'`). `/play` is a 302 to `/`
(set `PLAY_REDIRECT_URL` to point it at a custom domain); `/p/<code>` deep-links a lobby. `?ref=<handle>` visits are
counted in memory and logged (`[ref] handle visits=N`).

**Instagram (optional).** Join screen field; accepts `@handle`, `handle` or an instagram.com URL (letters, digits,
`.`, `_`, max 30), remembered in localStorage. Shown as a link only in the lobby and the recap (never during a game),
on the share image and the reel end cards. `CREATOR_IG = 'mmmmmray'` → “Follow the creator on Instagram”.

**Legal.** `/terms` and `/privacy` (Last Ping Terms / Privacy). Create/Join requires “I'm 18+ and agree to the Terms
and Privacy Policy” (remembered per `LEGAL_VERSION`); the server rejects create/join without `agreed: true`.

### Tests
`npm test` (unit: game, trails, awards/trophies/close calls, infection, multi-hunter targeting, catch confirmation,
highlight uploads, Instagram validation, /play redirect, consent). E2E (server on :3000, Chrome):
`node test/e2e.js`, `e2e_features.js`, `e2e_field.js`, `e2e_record.js`, `e2e_recap.js` (2-hunter game, catch confirm,
3 s recording segments at the preset bitrate, recap replay/heat map/share image, reels, group reel, viral clip).
