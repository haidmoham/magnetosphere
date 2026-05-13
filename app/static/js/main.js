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
const zoomBtn     = document.getElementById("zoom-btn");

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
const TUNING_KEY = "voidpulse.tuning.v6";
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

// ── Presets ─────────────────────────────────────────────────────────────
// Each preset is a map of slider data-uniform → raw slider value. Missing
// entries fall back to the HTML default. Starfield matches HTML defaults
// (so it's empty); heart has explicit values.
const PRESETS = {
  starfield: {},
  heart: {
    uBreatheMin:    0.35,
    uBreatheMax:    2.50,
    uBreatheCurve:  2.35,
    uSizeMin:       0.14,
    uSizeMax:       2.15,
    uSizeCurve:     3.00,
    cBurstInterval: 0.5,
    cRotateSpeed:   0.06,
    fMaxH:         30,
    fScroll:        5,
    fScrollBass:   22,
    fDecay:         0.80,
    fHotCurve:      2.5,
    bStrength:      0.48,    // raw — pow(0.48, 2.2) ≈ 0.20 displayed
    bRadius:        0.25,
    bThreshold:     0.38,
    uShapeMix:      1.0,
    eCycleSpeed:    0.05,
    eBassHue:       0.50,
    eTrebleHue:     0.10,
    eSatReact:      0.30,
    eBurstHue:      0.50,
  },
};

function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  document.querySelectorAll("#tuning-panel input[type=range]").forEach((input) => {
    const uniform = input.dataset.uniform;
    const raw = (uniform in preset) ? preset[uniform] : parseFloat(input.defaultValue);
    input.value = raw;
    // Fire the input event so all wiring (transform, display, save, viz.setTuning) runs.
    input.dispatchEvent(new Event("input"));
  });
}

document.querySelectorAll("#tuning-panel .preset-btn").forEach((btn) => {
  btn.addEventListener("click", () => applyPreset(btn.dataset.preset));
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

// Stereo toggles — three independent on/off switches for hemisphere split,
// floor split, and color divergence. Persist across reloads.
const STEREO_KEY = "voidpulse.stereo.v1";
const savedStereo = JSON.parse(localStorage.getItem(STEREO_KEY) || "{}");

document.querySelectorAll(".stereo-btn").forEach((btn) => {
  const uniform = btn.dataset.stereo;
  const restored = savedStereo[uniform] === 1 ? 1 : 0;
  btn.dataset.on = restored;
  btn.textContent = restored ? "stereo" : "mono";
  btn.classList.toggle("on", restored === 1);
  viz.setTuning(uniform, restored);

  btn.addEventListener("click", () => {
    const next = btn.dataset.on === "1" ? 0 : 1;
    btn.dataset.on = next;
    btn.textContent = next ? "stereo" : "mono";
    btn.classList.toggle("on", next === 1);
    viz.setTuning(uniform, next);
    savedStereo[uniform] = next;
    localStorage.setItem(STEREO_KEY, JSON.stringify(savedStereo));
  });
});

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

// Zoom toggle — flips camera between wide (default Z=135) and close (Z=80).
// Visualizer lerps internally so the transition is smooth.
const ZOOM_KEY = "voidpulse.zoom.v1";
let zoomedIn = localStorage.getItem(ZOOM_KEY) === "1";
function applyZoom() {
  viz.setZoom(zoomedIn);
  zoomBtn.classList.toggle("on", zoomedIn);
  zoomBtn.textContent = zoomedIn ? "⊖ close" : "⊕ wide";
}
applyZoom();
zoomBtn.addEventListener("click", () => {
  zoomedIn = !zoomedIn;
  localStorage.setItem(ZOOM_KEY, zoomedIn ? "1" : "0");
  applyZoom();
});

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
