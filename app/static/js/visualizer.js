import * as THREE from "three";
import { EffectComposer }  from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass }      from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass }      from "three/addons/postprocessing/OutputPass.js";

const PARTICLE_COUNT = 60000;
const COLOR_BG     = 0x08001a;
const BASE_INNER_H = 0.556;
const BASE_OUTER_H = 0.840;

// Deformable grid constants
const GRID_COLS      = 64;   // frequency bins left→right
const GRID_ROWS      = 32;   // depth slices front→back
const GRID_WIDTH     = 900;
const GRID_DEPTH     = 380;
const GRID_Z_CENTER  = -80;  // world-Z of grid midpoint
// Floor tuning defaults — overridable via the tuning panel (fMaxH, fScroll, …).
const FLOOR_DEFAULTS = {
  fMaxH:       30,    // max vertex lift (units)
  fScroll:      5,    // base scroll speed toward camera
  fScrollBass: 22,    // extra scroll speed driven by bass
  fDecay:    0.80,    // peak fall rate (lower = faster decay)
  fHotCurve:  2.5,    // white-hot bleach curve (higher = harder to bleach)
};

// Bloom defaults — UnrealBloomPass.
// bStrength is pre-transformed: slider raw 0.42 → pow(0.42, 2.2) ≈ 0.15.
const BLOOM_DEFAULTS = {
  bStrength:  0.15,
  bRadius:    0.50,
  bThreshold: 0.30,
};

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uBass;
  uniform float uMid;
  uniform float uTreble;
  uniform float uBurst;
  uniform float uEcho;
  uniform float uScatter;
  uniform float uPixelRatio;
  uniform float uBreatheMin;
  uniform float uBreatheMax;
  uniform float uBreatheCurve;
  uniform float uSizeMin;
  uniform float uSizeMax;
  uniform float uSizeCurve;
  attribute float aSize;
  attribute vec3 aSeed;
  varying float vRadial;
  varying float vBright;

  // Pseudo-curl flow field: each axis is a cross-derivative of sin-noise,
  // producing divergence-free-ish currents with no global drift.
  vec3 flowField(vec3 p, float t) {
    vec3 q = p * 0.035;
    float dx = sin(q.y * 1.4 + t * 0.22 + q.z * 0.9) - sin(q.z * 1.1 + t * 0.18);
    float dy = sin(q.z * 1.3 + t * 0.19 + q.x * 0.8) - sin(q.x * 1.2 + t * 0.23);
    float dz = sin(q.x * 1.1 + t * 0.21 + q.y * 0.7) - sin(q.y * 1.3 + t * 0.17);
    return vec3(dx, dy, dz);
  }

  void main() {
    float r = length(position);

    // Flow field displacement — scales up with mid energy
    vec3 pos = position + flowField(position, uTime) * (2.0 + uMid * 2.5);

    // Swirl rotation
    float angle = uTime * 0.04 + r * 0.012 + aSeed.x * 0.6;
    float c = cos(angle), s = sin(angle);
    pos = vec3(
      pos.x * c - pos.z * s,
      pos.y,
      pos.x * s + pos.z * c
    );

    // Non-linear breathe — uBreatheCurve > 1 means rare peaks (concentrates low bass near min)
    float bassCurved = pow(uBass, uBreatheCurve);
    float breathe = uBreatheMin + bassCurved * uBreatheMax;
    pos *= breathe;
    pos.y += aSeed.y * uMid   * 6.5;
    pos   += aSeed   * uTreble * 1.8;

    // Beat burst + echo — two radial shockwaves, echo slightly smaller
    pos += normalize(position) * (uBurst * 28.0 + uEcho * 18.0);

    // Scatter — each particle flies to its own random chaos position, then reforms
    vec3 scatterTarget = aSeed * 50.0;
    pos = mix(pos, scatterTarget, uScatter);

    vRadial = clamp(r / 60.0, 0.0, 1.0);
    vBright = 0.55 + uBass * 1.05 + uTreble * 0.45 + uBurst * 1.1 + uEcho * 0.7 + uScatter * 0.6;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;

    // Non-linear size — same curve story as breathe.
    float sizeCurved = pow(clamp(uBass, 0.0, 1.0), uSizeCurve);
    float size = aSize * (uSizeMin + sizeCurved * uSizeMax + uBurst * 0.9 + uScatter * 0.5);
    gl_PointSize = size * uPixelRatio * (220.0 / -mv.z);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColorInner;
  uniform vec3 uColorOuter;
  varying float vRadial;
  varying float vBright;

  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv);
    if (d > 0.5) discard;

    float core  = pow(1.0 - d * 2.0, 3.0);
    float halo  = pow(1.0 - d * 2.0, 1.2) * 0.35;
    vec3  col   = mix(uColorInner, uColorOuter, vRadial) * vBright;
    float alpha = core + halo;
    col += uColorInner * core * 0.5 * vBright;

    gl_FragColor = vec4(col, alpha);
  }
