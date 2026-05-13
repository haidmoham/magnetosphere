// Web Worker: runs Essentia.js RhythmExtractor2013 off the main thread.
//
// Loading Essentia WASM here instead of main.js means the 2.4 MB module
// parse + WASM instantiation never blocks the render loop. Analysis calls
// (~200-400ms each) also stay off the main thread.
//
// Message in:  { samples: Float32Array, sampleRate, receivedMs, durationMs }
// Message out: { bpm, confidence, lastTickSec, receivedMs, durationMs }
//           or { error: string, receivedMs, durationMs }
//
// Timing fields are echoed back so the caller can compute wall-clock phase
// without racing against the next incoming chunk.

const CDN_CORE = 'https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia.js-core.es.js';
const CDN_WASM = 'https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia-wasm.es.js';

let essentia   = null;
let loadError  = null;

// Start loading immediately on worker creation so Essentia is warm by the
// time the first 6-second audio chunk arrives (~6s after source activation).
(async () => {
  try {
    const [{ default: Essentia }, { EssentiaWASM }] = await Promise.all([
      import(CDN_CORE),
      import(CDN_WASM),
    ]);
    const wasm = typeof EssentiaWASM === 'function' ? await EssentiaWASM() : EssentiaWASM;
    essentia = new Essentia(wasm);
  } catch (err) {
    loadError = err.message || String(err);
    console.warn('[beat-worker] Essentia load failed:', loadError);
  }
})();

self.onmessage = ({ data }) => {
  const { samples, sampleRate, receivedMs, durationMs } = data;
  const echo = { receivedMs, durationMs }; // always echoed back for phase calc

  if (!essentia) {
    // Drop silently — still loading. Next chunk arrives in ~2s.
    return;
  }

  try {
    const vec    = essentia.arrayToVector(samples);
    const result = essentia.RhythmExtractor2013(vec, 208, 'multifeature', 40);
    vec.delete();

    const bpm        = result.bpm;
    const confidence = result.confidence;
    const ticksVec   = result.ticks;
    const ticks      = essentia.vectorToArray(ticksVec);
    ticksVec.delete();
    if (result.estimates)    result.estimates.delete();
    if (result.bpmIntervals) result.bpmIntervals.delete();

    const lastTickSec = ticks.length > 0 ? ticks[ticks.length - 1] : null;
    self.postMessage({ bpm, confidence, lastTickSec, ...echo });
  } catch (err) {
    self.postMessage({ error: err.message || String(err), ...echo });
  }
};
