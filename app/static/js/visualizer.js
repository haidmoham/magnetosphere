import * as THREE from "three";

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
const GRID_MAX_H     = 12;   // max vertex lift (units)

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uBass;
  uniform float uMid;
  uniform float uTreble;
  uniform float uPixelRatio;
  attribute float aSize;
  attribute vec3 aSeed;
  varying float vRadial;
  varying float vBright;

  void main() {
    float r = length(position);
    float angle = uTime * 0.04 + r * 0.012 + aSeed.x * 0.6;
    float c = cos(angle), s = sin(angle);
    vec3 pos = vec3(
      position.x * c - position.z * s,
      position.y,
      position.x * s + position.z * c
    );

    float breathe = 1.0 + uBass * 0.82;
    pos *= breathe;
    pos.y += aSeed.y * uMid   * 6.5;
    pos   += aSeed   * uTreble * 1.8;

    vRadial = clamp(r / 60.0, 0.0, 1.0);
    vBright = 0.55 + uBass * 1.05 + uTreble * 0.45;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;

    float size = aSize * (1.0 + uBass * 0.65);
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

    this._buildGrid();
    this._buildParticles();
    this.clock = new THREE.Clock();

    window.addEventListener("resize", () => this._onResize());
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

    const geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(posArr, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", posAttr);
    geo.setIndex(idxs);

    const mat = new THREE.LineBasicMaterial({
      color: 0x00f0ff,
      transparent: true,
      opacity: 0.55,
      fog: true,
    });

    const mesh = new THREE.LineSegments(geo, mat);
    mesh.position.y = -48;
    this.grid        = mesh;
    this._gridColH   = new Float32Array(GRID_COLS).fill(0); // per-column smoothed heights
    this._gridRowSpacing = rowSpacing;
    this.scene.add(mesh);
  }

  _updateGrid(freqData) {
    const pos = this.grid.geometry.attributes.position;

    if (freqData) {
      for (let col = 0; col < GRID_COLS; col++) {
        // Log-spaced bin: col 0 = bass, col GRID_COLS-1 = treble
        const t      = col / (GRID_COLS - 1);
        const binIdx = Math.max(1, Math.round(Math.pow(220, t)));
        const raw    = (freqData[binIdx] || 0) / 255;
        const target = raw * GRID_MAX_H;

        // Asymmetric smoothing: fast attack, slow decay
        const h = this._gridColH;
        h[col] = target > h[col] ? target : h[col] * 0.80 + target * 0.20;

        for (let row = 0; row < GRID_ROWS; row++) {
          // Front rows (high index, closer to camera) get full deformation;
          // back rows taper down so peaks appear to rise toward the viewer.
          const rowFade = row / (GRID_ROWS - 1);
          pos.setY(row * GRID_COLS + col, h[col] * (0.15 + 0.85 * rowFade));
        }
      }
    }

    pos.needsUpdate = true;
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
        uTime:       { value: 0 },
        uBass:       { value: 0 },
        uMid:        { value: 0 },
        uTreble:     { value: 0 },
        uPixelRatio: { value: this.renderer.getPixelRatio() },
        uColorInner: { value: new THREE.Color().setHSL(BASE_INNER_H, 1.0, 0.55) },
        uColorOuter: { value: new THREE.Color().setHSL(BASE_OUTER_H, 1.0, 0.50) },
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

  _updateColors(bands, t) {
    const cycle = (t * 0.014) % 1.0;

    const iH = (BASE_INNER_H + cycle - bands.treble * 0.06 + 1.0) % 1.0;
    const iS = 1.0 - bands.treble * 0.45;
    const iL = 0.50 + bands.treble * 0.45;

    const oH = (BASE_OUTER_H + cycle + bands.bass * 0.18) % 1.0;
    const oL = 0.45 + bands.bass * 0.42;

    this._cInner.setHSL(iH, iS, iL);
    this._cOuter.setHSL(oH, 1.0, oL);
    this._cGrid.setHSL(iH, 1.0, 0.40 + bands.bass * 0.25);
    this._cFog.setHSL(oH, 0.75, 0.06 + bands.bass * 0.05);

    this.particles.material.uniforms.uColorInner.value.copy(this._cInner);
    this.particles.material.uniforms.uColorOuter.value.copy(this._cOuter);
    this.grid.material.color.copy(this._cGrid);
    this.scene.fog.color.copy(this._cFog);
  }

  // ── Resize ───────────────────────────────────────────────────────────────

  _onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.particles.material.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
  }

  // ── Render ───────────────────────────────────────────────────────────────

  render(bands, freqData) {
    const dt = this.clock.getDelta();
    const t  = this.clock.getElapsedTime();
    const u  = this.particles.material.uniforms;

    u.uTime.value   = t;
    u.uBass.value   = bands.bass;
    u.uMid.value    = bands.mid;
    u.uTreble.value = bands.treble;

    this._updateColors(bands, t);
    this._updateGrid(freqData);

    this.particles.rotation.y += dt * (0.06 + bands.bass * 0.46);
    this.particles.rotation.x += dt * 0.018;

    // Scroll grid toward camera; loop seamlessly every row-spacing.
    this.grid.position.z =
      (this.grid.position.z + dt * (5 + bands.bass * 22)) % this._gridRowSpacing;

    this.camera.position.x = Math.sin(t * 0.08) * 13;
    this.camera.position.y = 12 + Math.cos(t * 0.06) * 2.5;
    this.camera.lookAt(0, -6, 0);

    this.renderer.render(this.scene, this.camera);
  }
}
