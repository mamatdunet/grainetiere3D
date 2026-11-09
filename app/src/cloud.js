import * as THREE from 'three';
import airMaskUrl from './air-mask.bin?url';
import speckMaskUrl from './speck-mask.bin?url';
import peopleMaskUrl from './people-mask.bin?url';

export async function gunzipIfNeeded(buffer) {
  const bytes = new Uint8Array(buffer);
  // Some hosts already decode .gz files through Content-Encoding.
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return buffer;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

// Each zone keeps the address it came from: the public store, or the private one behind /api/prive.
async function fetchZone(zone) {
  const response = await fetch(`${zone.base}/${zone.id}/metadata.json.gz`);
  if (!response.ok) throw new Error(`${zone.id}: HTTP ${response.status}`);
  const text = new TextDecoder().decode(await gunzipIfNeeded(await response.arrayBuffer()));
  return { ...zone, ...JSON.parse(text) };
}

async function fetchManifest(base) {
  const response = await fetch(`${base}/manifest.json`, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`manifest: HTTP ${response.status}`);
  const manifest = await response.json();
  for (const zone of manifest.zones) zone.base = base;
  return manifest;
}

// privateUrl, for /admin only, adds the monks' rooms, which are not in the public manifest.
export async function loadAbbey(baseUrl, privateUrl) {
  const manifest = await fetchManifest(baseUrl);
  if (privateUrl) manifest.zones.push(...(await fetchManifest(privateUrl)).zones);
  const [zones, cleaning, peopleMask, ...masks] = await Promise.all([
    Promise.all(manifest.zones.map(fetchZone)),
    loadCleaning(baseUrl),
    loadMask(peopleMaskUrl),
    loadMask(airMaskUrl),
    loadMask(speckMaskUrl),
  ]);
  manifest.zones = zones;
  manifest.masks = masks.filter(Boolean);
  manifest.peopleMask = peopleMask;
  manifest.cleaning = cleaning;
  if (peopleMask) {
    for (const cell of cleaning.added) peopleMask.cells.add(cell);
    for (const cell of cleaning.restored) peopleMask.cells.delete(cell);
  }
  return manifest;
}

// What the administrator cleaned by hand (see cleanup.js). Small, and always asked for afresh.
async function loadCleaning(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/nettoyage.json?v=${Date.now()}`);
    if (response.ok) return await response.json();
  } catch (error) {
    console.warn('nettoyage', error);
  }
  return { added: [], restored: [] };
}

// Cells of space holding only what floats in the air, or specks just off a surface (see pipeline/air_mask.py
// and speck_mask.py). Without these lists, the view still works, with a little more noise.
async function loadMask(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const size = new Uint32Array(buffer, 0, 1)[0];
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, size)));
    return { ...header, cells: new Set(new Uint32Array(buffer, 4 + Math.ceil(size / 4) * 4)) };
  } catch (error) {
    console.warn('mask', url, error);
    return null;
  }
}

function dropAirPoints(positions, tones, n, node, mask) {
  const toCell = node.size / 65535 / mask.voxel;
  const [lowX, lowY, lowZ] = mask.low;
  const { x: minX, y: minY, z: minZ } = node.box.min;
  const [width, depth] = mask.shape;
  let kept = 0;
  for (let i = 0; i < n; i++) {
    const x = Math.floor(positions[i * 3] * toCell + (minX - lowX) / mask.voxel);
    const y = Math.floor(positions[i * 3 + 1] * toCell + (minY - lowY) / mask.voxel);
    const z = Math.floor(positions[i * 3 + 2] * toCell + (minZ - lowZ) / mask.voxel);
    if (mask.cells.has(x + y * width + z * width * depth)) continue;
    positions[kept * 3] = positions[i * 3];
    positions[kept * 3 + 1] = positions[i * 3 + 1];
    positions[kept * 3 + 2] = positions[i * 3 + 2];
    tones[kept] = tones[i];
    kept += 1;
  }
  return kept;
}

// The survey crew and their tripods (see pipeline/people_mask.py): their points go last in the node, where
// a shorter draw range leaves them out. Hiding them or showing them again then costs nothing. Returns how many stay.
function moveTracesLast(positions, tones, n, node, mask) {
  const toCell = node.size / 65535 / mask.voxel;
  const [lowX, lowY, lowZ] = mask.low;
  const { x: minX, y: minY, z: minZ } = node.box.min;
  const [width, depth] = mask.shape;
  let end = n;
  for (let i = 0; i < end;) {
    const x = Math.floor(positions[i * 3] * toCell + (minX - lowX) / mask.voxel);
    const y = Math.floor(positions[i * 3 + 1] * toCell + (minY - lowY) / mask.voxel);
    const z = Math.floor(positions[i * 3 + 2] * toCell + (minZ - lowZ) / mask.voxel);
    if (!mask.cells.has(x + y * width + z * width * depth)) {
      i += 1;
      continue;
    }
    end -= 1;
    for (let axis = 0; axis < 3; axis++) {
      const held = positions[i * 3 + axis];
      positions[i * 3 + axis] = positions[end * 3 + axis];
      positions[end * 3 + axis] = held;
    }
    const held = tones[i];
    tones[i] = tones[end];
    tones[end] = held;
  }
  return end;
}

const NOTHING_MARKED = 1e9;

const VERTEX = /* glsl */ `
  uniform float uScale, uSize, uSpacing, uMinSize, uMaxSize, uMinTone, uMarkFrom;
  uniform vec3 uHiddenLow, uHiddenHigh;
  attribute float tone;
  varying float vTone;
  varying float vHeight;
  varying float vMarked;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec4 view = viewMatrix * world;
    gl_Position = projectionMatrix * view;
    gl_PointSize = uSize * clamp(1.5 * uSpacing * uScale / max(-view.z, 0.01), uMinSize, uMaxSize);
    // Laser echoes on edges come back almost black: send them off screen.
    if (tone < uMinTone) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    #ifdef HIDDEN_BOX
    if (all(greaterThan(world.xyz, uHiddenLow)) && all(lessThan(world.xyz, uHiddenHigh))) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    #endif
    vTone = tone;
    vHeight = world.z;
    vMarked = float(gl_VertexID) >= uMarkFrom ? 1.0 : 0.0;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform int uMode;
  uniform vec2 uHeightRange;
  varying float vTone;
  varying float vHeight;
  varying float vMarked;
  vec3 ramp(float t) {
    vec3 a = vec3(0.13, 0.20, 0.36), b = vec3(0.30, 0.58, 0.55), c = vec3(0.93, 0.80, 0.50);
    return t < 0.5 ? mix(a, b, t * 2.0) : mix(b, c, t * 2.0 - 1.0);
  }
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    #ifndef SQUARE_POINTS
    if (dot(p, p) > 0.25) discard;
    #endif
    vec3 base = uMode == 0
      ? (0.1 + 0.9 * pow(vTone, 1.25)) * vec3(1.0, 0.965, 0.9)
      : ramp(clamp((vHeight - uHeightRange.x) / (uHeightRange.y - uHeightRange.x), 0.0, 1.0))
        * (0.55 + 0.65 * vTone);
    gl_FragColor = vec4(vMarked > 0.5 ? vec3(1.0, 0.1, 0.1) : base, 1.0);
  }
`;

const MIN_OCCLUSION_DEPTH = 5;

// Birds and laser noise show up as points with nothing around them. Each node is cut into a coarse
// grid (a cell is 4 point spacings wide): a point whose cell and neighbouring cells hold at most
// ISOLATED points in all is dropped. Surfaces always have neighbours, at every level of detail.
const ISOLATED = 2;
const CELLS = 32;
const CELL_SHIFT = 11;
// At the levels seen from afar, small clumps connected to nothing are removed as well, unless they
// touch the edge of the node: there, they may simply continue into the neighbouring node.
const MAX_CLUMP_CELLS = 6;
const MAX_CLUMP_DEPTH = 8;

function floatingCells(cells) {
  const floating = new Uint8Array(cells.length);
  const seen = new Uint8Array(cells.length);
  const stack = [];
  for (let start = 0; start < cells.length; start++) {
    if (!cells[start] || seen[start]) continue;
    const clump = [];
    let touchesEdge = false;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const cell = stack.pop();
      clump.push(cell);
      const x = cell & 31, y = (cell >> 5) & 31, z = cell >> 10;
      if (x === 0 || x === 31 || y === 0 || y === 31 || z === 0 || z === 31) touchesEdge = true;
      for (let dz = Math.max(z - 1, 0); dz <= Math.min(z + 1, 31); dz++) {
        for (let dy = Math.max(y - 1, 0); dy <= Math.min(y + 1, 31); dy++) {
          for (let dx = Math.max(x - 1, 0); dx <= Math.min(x + 1, 31); dx++) {
            const next = dx | (dy << 5) | (dz << 10);
            if (cells[next] && !seen[next]) {
              seen[next] = 1;
              stack.push(next);
            }
          }
        }
      }
    }
    if (!touchesEdge && clump.length <= MAX_CLUMP_CELLS) for (const cell of clump) floating[cell] = 1;
  }
  return floating;
}

function keepSurroundedPoints(positions, tones, n, depth) {
  const cells = new Uint32Array(CELLS * CELLS * CELLS);
  const cellOf = (i) => (positions[i * 3] >> CELL_SHIFT)
    | ((positions[i * 3 + 1] >> CELL_SHIFT) << 5)
    | ((positions[i * 3 + 2] >> CELL_SHIFT) << 10);
  for (let i = 0; i < n; i++) cells[cellOf(i)] += 1;
  const isolated = (cell) => {
    const x = cell & 31, y = (cell >> 5) & 31, z = cell >> 10;
    let around = 0;
    for (let dz = Math.max(z - 1, 0); dz <= Math.min(z + 1, 31); dz++) {
      for (let dy = Math.max(y - 1, 0); dy <= Math.min(y + 1, 31); dy++) {
        for (let dx = Math.max(x - 1, 0); dx <= Math.min(x + 1, 31); dx++) {
          around += cells[dx | (dy << 5) | (dz << 10)];
          if (around > ISOLATED) return false;
        }
      }
    }
    return true;
  };
  const floating = depth <= MAX_CLUMP_DEPTH ? floatingCells(cells) : null;
  const verdict = new Int8Array(cells.length);
  let kept = 0;
  for (let i = 0; i < n; i++) {
    const cell = cellOf(i);
    if (!verdict[cell]) verdict[cell] = floating?.[cell] || isolated(cell) ? -1 : 1;
    if (verdict[cell] < 0) continue;
    positions[kept * 3] = positions[i * 3];
    positions[kept * 3 + 1] = positions[i * 3 + 1];
    positions[kept * 3 + 2] = positions[i * 3 + 2];
    tones[kept] = tones[i];
    kept += 1;
  }
  return kept;
}
const corner = new THREE.Vector4();

class BinaryHeap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  push(priority, value) {
    const items = this.items;
    let i = items.length;
    items.push([priority, value]);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent][0] >= items[i][0]) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }
  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let best = i;
        if (l < items.length && items[l][0] > items[best][0]) best = l;
        if (r < items.length && items[r][0] > items[best][0]) best = r;
        if (best === i) break;
        [items[best], items[i]] = [items[i], items[best]];
        i = best;
      }
    }
    return top;
  }
}

// A failed node is asked for again a little later. This many failures in a row, with no success between
// them, means the data does not get through at all (filtering, network), which the visitor should be told.
const RETRY_DELAY = 1000;
const TROUBLE_AFTER = 48;

export class PointCloud {
  constructor(abbey, baseUrl, { pointBudget, concurrency = 24, onChange, onTrouble }) {
    this.abbey = abbey;
    this.onTrouble = onTrouble;
    this.failures = 0;
    this.baseUrl = baseUrl;
    this.pointBudget = pointBudget;
    // How many new points may reach the graphics card at each selection: more would show as a jolt in the motion.
    this.maxNewPoints = 1_500_000;
    // Each node drawn has a cost of its own, however small: a slower device can pass over the smallest ones.
    this.minNodePoints = 1;
    this.concurrency = concurrency;
    this.onChange = onChange;
    this.group = new THREE.Group();
    this.loading = 0;
    this.loadedPoints = 0;
    this.droppedPoints = 0;
    this.visiblePoints = 0;
    this.pending = 0;
    this.clock = 0;
    this.store = null;
    this.storeReads = 0;
    this.networkReads = 0;
    this.loaded = new Set();
    this.queue = [];
    this.warmQueue = [];
    this.received = [];
    this.tracesHidden = true;
    this.tracesMarked = false;
    // An area shown by other means (see vr.js): nodes wholly inside it are not even selected.
    this.hiddenBox = null;

    const zs = abbey.zones.flatMap((zone) => zone.stations.map((s) => s.position[2]));
    const floor = Math.min(...zs) - 2;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uScale: { value: 1 },
        uSize: { value: 1 },
        uSpacing: { value: 1 },
        uMinSize: { value: 2.8 },
        uMinTone: { value: 0 },
        uMarkFrom: { value: NOTHING_MARKED },
        uHiddenLow: { value: new THREE.Vector3() },
        uHiddenHigh: { value: new THREE.Vector3() },
        uMaxSize: { value: 14 },
        uMode: { value: 0 },
        uHeightRange: { value: new THREE.Vector2(floor, floor + 12) },
      },
    });

    this.roots = abbey.zones.map((zone) => this.buildTree(zone));
    this.frustum = new THREE.Frustum();
    this.matrix = new THREE.Matrix4();
  }

  buildTree(zone) {
    const half = this.abbey.rootSize / 2;
    const tree = new Map();
    const makeNode = (key, count = 0, chunk = 0, offset = 0, length = 0) => {
      let size = this.abbey.rootSize, x = -half, y = -half, z = -half;
      for (const digit of key) {
        size /= 2;
        const c = Number(digit);
        if (c & 1) x += size;
        if (c & 2) y += size;
        if (c & 4) z += size;
      }
      const min = new THREE.Vector3(x, y, z);
      const node = {
        zone: zone.id, base: zone.base, key, count, chunk, offset, length, size,
        spacing: size / this.abbey.grid,
        box: new THREE.Box3(min, min.clone().addScalar(size)),
        center: min.clone().addScalar(size / 2),
        radius: (size * Math.sqrt(3)) / 2,
        children: [],
        parent: null,
        mesh: null,
        state: 'idle',
        lastUsed: 0,
      };
      tree.set(key, node);
      return node;
    };
    for (const [key, count, chunk, offset, length] of zone.nodes) makeNode(key, count, chunk, offset, length);
    // Upper levels can be empty in a small zone; the tree still needs them to be walked.
    for (const key of [...tree.keys()]) {
      for (let n = key.length - 1; n >= 0; n--) {
        const ancestor = key.slice(0, n);
        if (tree.has(ancestor)) break;
        makeNode(ancestor);
      }
    }
    for (const node of tree.values()) {
      if (!node.key) continue;
      node.parent = tree.get(node.key.slice(0, -1));
      node.parent.children.push(node);
    }
    delete zone.nodes;
    return tree.get('');
  }

  // Is the whole box behind what the previous picture shows, wherever the box falls on screen?
  isOccluded(node) {
    const map = this.occlusion;
    if (!map || node.key.length < MIN_OCCLUSION_DEPTH) return false;
    let nearest = Infinity;
    let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity;
    const { min, max } = node.box;
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z, 1);
      corner.applyMatrix4(map.view);
      const distance = -corner.z;
      if (distance <= map.projection.elements[14] / (map.projection.elements[10] - 1)) return false;
      nearest = Math.min(nearest, distance);
      corner.applyMatrix4(map.projection);
      const x = corner.x / corner.w, y = corner.y / corner.w;
      left = Math.min(left, x);
      right = Math.max(right, x);
      bottom = Math.min(bottom, y);
      top = Math.max(top, y);
    }
    if (left < -1 || right > 1 || bottom < -1 || top > 1) return false;
    const x0 = Math.floor((left * 0.5 + 0.5) * map.width), x1 = Math.min(Math.floor((right * 0.5 + 0.5) * map.width), map.width - 1);
    const y0 = Math.floor((bottom * 0.5 + 0.5) * map.height), y1 = Math.min(Math.floor((top * 0.5 + 0.5) * map.height), map.height - 1);
    const limit = nearest / 1.03 - 0.5;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (map.distance[y * map.width + x] > limit) return false;
      }
    }
    return true;
  }

  measures(camera, viewportHeight) {
    const pixelsPerMeter = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.matrix);
    const distanceTo = (node) => Math.max(node.center.distanceTo(camera.position) - node.radius, 0.05);
    const pixelSpacing = (node) => (node.spacing * pixelsPerMeter) / distanceTo(node);
    // Nearby surfaces first: they are what the eye reads, and far ones are often behind a wall.
    const priority = (node) => pixelSpacing(node) / Math.sqrt(distanceTo(node));
    return { pixelsPerMeter, pixelSpacing, priority };
  }

  // The nodes a view would show once everything is loaded, walls hiding nothing: adds them to the set.
  collectNodes(camera, viewportHeight, budget, nodes) {
    const { pixelSpacing, priority } = this.measures(camera, viewportHeight);
    const heap = new BinaryHeap();
    for (const root of this.roots) heap.push(Infinity, root);
    let total = 0;
    while (heap.size) {
      const [, node] = heap.pop();
      if (!this.frustum.intersectsBox(node.box) || pixelSpacing(node) < 1.2) continue;
      if (node.count) {
        if (total + node.count > budget) break;
        total += node.count;
        nodes.add(node);
      }
      for (const child of node.children) heap.push(priority(child), child);
    }
  }

  nodeUrl(node) {
    return `${node.base}/${node.zone}/chunks/${node.chunk}.bin`;
  }

  // Where a node's bytes are kept on disk: not a real address, only a key.
  storeKey(node) {
    return `${node.base}/${node.zone}/nodes/${node.key || 'root'}`;
  }

  async fetchNode(node) {
    const end = node.offset + node.length - 1;
    const response = await fetch(this.nodeUrl(node), { headers: { Range: `bytes=${node.offset}-${end}` } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.arrayBuffer();
    return response.status === 200 ? data.slice(node.offset, end + 1) : data;
  }

  async readNode(node) {
    const kept = this.store && await this.store.match(this.storeKey(node));
    if (kept) {
      this.storeReads += 1;
      return kept.arrayBuffer();
    }
    this.networkReads += 1;
    return this.fetchNode(node);
  }

  // Load these nodes without showing them, once what is on screen has been served.
  warm(nodes) {
    this.warmQueue = [...nodes];
    this.pump();
  }

  update(camera, viewportHeight) {
    const { pixelsPerMeter, pixelSpacing, priority } = this.measures(camera, viewportHeight);
    this.material.uniforms.uScale.value = pixelsPerMeter;
    this.clock += 1;

    const heap = new BinaryHeap();
    for (const root of this.roots) heap.push(Infinity, root);

    const visible = new Set();
    const wanted = [];
    let total = 0;
    let fresh = 0;
    let held = 0;
    while (heap.size) {
      const [, node] = heap.pop();
      if (!this.frustum.intersectsBox(node.box)) continue;
      if (this.isOccluded(node) || this.hiddenBox?.containsBox(node.box)) continue;
      if (pixelSpacing(node) < 1.2) continue;
      if (node.count < this.minNodePoints) {
        for (const child of node.children) heap.push(priority(child), child);
        continue;
      }
      if (total + node.count > this.pointBudget) break;
      total += node.count;
      if (node.mesh) {
        if (!node.shown) {
          if (fresh + node.count > this.maxNewPoints && fresh) {
            held += 1;
            continue;
          }
          fresh += node.count;
          node.shown = true;
        }
        visible.add(node);
        node.lastUsed = this.clock;
        for (const child of node.children) heap.push(priority(child), child);
      } else if (node.state === 'idle') {
        wanted.push(node);
      }
    }

    for (const node of this.loaded) node.mesh.visible = visible.has(node);
    // Children are drawn over their parent, so a parent's points only need to be as
    // large as the spacing of its finest visible descendant.
    const deepestFirst = [...visible].sort((a, b) => b.key.length - a.key.length);
    for (const node of deepestFirst) node.drawSpacing = node.spacing;
    for (const node of deepestFirst) {
      if (visible.has(node.parent)) node.parent.drawSpacing = Math.min(node.parent.drawSpacing, node.drawSpacing);
    }
    this.visiblePoints = total;
    this.pending = wanted.length + held;
    this.queue = wanted;
    this.pump();
    this.evict();
  }

  pump() {
    while (this.loading < this.concurrency && (this.queue.length || this.warmQueue.length)) {
      const node = this.queue.shift() ?? this.warmQueue.shift();
      if (node.state === 'idle') this.load(node);
    }
  }

  async load(node) {
    node.state = 'loading';
    this.loading += 1;
    try {
      this.received.push([node, await gunzipIfNeeded(await this.readNode(node))]);
      this.failures = 0;
      this.onTrouble?.(null);
    } catch (error) {
      console.warn(`node ${node.zone}/${node.key}`, error);
      this.failures += 1;
      if (this.failures >= TROUBLE_AFTER) this.onTrouble?.(error);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
      node.state = 'idle';
      this.loading -= 1;
      this.pump();
    }
  }

  hideTraces(hidden) {
    this.tracesHidden = hidden;
    for (const node of this.loaded) node.mesh.geometry.setDrawRange(0, hidden ? node.cleanCount : node.keptCount);
    this.onChange();
  }

  // For the administrator: the points of the people mask show in red instead of looking like the others.
  markTraces(marked) {
    this.tracesMarked = marked;
    this.onChange();
  }

  // The people mask has changed around here: sort again the nodes already loaded.
  sortTraces([lowX, lowY, lowZ, highX, highY, highZ]) {
    const box = new THREE.Box3(new THREE.Vector3(lowX, lowY, lowZ), new THREE.Vector3(highX, highY, highZ));
    for (const node of this.loaded) {
      if (!node.box.intersectsBox(box)) continue;
      const { position, tone } = node.mesh.geometry.attributes;
      node.cleanCount = moveTracesLast(position.array, tone.array, node.keptCount, node, this.abbey.peopleMask);
      position.needsUpdate = true;
      tone.needsUpdate = true;
      if (this.tracesHidden) node.mesh.geometry.setDrawRange(0, node.cleanCount);
    }
    this.onChange();
  }

  // Prepare what has arrived for this long at most: done all at once, it would make a frame miss its turn.
  settle(milliseconds) {
    const until = performance.now() + milliseconds;
    while (this.received.length && performance.now() < until) {
      const [node, buffer] = this.received.shift();
      try {
        this.attach(node, buffer);
        node.state = 'ready';
      } catch (error) {
        console.warn(`node ${node.zone}/${node.key}`, error);
        node.state = 'idle';
      }
      this.loading -= 1;
      this.pump();
      this.onChange();
    }
  }

  attach(node, buffer) {
    const n = node.count;
    const axes = new Uint16Array(buffer, 0, n * 3);
    const positions = new Uint16Array(n * 3);
    for (let i = 0; i < n; i++) {
      positions[i * 3] = axes[i];
      positions[i * 3 + 1] = axes[n + i];
      positions[i * 3 + 2] = axes[2 * n + i];
    }
    const tones = new Uint8Array(buffer, n * 6, n);
    let clear = n;
    for (const mask of this.abbey.masks) clear = dropAirPoints(positions, tones, clear, node, mask);
    const kept = keepSurroundedPoints(positions, tones, clear, node.key.length);
    this.droppedPoints += n - kept;
    node.cleanCount = this.abbey.peopleMask ? moveTracesLast(positions, tones, kept, node, this.abbey.peopleMask) : kept;
    node.keptCount = kept;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, kept * 3), 3, true));
    geometry.setAttribute('tone', new THREE.BufferAttribute(tones.subarray(0, kept), 1, true));

    if (this.tracesHidden) geometry.setDrawRange(0, node.cleanCount);
    const mesh = new THREE.Points(geometry, this.material);
    mesh.position.copy(node.box.min);
    mesh.scale.setScalar(node.size);
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.onBeforeRender = (_renderer, _scene, _camera, _geometry, material) => {
      material.uniforms.uSpacing.value = node.drawSpacing ?? node.spacing;
      material.uniforms.uMarkFrom.value = this.tracesMarked ? node.cleanCount : NOTHING_MARKED;
      material.uniformsNeedUpdate = true;
    };
    this.group.add(mesh);
    node.mesh = mesh;
    node.lastUsed = this.clock;
    this.loaded.add(node);
    this.loadedPoints += n;
  }

  evict() {
    const limit = this.pointBudget * 2;
    if (this.loadedPoints <= limit) return;
    const candidates = [...this.loaded]
      .filter((node) => !node.mesh.visible && node.children.every((c) => !c.mesh))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const node of candidates) {
      if (this.loadedPoints <= limit) break;
      this.group.remove(node.mesh);
      node.mesh.geometry.dispose();
      node.mesh = null;
      node.shown = false;
      node.state = 'idle';
      this.loaded.delete(node);
      this.loadedPoints -= node.count;
    }
  }
}
