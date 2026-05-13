# CLAUDE.md — Magnetosphere Project Memory

Source of truth for context, decisions, and conventions. Read at the start of every session.

---

## What This Project Is

A web reimagining of the iTunes Magnetosphere visualizer. A GPU particle field that swirls, breathes, and reacts to live audio.

**Reference:** https://www.youtube.com/watch?v=X29DK0qYEcE

---

## Audio Sources (priority order)

1. **Tab / system audio** — `getDisplayMedia({ audio: true })`. Chrome/Edge only. The cool one — visualizer reacts to whatever's playing in the shared tab without a mic.
2. **Microphone** — `getUserMedia` with `echoCancellation/noiseSuppression/autoGainControl` all forced off so music passes through cleanly.
3. **File upload** — fallback. Connects via `MediaElementAudioSourceNode` and routes to `ctx.destination` so the file plays through speakers.

Live sources (mic + system) are NOT connected to `ctx.destination` — mic would feed back, tab audio would double-play (the source tab is still emitting it).

---

## Stack

| Layer | Choice |
|---|---|
| Backend | Flask (app factory) on Python 3.11+ |
| Static compression | flask-compress (gzips shaders/JS) |
| Frontend | Vanilla ES modules + three.js r160 via importmap CDN |
| Audio analysis | Web Audio API `AnalyserNode`, FFT size 1024 |
| Rendering | three.js `Points` + custom `ShaderMaterial`, additive blending |
| Hosting | Railway (gunicorn gthread, healthcheck at `/health`) |

No bundler, no npm — everything is served as-is.

---

## Project Structure

```
voidpulse/
├── app/
│   ├── __init__.py           # Flask app factory
│   ├── routes.py             # /, /health
│   ├── templates/
│   │   └── index.html        # Single-page visualizer
│   └── static/
│       ├── css/style.css
│       └── js/
│           ├── main.js       # UI wiring + render loop
│           ├── audio.js      # AudioEngine (mic / tab audio / file)
│           └── visualizer.js # three.js particle field + shaders
├── scripts/
│   ├── dev.sh                # venv + run local
│   ├── deploy.sh             # commit + push + tail logs
│   ├── logs.sh               # railway logs
│   └── check-env.sh          # verify Railway env vars
├── railway.toml
├── requirements.txt
├── run.py
├── .env.example
└── CLAUDE.md                 # This file
```

---

## Audio → Visual Mapping

Three smoothed bands feed the shader uniforms each frame:

| Band | FFT bins | Hz range | Drives |
|---|---|---|---|
| bass | 1–6 | ~40–260 Hz | Radial breathing, point-size scale, rotation speed |
| mid | 7–46 | ~300 Hz–2 kHz | Y-axis displacement per particle |
| treble | 47–255 | ~2 kHz–11 kHz | High-frequency jitter / sparkle |

