// Scroll-driven 3D "orchestration constellation".
// Chapters: 0 hero · 1 orchestrator · 2 routing · 3 models · 4 bots.
import * as THREE from 'three';

const stage = document.querySelector('.stage');
const canvas = document.querySelector('.stage-canvas');
const labelRoot = document.querySelector('.stage-labels');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const CHAPTERS = 5;

const BLUE = new THREE.Color(0x2997ff);
const WHITE = new THREE.Color(0xf5f5f7);
const DIM = new THREE.Color(0x3a3a3f);

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
} catch {
  document.documentElement.classList.add('no-webgl');
  throw new Error('WebGL unavailable');
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x050507, 0.028);
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);

const ambient = new THREE.AmbientLight(0xffffff, 0.35);
scene.add(ambient);
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(-4, 8, 6);
scene.add(key);
const coreLight = new THREE.PointLight(0x2997ff, 30, 14, 1.6);
scene.add(coreLight);

// ---------- Shared glow texture (radial gradient), used by sprites and particles.
const glowTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
// Additive glow vanishes on a white page, so these materials switch blending with the theme.
const blendMats = [];
let glowGain = 1;
const glow = (size, color, opacity = 1) => {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
  s.scale.setScalar(size);
  blendMats.push(s.material);
  return s;
};

// ---------- Starfield
let stars;
{
  const n = 1400;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = 18 + Math.random() * 40;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    pos.set([r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) * 0.6, r * Math.sin(ph) * Math.sin(th)], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  stars = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0x8e8e93, size: 0.06, transparent: true, opacity: 0.6, depthWrite: false }));
  scene.add(stars);
}

// ---------- Core
const core = new THREE.Group();
const coreMesh = new THREE.Mesh(
  new THREE.IcosahedronGeometry(1.15, 0),
  new THREE.MeshStandardMaterial({ color: 0x15171c, metalness: 0.7, roughness: 0.22, flatShading: true, emissive: 0x0a2a55, emissiveIntensity: 0.4 }),
);
const coreEdges = new THREE.LineSegments(
  new THREE.EdgesGeometry(coreMesh.geometry),
  new THREE.LineBasicMaterial({ color: 0x2997ff, transparent: true, opacity: 0.85 }),
);
const coreShell = new THREE.Mesh(
  new THREE.IcosahedronGeometry(1.75, 1),
  new THREE.MeshBasicMaterial({ color: 0x2997ff, wireframe: true, transparent: true, opacity: 0.08 }),
);
const coreGlow = glow(5.5, 0x2997ff, 0.55);
const coreSpark = glow(1.4, 0xffffff, 0.9);
core.add(coreMesh, coreEdges, coreShell, coreGlow, coreSpark);
scene.add(core);

