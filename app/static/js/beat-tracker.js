// BeatTracker: real beat detection via Essentia.js running in a Web Worker.
//
// All heavy WASM computation (RhythmExtractor2013 on ~6s of PCM) happens in
// beat-worker.js off the main thread, so the render loop never stalls. The
// main thread only handles lightweight state updates from worker results.
//
// Until the worker has a confident estimate (~6-8s of audio), isReady is
// false and the caller should fall back to the FFT onset detector.
//
// Usage:
//   const bt = new BeatTracker(audioContext);
//   await bt.connect(sourceNode);  // non-blocking; safe to fire-and-forget
//   // per-frame:
//   if (bt.isReady) beat = bt.beat();
//   // cleanup:
//   bt.disconnect();

const WORKLET_URL = '/static/js/beat-worklet.js';
const WORKER_URL  = '/static/js/beat-worker.js';

export class BeatTracker {
  constructor(audioContext) {
    this._ctx          = audioContext;
    this._node         = null;    // AudioWorkletNode (sample collector)
    this._worker       = null;    // Web Worker (Essentia analysis)
    this._bpm          = null;
    this._intervalMs   = null;
    this._lastBeatMs   = -Infinity; // performance.now() of last phase-anchored beat
    this._workletReady = false;
    this._workletAdded = false;   // addModule() is idempotent but track it anyway

    // Public callbacks.
    this.onBeat  = null;  // () => void
    this.onBpm   = null;  // (bpm: number) => void
    this.onError = null;  // (err: Error) => void
  }

  get bpm()     { return this._bpm; }
  get isReady() { return this._workletReady && this._bpm !== null; }

  /**
   * Connect to a source node and begin beat detection.
   * Safe to call again on source change — disconnects the previous node first.
   */
  async connect(sourceNode) {
    this.disconnect();
    try {
      // Register the worklet module once per AudioContext.
      if (!this._workletAdded) {
        await this._ctx.audioWorklet.addModule(WORKLET_URL);
        this._workletAdded = true;
      }

      // Worker is created once per BeatTracker instance.
      // Essentia starts loading inside it immediately on creation.
      if (!this._worker) {
        this._worker = new Worker(WORKER_URL, { type: 'module' });
        this._worker.onmessage = (e) => this._onWorkerResult(e.data);
        this._worker.onerror   = (e) => this.onError?.(new Error(e.message));
      }

      this._node = new AudioWorkletNode(this._ctx, 'beat-collector', {
        numberOfOutputs: 0, // sink — no audio output
      });
      this._node.port.onmessage = (e) => this._onChunk(e.data);
      sourceNode.connect(this._node);
      this._workletReady = true;
    } catch (err) {
      // Non-fatal — caller falls back to FFT onset detector.
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Disconnect the worklet node. Worker and Essentia instance are retained. */
  disconnect() {
    try { this._node?.disconnect(); } catch {}
    this._node = null;
    this._workletReady = false;
  }

  /**
   * Call once per render frame (~60 fps). Returns true on the frame a beat
   * is inferred from the detected BPM grid + phase anchor. Also fires onBeat.
   */
  beat() {
    if (!this._bpm || !this._intervalMs) return false;
    const now = performance.now();
    if (now - this._lastBeatMs >= this._intervalMs * 0.95) {
      this._lastBeatMs = Math.floor(now / this._intervalMs) * this._intervalMs;
      this.onBeat?.();
      return true;
    }
    return false;
  }

  // ── private ────────────────────────────────────────────────────────────────

  /** Forward raw PCM to the Worker. No computation here — zero main-thread cost. */
  _onChunk({ samples, sampleRate }) {
    if (!this._worker) return;
    const receivedMs  = performance.now();
    const durationMs  = (samples.length / sampleRate) * 1000;
    // Transfer the buffer to avoid a copy across threads.
    this._worker.postMessage({ samples, sampleRate, receivedMs, durationMs }, [samples.buffer]);
  }

  /** Handle analysis result from the Worker. Lightweight state update only. */
  _onWorkerResult({ bpm, confidence, lastTickSec, receivedMs, durationMs, error }) {
    if (error) {
      console.warn('[beat-tracker]', error);
      return;
    }
    if (!bpm || bpm < 40 || bpm > 220 || confidence < 0.1) return;

    const newInterval = 60000 / bpm;
    const prevBpm     = this._bpm;
    this._bpm         = bpm;
    this._intervalMs  = newInterval;

    // Phase anchor: map the last detected tick to its wall-clock timestamp.
    // receivedMs ≈ wall-clock time of the last sample in the buffer.
    if (lastTickSec !== null) {
      const tickWallMs = receivedMs - durationMs + lastTickSec * 1000;
      const drift      = Math.abs(tickWallMs - (this._lastBeatMs + newInterval));
      if (this._lastBeatMs === -Infinity || drift < newInterval * 0.4) {
        this._lastBeatMs = tickWallMs;
      }
    }

    if (prevBpm === null || Math.abs(bpm - prevBpm) > 3) {
      this.onBpm?.(bpm);
    }
  }
}