Smoothing is asymmetric: snap up fast on hits, decay slow (so a bass kick punches but doesn't strobe).

---

## Build Order

### Phase 1 — Particle field that breathes (active)
- [x] Flask scaffold + Railway config
- [x] Web Audio: mic, tab audio, file sources
- [x] three.js 60k-particle sphere with custom shader
- [x] Bass-driven radial breathing, mid/treble modulation
- [ ] Verify against reference: open in Chrome, share a tab playing music, confirm reactivity

### Phase 2 — Flow + character
- [x] 2-octave curl-noise flow field (uFlowStrength uniform, tunable)
- [x] Inner / outer shells (55% radii 18–36 / 45% radii 44–66, aLayer attribute)
- [x] Two-envelope onset detector + 8-frame refractory → cleaner beat bursts

### Phase 3 — Glow
- [x] EffectComposer + UnrealBloomPass
- [x] OutputPass (sRGB + tonemap)
- [x] Color palette presets (synthwave/inferno/arctic/toxic/void/ember; hue-only swaps)

### Phase 4 — Magnetosphere proper
- [x] Audio-reactive attractors (mid orbit speed, bass radius pulse; 0–4 wells tunable)
- [x] Scene transitions (cinematic mode: 6 named camera scenes + paired palette swaps every 12–20s)
- [ ] Optional: webcam-based hand interaction

### Phase 5 — Spotify beat-sync (faithful recreation goal)
The original iTunes Magnetosphere used iTunes' internal playback data — exact beat
positions, song structure, tempo — not raw FFT. That's what made it feel locked-in
to the music rather than just loudness-reactive. Phase 5 closes that gap.

Spotify Audio Analysis API returns per-track: beat timestamps (ms), bar positions,
sections (verse/chorus/bridge), segments with pitch + timbre vectors, tempo, key,
time signature, energy, valence. Pair with the Web Playback SDK for in-browser
playback and we get everything iTunes gave the original plugin.

**Architecture:**
- Flask: add `/auth/spotify` + `/auth/callback` OAuth routes + token refresh endpoint
- Frontend: Spotify Web Playback SDK (Premium required) handles playback in-browser
- On track load: fetch Audio Analysis, build a beat/bar/section timeline
- Beat scheduler: align `performance.now()` to `player.getCurrentState().position`,
  schedule beat/bar events with drift correction each animation frame
- Existing FFT pipeline stays as fallback for mic/tab/file sources

**What each data type drives:**
| Spotify data | Visualizer event |
|---|---|
| Beat timestamps | `uBurst` fires exactly on beat — replaces onset detector |
| Bar / downbeat | Cinematic camera cut candidate |
| Section change | Shape transition + palette swap |
| Segment pitch vector | Per-frame color entropy modulation |
| Segment timbre vector | Flow field strength / attractor radius |
| Track valence + energy | Starting palette selection on load |

**Phase 5.1 — OAuth + playback foundation (active)**
- [x] Flask OAuth blueprint (`/auth/spotify/{login,callback,token,status,logout}`)
- [x] `SpotifyEngine` (SDK loader, player init, token auto-refresh, transfer)
- [x] Spotify source button in picker (hidden unless server is configured)
- [x] `audio.useSpotify()` stub mode — bypasses FFT pipeline

**Phase 5.2 — Audio Analysis + beat scheduler (next)**
- [ ] Fetch `/v1/audio-analysis/{id}` on track change; build typed timeline
- [ ] rAF-aligned scheduler with drift correction against player position
- [ ] Wire beat → `uBurst`, bar → camera cut candidate, section → shape/palette
- [ ] Segment pitch vector → color entropy, timbre → flow/attractor
- [ ] Track valence/energy → starting palette on load

**Phase 5 ops notes:**
- Spotify dev dashboard: register `${BASE_URL}/auth/spotify/callback` as a
  redirect URI. Use 127.0.0.1 for local dev (Spotify blocks raw `localhost` on new apps).
- Required env vars on Railway: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`,
  `SPOTIFY_REDIRECT_URI=https://voidpulse.up.railway.app/auth/spotify/callback`
- Tokens live in Flask signed-cookie sessions (`PERMANENT_SESSION_LIFETIME=30d`).

---

## Key Decisions Log

| Decision | Rationale |
|---|---|
| 80s synthwave aesthetic | Project-wide visual language: neon cyan + hot pink palette, deep purple background gradient, perspective grid floor, CRT scanlines, Orbitron + Share Tech Mono fonts. New UI elements should match this — no flat material-design defaults. |
| Spotify beat-sync over FFT-reactive | The original iTunes Magnetosphere used internal playback data (exact beat timestamps, song structure), not raw FFT. Phase 5 targets faithful recreation: Spotify Audio Analysis API provides beat/bar/section/segment data; the existing FFT pipeline stays as fallback for other sources. Requires Spotify Premium. |
| Real-time audio over file upload | The "live reactivity to whatever's playing" is what makes a visualizer worth building. File upload kept as a fallback. |
| Tab audio (`getDisplayMedia`) over installing a system audio driver | Zero-install, browser-native. Chrome/Edge support is enough for a hobby project. |
| three.js over raw WebGL | Particles + camera + render loop boilerplate is solved; the interesting work is in the shader and audio mapping. |
| importmap CDN over npm | No bundler, no build step, faster iteration. |
| ShaderMaterial over PointsMaterial | Need per-particle audio-reactive deformation in the vertex shader. |
| No `connect(destination)` for live sources | Mic feedback, tab-audio doubling. |
| Asymmetric band smoothing | Bass kicks should punch, then decay — symmetric smoothing flattens transients. |

---

## Notes for Claude Code

- Don't add a backend audio pipeline. All FFT happens in-browser. The Flask server only serves static files.
- The audio source picker is the primary UI. Anything that pushes mic/tab-audio off-screen is wrong.
- Browser autoplay rules: any audio source change requires a user click. Already handled.
- When debugging silence: open devtools, run `engine.bands()` — if all zeros, the graph isn't connected. If non-zero but stuck low, the source has gain/limiting.
