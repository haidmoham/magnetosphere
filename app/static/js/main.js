import { AudioEngine } from "./audio.js";
import { Visualizer } from "./visualizer.js";

const canvas = document.getElementById("stage");
const sourcePicker = document.getElementById("source-picker");
const fileInput = document.getElementById("file-input");
const sourceLabel = document.getElementById("source-label");
const playBtn = document.getElementById("play-btn");
const stopBtn = document.getElementById("stop-btn");
const errorToast = document.getElementById("error-toast");
const mobileNotice = document.getElementById("mobile-notice");
const mobileDismiss = document.getElementById("mobile-dismiss");
const volSlider   = document.getElementById("vol-slider");
const sensSlider  = document.getElementById("sens-slider");
const volRow      = document.getElementById("vol-row");
const castBtn     = document.getElementById("cast-btn");
const castTooltip = document.getElementById("cast-tooltip");
const helpBtn     = document.getElementById("help-btn");
const helpTooltip = document.getElementById("help-tooltip");
const zoomInBtn   = document.getElementById("zoom-in-btn");
const zoomOutBtn  = document.getElementById("zoom-out-btn");
const zoomValue   = document.getElementById("zoom-value");

const audio = new AudioEngine();
const viz = new Visualizer(canvas);

// Photosensitivity warning — shown once per browser session.
const ewOverlay = document.getElementById("epilepsy-warning");
const ewProceed = document.getElementById("ew-proceed");
if (sessionStorage.getItem("voidpulse.ew.ack")) {
  ewOverlay.hidden = true;
} else {
  ewProceed.addEventListener("click", () => {
    sessionStorage.setItem("voidpulse.ew.ack", "1");
    ewOverlay.hidden = true;
  }, { once: true });
}

let errorTimer = 0;
function showError(msg) {
  errorToast.textContent = msg;
  errorToast.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => { errorToast.hidden = true; }, 6000);
}

function refreshUi() {
  sourceLabel.textContent = audio.mode ? audio.label : "no source";
  document.querySelectorAll(".src-btn").forEach((btn) => {
    const src = btn.dataset.src || (btn.classList.contains("file-btn") ? "file" : "");
    btn.classList.toggle("active", audio.mode === src);
  });
  const isFile = audio.mode === "file";
  volRow.classList.toggle("ctrl-disabled", !isFile);
  volSlider.disabled = !isFile;

  if (isFile) {
    playBtn.hidden = false;
    playBtn.textContent = audio.isPlaying() ? "pause" : "play";
    stopBtn.hidden = false;
  } else if (audio.mode === "mic" || audio.mode === "system") {
    playBtn.hidden = true;
    stopBtn.hidden = false;
  } else {
    playBtn.hidden = true;
    stopBtn.hidden = true;
  }
}

sourcePicker.addEventListener("click", async (e) => {
  const btn = e.target.closest(".src-btn");
  if (!btn) return;
  const src = btn.dataset.src;
  if (src === "system") {
    e.preventDefault();
    try { await audio.useSystemAudio(); }
    catch (err) { showError(err.message || String(err)); }
    refreshUi();
  } else if (src === "mic") {
    e.preventDefault();
    try { await audio.useMicrophone(); }
    catch (err) { showError(err.message || String(err)); }
    refreshUi();
  }
  // file-btn opens the native file picker via its <input>.
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    await audio.loadFile(file);
    await audio.play();
  } catch (err) {
    showError(err.message || String(err));
  }
  refreshUi();
});

playBtn.addEventListener("click", async () => {
  if (audio.isPlaying()) audio.pause();
  else await audio.play();
  refreshUi();
});

stopBtn.addEventListener("click", async () => {
  audio.pause();
  await audio._teardownCurrent();
  refreshUi();
});

function frame() {
  const bands = audio.bands();
  const stereo = {
    bandsL:    audio.bandsL(),
    bandsR:    audio.bandsR(),
    freqDataL: audio.rawFreqL(),
    freqDataR: audio.rawFreqR(),
  };
  viz.render(bands, audio.rawFreq(), audio.beat(), stereo);
  requestAnimationFrame(frame);
}

