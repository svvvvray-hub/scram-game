# Last Ping: Privacy Policy

> **DRAFT TEMPLATE. NOT LEGAL ADVICE.** This document is a starting template for Murray Nguyen to review. It is not legal advice, and no attorney has reviewed it. Before you monetize Last Ping, have a lawyer licensed in California review and adapt it. That especially applies before you add payments (Stripe), ads (e.g., Google), accounts, analytics, or a database. Each of those changes what this policy must say. Items in `[BRACKETS]` are placeholders. Check every factual statement against how the app actually works before you publish.

**Effective date:** [DATE] · **Last updated:** [DATE]

## The short version (plain English)

This summary is here to make the policy easier to read. It is not a substitute for it. The full policy below is what counts.

- **No accounts, no tracking cookies.** We run the game in server memory. When a round, lobby, or server ends, that game data is gone. A small database, hosted by our provider Supabase, keeps only saved social media handles, next-game polls, and anonymous usage counts.
- **Your location is the core of the game.** During a game your phone sends your GPS location to our server. Hunters see hiders' locations at each "ping," about every 60 seconds by default. Your location trail is kept in memory for the round so we can show the end-of-round recap. Then it is discarded.
- **Other players see what you share:** your display name, your social media handle (e.g., Instagram, TikTok, X) if you add one, your role, your in-game status, and some of your location.
- **Your social media handle is saved if you enter one.** It is stored in our database (hosted by Supabase) and may be viewed by the game creator, for example to connect with players. Leave it blank, or ask us to delete it at any time and we will remove it.
- **The camera snapshot is opt-in.** If you consent in the lobby, hunters see one photo from your rear camera at minute 10. It is kept in memory for that round only.
- **Your video stays on your phone** unless you tap "Send my highlights to host." Then short highlight cuts go to the server and are kept in memory for **30 minutes at most**.
- **We do not sell your personal information,** and we don't share it for targeted advertising.
- **18+ only.** We don't knowingly collect data from children.
- **Questions or requests:** [CONTACT EMAIL].

---

## 1. Who we are

Last Ping (the "**Game**") is a free, browser-based GPS hide-and-seek game. It is created and operated by Murray Nguyen, an individual in California, United States ("**we**," "**us**," or "**our**"). This Privacy Policy explains what information the Game handles, how we use it, who can see it, and how long we keep it. It is part of our [Terms of Service](terms.html).

## 2. Information we handle

| What | When | Who sees it | How long we keep it |
|---|---|---|---|
| **Display name** | You type it to create or join a lobby | Everyone in your lobby | Server memory until you leave or the lobby closes |
| **Social media handle** (optional; e.g., Instagram, TikTok, X, Snapchat, YouTube, Threads, Facebook) | You add it, and pick the platform, when joining | Everyone in your lobby (shown as a link to your profile); may appear in recaps and shared links. Also saved for the game creator, who may view it, for example to connect with players | Kept until you ask us to delete it |
| **Lobby code and a random session token** | When you join | The token is used only by your browser and our server, to reconnect you | Server memory while the lobby exists; on your device until you leave the lobby |
| **Live GPS location** (latitude, longitude, accuracy) | During a game, sent repeatedly (roughly every few seconds while moving, at least every ~15 s) | See section 3 | Server memory for the round |
| **Location trail** | Built from the location pings during a round | Players in your lobby, in the end-of-round recap | Until **Play again**, the lobby closes, or the server restarts |
| **Camera snapshot** (optional; "hider cam sneak peek") | Minute 10, only if you're a hider and tapped "allow camera" in the lobby | Hunters in your lobby only | Server memory for that round only; never written to disk |
| **Highlight cuts** (optional) | Only if you tap "Send my highlights to host" | The lobby host (for a group highlight reel) | Server memory for **30 minutes at most**, or less if Play again starts or the lobby closes |
| **Video you record** | When you use Record | Only you; it stays on your device | We never receive it (unless you send highlights, as above) |
| **Referral visits** | When someone opens a link with `?ref=<handle>` | Us | The count per handle is kept with our anonymous usage statistics in our database (hosted by Supabase); each visit is also written to our server logs (handle and page). See section 6 |
| **Next-game poll votes** (optional) | You vote on a "Plan the next game" poll | Anyone with the poll link | Only the name and optional social media handle you type, plus your time/place picks; stored in our database (hosted by Supabase) and deleted 14 days after the poll's last time option |
| **Technical data** | Every request | Us, our host, and the map tile provider | See section 6 |

We **do not** collect your real name, email address, phone number, contacts, or payment information. We do not ask for them, and we have no account system.

