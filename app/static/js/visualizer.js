import * as THREE from "three";

const PARTICLE_COUNT = 60000;
const COLOR_BG       = 0x08001a;
const BASE_INNER_H   = 0.556; // ~200° cyan
const BASE_OUTER_H   = 0.840; // ~302° hot-pink

// Frequency bar layout
const BAR_COLS = 18;
const BAR_ROWS = 3;
const BAR_COUNT = BAR_COLS * BAR_ROWS;
const BAR_Z_POSITIONS = [-45, -85, -130]; // recede toward horizon
const BAR_MAX_HEIGHT  = 5.5;              // small — floor stays a floor

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

    // More dramatic: deeper radial breathing and displacement
    float breathe = 1.0 + uBass * 0.82;
    pos *= breathe;
    pos.y += aSeed.y * uMid  * 6.5;
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

    float core = pow(1.0 - d * 2.0, 3.0);
    float halo = pow(1.0 - d * 2.0, 1.2) * 0.35;

    vec3 col   = mix(uColorInner, uColorOuter, vRadial) * vBright;
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

    this.camera = new THREE.PerspectiveCamera(
      62,
      window.innerWidth / window.innerHeight,
      0.1,
      600,
    );
    this.camera.position.set(0, 12, 135);
    this.camera.lookAt(0, -6, 0);

    // Pre-allocated colours — updated in-place each frame, zero GC.
    this._cInner = new THREE.Color();
    this._cOuter = new THREE.Color();
    this._cGrid  = new THREE.Color();
    this._cFog   = new THREE.Color();
    this._cTmp   = new THREE.Color(); // scratch for bar lerp

    this._buildGrid();
    this._buildParticles();
    this._buildFreqBars();
    this.clock = new THREE.Clock();

    window.addEventListener("resize", () => this._onResize());
  }

  // ── Grid ────────────────────────────────────────────────────────────────

  _buildGrid() {
    const grid = new THREE.GridHelper(900, 60);
    grid.material = new THREE.LineBasicMaterial({
      color: 0x00f0ff,
      transparent: true,
      opacity: 0.5,
      fog: true,
    });
    grid.position.y = -48;
    this.grid = grid;
    this.scene.add(grid);
  }

  // ── Frequency peak bars ──────────────────────────────────────────────────
  // Small instanced columns distributed across the floor.
  // Each maps to a log-spaced frequency bin so every range of the spectrum
  // drives a distinct region of the floor.

  _buildFreqBars() {
    // Unit box with pivot at base (not centre) so it scales upward.
    const geo = new THREE.BoxGeometry(0.5, 1, 0.5);
    geo.translate(0, 0.5, 0);

    // color:white so instanceColor values are applied directly (not multiplied by a tint).
    // vertexColors must be false — BoxGeometry has no color attribute and it breaks instancing.
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const mesh = new THREE.InstancedMesh(geo, mat, BAR_COUNT);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const dummy = new THREE.Object3D();
    this._barPositions = [];

    for (let i = 0; i < BAR_COUNT; i++) {
      const col = i % BAR_COLS;
      const row = Math.floor(i / BAR_COLS);
      const x   = (col / (BAR_COLS - 1) - 0.5) * 130;
      const z   = BAR_Z_POSITIONS[row];

      dummy.position.set(x, -48, z);
      dummy.scale.set(1, 0.05, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, new THREE.Color(0x00f0ff));
      this._barPositions.push({ x, z });
    }

    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate  = true;

    this._barMesh    = mesh;
    this._barHeights = new Float32Array(BAR_COUNT).fill(0.05);
    this._barDummy   = dummy;
    this.scene.add(mesh);
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

  // ── Colour update ────────────────────────────────────────────────────────

  _updateColors(bands, t) {
    const cycle = (t * 0.014) % 1.0;

    const iH = (BASE_INNER_H + cycle - bands.treble * 0.06 + 1.0) % 1.0;
    const iS = 1.0 - bands.treble * 0.45;
    const iL = 0.50 + bands.treble * 0.45;

    const oH = (BASE_OUTER_H + cycle + bands.bass * 0.18) % 1.0;
    const oS = 1.0;
    const oL = 0.45 + bands.bass * 0.42;

    this._cInner.setHSL(iH, iS, iL);
    this._cOuter.setHSL(oH, oS, oL);
    this._cGrid.setHSL(iH, 1.0, 0.40 + bands.bass * 0.25);
    this._cFog.setHSL(oH, 0.75, 0.06 + bands.bass * 0.05);

    this.particles.material.uniforms.uColorInner.value.copy(this._cInner);
    this.particles.material.uniforms.uColorOuter.value.copy(this._cOuter);
    this.grid.material.color.copy(this._cGrid);
    this.scene.fog.color.copy(this._cFog);
  }

  // ── Frequency bar update ─────────────────────────────────────────────────

  _updateFreqBars(freqData) {
    if (!freqData) return;

    const dummy = this._barDummy;

    for (let i = 0; i < BAR_COUNT; i++) {
      // Log-spaced bin sampling: maps i=0 → low freq, i=BAR_COUNT-1 → high.
      const t      = i / (BAR_COUNT - 1);
      const binIdx = Math.max(1, Math.round(Math.pow(220, t)));
      const raw    = (freqData[binIdx] || 0) / 255;

      // Asymmetric smoothing: snap up on attack, slow decay.
      const target = raw * BAR_MAX_HEIGHT;
      this._barHeights[i] = target > this._barHeights[i]
        ? target
        : this._barHeights[i] * 0.80 + target * 0.20;

      const h   = Math.max(0.35, this._barHeights[i]);
      const pos = this._barPositions[i];

      dummy.position.set(pos.x, -48, pos.z);
      dummy.scale.set(0.55, h, 0.55);
      dummy.updateMatrix();
      this._barMesh.setMatrixAt(i, dummy.matrix);

      // Colour: interpolate inner→outer across the frequency range.
      this._cTmp.lerpColors(this._cInner, this._cOuter, t);
      // Brighten taller bars so hot peaks burn white.
      const boost = 1.0 + (h / BAR_MAX_HEIGHT) * 1.2;
      this._cTmp.multiplyScalar(boost);
      this._barMesh.setColorAt(i, this._cTmp);
    }

    this._barMesh.instanceMatrix.needsUpdate = true;
    this._barMesh.instanceColor.needsUpdate  = true;
  }

  // ── Resize ───────────────────────────────────────────────────────────────

  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.particles.material.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
  }

  // ── Main render loop ─────────────────────────────────────────────────────

  render(bands, freqData) {
    const dt = this.clock.getDelta();
    const t  = this.clock.getElapsedTime();
    const u  = this.particles.material.uniforms;

    u.uTime.value   = t;
    u.uBass.value   = bands.bass;
    u.uMid.value    = bands.mid;
    u.uTreble.value = bands.treble;

    this._updateColors(bands, t);
    this._updateFreqBars(freqData);

    // More dramatic rotation — bass hits kick the spin noticeably.
    this.particles.rotation.y += dt * (0.06 + bands.bass * 0.46);
    this.particles.rotation.x += dt * 0.018;

    // Grid scrolls faster on bass hits.
    this.grid.position.z = (this.grid.position.z + dt * (5 + bands.bass * 24)) % 15;

    // Wider camera drift so the view feels alive.
    this.camera.position.x = Math.sin(t * 0.08) * 13;
    this.camera.position.y = 12 + Math.cos(t * 0.06) * 2.5;
    this.camera.lookAt(0, -6, 0);

    this.renderer.render(this.scene, this.camera);
  }
}
