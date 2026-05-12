// Web Audio engine. Supports three sources:
//   - microphone           (getUserMedia, music-friendly constraints)
//   - system / tab audio   (getDisplayMedia, Chrome/Edge only)
//   - file upload          (fallback)
//
// For live sources we deliberately do NOT connect to ctx.destination —
// mic would feed back, tab audio would double-play.

const MIC_CONSTRAINTS = {
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 2,
  },
  video: false,
};

const DISPLAY_CONSTRAINTS = {
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
  // Chrome requires a video track in the picker even though we discard it.
  video: { displaySurface: "browser" },
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.source = null;
    this.mode = null; // "mic" | "system" | "file" | null
    this.audio = null;
    this.stream = null;
    this.freqData = null;
    this.label = "";
    this._smoothed = { bass: 0, mid: 0, treble: 0 };
    this._bassEnv  = 0;   // slow envelope for onset detection
    this._beat     = false;
  }

  _ensureContext() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx({ latencyHint: "interactive" });
    }
  }

  _buildAnalyser() {
    const a = this.ctx.createAnalyser();
    a.fftSize = 1024;
    a.smoothingTimeConstant = 0.78;
    this.analyser = a;
    this.freqData = new Uint8Array(a.frequencyBinCount);
  }

  async _teardownCurrent() {
    if (this.audio) {
      this.audio.pause();
      try { URL.revokeObjectURL(this.audio.src); } catch {}
      this.audio = null;
    }
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this.source) {
      try { this.source.disconnect(); } catch {}
      this.source = null;
    }
    if (this.analyser) {
      try { this.analyser.disconnect(); } catch {}
      this.analyser = null;
    }
    this.mode = null;
    this.label = "";
  }

  async useMicrophone() {
    this._ensureContext();
    await this._teardownCurrent();
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone not available in this browser.");
    }
    const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    this.stream = stream;
    this.source = this.ctx.createMediaStreamSource(stream);
    this._buildAnalyser();
    this.source.connect(this.analyser);
    // No connect to destination — would feed back.
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.mode = "mic";
    const track = stream.getAudioTracks()[0];
    this.label = track?.label || "microphone";
  }

  async useSystemAudio() {
    this._ensureContext();
    await this._teardownCurrent();
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error("System / tab audio capture not supported in this browser. Try Chrome or Edge.");
    }
    const stream = await navigator.mediaDevices.getDisplayMedia(DISPLAY_CONSTRAINTS);
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      for (const t of stream.getTracks()) t.stop();
      throw new Error("No audio in the shared source. Tick 'Share tab audio' in the picker, and share a tab (not a window).");
    }
    // Discard the video track — we only want audio.
    for (const t of stream.getVideoTracks()) t.stop();

    this.stream = stream;
    this.source = this.ctx.createMediaStreamSource(stream);
    this._buildAnalyser();
    this.source.connect(this.analyser);
    // No connect to destination — the source tab is still playing the audio out loud.

    // If the user clicks "Stop sharing" in the browser bar, drop the stream cleanly.
    audioTracks[0].addEventListener("ended", () => {
      if (this.mode === "system") this._teardownCurrent();
    });

    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.mode = "system";
    this.label = audioTracks[0].label || "tab audio";
  }

  async loadFile(file) {
    this._ensureContext();
    await this._teardownCurrent();
    const audio = new Audio();
    audio.crossOrigin = "anonymous";
    audio.src = URL.createObjectURL(file);
    this.audio = audio;
    this.source = this.ctx.createMediaElementSource(audio);
    this._buildAnalyser();
    this.source.connect(this.analyser);
    this.analyser.connect(this.ctx.destination); // file path: actually play it out
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.mode = "file";
    this.label = file.name;
  }

  async play() {
    if (this.mode === "file") await this.audio?.play();
  }

  pause() {
    if (this.mode === "file") this.audio?.pause();
  }

  isPlaying() {
    if (this.mode === "file") return !!this.audio && !this.audio.paused && !this.audio.ended;
    return this.mode === "mic" || this.mode === "system";
  }

  // Raw frequency array — call after bands() so freqData is fresh.
  rawFreq() {
    return this.freqData;
  }

  // Returns smoothed energy in [0, 1] for three bands.
  // Bin width at 44.1kHz / fftSize=1024 ≈ 43Hz.
  //   bass:   bins  1–6    (~40–260 Hz)
  //   mid:    bins  7–46   (~300 Hz–2 kHz)
  //   treble: bins 47–255  (~2 kHz–11 kHz)
  bands() {
    if (!this.analyser) return { bass: 0, mid: 0, treble: 0 };
    this.analyser.getByteFrequencyData(this.freqData);
    const bins = this.freqData;

    let bass = 0;
    for (let i = 1; i <= 6; i++) bass += bins[i];
    bass /= 6 * 255;

    let mid = 0;
    for (let i = 7; i <= 46; i++) mid += bins[i];
    mid /= 40 * 255;

    let treble = 0;
    for (let i = 47; i < 256; i++) treble += bins[i];
    treble /= 209 * 255;

    // Asymmetric smoothing: snap up fast on hits, decay slow.
    const s = this._smoothed;
    s.bass = bass > s.bass ? bass : s.bass * 0.88 + bass * 0.12;
    s.mid = mid > s.mid ? mid : s.mid * 0.82 + mid * 0.18;
    s.treble = treble > s.treble ? treble : s.treble * 0.78 + treble * 0.22;

    // Onset detection: beat fires when raw bass jumps >40% above slow envelope.
    this._bassEnv = this._bassEnv * 0.92 + bass * 0.08;
    this._beat = bass > this._bassEnv * 1.4 && bass > 0.2;

    return { bass: s.bass, mid: s.mid, treble: s.treble };
  }

  beat() { return this._beat; }
}
