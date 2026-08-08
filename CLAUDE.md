# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm start` — runs `node server.js` (the only script). Serves HTTP + WebSocket on `PORT` (default 3000).
- No build, no lint, no tests exist. HTML files are plain single-file apps; changes are live on reload.
- Deployed on Railway; clients connect to it over `wss://<railway-domain>`.

## Architecture

This is a real-time web radio for Terrapesca stores. One Node.js server (no framework, raw `http` +
`ws`) acts as **(a)** static file server, **(b)** API proxy, and **(c)** audio relay. The UI is a set
of **self-contained single-file HTML apps** (inline CSS + JS, no bundler):

| File | Role |
|---|---|
| `index.html` | Landing/role portal served at `/` (Cabina / Sucursal / Escuchar / Tienda) with live now-playing via WS. |
| `studio.html` | **Actively developed** DJ cabin. Dual-deck YouTube crossfade engine, DJ Rodo (AI voice), mood/hour song selection, spot/jingle/stinger playback, first-run onboarding wizard (`tp_onboarded`). This is where the playback engine lives. |
| `panel.html` | **FROZEN — hotfixes only** (Fase 0, see PLAN-SPOTIFY.md). Older/larger control panel (Los Mochis). Shares localStorage keys + IndexedDB schema with studio. New features go to studio.html. |
| `sucursal.html` | Receiver/player for branches (Culiacán, Mazatlán). Listens to WS relay only. |
| `tienda.html` | In-store mode with auto DJ Rodo speaking to customers. |
| `listen.html` | Public listener. Plays via hidden YouTube IFrame synced over WS (same mechanism as sucursal) — NOT via `/radio/stream` (ytdl-core breaks too often for the public page). Spots play from base64 over the paused player. |
| `server.js` | HTTP/WS server + proxies + server-side audio stream (`/radio/stream`). The experimental FFmpeg engines (Fase C, `RADIO_ENGINE_TEST`) were removed along with `audio-test/`, `audio-live/`, `scripts/` and `sucursal-stream*.html`. |
| `sw.js` | Service worker: caches static HTML, never intercepts `/radio/stream` or `/api/*`. |

### Communication model
A controller (`studio.html` / `panel.html`) connects over WebSocket and **broadcasts** messages that
the server relays to all other clients (`sucursal.html`, `listen.html`). Message types are enumerated in
the `wss.on('connection')` switch in `server.js`: `PLAY`, `PAUSE`, `RESUME`, `VOLUME`,
`PLAYLIST_UPDATE`, `SPOT`, `JINGLE_SET`, `MIC_ONAIR`, `AUTOPILOT_START`/`AUTOPILOT_STOP`. The server keeps
a single `radioState` object and sends a `SYNC` snapshot to every newly-connected client.

