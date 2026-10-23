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
  opted-in social handles with their platform, “Game by @mmmmmray · Instagram”) and shares it via `navigator.share({files})`, else downloads it.
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

**Your @ (optional).** Join screen field with a platform picker: Instagram (default), TikTok, X, Snapchat, YouTube,
Threads, Facebook (`public/socials.js`, shared by browser and server). Accepts `@handle`, `handle` or a pasted profile URL
(the platform is detected from the URL). Per-platform rules (charset from `[A-Za-z0-9._-]`, 1-30 chars, e.g. X 1-15
`[A-Za-z0-9_]`, TikTok 2-24, Snapchat 3-15 starting with a letter, Facebook 5-30); lowercased except X and YouTube,
which keep display case (matching is case-insensitive). Handle + platform are remembered in localStorage and sent as
`social: {handle, platform}` (the legacy `ig` string is still accepted as Instagram). Shown with a small inline platform
badge, linking to instagram.com/h, tiktok.com/@h, x.com/h, snapchat.com/add/h, youtube.com/@h, threads.net/@h or
facebook.com/h, only in the lobby and the recap (never during a game), on the share image and the reel end cards.
Creator credit: env `CREATOR_HANDLE` + `CREATOR_PLATFORM` (default `mmmmmray` / `instagram`; legacy `CREATOR_IG` still
works as an Instagram handle), served at `/config.js` → “Follow @mmmmmray on Instagram”.

**Legal.** `/terms` and `/privacy` (Last Ping Terms / Privacy). Create/Join requires “I'm 18+ and agree to the Terms
and Privacy Policy” (remembered per `LEGAL_VERSION`); the server rejects create/join without `agreed: true`.

### Tests
`npm test` (unit: game, trails, awards/trophies/close calls, infection, multi-hunter targeting, catch confirmation,
highlight uploads, social handle validation per platform, /play redirect, consent). E2E (server on :3000, Chrome):
`node test/e2e.js`, `e2e_features.js`, `e2e_field.js`, `e2e_record.js`, `e2e_recap.js` (2-hunter game, catch confirm,
3 s recording segments at the preset bitrate, recap replay/heat map/share image, reels, group reel, viral clip).

## v6 — random power-up drops & chime

Server-authoritative (`powerups.js` = pure helpers, effects in `server.js`). All timings scale with game length
(`scale = gameMin / 20`), so the 2-min quick test shows everything.

**Drops.** Host setting *🎁 Power-up drops*: **Off / Normal** (default, every 3 min) / **Chaos** (every 90 s).
Drops alternate hider → hunter (≈6 per 20-min game), none in the first 2 min of the hunt or in sudden death (existing
drops vanish when it starts). Hider drops spawn 50–200 m from a hider, preferring spots farther from the hunters;
hunter drops 50–200 m from a hunter; always inside the (current) playing field. Unclaimed drops despawn after 2.5 min.
*Visibility:* hider drops are sent **only to uncaught hiders** (never to hunters); hunter drops are visible to everyone.
*Pickup:* stand within 15 m for 5 s continuously (progress ring; stepping out resets). Max 1 held power-up (tap to
use), 3-min cooldown between uses per player. *Steal:* a hider who holds a hunter drop for 5 s destroys it — the spot
flashes for everyone and that hider is immediately pinged to the hunters with their real location (decoys ignored).
Everyone gets a toast when a power-up is used (“A hider used Jammer!”, “Ana used Sonar!” — hiders stay anonymous).
Nothing can be used in sudden death (held ones are greyed out).

| Hider (weights) | Effect |
|---|---|
| 📡 Hunter Radar (~22 %) | see all hunters live for 30 s |
| 📵 Jammer (~22 %) | 60 s: hunters' map blurs/jitters and the compass spins (pings still happen) |
| 🤫 Silent Shoes (~22 %) | you never chime again this round (also immune to Sonar) |
| 🛡️ Shield (~15 %) | activate with no hunter within 20 m; the next hunter catch claim (or host catch) is auto-rejected once — “Shield blocked!”; lasts until used or 5 min |
| ⏩ Extra Time (~10 %) | −2 min on the clock for everyone (clamped so it never cuts into sudden death) |
| 💖 Revive (~10 %) | frees the earliest-caught hider (infected hunters revert to hider); everyone is told |