**Your device.** The Game saves a few items in your browser's **localStorage** so you don't have to retype them: your display name, social media handle and platform, camera-consent choice, settings, and your current lobby session. Some layout preferences are saved in **sessionStorage**. These items stay on your device. Leaving a lobby removes the lobby session. To remove everything else, clear this site's data in your browser settings. **We do not use cookies.** We use no advertising or analytics trackers.

## 3. How location sharing works

- **Hiders:** the server receives your live location. **Hunters do not see it live.** They receive a snapshot of your location at each scheduled "ping" (about every 60 seconds by default; the host can change this). Hunters may also get extra or modified pings from game events, such as bounties, the out-of-bounds penalty, or a ghost decoy. In the final "sudden death" phase, hunters see only a compass direction and a rough distance band to the nearest hider, not coordinates.
- **Hunters:** other hunters on your team can see your location live.
- **Everyone:** other players may see whether you are inside or outside the playing field (an in/out flag only). The host's location may be used to center the playing field.
- **Recap:** at the end of a round, players in your lobby can see each hider's ping trail on a map.
- Location sharing stops when the round ends or you leave the lobby or close the page. You can deny location permission in your browser at any time, but then the game won't work for you.

**Please don't play from, or end a game at, your home** or any other place you want to keep private. See our Terms of Service.

## 4. How we use information

We use the information above only to:

- run the Game, including lobbies, roles, timers, pings, power-ups, the playing field, catches, recaps, photos, and highlight reels;
- reconnect you if you refresh the page or your screen locks;
- count referral visits, so creators can see how many people their links bring in;
- keep the Game secure, prevent abuse, and fix bugs; and
- comply with the law.

We do not use your location or other data for advertising, profiling, or any purpose unrelated to playing the Game.

## 5. Who we share information with

- **Other players in your lobby,** as described above. They may take screenshots, or download or share recap images and highlight reels. **Once they do, that copy is outside our control.** Play only with people you trust with this information.
- **Service providers.** These process data on our behalf so the Game can run:
  - **Render** (render.com) hosts our server in the United States. It processes the traffic and server logs (see section 6).
  - **Supabase** (supabase.com) hosts our database, in [SUPABASE REGION, e.g. US East (N. Virginia); confirm]. It stores only the items listed in section 7 as kept in our database: saved social media handles, next-game polls and votes, anonymous usage statistics (including referral counts), and our game settings. It acts only as our hosting provider.
  - **OpenStreetMap** map tiles are loaded directly by your browser from OpenStreetMap servers. Those servers receive your IP address and the map area being viewed, as with any website request. See the OpenStreetMap Foundation's privacy policy.
  - **Social media platforms (e.g., Instagram, TikTok, X):** if you tap a player's handle or "Follow," you leave the Game and go to that platform, where its own privacy policy applies.
- **Legal reasons:** we may disclose information if the law requires it, or to protect someone's safety. Because we keep almost nothing, we usually have nothing to disclose.
- **Business transfer:** if the Game is transferred to a new owner or entity, this policy will continue to apply to any information transferred.

**We do not sell your personal information. We do not "share" it for cross-context behavioral advertising** (as those terms are defined under California law). We have not done either in the past 12 months.

## 6. Server logs and technical data

Like most websites, our server and our hosting provider automatically handle technical data, such as your IP address, browser type, the pages you request, and timestamps. Our application writes a small amount of information to the server console, for example referral visits (the referring handle and page) and server events. Our host may keep these logs for a limited period under its own retention settings, [RENDER LOG RETENTION, e.g. 7 days on the free plan; confirm]. We use logs only to operate and debug the Game and prevent abuse.

## 7. How long we keep information

Our database (hosted by Supabase, see section 5) holds only: saved social media handles (see below), next-game polls and votes, anonymous usage statistics (daily counts, hashed random device ids, referral counts, share counts), and our game settings. All other game data, including names, locations, trails, photos, and highlights, lives only in server memory and is never written to the database. It is deleted:

- **at "Play again"** (trails, catches, photos, recaps, and highlights from the previous round are wiped);
- **when you leave the lobby** (your player entry is removed);
- **when the lobby closes**, that is, when the last player leaves or after about 1 hour with no game running (a running round is capped at 6 hours);
- **when the server restarts or sleeps**, which on our free hosting can happen after a period of inactivity; and
- **for highlight cuts, after 30 minutes at most.**

**Social media handles.** If you enter a social media handle (e.g., Instagram, TikTok, X), it is saved in our database (hosted by Supabase) together with the platform you picked (with when we first and last saw it, how many games you played, and the invite tag that brought you, if any) until you ask us to delete it, and may be viewed by the game creator, for example to connect with players. You can leave the field blank, or ask us to delete your saved handle by contacting us (see the Contact section).

