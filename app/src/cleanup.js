// Hand cleaning of the survey crew, for what the detection missed or took by mistake (adresse ?nettoyage=1).
// What is gommed shows in red here; visitors who hide the traces no longer see it. Everything is saved online
// (api/nettoyage.js) as what was added to the people mask and what was taken back from it.
import * as THREE from 'three';
import piecesUrl from './pieces-mask.bin?url';

// Left by the first version of this tool, which kept strokes in the browser.
const OLD_STORE = 'grainetiere-nettoyage';
const SAVE_DELAY = 1500;
const RETRY_DELAY = 10000;
const MAX_PREVIEW = 200_000;
// The surface a brush is aimed at is the nearest one holding a share of its points, however few: a thin
// foreground can count far fewer points than the wall behind it. A speck or two does not make a surface.
const LAYER_SPAN = 0.15;
const LAYER_SHARE = 0.002;
const LAYER_MIN_POINTS = 8;
const LAYER_MAX_POINTS = 200;
// Within a brush, what has something nearer on the same few pixels is hidden from view: it is left alone.
const HIDDEN_CELL = 6;
// A stroke beginning on a far plane right beside a much nearer one is taken for a slip of the hand.
const GUARD_REACH = 2;
const GUARD_GAP = 2;
const GUARD_SHARE = 0.35;
const AIM_EVERY = 80;
// A click takes the piece under the pointer. Moving further than this makes it a turn of the view instead.
const HOVER_RADIUS = 10;
const CLICK_SLOP = 4;
const NEAR = 0.05;
const ERASE_COLOR = 0xff1a1a;
const RESTORE_COLOR = 0x35d07f;

const emptyBounds = () => [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];

function indexIn(sorted, value) {
  let low = 0, high = sorted.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle] === value) return middle;
    if (sorted[middle] < value) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

// The pieces that are neither floor, vault nor wall, and the cells of the building (see pipeline/pieces_mask.py).
async function loadPieces() {
  const response = await fetch(piecesUrl);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  const size = new Uint32Array(buffer, 0, 1)[0];
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, size)));
  const start = 4 + Math.ceil(size / 4) * 4;
  const cells = new Uint32Array(buffer, start, header.cells);
  const owner = new Uint32Array(buffer, start + header.cells * 4, header.cells);
  const loose = new Uint8Array(buffer, start + header.cells * 8, header.pieces);
  const solid = new Uint32Array(buffer, start + header.cells * 8 + Math.ceil(header.pieces / 4) * 4, header.solid);
  for (let i = 1; i < cells.length; i++) cells[i] += cells[i - 1];
  for (let i = 1; i < solid.length; i++) solid[i] += solid[i - 1];
  const starts = new Uint32Array(header.pieces + 1);
  for (const piece of owner) starts[piece + 1] += 1;
  for (let i = 0; i < header.pieces; i++) starts[i + 1] += starts[i];
  const members = new Uint32Array(cells.length);
  const filled = starts.slice();
  owner.forEach((piece, i) => { members[filled[piece]++] = cells[i]; });
  const looseList = [];
  loose.forEach((flag, piece) => { if (flag) looseList.push(piece); });
  return {
    loose: looseList,
    isSolid: (cell) => indexIn(solid, cell) >= 0,
    pieceAt: (cell) => {
      const at = indexIn(cells, cell);
      return at < 0 ? -1 : owner[at];
    },
    cellsOf: (piece) => members.subarray(starts[piece], starts[piece + 1]),
  };
}

