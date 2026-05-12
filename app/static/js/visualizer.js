import * as THREE from "three";

const PARTICLE_COUNT = 60000;

// 80s synthwave palette
const COLOR_INNER = new THREE.Color(0x00f0ff); // neon cyan
const COLOR_OUTER = new THREE.Color(0xff3df0); // neon pink
const COLOR_FOG = new THREE.Color(0x2a0640);
const COLOR_BG = 0x08001a;
const COLOR_GRID_CENTER = 0xff3df0; // neon pink
const COLOR_GRID = 0x00f0ff;        // neon cyan

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

    // Hot core with soft falloff (cheap pseudo-bloom).
    float core = pow(1.0 - d * 2.0, 3.0);
    float halo = pow(1.0 - d * 2.0, 1.2) * 0.35;

    vec3 col = mix(uColorInner, uColorOuter, vRadial) * vBright;
    float alpha = core + halo;
    // Brighter inner glow for that "hot pixel" look.
    col += vec3(1.0, 0.7, 1.0) * core * 0.4 * vBright;

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
    this.scene.fog = new THREE.FogExp2(COLOR_FOG.getHex(), 0.0055);

    this.camera = new THREE.PerspectiveCamera(
      55,
      window.innerWidth / window.innerHeight,
      0.1,
      600,
    );
    this.camera.position.set(0, 8, 90);
    this.camera.lookAt(0, -4, 0);

    this._buildGrid();
    this._buildParticles();
    this.clock = new THREE.Clock();

    window.addEventListener("resize", () => this._onResize());
  }

  _buildGrid() {
    const grid = new THREE.GridHelper(900, 60, COLOR_GRID_CENTER, COLOR_GRID);
    grid.material.transparent = true;
    grid.material.opacity = 0.55;
    grid.material.fog = true;
    grid.position.y = -48;
    this.grid = grid;
    this.scene.add(grid);
  }

  _buildParticles() {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const sizes = new Float32Array(PARTICLE_COUNT);
    const seeds = new Float32Array(PARTICLE_COUNT * 3);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const u = Math.random();
      const radius = 25 + Math.pow(u, 0.6) * 30;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);

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
    geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 3));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uBass: { value: 0 },
        uMid: { value: 0 },
        uTreble: { value: 0 },
        uPixelRatio: { value: this.renderer.getPixelRatio() },
        uColorInner: { value: COLOR_INNER },
        uColorOuter: { value: COLOR_OUTER },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.particles = new THREE.Points(geo, mat);
    this.scene.add(this.particles);
  }

  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.particles.material.uniforms.uPixelRatio.value =
      this.renderer.getPixelRatio();
  }

  render(bands) {
    const dt = this.clock.getDelta();
    const t = this.clock.getElapsedTime();
    const u = this.particles.material.uniforms;
    u.uTime.value = t;
    u.uBass.value = bands.bass;
    u.uMid.value = bands.mid;
    u.uTreble.value = bands.treble;

    this.particles.rotation.y += dt * (0.05 + bands.bass * 0.25);
    this.particles.rotation.x += dt * 0.015;

    // Grid drifts toward camera for that endless-runway feel.
    this.grid.position.z = (this.grid.position.z + dt * (4 + bands.bass * 14)) % 15;

    // Subtle camera drift, with a downward tilt so the horizon stays in frame.
    this.camera.position.x = Math.sin(t * 0.08) * 6;
    this.camera.position.y = 8 + Math.cos(t * 0.06) * 2;
    this.camera.lookAt(0, -4, 0);

    this.renderer.render(this.scene, this.camera);
  }
}