// Tuning panel: sliders write directly to shader uniforms, values persist
// across reloads via localStorage so a good config survives a refresh.
const TUNING_KEY = "voidpulse.tuning.v9";
const savedTuning = JSON.parse(localStorage.getItem(TUNING_KEY) || "{}");

// If a slider has data-exponent="N", the raw slider value is raised to the
// Nth power before being applied. This gives log-like fine control at the
// low end while still reaching the full range at max. The *displayed* value
// and the value passed to setTuning are always the post-transform value so
// screenshots are truthful.
function applyTransform(input, raw) {
  const exp = parseFloat(input.dataset.exponent);
  return (exp && exp !== 1) ? Math.pow(raw, exp) : raw;
}

document.querySelectorAll("#tuning-panel input[type=range]").forEach((input) => {
  const valEl   = input.parentElement.querySelector(".slider-val");
  const label   = input.parentElement.querySelector("label");
  const uniform = input.dataset.uniform;

  // Restore from localStorage on load (saved value is the raw slider position).
  if (typeof savedTuning[uniform] === "number") {
    input.value = savedTuning[uniform];
    const restored = applyTransform(input, savedTuning[uniform]);
    valEl.textContent = restored.toFixed(2);
    viz.setTuning(uniform, restored);
  }

  input.addEventListener("input", () => {
    const raw = parseFloat(input.value);
    const v   = applyTransform(input, raw);
    valEl.textContent = v.toFixed(2);
    viz.setTuning(uniform, v);
    savedTuning[uniform] = raw;             // save raw position, not transformed
    localStorage.setItem(TUNING_KEY, JSON.stringify(savedTuning));
  });

  // Click the label to reset just that slider to its HTML default.
  // Tooltip shows the *effective* (transformed) default.
  const transformedDefault = applyTransform(input, parseFloat(input.defaultValue));
  label.dataset.resetTo = transformedDefault.toFixed(2);
  label.addEventListener("click", () => {
    input.value = input.defaultValue;
    valEl.textContent = transformedDefault.toFixed(2);
    viz.setTuning(uniform, transformedDefault);
    delete savedTuning[uniform];
    localStorage.setItem(TUNING_KEY, JSON.stringify(savedTuning));
  });
});

// Click a section header to reset only the sliders within that section.
document.querySelectorAll("#tuning-panel .section-label").forEach((header) => {
  const section = header.closest(".tuning-section");
  header.addEventListener("click", () => {
    section.querySelectorAll("input[type=range]").forEach((input) => {
      input.value = input.defaultValue;
      const v    = applyTransform(input, parseFloat(input.defaultValue));
      const valEl = input.parentElement.querySelector(".slider-val");
      valEl.textContent = v.toFixed(2);
      viz.setTuning(input.dataset.uniform, v);
      delete savedTuning[input.dataset.uniform];
    });
    localStorage.setItem(TUNING_KEY, JSON.stringify(savedTuning));
  });
});

// Helper: pick a random value within a slider's range (snapped to step), then
// fire the input event so all the existing wiring (transform, display, save,
// viz.setTuning) runs.
function randomizeSlider(input) {
  const min  = parseFloat(input.min);
  const max  = parseFloat(input.max);
  const step = parseFloat(input.step) || 0.01;
  const v    = min + Math.random() * (max - min);
  input.value = Math.round(v / step) * step;
  input.dispatchEvent(new Event("input"));
}

// 🎲 per-section randomize buttons.
document.querySelectorAll("#tuning-panel .section-random").forEach((btn) => {
  const section = btn.closest(".tuning-section");
  btn.addEventListener("click", () => {
    section.querySelectorAll("input[type=range]").forEach(randomizeSlider);
  });
});

// 🎲 overall randomize.
const tuningRandom = document.getElementById("tuning-random");
tuningRandom.addEventListener("click", () => {
  document.querySelectorAll("#tuning-panel input[type=range]").forEach(randomizeSlider);
});