export function setupCleanup({ canvas, camera, renderer, cloud, look }) {
  const mask = cloud.abbey.peopleMask;
  const { voxel } = mask;
  const [lowX, lowY, lowZ] = mask.low;
  const [width, depth] = mask.shape;
  const added = new Set(cloud.abbey.cleaning.added);
  const restored = new Set(cloud.abbey.cleaning.restored);
  const history = [];
  const undone = [];
  let isAdmin = false;
  let erasing = true;
  let stroke = null;
  let last = null;
  let pointer = null;
  let saveTimer = null;
  let unsaved = false;
  let pieces = null;
  let pressed = null;

  const panel = document.createElement('section');
  panel.className = 'panel cleanup';
  panel.setAttribute('aria-label', 'Nettoyage');
  panel.innerHTML = `
    <h2>Nettoyage</h2>
    <form id="cleanup-login" hidden>
      <label>Mot de passe administrateur <input id="cleanup-password" type="password" autocomplete="current-password" required /></label>
      <button class="primary">Entrer</button>
    </form>
    <div id="cleanup-tools" class="cleanup-tools" hidden>
      <p>Survoler : le morceau visé passe en rouge. Clic : il part en entier, sans toucher aux sols ni aux murs. Glisser : pivoter. Molette ou pincement : zoomer.</p>
      <p><kbd>Maj</kbd> + glisser : le pinceau, pour le reste. Il épargne le bâti et les fonds loin derrière un premier plan (tiret orange) ; <kbd>Alt</kbd> force le passage.</p>
      <div class="segmented" role="group" aria-label="Action du pinceau">
        <button id="cleanup-erase" aria-pressed="true">Gommer</button>
        <button id="cleanup-restore" aria-pressed="false">Dégommer</button>
      </div>
      <label>Taille du pinceau <input id="cleanup-size" type="range" min="4" max="80" step="1" value="20" /></label>
      <label>Profondeur : <span id="cleanup-depth-value"></span> <input id="cleanup-depth" type="range" min="0.1" max="2" step="0.1" value="0.4" /></label>
      <label><span>Morceaux isolés, jusqu'à <span id="cleanup-loose-value"></span> cases</span> <input id="cleanup-loose" type="range" min="1" max="100" step="1" value="10" /></label>
      <button id="cleanup-sweep" disabled>Chargement des morceaux…</button>
      <div class="cleanup-row">
        <button id="cleanup-undo">◀ Précédent</button>
        <button id="cleanup-redo">Suivant ▶</button>
      </div>
      <output id="cleanup-count"></output>
      <p><kbd>L</kbd> : copier le lien de cette vue, avec le point sous la souris, pour montrer un problème.</p>
    </div>
    <output id="cleanup-status" role="status"></output>`;
  document.body.append(panel);
  const ring = document.createElement('div');
  ring.className = 'cleanup-ring';
  ring.hidden = true;
  document.body.append(ring);

  const find = (id) => panel.querySelector(`#cleanup-${id}`);
  const sizeInput = find('size');
  const depthInput = find('depth');
  const status = find('status');

  const showState = () => {
    find('count').textContent = `${added.size.toLocaleString('fr-FR')} cases gommées à la main, ${restored.size.toLocaleString('fr-FR')} rendues à la détection automatique`;
    find('undo').disabled = !history.length;
    find('redo').disabled = !undone.length;
    find('erase').setAttribute('aria-pressed', String(erasing));
    find('restore').setAttribute('aria-pressed', String(!erasing));
    find('depth-value').textContent = `${Number(depthInput.value).toFixed(1).replace('.', ',')} m`;
    ring.classList.toggle('restoring', !erasing);
    find('loose-value').textContent = find('loose').value;
    if (pieces) {
      const count = loosePieces().length;
      find('sweep').disabled = !count;
      find('sweep').textContent = count ? `Retirer ces ${count.toLocaleString('fr-FR')} morceaux` : 'Plus aucun morceau de cette taille';
    }
  };
  // What is alone in space, up to the chosen size, and not gone yet.
  const loosePieces = () => {
    const most = Number(find('loose').value);
    return pieces.loose.filter((piece) => {
      const cells = pieces.cellsOf(piece);
      return cells.length <= most && cells.some((cell) => !mask.cells.has(cell));
    });
  };
  depthInput.addEventListener('input', showState);
  find('erase').addEventListener('click', () => { erasing = true; showState(); });
  find('restore').addEventListener('click', () => { erasing = false; showState(); });

  const save = async () => {
    saveTimer = null;
    status.textContent = 'Enregistrement…';
    const sent = { added: [...added], restored: [...restored] };
    unsaved = false;
    let failure = 'réseau';
    try {
      const response = await fetch('/api/nettoyage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sent) });
      if (response.ok) {
        if (!unsaved) {
          status.textContent = `Enregistré en ligne à ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
          localStorage.removeItem(OLD_STORE);
        }
        return;
      }
      failure = `erreur ${response.status}`;
    } catch (error) {
      console.warn('nettoyage', error);
    }
    unsaved = true;
    status.textContent = `Non enregistré (${failure}) : nouvel essai dans 10 secondes. Gardez cette page ouverte.`;
    saveTimer = setTimeout(save, RETRY_DELAY);
  };
  const saveSoon = () => {
    unsaved = true;
    status.textContent = 'Modifications à enregistrer…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_DELAY);
  };
  addEventListener('beforeunload', (event) => { if (unsaved) event.preventDefault(); });

  // A cell of the automatic detection is taken back by being listed, one painted here by being forgotten.
  const setCell = (cell, erase) => {
    if (erase) {
      mask.cells.add(cell);
      if (!restored.delete(cell)) added.add(cell);
    } else {
      mask.cells.delete(cell);
      if (!added.delete(cell)) restored.add(cell);
    }
  };

  // What the current stroke takes, drawn over the image until the brush lifts.
  const preview = new Float32Array(MAX_PREVIEW * 3);
  const previewGeometry = new THREE.BufferGeometry();
  previewGeometry.setAttribute('position', new THREE.BufferAttribute(preview, 3));
  previewGeometry.setDrawRange(0, 0);
  const previewScene = new THREE.Scene();
  const previewMaterial = new THREE.PointsMaterial({ size: 5, sizeAttenuation: false, depthTest: false, transparent: true, opacity: 0.75 });
  const previewPoints = new THREE.Points(previewGeometry, previewMaterial);
  previewPoints.frustumCulled = false;
  previewScene.add(previewPoints);
  // The point a shared link was about (main.js reads the view, here the point).
  const target = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0x00e5ff, size: 16, sizeAttenuation: false, depthTest: false }));
  const shared = new URLSearchParams(location.search).get('cible')?.split(',').map(Number);
  target.visible = shared?.length === 3 && shared.every(Number.isFinite);
  if (target.visible) target.geometry.setAttribute('position', new THREE.Float32BufferAttribute(shared, 3));
  target.frustumCulled = false;
  previewScene.add(target);

  // Whether a cell of the building stays out of this erasing.
  const spared = (cell, erase, forced) => erase && !forced && pieces?.isSolid(cell);

  const cellCenter = (cell) => [
    lowX + ((cell % width) + 0.5) * voxel,
    lowY + ((Math.floor(cell / width) % depth) + 0.5) * voxel,
    lowZ + (Math.floor(cell / (width * depth)) + 0.5) * voxel,
  ];

  function markCell(cell, target) {
    if (mask.cells.has(cell) === target.erase) return;
    setCell(cell, target.erase);
    target.cells.push(cell);
    const at = target.cells.length - 1;
    const [worldX, worldY, worldZ] = cellCenter(cell);
    if (at < MAX_PREVIEW) preview.set([worldX, worldY, worldZ], at * 3);
    const box = target.box;
    box[0] = Math.min(box[0], worldX - voxel);
    box[1] = Math.min(box[1], worldY - voxel);
    box[2] = Math.min(box[2], worldZ - voxel);
    box[3] = Math.max(box[3], worldX + voxel);
    box[4] = Math.max(box[4], worldY + voxel);
    box[5] = Math.max(box[5], worldZ + voxel);
  }

  function keepDone(done) {
    if (!done.cells.length) return;
    history.push(done);
    undone.length = 0;
    cloud.sortTraces(done.box);
    saveSoon();
    showState();
  }

  const viewProjection = new THREE.Matrix4();
  const center = new THREE.Vector3();
  const metres = (value) => `${value.toFixed(1).replace('.', ',')} m`;

  // The points under a disc of the screen, as runs of depth, x, y, z and position relative to its centre.
  function scan(clientX, clientY, radius, erase) {
    const rect = canvas.getBoundingClientRect();
    camera.updateMatrixWorld();
    viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const e = viewProjection.elements;
    const pixelsPerMeter = rect.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    const halfW = rect.width / 2, halfH = rect.height / 2;
    const brushX = clientX - rect.left - halfW, brushY = halfH - (clientY - rect.top);
    const limit = radius * radius;
    const found = [];

    for (const node of cloud.loaded) {
      if (!node.mesh.visible) continue;
      const away = node.center.distanceTo(camera.position) - node.radius;
      if (away > NEAR) {
        center.copy(node.center).applyMatrix4(viewProjection);
        const gapX = center.x * halfW - brushX, gapY = center.y * halfH - brushY;
        const reach = (node.radius * pixelsPerMeter) / away + radius;
        if (gapX * gapX + gapY * gapY > reach * reach) continue;
      }
      const array = node.mesh.geometry.attributes.position.array;
      const n = Math.min(node.mesh.geometry.drawRange.count, array.length / 3);
      const scale = node.size / 65535;
      const { x: minX, y: minY, z: minZ } = node.box.min;
      // Only what is red can be taken back.
      for (let i = erase ? 0 : node.cleanCount; i < n; i++) {
        const x = minX + array[i * 3] * scale, y = minY + array[i * 3 + 1] * scale, z = minZ + array[i * 3 + 2] * scale;
        const w = e[3] * x + e[7] * y + e[11] * z + e[15];
        if (w < NEAR) continue;
        const px = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w) * halfW - brushX;
        const py = ((e[1] * x + e[5] * y + e[9] * z + e[13]) / w) * halfH - brushY;
        if (px * px + py * py <= limit) found.push(w, x, y, z, px, py);
      }
    }
    return found;
  }

  function frontDepth(depths) {
    depths.sort((a, b) => a - b);
    const enough = THREE.MathUtils.clamp(Math.ceil(depths.length * LAYER_SHARE), LAYER_MIN_POINTS, LAYER_MAX_POINTS);
    for (let i = 0; i + enough <= depths.length; i++) {
      if (depths[i + enough - 1] - depths[i] <= LAYER_SPAN) return depths[i];
    }
    return depths[0];
  }

  // Which surface a brush placed here would work on, and whether that looks like a slip.
  function aim(clientX, clientY, erase, forced) {
    const radius = Number(sizeInput.value);
    const found = scan(clientX, clientY, radius * GUARD_REACH, erase);
    const inside = [], around = [];
    for (let i = 0; i < found.length; i += 6) {
      around.push(found[i]);
      if (found[i + 4] * found[i + 4] + found[i + 5] * found[i + 5] <= radius * radius) inside.push(found[i]);
    }
    if (!inside.length) return null;
    const depth = frontDepth(inside);
    const nearer = frontDepth(around);
    return { depth, nearer, found, blocked: erase && !forced && depth - nearer > Math.max(GUARD_GAP, depth * GUARD_SHARE) };
  }

  // The points of a scan the brush may take at this depth: neither off that depth, nor hidden behind something.
  function forEachTaken(found, depth, visit) {
    const radius = Number(sizeInput.value);
    const thickness = Number(depthInput.value);
    const side = Math.ceil((radius * 2) / HIDDEN_CELL) + 1;
    const nearest = new Float32Array(side * side).fill(Infinity);
    const cellAt = (i) => Math.floor((found[i + 4] + radius) / HIDDEN_CELL) + side * Math.floor((found[i + 5] + radius) / HIDDEN_CELL);
    const inBrush = (i) => found[i + 4] * found[i + 4] + found[i + 5] * found[i + 5] <= radius * radius;
    for (let i = 0; i < found.length; i += 6) {
      if (inBrush(i)) nearest[cellAt(i)] = Math.min(nearest[cellAt(i)], found[i]);
    }
    for (let i = 0; i < found.length; i += 6) {
      if (!inBrush(i) || Math.abs(found[i] - depth) > thickness || found[i] > nearest[cellAt(i)] + thickness) continue;
      visit(found[i + 1], found[i + 2], found[i + 3]);
    }
  }

  function stamp(clientX, clientY) {
    if (stroke.blocked) return;
    let found;
    // A stroke stays at the depth it began at: running over the edge of a person spares the wall behind
    // and the ground in front.
    if (stroke.depth === undefined) {
      const aimed = aim(clientX, clientY, stroke.erase, stroke.forced);
      if (!aimed) return;
      if (aimed.blocked) {
        stroke.blocked = true;
        status.textContent = `Rien n'est gommé : ce fond est à ${metres(aimed.depth)}, juste à côté d'un premier plan à ${metres(aimed.nearer)}. Visez le premier plan, ou ajoutez Alt pour gommer ce fond.`;
        return;
      }
      stroke.depth = aimed.depth;
      found = aimed.found;
    } else {
      found = scan(clientX, clientY, Number(sizeInput.value), stroke.erase);
    }
    forEachTaken(found, stroke.depth, (x, y, z) => {
      const cellX = Math.floor((x - lowX) / voxel);
      const cellY = Math.floor((y - lowY) / voxel);
      const cellZ = Math.floor((z - lowZ) / voxel);
      const cell = cellX + cellY * width + cellZ * width * depth;
      if (!spared(cell, stroke.erase, stroke.forced)) markCell(cell, stroke);
    });
    previewGeometry.setDrawRange(0, Math.min(stroke.cells.length, MAX_PREVIEW));
    previewGeometry.attributes.position.needsUpdate = true;
    cloud.onChange();
  }

  const clearPreview = () => {
    if (!previewGeometry.drawRange.count) return;
    previewGeometry.setDrawRange(0, 0);
    cloud.onChange();
  };

  // Before the click: where the brush would bite, drawn over the image, with how far that is.
  let aimedAt = 0;
  function showAim() {
    const now = performance.now();
    if (stroke || !pointer || now - aimedAt < AIM_EVERY) return;
    aimedAt = now;
    const aimed = aim(pointer.x, pointer.y, erasing, pointer.forced);
    ring.classList.toggle('guarded', Boolean(aimed?.blocked));
    ring.dataset.label = !aimed ? '' : aimed.blocked ? `Fond à ${metres(aimed.depth)}, non gommé` : metres(aimed.depth);
    if (!aimed || aimed.blocked) {
      clearPreview();
      return;
    }
    const cells = new Map();
    forEachTaken(aimed.found, aimed.depth, (x, y, z) => {
      const cellX = Math.floor((x - lowX) / voxel), cellY = Math.floor((y - lowY) / voxel), cellZ = Math.floor((z - lowZ) / voxel);
      const cell = cellX + cellY * width + cellZ * width * depth;
      if (mask.cells.has(cell) !== erasing && !spared(cell, erasing, pointer.forced)) cells.set(cell, [lowX + (cellX + 0.5) * voxel, lowY + (cellY + 0.5) * voxel, lowZ + (cellZ + 0.5) * voxel]);
    });
    let at = 0;
    for (const position of cells.values()) {
      if (at === MAX_PREVIEW) break;
      preview.set(position, at * 3);
      at += 1;
    }
    previewMaterial.color.set(erasing ? ERASE_COLOR : RESTORE_COLOR);
    previewGeometry.setDrawRange(0, at);
    previewGeometry.attributes.position.needsUpdate = true;
    cloud.onChange();
  }

  function drawPreview(cells, color) {
    let at = 0;
    for (const cell of cells) {
      if (at === MAX_PREVIEW) break;
      preview.set(cellCenter(cell), at * 3);
      at += 1;
    }
    previewMaterial.color.set(color);
    previewGeometry.setDrawRange(0, at);
    previewGeometry.attributes.position.needsUpdate = true;
    cloud.onChange();
  }

  // The piece on the nearest surface under the pointer, or -1 when that surface is building.
  function pieceUnder(clientX, clientY) {
    const found = scan(clientX, clientY, HOVER_RADIUS, erasing);
    if (!found.length) return null;
    const depths = [];
    for (let i = 0; i < found.length; i += 6) depths.push(found[i]);
    const front = frontDepth(depths);
    const votes = new Map();
    let best = -1, most = 0;
    for (let i = 0; i < found.length; i += 6) {
      if (Math.abs(found[i] - front) > LAYER_SPAN) continue;
      const cell = Math.floor((found[i + 1] - lowX) / voxel) + Math.floor((found[i + 2] - lowY) / voxel) * width + Math.floor((found[i + 3] - lowZ) / voxel) * width * depth;
      const piece = pieces.pieceAt(cell);
      if (piece < 0) continue;
      const count = (votes.get(piece) ?? 0) + 1;
      votes.set(piece, count);
      if (count > most) {
        best = piece;
        most = count;
      }
    }
    return best;
  }

  // The nearest surface point under the pointer, for a shared link.
  function pointUnder(clientX, clientY) {
    const found = scan(clientX, clientY, HOVER_RADIUS, erasing);
    if (!found.length) return null;
    const depths = [];
    for (let i = 0; i < found.length; i += 6) depths.push(found[i]);
    const front = frontDepth(depths);
    let best = -1;
    for (let i = 0; i < found.length; i += 6) {
      if (Math.abs(found[i] - front) > LAYER_SPAN) continue;
      if (best < 0 || found[i + 4] ** 2 + found[i + 5] ** 2 < found[best + 4] ** 2 + found[best + 5] ** 2) best = i;
    }
    return found.slice(best + 1, best + 4);
  }

  async function copyLink() {
    const { x, y, z } = camera.position;
    // Written by hand, so that the commas stay readable in the link.
    let link = `${location.origin}${location.pathname}?nettoyage=1&vue=${[x.toFixed(2), y.toFixed(2), z.toFixed(2), look.yaw.toFixed(3), look.pitch.toFixed(3), camera.fov.toFixed(1)].join(',')}`;
    const point = pointer && pointUnder(pointer.x, pointer.y);
    if (point) link += `&cible=${point.map((value) => value.toFixed(2)).join(',')}`;
    try {
      await navigator.clipboard.writeText(link);
      status.textContent = point ? 'Lien copié, avec le point sous la souris.' : 'Lien copié (sans point : la souris était hors de la vue).';
    } catch (error) {
      console.warn('nettoyage', error);
      status.textContent = `Copie impossible. Le lien : ${link}`;
    }
  }
  addEventListener('keydown', (event) => {
    if (!isAdmin || event.code !== 'KeyL' || event.ctrlKey || event.metaKey || event.altKey || event.target.closest?.('input')) return;
    event.preventDefault();
    copyLink();
  });

  // A piece goes with the empty cells around it, where the finer levels reach beyond the coarse points.
  function takePieces(list, erase) {
    const done = { erase, cells: [], box: emptyBounds() };
    const steps = [];
    for (let z = -1; z <= 1; z++) for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) steps.push(x + y * width + z * width * depth);
    for (const piece of list) {
      for (const cell of pieces.cellsOf(piece)) {
        for (const step of steps) {
          const near = cell + step;
          if (near === cell || !pieces.isSolid(near)) markCell(near, done);
        }
      }
    }
    keepDone(done);
  }

  function showHover() {
    const now = performance.now();
    if (now - aimedAt < AIM_EVERY) return;
    aimedAt = now;
    const piece = pieceUnder(pointer.x, pointer.y);
    const diameter = HOVER_RADIUS * 2;
    ring.hidden = false;
    ring.style.width = ring.style.height = `${diameter}px`;
    ring.style.transform = `translate(${pointer.x - diameter / 2}px, ${pointer.y - diameter / 2}px)`;
    ring.classList.toggle('guarded', piece === -1);
    if (piece === null || piece === -1) {
      ring.dataset.label = piece === -1 ? 'Bâti ou trop grand : pinceau' : '';
      clearPreview();
      return;
    }
    const cells = [...pieces.cellsOf(piece)].filter((cell) => mask.cells.has(cell) !== erasing);
    ring.dataset.label = !cells.length ? 'Déjà retiré' : `${erasing ? 'Clic : retirer' : 'Clic : rendre'} (${pieces.cellsOf(piece).length} cases)`;
    drawPreview(cells, erasing ? ERASE_COLOR : RESTORE_COLOR);
  }

  const showRing = () => {
    if (!pointer) return;
    const diameter = Number(sizeInput.value) * 2;
    ring.hidden = false;
    ring.style.width = ring.style.height = `${diameter}px`;
    ring.style.transform = `translate(${pointer.x - diameter / 2}px, ${pointer.y - diameter / 2}px)`;
    showAim();
  };
  const hideRing = () => {
    ring.hidden = true;
    clearPreview();
  };
  canvas.addEventListener('pointerleave', () => {
    pointer = null;
    if (!stroke) hideRing();
  });
  addEventListener('keydown', (event) => {
    if (pointer && event.key === 'Alt') pointer.forced = true;
    if ((event.key === 'Shift' || event.key === 'Alt') && event.shiftKey && isAdmin) {
      aimedAt = 0;
      showRing();
    }
  });
  addEventListener('keyup', (event) => {
    if (pointer && event.key === 'Alt') {
      pointer.forced = false;
      aimedAt = 0;
      if (event.shiftKey && isAdmin) showRing();
    }
    if (event.key === 'Shift' && !stroke) hideRing();
  });

  const replay = (from, to, erase) => {
    const done = from.pop();
    if (!done) return;
    for (const cell of done.cells) setCell(cell, erase(done));
    to.push(done);
    cloud.sortTraces(done.box);
    saveSoon();
    showState();
  };
  const undo = () => replay(history, undone, (done) => !done.erase);
  const redo = () => replay(undone, history, (done) => done.erase);
  find('loose').addEventListener('input', () => {
    showState();
    if (!pieces) return;
    drawPreview(loosePieces().flatMap((piece) => [...pieces.cellsOf(piece)]), ERASE_COLOR);
  });
  find('sweep').addEventListener('click', () => {
    clearPreview();
    takePieces(loosePieces(), true);
  });
  find('undo').addEventListener('click', undo);
  find('redo').addEventListener('click', redo);
  addEventListener('keydown', (event) => {
    if (!isAdmin || !(event.ctrlKey || event.metaKey) || event.code !== 'KeyZ') return;
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
  });

  const openTools = () => {
    isAdmin = true;
    find('login').hidden = true;
    find('tools').hidden = false;
    status.textContent = '';
    // The working view: as many points as possible.
    document.querySelector('[data-profile="detaille"]').click();
    let old = [];
    try {
      old = JSON.parse(localStorage.getItem(OLD_STORE)) ?? [];
    } catch (error) {
      console.warn('nettoyage', error);
    }
    if (old.length) {
      for (const done of old) {
        for (const cell of done.cells) if (!mask.cells.has(cell)) setCell(cell, true);
        cloud.sortTraces(done.box);
      }
      saveSoon();
    }
    showState();
    loadPieces().then((loaded) => {
      pieces = loaded;
      showState();
    }).catch((error) => {
      console.warn('nettoyage', error);
      find('sweep').textContent = 'Morceaux indisponibles : pinceau seul';
    });
  };
  find('login').addEventListener('submit', async (event) => {
    event.preventDefault();
    const response = await fetch('/api/nettoyage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: find('password').value }) }).catch(() => null);
    find('password').value = '';
    if (response?.ok) openTools();
    else status.textContent = response?.status === 401 ? 'Mot de passe incorrect.' : 'Connexion impossible, réessayez.';
  });
  cloud.markTraces(true);
  fetch('/api/nettoyage').then((response) => {
    if (response.ok) openTools();
    else if (response.status === 503) status.textContent = "Le mot de passe administrateur n'est pas encore configuré.";
    else find('login').hidden = false;
  }).catch(() => { status.textContent = 'Connexion impossible, rechargez la page.'; });

  return {
    // Each of these says whether the event was the brush's.
    pointerDown(event) {
      if (isAdmin && pieces && event.button === 0 && !event.shiftKey) {
        pressed = { x: event.clientX, y: event.clientY, moved: false };
        hideRing();
        return false;
      }
      if (!isAdmin || event.button !== 0 || !event.shiftKey) return false;
      canvas.setPointerCapture(event.pointerId);
      stroke = { erase: erasing, forced: event.altKey, cells: [], box: emptyBounds() };
      previewGeometry.setDrawRange(0, 0);
      previewMaterial.color.set(erasing ? ERASE_COLOR : RESTORE_COLOR);
      last = { x: event.clientX, y: event.clientY };
      stamp(event.clientX, event.clientY);
      return true;
    },
    pointerMove(event) {
      pointer = { x: event.clientX, y: event.clientY, forced: event.altKey };
      if (pressed) {
        if (Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > CLICK_SLOP) pressed.moved = true;
        return false;
      }
      if (isAdmin && event.shiftKey) showRing();
      else if (!stroke && isAdmin && pieces) showHover();
      else if (!stroke) hideRing();
      if (!stroke) return false;
      const step = Math.max(Number(sizeInput.value) / 2, 1);
      const distance = Math.hypot(event.clientX - last.x, event.clientY - last.y);
      if (distance < step) return true;
      for (let travelled = step; travelled <= distance; travelled += step) {
        stamp(last.x + ((event.clientX - last.x) * travelled) / distance, last.y + ((event.clientY - last.y) * travelled) / distance);
      }
      last = { x: event.clientX, y: event.clientY };
      return true;
    },
    pointerUp() {
      if (pressed) {
        const { x, y, moved } = pressed;
        pressed = null;
        const piece = moved ? -1 : pieceUnder(x, y);
        if (piece !== null && piece >= 0) takePieces([piece], erasing);
        aimedAt = 0;
        return false;
      }
      if (!stroke) return false;
      keepDone(stroke);
      stroke = null;
      previewGeometry.setDrawRange(0, 0);
      cloud.onChange();
      return true;
    },
    drawOver() {
      if (!previewGeometry.drawRange.count && !target.visible) return;
      renderer.setRenderTarget(null);
      renderer.render(previewScene, camera);
    },
  };
}
