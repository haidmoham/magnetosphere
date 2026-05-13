// Spotify listening-along watcher.
//
// We don't play audio in the browser. Instead we poll Spotify's Web API for
// what's currently playing on the user's account (any device — phone, desktop
// app, speaker, etc.) and fetch the per-track audio analysis on track change.
// A drift-corrected scheduler fires beat events against an estimated playhead.
//
// Why this approach:
//   - No Chrome `getDisplayMedia` sharing bar — audio never enters the browser
//   - Works with hardware controls (media keys, AirPod stems, etc.)
//   - Spotify Free works (no `streaming` scope, no Web Playback SDK)
//   - Matches the original iTunes Magnetosphere model: the plugin reacted
//     to iTunes' internal playback data, it didn't play music itself
//
// Trade-off: polling latency. /v1/me/player isn't push-based. We poll every
// ~1.5s and extrapolate position locally between polls. Pause/seek detection
// lags by one poll cycle, which is fine for a visualizer.

const POLL_INTERVAL_MS = 1500;

// Tolerance window around a beat's exact timestamp where we still consider
// it "now." Bigger = beats are more forgiving but might double-fire on seeks;
// smaller = miss beats on slow frames. 60ms ≈ 3.6 frames at 60fps.
const BEAT_WINDOW_MS = 60;

export class SpotifyWatcher {
  constructor() {
    // Auth
    this._token          = null;
    this._tokenExpiresAt = 0;

    // Current playback snapshot (refreshed by _poll, extrapolated between)
    this.currentTrack    = null;   // Spotify track object
    this.currentDevice   = null;
    this.isPlaying       = false;
    this._anchorPosMs    = 0;      // ms into the track at last poll
    this._anchorClockMs  = 0;      // performance.now() at last poll

    // Audio analysis (fetched on track change)
    this.analysis        = null;   // { beats, bars, sections, segments, track }
    this._analysisTrackId = null;
    this._nextBeatIdx    = 0;
    this._segIdxCache    = 0;

    // Poll loop
    this._pollTimer      = null;
    this._running        = false;

    // Public hooks (assigned by main.js)
    this.onTrackChange   = null;   // (track, device)               => void
    this.onStateChange   = null;   // ({track, device, isPlaying})  => void
    this.onAnalysisLoad  = null;   // (analysis)                    => void
    this.onError         = null;   // ({type, message})             => void
  }

  /** Begin watching. Throws if not authenticated. */
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

  /** Stop polling and clear all state. */
  stop() {
    this._running = false;
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    this.currentTrack  = null;
    this.currentDevice = null;
    this.isPlaying     = false;
    this.analysis      = null;
    this._nextBeatIdx  = 0;
    this._segIdxCache  = 0;
  }

  /**
   * Called once per render frame. Returns:
   *   { bands: {bass, mid, treble}, beat: bool, positionMs: number }
   *
   * `bands` is synthesized from segment loudness so the existing visualizer
   * drivers (breathing, point size, etc.) keep working without real FFT data.
   * `beat` fires true on the frame a beat's timestamp crosses the playhead.
   */
  tick() {
    const positionMs = this.estimatePositionMs();
    return {
      bands:      this._synthBands(positionMs),
      beat:       this._consumeBeat(positionMs),
      positionMs,
    };
  }

  /** Best estimate of current playhead (ms into track) using local clock drift. */
  estimatePositionMs() {
    if (!this._anchorClockMs) return 0;
    if (!this.isPlaying)      return this._anchorPosMs;
    return this._anchorPosMs + (performance.now() - this._anchorClockMs);
  }

  // ── beat scheduler ────────────────────────────────────────────────

  /**
   * Returns true if a beat crosses the playhead this frame.
   * `_nextBeatIdx` is the cursor into `analysis.beats`; it monotonically
   * advances during playback and is re-snapped on poll (to handle seeks).
   */
  _consumeBeat(positionMs) {
    if (!this.analysis || !this.isPlaying) return false;
    const beats = this.analysis.beats;
    let fired = false;
    while (this._nextBeatIdx < beats.length) {
      const beatMs = beats[this._nextBeatIdx].start * 1000;
      if (beatMs > positionMs + BEAT_WINDOW_MS) break;          // not yet
      if (beatMs > positionMs - BEAT_WINDOW_MS * 4) fired = true; // close enough
      this._nextBeatIdx++;
    }
    return fired;
  }

