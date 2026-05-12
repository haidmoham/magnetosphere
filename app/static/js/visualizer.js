import * as THREE from "three";

const PARTICLE_COUNT = 60000;
const COLOR_BG = 0x08001a;

// Starting HSL values for silence — classic synthwave at rest.
// Inner: cyan (200°), Outer: hot pink (302°)
const BASE_INNER_H = 0.556; // ~200°
const BASE_OUTER_H = 0.840; // ~302°

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

    float breathe = 1.0 + uBass * 0.55;
    pos *= breathe;
    pos.y += aSeed.y * uMid * 4.0;
    pos += aSeed * uTreble * 0.9;

    vRadial = clamp(r / 60.0, 0.0, 1.0);
    vBright = 0.6 + uBass * 0.8 + uTreble * 0.3;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;

    float size = aSize * (1.0 + uBass * 0.5);
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

    vec3 col = mix(uColorInner, uColorOuter, vRadial) * vBright;
    float alpha = core + halo;
    // White-hot core: inner colour bleeds toward white on bright pixels.
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

    // Pre-allocated Color instances — updated in place each frame (no GC pressure).
    this._cInner = new THREE.Color();
    this._cOuter = new THREE.Color();
    this._cGrid  = new THREE.Color();
    this._cFog   = new THREE.Color();

    this._buildGrid();
    this._buildParticles();
    this.clock = new THREE.Clock();

    window.addEventListener("resize", () => this._onResize());
  }

  _buildGrid() {
    const grid = new THREE.GridHelper(900, 60);
    // Replace vertex-colour material so we can update colour per frame.
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

  _buildParticles() {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const sizes     = new Float32Array(PARTICLE_COUNT);
    const seeds     = new Float32Array(PARTICLE_COUNT * 3);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const u      = Math.random();
      const radius = 25 + Math.pow(u, 0.6) * 30;
      const theta  = Math.random() * Math.PI * 2;
      const phi    = Math.acos(2 * Math.random() - 1);
      const sinPhi = Math.sin(phi);

      positions[i * 3 + 0] = radius * sinPhi * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.cos(phi);
      positions[i * 3 + 2] = radius * sinPhi * Math.sin(theta);

      sizes[i] = 0.8 + Math.random() * 2.4;

      seeds[i * 3 + 0] = (Math.random() - 0.5) * 2;
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

  // Derive all scene colours from the current FFT bands and elapsed time.
  // All writes go through .copy() / .setHSL() — no allocations.
  _updateColors(bands, t) {
    // Slow autonomous hue cycle — one full rotation every ~70 s.
    const cycle = (t * 0.014) % 1.0;

    // Inner core: starts cyan, treble desaturates it toward white-hot.
    const iH = (BASE_INNER_H + cycle - bands.treble * 0.06 + 1.0) % 1.0;
    const iS = 1.0 - bands.treble * 0.45;   // high treble → near-white core
    const iL = 0.50 + bands.treble * 0.38;  // treble brightens the core

    // Outer shell: starts hot-pink, bass pushes it toward red/orange.
    const oH = (BASE_OUTER_H + cycle + bands.bass * 0.18) % 1.0;
    const oS = 1.0;
    const oL = 0.45 + bands.bass * 0.32;    // bass makes the halo flare

    this._cInner.setHSL(iH, iS, iL);
    this._cOuter.setHSL(oH, oS, oL);

    // Grid tracks the inner (cool) hue so it stays cyan-adjacent.
    // Brightness pulses gently with bass.
    this._cGrid.setHSL(iH, 1.0, 0.45 + bands.bass * 0.22);

    // Fog: dark, desaturated outer hue — particles fade into a warm haze on bass hits.
    this._cFog.setHSL(oH, 0.75, 0.06 + bands.bass * 0.05);

    // Push to GPU uniforms and scene objects.
    this.particles.material.uniforms.uColorInner.value.copy(this._cInner);
    this.particles.material.uniforms.uColorOuter.value.copy(this._cOuter);
    this.grid.material.color.copy(this._cGrid);
    this.scene.fog.color.copy(this._cFog);
  }

  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.particles.material.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
  }

  render(bands) {
    const dt = this.clock.getDelta();
    const t  = this.clock.getElapsedTime();
    const u  = this.particles.material.uniforms;

    u.uTime.value   = t;
    u.uBass.value   = bands.bass;
    u.uMid.value    = bands.mid;
    u.uTreble.value = bands.treble;

    this._updateColors(bands, t);

    this.particles.rotation.y += dt * (0.05 + bands.bass * 0.25);
    this.particles.rotation.x += dt * 0.015;

    this.grid.position.z = (this.grid.position.z + dt * (4 + bands.bass * 14)) % 15;

    this.camera.position.x = Math.sin(t * 0.08) * 7;
    this.camera.position.y = 12 + Math.cos(t * 0.06) * 2;
    this.camera.lookAt(0, -6, 0);

    this.renderer.render(this.scene, this.camera);
  }
}
