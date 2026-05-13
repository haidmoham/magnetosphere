import * as THREE from "three";
import { EffectComposer }  from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass }      from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass }      from "three/addons/postprocessing/OutputPass.js";

const PARTICLE_COUNT = 60000;
const COLOR_BG     = 0x08001a;
const BASE_INNER_H = 0.556;
const BASE_OUTER_H = 0.840;

// Deformable grid constants. Depth & center are tuned so the front edge sits
// just behind the camera (Z=+300) at max zoom out (camera Z=250) — eliminates
// the black band that used to appear below the floor when zoomed all the way
// out. ROWS bumps proportionally so row spacing stays at ~12 units (preserves
// the original scroll cadence).
const GRID_COLS      = 64;   // frequency bins left→right
const GRID_ROWS      = 46;   // depth slices front→back
const GRID_WIDTH     = 900;
const GRID_DEPTH     = 560;
const GRID_Z_CENTER  = 20;   // world-Z of grid midpoint (front edge = +300)
// Floor tuning defaults — overridable via the tuning panel (fMaxH, fScroll, …).
const FLOOR_DEFAULTS = {
  fMaxH:       30,    // max vertex lift (units)
  fScroll:      5,    // base scroll speed toward camera
  fScrollBass: 22,    // extra scroll speed driven by bass
  fDecay:    0.80,    // peak fall rate (lower = faster decay)
  fHotCurve:  2.5,    // white-hot bleach curve (higher = harder to bleach)
};