// Collapse / expand the tuning panel.
const tuningPanel  = document.getElementById("tuning-panel");
const tuningToggle = document.getElementById("tuning-toggle");
const tuningReset  = document.getElementById("tuning-reset");
const TUNING_COLLAPSED_KEY = "voidpulse.tuning.collapsed";
// Panel starts collapsed (set via HTML class). Only expand if the user has
// explicitly opened it in a previous session.
if (localStorage.getItem(TUNING_COLLAPSED_KEY) === "0") {
  tuningPanel.classList.remove("collapsed");
}
tuningToggle.addEventListener("click", () => {
  tuningPanel.classList.toggle("collapsed");
  localStorage.setItem(
    TUNING_COLLAPSED_KEY,
    tuningPanel.classList.contains("collapsed") ? "1" : "0",
  );
});

// Simple ↔ advanced view. Simple = chip rows + stereo only. Advanced =
// expands the slider body. Default is simple to keep the menu uncluttered;
// power users explicitly opt into the sliders, and the choice persists.
const tuningDetails       = document.getElementById("tuning-details");
const TUNING_ADVANCED_KEY = "voidpulse.tuning.advanced";

function applyAdvancedMode(on) {
  tuningPanel.classList.toggle("advanced", on);
  tuningDetails.textContent = on ? "▾ advanced" : "▸ advanced";
  localStorage.setItem(TUNING_ADVANCED_KEY, on ? "1" : "0");
}

applyAdvancedMode(localStorage.getItem(TUNING_ADVANCED_KEY) === "1");
tuningDetails.addEventListener("click", () => {
  applyAdvancedMode(!tuningPanel.classList.contains("advanced"));
});

// Cinematic mode — auto-cut camera + palette every 12–20s. State persists
// across reloads. The visualizer fires onSceneTick on each cut and we pair
// it with a random palette swap so each cut feels like a scene change.
const tuningCinema    = document.getElementById("tuning-cinema");
const CINEMA_KEY      = "voidpulse.cinema";
let   lastCinemaPalette = null;

viz.onSceneTick = () => {
  // PALETTES is defined below; evaluate lazily at call time (not at module parse).
  const names = Object.keys(PALETTES);
  // Pick a different palette than the last cut so consecutive scenes feel distinct.
  let name;
  do { name = names[Math.floor(Math.random() * names.length)]; }
  while (name === lastCinemaPalette && names.length > 1);
  lastCinemaPalette = name;
  applyPalette(name);
};

function applyCinema(on) {
  viz.setCinematic(on);
  tuningCinema.classList.toggle("on", on);
  localStorage.setItem(CINEMA_KEY, on ? "1" : "0");
}

applyCinema(localStorage.getItem(CINEMA_KEY) === "1");
tuningCinema.addEventListener("click", () => applyCinema(!viz.cinematic));

// Reset all sliders to their HTML default values and clear persisted state.
tuningReset.addEventListener("click", () => {
  document.querySelectorAll("#tuning-panel input[type=range]").forEach((input) => {
    input.value = input.defaultValue;
    const v    = applyTransform(input, parseFloat(input.defaultValue));
    const valEl = input.parentElement.querySelector(".slider-val");
    valEl.textContent = v.toFixed(2);
    viz.setTuning(input.dataset.uniform, v);
    delete savedTuning[input.dataset.uniform];
  });
  localStorage.removeItem(TUNING_KEY);
});

// ── Stereo toggles ────────────────────────────────────────────────────────
// Three independent on/off switches for particle hemisphere split, floor
// channel split, and color divergence. Persist across reloads.
const STEREO_KEY = "voidpulse.stereo.v1";
const savedStereo = JSON.parse(localStorage.getItem(STEREO_KEY) || "{}");