// ---------- Brand icon textures (SVGs in assets/icons, drawn onto canvases).
// tile: 'dark' / 'card' app-tiles for planners and models (per page theme); 'light' (borderless)
// for phone screens, where blue marks (WeCom, Feishu) would otherwise vanish into the glowing screen.
const MONO = new Set(['kimi', 'mimo', 'openrouter', 'ollama']);
function iconTexture(id, tile) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const img = new Image();
  img.onload = () => {
    const g = c.getContext('2d');
    g.beginPath();
    g.roundRect(10, 10, 236, 236, 64);
    g.fillStyle = tile === 'dark' ? '#16171c' : '#ffffff';
    g.fill();
    if (tile !== 'light') {
      g.lineWidth = 4;
      g.strokeStyle = tile === 'dark' ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.10)';
      g.stroke();
    }
    const s = 136;
    g.drawImage(img, (256 - s) / 2, (256 - s) / 2, s, s);
    tex.needsUpdate = true;
  };
  // Mono marks are rendered white for dark tiles; re-ink them for white tiles.
  if (MONO.has(id) && tile !== 'dark') {
    fetch(`assets/icons/${id}.svg`).then((r) => r.text()).then((svg) => {
      img.src = URL.createObjectURL(new Blob([svg.replace(/#ffffff/gi, '#1d1d1f')], { type: 'image/svg+xml' }));
    });
  } else {
    img.src = `assets/icons/${id}.svg`;
  }
  return tex;
}

// ---------- Nodes
const nodes = [];
const ICON_DIM = new THREE.Color(0x56565e);
const ICON_FULL = new THREE.Color(1, 1, 1);
const phoneGeo = new THREE.BoxGeometry(0.46, 0.84, 0.07);
function makeNode({ id, kind, size }) {
  const g = new THREE.Group();
  const halo = glow(kind === 'bot' ? 1.4 : size * 2.4, 0x2997ff, 0);
  halo.renderOrder = 1;
  let face;
  let body = null;
  let screen = null;
  let tex = null;
  if (kind === 'bot') {
    body = new THREE.Mesh(phoneGeo, new THREE.MeshStandardMaterial({ color: 0x1b1c22, metalness: 0.6, roughness: 0.3, emissive: BLUE.clone(), emissiveIntensity: 0 }));
    screen = new THREE.Mesh(new THREE.PlaneGeometry(0.38, 0.72), new THREE.MeshBasicMaterial({ color: 0x0c1626 }));
    screen.position.z = 0.037;
    face = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.36), new THREE.MeshBasicMaterial({ map: iconTexture(id, 'light'), transparent: true, depthWrite: false }));
    face.position.z = 0.04;
    g.add(halo, body, screen, face);
  } else {
    // Sprites always face the camera, so the brand mark stays readable from every chapter angle.
    tex = { dark: iconTexture(id, 'dark'), light: iconTexture(id, 'card') };
    face = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex.dark, transparent: true, depthWrite: false }));
    face.scale.setScalar(size);
    face.renderOrder = 2;
    g.add(halo, face);
  }
  const label = labelRoot.querySelector(`[data-node="${id}"]`);
  const node = { id, kind, group: g, face, body, screen, tex, halo, label, size, emphasis: 0, target: 0 };
  nodes.push(node);
  return node;
}

const planners = [
  makeNode({ id: 'claude', kind: 'plan', size: 1.3 }),
  makeNode({ id: 'codex', kind: 'plan', size: 1.3 }),
];
planners[0].group.position.set(-6.2, 1.3, 0.6);
planners[1].group.position.set(-6.2, -1.3, -0.6);
planners.forEach((n) => scene.add(n.group));

const MODEL_IDS = ['deepseek', 'glm', 'kimi', 'qwen', 'minimax', 'mimo', 'openrouter', 'ollama'];
const ring = new THREE.Group();
ring.rotation.x = 0.32;
const ringRadius = 3.7;
let ringLine;
const models = MODEL_IDS.map((id, i) => {
  const n = makeNode({ id, kind: 'model', size: 0.92 });
  const a = (i / MODEL_IDS.length) * Math.PI * 2;
  n.group.position.set(Math.cos(a) * ringRadius, 0, Math.sin(a) * ringRadius);
  ring.add(n.group);
  return n;
});
{
  const pts = [];
  for (let i = 0; i <= 128; i++) {
    const a = (i / 128) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * ringRadius, 0, Math.sin(a) * ringRadius));
  }
  ringLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x5a5a64, transparent: true, opacity: 0.35 }));
  ring.add(ringLine);
}
scene.add(ring);

const bots = ['telegram', 'wechat', 'wecom', 'feishu'].map((id, i) => {
  const n = makeNode({ id, kind: 'bot', size: 0.38 });
  n.group.position.set(6.4, 2.1 - i * 1.4, (i % 2 ? -0.5 : 0.5));
  n.group.rotation.y = -0.45;
  scene.add(n.group);
  return n;
});

