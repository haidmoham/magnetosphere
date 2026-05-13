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
- [ ] EffectComposer + UnrealBloomPass
- [ ] Tonemapping pass
- [ ] Color palette presets

### Phase 4 — Magnetosphere proper
- [x] Audio-reactive attractors (mid orbit speed, bass radius pulse; 0–4 wells tunable)
- [ ] Scene transitions (camera cuts, palette swaps)
- [ ] Optional: webcam-based hand interaction

---

## Key Decisions Log

| Decision | Rationale |
|---|---|
| 80s synthwave aesthetic | Project-wide visual language: neon cyan + hot pink palette, deep purple background gradient, perspective grid floor, CRT scanlines, Orbitron + Share Tech Mono fonts. New UI elements should match this — no flat material-design defaults. |
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
