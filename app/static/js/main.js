import { AudioEngine } from "./audio.js";
import { Visualizer } from "./visualizer.js";

const canvas = document.getElementById("stage");
const sourcePicker = document.getElementById("source-picker");
const fileInput = document.getElementById("file-input");
const sourceLabel = document.getElementById("source-label");
const playBtn = document.getElementById("play-btn");
const stopBtn = document.getElementById("stop-btn");
const bassBar = document.getElementById("bass-bar");
const midBar = document.getElementById("mid-bar");
const trebleBar = document.getElementById("treble-bar");
const errorToast = document.getElementById("error-toast");
const mobileNotice = document.getElementById("mobile-notice");
const mobileDismiss = document.getElementById("mobile-dismiss");
const castBtn     = document.getElementById("cast-btn");
const castTooltip = document.getElementById("cast-tooltip");
const helpBtn     = document.getElementById("help-btn");
const helpTooltip = document.getElementById("help-tooltip");

const audio = new AudioEngine();
const viz = new Visualizer(canvas);

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
  if (audio.mode === "file") {
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
  viz.render(bands, audio.rawFreq(), audio.beat());
  bassBar.style.width = `${Math.min(100, bands.bass * 100).toFixed(0)}%`;
  midBar.style.width = `${Math.min(100, bands.mid * 100).toFixed(0)}%`;
  trebleBar.style.width = `${Math.min(100, bands.treble * 100).toFixed(0)}%`;
  requestAnimationFrame(frame);
}

// Tuning panel: sliders write directly to shader uniforms, values persist
// across reloads via localStorage so a good config survives a refresh.
const TUNING_KEY = "voidpulse.tuning.v1";
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

// Collapse / expand the tuning panel.
const tuningPanel  = document.getElementById("tuning-panel");
const tuningToggle = document.getElementById("tuning-toggle");
const tuningReset  = document.getElementById("tuning-reset");
const TUNING_COLLAPSED_KEY = "voidpulse.tuning.collapsed";
if (localStorage.getItem(TUNING_COLLAPSED_KEY) === "1") {
  tuningPanel.classList.add("collapsed");
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