// ---------- Routes: dynamic bezier lines + flowing particles
const routes = [];
const PARTICLES = 7;
function makeRoute(from, to, kind, opts = {}) {
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(33 * 3), 3));
  const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0x6e6e78, transparent: true, opacity: 0.2, depthWrite: false }));
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PARTICLES * 3), 3));
  const points = new THREE.Points(pGeo, new THREE.PointsMaterial({ map: glowTex, color: 0x2997ff, size: 0.32, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  scene.add(line, points);
  blendMats.push(points.material);
  const seeds = Array.from({ length: PARTICLES }, (_, i) => ({ t: i / PARTICLES, dir: opts.both && i % 2 ? -1 : 1 }));
  const r = { from, to, kind, line, points, seeds, lift: opts.lift ?? 0.9, speed: opts.speed ?? 0.22, activity: 0, target: 0 };
  routes.push(r);
  return r;
}
planners.forEach((p) => makeRoute(p, null, 'plan', { lift: 1.2 }));
models.forEach((m) => makeRoute(null, m, 'model', { lift: 0.6, speed: 0.3 }));
bots.forEach((b) => makeRoute(null, b, 'bot', { lift: 1.0, both: true, speed: 0.18 }));

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const tmpP = new THREE.Vector3();
function bezier(a, c, b, t, out) {
  const u = 1 - t;
  return out.set(
    u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    u * u * a.y + 2 * u * t * c.y + t * t * b.y,
    u * u * a.z + 2 * u * t * c.z + t * t * b.z,
  );
}
function updateRoute(r, dt) {
  (r.from ? r.from.group : core).getWorldPosition(tmpA);
  (r.to ? r.to.group : core).getWorldPosition(tmpB);
  tmpC.copy(tmpA).add(tmpB).multiplyScalar(0.5);
  tmpC.y += r.lift;
  const lp = r.line.geometry.attributes.position;
  for (let i = 0; i <= 32; i++) {
    bezier(tmpA, tmpC, tmpB, i / 32, tmpP);
    lp.setXYZ(i, tmpP.x, tmpP.y, tmpP.z);
  }
  lp.needsUpdate = true;
  const pp = r.points.geometry.attributes.position;
  r.seeds.forEach((s, i) => {
    if (!reduceMotion) s.t = (s.t + dt * r.speed * (0.4 + r.activity) * s.dir + 1) % 1;
    bezier(tmpA, tmpC, tmpB, s.t, tmpP);
    pp.setXYZ(i, tmpP.x, tmpP.y, tmpP.z);
  });
  pp.needsUpdate = true;
  r.line.material.opacity = 0.08 + r.activity * 0.45;
  r.line.material.color.copy(DIM).lerp(BLUE, r.activity);
  r.points.material.opacity = r.activity;
}

// ---------- Theme (html[data-theme] is owned by main.js)
function applyTheme() {
  const light = document.documentElement.dataset.theme === 'light';
  BLUE.set(light ? 0x0a7cff : 0x2997ff);
  DIM.set(light ? 0xc3c6ce : 0x3a3a3f);
  ICON_DIM.set(light ? 0xd4d4da : 0x56565e);
  glowGain = light ? 0.55 : 1;
  blendMats.forEach((m) => { m.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending; m.needsUpdate = true; });
  scene.fog.color.set(light ? 0xffffff : 0x050507);
  scene.fog.density = light ? 0.02 : 0.028;
  ambient.intensity = light ? 1.1 : 0.35;
  stars.material.color.set(light ? 0x9db3d3 : 0x8e8e93);
  coreMesh.material.color.set(light ? 0xe4e9f2 : 0x15171c);
  coreMesh.material.emissive.set(light ? 0x2a6fd6 : 0x0a2a55);
  coreMesh.material.emissiveIntensity = light ? 0.12 : 0.4;
  coreEdges.material.color.copy(BLUE);
  coreShell.material.color.copy(BLUE);
  coreShell.material.opacity = light ? 0.14 : 0.08;
  coreGlow.material.opacity = light ? 0.28 : 0.55;
  coreSpark.material.opacity = light ? 0.5 : 0.9;
  ringLine.material.color.set(light ? 0xb4b8c2 : 0x5a5a64);
  ringLine.material.opacity = light ? 0.7 : 0.35;
  nodes.forEach((n) => {
    if (n.tex) n.face.material.map = light ? n.tex.light : n.tex.dark;
    if (n.body) n.body.material.color.set(light ? 0xe6e7ec : 0x1b1c22);
    if (n.screen) n.screen.material.color.set(light ? 0xeef4fd : 0x0c1626);
  });
}
new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
applyTheme();

// ---------- Chapter states
// cam/look: camera position + target. Emphasis per node kind; `pick` overrides for specific ids.
const STATES = [
  { cam: [0, 3.4, 18], look: [0, -0.4, 0], plan: 0.5, model: 0.42, bot: 0.45, spin: 0.08 },
  { cam: [-3.6, 2.6, 12.5], look: [-3.4, 0, 0], plan: 1, model: 0.35, bot: 0.05, spin: 0.05, pick: { deepseek: 1, glm: 1, kimi: 1, qwen: 1 } },
  { cam: [0, 7, 16], look: [-1.2, -0.3, 0], plan: 0.45, model: 0.12, bot: 0.05, spin: 0.03, pick: { claude: 1, glm: 1, deepseek: 1 } },
  { cam: [0, 10.5, 4.6], look: [0, 0, 0], plan: 0.1, model: 0.55, bot: 0.05, spin: 0.22, dial: true },
  { cam: [4.6, 1.6, 11.5], look: [4.2, 0, 0], plan: 0.15, model: 0.15, bot: 1, spin: 0.05 },
];
const v3 = (a) => new THREE.Vector3(...a);
const camPos = v3(STATES[0].cam);
const camLook = v3(STATES[0].look);
const camPosT = camPos.clone();
const camLookT = camLook.clone();
let spin = STATES[0].spin;
// Scroll progress + active chapter are owned by main.js (so the copy works without WebGL).
const story = window.ccemStory;
let progress = 0;
let active = 0;
let dialIndex = 0;
let dialClock = 0;
const mouse = { x: 0, y: 0, tx: 0, ty: 0 };

const smooth = (t) => t * t * (3 - 2 * t);
function emphasisFor(state, node) {
  if (state.dial && node.kind === 'model') return MODEL_IDS[dialIndex] === node.id ? 1 : 0.3;
  if (state.pick && node.id in state.pick) return state.pick[node.id];
  return state[node.kind];
}

function applyState(dt) {
  const i0 = Math.floor(progress);
  const i1 = Math.min(i0 + 1, CHAPTERS - 1);
  const t = smooth(progress - i0);
  const a = STATES[i0];
  const b = STATES[i1];
  camPosT.copy(v3(a.cam)).lerp(v3(b.cam), t);
  camLookT.copy(v3(a.look)).lerp(v3(b.look), t);
  // Portrait screens: back the camera off so the wide constellation still fits.
  camPosT.sub(camLookT).multiplyScalar(fit).add(camLookT);
  spin = a.spin + (b.spin - a.spin) * t;

  const s = STATES[active];
  if (s.dial) {
    dialClock += dt;
    if (dialClock > 1.1) { dialClock = 0; dialIndex = (dialIndex + 1) % MODEL_IDS.length; }
  }
  nodes.forEach((n) => { n.target = emphasisFor(s, n); });
  routes.forEach((r) => {
    const end = r.from || r.to;
    r.target = active === 0 ? 0.35 : emphasisFor(s, end) > 0.6 ? 1 : emphasisFor(s, end) * 0.4;
  });
}

// ---------- Labels: project 3D anchors to screen space.
const proj = new THREE.Vector3();
function placeLabels(w, h) {
  nodes.forEach((n) => {
    if (!n.label) return;
    n.group.getWorldPosition(proj);
    const side = n.kind === 'bot'; // phones stack vertically, so their labels sit to the left
    if (side) proj.x -= 0.5; else proj.y -= n.size * 0.5 + 0.22;
    proj.project(camera);
    const visible = proj.z < 1 && n.emphasis > 0.45;
    const x = (proj.x * 0.5 + 0.5) * w;
    const y = (-proj.y * 0.5 + 0.5) * h;
    n.label.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) ${side ? 'translate(-100%, -50%)' : 'translate(-50%, 0)'}`;
    n.label.style.opacity = visible ? Math.min(1, (n.emphasis - 0.45) * 2.5).toFixed(2) : '0';
    n.label.classList.toggle('hot', n.emphasis > 0.8);
  });
}

// ---------- Sizing (desktop pushes the scene right of the copy panel; mobile pushes it up).
let W = 0;
let H = 0;
let fit = 1;
function resize() {
  W = stage.querySelector('.stage-sticky').clientWidth;
  H = innerHeight;
  renderer.setSize(W, H, false);
  camera.aspect = W / H;
  fit = Math.max(1, Math.sqrt(1.6 / camera.aspect));
  camera.updateProjectionMatrix();
}
let offsetX = 0;
let offsetY = 0;
function applyViewOffset(k) {
  const wide = W > 860;
  // Hero: push the constellation below the headline. Chapters: make room for the copy panel.
  const tx = active === 0 ? 0 : wide ? -W * 0.2 : 0;
  const ty = active === 0 ? -H * (wide ? 0.27 : 0.3) : wide ? 0 : H * 0.17;
  offsetX += (tx - offsetX) * k;
  offsetY += (ty - offsetY) * k;
  camera.setViewOffset(W, H, offsetX, offsetY, W, H);
}

// ---------- Loop
const clock = new THREE.Clock();
let running = false;
function frame() {
  if (!running) return;
  requestAnimationFrame(frame);
  // Generous clamp: damping stays time-based even when the tab is throttled to a few fps.
  const dt = Math.min(clock.getDelta(), 0.25);
  const time = clock.elapsedTime;
  progress = story.progress;
  active = story.active;
  applyState(dt);

  const k = 1 - Math.exp(-dt * 3.2);
  camPos.lerp(camPosT, k);
  camLook.lerp(camLookT, k);
  mouse.x += (mouse.tx - mouse.x) * k;
  mouse.y += (mouse.ty - mouse.y) * k;
  camera.position.set(camPos.x + mouse.x * 0.9, camPos.y + mouse.y * 0.6, camPos.z);
  camera.lookAt(camLook);
  applyViewOffset(k);

  if (!reduceMotion) {
    ring.rotation.y += dt * spin;
    core.rotation.y += dt * 0.25;
    coreMesh.rotation.x += dt * 0.12;
    coreShell.rotation.y -= dt * 0.1;
    const pulse = 1 + Math.sin(time * 2.2) * 0.04;
    coreGlow.scale.setScalar(5.5 * pulse);
    planners.forEach((p, i) => { p.group.position.y = (i ? -1.3 : 1.3) + Math.sin(time + i) * 0.12; });
    bots.forEach((b, i) => { b.group.position.y = 2.1 - i * 1.4 + Math.sin(time * 0.9 + i) * 0.08; });
  }

  nodes.forEach((n) => {
    n.emphasis += (n.target - n.emphasis) * Math.min(1, k * 1.4);
    const e = n.emphasis;
    n.face.material.color.copy(ICON_DIM).lerp(ICON_FULL, Math.min(1, e * 1.3));
    n.face.material.opacity = 0.4 + 0.6 * Math.min(1, e * 1.3);
    if (n.body) n.body.material.emissiveIntensity = e * 0.5;
    n.halo.material.opacity = Math.max(0, e - 0.3) * 0.9 * glowGain;
    n.group.scale.setScalar(0.8 + e * 0.35);
  });
  routes.forEach((r) => {
    r.activity += (r.target - r.activity) * k;
    updateRoute(r, dt);
  });

  renderer.render(scene, camera);
  placeLabels(W, H);
}

new IntersectionObserver(([e]) => {
  const was = running;
  running = e.isIntersecting;
  if (running && !was) { clock.getDelta(); frame(); }
}).observe(stage);

addEventListener('resize', resize);
addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return;
  mouse.tx = (e.clientX / innerWidth - 0.5) * 2;
  mouse.ty = -(e.clientY / innerHeight - 0.5) * 2;
});

resize();
document.documentElement.classList.add('webgl-ready');