  /**
   * Synthesize bass/mid/treble from Spotify's per-segment loudness curve.
   * Without this the visualizer would freeze between beats (no continuous
   * energy signal driving breathing / rotation / particle size).
   *
   * Each segment exposes a piecewise loudness envelope:
   *   loudness_start → loudness_max (at loudness_max_time) → loudness_end
   * We interpolate within that envelope and map dB → 0–1.
   *
   * Bass gets the full energy; mid is slightly damped; treble more so.
   * Future refinement (Phase 5.3): use segment.timbre[1] for true brightness
   * and segment.pitches for harmonic content distribution.
   */
  _synthBands(positionMs) {
    if (!this.analysis || !this.isPlaying) return { bass: 0, mid: 0, treble: 0 };
    const seg = this._currentSegment(positionMs);
    if (!seg) return { bass: 0, mid: 0, treble: 0 };

    const tSec    = positionMs / 1000;
    const localT  = Math.max(0, tSec - seg.start);
    const peakT   = seg.loudness_max_time;
    const tailDur = Math.max(0.001, seg.duration - peakT);
    let dB;
    if (localT < peakT) {
      dB = lerp(seg.loudness_start, seg.loudness_max, peakT > 0 ? localT / peakT : 1);
    } else {
      dB = lerp(seg.loudness_max, seg.loudness_end, Math.min(1, (localT - peakT) / tailDur));
    }
    // Spotify loudness is in dB (typically -60 to 0). Map to 0–1.
    const energy = clamp01((dB + 60) / 60);
    return {
      bass:   energy,
      mid:    energy * 0.78,
      treble: energy * 0.55,
    };
  }

  /** Find the segment containing `positionMs`. Cached index makes this O(1) amortized. */
  _currentSegment(positionMs) {
    if (!this.analysis || !this.analysis.segments.length) return null;
    const tSec = positionMs / 1000;
    const segs = this.analysis.segments;
    let idx = this._segIdxCache;
    if (idx >= segs.length || segs[idx].start > tSec) idx = 0;
    while (idx < segs.length - 1 && segs[idx + 1].start <= tSec) idx++;
    this._segIdxCache = idx;
    return segs[idx];
  }

  /** After a seek (detected by position discontinuity), snap the beat
      cursor forward to the right place. */
  _resyncBeatIndex() {
    if (!this.analysis) return;
    const tMs = this.estimatePositionMs();
    const beats = this.analysis.beats;
    let idx = 0;
    while (idx < beats.length && beats[idx].start * 1000 < tMs - BEAT_WINDOW_MS) idx++;
    this._nextBeatIdx = idx;
    this._segIdxCache = 0;  // segment lookup will re-scan from start
  }

  // ── polling ───────────────────────────────────────────────────────

  async _poll() {
    if (!this._running) return;
    const token = await this._getFreshToken();
    const r = await fetch("https://api.spotify.com/v1/me/player", {
      headers: { Authorization: `Bearer ${token}` },
    });

    // 204 = no active device / nothing playing
    if (r.status === 204) {
      this._handleNoPlayback();
      return;
    }
    if (!r.ok) throw new Error(`Player fetch failed: ${r.status}`);

    const data = await r.json();
    if (!data || !data.item) {
      this._handleNoPlayback();
      return;
    }

    const newTrackId   = data.item.id;
    const trackChanged = newTrackId !== this.currentTrack?.id;

    this.currentTrack   = data.item;
    this.currentDevice  = data.device;
    this.isPlaying      = !!data.is_playing;
    this._anchorPosMs   = data.progress_ms || 0;
    this._anchorClockMs = performance.now();

    if (trackChanged) {
      this._nextBeatIdx = 0;
      this._segIdxCache = 0;
      this.analysis     = null;
      this.onTrackChange?.(this.currentTrack, this.currentDevice);
      // Analysis fetch runs in the background; visualizer falls back to
      // zero-energy/no-beats until it arrives.
      this._fetchAnalysis(newTrackId).catch(err => {
        this.onError?.({ type: "analysis_fetch", message: err.message || String(err) });
      });
    } else {
      // Same track: re-sync against the new position in case of seek.
      this._resyncBeatIndex();
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
    this.analysis       = null;
    this._nextBeatIdx   = 0;
    this.onStateChange?.({ track: null, device: null, isPlaying: false });
  }

  async _fetchAnalysis(trackId) {
    const token = await this._getFreshToken();
    const r = await fetch(`https://api.spotify.com/v1/audio-analysis/${trackId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`Audio analysis fetch failed: ${r.status}`);
    const data = await r.json();
    // Race protection: the user may have skipped to another track while
    // we were fetching. Discard stale results.
    if (trackId !== this.currentTrack?.id) return;
    this.analysis = {
      beats:    data.beats    || [],
      bars:     data.bars     || [],
      sections: data.sections || [],
      segments: data.segments || [],
      track:    data.track    || {},
    };
    this._analysisTrackId = trackId;
    this._resyncBeatIndex();
    this.onAnalysisLoad?.(this.analysis);
  }

  // ── token helpers ─────────────────────────────────────────────────

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

function lerp(a, b, t)   { return a + (b - a) * t; }
function clamp01(v)      { return v < 0 ? 0 : v > 1 ? 1 : v; }