// Push a single stereo toggle to its visual + viz state. Doesn't persist —
// callers batch the localStorage write so a preset load only writes once.
function setStereo(uniform, value) {
  const btn = document.querySelector(`.stereo-btn[data-stereo="${uniform}"]`);
  if (!btn) return;
  const next = value ? 1 : 0;
  btn.dataset.on = next;
  btn.textContent = next ? "stereo" : "mono";
  btn.classList.toggle("on", next === 1);
  viz.setTuning(uniform, next);
  savedStereo[uniform] = next;
}

document.querySelectorAll(".stereo-btn").forEach((btn) => {
  const uniform = btn.dataset.stereo;
  setStereo(uniform, savedStereo[uniform] === 1 ? 1 : 0);

  btn.addEventListener("click", () => {
    setStereo(uniform, btn.dataset.on === "1" ? 0 : 1);
    localStorage.setItem(STEREO_KEY, JSON.stringify(savedStereo));
  });
});

// ── Presets, save slots, URL-hash sharing ─────────────────────────────────
// Everything "preset-like" is captured in one state shape:
//   { sliders: { uniform → raw }, stereo: { uniform → 0|1 } }
// captureState() reads it from the live UI. applyState() pushes it back
// through dispatchEvent('input') so localStorage + display values + shader
// uniforms all stay in sync without re-implementing that wiring.
function captureState() {
  const sliders = {};
  document.querySelectorAll("#tuning-panel input[type=range]").forEach((input) => {
    sliders[input.dataset.uniform] = parseFloat(input.value);
  });
  const stereo = {};
  document.querySelectorAll(".stereo-btn").forEach((btn) => {
    stereo[btn.dataset.stereo] = parseInt(btn.dataset.on, 10) || 0;
  });
  return { sliders, stereo, shape: currentShape };
}

function applyState(state) {
  if (!state) return;
  if (state.shape) applyShape(state.shape);
  if (state.sliders) {
    document.querySelectorAll("#tuning-panel input[type=range]").forEach((input) => {
      const uniform = input.dataset.uniform;
      const raw = (uniform in state.sliders)
        ? state.sliders[uniform]
        : parseFloat(input.defaultValue);
      input.value = raw;
      input.dispatchEvent(new Event("input")); // updates display, viz, localStorage
    });
  }
  if (state.stereo) {
    document.querySelectorAll(".stereo-btn").forEach((btn) => {
      const uniform = btn.dataset.stereo;
      const val = (uniform in state.stereo) ? state.stereo[uniform] : 0;
      setStereo(uniform, val);
    });
    localStorage.setItem(STEREO_KEY, JSON.stringify(savedStereo));
  }
}

