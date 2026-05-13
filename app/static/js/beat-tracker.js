// BeatTracker: real beat detection via Essentia.js (WebAssembly).
//
// Loads lazily the first time connect() is called — Essentia's WASM is ~2.4MB
// so we don't load it until the user actually picks an audio source. Until
// Essentia is ready (first ~6-8s), the caller should fall back to the existing
// FFT onset detector; isReady indicates when Essentia has taken over.
//
// Algorithm: RhythmExtractor2013 ('multifeature' method) on a rolling 6-second
// PCM buffer posted by beat-worklet.js every ~2 seconds. Returns per-analysis:
//   bpm   — detected tempo (40–220 BPM, null until first confident estimate)
//   ticks — beat timestamps within the buffer, in seconds from buffer start
//
// Phase-locking: on each analysis we anchor _lastBeatMs (wall-clock) to the
// last detected tick. The beat() method then fires on the inferred grid, so
// the visualiser's burst events align with real musical downbeats rather than
// an arbitrary cadence offset.
//
// Usage:
//   const bt = new BeatTracker(audioCtx);
//   await bt.connect(sourceNode);   // non-blocking; fires error callback on fail
//   // per-frame:
//   if (bt.isReady) { const hit = bt.beat(); }
//   // cleanup:
//   bt.disconnect();

const CDN_CORE   = 'https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia.js-core.es.js';
const CDN_WASM   = 'https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia-wasm.es.js';
const WORKLET_URL = '/static/js/beat-worklet.js';

export class BeatTracker {
  constructor(audioContext) {
    this._ctx          = audioContext;
    this._node         = null;    // AudioWorkletNode (beat-collector)
    this._ess          = null;    // Essentia instance
    this._bpm          = null;
    this._intervalMs   = null;    // 60000 / bpm
    this._lastBeatMs   = -Infinity; // performance.now() of last phase-locked beat
    this._loadPromise  = null;
    this._workletReady = false;

    // Public callbacks.
    this.onBeat  = null;  // () => void
    this.onBpm   = null;  // (bpm: number) => void
    this.onError = null;  // (err: Error) => void
  }

  /** Current BPM estimate, or null until a confident first reading. */
  get bpm()     { return this._bpm; }

  /** True once the worklet is connected AND Essentia has produced its first
   *  confident estimate. Until then, the caller should use a fallback detector. */
  get isReady() { return this._workletReady && this._bpm !== null; }

  /**
   * Connect to a source node and begin accumulating audio.
   * Non-blocking: Essentia loads in the background; isReady reflects progress.
   * Safe to call again when the audio source changes — re-connects automatically.
   */
  async connect(sourceNode) {
    this.disconnect();
    try {
      await this._load();
      this._node = new AudioWorkletNode(this._ctx, 'beat-collector', {
        numberOfOutputs: 0, // sink node — no audio output
      });
      this._node.port.onmessage = (e) => this._onChunk(e.data);
      sourceNode.connect(this._node);
      this._workletReady = true;
    } catch (err) {
      // Non-fatal. Caller falls back to FFT onset detector.
      this.onError?.(err);
    }
  }

  /** Disconnect and free the worklet node. Essentia instance is retained so
   *  a future connect() reuses the already-loaded WASM. */
  disconnect() {
    try { this._node?.disconnect(); } catch {}
    this._node = null;
    this._workletReady = false;
    // Keep _bpm / _lastBeatMs — if the user re-connects the same source (e.g.,
    // after a brief interruption) the existing phase anchor is still useful.
  }

  /**
   * Call once per render frame (60 fps). Returns true on the frame where a beat
   * is inferred from the detected BPM grid + phase anchor. Also fires onBeat.
   * Returns false when isReady is false (caller should use fallback).
   */
  beat() {
    if (!this._bpm || !this._intervalMs) return false;
    const now = performance.now();
    if (now - this._lastBeatMs >= this._intervalMs * 0.95) {
      // Snap to the nearest grid line to prevent drift accumulation.
      this._lastBeatMs = Math.floor(now / this._intervalMs) * this._intervalMs;
      this.onBeat?.();
      return true;
    }
    return false;
  }

  // ── private ────────────────────────────────────────────────────────────────

  /** Load the AudioWorklet module + Essentia WASM in parallel. Idempotent. */
  async _load() {
    if (this._loadPromise) {
      try { await this._loadPromise; return; }
      catch { this._loadPromise = null; } // retry after failure
    }
    this._loadPromise = (async () => {
      await Promise.all([
        this._ctx.audioWorklet.addModule(WORKLET_URL),
        this._loadEssentia(),
      ]);
    })();
    this._loadPromise.catch(() => { this._loadPromise = null; });
    return this._loadPromise;
  }

  async _loadEssentia() {
    if (this._ess) return;
    const [coreModule, wasmModule] = await Promise.all([
      import(CDN_CORE),
      import(CDN_WASM),
    ]);
    const Essentia    = coreModule.default;
    const EssentiaWASM = wasmModule.EssentiaWASM;
    // EssentiaWASM may be an already-initialised module object (v0.1.3) or a
    // factory function — handle both.
    const wasm = typeof EssentiaWASM === 'function' ? await EssentiaWASM() : EssentiaWASM;
    this._ess = new Essentia(wasm);
  }

  /** Called every ~2s with a fresh 6-second PCM chunk from the worklet. */
  _onChunk({ samples, sampleRate }) {
    if (!this._ess) return;

    // chunkReceivedMs ≈ wall-clock time of the last sample in this buffer.
    const chunkReceivedMs = performance.now();
    const bufDurationMs   = (samples.length / sampleRate) * 1000;

    try {
      const vec    = this._ess.arrayToVector(samples);
      // Parameters: signal, maxTempo, method, minTempo
      const result = this._ess.RhythmExtractor2013(vec, 208, 'multifeature', 40);
      vec.delete();

      const bpm        = result.bpm;
      const confidence = result.confidence;
      const ticksVec   = result.ticks;
      const ticks      = this._ess.vectorToArray(ticksVec); // seconds from buf start
      ticksVec.delete();
      // Free remaining output vectors.
      if (result.estimates)    result.estimates.delete();
      if (result.bpmIntervals) result.bpmIntervals.delete();

      // Reject implausible or low-confidence readings — better to keep using
      // the previous estimate than to glitch on a noisy chunk.
      if (bpm < 40 || bpm > 220 || confidence < 0.1) return;

      const prevBpm   = this._bpm;
      const newInterval = 60000 / bpm;
      this._bpm       = bpm;
      this._intervalMs = newInterval;

      // Phase anchor: map the last detected tick to its wall-clock timestamp.
      // Only adopt the new anchor if it's within 40% of an interval from where
      // the existing grid predicts — prevents jarring jumps on a noisy chunk.
      if (ticks.length > 0) {
        const lastTickSec = ticks[ticks.length - 1];
        const tickWallMs  = chunkReceivedMs - bufDurationMs + lastTickSec * 1000;
        const expectedMs  = this._lastBeatMs + newInterval;
        const drift       = Math.abs(tickWallMs - expectedMs);
        if (this._lastBeatMs === -Infinity || drift < newInterval * 0.4) {
          this._lastBeatMs = tickWallMs;
        }
      }

      if (prevBpm === null || Math.abs(bpm - prevBpm) > 3) {
        this.onBpm?.(bpm);
      }
    } catch (err) {
      // Analysis errors are non-fatal — the grid just doesn't update this tick.
      console.warn('[beat-tracker]', err.message || err);
    }
  }
}