| Hunter (even odds) | Effect |
|---|---|
| 🔊 Sonar | every hider within 75 m chimes (Silent Shoes blocks it); ALL hiders see “A hunter used Sonar! (name)” |
| 🔍 Truth Ping | the next scheduled ping ignores decoys and bounty wipes for everyone (decoys stay armed). The game has no Ghost/Frozen effects, so nothing else to ignore |
| 🎯 Shrink Zone | field shrinks 30 % (circle radius ×0.7, polygon toward its centroid) for 3 min with the normal 30 s out-of-bounds grace; with no boundary, a circle on the hunters' centroid covering all players ×0.7 |
| 📷 Cam Peek+ | fresh snapshot request to every consenting hider, relayed to hunters |
| 🔥 Heat Trail | for 30 s, that hunter sees each hider's last-2-min trail |
| 🐕 Bloodhound | for 60 s, that hunter sees each hider's distance in metres (no direction) |

Recap: drops, pickups, steals and uses are in the timeline/replay; trophies **🦝 Thief** (stole a hunter drop) and
**⚡ Power Player** (most power-ups used).

**Chime.** Soft 3-note sine chime (E5–G5–B5, gentle attack), default **25 %** (Web Audio gain 0.25) — we play in
residential areas. Host lobby setting *🔔 Chime volume* 10–100 % applies to every phone. Every chime also vibrates
`[300,100,300]` and flashes the screen. *🔔 Check your sound* plays it and asks “Did you hear it?”; “No” shows tips.
Moving the slider (on release, or at most once per 1.5 s while dragging) or *Test chime on all phones* plays a preview
on every phone in the lobby (lobby only, server-throttled); each player votes 👍 Good / 🔉 Too quiet / 🔊 Too loud and
the host sees a live tally. Phones whose audio isn't unlocked yet get “Tap to enable sound”.
**Note:** websites cannot override the phone's silent/Do-Not-Disturb mode or its volume — the vibration and flash are
the fallback.

Tests: `test/powerups.test.js` (spawn timing/distances/field, visibility, 5 s pickup + reset, max held + cooldown,
steal-and-ping, every effect, weight distribution, Off/Chaos, chime volume, chime preview throttle/broadcast/tally).
E2E `test/e2e_powerups.js` needs a server started with `SCRAM_TEST_PU=hider:radar,hunter:sonar` (a test-only hook
that forces drop types): `PORT=3001 SCRAM_TEST_PU=hider:radar,hunter:sonar node server.js` then `node test/e2e_powerups.js`.

## v7 — named hunter power-ups + How to play
- Hunter power-up toasts name the hunter: "Hunter Murray used Sonar!" (the Sonar alert to hiders too). Hider toasts stay anonymous: "A hider used Jammer!".
- `public/rules.html` (also at `/rules`): a dark, phone-friendly rules page with a sticky table of contents and collapsible sections. Its numbers come live from `/api/rules`, which reads the game constants, so the page can't drift from the code.
- A "📖 How to play" button on the join screen and in the lobby opens the rules in an in-app iframe sheet. The WebSocket stays connected, and "← Back" inside the sheet just closes it.

## v8: teammate visibility and player cap
- **Teammates visible** (host toggle, on by default): uncaught hiders see the other uncaught hiders live (🤝 purple marker with name) on every GPS update. The server builds a separate view for each player, and those positions go only to uncaught hiders, **never to hunters**. Hunters still see each other live, as before. When a hider is caught and infected, they immediately stop getting hider positions, start getting hunter positions, and drop off the other hiders' maps. A player caught without infection becomes a spectator and sees nothing live until the recap. Unit tests grep every frame hunters receive for leaked hider coordinates.
- **Player cap:** `MAX_PLAYERS` (env, default 20, range 2–500) per lobby. Joining a full lobby gets `Lobby is full (20/20)`. The lobby shows `Players 7/20`, and the cap is in `/api/rules` and on the rules page.
- **Capacity:** the Render free tier comfortably handles a few concurrent lobbies of 20. Each GPS update triggers small per-player JSON frames, so the work per lobby grows with the square of its size, but at 20 players and one update every 2–5 s per player that's only a few hundred small messages a second. One caveat: the free instance sleeps when idle, so the first visit can take about 30 s.

## v9: simpler UX and modern UI
- **Game modes:** the host picks Classic (the default for new lobbies), Party, Chaos or Custom, and each has a one-line description.
  - Classic = pings, field, chime and catch confirmation.
  - Party = Classic + decoys, bounties, power-ups (Normal) and the compass.
  - Chaos = everything on, with power-ups on Chaos.
  - Custom reveals the individual toggles.
  - Changing any toggle switches the lobby to Custom.
  - The modes come from the same server constants as `/api/rules` (`modes` and `defaultMode`), and the rules page renders them from there.