// Five curated presets, each with a distinct visual character. Missing
// slider/stereo keys fall back to HTML defaults / mono.
const PRESETS = {
  starfield: {
    shape: "sphere",
    sliders: { cAttrCount: 2, uAttrStr: 7.5, cAttrRadius: 55 },
    stereo: { uStereoParticles: 0, fStereoFloor: 0, eStereoColor: 0 },
  },
  heart: {
    shape: "heart",
    // Single slow attractor at tight radius so the cloud wraps into the heart.
    sliders: {
      uBreatheMin: 0.35, uBreatheMax: 2.50, uBreatheCurve: 2.35,
      uSizeMin:    0.14, uSizeMax:    2.15, uSizeCurve:    3.00,
      cBurstInterval: 0.5, cRotateSpeed: 0.06,
      fMaxH: 30, fScroll: 5, fScrollBass: 22, fDecay: 0.80, fHotCurve: 2.5,
      bStrength: 0.48, bRadius: 0.25, bThreshold: 0.38,
      eCycleSpeed: 0.05, eBassHue: 0.50, eTrebleHue: 0.10, eSatReact: 0.30, eBurstHue: 0.50,
      cAttrCount: 1, uAttrStr: 6.0, cAttrRadius: 35,
    },
    stereo: { uStereoParticles: 0, fStereoFloor: 0, eStereoColor: 0 },
  },
  nebula: {
    shape: "galaxy",
    // Dreamy soft-glow cloud on a flat spiral disk: gentle breathe, slow
    // rotation, low floor, high bloom, stereo color split for cyan/pink
    // hemisphere tint across the spiral arms.
    sliders: {
      uBreatheMin: 0.55, uBreatheMax: 1.80, uBreatheCurve: 1.40,
      uSizeMin:    0.35, uSizeMax:    2.00, uSizeCurve:    1.50,
      cBurstInterval: 3.5, cRotateSpeed: 0.04,
      fMaxH: 8, fScroll: 1.5, fScrollBass: 6, fDecay: 0.92, fHotCurve: 2.0,
      bStrength: 0.50, bRadius: 0.55, bThreshold: 0.35,
      eCycleSpeed: 0.04, eBassHue: 0.30, eTrebleHue: 0.20, eSatReact: 0.50, eBurstHue: 0.25,
      cAttrCount: 1, uAttrStr: 4.5, cAttrRadius: 80,
    },
    stereo: { uStereoParticles: 0, fStereoFloor: 0, eStereoColor: 1 },
  },
  storm: {
    shape: "torus",
    // Aggressive/snappy: a spinning donut torn by 4 attractors at max strength.
    // Fast bursts, fast spin, fast bass-scroll floor, sharp decay, all stereo
    // channels engaged.
    sliders: {
      uBreatheMin: 0.40, uBreatheMax: 2.20, uBreatheCurve: 0.80,
      uSizeMin:    0.18, uSizeMax:    1.50, uSizeCurve:    2.20,
      cBurstInterval: 0.8, cRotateSpeed: 0.32,
      fMaxH: 38, fScroll: 9, fScrollBass: 55, fDecay: 0.58, fHotCurve: 4.7,
      bStrength: 0.42, bRadius: 0.30, bThreshold: 0.55,
      eCycleSpeed: 0.015, eBassHue: 0.42, eTrebleHue: 0.18, eSatReact: 0.65, eBurstHue: 0.40,
      cAttrCount: 4, uAttrStr: 14.0, cAttrRadius: 65,
    },
    stereo: { uStereoParticles: 1, fStereoFloor: 1, eStereoColor: 1 },
  },
  vapor: {
    shape: "helix",
    // Slow + deep + drifting double-helix: long burst interval, deep
    // saturation, slow color cycle, stereo floor only. Two wells at mid
    // radius pull the strands gently apart and back.
    sliders: {
      uBreatheMin: 0.30, uBreatheMax: 1.60, uBreatheCurve: 2.60,
      uSizeMin:    0.45, uSizeMax:    1.90, uSizeCurve:    2.30,
      cBurstInterval: 6.0, cRotateSpeed: 0.05,
      fMaxH: 22, fScroll: 2.5, fScrollBass: 15, fDecay: 0.90, fHotCurve: 2.2,
      bStrength: 0.42, bRadius: 0.45, bThreshold: 0.50,
      eCycleSpeed: 0.025, eBassHue: 0.45, eTrebleHue: 0.06, eSatReact: 0.38, eBurstHue: 0.42,
      cAttrCount: 2, uAttrStr: 9.0, cAttrRadius: 50,
    },
    stereo: { uStereoParticles: 0, fStereoFloor: 1, eStereoColor: 0 },
  },
};

function applyPreset(name) {
  if (PRESETS[name]) applyState(PRESETS[name]);
}

document.querySelectorAll("#tuning-panel .preset-btn").forEach((btn) => {
  btn.addEventListener("click", () => applyPreset(btn.dataset.preset));
});

