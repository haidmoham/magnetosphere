# Magnetosphere

A web reimagining of the iTunes Magnetosphere visualizer: a GPU particle field that swirls, breathes, and reacts to live audio.

## Run locally

```bash
./scripts/dev.sh
```

Then open http://localhost:5002

## Audio sources

1. **Tab audio** — share a Chrome tab with audio (the cool one — captures whatever's playing in the tab)
2. **Microphone** — listens through the laptop mic
3. **Audio file** — fallback; pick an mp3

## Deploy

```bash
./scripts/deploy.sh "what changed"
./scripts/logs.sh
```