- **Coach tips:** one-time and dismissible, stored per device (`localStorage.scramTips`), shown one at a time, and hidden after 6 s. They cover:
  - first ping (hunter and hider versions)
  - decoy ready, bounty, power-up pickup and power-up held
  - chime (hider and hunter versions)
  - out of bounds, compass, caught, infected and recording
  - "Reset tips" is in the lobby and in ⋯ More.
- **Role card:** a full-screen "You're a HIDER / HUNTER" card in the role color, with the goal, the head-start countdown ("Hide! 2:00" / "Wait... hunters release in 2:00") and 3 bullets summarising the mode. Tap to close it; the hunter's card closes itself at release. Infected players get "You've been infected, you're a HUNTER now".
- **Bottom action bar:** power-up slot (icon, cooldown ring, greyed out in sudden death), decoy (charges badge), Catch (opens a catch sheet) or I got caught, Record, and ⋯ More (sound check, rules, clips and quality, reset tips, end game for the host, leave). Buttons are at least 56 px, the bar respects safe-area insets, and the radar bubble sits above the bar.
- **Pings:** a ripple appears on the map at each pinged spot, hunters' phones buzz (`navigator.vibrate(40)`), and an SVG ring around the ping timer counts down (red in the last 5 s).
- **Map:** markers are clean SVG badges (`public/icons.js`): hunters red, hiders cyan, teammates purple, drops and bounties gold with a per-type power-up glyph, the recap decoy as a ghost, and "you" in green with a pulse. The boundary stays bold yellow.
  - **Basemap:** CARTO's dark raster tiles now return an "API KEY REQUIRED" placeholder without a key. So the default is OSM tiles with a CSS dark filter, attribution kept.
  - **Your own dark tiles:** set `DARK_TILES_URL` (and `DARK_TILES_ATTR`), e.g. CARTO `dark_nolabels` with your key. If those tiles fail to load, the map falls back to the filtered OSM tiles.
- **Motion:**
  - Markers glide to new positions over 600 ms.
  - Sheets slide up with a spring easing.
  - Toasts and tips animate in and out.
  - `prefers-reduced-motion` turns all of this off, including the gliding.
- **Invites:** a big join code (tap to copy), a QR code of `/p/<code>` rendered server-side with the bundled `qrcode` package (no CDN), and a Share invite button (`navigator.share`, or a copied link as fallback). Opening the QR link prefills the join screen. If `PLAY_REDIRECT_URL` is set, `/p/<code>` follows it, as before.
- **Battery saver** (`public/gps.js`, unit-tested in `test/gps.test.js`):
  - **How GPS is read:** `watchPosition` with `maximumAge: 3000`.
  - **Saver mode:** if you've moved less than 5 m and no known enemy, drop or bounty is within 150 m, uploads happen at most every 15 s. Otherwise they happen every 3-5 s, and urgently in the compass phase or during a pickup.
  - **What counts as an enemy:** only positions your phone already has (pings for hunters, Radar for hiders). The server never hints at proximity.
  - **Accurate pings:** 5 s before every scheduled ping (scaled for short games), the server sends `need_fix`. Every phone then uploads straight away and asks for a fresh high-accuracy fix. Catch claims also force an upload.
  - **Background:** map rendering pauses while the page is hidden.
  - **Indicator:** 🔋 Saver shows in the HUD.
- **Tests:**
  - **Unit:** `npm test` covers modes, `need_fix` and the throttle.
  - **New e2e:** `node test/e2e_v9.js` against a server with real defaults (`PORT=3002 node server.js`).
  - **Older e2e suites:** run against `SCRAM_DEFAULT_MODE=custom node server.js` (the old everything-on defaults) and set `localStorage.scramQuiet=1` to skip the role card and tips. Those two are test-only hooks.
- **Screenshots:** `shots/v9_*.png`.

