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

**Architectural pivot (5.1 → 5.2):** the initial 5.1 implementation routed
playback *through the browser* via the Web Playback SDK so we could attach to
the audio. In 5.2 we dropped that entirely in favor of a **listening-along
watcher**: the user plays music in their normal Spotify client (desktop, phone,
speaker, anything) and we just poll `/v1/me/player` for what's playing +
position, then fetch `/v1/audio-analysis/{id}` for the beat timeline. The
visualizer reacts; no audio ever enters the browser. This matches how the
iTunes plugin worked, removes the Chrome sharing-bar problem, preserves
hardware playback controls, and works for free Spotify accounts (no Premium
streaming scope needed).

Spotify Audio Analysis API returns per-track: beat timestamps (sec), bar
positions, sections (verse/chorus/bridge), segments with pitch + timbre +
loudness envelopes, tempo, key, time signature, energy, valence.

**Architecture:**
- Flask: `/auth/spotify/{login,callback,token,status,logout}` with one scope
  (`user-read-playback-state`). Tokens in signed-cookie session.
- Frontend `SpotifyWatcher` (no SDK): polls `/v1/me/player` every 1.5s,
  extrapolates playhead between polls via `performance.now()` delta against
  the last `progress_ms` anchor, re-syncs on each poll to correct drift.
- On track change: fetches audio analysis, builds timeline, runs scheduler.
- `spotify.tick()` is called once per render frame; returns
  `{bands, beat, positionMs}` that main.js passes into viz.render() in
  place of the FFT-derived values.
- `bands` is *synthesized* from segment loudness envelopes (continuous energy
  signal between beats); `beat` is true when a beat timestamp crosses the
  estimated playhead this frame.
- Existing FFT pipeline stays in place for mic / tab / file sources.

**What each Spotify data type drives:**
| Spotify data | Visualizer event |
|---|---|
| Beat timestamps | `uBurst` fires exactly on beat (replaces onset detector) |
| Segment loudness | Synthesised bass/mid/treble (continuous energy curve) |
| Bar / downbeat *(todo)* | Cinematic camera cut candidate |
| Section change *(todo)* | Shape transition + palette swap |
| Segment pitch vector *(todo)* | Per-frame color entropy modulation |
| Segment timbre vector *(todo)* | Flow field strength / attractor radius |
| Track valence + energy *(todo)* | Starting palette selection on load |

**Phase 5.1 — OAuth + playback foundation (done; superseded)**
- [x] Flask OAuth blueprint
- [x] Spotify source button (gated on server-side `configured` flag)
- [x] `audio.useSpotify()` stub mode

**Phase 5.2 — Listening-along watcher + beat scheduler (active)**
- [x] Drop Web Playback SDK; rewrite as `SpotifyWatcher` (polling)
- [x] Reduce OAuth scope to `user-read-playback-state` only
- [x] Drift-corrected playhead estimator
- [x] Audio analysis fetch + race-safe storage
- [x] Beat scheduler firing `uBurst` on beat timestamps
- [x] Synthesised bass/mid/treble from segment loudness envelope
- [ ] Bar/section/segment wiring (next sub-phase)

**Phase 5.3 — Richer analysis wiring (next)**
- [ ] Bar/downbeat → cinematic camera cut candidate
- [ ] Section change → shape transition + palette swap
- [ ] Segment pitch vector (12-dim) → color entropy modulation
- [ ] Segment timbre vector (12-dim) → flow strength / attractor radius
- [ ] Track valence + energy → auto-palette on track load

**Phase 5 ops notes:**
- Spotify dev dashboard: register `${BASE_URL}/auth/spotify/callback` as a
  redirect URI. Use 127.0.0.1 for local dev (Spotify blocks raw `localhost` on new apps).
- Required env vars on Railway: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`,
  `SPOTIFY_REDIRECT_URI=https://voidpulse.up.railway.app/auth/spotify/callback`
- Tokens live in Flask signed-cookie sessions (`PERMANENT_SESSION_LIFETIME=30d`).
- Polling cadence (1500ms) sits well under Spotify's ~180 req/min rate cap.

---

## Key Decisions Log

| Decision | Rationale |
|---|---|
| 80s synthwave aesthetic | Project-wide visual language: neon cyan + hot pink palette, deep purple background gradient, perspective grid floor, CRT scanlines, Orbitron + Share Tech Mono fonts. New UI elements should match this — no flat material-design defaults. |
| Spotify beat-sync over FFT-reactive | The original iTunes Magnetosphere used internal playback data (exact beat timestamps, song structure), not raw FFT. Phase 5 targets faithful recreation: Spotify Audio Analysis API provides beat/bar/section/segment data; the existing FFT pipeline stays as fallback for other sources. |
| Listening-along over in-browser playback | The Web Playback SDK approach (Phase 5.1) was dropped: routing audio through the browser added complexity (Chrome sharing-bar equivalents, volume routing, Premium requirement) without buying us anything beyond the analysis data we can fetch via the public Web API. The watcher just polls `/v1/me/player` for what's already playing on whatever device the user is using. Closer to how the original iTunes plugin actually worked. |
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
