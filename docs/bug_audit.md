# Last Ping: bug audit (October 2026)

A list of ~100 common bugs in GPS hide-and-seek / location games, realtime WebSocket multiplayer games and mobile web apps, built from public bug lists, postmortems and docs (Pokémon GO help pages, Jet Lag hide-and-seek community threads, OWASP cheat sheets, WebKit / Chromium bugs, MDN, Render docs). Each item was checked against this repo.

Status: **Not affected** (handled, with evidence) · **Affected → Fixed** (fixed in this change, with a test) · **Affected (not fixed)** (see Recommendations) · **N/A**. Line numbers are as of this commit.


## Summary

- Items checked: **115**
- Affected: **38** (fixed now: **26**, left as recommendations: **12**)
- Not affected: **76** · N/A: **1**


## A. Hider privacy & secret roles

| # | Bug | Status | Evidence | Source |
|---|---|---|---|---|
| 1 | Hider live coordinates included in state broadcasts to hunters | Not affected | `server.js:210-214` `canSeeLive`: hunters only see themselves + hunters; hider coords never from `p.loc` | [link](https://www.reddit.com/r/JetLagTheGame/comments/16uq6mw/should_jl_obscure_gps_positions_in_future_seasons/) |
| 2 | Hider coordinates in ping messages sent to non-hunters | Not affected | `server.js:348` `locs` only spread for `isHunter(p)` | [link](https://www.reddit.com/r/JetLagTheGame/comments/16uq6mw/should_jl_obscure_gps_positions_in_future_seasons/) |
| 3 | Roles (own or others) on the wire before `revealAt` | Not affected | `server.js:203` `pre` → `preView` (`:251-268`) has no role / pings / drops; `reveal.test.js` | [link](https://gafferongames.com/post/what_every_programmer_needs_to_know_about_game_networking/) |
| 4 | Role leaked via the pre-rejoin `peek` before the reveal | Not affected | `server.js:688-690` role only when `!preReveal` | [link](https://gafferongames.com/post/what_every_programmer_needs_to_know_about_game_networking/) |
| 5 | New host inherits the old host's secret manual hunter pick (sees roles before the reveal) | Affected → **Fixed** | `server.js:195` `setHost()` clears the manual pick on host change (leave + offline handoff); `test/audit.test.js` | [link](https://gafferongames.com/post/what_every_programmer_needs_to_know_about_game_networking/) |
| 6 | Recap / trails / full ping history exposed before the round ends | Not affected | `buildRecap` returns null unless `ended`; full `pings` only when `ended` (`viewFor`) | [link](https://www.reddit.com/r/JetLagTheGame/comments/16uq6mw/should_jl_obscure_gps_positions_in_future_seasons/) |
| 7 | Teammate positions reach caught hiders or hunters | Not affected | `server.js:212` requires `me` hider, not caught, `running` | [link](https://www.reddit.com/r/JetLagTheGame/comments/16uq6mw/should_jl_obscure_gps_positions_in_future_seasons/) |
| 8 | Hider-side drops (spawned near a hider) visible to hunters | Not affected | `viewFor` drops filter `d.side === "hunter" || hiderView` | [link](https://www.reddit.com/r/JetLagTheGame/comments/16uq6mw/should_jl_obscure_gps_positions_in_future_seasons/) |
| 9 | Bounty spawns around the centroid of all players incl. hiders (rough position hint) | **Affected** (not fixed) | `server.js:353-359` `spawnBounty` centroid of every un-caught player | [link](https://www.reddit.com/r/JetLagTheGame/comments/16uq6mw/should_jl_obscure_gps_positions_in_future_seasons/) |
| 10 | Social handles visible during the game (de-anonymises hiders) | Not affected | `server.js:209` handles only in lobby + recap | [link](https://www.reddit.com/r/JetLagTheGame/comments/16uq6mw/should_jl_obscure_gps_positions_in_future_seasons/) |
| 11 | Cam-peek photos sent to hiders / non-hunters | Not affected | `relayPhoto` + `viewFor` photos only for hunters | [link](https://www.reddit.com/r/JetLagTheGame/comments/16uq6mw/should_jl_obscure_gps_positions_in_future_seasons/) |
| 12 | Locations written to server logs | Not affected | no `console.log` of `loc`/`locs` anywhere in `server.js` | [link](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html) |
| 13 | Other players' session tokens sent to clients | Not affected | token only in the player's own `joined` message (`server.js:693`) | [link](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html) |
| 14 | Out-of-bounds flag / GPS accuracy of hiders visible to all (by-design rule info only, no coords) | Not affected | `outFlag` + `acc` only; announced as a rule event | [link](https://www.reddit.com/r/JetLagTheGame/comments/16uq6mw/should_jl_obscure_gps_positions_in_future_seasons/) |

## B. GPS / Geolocation

| # | Bug | Status | Evidence | Source |
|---|---|---|---|---|
| 15 | Geolocation needs a secure context (HTTPS) | Not affected | `public/app.js:166` warns; Render serves HTTPS | [link](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation_API/Using_the_Geolocation_API) |
| 16 | Permission denied (iOS Safari) leaves a dead watch with no recovery path | Not affected | `app.js:172-175` clears the watch, explains settings; GPS retry button | [link](https://stackoverflow.com/questions/70228287/how-is-it-determined-when-to-prompt-user-location-permissions-on-ios-safari) |
| 17 | iOS ends the watch while suspended; not restarted on return | Affected → **Fixed** | `app.js` visibilitychange now calls `startGps()` when the watch is gone | [link](https://github.com/apache/cordova-plugin-geolocation/issues/224) |
| 18 | No location updates while the tab is backgrounded / screen locked | **Affected** (not fixed) | platform limit (no background geolocation on the web); mitigated: wake lock, `STALE_MS` 45 s stale flag (`server.js:21`), warnings | [link](https://www.xjavascript.com/blog/it-is-possible-to-watch-the-location-in-the-background-on-mobile-ios-android/) |
| 19 | Stale cached fixes accepted (`maximumAge` too high) | Not affected | `app.js:176` `maximumAge: 3000`; pre-ping `freshFix` uses `maximumAge: 0` | [link](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation/getCurrentPosition) |
| 20 | Out-of-order (older) fix overwrites a newer one | Affected → **Fixed** | `public/gps.js` `accept()` rejects `ts` older than the current fix | [link](https://www.w3.org/TR/geolocation/) |
| 21 | Coarse cell/Wi-Fi fix right after a good one (jump → false out-of-bounds reveal / catch) | Affected → **Fixed** | `gps.js` `accept()`: >200 m and 4x worse within 30 s is ignored; `test/gps.test.js` | [link](https://niantic.helpshift.com/hc/en/6-pokemon-go/faq/2520-gps-troubleshooting-guide/?hl=en) |
| 22 | NaN / out-of-range coordinates accepted by the server | Not affected | `server.js:705` finite + range check | [link](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html) |
| 23 | (0,0) "Null Island" bogus fixes accepted | Affected → **Fixed** | `server.js:705` and `gps.js accept()` reject (0,0) | [link](https://en.wikipedia.org/wiki/Null_Island) |
| 24 | Client timestamps trusted (absurd `ts`) | Affected → **Fixed** | `server.js:706-707` ts kept only within ±24 h of server time | [link](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html) |
| 25 | GPS drift triggers pickups / claims while standing still | Not affected | pickups need a 5 s dwell within 15 m (`pickupMs`, `checkPickups`) | [link](https://gameinformer.com/b/news/archive/2017/01/17/pok-233-mon-go-update-to-fix-gps-drifting) |
| 26 | GPS spoofing / mock locations / "micro drift" abuse | **Affected** (not fixed) | no spoof detection (server trusts client fixes) | [link](https://pokemongohub.net/post/news/niantic-confirms-micro-gps-drift-is-a-tos-violation-in-pokemon-go/) |
| 27 | Battery drain from constant high-accuracy uploads | Not affected | `gps.js decide()` adaptive 3-15 s uploads | [link](https://www.gamespot.com/articles/pokemon-go-all-the-known-issues-here/1100-6441532/) |
| 28 | Poor accuracy (urban canyon, indoors) not surfaced to players | Not affected | `app.js` `warnings()` flags ±100 m+ and stale GPS; lobby shows ±m | [link](https://niantic.helpshift.com/hc/en/6-pokemon-go/faq/2520-gps-troubleshooting-guide/?hl=en) |
| 29 | Flat-earth distance math errors | Not affected | haversine `distM` (`server.js:46-50`, `field.js`) | [link](https://en.wikipedia.org/wiki/Haversine_formula) |
| 30 | Field polygon validation (huge / tiny / too many points / poles) | Not affected | `public/field.js:163-186` (≤50 pts, 20 m-20 km, |lat|≤85) | [link](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html) |
| 31 | Field across the antimeridian breaks point-in-polygon | N/A | fields ≤20 km; no play areas on the 180° meridian | [link](https://en.wikipedia.org/wiki/Haversine_formula) |
| 32 | Geolocation unsupported browser not handled | Not affected | `app.js:165` sends `perm: unsupported` | [link](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation_API/Using_the_Geolocation_API) |

## C. WebSocket & realtime

| # | Bug | Status | Evidence | Source |
|---|---|---|---|---|
| 33 | Throwing message handler crashes the whole process (`JSON` `null`, bad `cuts[]`) | Affected → **Fixed** | `server.js:658-659` shape check + try/catch around `onMsg`; `cuts` entries checked (`:805`); `test/audit.test.js` | [link](https://nodejs.org/api/process.html#event-uncaughtexception) |
| 34 | No message size limit before join (24 MB `maxPayload` for anyone) | Affected → **Fixed** | `server.js:656` 64 KB before join, 1 MB in game (only post-game reel uploads bigger) | [link](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html) |
| 35 | No per-socket message rate limit (perm/cam/chimeVote spam is broadcast to the lobby) | Affected → **Fixed** | `server.js:652-654` token bucket 60 burst / 30 per s, flooders closed (1008) | [link](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html) |
| 36 | No per-IP limit on create / join | Affected → **Fixed** | `server.js:671` 20 creates / 120 joins per IP per 10 min (env `CREATE_PER_IP`, `JOIN_PER_IP`) | [link](https://codezup.com/securing-websocket-connections-tutorial/) |
| 37 | No per-IP limit on concurrent WebSocket connections | **Affected** (not fixed) | `wss.on("connection")` accepts any number | [link](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html) |
| 38 | Origin header not checked (cross-site WebSocket hijacking) | Not affected | no cookie auth on `/ws` (token is sent in the message), so a foreign page gains nothing; allow-list still recommended | [link](https://portswigger.net/web-security/websockets/cross-site-websocket-hijacking) |
| 39 | `ws` fragment-flood DoS (CVE-2026-48779, ws < 8.21) | Not affected | installed `ws` 8.22.0 | [link](https://codezup.com/securing-websocket-connections-tutorial/) |
| 40 | Dead / half-open connections never cleaned up | Not affected | `server.js:826` 20 s ping/pong heartbeat terminates | [link](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html) |
| 41 | Client half-open socket not detected | Not affected | `app.js` 10 s silence → `sync`, 8 s no answer → reconnect | [link](https://websocket.org/guides/reconnection/) |
| 42 | Reconnect without backoff / jitter (thundering herd after a restart) | Affected → **Fixed** | `app.js:48` capped exponential backoff now with ±50 % jitter | [link](https://websocket.org/guides/reconnection/) |
| 43 | Same game in two tabs: endless reconnect ping-pong (each rejoin kicks the other) | Affected → **Fixed** | server sends `replaced` + close 4001 (`server.js:687`); old tab stops, takes over when visible or when the other tab closes (BroadcastChannel) | [link](https://github.com/n8n-io/n8n/pull/28419) |
| 44 | After kick / lobby closed the socket stays bound to the old lobby (can't create/join again, can still act on it) | Affected → **Fixed** | `server.js:663` unbinds the socket when the player is no longer in a live lobby | [link](https://websocket.org/guides/reconnection/) |
| 45 | State desync after reconnect | Not affected | rejoin sends full state + recap + photos (`server.js:692-697`) | [link](https://websocket.org/guides/reconnection/) |
| 46 | bfcache restore with a dead socket | Not affected | `app.js:211` `pageshow` persisted → reconnect | [link](https://web.dev/articles/bfcache) |
| 47 | Server-side game state lost on restart / Render spin-down (all live games in memory) | **Affected** (not fixed) | `lobbies` Map only; stats/polls persisted in Supabase | [link](https://render.com/docs/free) |
| 48 | Render free: idle spin-down and wiped disk | Not affected | stats/polls/socials in Supabase; WS messages keep the instance awake during games | [link](https://render.com/changelog/free-web-services-now-remain-active-while-receiving-websocket-messages) |
| 49 | Double catch confirmation / double finalize race | Not affected | `finalizeCatch` deletes the claim first; `catchHider` checks `h.caught` | [link](https://gafferongames.com/post/what_every_programmer_needs_to_know_about_game_networking/) |
| 50 | Start pressed twice / settings changed mid-game | Not affected | `state === "lobby"` guards on `start`, `settings`, `field` | [link](https://gafferongames.com/post/what_every_programmer_needs_to_know_about_game_networking/) |
| 51 | Two players claim the same bounty or drop | Not affected | single-threaded; bounty nulled / drop deleted on claim | [link](https://gafferongames.com/post/what_every_programmer_needs_to_know_about_game_networking/) |
| 52 | Client-authoritative timers (client can extend the game) | Not affected | all timers on the server (`tick`) | [link](https://gabrielgambetta.com/client-side-prediction-server-reconciliation.html) |
| 53 | Late joiner gets an unfair hider role mid-round | Not affected | `server.js:682` late joiners hunt | [link](https://gafferongames.com/post/what_every_programmer_needs_to_know_about_game_networking/) |
| 54 | Lobby full race (more than max players) | Not affected | `server.js:680` checked synchronously | [link](https://gafferongames.com/post/what_every_programmer_needs_to_know_about_game_networking/) |

## D. Timers, memory & cleanup

| # | Bug | Status | Evidence | Source |
|---|---|---|---|---|
| 55 | Games never cleaned up | Not affected | `server.js:423-425` empty lobby, 1 h idle, 6 h running cap | [link](https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html) |
| 56 | Active lobby deleted 1 h after creation (idle timer never refreshed by activity) | Affected → **Fixed** | `server.js:701` + join/rejoin refresh `idleSince`; `test/audit.test.js` | [link](https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html) |
| 57 | Server intervals not cleared on shutdown | Not affected | `server.js:827` clears tick, heartbeat, poll sweep | [link](https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html) |
| 58 | Reveal `setTimeout` outlives its round | Not affected | `server.js:774` guarded by `round` + state | [link](https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html) |
| 59 | Highlight uploads: no server-wide memory cap (20 players x 15 MB per lobby) | Affected → **Fixed** | `server.js:810-811` total cap `HL_TOTAL_MB` (120 MB default); 30 min TTL kept | [link](https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html) |
| 60 | `?ref=` visit counter Map grows forever | Affected → **Fixed** | `server.js:111` capped at 2 000 refs | [link](https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html) |
| 61 | Stored refs / share kinds grow without bound (persisted to Supabase) | Affected → **Fixed** | `stats.js` `MAX_REFS` 2 000, `MAX_SHARE_KINDS` 30 | [link](https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html) |
| 62 | A player can store unlimited social handles by re-sending `social` | Affected → **Fixed** | `server.js:721` max 10 recorded per player | [link](https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html) |
| 63 | Empty poll-subscriber sets left behind | Affected → **Fixed** | `server.js:666` deleted when a socket switches polls | [link](https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html) |
| 64 | Per-device ids / daily player lists in stats grow forever | **Affected** (not fixed) | `stats.js` `devices`, `days[].players` never pruned | [link](https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html) |
| 65 | CPU blow-up: 1 s pings for 6 h → every broadcast rescans all pings | **Affected** (not fixed) | `viewFor` loops `L.pings` per player per broadcast; `pingSec` min 1 s, `gameSec` max 6 h | [link](https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html) |
| 66 | Client intervals / timers leak across games | Not affected | global intervals created once; heat/flash/ripple timeouts remove their layers | [link](https://github.com/Leaflet/Leaflet/issues/5263) |
| 67 | Leaflet maps / layers not removed (memory leak) | Not affected | `app.js:158` `map.remove()` on leave; `:506`, `:547` stale layers removed | [link](https://github.com/Leaflet/Leaflet/issues/5263) |

## E. Game logic edge cases

| # | Bug | Status | Evidence | Source |
|---|---|---|---|---|
| 68 | Host leaves mid-game | Not affected | `server.js:632-646` host passes to a connected player; game continues | [link](https://gafferongames.com/post/what_every_programmer_needs_to_know_about_game_networking/) |
| 69 | Host disconnects (no Leave): nobody can start, end or override | Affected → **Fixed** | `server.js:428-431` hand-off after 90 s offline | [link](https://gafferongames.com/post/what_every_programmer_needs_to_know_about_game_networking/) |
| 70 | Last hider leaves → game never ends | Not affected | `server.js:643` ends for hunters | [link](https://gafferongames.com/post/what_every_programmer_needs_to_know_about_game_networking/) |
| 71 | All hunters leave → game never ends | Not affected | `leave()` ends for hiders | [link](https://gafferongames.com/post/what_every_programmer_needs_to_know_about_game_networking/) |
| 72 | Last hider disconnects (no Leave): round waits for the timer | **Affected** (not fixed) | by design the slot is kept (`server.js:821`); host can End | [link](https://gafferongames.com/post/what_every_programmer_needs_to_know_about_game_networking/) |
| 73 | Catch claim stuck when the other side is offline | Not affected | claims expire after 20 s (`tick`) | [link](https://gafferongames.com/post/what_every_programmer_needs_to_know_about_game_networking/) |
| 74 | Power-up cooldown / role checks done on the client only | Not affected | `usePower` checks held, cooldown, side, caught on the server | [link](https://gabrielgambetta.com/client-side-prediction-server-reconciliation.html) |
| 75 | Rematch keeps stale round state | Not affected | `rematch()` + `resetFeatures` + `clearRound` | [link](https://gafferongames.com/post/what_every_programmer_needs_to_know_about_game_networking/) |
| 76 | Kick during a running game | Not affected | kick only in lobby | [link](https://gafferongames.com/post/what_every_programmer_needs_to_know_about_game_networking/) |
| 77 | Settings NaN / extreme values | Not affected | `server.js:725-733` `clampNum` + allow-lists | [link](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html) |
| 78 | Client clock skew breaks synced countdown / reveal | Not affected | NTP-style offset (`timesync.js`, `app.js:766-775`) | [link](https://en.wikipedia.org/wiki/Network_Time_Protocol#Clock_synchronization_algorithm) |
| 79 | Clock drift / sleep jump during a long round (sync only at connect) | Affected → **Fixed** | `app.js` re-syncs every 5 min in game and on return to the tab | [link](https://en.wikipedia.org/wiki/Network_Time_Protocol#Clock_synchronization_algorithm) |
| 80 | Background-tab timer throttling breaks countdowns | Not affected | server-authoritative times; UI re-renders on `visibilitychange` | [link](https://developer.chrome.com/blog/timer-throttling-in-chrome-88) |

## F. Security (OWASP)

| # | Bug | Status | Evidence | Source |
|---|---|---|---|---|
| 81 | XSS via player names | Not affected | `app.js:21` `esc()` in every `innerHTML` / Leaflet tooltip (e.g. `:339`, `:533`, `:581`) | [link](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html) |
| 82 | XSS via social handles / profile links | Not affected | strict per-platform regex (`socials.js`), `esc()` in `igLink` (`app.js:31`), `encodeURIComponent` in URLs | [link](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html) |
| 83 | XSS via poll names / place labels | Not affected | `polls.js` `clean()`, `plan.js:6` `esc()` (quotes too); `plan.test.js` | [link](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html) |
| 84 | XSS via highlight captions / recap text | Not affected | captions drawn on canvas; recap `esc()` (`recapui.js:5`); captions now also cleaned | [link](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html) |
| 85 | XSS in the admin dashboard | Not affected | `admin.js:8` `esc()` on every value | [link](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html) |
| 86 | Image / video data URL injection | Not affected | strict `data:image/jpeg;base64` / `data:video/(webm|mp4)` regexes (`server.js:782`, `:805`) | [link](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html) |
| 87 | Bidi-override / zero-width / control characters in names (display spoofing) | Affected → **Fixed** | `server.js:83` `cleanName` (same filter as polls); `test/audit.test.js` | [link](https://www.unicode.org/reports/tr39/) |
| 88 | CSV / formula injection in the socials export | Not affected | `admin.js` `q()` prefixes `= + - @` | [link](https://owasp.org/www-community/attacks/CSV_Injection) |
| 89 | Admin key compared with a non-constant-time check | Not affected | `admin.js:9` SHA-256 + `crypto.timingSafeEqual` | [link](https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b) |
| 90 | Admin key brute force (no attempt limit) | Affected → **Fixed** | `admin.js` 10 wrong keys per IP / 15 min → locked out | [link](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html) |
| 91 | Admin key left in URL / history | Not affected | `admin.js:24` 303 redirect strips `?key=`; cookie holds an HMAC, not the key | [link](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html) |
| 92 | CSRF on the brake switch / handle delete | Not affected | cookie `SameSite=Strict`, POST only | [link](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) |
| 93 | Clickjacking of /admin | Affected → **Fixed** | `admin.js` gate sets `X-Frame-Options: DENY` + `frame-ancestors 'none'` | [link](https://cheatsheetseries.owasp.org/cheatsheets/Clickjacking_Defense_Cheat_Sheet.html) |
| 94 | Prototype pollution via `?ref=__proto__` (stats counters wrote to `Object.prototype`) | Affected → **Fixed** | `stats.js` own-property lookups + reserved-key block; `test/audit.test.js` | [link](https://cheatsheetseries.owasp.org/cheatsheets/Prototype_Pollution_Prevention_Cheat_Sheet.html) |
| 95 | `trust proxy: true` lets clients spoof `X-Forwarded-For` (bypass per-IP limits) | **Affected** (not fixed) | `server.js:92` | [link](https://expressjs.com/en/5x/guide/behind-proxies/) |
| 96 | Missing CSP / security headers on the game pages | **Affected** (not fixed) | no CSP / `nosniff` on `/` (admin now has them) | [link](https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html) |
| 97 | Supabase service key leaked to clients or logs | Not affected | server-only; masked in errors (`supabase.js:45`) | [link](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html) |
| 98 | HTTP JSON bodies without size limits | Not affected | 8 KB polls, 1 KB share, 4 KB admin | [link](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html) |
| 99 | Poll creation spam | Not affected | `polls.js` 20 per IP per hour, 200 active max | [link](https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html) |
| 100 | Unvalidated message fields (type confusion in settings / field / ids) | Not affected | `clampNum`, `Field.validate`, `Map.get` lookups, allow-lists | [link](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html) |
| 101 | Consent / age gate bypass by crafting messages | Not affected | `server.js:669` requires `agreed: true` on create/join | [link](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html) |

## G. Mobile web platform

| # | Bug | Status | Evidence | Source |
|---|---|---|---|---|
| 102 | Web Audio blocked until a user gesture (autoplay policy) | Not affected | `app.js:223` unlock on first tap + "Sound check" / unlock button | [link](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay) |
| 103 | iOS AudioContext stuck "suspended"/"interrupted" after a call, lock or app switch | Affected → **Fixed** | `app.js:241` `resumeAudio()` on every tap and on return to the tab | [link](https://bugs.webkit.org/show_bug.cgi?id=276016) |
| 104 | iOS silent switch mutes Web Audio chimes | Not affected | visual chime flash + "turn off silent mode" hint (`app.js` sound check) | [link](https://developer.apple.com/forums/thread/658375) |
| 105 | `navigator.vibrate` missing on iOS | Not affected | called with `?.`; visual flash / banners as fallback | [link](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/vibrate) |
| 106 | Wake lock released on hide and not re-acquired | Not affected | `app.js:201-221` re-acquired on `visibilitychange` | [link](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API) |
| 107 | Wake lock unsupported browsers | Not affected | `app.js:598` warning to keep the screen on | [link](https://developer.chrome.com/docs/capabilities/web-apis/wake-lock) |
| 108 | MediaRecorder MIME differences (Safari mp4 vs webm) | Not affected | `record.js:5`, `reel.js:12` `isTypeSupported` pick | [link](https://www.testmuai.com/learning-hub/mediarecorder-browser-support/) |
| 109 | MediaRecorder huge blobs / memory (long recordings) | Not affected | 3-min segments, saved clips freed (`record.js:15`, `:58`) | [link](https://blog.addpipe.com/dealing-with-huge-mediarecorder-slices/) |
| 110 | Camera track ends when the app is backgrounded mid-recording (iOS); segment silently stops | **Affected** (not fixed) | `record.js` has no track `ended` / visibility handling | [link](https://bugs.webkit.org/show_bug.cgi?id=279432) |
| 111 | Camera left on (tracks not stopped) | Not affected | `getTracks().forEach(t => t.stop())` after photo / recording | [link](https://www.testmuai.com/learning-hub/mediarecorder-browser-support/) |
| 112 | In-app browsers (Instagram, TikTok...) drop the page and its socket | Not affected | `public/inapp.js` banner + open-in-browser | [link](https://www.xjavascript.com/blog/it-is-possible-to-watch-the-location-in-the-background-on-mobile-ios-android/) |
| 113 | Leaflet map sized while hidden (grey tiles) | Not affected | `invalidateSize()` after show | [link](https://github.com/Leaflet/Leaflet/issues/5263) |
| 114 | Heavy use of the public OSM tile server (usage policy) | **Affected** (not fixed) | `app.js` default tiles `tile.openstreetmap.org` | [link](https://operations.osmfoundation.org/policies/tiles/) |
| 115 | Page Visibility not used to pause rendering | Not affected | `render()` skips the game map while hidden | [link](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API) |

## Recommendations (not fixed: bigger or riskier)

1. **Live games are lost on any restart or deploy** (in-memory `lobbies`). Snapshot running lobbies to Supabase every few seconds and restore on boot, or at least deploy only between games.
2. **`trust proxy: true`** trusts a client-supplied `X-Forwarded-For`, so per-IP limits (games, joins, polls, admin lockout) can be bypassed. Check Render's proxy hop count and set `trust proxy` to that number (and use the same IP in `clientIp()`).
3. **GPS spoofing** (mock location apps): add server-side plausibility checks (speed > ~12 m/s between fixes, teleports, perfect 0 m accuracy) and flag rather than block.
4. **Per-IP WebSocket connection cap** (e.g. 30 open sockets per IP) to stop socket floods; keep it generous for carrier NAT.
5. **CSP + `X-Content-Type-Options` on the game pages** (`default-src 'self'`, tiles host in `img-src`). Needs a pass over inline handlers/styles first.
6. **CPU guard for extreme settings**: raise the minimum ping interval (e.g. 10 s) or cache the per-hider "last ping" view instead of rescanning `L.pings` on every broadcast.
7. **Bounty placement hint**: spawn the bounty from the field centre or hunters only, so its position doesn't leak the hiders' centroid.
8. **Last hider offline**: optional rule to forfeit a hider who stays disconnected for N minutes (today the round waits for the timer; host can End).
9. **Background GPS**: the web cannot track a locked phone. Keep the wake-lock nudges; a native wrapper is the only real fix.
10. **Recording interruptions**: listen for the camera track `ended` / `visibilitychange` in `record.js`, close the segment cleanly and tell the player.
11. **OSM tile policy**: set `DARK_TILES_URL` to a provider with a key (or self-host) before traffic grows.
12. **Stats growth**: prune `devices` and old `days[].players` (e.g. keep 90 days).