// Bloom defaults — UnrealBloomPass.
// bStrength is pre-transformed: slider raw 0.395 → pow(0.395, 2.2) ≈ 0.13.
const BLOOM_DEFAULTS = {
  bStrength:  0.13,
  bRadius:    0.39,
  bThreshold: 0.71,
};

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uBass;
  uniform float uMid;
  uniform float uTreble;
  // Per-channel bands — used when uStereoParticles > 0 to drive the left
  // hemisphere of the cloud from the L channel and right from R.
  uniform float uBassL;
  uniform float uMidL;
  uniform float uTrebleL;
  uniform float uBassR;
  uniform float uMidR;
  uniform float uTrebleR;
  uniform float uStereoParticles;  // 0 = mono, 1 = full L/R hemisphere split
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
  uniform float uShapeMix;
  uniform float uFlowStrength;   // tuning panel multiplier for flow amplitude
  attribute float aSize;
  attribute float aLayer;        // 0 = inner shell, 1 = outer shell
  attribute vec3 aSeed;
  attribute vec3 aPositionTarget;
  varying float vRadial;
  varying float vBright;

  // 2-octave analytic-curl flow field — divergence-free-ish swirling currents.
  // Oct 1: large-scale organic drift. Oct 2: finer turbulence, faster evolution.
  vec3 curlFlow(vec3 p, float t) {
    vec3 q = p * 0.030;
    float dx = sin(q.y * 1.4 + t * 0.19 + q.z * 0.9) - sin(q.z * 1.1 + t * 0.15 + q.x * 0.7);
    float dy = sin(q.z * 1.3 + t * 0.17 + q.x * 0.8) - sin(q.x * 1.2 + t * 0.21 + q.y * 0.6);
    float dz = sin(q.x * 1.1 + t * 0.20 + q.y * 0.7) - sin(q.y * 1.3 + t * 0.16 + q.z * 0.8);
    vec3 q2 = p * 0.075;
    float dx2 = sin(q2.y * 1.2 + t * 0.43 + q2.z) - sin(q2.z * 0.9 + t * 0.38 + q2.x);
    float dy2 = sin(q2.z * 1.1 + t * 0.40 + q2.x) - sin(q2.x * 1.0 + t * 0.45 + q2.y);
    float dz2 = sin(q2.x * 0.9 + t * 0.41 + q2.y) - sin(q2.y * 1.1 + t * 0.36 + q2.z);
    return vec3(dx + dx2 * 0.40, dy + dy2 * 0.40, dz + dz2 * 0.40);
  }

  void main() {
    // Morph between base shapes (sphere ↔ heart, etc).
    vec3 basePos = mix(position, aPositionTarget, uShapeMix);
    float r = length(basePos);

    // Per-particle band values: blend mono with the channel matching this
    // particle's hemisphere (sign of basePos.x). At uStereoParticles=0 every
    // particle sees the mono bands; at 1.0 the left hemisphere reacts purely
    // to L, the right to R.
    float side = step(0.0, basePos.x); // 0 if left, 1 if right
    float bassChan   = mix(uBassL,   uBassR,   side);
    float midChan    = mix(uMidL,    uMidR,    side);
    float trebleChan = mix(uTrebleL, uTrebleR, side);
    float bassP   = mix(uBass,   bassChan,   uStereoParticles);
    float midP    = mix(uMid,    midChan,    uStereoParticles);
    float trebleP = mix(uTreble, trebleChan, uStereoParticles);

    // 2-octave curl flow — outer shell (aLayer=1) rides the field harder
    float flowAmp = (2.0 + midP * 2.5) * (1.0 + aLayer * 0.65) * uFlowStrength;
    vec3 pos = basePos + curlFlow(basePos, uTime) * flowAmp;

    // Swirl rotation — outer shell orbits fractionally faster
    float angle = uTime * (0.04 + aLayer * 0.016) + r * 0.012 + aSeed.x * 0.6;
    float c = cos(angle), s = sin(angle);
    pos = vec3(
      pos.x * c - pos.z * s,
      pos.y,
      pos.x * s + pos.z * c
    );

    // Non-linear breathe — uBreatheCurve > 1 means rare peaks (concentrates low bass near min)
    float bassCurved = pow(bassP, uBreatheCurve);
    float breathe = uBreatheMin + bassCurved * uBreatheMax;
    pos *= breathe;
    pos.y += aSeed.y * midP    * 6.5;
    pos   += aSeed   * trebleP * 1.8;

    // Beat burst + echo — two radial shockwaves, echo slightly smaller
    pos += normalize(basePos) * (uBurst * 28.0 + uEcho * 18.0);

    // Scatter — each particle flies to its own random chaos position, then reforms
    vec3 scatterTarget = aSeed * 50.0;
    pos = mix(pos, scatterTarget, uScatter);

    // Outer shell biased toward the outer (hot) color
    vRadial = clamp(r / 60.0 + aLayer * 0.18, 0.0, 1.0);
    vBright = 0.55 + bassP * 1.05 + trebleP * 0.45 + uBurst * 1.1 + uEcho * 0.7 + uScatter * 0.6;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;

    // Non-linear size — same curve story as breathe.
    float sizeCurved = pow(clamp(bassP, 0.0, 1.0), uSizeCurve);
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

    // Zoom — _zoomTarget is the desired camera Z, _zoomCurrent lerps toward
    // it each frame for a smooth ~0.5s ease. Bounds are clamps used by setZoom.
    this._zoomMin     = 50;
    this._zoomMax     = 250;
    this._zoomDefault = 135;
    this._zoomCurrent = 135;
    this._zoomTarget  = 135;

    // Pre-allocated colours — zero GC per frame.
    this._cInner = new THREE.Color();
    this._cOuter = new THREE.Color();
    this._cGrid  = new THREE.Color();
    this._cFog   = new THREE.Color();

    // Cloud animation params (live-editable via setTuning, c* prefix).
    this.cBurstInterval = 5.0; // minimum seconds between bursts
    this.cRotateSpeed   = 0.14; // base Y-axis spin rate (rad/s)
    this._lastBurstT    = -Infinity;

    // Color entropy params (e* prefix).
    this.eCycleSpeed = 0.00;   // base hue drift rate (hue units/sec)
    this.eBassHue    = 0.10;   // bass energy → outer hue shift
    this.eTrebleHue  = 0.10;   // treble energy → inner hue shift
    this.eSatReact   = 0.25;   // treble → saturation + lightness reactivity
    this.eBurstHue   = 0.44;   // burst event → instant chromatic flash (inner/outer diverge)
    this.eStereoColor = 0;     // 0 = mono, 1 = inner reacts to L / outer to R

    // Floor tuning (live-editable via setTuning).
    Object.assign(this, FLOOR_DEFAULTS);
    this.fStereoFloor = 0;     // 0 = mono, 1 = left grid half = L / right = R

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
    mesh.position.y   = -48;
    mesh.renderOrder  = -1;
    mat.depthWrite    = false;
    this.grid            = mesh;
    this._gridColH       = new Float32Array(GRID_COLS).fill(0);
    this._gridRowSpacing = rowSpacing;
    this.scene.add(mesh);
  }

  _updateGrid(freqData, freqDataL, freqDataR) {
    const pos = this.grid.geometry.attributes.position;
    const col = this.grid.geometry.attributes.color;

    if (freqData) {
      const maxH     = this.fMaxH;
      const decay    = this.fDecay;
      const attack   = 1 - decay;
      const hotCurve = this.fHotCurve;
      const stereo   = this.fStereoFloor;
      const halfCol  = (GRID_COLS - 1) / 2;

      for (let c = 0; c < GRID_COLS; c++) {
        const t      = c / (GRID_COLS - 1);          // 0=bass … 1=treble
        const binIdx = Math.max(1, Math.round(Math.pow(220, t)));
        // Pick stereo channel by column position (left half = L, right = R).
        const channelData = c < halfCol ? freqDataL : freqDataR;
        const monoVal     = (freqData[binIdx]   || 0) / 255;
        const chanVal     = channelData
          ? (channelData[binIdx] || 0) / 255
          : monoVal;
        const raw    = monoVal * (1 - stereo) + chanVal * stereo;
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

  // Sphere shell between rMin and rMax, weighted toward the outer edge.
  _sampleSphereRange(n, rMin, rMax) {
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u      = Math.random();
      const radius = rMin + Math.pow(u, 0.6) * (rMax - rMin);
      const theta  = Math.random() * Math.PI * 2;
      const phi    = Math.acos(2 * Math.random() - 1);
      const sinPhi = Math.sin(phi);
      out[i * 3]     = radius * sinPhi * Math.cos(theta);
      out[i * 3 + 1] = radius * Math.cos(phi);
      out[i * 3 + 2] = radius * sinPhi * Math.sin(theta);
    }
    return out;
  }

  // Heart: 2D implicit heart curve  (x² + y² − 1)³ − k·x²y³ = 0  extruded into Z.
  // k > 1 deepens the top cleft and sharpens the bottom point. Cleft at y = +1,
  // point at y ≈ −1, lobes spread along ±x. A puffy z-thickness gives it 3D depth.
  // scale controls size — inner shell uses a tighter heart, outer uses a larger one.
  _sampleHeart(n, scale = 36) {
    const out   = new Float32Array(n * 3);
    const k     = 1.55;   // cleft / point sharpness
    let i = 0;
    while (i < n) {
      const x = (Math.random() - 0.5) * 2.6;
      const y = (Math.random() - 0.5) * 2.6;
      const a = x * x + y * y - 1;
      const f = a * a * a - k * x * x * y * y * y;
      if (f >= 0) continue;
      // Puffy 3D thickness — scales with how deep inside the 2D heart we are.
      const thick = 0.55 * Math.sqrt(Math.max(0, -f / 0.4));
      const z     = (Math.random() * 2 - 1) * Math.min(thick, 0.7);
      out[i * 3]     = x * scale;            // world X = heart X (width / lobe axis)
      out[i * 3 + 1] = y * scale;            // world Y = heart Y (cleft up, point down)
      out[i * 3 + 2] = z * scale;            // world Z = thickness
      i++;
    }
    return out;
  }

  _buildParticles() {
    // Two concentric shells: inner (bass-anchored core) + outer (flow-driven envelope).
    // Inner: 55% of particles, radii 18–36. Outer: 45%, radii 44–66.
    const INNER = Math.floor(PARTICLE_COUNT * 0.55);
    const OUTER = PARTICLE_COUNT - INNER;

    const innerPos = this._sampleSphereRange(INNER, 18, 36);
    const outerPos = this._sampleSphereRange(OUTER, 44, 66);
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    positions.set(innerPos, 0);
    positions.set(outerPos, INNER * 3);

    // Heart targets: inner shell morphs to a tighter heart, outer to a larger one.
    const innerTgt = this._sampleHeart(INNER, 26);
    const outerTgt = this._sampleHeart(OUTER, 46);
    const targets  = new Float32Array(PARTICLE_COUNT * 3);
    targets.set(innerTgt, 0);
    targets.set(outerTgt, INNER * 3);

    const geo    = new THREE.BufferGeometry();
    const sizes  = new Float32Array(PARTICLE_COUNT);
    const seeds  = new Float32Array(PARTICLE_COUNT * 3);
    const layers = new Float32Array(PARTICLE_COUNT);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      sizes[i]         = 0.8 + Math.random() * 2.4;
      seeds[i * 3]     = (Math.random() - 0.5) * 2;
      seeds[i * 3 + 1] = (Math.random() - 0.5) * 2;
      seeds[i * 3 + 2] = (Math.random() - 0.5) * 2;
      layers[i]        = i < INNER ? 0.0 : 1.0;
    }

    geo.setAttribute("position",        new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aPositionTarget", new THREE.BufferAttribute(targets,   3));
    geo.setAttribute("aSize",           new THREE.BufferAttribute(sizes,     1));
    geo.setAttribute("aSeed",           new THREE.BufferAttribute(seeds,     3));
    geo.setAttribute("aLayer",          new THREE.BufferAttribute(layers,    1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime:         { value: 0 },
        uBass:         { value: 0 },
        uMid:          { value: 0 },
        uTreble:       { value: 0 },
        uBassL:        { value: 0 },
        uMidL:         { value: 0 },
        uTrebleL:      { value: 0 },
        uBassR:        { value: 0 },
        uMidR:         { value: 0 },
        uTrebleR:      { value: 0 },
        uStereoParticles: { value: 0 },
        uBurst:        { value: 0 },
        uEcho:         { value: 0 },
        uScatter:      { value: 0 },
        uPixelRatio:   { value: this.renderer.getPixelRatio() },
        uColorInner:   { value: new THREE.Color().setHSL(BASE_INNER_H, 1.0, 0.55) },
        uColorOuter:   { value: new THREE.Color().setHSL(BASE_OUTER_H, 1.0, 0.50) },
        uBreatheMin:   { value: 1.16 },
        uBreatheMax:   { value: 1.71 },
        uBreatheCurve: { value: 0.35 },
        uSizeMin:      { value: 0.24 },
        uSizeMax:      { value: 1.72 },
        uSizeCurve:    { value: 2.65 },
        uShapeMix:     { value: 0.29 },   // 0 = sphere, 1 = heart
        uFlowStrength: { value: 1.0  },   // curl-noise amplitude multiplier
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

  _updateColors(bands, bandsL, bandsR, t, burst) {
    const cycle = (t * this.eCycleSpeed) % 1.0;

    // On a burst: inner and outer hues diverge in opposite directions,
    // creating a chromatic flash that decays with the burst envelope.
    const burstShift = burst * this.eBurstHue;

    // Stereo divergence — at eStereoColor=1, the inner color reacts purely to
    // L and the outer purely to R, so panning splits the palette.
    const stereo    = this.eStereoColor;
    const innerBass   = bands.bass   * (1 - stereo) + (bandsL ? bandsL.bass   : bands.bass)   * stereo;
    const innerTreble = bands.treble * (1 - stereo) + (bandsL ? bandsL.treble : bands.treble) * stereo;
    const outerBass   = bands.bass   * (1 - stereo) + (bandsR ? bandsR.bass   : bands.bass)   * stereo;

    const iH = (BASE_INNER_H + cycle - innerTreble * this.eTrebleHue - burstShift + 1.0) % 1.0;
    const iS = 1.0 - innerTreble * this.eSatReact;
    const iL = 0.50 + innerTreble * this.eSatReact;

    const oH = (BASE_OUTER_H + cycle + outerBass * this.eBassHue + burstShift) % 1.0;
    const oL = 0.45 + outerBass * 0.42;

    this._cInner.setHSL(iH, iS, iL);
    this._cOuter.setHSL(oH, 1.0, oL);
    this._cFog.setHSL(oH, 0.75, 0.06 + outerBass * 0.05);

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

  render(bands, freqData, beat, stereo) {
    const dt = this.clock.getDelta();
    const t  = this.clock.getElapsedTime();
    const u  = this.particles.material.uniforms;

    const bandsL    = stereo?.bandsL    || bands;
    const bandsR    = stereo?.bandsR    || bands;
    const freqDataL = stereo?.freqDataL || freqData;
    const freqDataR = stereo?.freqDataR || freqData;

    u.uTime.value    = t;
    u.uBass.value    = bands.bass;
    u.uMid.value     = bands.mid;
    u.uTreble.value  = bands.treble;
    u.uBassL.value   = bandsL.bass;
    u.uMidL.value    = bandsL.mid;
    u.uTrebleL.value = bandsL.treble;
    u.uBassR.value   = bandsR.bass;
    u.uMidR.value    = bandsR.mid;
    u.uTrebleR.value = bandsR.treble;

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

    this._updateColors(bands, bandsL, bandsR, t, u.uBurst.value);
    this._updateGrid(freqData, freqDataL, freqDataR);

    // Y-axis spin (podium rotation). Bass speeds it up.
    this.particles.rotation.y += dt * (this.cRotateSpeed + bands.bass * 0.46);
    // X-axis tumble — only active for sphere mode. When morphed toward heart,
    // accumulation is gated and any existing tilt damps back to upright.
    const shapeMix = u.uShapeMix.value;
    this.particles.rotation.x += dt * 0.018 * (1 - shapeMix);
    this.particles.rotation.x *= 1 - shapeMix * dt * 2.5;

    // Scroll grid toward camera; loop seamlessly every row-spacing.
    this.grid.position.z =
      (this.grid.position.z + dt * (this.fScroll + bands.bass * this.fScrollBass)) % this._gridRowSpacing;

    this.camera.position.x = 0;
    this.camera.position.y = 12 + Math.cos(t * 0.06) * 2.5;
    this._zoomCurrent += (this._zoomTarget - this._zoomCurrent) * 0.06;
    this.camera.position.z = this._zoomCurrent;
    this.camera.lookAt(0, -6, 0);

    this.composer.render();
  }

  // Zoom — set the target camera Z (any number, clamped to [zoomMin, zoomMax]).
  // The render loop lerps _zoomCurrent toward _zoomTarget for smooth transitions.
  setZoom(z) {
    this._zoomTarget = Math.max(this._zoomMin, Math.min(this._zoomMax, z));
  }
  get zoomMin()     { return this._zoomMin; }
  get zoomMax()     { return this._zoomMax; }
  get zoomDefault() { return this._zoomDefault; }
  get zoomTarget()  { return this._zoomTarget; }

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
