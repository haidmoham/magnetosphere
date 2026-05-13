// Spotify listening-along watcher.
//
// Spotify deprecated the rich /v1/audio-analysis endpoint for new apps in
// Nov 2024 (and the API on which this project's auth was registered is post-
// cutoff). So we can't pull beat/bar/section/segment timestamps anymore. We
// CAN still pull track-level audio features via ReccoBeats — a free public
// API that rebuilt the deprecated /audio-features half with identical field
// names + ranges (energy/valence/tempo/key/etc.). Proxied through Flask at
// /auth/spotify/features/{spotifyId} to avoid CORS.
//
// What this watcher does:
//   - Polls /v1/me/player every 1500ms (Spotify Web API) — knows what track
//     is playing, where in the track, on which device
//   - On track change: fetch ReccoBeats features → emit onFeaturesLoad
//   - Per-frame tick(): synthesizes {bands, beat} from tempo + playhead
//     so the visualizer pulses in time with the song even without real beat
//     timestamps. Won't align to actual downbeats (we have no offset data),
//     but the *cadence* matches.
//
// Phase 5.4 (next): pair with Essentia.js BeatTrackerMultiFeature when an
// audio source is also active — gets us real beat alignment.

const POLL_INTERVAL_MS = 1500;

export class SpotifyWatcher {
  constructor() {
    // Auth
    this._token          = null;
    this._tokenExpiresAt = 0;

    // Current playback snapshot
    this.currentTrack    = null;
    this.currentDevice   = null;
    this.isPlaying       = false;
    this._anchorPosMs    = 0;      // ms into the track at last poll
    this._anchorClockMs  = 0;      // performance.now() at last poll

    // Audio features (ReccoBeats), refreshed on track change
    this.features        = null;   // { tempo, energy, valence, key, ... } or null
    this._featuresTrackId = null;

    // BPM pulse state
    this._lastPulseMs    = -Infinity;

    // Poll loop
    this._pollTimer      = null;
    this._running        = false;

    // Public hooks
    this.onTrackChange   = null;   // (track, device)              => void
    this.onStateChange   = null;   // ({track, device, isPlaying}) => void
    this.onFeaturesLoad  = null;   // (features)                   => void
    this.onError         = null;   // ({type, message})            => void
  }

  /** True while the poll loop is active (regardless of audio mode). */
  get isRunning() { return this._running; }

  async start() {
    if (this._running) return;
    await this._refreshToken();
    this._running = true;
    await this._poll();
    this._pollTimer = setInterval(
      () => this._poll().catch(err => this.onError?.({ type: "poll", message: err.message || String(err) })),
      POLL_INTERVAL_MS,
    );
  }

  stop() {
    this._running = false;
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    this.currentTrack  = null;
    this.currentDevice = null;
    this.isPlaying     = false;
    this.features      = null;
    this._featuresTrackId = null;
    this._lastPulseMs  = -Infinity;
  }

  /**
   * Called once per render frame. Returns {bands, beat, positionMs}.
   *
   * Synthesis approach:
   *   - We know tempo (BPM) from ReccoBeats and current playhead from polling
   *   - Beat interval = 60000 / tempo ms
   *   - Fire a synthetic `beat` every interval, snap to BPM grid
   *   - `bands` decays exponentially after each pulse (peaks on beat, dips
   *     between) so the visualizer's bass-driven breathing has a heartbeat
   *
   * Limitation: we have no offset, so the pulses won't necessarily land
   * on the song's actual downbeats — just at the right *cadence*. With an
   * Essentia.js beat tracker (Phase 5.4) running on a paired audio source,
   * we'd snap to real beats.
   */
  tick() {
    const positionMs = this.estimatePositionMs();
    if (!this.isPlaying || !this.features?.tempo) {
      return { bands: ZERO_BANDS, beat: false, positionMs };
    }
    const beatIntervalMs = 60000 / this.features.tempo;

    // Fire a beat if we've crossed a grid line since the last pulse.
    let beat = false;
    if (positionMs - this._lastPulseMs >= beatIntervalMs * 0.95) {
      beat = true;
      // Advance by exactly one interval rather than Math.floor-snapping.
      // Snapping to Math.floor can place _lastPulseMs before the current
      // position, causing the next frame to immediately re-fire (double-burst).
      this._lastPulseMs += beatIntervalMs;
    }

    // Energy curve: peaks at the pulse, decays before the next one. Half-life
    // tuned so we hit ~25% of peak right before the next beat — gives a
    // recognizable "thump-thump" feel rather than mush.
    const sinceMs = Math.max(0, positionMs - this._lastPulseMs);
    const decayK  = Math.log(2) / (beatIntervalMs * 0.45);
    const env     = Math.exp(-sinceMs * decayK);

    // Scale by track energy so soft tracks feel softer.
    const trackE  = clamp01(this.features.energy ?? 0.6);
    const peak    = 0.35 + trackE * 0.6;     // 0.35..0.95 peak amplitude
    const amp     = env * peak;
    return {
      bands: {
        bass:   amp,
        mid:    amp * 0.75,
        treble: amp * 0.50,
      },
      beat,
      positionMs,
    };
  }