### v10: in-app browsers + rejoin
- `public/inapp.js` — `InApp.detect(ua)` → `{ inApp, app, os }` (Zalo, Facebook, Instagram, Messenger, Line, TikTok, WeChat, Snapchat, Android `; wv)`), `InApp.chromeIntent(href)` → Chrome `intent://` URL keeping the code/ref query. Android shows **Open in Chrome**; iOS shows an arrow + "tap ⋯ / share → Open in Safari" + Copy link. The × minimizes; the banner stays on the join screen.
- Rejoin: `localStorage.scram = { code, token, id }`. Auto-rejoin on load (same/no invite code), socket reconnect, visibilitychange and bfcache `pageshow`; opening a different link sends `peek` and shows a **Rejoin game** button. Server keeps a disconnected slot (role, team, caught state) for the lobby's life (≥ `DISCONNECT_GRACE_MS` = 10 min); disconnecting never marks anyone caught or removed.
- Tests: `test/inapp.test.js`, v10 case in `game.test.js`, e2e `PORT=3010 node server.js` then `node test/e2e_v10.js`.

## Growth dashboard & brake switch (`/admin`)

Set `ADMIN_KEY` (a long random string) to enable `/admin`. Without it, `/admin` returns 404; a wrong key returns 401.
Sign in with the login form or open `/admin?key=YOUR_KEY` once: both set an HttpOnly cookie that holds an HMAC of the key (never the key), and the key is removed from the URL.

- **Stats:** games created/started per day, unique players per day (anonymous random device id, SHA-256 hashed, no personal data), live games/players, totals, top `?ref` referrers (new players, games, visits), `/play` clicks, reel and "Make it viral" shares. Charts are inline SVG. JSON at `/admin/stats.json` (auth required).
- **Players' socials:** every handle a player chose to enter, keyed by platform + handle (case-insensitive), with platform, first/last seen, games played and `?ref`. Filter by platform, per-platform counts, links to the right profile, sortable. CSV at `/admin/socials.csv` (alias `/admin/handles.csv`; columns `handle,platform,profile_url,first_seen,last_seen,games,ref`, `?platform=` filter). 🗑️ Delete per row (confirmation, authenticated POST `/admin/handles/delete` with `platform` + `handle`) for removal requests. Saved Instagram-only entries from older versions are migrated on load (no platform = Instagram).
- **Brake switch:** pause new games, max concurrent games (default `MAX_GAMES`, 50), max new games per hour (0 = unlimited). Blocked creates show "Last Ping is busy right now. Try again in a few minutes!". Joining an existing game is never blocked, and running games keep going. Settings change only via authenticated POST `/admin/settings`.
- **Storage:** `STATS_FILE` (default `./data/stats.json`, gitignored), written at most every 5 s and on shutdown.

**Render free plan caveat:** the free instance's filesystem is ephemeral. Stats, brake settings **and next-game polls** reset on every redeploy, restart, or spin-down after idling. The brake then falls back to `MAX_GAMES`, unpaused.
To keep the data, use one of these upgrade paths:
1. **Render persistent disk** (paid instance): add a disk (for example, mount path `/var/data`) and set `STATS_FILE=/var/data/stats.json`. No code changes are needed.
2. **Free hosted database** (for example Neon Postgres, Upstash Redis, or Turso): replace `load`/`flush` in `stats.js` with reads and writes of the same JSON blob. This needs one client library, so it isn't included by default.

## v13.1: secret roles until the reveal
- **No lobby roles.** Nobody's lobby shows hunter/hider (no pills, no counts). By default roles are **dealt randomly at Start**; the host only sets *how many hunters*.
- **Host-only manual pick:** "🔒 Pick hunters manually (host only — players never see it)" shows 🔒 pick buttons on the host's phone only. The pick (`hostPick`) is sent to the host alone; players never receive it.
- **Server:** before `revealAt` (lobby + countdown) every state is a role-free `preView` (names, GPS, presence, own location only: no `role`, pings, photos, drops, decoys, teammates; `session` peek omits role). Roles go out in a broadcast exactly at `revealAt`. After the reveal the existing visibility rules apply unchanged.
- **Wire:** `{type:'pick', manual, hunters}`; `randomize` = random deal with N hunters; `role` (host, lobby) = toggle that player in the secret manual pick.
- Tests: `reveal.test.js` (no role data on the wire before revealAt, side-only visibility after), `game.test.js` lobby case; `e2e_v13.js` checks every lobby DOM for role strings/classes, records every WS frame before revealAt (no role data), and writes `shots/v13_lobby_noroles.png`. Older suites pick the host as hunter explicitly (secret manual pick) instead of relying on lobby roles.