// Color palettes — full visual mood swaps. Each touches base hues, the five
// color-reactivity sliders, bloom (strength/radius/threshold), and particle
// size character so palettes feel genuinely different — not just tinted.
// Stays off cloud dynamics (breathe, rotate, attractors, flow, beats) so
// you can layer any palette onto any scene preset without behavior change.
const PALETTES = {
  // Electric / sharp / 80s. Identity = brisk spin + tight flow holding the
  // shape, smallest particles. Low bloom keeps edges crisp on cube/helix.
  synthwave: {
    eInnerHue: 0.556, eOuterHue: 0.840,
    eCycleSpeed: 0.00, eBassHue: 0.10, eTrebleHue: 0.10, eSatReact: 0.25, eBurstHue: 0.44,
    bStrength: 0.395, bRadius: 0.39, bThreshold: 0.71,
    uSizeMin: 0.18, uSizeMax: 1.50, uSizeCurve: 2.80,
    cRotateSpeed: 0.18, uFlowStrength: 0.70,
  },
  // Hellfire / chaotic / fast. Identity = highest flow strength + fastest
  // spin + most frequent bursts. Bloom moderated; the chaos sells the heat.
  inferno: {
    eInnerHue: 0.10, eOuterHue: 0.97,
    eCycleSpeed: 0.02, eBassHue: 0.40, eTrebleHue: 0.18, eSatReact: 0.60, eBurstHue: 0.40,
    bStrength: 0.50, bRadius: 0.45, bThreshold: 0.40,
    uSizeMin: 0.18, uSizeMax: 1.30, uSizeCurve: 2.40,
    cRotateSpeed: 0.32, uFlowStrength: 1.80,
    uBreatheMin: 0.55, uBreatheMax: 2.20, cBurstInterval: 1.5,
  },
  // Glacial / still / crystalline. Identity = lowest flow + slowest spin +
  // rare bursts. Large soft particles, gentle breathe, minimal reactivity.
  arctic: {
    eInnerHue: 0.50, eOuterHue: 0.62,
    eCycleSpeed: 0.00, eBassHue: 0.06, eTrebleHue: 0.06, eSatReact: 0.15, eBurstHue: 0.20,
    bStrength: 0.45, bRadius: 0.55, bThreshold: 0.45,
    uSizeMin: 0.40, uSizeMax: 2.00, uSizeCurve: 1.50,
    cRotateSpeed: 0.04, uFlowStrength: 0.30,
    uBreatheMin: 0.80, uBreatheMax: 1.40, cBurstInterval: 6.0,
  },
  // Radioactive / squirming / alive. Identity = high flow + fast hue cycle
  // + max sat reactivity. Cloud writhes between greens and yellows.
  toxic: {
    eInnerHue: 0.33, eOuterHue: 0.17,
    eCycleSpeed: 0.06, eBassHue: 0.30, eTrebleHue: 0.25, eSatReact: 0.70, eBurstHue: 0.50,
    bStrength: 0.40, bRadius: 0.40, bThreshold: 0.55,
    uSizeMin: 0.22, uSizeMax: 1.50, uSizeCurve: 2.40,
    cRotateSpeed: 0.20, uFlowStrength: 2.00,
    uBreatheCurve: 0.80,
  },
  // Deep space / cosmic / drifting. Identity = slow continuous hue drift +
  // huge breathe curve (rare cosmic pulses) + slow spin. Large slow particles.
  void: {
    eInnerHue: 0.72, eOuterHue: 0.86,
    eCycleSpeed: 0.04, eBassHue: 0.45, eTrebleHue: 0.06, eSatReact: 0.40, eBurstHue: 0.30,
    bStrength: 0.48, bRadius: 0.50, bThreshold: 0.45,
    uSizeMin: 0.45, uSizeMax: 1.85, uSizeCurve: 1.80,
    cRotateSpeed: 0.06, uFlowStrength: 1.00,
    uBreatheMin: 0.45, uBreatheMax: 1.85, uBreatheCurve: 2.60, cBurstInterval: 5.0,
  },
  // Warm campfire / flickering / gentle. Identity = lowest spin + soft flow
  // + gentle breathe. Warmest bloom but moderated so amber stays visible.
  ember: {
    eInnerHue: 0.06, eOuterHue: 0.99,
    eCycleSpeed: 0.00, eBassHue: 0.15, eTrebleHue: 0.05, eSatReact: 0.20, eBurstHue: 0.30,
    bStrength: 0.55, bRadius: 0.45, bThreshold: 0.45,
    uSizeMin: 0.42, uSizeMax: 1.95, uSizeCurve: 2.00,
    cRotateSpeed: 0.06, uFlowStrength: 0.50,
    uBreatheMin: 0.65, uBreatheMax: 1.55, cBurstInterval: 5.0,
  },
};