  estimatePositionMs() {
    if (!this._anchorClockMs) return 0;
    if (!this.isPlaying)      return this._anchorPosMs;
    return this._anchorPosMs + (performance.now() - this._anchorClockMs);
  }

  /**
   * Phase-lock the BPM pulse grid to an externally detected beat.
   * Called by BeatTracker.onBeat when a paired audio source (tab/mic/file)
   * is running alongside the Spotify watcher. Snaps _lastPulseMs to the
   * current track position so the synthesised pulse grid aligns with real
   * musical downbeats instead of an arbitrary offset.
   *
   * @param {number} posMs  Current track position in ms (from estimatePositionMs)
   */
  phaseLock(posMs) {
    this._lastPulseMs = posMs;
  }

  // ── polling ──────────────────────────────────────────────────────

  async _poll() {
    if (!this._running) return;
    const token = await this._getFreshToken();
    const r = await fetch("https://api.spotify.com/v1/me/player", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.status === 204) { this._handleNoPlayback(); return; }
    if (!r.ok) throw new Error(`Player fetch failed: ${r.status}`);

    const data = await r.json();
    if (!data || !data.item) { this._handleNoPlayback(); return; }

    const newTrackId   = data.item.id;
    const trackChanged = newTrackId !== this.currentTrack?.id;

    this.currentTrack   = data.item;
    this.currentDevice  = data.device;
    this.isPlaying      = !!data.is_playing;
    this._anchorPosMs   = data.progress_ms || 0;
    this._anchorClockMs = performance.now();

    if (trackChanged) {
      this.features       = null;
      this._lastPulseMs   = -Infinity;
      this.onTrackChange?.(this.currentTrack, this.currentDevice);
      this._fetchFeatures(newTrackId).catch(err => {
        // Most likely "track_not_indexed" (404) — fine, just no auto-palette.
        if (!String(err.message).includes("404")) {
          this.onError?.({ type: "features", message: err.message || String(err) });
        }
      });
    }

    this.onStateChange?.({
      track:     this.currentTrack,
      device:    this.currentDevice,
      isPlaying: this.isPlaying,
    });
  }

  _handleNoPlayback() {
    if (!this.currentTrack && !this.isPlaying) return;
    this.currentTrack   = null;
    this.currentDevice  = null;
    this.isPlaying      = false;
    this.features       = null;
    this._lastPulseMs   = -Infinity;
    this.onStateChange?.({ track: null, device: null, isPlaying: false });
  }

  async _fetchFeatures(spotifyId) {
    const r = await fetch(`/auth/spotify/features/${spotifyId}`);
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(`${r.status} ${body.error || "features fetch failed"}`);
    }
    const feats = await r.json();
    // Race protection: discard if user has skipped to another track.
    if (spotifyId !== this.currentTrack?.id) return;
    this.features         = feats;
    this._featuresTrackId = spotifyId;
    this.onFeaturesLoad?.(feats);
  }

  // ── token helpers ────────────────────────────────────────────────

  async _refreshToken() {
    const r = await fetch("/auth/spotify/token");
    if (!r.ok) throw new Error("Spotify not authenticated");
    const { access_token, expires_at } = await r.json();
    this._token          = access_token;
    this._tokenExpiresAt = expires_at;
  }

  async _getFreshToken() {
    if (Date.now() / 1000 < this._tokenExpiresAt - 60) return this._token;
    await this._refreshToken();
    return this._token;
  }
}

const ZERO_BANDS = { bass: 0, mid: 0, treble: 0 };
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
