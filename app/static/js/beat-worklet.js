// AudioWorklet processor: accumulates PCM samples into a rolling 6-second
// ring buffer and posts a linearised snapshot to the main thread every ~2s.
// Main thread runs Essentia.js RhythmExtractor2013 on each snapshot.
//
// Registered as: 'beat-collector'
// Messages sent: { samples: Float32Array, sampleRate: number }
// (Float32Array buffer is transferred — zero-copy.)

class BeatCollectorProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // 6-second window, 2-second hop.
    this._maxSamples  = Math.round(sampleRate * 6);
    this._hopSamples  = Math.round(sampleRate * 2);
    this._ring        = new Float32Array(this._maxSamples);
    this._writePos    = 0;
    this._totalWritten = 0;  // detect when ring is initially full
    this._sincePost   = 0;
  }

  process(inputs) {
    const left  = inputs[0]?.[0];
    const right = inputs[0]?.[1];
    if (!left) return true;

    const len = left.length;
    for (let i = 0; i < len; i++) {
      // Mix to mono. If stereo, average channels; otherwise pass straight through.
      this._ring[this._writePos] = right
        ? (left[i] + right[i]) * 0.5
        : left[i];
      this._writePos = (this._writePos + 1) % this._maxSamples;
    }
    this._totalWritten += len;
    this._sincePost    += len;

    // Wait until the ring is full before posting — RhythmExtractor2013 needs
    // enough context (~5-6s) for a reliable first estimate.
    if (this._totalWritten >= this._maxSamples && this._sincePost >= this._hopSamples) {
      this._sincePost = 0;
      // Linearise: copy oldest → newest into a fresh Float32Array.
      const out   = new Float32Array(this._maxSamples);
      const start = this._writePos; // oldest sample sits at write cursor
      for (let i = 0; i < this._maxSamples; i++) {
        out[i] = this._ring[(start + i) % this._maxSamples];
      }
      // Transfer the buffer — avoids a copy across the thread boundary.
      this.port.postMessage({ samples: out, sampleRate }, [out.buffer]);
    }
    return true;
  }
}

registerProcessor('beat-collector', BeatCollectorProcessor);
