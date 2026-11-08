import * as THREE from 'three';
import { loadAbbey, PointCloud } from './cloud.js';
import { Music } from './music.js';
import tourPlan from './tour.json';
import placeTexts from './places.json';
import mapProjection from './minimap.json';
import mapImageUrl from './minimap.png?url';

const DEFAULT_DATA = 'https://earmm4k9vwqulmnw.public.blob.vercel-storage.com/abbaye';
const baseUrl = new URLSearchParams(location.search).get('data') || DEFAULT_DATA;
// A headset's browser has no more power to spare than a phone, whichever pointer it reports.
const isTouch = matchMedia('(pointer: coarse)').matches || /OculusBrowser|Quest/.test(navigator.userAgent);
// URL options: detail=<millions of points>, precharger=1 (download the tour first), lieux=<lieu,lieu>.
// Phones and tablets ignore the first two: they keep following their own frame rate, and such a
// download could be too much for them. Past 16 million points, a preloaded tour gains next to nothing.
const options = new URLSearchParams(location.search);
const preloadWanted = options.has('precharger') && !isTouch;
const DETAIL_MAX = preloadWanted ? 16 : 40;
const chosenDetail = isTouch ? 0
  : THREE.MathUtils.clamp(Number(options.get('detail')) || (preloadWanted ? DETAIL_MAX : 0), 0, DETAIL_MAX);
const chosenPlaces = options.get('lieux')?.split(',');
// The monks' rooms are a private space: they are left out unless the address is /admin.
const isAdmin = location.pathname.replace(/\/+$/, '') === '/admin';
const PRIVATE_ZONES = ['chambres', 'chambres_n1', 'chambres_n1_esc', 'chambres_n1_sdb'];

const canvas = document.getElementById('view');
const stats = document.getElementById('stats');
const showError = (message) => {
  const box = document.getElementById('error');
  box.textContent = message;
  box.hidden = false;
};

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, alpha: false, antialias: false, powerPreference: 'high-performance' });
} catch {
  showError("Votre navigateur ne permet pas d'afficher cette vue 3D (WebGL indisponible).");
  throw new Error('WebGL unavailable');
}
// The points can arrive and still draw nothing: this too must not look like an endless wait.
const GRAPHICS_TROUBLE = "La carte graphique n'arrive pas à afficher les points. Mettez à jour son pilote ou essayez un autre navigateur.";
renderer.debug.onShaderError = (gl, program, vertexShader, fragmentShader) => {
  console.error('shader', gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertexShader), gl.getShaderInfoLog(fragmentShader));
  showError(GRAPHICS_TROUBLE);
};
canvas.addEventListener('webglcontextlost', () => showError(GRAPHICS_TROUBLE));
canvas.addEventListener('webglcontextrestored', () => { document.getElementById('error').hidden = true; });

let dataTrouble = false;
function showDataTrouble(error) {
  if (Boolean(error) === dataTrouble) return;
  dataTrouble = Boolean(error);
  if (error) {
    showError(`Les données de l'abbaye n'arrivent pas (${error.message}). La connexion à vercel-storage.com est peut-être bloquée par un antivirus, une extension du navigateur ou le réseau. Le chargement continue d'essayer.`);
  } else {
    document.getElementById('error').hidden = true;
  }
}
renderer.autoClear = false;
let pixelRatio = Math.min(devicePixelRatio, isTouch ? 1.25 : 1.5);
renderer.setPixelRatio(pixelRatio);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 4000);
camera.up.set(0, 0, 1);

const target = new THREE.WebGLRenderTarget(1, 1, {
  minFilter: THREE.NearestFilter,
  magFilter: THREE.NearestFilter,
  depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
});