`;

export class Visualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.setClearColor(COLOR_BG, 1);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x1a0330, 0.0055);

    this.camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 600);
    this.camera.position.set(0, 12, 135);
    this.camera.lookAt(0, -6, 0);

    // Pre-allocated colours — zero GC per frame.
    this._cInner = new THREE.Color();
    this._cOuter = new THREE.Color();
    this._cGrid  = new THREE.Color();
    this._cFog   = new THREE.Color();

    // Cloud animation params (live-editable via setTuning, c* prefix).
    this.cBurstInterval = 2.5; // minimum seconds between bursts
    this._lastBurstT    = -Infinity;

    // Color entropy params (e* prefix).
    this.eCycleSpeed = 0.014;  // base hue drift rate (hue units/sec)
    this.eBassHue    = 0.22;   // bass energy → outer hue shift
    this.eTrebleHue  = 0.10;   // treble energy → inner hue shift
    this.eSatReact   = 0.45;   // treble → saturation + lightness reactivity
    this.eBurstHue   = 0.18;   // burst event → instant chromatic flash (inner/outer diverge)

    // Floor tuning (live-editable via setTuning).
    Object.assign(this, FLOOR_DEFAULTS);

    this._buildGrid();
    this._buildParticles();
    this._buildComposer();
    this.clock = new THREE.Clock();

    window.addEventListener("resize", () => this._onResize());
  }

  // ── Post-processing ─────────────────────────────────────────────────────
  _buildComposer() {
    const w = window.innerWidth, h = window.innerHeight;
    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.composer.setSize(w, h);

    this.composer.addPass(new RenderPass(this.scene, this.camera));

    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(w, h),
      BLOOM_DEFAULTS.bStrength,
      BLOOM_DEFAULTS.bRadius,
      BLOOM_DEFAULTS.bThreshold,
    );
    this.composer.addPass(this.bloom);

    // sRGB conversion + tonemap.
    this.composer.addPass(new OutputPass());
  }

  // ── Deformable grid ──────────────────────────────────────────────────────
  // Custom LineSegments in the XZ plane. Vertex Y is updated each frame
  // from FFT data — each column of vertices maps to one frequency bin.

  _buildGrid() {
    const vertCount = GRID_COLS * GRID_ROWS;
    const posArr    = new Float32Array(vertCount * 3);
    const rowSpacing = GRID_DEPTH / (GRID_ROWS - 1);

    for (let row = 0; row < GRID_ROWS; row++) {
      for (let col = 0; col < GRID_COLS; col++) {
        const i = (row * GRID_COLS + col) * 3;
        posArr[i]     = (col / (GRID_COLS - 1) - 0.5) * GRID_WIDTH;
        posArr[i + 1] = 0; // Y = height, mutated per frame
        posArr[i + 2] = (row / (GRID_ROWS - 1) - 0.5) * GRID_DEPTH + GRID_Z_CENTER;
      }
    }

    // Line index pairs — horizontal runs + vertical runs, no diagonals.
    const idxs = [];
    for (let row = 0; row < GRID_ROWS; row++)
      for (let col = 0; col < GRID_COLS - 1; col++)
        idxs.push(row * GRID_COLS + col, row * GRID_COLS + col + 1);
    for (let col = 0; col < GRID_COLS; col++)
      for (let row = 0; row < GRID_ROWS - 1; row++)
        idxs.push(row * GRID_COLS + col, (row + 1) * GRID_COLS + col);

    // Colour buffer — dark violet at rest, driven to magenta/cyan/white on peaks.
    const colArr  = new Float32Array(vertCount * 3);
    for (let i = 0; i < vertCount; i++) {
      colArr[i * 3]     = 0.06;
      colArr[i * 3 + 1] = 0.02;
      colArr[i * 3 + 2] = 0.18;
    }

    const geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(posArr, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    const colAttr = new THREE.BufferAttribute(colArr, 3);
    colAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", posAttr);
    geo.setAttribute("color",    colAttr);
    geo.setIndex(idxs);

    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      fog: true,
    });

    const mesh = new THREE.LineSegments(geo, mat);
    mesh.position.y = -48;
    this.grid            = mesh;
    this._gridColH       = new Float32Array(GRID_COLS).fill(0);
    this._gridRowSpacing = rowSpacing;
    this.scene.add(mesh);
  }

  _updateGrid(freqData) {
    const pos = this.grid.geometry.attributes.position;
    const col = this.grid.geometry.attributes.color;

    if (freqData) {
      const maxH     = this.fMaxH;
      const decay    = this.fDecay;
      const attack   = 1 - decay;
      const hotCurve = this.fHotCurve;

      for (let c = 0; c < GRID_COLS; c++) {
        const t      = c / (GRID_COLS - 1);          // 0=bass … 1=treble
        const binIdx = Math.max(1, Math.round(Math.pow(220, t)));
        const raw    = (freqData[binIdx] || 0) / 255;
        const target = raw * maxH;

        const h = this._gridColH;
        h[c] = target > h[c] ? target : h[c] * decay + target * attack;

        // Peak colour: magenta at bass end, cyan at treble end.
        const pr = 1.00 - t * 1.00;  // R: 1→0
        const pg = 0.24 + t * 0.70;  // G: 0.24→0.94
        const pb = 0.94 + t * 0.06;  // B: 0.94→1.00

        for (let r = 0; r < GRID_ROWS; r++) {
          const rowFade = r / (GRID_ROWS - 1);
          const vertH   = h[c] * (0.15 + 0.85 * rowFade);
          pos.setY(r * GRID_COLS + c, vertH);

          // Normalised height drives colour from base → peak → white-hot.
          const nH      = vertH / maxH;
          const white   = Math.pow(nH, hotCurve);      // higher curve = harder to bleach
          const fr = 0.06 + (pr + (1.0 - pr) * white - 0.06) * nH;
          const fg = 0.02 + (pg + (1.0 - pg) * white - 0.02) * nH;
          const fb = 0.18 + (pb + (1.0 - pb) * white - 0.18) * nH;

          col.setXYZ(r * GRID_COLS + c, fr, fg, fb);
        }
      }
    }

    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  // ── Particles ────────────────────────────────────────────────────────────

  _buildParticles() {
    const geo       = new THREE.BufferGeometry();
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const sizes     = new Float32Array(PARTICLE_COUNT);
    const seeds     = new Float32Array(PARTICLE_COUNT * 3);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const u      = Math.random();
      const radius = 25 + Math.pow(u, 0.6) * 30;
      const theta  = Math.random() * Math.PI * 2;
      const phi    = Math.acos(2 * Math.random() - 1);
      const sinPhi = Math.sin(phi);

      positions[i * 3]     = radius * sinPhi * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.cos(phi);
      positions[i * 3 + 2] = radius * sinPhi * Math.sin(theta);

      sizes[i]         = 0.8 + Math.random() * 2.4;
      seeds[i * 3]     = (Math.random() - 0.5) * 2;
      seeds[i * 3 + 1] = (Math.random() - 0.5) * 2;
      seeds[i * 3 + 2] = (Math.random() - 0.5) * 2;
    }

    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aSize",    new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute("aSeed",    new THREE.BufferAttribute(seeds, 3));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime:         { value: 0 },
        uBass:         { value: 0 },
        uMid:          { value: 0 },
        uTreble:       { value: 0 },
        uBurst:        { value: 0 },
        uEcho:         { value: 0 },
        uScatter:      { value: 0 },
        uPixelRatio:   { value: this.renderer.getPixelRatio() },
        uColorInner:   { value: new THREE.Color().setHSL(BASE_INNER_H, 1.0, 0.55) },
        uColorOuter:   { value: new THREE.Color().setHSL(BASE_OUTER_H, 1.0, 0.50) },
        uBreatheMin:   { value: 0.35 },
        uBreatheMax:   { value: 1.70 },
        uBreatheCurve: { value: 2.35 },
        uSizeMin:      { value: 0.14 },
        uSizeMax:      { value: 1.60 },
        uSizeCurve:    { value: 3.00 },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
    });

    this.particles = new THREE.Points(geo, mat);
    this.scene.add(this.particles);
  }

  // ── Colours ──────────────────────────────────────────────────────────────

  _updateColors(bands, t, burst) {
    const cycle = (t * this.eCycleSpeed) % 1.0;

    // On a burst: inner and outer hues diverge in opposite directions,
    // creating a chromatic flash that decays with the burst envelope.
    const burstShift = burst * this.eBurstHue;

    const iH = (BASE_INNER_H + cycle - bands.treble * this.eTrebleHue - burstShift + 1.0) % 1.0;
    const iS = 1.0 - bands.treble * this.eSatReact;
    const iL = 0.50 + bands.treble * this.eSatReact;

    const oH = (BASE_OUTER_H + cycle + bands.bass * this.eBassHue + burstShift) % 1.0;
    const oL = 0.45 + bands.bass * 0.42;

    this._cInner.setHSL(iH, iS, iL);
    this._cOuter.setHSL(oH, 1.0, oL);
    this._cFog.setHSL(oH, 0.75, 0.06 + bands.bass * 0.05);

    this.particles.material.uniforms.uColorInner.value.copy(this._cInner);
    this.particles.material.uniforms.uColorOuter.value.copy(this._cOuter);
    this.scene.fog.color.copy(this._cFog);
  }

  // ── Resize ───────────────────────────────────────────────────────────────

  _onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.particles.material.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
    if (this.composer) this.composer.setSize(w, h);
    if (this.bloom)    this.bloom.setSize(w, h);
  }

  // ── Render ───────────────────────────────────────────────────────────────

  render(bands, freqData, beat) {
    const dt = this.clock.getDelta();
    const t  = this.clock.getElapsedTime();
    const u  = this.particles.material.uniforms;

    u.uTime.value   = t;
    u.uBass.value   = bands.bass;
    u.uMid.value    = bands.mid;
    u.uTreble.value = bands.treble;

    // Beat burst: fast radial punch, echo 200ms later, scatter: reform ~1.5s
    // Cooldown: don't re-trigger while still reforming from last beat
    if (beat && (t - this._lastBurstT) > this.cBurstInterval && u.uScatter.value < 0.06) {
      this._lastBurstT = t;
      u.uBurst.value   = 1.0;
      u.uScatter.value = 1.0;
      clearTimeout(this._echoTimer);
      this._echoTimer = setTimeout(() => { u.uEcho.value = 0.7; }, 200);
    }
    u.uBurst.value   *= 0.82;
    u.uEcho.value    *= 0.82;
    u.uScatter.value *= 0.945;

    this._updateColors(bands, t, u.uBurst.value);
    this._updateGrid(freqData);

    this.particles.rotation.y += dt * (0.06 + bands.bass * 0.46);
    this.particles.rotation.x += dt * 0.018;

    // Scroll grid toward camera; loop seamlessly every row-spacing.
    this.grid.position.z =
      (this.grid.position.z + dt * (this.fScroll + bands.bass * this.fScrollBass)) % this._gridRowSpacing;

    this.camera.position.x = Math.sin(t * 0.08) * 13;
    this.camera.position.y = 12 + Math.cos(t * 0.06) * 2.5;
    this.camera.lookAt(0, -6, 0);

    this.composer.render();
  }

  // Live-tuning hook for the debug panel.
  //   uX → shader uniform on the particle material
  //   fX → instance property used by the floor (grid) update
  //   bX → property on the UnrealBloomPass
  setTuning(name, value) {
    if (name.startsWith("u")) {
      const u = this.particles.material.uniforms;
      if (u[name]) u[name].value = value;
    } else if (name.startsWith("f") || name.startsWith("c") || name.startsWith("e")) {
      if (name in this) this[name] = value;
    } else if (name.startsWith("b") && this.bloom) {
      const map = { bStrength: "strength", bRadius: "radius", bThreshold: "threshold" };
      const k = map[name];
      if (k) this.bloom[k] = value;
    }
  }
}