**Radio 24/7 (autopilot):** `AUTOPILOT_START` hands the server a playlist (`[{ytId,name,artist,duration}]`);
the server then drives playback itself — a `setTimeout` chain that broadcasts `PLAY` + `QUEUE_PREVIEW` per
track on schedule, so listeners keep playing (each in its own YouTube IFrame) **without the studio open**.
State persists to `.autopilot.json` (gitignored) and resumes on boot. A manual `PLAY` from a live studio
stops autopilot (live overrides). Studio suppresses its own `_wsPlayTrack`/60s-sync while `_autopilotOn`.
The server needs track durations → `/api/ytdur?ids=&key=` (videos.list). Railway free tier sleeps after
30 min idle — true 24/7 needs the Hobby plan or a keep-alive ping. Listeners (`listen.html`) can send
`NEXT_TRACK`/`PREV_TRACK`; the server relays them and `studio.html` handles them in `_onRemoteCmd`
(3s cooldown so a remote listener can't spam skips across the whole network). Studio also emits
`QUEUE_PREVIEW` (next up-to-5 tracks) with every `PLAY`; the server stores it in
`radioState.queuePreview` so new clients get it via `SYNC`, and listen.html renders it as
"Próximas canciones".

**Roadmap:** `PLAN-SPOTIFY.md` holds the full audit and the phased plan to evolve the radio into a
Spotify-like experience (library, playlists, search, now-playing bar) without touching the dual-deck engine.

### Secrets model (important)
**The server holds no API keys.** Keys live in the browser's `localStorage` and are sent as request
headers to the server's proxy endpoints, which forward them to the upstream API:
- `tp_oai` → OpenAI (`x-openai-key` → server sets `Authorization: Bearer`) → `/api/openai/tts`
- `tp_vk_key` + `tp_vk_user` → VoiceKiller (`api-key` + `userid` headers) → `/api/voicekiller/tts` (POST
  `{script,voice_name,instructions}` → returns mp3). Alternative TTS engine, selected via `tp_engine`
  (`openai`|`voicekiller`); `tp_vk_voice` picks the VoiceKiller voice. `synthTTS()` in studio and
  `genAndPlay()` in tienda branch on `tp_engine`.
- `tp_shopify_domain` + `tp_shopify_token` → Shopify Storefront API (`x-shopify-shop` + `x-shopify-token`
  headers → server sets `X-Shopify-Storefront-Access-Token`) → `/api/shopify/products` (GraphQL product
  search for the spot generator; `shopSearch()`/`shopPick()` in studio fill the spot topic from a real
  product)
- `tp_ant` → Anthropic (`x-api-key`) → `/api/anthropic`
- `tp_yt` → YouTube Data API key (query param) → `/api/ytplaylist`
- `tp_ws` → the `wss://` server URL the client connects to
- `tp_el` → ElevenLabs (`xi-api-key`) → `/api/elevenlabs/:voiceId` — **legacy**, no longer used by any
  client (voice migrated to OpenAI). Proxy endpoint kept for backward compat; safe to remove later.
Other `tp_*` keys store voice/slogan/weather-city/DJ-Rodo config. Never hardcode keys or move them
server-side.

### External services
- **Anthropic** (`claude-sonnet-5`, `thinking:{type:'disabled'}` for fast short generations) — DJ Rodo
  scripts and ad-spot copy. Responses are parsed with `aiText()` (find the `text` block — never assume
  `content[0]`). The previous model `claude-sonnet-4-20250514` was retired 2026-06-15 (returned 404).
- **OpenAI TTS** (`gpt-4o-mini-tts`, `response_format: 'mp3'`) — Spanish voice for DJ Rodo, spots and
  tienda. Steered with a natural-language `instructions` string (professional Mexican radio register)
  instead of numeric voice settings; `_expLevel` picks the tone matiz (`OAI_TONE` in studio). All 11
  OpenAI voices are selectable (alloy/ash/ballad/coral/echo/fable/nova/onyx/sage/shimmer/verse); default
  `ash` (most expressive/energetic; bumped from onyx via `tp_voice_ash`). Legacy `tp_voice_*` values
  (eleguar/latinFem/daniela) are migrated via `_migVoice()`. Replaced
  ElevenLabs 2026-08.
- **ElevenLabs** (`eleven_multilingual_v2`, `language_code: 'es'`) — *legacy* TTS; proxy still exists but
  no client calls it anymore.
- **YouTube** — three paths: IFrame API (in-browser playback in studio/panel), `@distube/ytdl-core`
  (server-side audio stream for mobile via `/radio/stream` and `/api/ytaudio/:id`), and YouTube Data
  API v3 (playlist import via `/api/ytplaylist`; song search via `/api/ytsearch` which merges
  `search.list` + `videos.list` durations).
- **Spotify (import only)** — `/api/spotify/playlist?id=` fetches the *public* embed page
  (`open.spotify.com/embed/playlist/:id`) and `parseSpotifyEmbed()` scrapes `__NEXT_DATA__` for
  `{title,subtitle}` → returns `{name,count,tracks:[{title,artist}]}`. Spotify audio is DRM'd and its
  ToS forbids rebroadcast, so this is **metadata only**: studio's `importSpotifyPlaylist()` resolves each
  track to a YouTube video via `/api/ytsearch` and adds it to the queue (curate on Spotify, play on
  YouTube). Client caps import at 60 tracks (YouTube search quota is 100 units/call). No Spotify key/login
  needed — public playlists only. The parser is best-effort with a recursive fallback if the embed shape
  changes.
- **CONAGUA** presas data via `/api/conagua` (self-signed cert, `rejectUnauthorized:false`).
- `/api/scrape` fetches a product page (one redirect followed, 80KB cap) so the AI can write a spot.

### Studio UI (Fase 3 + Fase 8 shell)
studio.html is an app shell: fixed left sidebar (`.sidebar`, becomes a horizontal top bar under 900px)
with views Inicio / Buscar / Cabina / Biblioteca / Me gusta / Historial / Playlists via `showView()` —
the cabina is hidden with the `offstage` class (kept in the DOM so the YouTube decks keep playing),
never `display:none`. Default view is `home` (persisted per user in `tp_last_view`); `renderHome()`
builds the greeting/hero/top/recent; search lives in its own view (`#viewSearch`, IDs `ytSearch`/
`searchResults` moved there). Global keyboard shortcuts (space/→/L/S/R) skip when focus is in an
input. A fixed bottom now-playing bar mirrors the active deck (500ms tick) with working
heart/shuffle/repeat and an animated equalizer. **`nextQueueIndex()` is the single next-track selector** — every engine path
(watcher, crossfade finalize, DJ pre-cue, manual cues) goes through it; it honors `shuffleMode` /
`repeatMode` (localStorage `tp_shuffle`/`tp_repeat`). Don't reintroduce raw `(queuePos+1)%queue.length`.

### Audio engine (studio.html)
Two YouTube IFrame players = deck A and deck B. The auto-mix watcher (250ms interval) reads
`getCurrentTime`/`getDuration`; `prebufferNext()` starts the inactive deck muted ~`PREBUFFER_AHEAD`
seconds before the end so it's buffered, then `doCrossfade()` ramps volumes over `CROSSFADE_SECS`.
Key invariants learned from past bugs:
- `_xfading` guards against double-crossfade (the 250ms watcher can fire twice); reset it on completion.
- `_prebufDone` must reset to `false` after each crossfade.
- Video is intentionally hidden (`opacity:0` on the iframe) — decks show cover art, not video.
- **Do NOT force playback quality.** Forcing a fixed resolution fights YouTube's adaptive bitrate and
  each forced change triggers a re-buffer (audible stutter). This was a real regression.
- DJ Rodo: `DJ_ROTATION_NORMAL` vs `DJ_ROTATION_CAMPAIGN` (Venta Nocturna). During the campaign window
  Rodo announces date/hours only — no promotions. Ducking lowers music when voice plays, then restores.

### Persistence
IndexedDB database `TerrapescaRadio` **v3** — `IDB_VER` must match between studio.html and panel.html
(opening with a lower version throws `VersionError`). Object stores:
- `playlist`, `session` (keyPath `key`) — unchanged from v2; queue lives at `playlist/main`, `session`
  holds base64 blobs (spots library, `studioJingle`, `studioStinger`). Shared with panel.html.
- `tracks` (keyPath `ytId`) — the **library**: `{ytId, title, artist, duration, cover, addedAt,
  playCount, liked, lastPlayedAt}`. Written only by studio via `libUpsert()`/`libSetLiked()`, which are
  serialized through `_libQueue` (read-modify-write race protection). `_onTrackStarted()` is the single
  hook for "a song started playing" (visible history + persistent history + playCount + duration capture).
- `playlists` (keyPath `id`) — `{id, name, trackIds[], createdAt}`; default playlist `main` seeded from
  the queue. UI arrives in Fase 3 (see PLAN-SPOTIFY.md).
- `history` (autoIncrement) — persistent play history, capped at 500 entries.
localStorage holds config (`tp_*`).