// Eye-dome lighting: without colour, depth edges are what make the walls readable.
const edl = new THREE.ShaderMaterial({
  depthTest: false,
  depthWrite: false,
  uniforms: {
    tColor: { value: target.texture },
    tDepth: { value: target.depthTexture },
    uTexel: { value: new THREE.Vector2() },
    uNear: { value: camera.near },
    uFar: { value: camera.far },
    uStrength: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tColor, tDepth;
    uniform vec2 uTexel;
    uniform float uNear, uFar, uStrength;
    varying vec2 vUv;
    float logDepth(vec2 uv) {
      float d = texture2D(tDepth, uv).r;
      if (d >= 1.0) return log2(uFar);
      return log2(uNear * uFar / (uFar - d * (uFar - uNear)));
    }
    void main() {
      vec2 dirs[8];
      dirs[0] = vec2(1, 0); dirs[1] = vec2(-1, 0); dirs[2] = vec2(0, 1); dirs[3] = vec2(0, -1);
      dirs[4] = vec2(0.71, 0.71); dirs[5] = vec2(-0.71, 0.71); dirs[6] = vec2(0.71, -0.71); dirs[7] = vec2(-0.71, -0.71);
      float center = logDepth(vUv);
      float sum = 0.0;
      for (int i = 0; i < 8; i++) sum += max(center - logDepth(vUv + dirs[i] * uTexel * 1.5), 0.0);
      float shade = exp(-sum * 1.1 * uStrength);
      vec3 color = texture2D(tColor, vUv).rgb;
      gl_FragColor = vec4(color * shade, 1.0);
    }
  `,
});
const quadScene = new THREE.Scene();
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), edl);
quadScene.add(quad);
const quadCamera = new THREE.Camera();

// Improved rendering, computed on the fly from what the points draw on screen, in three steps:
// keep colour and distance together, close the gaps between points and hide what shows through
// them (screen-space visibility operator, after Pintus et al. 2011 and Bouchiba et al. 2017),
// then light the surfaces using normals estimated from the depth image.
const canImprove = renderer.capabilities.isWebGL2 && renderer.extensions.has('EXT_color_buffer_float');
const FILL_RADII = [1, 2, 4];
const fillOptions = {
  type: THREE.FloatType,
  minFilter: THREE.NearestFilter,
  magFilter: THREE.NearestFilter,
  depthBuffer: false,
};
let fillA = new THREE.WebGLRenderTarget(1, 1, fillOptions);
let fillB = new THREE.WebGLRenderTarget(1, 1, fillOptions);
const fullScreen = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const passOptions = { depthTest: false, depthWrite: false, vertexShader: fullScreen };

const seedPass = new THREE.ShaderMaterial({
  ...passOptions,
  uniforms: {
    tColor: { value: target.texture },
    tDepth: { value: target.depthTexture },
    uNear: { value: camera.near },
    uFar: { value: camera.far },
  },
  fragmentShader: /* glsl */ `
    uniform sampler2D tColor, tDepth;
    uniform float uNear, uFar;
    varying vec2 vUv;
    void main() {
      float d = texture2D(tDepth, vUv).r;
      float distance = d >= 1.0 ? 0.0 : uNear * uFar / (uFar - d * (uFar - uNear));
      gl_FragColor = vec4(texture2D(tColor, vUv).rgb, distance);
    }
  `,
});

const fillPass = new THREE.ShaderMaterial({
  ...passOptions,
  uniforms: {
    tPrev: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uRadius: { value: 1 },
  },
  fragmentShader: /* glsl */ `
    uniform sampler2D tPrev;
    uniform vec2 uTexel;
    uniform float uRadius;
    varying vec2 vUv;
    void main() {
      vec4 here = texture2D(tPrev, vUv);
      float center = here.a > 0.0 ? here.a : 1e9;
      float limit = center - max(0.03, center * 0.02);
      vec2 dirs[8];
      dirs[0] = vec2(1, 0); dirs[1] = vec2(0.71, 0.71); dirs[2] = vec2(0, 1); dirs[3] = vec2(-0.71, 0.71);
      dirs[4] = vec2(-1, 0); dirs[5] = vec2(-0.71, -0.71); dirs[6] = vec2(0, -1); dirs[7] = vec2(0.71, -0.71);
      vec4 around[8];
      float nearest = 1e9;
      for (int i = 0; i < 8; i++) {
        around[i] = texture2D(tPrev, vUv + dirs[i] * uRadius * uTexel);
        if (around[i].a > 0.0) nearest = min(nearest, around[i].a);
      }
      // A pixel with something closer on opposite sides sits in a gap: what it shows is behind the surface.
      int pairs = 0;
      for (int i = 0; i < 4; i++) {
        float a = around[i].a, b = around[i + 4].a;
        if (a > 0.0 && b > 0.0 && a < limit && b < limit) pairs++;
      }
      vec4 sum = vec4(0.0);
      float count = 0.0;
      if (pairs < 3) {
        // A speck floating alone in front of everything is scanner noise: use what lies behind it.
        float clear = 0.0;
        for (int i = 0; i < 8; i++) {
          if (around[i].a <= 0.0) clear += 1.0;
          if (here.a > 0.0 && around[i].a > here.a + max(0.03, here.a * 0.02)) {
            sum += around[i];
            count += 1.0;
          }
        }
        // At the widest radius, nothing at all around it means a dot in the open sky.
        if (uRadius >= 4.0 && clear >= 8.0) gl_FragColor = vec4(0.0);
        else gl_FragColor = count >= 7.0 ? sum / count : here;
        return;
      }
      float cluster = nearest + max(0.03, nearest * 0.03);
      for (int i = 0; i < 8; i++) {
        if (around[i].a > 0.0 && around[i].a < cluster) {
          sum += around[i];
          count += 1.0;
        }
      }
      gl_FragColor = sum / count;
    }
  `,
});

const SKY_SHADER = /* glsl */ `
  uniform vec3 uSun, uHorizon, uZenith, uGlow;
  uniform float uDisc, uNight;
  vec3 sky(vec3 world) {
    float up = clamp(world.z * 1.4 + 0.15, 0.0, 1.0);
    return mix(uHorizon, uZenith, pow(up, 0.7));
  }
  vec3 openSky(vec3 world) {
    float toSun = max(dot(world, uSun), 0.0);
    vec3 color = sky(world) + uGlow * (pow(toSun, 5.0) * 0.45 + pow(toSun, 60.0) * 0.5);
    float above = smoothstep(-0.01, 0.02, world.z);
    color += above * uDisc * smoothstep(0.9993, 0.9997, toSun) * vec3(1.0, 0.97, 0.88);
    float star = fract(sin(dot(floor(world * 260.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    return color + above * uNight * step(0.9972, star) * star * vec3(0.8, 0.85, 1.0);
  }
`;

const shadePass = new THREE.ShaderMaterial({
  ...passOptions,
  uniforms: {
    tFill: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uTan: { value: new THREE.Vector2() },
    uViewToWorld: { value: new THREE.Matrix3() },
    uSun: { value: new THREE.Vector3(0.45, -0.55, 0.7).normalize() },
    uHorizon: { value: new THREE.Color() },
    uZenith: { value: new THREE.Color() },
    uGlow: { value: new THREE.Color() },
    uAmbient: { value: new THREE.Color() },
    uKey: { value: new THREE.Color() },
    uDisc: { value: 0 },
    uNight: { value: 0 },
    uStrength: { value: 1 },
  },
  fragmentShader: /* glsl */ `
    uniform sampler2D tFill;
    uniform vec2 uTexel, uTan;
    uniform mat3 uViewToWorld;
    uniform vec3 uAmbient, uKey;
    uniform float uStrength;
    varying vec2 vUv;
    ${SKY_SHADER}
    vec3 viewPosition(vec2 uv, float z) { return vec3((uv * 2.0 - 1.0) * uTan * z, -z); }
    // On each side, follow the neighbour lying on the same surface.
    vec3 slope(vec2 step, vec3 center) {
      float a = texture2D(tFill, vUv + step).a, b = texture2D(tFill, vUv - step).a;
      bool useA = a > 0.0 && (b <= 0.0 || abs(a + center.z) < abs(b + center.z));
      if (useA) return viewPosition(vUv + step, a) - center;
      if (b > 0.0) return center - viewPosition(vUv - step, b);
      return vec3(0.0);
    }
    void main() {
      vec4 here = texture2D(tFill, vUv);
      vec3 ray = uViewToWorld * normalize(vec3((vUv * 2.0 - 1.0) * uTan, -1.0));
      if (here.a <= 0.0) {
        gl_FragColor = vec4(openSky(ray), 1.0);
        return;
      }
      float z = here.a;
      vec3 p = viewPosition(vUv, z);
      // A wide baseline: over a few pixels only, depth noise would look like a rough surface.
      vec3 dx = slope(vec2(uTexel.x * 5.0, 0.0), p);
      vec3 dy = slope(vec2(0.0, uTexel.y * 5.0), p);
      vec3 normal = cross(dx, dy);
      normal = dot(normal, normal) > 0.0 ? normalize(normal) : normalize(-p);
      if (dot(normal, p) > 0.0) normal = -normal;
      vec3 worldNormal = uViewToWorld * normal;

      vec2 dirs[8];
      dirs[0] = vec2(1, 0); dirs[1] = vec2(-1, 0); dirs[2] = vec2(0, 1); dirs[3] = vec2(0, -1);
      dirs[4] = vec2(0.71, 0.71); dirs[5] = vec2(-0.71, 0.71); dirs[6] = vec2(0.71, -0.71); dirs[7] = vec2(-0.71, -0.71);
      float edge = 0.0, occlusion = 0.0, weight = 1.0;
      vec3 color = here.rgb;
      for (int i = 0; i < 8; i++) {
        float near = texture2D(tFill, vUv + dirs[i] * uTexel * 1.5).a;
        if (near > 0.0) edge += max(log2(z) - log2(near), 0.0);
        float wide = texture2D(tFill, vUv + dirs[i] * uTexel * 8.0).a;
        if (wide > 0.0 && z - wide > z * 0.008 && z - wide < z * 0.25) occlusion += 1.0;
        // Laser speckle: average with the neighbours lying on the same surface.
        vec4 close = texture2D(tFill, vUv + dirs[i] * uTexel);
        if (i < 4 && close.a > 0.0 && abs(close.a - z) < z * 0.01 + 0.005) {
          color += close.rgb;
          weight += 1.0;
        }
      }
      color /= weight;
      vec3 light = (0.62 + 0.2 * worldNormal.z) * uAmbient + 0.4 * max(dot(worldNormal, uSun), 0.0) * uKey;
      float shade = exp(-edge * 1.1 * uStrength) * (1.0 - 0.055 * occlusion * uStrength);
      vec3 lit = color * light * shade;
      float haze = 1.0 - exp(-z / 600.0);
      gl_FragColor = vec4(mix(lit, sky(ray), haze), 1.0);
    }
  `,
});
let improved = canImprove;

// Occlusion: a small map of the farthest visible distance on screen. It lets the selection skip
// what hides behind walls and spend the point budget on the surfaces actually in view.
const OCCLUSION_STEP = 4;
const reduceOptions = { ...fillOptions };
const reduceA = new THREE.WebGLRenderTarget(1, 1, reduceOptions);
const reduceB = new THREE.WebGLRenderTarget(1, 1, reduceOptions);
const reducePass = new THREE.ShaderMaterial({
  ...passOptions,
  uniforms: { tPrev: { value: null }, uTexel: { value: new THREE.Vector2() } },
  fragmentShader: /* glsl */ `
    uniform sampler2D tPrev;
    uniform vec2 uTexel;
    varying vec2 vUv;
    void main() {
      // A few gaps in a wall do not make an opening; a mostly empty cell does.
      float farthest = 0.0;
      float empty = 0.0;
      for (int x = -2; x < 2; x++) {
        for (int y = -2; y < 2; y++) {
          float d = texture2D(tPrev, vUv + (vec2(x, y) + 0.5) * uTexel).a;
          if (d <= 0.0 || d >= 1e8) empty += 1.0;
          else farthest = max(farthest, d);
        }
      }
      gl_FragColor = vec4(0.0, 0.0, 0.0, empty >= 8.0 ? 1e9 : farthest);
    }
  `,
});
let occlusionBusy = false;
let occlusionAt = 0;

// Fly camera
const look = { yaw: 0, pitch: 0 };
const velocity = new THREE.Vector3();
const keys = new Set();
let speed = 1.6;
let flight = null;
let dirty = true;
let cleanup = null;
let headset = null;
let stale = true;
let cloud = null;

const speedValue = document.getElementById('speed-value');
function setSpeed(value) {
  speed = THREE.MathUtils.clamp(value, 0.2, 40);
  speedValue.textContent = `${speed.toFixed(1).replace('.', ',')} m/s`;
  dirty = true;
}
const SPEED_STEP = 1.25;
document.getElementById('speed-down').addEventListener('click', () => setSpeed(speed / SPEED_STEP));
document.getElementById('speed-up').addEventListener('click', () => setSpeed(speed * SPEED_STEP));

function applyLook() {
  const cp = Math.cos(look.pitch);
  const dir = new THREE.Vector3(cp * Math.cos(look.yaw), cp * Math.sin(look.yaw), Math.sin(look.pitch));
  camera.lookAt(camera.position.clone().add(dir));
  camera.updateMatrixWorld();
  dirty = true;
}

function resize() {
  if (headset?.active) return;
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  target.setSize(Math.round(w * pixelRatio), Math.round(h * pixelRatio));
  edl.uniforms.uTexel.value.set(1 / target.width, 1 / target.height);
  fillA.setSize(target.width, target.height);
  fillB.setSize(target.width, target.height);
  fillPass.uniforms.uTexel.value.set(1 / target.width, 1 / target.height);
  shadePass.uniforms.uTexel.value.set(1 / target.width, 1 / target.height);
  reduceA.setSize(Math.ceil(target.width / OCCLUSION_STEP), Math.ceil(target.height / OCCLUSION_STEP));
  reduceB.setSize(Math.ceil(reduceA.width / OCCLUSION_STEP), Math.ceil(reduceA.height / OCCLUSION_STEP));
  camera.aspect = w / h;
  if (tour) fovGoal = tourFov();
  camera.updateProjectionMatrix();
  dirty = true;
}
addEventListener('resize', resize);

// event.code is the physical key: KeyW is printed Z on AZERTY keyboards, KeyA is Q, KeyQ is A.
const KEY_MOVES = {
  KeyW: [1, 0, 0], ArrowUp: [1, 0, 0],
  KeyS: [-1, 0, 0], ArrowDown: [-1, 0, 0],
  KeyA: [0, -1, 0], ArrowLeft: [0, -1, 0],
  KeyD: [0, 1, 0], ArrowRight: [0, 1, 0],
};
const VERTICAL = { KeyE: 1, KeyQ: -1, PageUp: 1, PageDown: -1 };

addEventListener('keydown', (event) => {
  if ((event.target instanceof HTMLInputElement || event.target.getAttribute?.('role') === 'slider') && event.code.startsWith('Arrow')) return;
  if (event.key === '+' || event.key === '=') setSpeed(speed * SPEED_STEP);
  if (event.key === '-' || event.key === '_') setSpeed(speed / SPEED_STEP);
  if (event.code in KEY_MOVES || event.code in VERTICAL || event.code.startsWith('Shift')) {
    keys.add(event.code);
    if (!event.code.startsWith('Shift')) stopTour();
    flight = null;
    if (event.code.startsWith('Arrow') || event.code.startsWith('Page')) event.preventDefault();
  }
});
addEventListener('keyup', (event) => keys.delete(event.code));
addEventListener('blur', () => keys.clear());

const pointers = new Map();
let pinch = null;
canvas.addEventListener('pointerdown', (event) => {
  if (cleanup?.pointerDown(event)) return;
  canvas.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  pinch = null;
  flight = null;
  stopTour();
  document.getElementById('help').hidden = true;
});
canvas.addEventListener('pointermove', (event) => {
  if (cleanup?.pointerMove(event)) return;
  const last = pointers.get(event.pointerId);
  if (!last) return;
  const dx = event.clientX - last.x, dy = event.clientY - last.y;
  last.x = event.clientX;
  last.y = event.clientY;
  if (pointers.size === 1) {
    // Zoomed in, the same gesture covers less of the scene.
    const turn = 0.0035 * Math.min(camera.fov / NORMAL_FOV, 1);
    look.yaw += dx * turn;
    look.pitch = THREE.MathUtils.clamp(look.pitch + dy * turn, -1.55, 1.55);
    applyLook();
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const now = { d: Math.hypot(a.x - b.x, a.y - b.y) };
    if (pinch) {
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
      camera.position.addScaledVector(forward, (now.d - pinch.d) * 0.012 * speed);
      camera.position.addScaledVector(right, -dx * 0.005 * speed);
      camera.position.z += dy * 0.005 * speed;
      camera.updateMatrixWorld();
      dirty = true;
    }
    pinch = now;
  }
});
const release = (event) => {
  if (cleanup?.pointerUp()) return;
  pointers.delete(event.pointerId);
  pinch = null;
};
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
// Zoom: the field of view narrows, so that the visitor stays where they are and goes through no wall. A pinch on
// a trackpad reaches the page as a wheel with Ctrl. The plain wheel sets the speed, except while cleaning.
const ZOOM_FOV = { min: 12, max: 100 };
function zoom(amount) {
  stopTour();
  flight = null;
  camera.fov = fovGoal = THREE.MathUtils.clamp(camera.fov * Math.exp(amount), ZOOM_FOV.min, ZOOM_FOV.max);
  camera.updateProjectionMatrix();
  dirty = true;
}
canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  // With Shift held, some systems turn the wheel sideways.
  const delta = event.deltaY || event.deltaX;
  if (event.ctrlKey) zoom(delta * 0.01);
  else if (cleanup) zoom(delta * 0.0015);
  else setSpeed(speed * Math.exp(-delta * 0.0012));
}, { passive: false });

function goTo(position, duration = 1.2, view = null) {
  flight = { from: camera.position.clone(), to: new THREE.Vector3(...position), t: 0, duration };
  if (view) {
    // Turn the shortest way round.
    const turn = Math.atan2(Math.sin(view.yaw - look.yaw), Math.cos(view.yaw - look.yaw));
    flight.look = { yaw: look.yaw, pitch: look.pitch, turn, rise: view.pitch - look.pitch };
  }
  velocity.set(0, 0, 0);
}

// Drone view: outside, south-east of the cloister garth and looking down at it.
const OVERVIEW_OFFSET = new THREE.Vector3(38, -32, 30);
const CLOISTER = ['cloitre_est', 'cloitre_ouest', 'cloitre_sud'];
function overviewOf(abbey) {
  const stations = abbey.zones.filter((z) => CLOISTER.includes(z.id)).flatMap((z) => z.stations);
  const center = stations
    .reduce((sum, s) => sum.add(new THREE.Vector3(...s.position)), new THREE.Vector3())
    .divideScalar(stations.length);
  const position = center.clone().add(OVERVIEW_OFFSET);
  const yaw = Math.atan2(-OVERVIEW_OFFSET.y, -OVERVIEW_OFFSET.x);
  const pitch = -Math.atan2(OVERVIEW_OFFSET.z, Math.hypot(OVERVIEW_OFFSET.x, OVERVIEW_OFFSET.y));
  return { position: position.toArray(), yaw, pitch };
}
// Level view from the first station towards the middle of the zone.
function viewInto(zone) {
  const first = zone.stations[0].position;
  const middle = zone.stations.reduce((sum, s) => sum.add(new THREE.Vector3(...s.position)), new THREE.Vector3())
    .divideScalar(zone.stations.length);
  return { yaw: Math.atan2(middle.y - first[1], middle.x - first[0]), pitch: 0 };
}
// The scanner positions of a zone, a few metres apart at least and named after where they lie in it:
// a side when the zone is wide enough in that direction, and a level when it has several.
const VIEWPOINT_GAP = 2.5;
const SIDE_MIN_EXTENT = 4;
const LEVEL_MIN_EXTENT = 2.5;
function viewpointsOf(zone) {
  if (!zone) return [];
  const axis = (i) => zone.stations.map((s) => s.position[i]);
  const range = (i) => [Math.min(...axis(i)), Math.max(...axis(i))];
  const [[x0, x1], [y0, y1], [z0, z1]] = [range(0), range(1), range(2)];
  // Lay them out along the long side of the zone, so that the buttons read in the order of the place.
  const along = x1 - x0 >= y1 - y0 ? 0 : 1;
  const sorted = [...zone.stations].sort((a, b) => a.position[along] - b.position[along] || a.position[1 - along] - b.position[1 - along]);
  const kept = [];
  for (const station of sorted) {
    const [x, y, z] = station.position;
    if (kept.some((other) => Math.hypot(other.position[0] - x, other.position[1] - y, other.position[2] - z) < VIEWPOINT_GAP)) continue;
    kept.push(station);
  }
  const third = (value, low, high, minus, plus, min) => {
    if (high - low < min) return '';
    const t = (value - low) / (high - low);
    return t < 1 / 3 ? minus : t > 2 / 3 ? plus : '';
  };
  const names = kept.map((station) => {
    const [x, y, z] = station.position;
    const northSouth = third(y, y0, y1, 'Sud', 'Nord', SIDE_MIN_EXTENT);
    const eastWest = third(x, x0, x1, 'ouest', 'est', SIDE_MIN_EXTENT);
    const side = northSouth && eastWest ? `${northSouth}-${eastWest}`
      : northSouth || (eastWest && eastWest[0].toUpperCase() + eastWest.slice(1)) || 'Centre';
    const level = third(z, z0, z1, 'bas', 'haut', LEVEL_MIN_EXTENT);
    return level ? `${side}, ${level}` : side;
  });
  const seen = new Map();
  return kept.map((station, i) => {
    const total = names.filter((name) => name === names[i]).length;
    seen.set(names[i], (seen.get(names[i]) ?? 0) + 1);
    return { ...station, label: total > 1 ? `${names[i]} ${seen.get(names[i])}` : names[i] };
  });
}
const OVERVIEW_SPEED = 6;
const WALKING_SPEED = 1.6;

let showZone = () => {};
const PLACE_PREFIX = 'lieu:';
// The sky over the abbey at a given moment: the sun's real course, and colours chosen by its height above the
// horizon in degrees. Scanned surfaces take the light too; they cast no shadows, having none to compute from.
const ABBEY_LATITUDE = THREE.MathUtils.degToRad(46.84);
const ABBEY_LONGITUDE = THREE.MathUtils.degToRad(-1.03);
const SKY_REFRESH = 60_000;
const SKY_STAGES = [
  { height: -18, horizon: [0.03, 0.04, 0.08], zenith: [0.012, 0.018, 0.045], glow: [0, 0, 0], ambient: [0.72, 0.76, 0.9], key: [0, 0, 0], disc: 0, night: 1 },
  { height: -6, horizon: [0.2, 0.18, 0.27], zenith: [0.05, 0.08, 0.19], glow: [0.28, 0.13, 0.12], ambient: [0.78, 0.78, 0.88], key: [0, 0, 0], disc: 0, night: 0.1 },
  { height: 0, horizon: [0.62, 0.48, 0.42], zenith: [0.16, 0.25, 0.44], glow: [0.75, 0.33, 0.12], ambient: [0.66, 0.6, 0.6], key: [0.85, 0.48, 0.28], disc: 1, night: 0 },
  { height: 8, horizon: [0.8, 0.72, 0.62], zenith: [0.22, 0.38, 0.62], glow: [0.55, 0.36, 0.2], ambient: [0.86, 0.82, 0.8], key: [1, 0.82, 0.62], disc: 1, night: 0 },
  { height: 25, horizon: [0.74, 0.8, 0.86], zenith: [0.24, 0.44, 0.72], glow: [0.28, 0.25, 0.2], ambient: [1, 1, 1], key: [1, 0.97, 0.92], disc: 1, night: 0 },
  { height: 60, horizon: [0.7, 0.8, 0.9], zenith: [0.18, 0.38, 0.7], glow: [0.25, 0.24, 0.2], ambient: [1.02, 1.02, 1.02], key: [1, 1, 0.98], disc: 1, night: 0 },
];
const skyTime = document.getElementById('sky-time');
const skyHour = document.getElementById('sky-hour');
const skyNow = document.getElementById('sky-now');
let skyLive = true;

function sunDirection(date) {
  const rad = Math.PI / 180;
  const days = date.getTime() / 86_400_000 - 10957.5;
  const anomaly = (357.529 + 0.98560028 * days) * rad;
  const ecliptic = (280.459 + 0.98564736 * days + 1.915 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly)) * rad;
  const tilt = (23.439 - 0.00000036 * days) * rad;
  const declination = Math.asin(Math.sin(tilt) * Math.sin(ecliptic));
  const ascension = Math.atan2(Math.cos(tilt) * Math.sin(ecliptic), Math.cos(ecliptic));
  const hourAngle = (280.46061837 + 360.98564736629 * days) * rad + ABBEY_LONGITUDE - ascension;
  const sinLat = Math.sin(ABBEY_LATITUDE), cosLat = Math.cos(ABBEY_LATITUDE);
  return new THREE.Vector3(
    -Math.cos(declination) * Math.sin(hourAngle),
    cosLat * Math.sin(declination) - sinLat * Math.cos(declination) * Math.cos(hourAngle),
    sinLat * Math.sin(declination) + cosLat * Math.cos(declination) * Math.cos(hourAngle),
  );
}

// The hour on the clocks at the abbey, whatever the visitor's time zone.
function abbeyHour(date) {
  const parts = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(date);
  const part = (type) => Number(parts.find((p) => p.type === type).value);
  return part('hour') + part('minute') / 60;
}

function showSky() {
  const now = new Date();
  const hour = skyLive ? abbeyHour(now) : Number(skyHour.value);
  const sun = sunDirection(new Date(now.getTime() + (hour - abbeyHour(now)) * 3_600_000));
  const height = THREE.MathUtils.radToDeg(Math.asin(sun.z));
  const next = Math.max(SKY_STAGES.findIndex((stage) => stage.height > height), 1);
  const low = SKY_STAGES[next - 1];
  const high = SKY_STAGES[next] ?? low;
  const t = THREE.MathUtils.clamp((height - low.height) / (high.height - low.height), 0, 1);
  const uniforms = shadePass.uniforms;
  const mixed = (name, color) => color.setRGB(...low[name].map((value, i) => value + (high[name][i] - value) * t));
  mixed('horizon', uniforms.uHorizon.value);
  mixed('zenith', uniforms.uZenith.value);
  mixed('glow', uniforms.uGlow.value);
  mixed('ambient', uniforms.uAmbient.value);
  mixed('key', uniforms.uKey.value);
  uniforms.uDisc.value = low.disc + (high.disc - low.disc) * t;
  uniforms.uNight.value = low.night + (high.night - low.night) * t;
  uniforms.uSun.value.copy(sun);
  // What shows behind the points in the raw rendering.
  renderer.setClearColor(uniforms.uHorizon.value.clone().lerp(uniforms.uZenith.value, 0.5));
  skyHour.value = hour;
  const whole = Math.floor(hour);
  skyTime.textContent = `${whole} h ${String(Math.round((hour - whole) * 60)).padStart(2, '0')}${skyLive ? ' (maintenant)' : ''}`;
  skyNow.setAttribute('aria-pressed', String(skyLive));
  dirty = true;
}

function setupSky() {
  skyHour.addEventListener('input', () => {
    skyLive = false;
    showSky();
  });
  skyNow.addEventListener('click', () => {
    skyLive = true;
    showSky();
  });
  setInterval(() => { if (skyLive) showSky(); }, SKY_REFRESH);
  showSky();
}

function buildUi(abbey, startZone, overview) {
  const select = document.getElementById('zone');
  // No map column on a phone: the choice of place goes under the menu button.
  const gotoBox = document.getElementById('goto');
  const placeGoto = () => {
    if (phone.matches) document.getElementById('menu-toggle').after(gotoBox);
    else document.querySelector('.minimap').after(gotoBox);
  };
  phone.addEventListener('change', placeGoto);
  placeGoto();
  const list = document.getElementById('stations');
  const descend = () => { if (speed === OVERVIEW_SPEED) setSpeed(WALKING_SPEED); };
  showZone = (zone, keepChoice = false) => {
    if (!keepChoice) select.value = zone?.id ?? '';
    document.getElementById('stations-row').hidden = !zone || Boolean(tour);
    list.replaceChildren(...viewpointsOf(zone).map((station) => {
      const button = document.createElement('button');
      button.textContent = station.label;
      button.title = `Position du scanner ${station.name.match(/(\d+)$/)?.[1] ?? station.name}`;
      button.addEventListener('click', () => { stopTour(); descend(); goTo(station.position); });
      return button;
    }));
  };
  select.add(new Option("Vue d'ensemble", ''));
  const placeGroup = document.createElement('optgroup');
  placeGroup.label = 'Lieux de la visite';
  for (const place of tourPlan.places) placeGroup.append(new Option(placeTexts.places[place.id].title, `${PLACE_PREFIX}${place.id}`));
  select.add(placeGroup);
  const zoneGroup = document.createElement('optgroup');
  zoneGroup.label = 'Zones du relevé';
  for (const zone of abbey.zones) zoneGroup.append(new Option(zone.label, zone.id));
  select.add(zoneGroup);
  select.value = startZone?.id ?? '';
  select.addEventListener('change', () => {
    stopTour();
    forgetTour();
    if (select.value.startsWith(PLACE_PREFIX)) {
      const place = tourPlan.places.find((p) => `${PLACE_PREFIX}${p.id}` === select.value);
      const [x, y, z, yaw, pitch] = tourPlan.chains[place.chain][place.from];
      showZone(null, true);
      descend();
      goTo([x, y, z], 1.6, { yaw, pitch });
      setCurrentPlace(place.id);
      return;
    }
    const zone = abbey.zones.find((z) => z.id === select.value);
    showZone(zone);
    if (zone) {
      descend();
      goTo(zone.stations[0].position, 1.6, viewInto(zone));
    } else {
      setSpeed(OVERVIEW_SPEED);
      goTo(overview.position, 1.6, overview);
    }
  });
  showZone(startZone);
  const intensity = document.getElementById('mode-intensity');
  const height = document.getElementById('mode-height');
  const setMode = (mode) => {
    cloud.material.uniforms.uMode.value = mode;
    intensity.setAttribute('aria-pressed', String(mode === 0));
    height.setAttribute('aria-pressed', String(mode === 1));
    dirty = true;
  };
  intensity.addEventListener('click', () => setMode(0));
  height.addEventListener('click', () => setMode(1));
  document.getElementById('size').addEventListener('input', (event) => {
    cloud.material.uniforms.uSize.value = Number(event.target.value);
    dirty = true;
  });
  const detail = document.getElementById('detail');
  detail.max = DETAIL_MAX;
  detail.value = cloud.pointBudget / 1e6;
  detail.addEventListener('input', () => {
    detailChanged = true;
    cloud.pointBudget = Number(detail.value) * 1e6;
    dirty = true;
  });
  document.getElementById('edl').addEventListener('input', (event) => {
    edl.uniforms.uStrength.value = Number(event.target.value);
    shadePass.uniforms.uStrength.value = Number(event.target.value);
    dirty = true;
  });
  const improvedButton = document.getElementById('render-improved');
  const rawButton = document.getElementById('render-raw');
  const setImproved = (value) => {
    improved = value;
    if (!value) cloud.occlusion = null;
    improvedButton.setAttribute('aria-pressed', String(value));
    rawButton.setAttribute('aria-pressed', String(!value));
    // With the gaps filled afterwards, points can stay small and keep their detail.
    cloud.material.uniforms.uMinSize.value = value ? 2.6 : 2.8;
    cloud.material.uniforms.uMaxSize.value = value ? 7 : 14;
    cloud.material.uniforms.uMinTone.value = value ? 0.08 : 0;
    dirty = true;
  };
  improvedButton.addEventListener('click', () => setImproved(true));
  rawButton.addEventListener('click', () => setImproved(false));
  improvedButton.disabled = !canImprove;
  setImproved(canImprove);
  setupProfiles(detail);
  const hideTraces = document.getElementById('hide-traces');
  hideTraces.hidden = !abbey.peopleMask;
  hideTraces.addEventListener('click', () => {
    const hidden = hideTraces.getAttribute('aria-pressed') !== 'true';
    hideTraces.setAttribute('aria-pressed', String(hidden));
    cloud.hideTraces(hidden);
  });
}

// A few sets of values for the sliders. Moving a slider by hand means no profile applies any more.
const PROFILES = {
  fluide: { detail: 8, size: 1.1, edl: 0.9 },
  equilibre: { detail: 16, size: 1, edl: 1 },
  detaille: { detail: 28, size: 0.9, edl: 1.2 },
};
const FINE_SETTINGS_MIN_HEIGHT = 860;
function setupProfiles(detail) {
  const buttons = [...document.querySelectorAll('#profiles button')];
  const press = (name) => {
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.profile === name));
  };
  const sliders = { detail, size: document.getElementById('size'), edl: document.getElementById('edl') };
  for (const slider of Object.values(sliders)) slider.addEventListener('input', () => press(null));
  for (const button of buttons) {
    button.addEventListener('click', () => {
      for (const [name, slider] of Object.entries(sliders)) {
        slider.value = Math.min(PROFILES[button.dataset.profile][name], Number(slider.max));
        slider.dispatchEvent(new Event('input'));
      }
      press(button.dataset.profile);
      // Only the richest one is a demand for detail at the cost of smoothness.
      detailChanged = button.dataset.profile === 'detaille';
    });
  }
  press(cloud.pointBudget === PROFILES.equilibre.detail * 1e6 ? 'equilibre' : null);
  document.getElementById('fine-settings').open = innerHeight >= FINE_SETTINGS_MIN_HEIGHT;
}

// Contemplative tour, planned ahead from the points (see pipeline/plan_tour.py): one key position per
// second at walking speed, along paths avoiding walls and furniture, sweeping the gaze over open spaces.
// Places in one chain of keys follow each other on foot. Between chains, a fade avoids flying through
// walls: to black while points come over the network, or a dissolve when they are already on disk.
const TOUR_SPEED = 0.6;
const TOUR_FADE = 0.9;
const TOUR_MAX_WAIT = 6;
const DISSOLVE_MAX_WAIT = 1.2;
const WARM_LEAD = 15;
const TOUR_WIDTH = 115;
const TOUR_MAX_FOV = 100;
const NORMAL_FOV = 70;
const fadeLayer = document.getElementById('fade');
const freezeLayer = document.getElementById('freeze');
const tourButton = document.getElementById('tour');
const tourProgress = document.getElementById('tour-progress');
const tourTrack = document.getElementById('tour-track');
const tourFill = document.getElementById('tour-fill');
const tourThumb = document.getElementById('tour-thumb');
const tourPlace = document.getElementById('tour-place');
const tourLeft = document.getElementById('tour-left');
const tourPrevious = document.getElementById('tour-previous');
const tourNext = document.getElementById('tour-next');
const tourPreviousName = document.getElementById('tour-previous-name');
const tourNextName = document.getElementById('tour-next-name');
let tour = null;
let abbeyZones = [];
let fovGoal = NORMAL_FOV;

// As wide as the view allows, without stretching too much on an upright phone.
function tourFov() {
  const half = THREE.MathUtils.degToRad(TOUR_WIDTH) / 2;
  const fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(half) / camera.aspect));
  return THREE.MathUtils.clamp(fov, NORMAL_FOV, TOUR_MAX_FOV);
}

function tourStops() {
  return tourPlan.places.filter((place) => !chosenPlaces || chosenPlaces.includes(place.id))
    .map((place) => ({ ...place, keys: tourPlan.chains[place.chain] }));
}

// Where a stopped tour would pick up again, to the very instant.
let tourLeftAt = null;

function showTourButton() {
  tourButton.setAttribute('aria-pressed', String(Boolean(tour) && !tour.held));
  tourButton.textContent = tour?.held ? '▶ Reprendre' : tour ? '⏸ Pause' : tourLeftAt ? '▶ Reprendre la visite' : '▶ Lancer la visite guidée';
}

// On a phone, the screen is left to the view: the menu stays behind a button in the bottom right corner, and
// below it only the tour's progress, or outside the tour the choice of place (see buildUi).
const phone = matchMedia('(max-width: 640px)');
const bar = document.getElementById('bar');
const dock = document.getElementById('dock');
const menuToggle = document.getElementById('menu-toggle');

function showMenu(open) {
  bar.classList.toggle('open', open);
  menuToggle.setAttribute('aria-expanded', String(open));
  menuToggle.setAttribute('aria-label', open ? 'Fermer le menu' : 'Ouvrir le menu');
}

function placeMenu() {
  const settings = document.querySelector('.settings');
  if (phone.matches) {
    dock.prepend(bar);
    dock.append(tourProgress);
    document.getElementById('submenu').append(settings);
  } else {
    document.getElementById('place-title').after(bar);
    bar.append(tourProgress);
    document.querySelector('.side').append(settings);
  }
  showMenu(false);
}

menuToggle.addEventListener('click', () => showMenu(!bar.classList.contains('open')));
canvas.addEventListener('pointerdown', () => { if (phone.matches) showMenu(false); });
phone.addEventListener('change', placeMenu);
placeMenu();

function forgetTour() {
  tourLeftAt = null;
  showTourButton();
}

function startTour() {
  const stops = tourStops();
  if (!stops.length) return;
  flight = null;
  keys.clear();
  velocity.set(0, 0, 0);
  document.getElementById('help').hidden = true;
  if (tourLeftAt) {
    const { index, time, position, yaw, pitch, pace } = tourLeftAt;
    const unmoved = camera.position.distanceTo(position) < 0.01 && Math.abs(look.yaw - yaw) < 0.001 && Math.abs(look.pitch - pitch) < 0.001;
    // Having walked away, come back through the usual fade; otherwise simply carry on.
    tour = unmoved
      ? { stops, index, phase: 'walking', clock: 0, time }
      : { stops, index, target: index, resumeAt: time, phase: 'next', clock: 0, time };
    setSpeed(pace);
    tourLeftAt = null;
  } else {
    const choice = document.getElementById('zone').value;
    const startPlace = choice.startsWith(PLACE_PREFIX) ? choice.slice(PLACE_PREFIX.length) : choice && placeAt(camera.position);
    const here = stops.findIndex((stop) => stop.id === startPlace);
    tour = { stops, index: -1, target: here >= 0 ? here : undefined, phase: 'next', clock: 0, time: 0 };
    setSpeed(TOUR_SPEED);
  }
  fovGoal = tourFov();
  showTourButton();
  drawRoute();
  buildTourTicks();
  document.getElementById('stations-row').hidden = true;
  tourProgress.hidden = false;
  showTourProgress();
}

function stopTour() {
  if (!tour) return;
  const index = tour.target ?? tour.index;
  if (index >= 0) {
    tourLeftAt = {
      index,
      time: tour.target === undefined ? tour.time : tour.resumeAt ?? tour.stops[index].from,
      position: camera.position.clone(),
      yaw: look.yaw,
      pitch: look.pitch,
      pace: speed,
    };
  }
  tour = null;
  fadeLayer.classList.remove('dark');
  freezeLayer.classList.remove('held');
  closeDetail();
  setSpeed(WALKING_SPEED);
  fovGoal = NORMAL_FOV;
  showTourButton();
  tourProgress.hidden = true;
  showZone(abbeyZones.find((z) => z.id === document.getElementById('zone').value), true);
}

function toggleTour() {
  if (!cloud) return;
  if (tour) tour.held = !tour.held;
  else startTour();
  showTourButton();
  if (tour) showTourProgress();
}

// Leave for another place of the tour, through the same fade. Several presses add up.
function jumpTour(delta) {
  if (!tour) return;
  const count = tour.stops.length;
  const from = tour.target ?? Math.max(tour.index, 0);
  tour.target = (from + delta + count) % count;
  tour.resumeAt = undefined;
  closeDetail();
  if (tour.phase !== 'darkening') tour.phase = 'next';
  showTourProgress();
}

function formatDuration(seconds) {
  const whole = Math.ceil(seconds);
  if (whole < 60) return `${whole} s`;
  const rest = whole % 60;
  return `${Math.floor(whole / 60)} min${rest ? ` ${String(rest).padStart(2, '0')}` : ''}`;
}

// These run during the walk: touching the page only when something changed keeps it from costing frames.
function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function towards(button, nameBox, stop) {
  const title = placeTexts.places[stop.id].title;
  const label = `Vers ${title[0].toLowerCase()}${title.slice(1)}`.replace('Vers retour au', 'Vers le');
  setText(nameBox, label);
  if (button.title !== label) {
    button.title = label;
    button.setAttribute('aria-label', label);
  }
}

const tourLength = () => tour.stops.reduce((sum, stop) => sum + stop.to - stop.from, 0);

// Seconds into the whole visit, at the pace it was planned for.
function tourClock() {
  const index = tour.target ?? tour.index;
  if (index < 0) return 0;
  const before = tour.stops.slice(0, index).reduce((sum, stop) => sum + stop.to - stop.from, 0);
  const time = tour.target !== undefined ? tour.resumeAt ?? tour.stops[index].from : tour.time;
  return before + THREE.MathUtils.clamp(time - tour.stops[index].from, 0, tour.stops[index].to - tour.stops[index].from);
}

function tourMoment(seconds) {
  let rest = THREE.MathUtils.clamp(seconds, 0, tourLength() - 0.01);
  for (const [index, stop] of tour.stops.entries()) {
    if (rest < stop.to - stop.from) return { index, time: stop.from + rest };
    rest -= stop.to - stop.from;
  }
  return { index: 0, time: tour.stops[0].from };
}

const formatClock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

function buildTourTicks() {
  const total = tourLength();
  let sum = 0;
  document.getElementById('tour-ticks').replaceChildren(...tour.stops.slice(0, -1).map((stop) => {
    sum += stop.to - stop.from;
    const tick = document.createElement('i');
    tick.style.left = `${(sum / total) * 100}%`;
    return tick;
  }));
}

function showTourPosition(seconds) {
  const share = seconds / tourLength();
  tourFill.style.transform = `scaleX(${share})`;
  tourThumb.style.left = `${share * 100}%`;
  tourTrack.setAttribute('aria-valuenow', String(Math.round(share * 100)));
  tourTrack.setAttribute('aria-valuetext', formatClock(seconds));
}

function showTourProgress() {
  const stop = tour.stops[tour.index];
  const count = tour.stops.length;
  const shown = tour.target ?? Math.max(tour.index, 0);
  towards(tourPrevious, tourPreviousName, tour.stops[(shown - 1 + count) % count]);
  towards(tourNext, tourNextName, tour.stops[(shown + 1) % count]);
  const clock = `${formatClock(tourClock())} / ${formatClock(tourLength())}`;
  if (seeking === null) showTourPosition(tourClock());
  if (tour.target !== undefined || !stop) {
    setText(tourPlace, tour.target !== undefined
      ? `Lieu ${tour.target + 1} sur ${count} : ${placeTexts.places[tour.stops[tour.target].id].title}`
      : 'Préparation de la visite…');
    setText(tourLeft, tour.target !== undefined ? clock : '');
    return;
  }
  setText(tourPlace, `Lieu ${tour.index + 1} sur ${count} : ${placeTexts.places[stop.id].title}`);
  setText(tourLeft, tour.held || tour.reading ? `en pause · ${clock}`
    : tour.phase === 'walking' ? clock : 'chargement…');
}

// Go to any moment of the visit, as in a video: on foot's distance away it simply jumps, otherwise through the fade.
const SEEK_KEEP_PLACE = 6;
const SEEK_KEY_STEP = 10;
let seeking = null;
function seekTour(seconds) {
  const { index, time } = tourMoment(seconds);
  const here = tour.stops[tour.index];
  const there = tour.stops[index];
  closeDetail();
  if (tour.phase === 'walking' && tour.target === undefined && here?.chain === there.chain && Math.abs(time - tour.time) < SEEK_KEEP_PLACE) {
    tour.index = index;
    tour.time = time;
    setCurrentPlace(there.id);
    placeOnTour();
  } else {
    tour.target = index;
    tour.resumeAt = time;
    if (tour.phase !== 'darkening') tour.phase = 'next';
  }
  showTourProgress();
}

function setupSeek() {
  const tip = document.getElementById('tour-tip');
  const secondsAt = (event) => {
    const box = tourTrack.getBoundingClientRect();
    return THREE.MathUtils.clamp((event.clientX - box.left) / box.width, 0, 1) * tourLength();
  };
  const showTip = (seconds) => {
    const box = tourTrack.getBoundingClientRect();
    tip.textContent = `${formatClock(seconds)} · ${placeTexts.places[tour.stops[tourMoment(seconds).index].id].title}`;
    tip.hidden = false;
    const half = tip.offsetWidth / 2;
    const share = seconds / tourLength();
    // Stays over the bar, and on screen at both ends.
    tip.style.left = `${THREE.MathUtils.clamp(share * box.width, half - box.left + 8, innerWidth - box.left - half - 8)}px`;
  };
  tourTrack.addEventListener('pointerdown', (event) => {
    if (!tour) return;
    tourTrack.setPointerCapture(event.pointerId);
    seeking = secondsAt(event);
    showTourPosition(seeking);
    showTip(seeking);
  });
  tourTrack.addEventListener('pointermove', (event) => {
    if (!tour) return;
    const seconds = secondsAt(event);
    showTip(seconds);
    if (seeking !== null) {
      seeking = seconds;
      showTourPosition(seconds);
    }
  });
  tourTrack.addEventListener('pointerup', () => {
    if (!tour || seeking === null) return;
    const seconds = seeking;
    seeking = null;
    tip.hidden = true;
    seekTour(seconds);
  });
  tourTrack.addEventListener('pointercancel', () => {
    seeking = null;
    tip.hidden = true;
  });
  tourTrack.addEventListener('pointerleave', () => { if (seeking === null) tip.hidden = true; });
  tourTrack.addEventListener('keydown', (event) => {
    if (!tour || (event.code !== 'ArrowLeft' && event.code !== 'ArrowRight')) return;
    event.preventDefault();
    seekTour(tourClock() + (event.code === 'ArrowLeft' ? -SEEK_KEY_STEP : SEEK_KEY_STEP));
  });
}

const catmullRom = (a, b, c, d, t) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);

function placeOnTour() {
  const keyList = tour.stops[tour.index].keys;
  const last = keyList.length - 1;
  const time = Math.min(tour.time, last);
  const i = Math.floor(time);
  const key = (n) => keyList[THREE.MathUtils.clamp(n, 0, last)];
  const value = (field) => catmullRom(key(i - 1)[field], key(i)[field], key(i + 1)[field], key(i + 2)[field], time - i);
  camera.position.set(value(0), value(1), value(2));
  look.yaw = value(3);
  look.pitch = value(4);
  applyLook();
}

// Preloaded tour: every node the tour will ask for is computed from its key positions without loading
// anything, then kept on disk by the browser, so that the walk no longer waits for the network.
const PRELOAD_STORE = 'grainetiere-points-1';
// Walls hide part of each view, which leaves room for finer detail nearby than this count foresees.
const PRELOAD_MARGIN = 1.5;
const PRELOAD_KEY_STEP = 2;
const PRELOAD_PARALLEL = 12;
const PRELOAD_RETRIES = 4;
const PRELOAD_CHECKS = 64;
const gigabytes = (bytes) => `${(bytes / 1e9).toFixed(bytes < 1e10 ? 2 : 1).replace('.', ',')} Go`;

async function tourNodes() {
  const view = camera.clone();
  view.fov = tourFov();
  view.updateProjectionMatrix();
  const nodes = new Set();
  const dir = new THREE.Vector3();
  for (const stop of tourStops()) {
    for (let i = stop.from; i <= stop.to; i += PRELOAD_KEY_STEP) {
      const [x, y, z, yaw, pitch] = stop.keys[i];
      view.position.set(x, y, z);
      dir.set(Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch));
      view.lookAt(dir.add(view.position));
      view.updateMatrixWorld();
      cloud.collectNodes(view, target.height, cloud.pointBudget * PRELOAD_MARGIN, nodes);
    }
    await new Promise((resolve) => setTimeout(resolve));
  }
  return [...nodes];
}

let onEnter = () => {};
async function setupPreload() {
  const box = document.getElementById('prepare');
  const text = document.getElementById('prepare-text');
  const track = document.getElementById('prepare-track');
  const fill = document.getElementById('prepare-fill');
  const startButton = document.getElementById('prepare-start');
  const clearButton = document.getElementById('prepare-clear');
  box.hidden = false;
  if (!('caches' in window)) {
    text.textContent = 'Ce navigateur ne permet pas de garder la visite sur cet appareil.';
    return;
  }
  const detail = `${Math.round(cloud.pointBudget / 1e6)} millions de points`;
  text.textContent = 'Calcul des données nécessaires à la visite…';
  const nodes = await tourNodes();
  let stopped = false;

  // The browser's store can refuse to open or to list (private window, damaged or full store): the visit
  // itself does not need it and goes on over the network.
  const showStoreFailure = (error) => {
    console.error(error);
    cloud.store = null;
    track.hidden = true;
    startButton.hidden = true;
    clearButton.hidden = false;
    text.textContent = `Ce navigateur n'arrive pas à utiliser son espace de stockage (${error.name}). La visite reste possible, chargée au fil de l'eau. Effacer la visite gardée peut résoudre le problème ; sinon, essayez hors navigation privée ou dans un autre navigateur.`;
  };
  onEnter = () => { stopped = true; };

  const showReady = (failed) => {
    track.hidden = true;
    startButton.hidden = !failed;
    clearButton.hidden = false;
    text.textContent = failed
      ? `${failed} éléments n'ont pas pu être téléchargés : la visite les chargera au passage, ou réessayez.`
      : `La visite est prête, au détail de ${detail}.`;
    onEnter = () => {};
  };

  // One node at a time: Chromium refuses to list a whole store of this size ("Operation too large").
  const missingNodes = async () => {
    const store = await caches.open(PRELOAD_STORE);
    const kept = new Uint8Array(nodes.length);
    let next = 0;
    const checker = async () => {
      while (next < nodes.length) {
        const index = next++;
        if (await store.match(cloud.storeKey(nodes[index]))) kept[index] = 1;
      }
    };
    await Promise.all(Array.from({ length: PRELOAD_CHECKS }, checker));
    return { store, missing: nodes.filter((_node, index) => !kept[index]) };
  };

  const offer = async () => {
    const { store, missing } = await missingNodes();
    cloud.store = store;
    if (!missing.length) {
      showReady(0);
      return;
    }
    const bytes = missing.reduce((sum, node) => sum + node.length, 0);
    const room = await navigator.storage?.estimate?.().catch(() => null);
    const free = room?.quota ? room.quota - room.usage : Infinity;
    const enough = free >= bytes;
    clearButton.hidden = missing.length === nodes.length;
    text.textContent = `${chosenPlaces ? 'Visite des lieux choisis' : 'Visite complète'} au détail de ${detail}. `
      + `Espace disque nécessaire : ${gigabytes(bytes)}, gardés dans ce navigateur jusqu'à ce que vous les effaciez.`
      + (Number.isFinite(free) ? ` Espace disponible pour le navigateur : ${gigabytes(free)}.` : '')
      + (enough ? '' : ' Ce n\'est pas suffisant : libérez de la place ou choisissez un détail plus faible.');
    startButton.textContent = `⬇ Télécharger ${gigabytes(bytes)} puis visiter`;
    startButton.disabled = !enough;
    startButton.hidden = false;
  };

  const download = async () => {
    const { store, missing } = await missingNodes();
    await navigator.storage?.persist?.().catch(() => {});
    const total = missing.reduce((sum, node) => sum + node.length, 0);
    const began = performance.now();
    let done = 0, failed = 0, next = 0, full = false;
    startButton.hidden = true;
    clearButton.hidden = true;
    track.hidden = false;
    const show = () => {
      const share = total ? done / total : 1;
      fill.style.transform = `scaleX(${share})`;
      const rest = share > 0.005 ? ((performance.now() - began) / 1000) * (1 - share) / share : null;
      text.textContent = `Téléchargement : ${gigabytes(done)} sur ${gigabytes(total)}${rest === null ? '' : `, encore ${formatDuration(rest)}`}. Gardez cet onglet ouvert.`;
    };
    show();
    const worker = async () => {
      while (next < missing.length && !stopped && !full) {
        const node = missing[next++];
        for (let attempt = 1; ; attempt++) {
          try {
            const data = await cloud.fetchNode(node);
            await store.put(cloud.storeKey(node), new Response(data));
            done += node.length;
            break;
          } catch (error) {
            if (error.name === 'QuotaExceededError') full = true;
            if (full || attempt === PRELOAD_RETRIES) {
              failed += 1;
              break;
            }
          }
        }
        show();
      }
    };
    await Promise.all(Array.from({ length: PRELOAD_PARALLEL }, worker));
    if (stopped) return;
    if (full) {
      track.hidden = true;
      clearButton.hidden = false;
      text.textContent = "L'espace accordé par le navigateur est plein : choisissez un détail plus faible (paramètre detail de l'adresse).";
      return;
    }
    showReady(failed);
  };

  startButton.addEventListener('click', () => download().catch(showStoreFailure));
  clearButton.addEventListener('click', async () => {
    cloud.store = null;
    onEnter = () => { stopped = true; };
    clearButton.hidden = true;
    try {
      await caches.delete(PRELOAD_STORE);
      await offer();
    } catch (error) {
      showStoreFailure(error);
    }
  });
  await offer().catch(showStoreFailure);
}

// Hand the next place's first view to the loader ahead of time, so that the cut finds it ready.
function warmNextPlace() {
  const next = tour.stops[tour.target ?? (tour.index + 1) % tour.stops.length];
  const view = camera.clone();
  const [x, y, z, yaw, pitch] = next.keys[next.from];
  view.position.set(x, y, z);
  view.lookAt(x + Math.cos(pitch) * Math.cos(yaw), y + Math.cos(pitch) * Math.sin(yaw), z + Math.sin(pitch));
  view.updateMatrixWorld();
  const nodes = new Set();
  cloud.collectNodes(view, target.height, cloud.pointBudget, nodes);
  cloud.warm(nodes);
}

function arriveAtNextPlace() {
  tour.index = tour.target ?? (tour.index + 1) % tour.stops.length;
  tour.target = undefined;
  const stop = tour.stops[tour.index];
  tour.time = tour.resumeAt ?? stop.from;
  tour.resumeAt = undefined;
  tour.warmed = false;
  // What hid things from the last view says nothing about this one.
  cloud.occlusion = null;
  cloud.warm([]);
  setCurrentPlace(stop.id);
  drawRoute();
  placeOnTour();
  tour.phase = 'loading';
  tour.clock = 0;
}

function holdLastPicture() {
  draw();
  freezeLayer.width = canvas.width;
  freezeLayer.height = canvas.height;
  freezeLayer.getContext('2d').drawImage(canvas, 0, 0);
  freezeLayer.classList.add('held');
}

const TOUR_SHOW_EVERY = 250;
let tourShownAt = 0;
function stepTour(dt) {
  tour.clock += dt;
  if (tour.phase === 'next') {
    if (cloud.store && !headset?.active) {
      holdLastPicture();
      arriveAtNextPlace();
    } else {
      fadeLayer.classList.add('dark');
      tour.phase = 'darkening';
      tour.clock = 0;
    }
  } else if (tour.phase === 'darkening' && tour.clock > TOUR_FADE) {
    arriveAtNextPlace();
  } else if (tour.phase === 'loading') {
    const settled = !cloud.loading && !cloud.pending;
    if (cloud.store ? settled || tour.clock > DISSOLVE_MAX_WAIT : (settled && tour.clock > 0.5) || tour.clock > TOUR_MAX_WAIT) {
      fadeLayer.classList.remove('dark');
      freezeLayer.classList.remove('held');
      tour.phase = 'walking';
    }
  } else if (tour.phase === 'walking' && !tour.held && !tour.reading) {
    tour.time += dt * speed / TOUR_SPEED;
    placeOnTour();
    const stop = tour.stops[tour.index];
    const next = tour.stops[tour.index + 1];
    const onFoot = next && next.chain === stop.chain && next.from === stop.to;
    if (!onFoot && !tour.warmed && stop.to - tour.time < WARM_LEAD) {
      tour.warmed = true;
      warmNextPlace();
    }
    if (tour.time >= stop.to) {
      if (onFoot) {
        tour.index += 1;
        setCurrentPlace(next.id);
      } else {
        tour.phase = 'next';
      }
    }
  }
  const now = performance.now();
  if (now - tourShownAt > TOUR_SHOW_EVERY) {
    tourShownAt = now;
    showTourProgress();
  }
}

// Where we are, for the title, the texts and the map: the place of the nearest point of the tour, or of the
// nearest scanner position in rooms the tour leaves out. Heights count double: floors are close together.
const PLACE_CHECK_EVERY = 500;
const OVERVIEW_HEIGHT = 14;
const PLACE_REACH = 30;
const OFF_TOUR_ZONES = { chambres: 'chambres', chambres_n1: 'chambres', chambres_n1_esc: 'chambres', chambres_n1_sdb: 'chambres', buanderie: 'buanderie', buanderie_jc: 'buanderie', buanderie_n1: 'buanderie' };
let placeMarks = [];
let currentPlace = null;
let placeSeen = null;
let placeCheckAt = 0;
function buildPlaceMarks(abbey) {
  placeMarks = tourPlan.places.flatMap((place) => {
    const keys = tourPlan.chains[place.chain].slice(place.from, place.to + 1);
    return keys.filter((_, i) => i % 3 === 0).map(([x, y, z]) => ({ x, y, z, id: place.id }));
  });
  for (const zone of abbey.zones) {
    if (!OFF_TOUR_ZONES[zone.id]) continue;
    for (const { position: [x, y, z] } of zone.stations) placeMarks.push({ x, y, z, id: OFF_TOUR_ZONES[zone.id] });
  }
}

function placeAt({ x, y, z }) {
  if (z > OVERVIEW_HEIGHT) return null;
  let nearest = null;
  let best = PLACE_REACH * PLACE_REACH;
  for (const mark of placeMarks) {
    const d = (mark.x - x) ** 2 + (mark.y - y) ** 2 + 4 * (mark.z - z) ** 2;
    if (d < best) {
      best = d;
      nearest = mark.id;
    }
  }
  return nearest;
}

function watchPlace(now) {
  if (tour || flight || now - placeCheckAt < PLACE_CHECK_EVERY || !document.getElementById('welcome').hidden) return;
  placeCheckAt = now;
  const here = placeAt(camera.position);
  // Twice in a row, so that walking along a wall does not make the title flicker.
  if (here !== currentPlace && here === placeSeen) setCurrentPlace(here);
  placeSeen = here;
}

// In the middle of the screen at first, then aside in the top corner, and gone.
const placeTitle = document.getElementById('place-title');
const PLACE_TITLE_CENTERED = 5000;
const PLACE_TITLE_ASIDE = 5000;
let placeTitleTimers = [];
function showPlaceTitle(text) {
  document.getElementById('place-name').textContent = text.title;
  document.getElementById('place-role').textContent = text.role;
  placeTitleTimers.forEach(clearTimeout);
  placeTitle.style.transition = 'none';
  placeTitle.style.transform = 'none';
  placeTitle.classList.add('centered');
  const box = placeTitle.getBoundingClientRect();
  placeTitle.style.transform = `translate(${innerWidth / 2 - box.left - box.width / 2}px, ${innerHeight / 2 - box.top - box.height / 2}px)`;
  placeTitle.getBoundingClientRect();
  placeTitle.style.transition = '';
  placeTitle.classList.add('shown');
  placeTitleTimers = [
    setTimeout(() => {
      placeTitle.classList.remove('centered');
      placeTitle.style.transform = 'none';
    }, PLACE_TITLE_CENTERED),
    setTimeout(() => placeTitle.classList.remove('shown'), PLACE_TITLE_CENTERED + PLACE_TITLE_ASIDE),
  ];
}

function setCurrentPlace(id) {
  placeSeen = id;
  if (id === currentPlace) return;
  currentPlace = id;
  showStory();
  drawRoute();
  if (tour) document.getElementById('zone').value = `${PLACE_PREFIX}${id}`;
  if (!id) return;
  showPlaceTitle(placeTexts.places[id]);
}

// Texts of the guided visit: a few lines for each place, and the longer extract on demand. The tour waits
// while it is being read, otherwise the text would change under the reader's eyes.
const story = document.getElementById('story');
const storyToggle = document.getElementById('story-toggle');
const storyTitle = document.getElementById('story-title');
const storyShort = document.getElementById('story-short');
const storyDetail = document.getElementById('story-detail');
const storyMore = document.getElementById('story-more');
document.getElementById('story-credit').textContent = placeTexts.credit;

function closeDetail() {
  storyDetail.hidden = true;
  if (tour) tour.reading = false;
  showStoryMore();
}

function showStoryMore() {
  const open = !storyDetail.hidden;
  storyMore.textContent = open ? (tour ? 'Réduire et reprendre la visite' : 'Réduire') : 'Lire le texte détaillé';
  storyMore.setAttribute('aria-expanded', String(open));
}

function showStory() {
  const text = placeTexts.places[currentPlace ?? 'abords'];
  storyTitle.textContent = currentPlace ? text.title : "L'abbaye de la Grainetière";
  storyShort.textContent = text.short;
  storyDetail.replaceChildren(...text.detail.map((paragraph) => {
    const p = document.createElement('p');
    p.textContent = paragraph;
    return p;
  }));
  storyMore.hidden = !text.detail.length;
  closeDetail();
}

function setStoryOpen(open) {
  story.hidden = !open;
  document.body.classList.toggle('story-open', open);
  storyToggle.setAttribute('aria-pressed', String(open));
  storyToggle.textContent = open ? 'Masquer les explications' : 'Afficher les explications';
  if (!open) closeDetail();
  try { localStorage.setItem('storyOpen', open ? '1' : ''); } catch { /* private mode */ }
}

function setupStory() {
  storyToggle.addEventListener('click', () => setStoryOpen(story.hidden));
  document.getElementById('story-close').addEventListener('click', () => setStoryOpen(false));
  storyMore.addEventListener('click', () => {
    storyDetail.hidden = !storyDetail.hidden;
    if (tour) tour.reading = !storyDetail.hidden;
    showStoryMore();
    story.scrollTop = 0;
  });
  showStory();
  let remembered = false;
  try { remembered = localStorage.getItem('storyOpen') === '1'; } catch { /* private mode */ }
  setStoryOpen(remembered);
}

// Small model of the abbey (see pipeline/minimap.py), with the route, the visitor and where they look.
const SVG_NS = 'http://www.w3.org/2000/svg';
const MAP_EVERY = 100;
const MAP_LOOK_REACH = 7;
const MAP_LOOK_SPREAD = 0.6;
const ROUTE_KEY_STEP = 4;
const mapRoute = document.getElementById('map-route');
const mapHere = document.getElementById('map-here');
const mapMarker = document.getElementById('map-marker');
const mapLook = document.getElementById('map-look');
const mapCos = Math.cos(mapProjection.axis);
const mapSin = Math.sin(mapProjection.axis);
let mapDrawnAt = 0;

function onMap(x, y, z) {
  const u = x * mapCos + y * mapSin;
  const v = -x * mapSin + y * mapCos;
  return [
    ((u - v) * Math.cos(Math.PI / 6) - mapProjection.left) * mapProjection.scale + mapProjection.pad,
    (-(u + v) * 0.5 - z - mapProjection.high) * mapProjection.scale + mapProjection.pad,
  ];
}

function setupMap() {
  document.getElementById('map-image').src = mapImageUrl;
  document.getElementById('map-svg').setAttribute('viewBox', `0 0 ${mapProjection.width} ${mapProjection.height}`);
  for (const keys of tourPlan.chains) {
    const line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('points', keys.filter((_, i) => i % ROUTE_KEY_STEP === 0).map(([x, y, z]) => onMap(x, y, z).map((n) => n.toFixed(1)).join(',')).join(' '));
    mapRoute.append(line);
  }
}

function drawRoute() {
  const place = tourPlan.places.find((p) => p.id === currentPlace);
  if (!tour || !place) {
    mapHere.setAttribute('points', '');
    return;
  }
  const keys = tourPlan.chains[place.chain].slice(place.from, place.to + 1);
  mapHere.setAttribute('points', keys.filter((_, i) => i % ROUTE_KEY_STEP === 0).map(([x, y, z]) => onMap(x, y, z).map((n) => n.toFixed(1)).join(',')).join(' '));
}

function drawMap(now) {
  if (now - mapDrawnAt < MAP_EVERY) return;
  mapDrawnAt = now;
  const { x, y, z } = camera.position;
  const [px, py] = onMap(x, y, z);
  mapMarker.setAttribute('cx', px.toFixed(1));
  mapMarker.setAttribute('cy', py.toFixed(1));
  const side = (turn) => onMap(x + Math.cos(look.yaw + turn) * MAP_LOOK_REACH, y + Math.sin(look.yaw + turn) * MAP_LOOK_REACH, z).map((n) => n.toFixed(1)).join(',');
  mapLook.setAttribute('points', `${px.toFixed(1)},${py.toFixed(1)} ${side(-MAP_LOOK_SPREAD)} ${side(MAP_LOOK_SPREAD)}`);
  mapRoute.classList.toggle('shown', Boolean(tour));
}

const movement = new THREE.Vector3();
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
function step(dt) {
  if (Math.abs(camera.fov - fovGoal) > 0.01) {
    camera.fov += (fovGoal - camera.fov) * (1 - Math.exp(-dt * 1.5));
    camera.updateProjectionMatrix();
    dirty = true;
  }
  if (tour) {
    stepTour(dt);
    return;
  }
  if (flight) {
    flight.t = Math.min(flight.t + dt / flight.duration, 1);
    const k = flight.t * flight.t * (3 - 2 * flight.t);
    camera.position.lerpVectors(flight.from, flight.to, k);
    if (flight.look) {
      look.yaw = flight.look.yaw + flight.look.turn * k;
      look.pitch = flight.look.pitch + flight.look.rise * k;
      applyLook();
    }
    camera.updateMatrixWorld();
    dirty = true;
    if (flight.t === 1) flight = null;
    return;
  }
  movement.set(0, 0, 0);
  camera.getWorldDirection(forward);
  right.crossVectors(forward, camera.up).normalize();
  for (const code of keys) {
    const move = KEY_MOVES[code];
    if (move) {
      movement.addScaledVector(forward, move[0]);
      movement.addScaledVector(right, move[1]);
    }
    if (VERTICAL[code]) movement.z += VERTICAL[code];
  }
  if (movement.lengthSq() > 0) movement.normalize();
  const boost = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 4 : 1;
  movement.multiplyScalar(speed * boost);
  velocity.lerp(movement, 1 - Math.exp(-dt * 10));
  if (velocity.lengthSq() > 1e-5) {
    camera.position.addScaledVector(velocity, dt);
    camera.updateMatrixWorld();
    dirty = true;
  } else {
    velocity.set(0, 0, 0);
  }
}

// Phones differ too much for one setting: follow the frame rate actually reached while moving.
const TOUCH_BUDGET = { start: 5_000_000, min: 2_000_000, max: 12_000_000 };
let adaptFrames = 0;
let adaptStart = 0;
let adaptLast = 0;
function adaptBudget(now) {
  if (!isTouch || chosenDetail) return;
  // A pause between two pictures means the view was at rest, not that the phone is slow.
  if (now - adaptLast > 250) {
    adaptStart = now;
    adaptFrames = 0;
  }
  adaptLast = now;
  adaptFrames += 1;
  if (now - adaptStart < 1500 || adaptFrames < 10) return;
  const rate = (adaptFrames * 1000) / (now - adaptStart);
  if (rate < 22) cloud.pointBudget = Math.max(TOUCH_BUDGET.min, cloud.pointBudget * 0.8);
  else if (rate > 40) cloud.pointBudget = Math.min(TOUCH_BUDGET.max, cloud.pointBudget * 1.15);
  adaptStart = now;
  adaptFrames = 0;
  dirty = true;
}

// Moving slowly, the eye sees every picture that misses its turn at the screen, even at 50 i/s on average:
// on a 60 Hz screen, that is ten jolts a second. So pictures come at a steady pace, every other refresh on the
// fastest screens, and when too many are late during the tour, the load is lowered for good until they stop.
const PACE_SAMPLES = 60;
const LATE_SHARE = 0.04;
const LATE_WINDOW = 180;
const DESKTOP_MIN_BUDGET = 12_000_000;
const MIN_PIXEL_RATIO = 1;
const LOAD_STEP = 0.85;
const RATIO_STEP = 0.25;
const paceIntervals = [];
let refreshTime = 1000 / 60;
let refreshEvery = 1;
let refreshCount = 0;
let lastRefresh = 0;
let lastPicture = 0;
let picturesSeen = 0;
let picturesLate = 0;
let lateShare = 0;
let detailChanged = options.has('detail');

// True when this screen refresh should show nothing.
function skipRefresh(now) {
  const gap = now - lastRefresh;
  lastRefresh = now;
  if (gap < 250) paceIntervals.push(gap);
  if (paceIntervals.length >= PACE_SAMPLES) {
    refreshTime = paceIntervals.sort((a, b) => a - b)[Math.floor(PACE_SAMPLES / 10)];
    refreshEvery = refreshTime < 12 ? 2 : 1;
    paceIntervals.length = 0;
  }
  refreshCount += 1;
  return refreshCount % refreshEvery !== 0;
}

function lightenLoad() {
  if (cloud.pointBudget > DESKTOP_MIN_BUDGET) {
    cloud.pointBudget = Math.max(DESKTOP_MIN_BUDGET, cloud.pointBudget * LOAD_STEP);
    document.getElementById('detail').value = cloud.pointBudget / 1e6;
    stale = true;
  } else if (pixelRatio > MIN_PIXEL_RATIO) {
    pixelRatio = Math.max(MIN_PIXEL_RATIO, pixelRatio - RATIO_STEP);
    renderer.setPixelRatio(pixelRatio);
    resize();
  }
}

function watchPace(now) {
  const gap = now - lastPicture;
  lastPicture = now;
  if (isTouch || tour?.phase !== 'walking' || tour.held || tour.reading || gap > 250) return;
  picturesSeen += 1;
  if (gap > 1.5 * refreshTime * refreshEvery) picturesLate += 1;
  if (picturesSeen < LATE_WINDOW) return;
  lateShare = picturesLate / picturesSeen;
  if (lateShare > LATE_SHARE && !detailChanged) lightenLoad();
  picturesSeen = picturesLate = 0;
}

function runPass(material, output) {
  quad.material = material;
  renderer.setRenderTarget(output);
  renderer.render(quadScene, quadCamera);
}

function draw() {
  renderer.setRenderTarget(target);
  renderer.clear();
  renderer.render(scene, camera);
  if (!improved) {
    runPass(edl, null);
    return;
  }
  runPass(seedPass, fillA);
  for (const radius of FILL_RADII) {
    fillPass.uniforms.tPrev.value = fillA.texture;
    fillPass.uniforms.uRadius.value = radius;
    runPass(fillPass, fillB);
    [fillA, fillB] = [fillB, fillA];
  }
  const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  shadePass.uniforms.tFill.value = fillA.texture;
  shadePass.uniforms.uTan.value.set(tan * camera.aspect, tan);
  shadePass.uniforms.uViewToWorld.value.setFromMatrix4(camera.matrixWorld);
  runPass(shadePass, null);
  refreshOcclusion();
}

function refreshOcclusion() {
  const now = performance.now();
  if (occlusionBusy || now - occlusionAt < 400) return;
  occlusionBusy = true;
  occlusionAt = now;
  reducePass.uniforms.tPrev.value = fillA.texture;
  reducePass.uniforms.uTexel.value.set(1 / fillA.width, 1 / fillA.height);
  runPass(reducePass, reduceA);
  reducePass.uniforms.tPrev.value = reduceA.texture;
  reducePass.uniforms.uTexel.value.set(1 / reduceA.width, 1 / reduceA.height);
  runPass(reducePass, reduceB);
  renderer.setRenderTarget(null);
  const { width, height } = reduceB;
  const pixels = new Float32Array(width * height * 4);
  const seen = {
    width,
    height,
    view: camera.matrixWorldInverse.clone(),
    projection: camera.projectionMatrix.clone(),
  };
  renderer.readRenderTargetPixelsAsync(reduceB, 0, 0, width, height, pixels).then(() => {
    occlusionBusy = false;
    if (!improved || !cloud || headset?.active) return;
    seen.distance = new Float32Array(width * height);
    let moved = 0;
    const before = cloud.occlusion?.distance;
    for (let i = 0; i < seen.distance.length; i++) {
      seen.distance[i] = pixels[i * 4 + 3];
      if (!before || before.length !== seen.distance.length || Math.abs(before[i] - seen.distance[i]) > 0.5) moved += 1;
    }
    cloud.occlusion = seen;
    // Only ask for a new selection if the picture really changed, so that the loop settles.
    if (moved > seen.distance.length * 0.01) stale = true;
  }).catch(() => { occlusionBusy = false; });
}

const SETTLE_TIME = 4;
let previous = performance.now();
let lastUpdate = 0;
let frames = 0;
let lastFps = previous;
let fps = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (headset?.active || skipRefresh(now)) return;
  const dt = Math.min((now - previous) / 1000, 0.1);
  previous = now;
  step(dt);
  if (!cloud) return;
  cloud.settle(SETTLE_TIME);
  watchPlace(now);
  drawMap(now);
  // A change seen between two selection passes must still trigger the next one.
  if (dirty) stale = true;
  if (now - lastUpdate > 120 && (stale || cloud.loading || cloud.pending)) {
    cloud.update(camera, target.height);
    lastUpdate = now;
    stale = false;
    dirty = true;
  }
  if (!dirty) return;
  dirty = false;
  draw();
  cleanup?.drawOver();
  frames += 1;
  watchPace(now);
  adaptBudget(now);
  if (now - lastFps > 500) {
    fps = Math.round((frames * 1000) / (now - lastFps));
    frames = 0;
    lastFps = now;
    const million = (cloud.visiblePoints / 1e6).toFixed(1);
    const late = lateShare > 0 ? ` · ${Math.round(lateShare * 100)} % en retard` : '';
    stats.textContent = `${million} M points · ${fps} i/s${late}${cloud.loading ? ' · chargement…' : ''}`;
  }
}

let music;
let ready;
function setupMusic() {
  const mute = document.getElementById('mute');
  const dialog = document.getElementById('music-dialog');
  const list = document.getElementById('music-tracks');
  const volume = document.getElementById('music-volume');
  const welcome = document.getElementById('welcome');
  const show = () => {
    mute.setAttribute('aria-pressed', String(!music.playing));
    mute.setAttribute('aria-label', music.playing ? 'Couper la musique' : 'Lancer la musique');
    mute.title = mute.getAttribute('aria-label');
    mute.classList.toggle('muted', !music.playing);
    for (const button of list.children) {
      button.setAttribute('aria-pressed', String(music.playing && button.track === music.current));
    }
  };
  music = new Music(show);
  list.replaceChildren(...music.tracks.map((track) => {
    const button = document.createElement('button');
    button.textContent = track.name;
    button.track = track;
    button.addEventListener('click', () => {
      music.playing = true;
      music.choose(track);
    });
    return button;
  }));
  try {
    if (localStorage.getItem('musicVolume') !== null) volume.value = localStorage.getItem('musicVolume');
  } catch { /* private mode */ }
  music.volume = Number(volume.value);
  show();
  let hiddenWhilePlaying = false;
  mute.addEventListener('click', () => (music.playing ? music.pause() : music.play()));
  document.getElementById('music-open').addEventListener('click', () => dialog.showModal());
  document.getElementById('music-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  volume.addEventListener('input', () => {
    music.setVolume(Number(volume.value));
    try { localStorage.setItem('musicVolume', volume.value); } catch { /* private mode */ }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && music.playing) {
      hiddenWhilePlaying = true;
      music.pause();
    } else if (!document.hidden && hiddenWhilePlaying) {
      hiddenWhilePlaying = false;
      music.play();
    }
  });
  let guided = false;
  const stepMode = document.getElementById('step-mode');
  const stepMusic = document.getElementById('step-music');
  const choose = (wantsTour) => {
    guided = wantsTour;
    stepMode.hidden = true;
    stepMusic.hidden = false;
    document.getElementById('enter-music').focus();
  };
  const total = tourPlan.places.reduce((sum, place) => sum + place.to - place.from, 0);
  document.getElementById('guided-note').textContent = `Un parcours de ${Math.round(total / 60)} minutes, du dehors jusqu'au cœur de l'abbaye.`;
  document.getElementById('enter-guided').addEventListener('click', () => choose(true));
  document.getElementById('enter-free').addEventListener('click', () => choose(false));
  const enter = (withMusic) => {
    welcome.hidden = true;
    if (withMusic) music.play();
    canvas.focus();
    onEnter();
    if (!document.getElementById('vr-choice').hidden && document.getElementById('vr-wanted').checked) enterHeadset();
    if (guided) ready.then(() => { if (cloud && !tour) startTour(); });
    callForGuide();
  };
  document.getElementById('enter-music').addEventListener('click', () => enter(true));
  document.getElementById('enter-silent').addEventListener('click', () => enter(false));
  document.getElementById('enter-guided').focus();
}

// A tour of the interface itself: each pop-in points at one control and says what it is for.
const GUIDE_STEPS = [
  { target: '#tour', title: 'La visite guidée', text: 'Lance un parcours commenté de toute l’abbaye, et le met en pause à tout moment. Un clic dans l’image ou un déplacement vous rend la main ; ce bouton vous ramène ensuite à l’instant exact où vous en étiez.' },
  { target: '#tour-progress', title: 'L’avancement de la visite', text: 'Comme pour une vidéo, glissez le curseur jaune pour aller à n’importe quel moment. De chaque côté, les boutons mènent au lieu précédent et au lieu suivant.' },
  { target: '.speed', title: 'La vitesse de défilement', text: 'Règle l’allure de la visite guidée ou de vos déplacements. La molette de la souris et les touches + et − font de même. Sur un pavé tactile, pincer zoome dans l’image.' },
  { target: '#vr-open', title: 'Le casque de réalité virtuelle', text: 'Passe la visite dans le casque et la commande aux manettes. Une aide y rappelle chaque bouton.' },
  { target: '#story-toggle', title: 'Les explications', text: 'Affiche un court texte sur le lieu où vous êtes, avec une version détaillée à la demande. La visite guidée attend pendant la lecture du texte détaillé.' },
  { target: '#mute', title: 'La musique', text: 'Ce bouton la lance ou la coupe, le bouton voisin permet de choisir un morceau et le volume.' },
  { target: '.minimap', title: 'Le plan', text: 'Le point orange indique où vous êtes, et le triangle dans quelle direction vous regardez. Pendant la visite guidée, le parcours s’y dessine.' },
  { target: '#goto', title: 'Se rendre à', text: 'Emmène directement vers un lieu de la visite, ou vers une zone du relevé.' },
  { target: '#fine-settings', title: 'Les réglages fins', text: 'Trois profils s’y trouvent : Fluide privilégie un mouvement régulier, Détaillé le nombre de points, pour un ordinateur puissant. Les curseurs permettent d’aller plus loin.' },
  { target: '#sky-box', title: 'La lumière du ciel', text: 'Par défaut, le ciel et le soleil suivent l’heure réelle à l’abbaye. Le curseur permet de choisir un autre moment de la journée.' },
  { target: '#hide-traces', title: 'Les traces de la captation', text: 'Le relevé a gardé les silhouettes et les trépieds de l’équipe qui l’a réalisé. Ce bouton masque ceux qu’une détection automatique a reconnus : une partie reste visible.' },
  { target: '#view', title: 'Se déplacer soi-même', text: isTouch
    ? 'Un doigt pour regarder autour de vous, deux doigts pour avancer (pincer) et vous déplacer (glisser).'
    : 'Glissez dans l’image pour regarder autour de vous. Les touches Z, Q, S, D ou les flèches font avancer, A et E font monter et descendre, Maj accélère.' },
];
const GUIDE_MARGIN = 8;
function setupGuide() {
  const box = document.getElementById('guide');
  const ring = document.getElementById('guide-ring');
  const card = document.getElementById('guide-card');
  const next = document.getElementById('guide-next');
  const previous = document.getElementById('guide-previous');
  let steps = [];
  let at = 0;
  let heldByGuide = false;
  const show = () => {
    const step = steps[at];
    document.getElementById('guide-title').textContent = step.title;
    document.getElementById('guide-text').textContent = step.text;
    document.getElementById('guide-count').textContent = `${at + 1} / ${steps.length}`;
    previous.disabled = at === 0;
    next.textContent = at === steps.length - 1 ? 'Terminer' : 'Suivant';
    const whole = step.target === '#view';
    const rect = document.querySelector(step.target).getBoundingClientRect();
    ring.style.display = '';
    ring.style.left = whole ? '0' : `${rect.left - 4}px`;
    ring.style.top = whole ? '0' : `${rect.top - 4}px`;
    ring.style.width = whole ? '100%' : `${rect.width + 8}px`;
    ring.style.height = whole ? '100%' : `${rect.height + 8}px`;
    const size = card.getBoundingClientRect();
    if (whole) {
      card.style.left = `${(innerWidth - size.width) / 2}px`;
      card.style.top = `${(innerHeight - size.height) / 2}px`;
      return;
    }
    // Beside the control for the tall ones on the right, otherwise above or below it.
    const fitsBeside = rect.height > innerHeight / 3 && rect.left > size.width + 2 * GUIDE_MARGIN;
    const left = fitsBeside ? rect.left - size.width - 2 * GUIDE_MARGIN : rect.left + rect.width / 2 - size.width / 2;
    const top = fitsBeside ? rect.top : rect.top > size.height + 3 * GUIDE_MARGIN ? rect.top - size.height - 2 * GUIDE_MARGIN : rect.bottom + 2 * GUIDE_MARGIN;
    card.style.left = `${THREE.MathUtils.clamp(left, GUIDE_MARGIN, innerWidth - size.width - GUIDE_MARGIN)}px`;
    card.style.top = `${THREE.MathUtils.clamp(top, GUIDE_MARGIN, innerHeight - size.height - GUIDE_MARGIN)}px`;
  };
  const close = () => {
    box.hidden = true;
    if (heldByGuide && tour) tour.held = false;
    heldByGuide = false;
    if (tour) {
      showTourButton();
      showTourProgress();
    }
    canvas.focus();
  };
  const go = (delta) => {
    at += delta;
    if (at >= steps.length) close();
    else show();
  };
  document.getElementById('guide-open').addEventListener('click', () => {
    document.getElementById('guide-open').classList.remove('call');
    try { localStorage.setItem('guideSeen', '1'); } catch { /* private mode */ }
    if (tour && !tour.held) {
      tour.held = true;
      heldByGuide = true;
      showTourButton();
      showTourProgress();
    }
    box.hidden = false;
    // What is not on screen right now (the map on a phone, the progress bar outside the tour) is left out.
    steps = GUIDE_STEPS.filter((step) => document.querySelector(step.target)?.getClientRects().length);
    at = 0;
    show();
    next.focus();
  });
  next.addEventListener('click', () => go(1));
  previous.addEventListener('click', () => go(-1));
  document.getElementById('guide-close').addEventListener('click', close);
  addEventListener('keydown', (event) => { if (event.key === 'Escape' && !box.hidden) close(); });
  addEventListener('resize', () => { if (!box.hidden) show(); });
}

function callForGuide() {
  let seen = false;
  try { seen = localStorage.getItem('guideSeen') === '1'; } catch { /* private mode */ }
  if (!seen) document.getElementById('guide-open').classList.add('call');
}

// In a headset's own browser, or a computer with one connected: the visit can go on in there (see vr.js).
async function setupHeadset() {
  if (!await navigator.xr?.isSessionSupported('immersive-vr').catch(() => false)) return;
  const { Headset } = await import('./vr.js');
  headset = new Headset({
    renderer,
    scene,
    camera,
    look,
    applyLook,
    cloud,
    step,
    watchPlace,
    toggleTour,
    jumpTour,
    stopTour,
    music,
    fadeLayer,
    skyShader: SKY_SHADER,
    skyUniforms: shadePass.uniforms,
    settleTime: SETTLE_TIME,
    baseUrl,
    tourPlan,
    get tour() { return tour; },
    get speed() { return speed; },
    get placeText() { return currentPlace && placeTexts.places[currentPlace]; },
    leftHeadset() {
      if (improved) cloud.occlusion = null;
      flight = null;
      resize();
      stale = dirty = true;
    },
  });
  document.getElementById('vr-open').hidden = false;
  document.getElementById('vr-choice').hidden = false;
  document.getElementById('vr-open').addEventListener('click', enterHeadset);
}

function enterHeadset() {
  if (!headset || headset.active) return;
  flight = null;
  // High above the abbey is no place to find oneself in a headset: start on the ground, where the tour does.
  if (!tour && camera.position.z > OVERVIEW_HEIGHT) {
    const first = tourPlan.places[0];
    const [x, y, z, yaw, pitch] = tourPlan.chains[first.chain][first.from];
    camera.position.set(x, y, z);
    look.yaw = yaw;
    look.pitch = pitch;
    applyLook();
    setSpeed(WALKING_SPEED);
  }
  cloud.occlusion = null;
  headset.enter().catch((error) => {
    console.error(error);
    showError("Le casque n'a pas pu démarrer. Réessayez depuis le navigateur du casque.");
  });
}

async function start() {
  const abbey = await loadAbbey(baseUrl);
  if (!isAdmin) abbey.zones = abbey.zones.filter((zone) => !PRIVATE_ZONES.includes(zone.id));
  cloud = new PointCloud(abbey, baseUrl, {
    pointBudget: chosenDetail ? chosenDetail * 1e6 : isTouch ? TOUCH_BUDGET.start : 16_000_000,
    onChange: () => { dirty = true; },
    onTrouble: showDataTrouble,
  });
  scene.add(cloud.group);

  const params = new URLSearchParams(location.search);
  const startZone = abbey.zones.find((z) => z.id === params.get('zone'));
  const overview = overviewOf(abbey);
  abbeyZones = abbey.zones;
  buildPlaceMarks(abbey);
  buildUi(abbey, startZone, overview);
  // A view shared from the cleaning tool (see cleanup.js): position, direction and zoom.
  const shared = params.get('vue')?.split(',').map(Number);
  if (shared?.length === 6 && shared.every(Number.isFinite)) {
    camera.position.set(shared[0], shared[1], shared[2]);
    look.yaw = shared[3];
    look.pitch = shared[4];
    camera.fov = fovGoal = THREE.MathUtils.clamp(shared[5], ZOOM_FOV.min, ZOOM_FOV.max);
  } else if (startZone) {
    const startStation = startZone.stations.find((s) => s.name.endsWith(params.get('station'))) ?? startZone.stations[0];
    camera.position.set(...startStation.position);
    const others = startZone.stations.reduce((sum, s) => sum.add(new THREE.Vector3(...s.position)), new THREE.Vector3())
      .divideScalar(startZone.stations.length)
      .sub(camera.position);
    look.yaw = Number(params.get('yaw') ?? Math.atan2(others.y, others.x));
    look.pitch = Number(params.get('pitch') ?? 0);
  } else {
    camera.position.set(...overview.position);
    look.yaw = overview.yaw;
    look.pitch = overview.pitch;
    setSpeed(OVERVIEW_SPEED);
  }
  resize();
  applyLook();
  if (options.has('nettoyage') && !isTouch && abbey.peopleMask) {
    const { setupCleanup } = await import('./cleanup.js');
    cleanup = setupCleanup({ canvas, camera, renderer, cloud, look });
    document.getElementById('enter-free').click();
    document.getElementById('enter-silent').click();
  }
  await setupHeadset();
  if (preloadWanted) await setupPreload();
  else if (options.has('precharger')) {
    document.getElementById('prepare').hidden = false;
    document.getElementById('prepare-text').textContent = "Le téléchargement préalable de la visite n'est proposé que sur ordinateur.";
  }
}

// Safari ignores the viewport limits: a pinch on a panel would zoom the whole page.
for (const type of ['gesturestart', 'gesturechange', 'dblclick']) {
  document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
}
setSpeed(speed);
setupMusic();
setupStory();
setupMap();
setupSky();
setupSeek();
setupGuide();
tourButton.addEventListener('click', toggleTour);
document.getElementById('tour-previous').addEventListener('click', () => jumpTour(-1));
document.getElementById('tour-next').addEventListener('click', () => jumpTour(1));
resize();
requestAnimationFrame(frame);
ready = start().catch((error) => {
  console.error(error);
  showError("Le nuage de points n'a pas pu être chargé. Réessayez dans un instant.");
});

// Read by automated checks and handy in the console.
window.__nuage = { camera, look, applyLook, draw, step, renderer, music, get cloud() { return cloud; }, get tour() { return tour; }, tourPlan, showPlaceTitle, sunDirection };