function applyPalette(name) {
  const p = PALETTES[name];
  if (!p) return;
  for (const [uniform, value] of Object.entries(p)) {
    const input = document.querySelector(`#tuning-panel input[data-uniform="${uniform}"]`);
    if (!input) continue;
    input.value = value;
    input.dispatchEvent(new Event("input"));
  }
}

document.querySelectorAll("#tuning-panel .palette-btn").forEach((btn) => {
  btn.addEventListener("click", () => applyPalette(btn.dataset.palette));
});

// Shape selection. The visualizer drives the actual particle morph
// (smooth sphere↔target transition); this layer manages the active chip
// highlight + localStorage persistence. captureState/applyState also
// carry the shape field so presets and shared URLs restore it.
const SHAPE_KEY = "voidpulse.shape";
let currentShape = localStorage.getItem(SHAPE_KEY) || "sphere";

function applyShape(name, persist = true) {
  currentShape = name;
  viz.setShape(name);
  document.querySelectorAll(".shape-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.shape === name);
  });
  if (persist) localStorage.setItem(SHAPE_KEY, name);
}

document.querySelectorAll(".shape-btn").forEach((btn) => {
  btn.addEventListener("click", () => applyShape(btn.dataset.shape));
});

// Restore on load — if the saved shape isn't sphere, this triggers a smooth
// sphere→shape intro animation on first render.
applyShape(currentShape, false);

// User save slots: 4 chips, persisted as full state shapes in localStorage.
//   - Empty: plain click saves current state.
//   - Filled: plain click loads it. Shift+click overwrites with current.
//   - Right-click filled slot to clear it.
const SLOTS_KEY = "voidpulse.slots.v1";
const slots = JSON.parse(localStorage.getItem(SLOTS_KEY) || "{}");

function refreshSlotUI() {
  document.querySelectorAll(".slot-btn").forEach((btn) => {
    btn.classList.toggle("filled", !!slots[btn.dataset.slot]);
  });
}

document.querySelectorAll(".slot-btn").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    const id = btn.dataset.slot;
    if (slots[id] && !e.shiftKey) {
      applyState(slots[id]);
    } else {
      slots[id] = captureState();
      localStorage.setItem(SLOTS_KEY, JSON.stringify(slots));
      refreshSlotUI();
    }
  });
  btn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const id = btn.dataset.slot;
    if (slots[id]) {
      delete slots[id];
      localStorage.setItem(SLOTS_KEY, JSON.stringify(slots));
      refreshSlotUI();
    }
  });
});

refreshSlotUI();

// URL-hash sharing:
//   #presetName       → load a named preset
//   #c-<base64-json>  → load an arbitrary captured state
const shareBtn = document.getElementById("preset-share");

function loadFromHash() {
  const hash = location.hash.slice(1);
  if (!hash) return false;
  if (PRESETS[hash]) {
    applyPreset(hash);
    return true;
  }
  if (hash.startsWith("c-")) {
    try {
      applyState(JSON.parse(atob(hash.slice(2))));
      return true;
    } catch (err) {
      console.warn("[voidpulse] invalid state in URL hash:", err);
    }
  }
  return false;
}

shareBtn.addEventListener("click", () => {
  const encoded = btoa(JSON.stringify(captureState()));
  const url = `${location.origin}${location.pathname}#c-${encoded}`;
  const flash = () => {
    shareBtn.classList.add("copied");
    shareBtn.textContent = "✓ copied";
    setTimeout(() => {
      shareBtn.classList.remove("copied");
      shareBtn.textContent = "⎘ share";
    }, 1500);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(flash).catch(() => prompt("copy this URL:", url));
  } else {
    prompt("copy this URL:", url);
  }
});

window.addEventListener("hashchange", loadFromHash);
// Run after localStorage tuning/stereo init so hash takes precedence.
loadFromHash();