Anonymous usage statistics, including referral visit counts, are kept in our database to understand how the Game grows. When we delete a handle on request, it is deleted from the database. Server logs are kept as described in section 6.

## 8. Your choices

- Use any display name you like (within our conduct rules), and leave the "Your @" field blank if you prefer. If you entered a handle, you can ask us to delete it.
- Tap **"Ready without camera"** to opt out of the camera snapshot.
- Keep your videos on your device. Don't tap "Send my highlights to host."
- Deny or revoke location, camera, or microphone permissions in your browser settings. Some features won't work without them.
- Clear this site's data in your browser to remove locally stored items. Leaving a lobby removes only the lobby session.

## 9. California privacy rights (CCPA/CPRA)

If you are a California resident, the California Consumer Privacy Act, as amended by the California Privacy Rights Act ("**CCPA**"), may give you rights over your personal information. We aim to respect these rights even where the law may not strictly apply to a small, free project like ours.

**Categories of personal information we handle (past 12 months):**

- **identifiers**: display name, social media handle, IP address, and session token;
- **geolocation data**: **precise geolocation**, which is "sensitive personal information" under the CCPA;
- **audio, electronic, and visual information**: the optional camera snapshot and optional highlight cuts; and
- **internet or network activity**: server logs and referral visits.

**Sources:** you and your device. **Purpose:** to provide the Game, as described in section 4. **Disclosed to:** other players in your lobby and our service providers, as described in section 5.

**Sensitive personal information.** We use precise geolocation and camera images only to provide the Game features you request. We do not use them to infer characteristics about you. Because of this, the CCPA right to limit the use of sensitive personal information does not currently apply. If that ever changes, we will update this policy and offer a way to limit.

**Your rights** may include the right to:

- **know or access** the personal information we have about you;
- **delete** it;
- **correct** it;
- **opt out of the sale or sharing** of it (we don't sell or share it);
- **limit** the use of sensitive personal information; and
- **not be discriminated against** for exercising these rights.

**How to make a request:** email [CONTACT EMAIL] with "California privacy request" in the subject. You may also use an authorized agent. Because we have no accounts and delete game data at the end of each round or lobby, we usually hold **no personal information that we can link to you** after your game ends. We may ask for details, such as your display name, lobby code, and the approximate date and time, to look for anything that remains, for example in server logs. We will respond within the time the law requires (generally 45 days).

**Global Privacy Control / Do Not Track.** We don't sell or share personal information or track you across sites, so there is currently nothing for these signals to opt you out of. If we add advertising, we will honor Global Privacy Control signals as required by law.

**Retention:** see section 7.

## 10. Children

The Game is intended **only for people 18 and older**. See our Terms of Service for why. We do not knowingly collect personal information from anyone under 18, and certainly not from children under 13, in line with the U.S. Children's Online Privacy Protection Act (COPPA). If you believe a child has used the Game, contact us at [CONTACT EMAIL] and we will delete any information we can identify. Because game data is held only in memory, it is usually already gone.

## 11. Future features: payments, ads, and third parties

The Game currently has **no payments and no ads**. We may later add:

- **Optional cosmetic purchases** processed by **Stripe**. Stripe would collect your payment details under its own privacy policy, and we would not see your full card number.
- **Ads, including optional "rewarded" ads,** from providers such as **Google**. Ad providers may use cookies, device identifiers, or similar technology, and may collect information such as your IP address and ad interactions. In some cases that is used for personalized advertising.
- **Accounts, analytics, or a database** to save progress or purchases.

**Before** we launch any of these features, we will update this Privacy Policy to describe exactly what is collected and by whom, and to explain your choices. If we ever "sell" or "share" personal information as California defines those terms, we will add a **"Do Not Sell or Share My Personal Information"** link, along with any consent prompts the law requires.

## 12. Security

We limit what we collect and keep most of it only in memory, and that is our main protection. The few items in our database are reachable only by our server with a secret key; the database blocks all public access. The Game is served over HTTPS. Hiders' coordinates are sent to hunters only at ping time. However, no system is perfectly secure. Anyone with a lobby code or link can join that lobby, so share codes only with people you intend to play with.

## 13. International users

The Game is operated from, and hosted in, the United States (our server at Render; our database at Supabase, in [SUPABASE REGION; confirm]). If you use it from elsewhere, your information will be processed in the United States.

## 14. Changes to this policy

We may update this policy. When we do, we will change the "Last updated" date. If a change is material, especially one that adds new kinds of data collection, we will give notice in the Game before the change applies.

## 15. Contact

Murray Nguyen (Last Ping)
Email: **[CONTACT EMAIL, e.g. privacy@yourdomain.com]**
Instagram: [@mmmmmray](https://www.instagram.com/mmmmmray/)
California, United States