## v14: Plan the next game (whenisgood-style poll)
- **Recap → 📅 Plan the next game** (host only by default; set `PLAN_ANYONE=1` to let any player propose). Pick **2-8 times** with quick chips (this Sat/Sun at 11am, 2pm, 4pm, 6pm) or the custom date-time picker, and **1-3 places**: tap the mini map (local Leaflet) and add an optional label, or tap a suggestion: *This game's field* or a *Past area* (field centers of games this device hosted, kept in `localStorage.scramAreas`, newest 6).
- Times are stored as **UTC** ms and always shown in the viewer's zone with a short label (`Sat, Oct 24 · 4pm PDT`).
- **Link:** `/p/CODE` (6 characters; lobby codes stay 5 and keep their `/p/<code>` redirect). Poll pages are served by the app on whatever host it's reached at, so they also work from the `/play` redirect domain. **Share poll** uses `navigator.share` (or copies) with *"Who's down for another round of Last Ping? Vote here: <link>"*; the link carries `?ref=<sharer's saved handle>`, so visits count in the referral stats and new players keep the ref when they play.
- The host's lobby gets a `plan` message, so every player's recap shows **🗳 Vote on the next game** (late joiners get it too).
- **Voting:** no sign-up: a name (prefilled from the saved player name) + optional @handle. Tap an option = ✅ yes, tap again or long-press = 🤷 maybe, again = clear. Re-voting from the same device updates your row (random per-device voter id, stored hashed).
- **Live tally:** WebSocket `{type:'pollSub', code}` pushes every vote/lock (10 s polling fallback). Grid of times × places; the **best combination glows**: most voters with yes for both, then most yes-or-maybe, then earliest time, then place order. A who-voted table shows each voter's marks.
- **🔒 Lock it** (creator only: a random creator token kept in `localStorage.scramPolls`, only its SHA-256 is stored) picks the final time + place (defaults to the best). Everyone viewing sees **"Next Last Ping: Sat 4pm at <place>"** with **📅 Add to calendar** (`/api/polls/CODE/ics`, RFC 5545: UTC times, escaped + folded, CRLF), a Google Calendar template link, a map link and a **🖼 Share card**: a 1080×1920 canvas with time, place, a QR code of the poll (the existing `/qr/<code>.svg` generator) and **"Game by @handle"** from `CREATOR_HANDLE`/`CREATOR_PLATFORM`. The creator can change the plan or reopen voting.
- **Storage:** polls live in the stats JSON (`STATS_FILE`, throttled writes) under `polls`, and expire **14 days after their latest time option** (swept hourly and on access). **On Render's free plan they are lost whenever the instance restarts or sleeps**, like the other stats (use a persistent disk to keep them).
- **Limits:** 2-8 times (future, ≤180 days ahead), 1-3 places, names 20 / labels 40 chars (control and bidi characters stripped), **max 30 voters per poll**, **max 200 active polls**, 20 polls per IP per hour, 8 KB request bodies. All user text is escaped on output (poll page, admin, .ics).
- **Privacy:** a vote stores only the name and optional handle the voter types (plus their picks); no other personal data. One line added to `/privacy` and `legal/privacy.md` (the PDF in `legal/` was not regenerated).
- **/admin:** a *Next-game polls* card: active count, voters in active polls, created/locked totals and the recent polls (code, creator, options, voters, status, expiry). `stats.json` includes `polls`.
- **API:** `POST /api/polls` `{times:[ms], places:[{lat,lng,label}], name, social}` → `{code, token}`; `GET /api/polls/CODE[?v=voterId]`; `POST /api/polls/CODE/vote` `{voter, name, social, t:[0|1|2], p:[0|1|2]}` (2 = yes, 1 = maybe); `POST /api/polls/CODE/lock` `{token, time, place}` or `{token, unlock:true}`; `GET /api/polls/CODE/ics`.
- Files: `polls.js` (server logic + .ics), `public/plan.js` (create sheet, poll view, card), `public/plan.html` (`/p/CODE`).
- Tests: `test/plan.test.js` (validation, limits, best combo, lock auth, .ics, expiry, persistence, XSS escaping, WS live updates, lobby message) is part of `npm test`. E2E: `ADMIN_KEY=e2e-admin-key STATS_FILE=/tmp/lp_e2e14.json PORT=3014 node server.js` then `node test/e2e_v14.js` (host creates from the recap, 3 voters in separate contexts incl. a London time zone, live update, long-press/second-tap maybe, best-combo glow, lock, .ics/Google/map links, 9:16 card with QR, XSS, admin, referral).
- Screenshots: `shots/v14_plan_create.png`, `shots/v14_plan_vote.png`, `shots/v14_plan_locked.png`, `shots/v14_next_card.png`.