// Sensitivity transform: quadratic curve so the useful range (0.2–1.5)
// spans the first ~70% of the slider rather than the first 40%.
// raw 0→1 maps to displayed 0.20→3.00; default raw≈0.535 → displayed≈1.00.
function sensTform(raw) {
  return 0.2 + raw * raw * 2.8;
}

// Volume (file only) + Sensitivity (all modes) — both persist via localStorage.
const VOL_KEY  = "voidpulse.volume";
const SENS_KEY = "voidpulse.sensitivity.v2"; // v2: stores raw 0–1 position, not displayed value

const savedVol = parseFloat(localStorage.getItem(VOL_KEY));
if (!isNaN(savedVol)) { volSlider.value = savedVol; }
audio.setVolume(parseFloat(volSlider.value));
volSlider.addEventListener("input", () => {
  const v = parseFloat(volSlider.value);
  audio.setVolume(v);
  localStorage.setItem(VOL_KEY, v);
});

const savedSens = parseFloat(localStorage.getItem(SENS_KEY));
if (!isNaN(savedSens)) { sensSlider.value = savedSens; }
audio.setSensitivity(sensTform(parseFloat(sensSlider.value)));
sensSlider.addEventListener("input", () => {
  const raw = parseFloat(sensSlider.value);
  audio.setSensitivity(sensTform(raw));
  localStorage.setItem(SENS_KEY, raw);
});

// Click label to reset — same design language as tuning panel sliders.
const volLabel  = document.getElementById("vol-label");
const sensLabel = document.getElementById("sens-label");

volLabel.addEventListener("click", () => {
  volSlider.value = volSlider.defaultValue;
  audio.setVolume(parseFloat(volSlider.defaultValue));
  localStorage.removeItem(VOL_KEY);
});

sensLabel.addEventListener("click", () => {
  sensSlider.value = sensSlider.defaultValue;
  audio.setSensitivity(sensTform(parseFloat(sensSlider.defaultValue)));
  localStorage.removeItem(SENS_KEY);
});

// Zoom controls — + and − step the camera Z in increments of ZOOM_STEP. The
// visualizer lerps internally so each click eases in over ~0.5s. Percentage
// readout: 100% = closest (Z=zoomMin), 0% = farthest (Z=zoomMax).
const ZOOM_KEY = "voidpulse.zoom.v2"; // v2: stores a number, not a bool
const ZOOM_STEP = 15;

let currentZoom = parseFloat(localStorage.getItem(ZOOM_KEY));
if (!Number.isFinite(currentZoom)) currentZoom = viz.zoomDefault;
currentZoom = Math.max(viz.zoomMin, Math.min(viz.zoomMax, currentZoom));

function applyZoom() {
  viz.setZoom(currentZoom);
  const pct = Math.round(((viz.zoomMax - currentZoom) / (viz.zoomMax - viz.zoomMin)) * 100);
  zoomValue.textContent = `${pct}%`;
  zoomInBtn.disabled  = currentZoom <= viz.zoomMin;
  zoomOutBtn.disabled = currentZoom >= viz.zoomMax;
  localStorage.setItem(ZOOM_KEY, currentZoom);
}

zoomInBtn.addEventListener("click", () => {
  currentZoom = Math.max(viz.zoomMin, currentZoom - ZOOM_STEP);
  applyZoom();
});
zoomOutBtn.addEventListener("click", () => {
  currentZoom = Math.min(viz.zoomMax, currentZoom + ZOOM_STEP);
  applyZoom();
});

applyZoom();

mobileDismiss.addEventListener("click", () => { mobileNotice.hidden = true; });

helpBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  helpTooltip.hidden = !helpTooltip.hidden;
  castTooltip.hidden = true;
});
castBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  castTooltip.hidden = !castTooltip.hidden;
  helpTooltip.hidden = true;
});
document.addEventListener("click", () => {
  castTooltip.hidden = true;
  helpTooltip.hidden = true;
});

refreshUi();
requestAnimationFrame(frame);
