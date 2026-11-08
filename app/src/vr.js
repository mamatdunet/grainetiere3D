// The visit in a headset, from the browser (WebXR), steered with the controllers. Two eyes to draw 72 times a
// second on the chip of a headset: fewer points than on a computer, without the screen-space passes of the
// improved rendering, and square points, which the chip draws much faster than round ones.
import * as THREE from 'three';
import { gunzipIfNeeded } from './cloud.js';

const BUDGET = { start: 4_500_000, min: 3_000_000, max: 15_000_000 };
// By hand, with the grips: the visitor may ask for more, or less, than the automatic setting would dare.
const BUDGET_BY_HAND = { min: 1_000_000, max: 20_000_000, step: 1.25 };
const MAX_NEW_POINTS = 400_000;
// A quarter of the nodes hold about 1 % of the points, and every node costs a call for each eye.
const MIN_NODE_POINTS = 1000;
const UPDATE_EVERY = 150;
// The selection runs less often than the head turns: it looks wider than the eyes, so that nothing is missing at the edges.
const SELECTION_FOV = 125;
const POINT_SIZE = { min: 2.2, max: 14 };
const ADAPT_EVERY = 2000;
// Turning the head stays smooth below the screen's rate, the headset taking care of it: detail comes first.
const TOO_SLOW = 0.6;
const FAST_ENOUGH = 0.85;
const BUDGET_DOWN = 0.85;
const BUDGET_UP = 1.1;
const STICK_DEADZONE = 0.15;
const TURN_SPEED = Math.PI / 2;
// Motion follows the sticks closely, without starting or stopping dead.
const STICK_RESPONSE = 12;
const MAX_BOOST = 3;
const FADE_RATE = 2.5;
const PANEL_DISTANCE = 1.6;
const PANEL_DROP = 0.15;
const HELP_TIME = 15;
const STORY_TIME = 25;
const DENSITY_TIME = 8;
const TITLE_TIME = 5;
// Positions in the standard mapping of a controller's buttons.
const TRIGGER = 0;
const STICK_CLICK = 3;
// Prototype of a surface mode, on one area only (see pipeline/mesh_area.py).
const SURFACE_FILE = 'surfaces/galerie_ouest.bin.gz';
const SURFACE_PLACE = 'galerie_ouest';
const LOWER_FACE = 4;
const UPPER_FACE = 5;
const HELP = [
  'Stick gauche : se déplacer vers où vous regardez',
  'Stick droit : tourner à gauche ou à droite, monter ou descendre',
  'Gâchette : aller plus vite',
  'A : lancer ou mettre en pause la visite guidée',
  'B : lieu suivant de la visite',
  'X : le texte sur ce lieu    Y : cette aide',
  'Poignées : moins de points (gauche), plus de points (droite)',
  'Clic du stick droit : musique',
  'Clic du stick gauche : points ou surfaces (galerie ouest)',
  'Bouton Oculus de la manette droite : quitter',
];

const Z_AXIS = new THREE.Vector3(0, 0, 1);
const moving = new THREE.Vector3();
const direction = new THREE.Vector3();
const side = new THREE.Vector3();
// Nothing in the dead zone, then gentle at first for fine moves, and full speed at the end of the stick's travel.
function eased(value) {
  const beyond = Math.max(Math.abs(value) - STICK_DEADZONE, 0) / (1 - STICK_DEADZONE);
  return Math.sign(value) * beyond * beyond;
}
// Headsets count height along Y, the survey along Z.
const Y_UP_TO_Z_UP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

// A sign in the air, a little below eye level, that stays where it was put.
class Panel {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1024;
    this.canvas.height = 768;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1.28, 0.96),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false }),
    );
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;
    this.time = 0;
    this.kind = null;
  }

  show(kind, title, lines, seconds, head) {
    this.write(title, lines);
    this.kind = kind;
    this.time = seconds;
    this.mesh.visible = true;
    // Straight ahead on the level, wherever the head is tilted.
    const ahead = new THREE.Vector3(0, 0, -1).applyQuaternion(head.quaternion).setY(0).normalize();
    this.mesh.position.copy(head.position).addScaledVector(ahead, PANEL_DISTANCE);
    this.mesh.position.y -= PANEL_DROP;
    this.mesh.rotation.set(0, Math.atan2(-ahead.x, -ahead.z), 0);
  }

  write(title, lines) {
    const context = this.canvas.getContext('2d');
    const { width, height } = this.canvas;
    context.clearRect(0, 0, width, height);
    context.fillStyle = 'rgba(13, 12, 10, 0.86)';
    context.beginPath();
    context.roundRect(0, 0, width, height, 28);
    context.fill();
    context.fillStyle = '#f8f5ef';
    context.font = '400 52px Marcellus, Georgia, serif';
    context.fillText(title, 48, 88, width - 96);
    context.fillStyle = '#c9bda8';
    context.font = '34px Lato, "Helvetica Neue", sans-serif';
    let y = 152;
    for (const line of lines) {
      let row = '';
      for (const word of line.split(' ')) {
        if (context.measureText(`${row} ${word}`).width > width - 96 && row) {
          context.fillText(row, 48, y);
          y += 46;
          row = word;
        } else {
          row = row ? `${row} ${word}` : word;
        }
      }
      context.fillText(row, 48, y);
      y += 52;
    }
    this.texture.needsUpdate = true;
  }

  hide() {
    this.mesh.visible = false;
    this.kind = null;
  }

  tick(dt) {
    if (!this.mesh.visible) return;
    this.time -= dt;
    if (this.time <= 0) this.hide();
  }
}

async function loadSurface(app) {
  const response = await fetch(`${app.baseUrl}/${SURFACE_FILE}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = await gunzipIfNeeded(await response.arrayBuffer());
  const size = new Uint32Array(buffer, 0, 1)[0];
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, size)));
  let at = 4 + size;
  const take = (Type, count) => {
    const part = new Type(buffer, at, count);
    at += part.byteLength;
    return part;
  };
  const { uSun, uAmbient, uKey } = app.skyUniforms;
  const material = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: { uSun, uAmbient, uKey },
    // The same light as the improved rendering, here from true surface directions.
    vertexShader: /* glsl */ `
      uniform vec3 uSun, uAmbient, uKey;
      attribute float tone;
      varying vec3 vColor;
      void main() {
        vec3 light = (0.62 + 0.2 * normal.z) * uAmbient + 0.4 * max(dot(normal, uSun), 0.0) * uKey;
        // Stone returns the laser within a narrow range: widen it, or the walls come out all of one grey.
        float shade = clamp((tone - 0.66) * 2.5 + 0.6, 0.05, 1.0);
        vColor = shade * vec3(1.0, 0.965, 0.9) * light;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() { gl_FragColor = vec4(vColor, 1.0); }
    `,
  });
  const mesh = new THREE.Group();
  for (const { vertices, triangles } of header.tiles) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(take(Float32Array, vertices * 3), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(take(Int8Array, vertices * 3), 3, true));
    geometry.setAttribute('tone', new THREE.BufferAttribute(take(Uint8Array, vertices), 1, true));
    geometry.setIndex(new THREE.BufferAttribute(take(Uint32Array, triangles * 3), 1));
    mesh.add(new THREE.Mesh(geometry, material));
  }
  const triangles = header.tiles.reduce((sum, tile) => sum + tile.triangles, 0);
  return { mesh, box: new THREE.Box3(new THREE.Vector3(...header.low), new THREE.Vector3(...header.high)), triangles };
}

export class Headset {
  constructor(app) {
    this.app = app;
    this.active = false;
    this.rig = new THREE.Group();
    this.rig.visible = false;
    this.head = new THREE.PerspectiveCamera(70, 1, 0.05, 4000);
    this.rig.add(this.head);
    // What the selection of points works from: where the head is, in the coordinates of the survey.
    this.view = new THREE.PerspectiveCamera(SELECTION_FOV, 1, 0.05, 4000);
    this.view.updateProjectionMatrix();
    this.selection = this.view.projectionMatrix.clone();
    this.panel = new Panel();
    this.rig.add(this.panel.mesh);

    this.dark = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, transparent: true, opacity: 0, depthTest: false, depthWrite: false }),
    );
    this.dark.renderOrder = 20;
    this.dark.visible = false;
    this.head.add(this.dark);

    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(3000, 24, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthTest: false,
        depthWrite: false,
        uniforms: app.skyUniforms,
        vertexShader: /* glsl */ `
          varying vec3 vDirection;
          void main() {
            vDirection = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          ${app.skyShader}
          varying vec3 vDirection;
          void main() { gl_FragColor = vec4(openSky(normalize(vDirection)), 1.0); }
        `,
      }),
    );
    this.sky.renderOrder = -1;
    this.sky.frustumCulled = false;
    this.sky.visible = false;
    app.scene.add(this.rig, this.sky);

    this.yaw = 0;
    this.pressed = new Map();
    this.turnRate = 0;
    this.walk = new THREE.Vector3();
    this.aligned = false;
    this.place = null;
  }

  async enter() {
    const { renderer, cloud } = this.app;
    const session = await navigator.xr.requestSession('immersive-vr');
    this.session = session;
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local');
    // Before the session is handed over: set afterwards, the loop would also run on the page's own frames.
    renderer.setAnimationLoop((now) => { if (this.active) this.frame(now); });
    await renderer.xr.setSession(session);
    renderer.xr.setFoveation(1);

    const { uniforms } = cloud.material;
    this.flat = {
      budget: cloud.pointBudget,
      maxNewPoints: cloud.maxNewPoints,
      minNodePoints: cloud.minNodePoints,
      minSize: uniforms.uMinSize.value,
      maxSize: uniforms.uMaxSize.value,
      minTone: uniforms.uMinTone.value,
    };
    cloud.pointBudget = BUDGET.start;
    cloud.maxNewPoints = MAX_NEW_POINTS;
    cloud.minNodePoints = MIN_NODE_POINTS;
    uniforms.uMinSize.value = POINT_SIZE.min;
    uniforms.uMaxSize.value = POINT_SIZE.max;
    cloud.material.defines.SQUARE_POINTS = 1;
    cloud.material.needsUpdate = true;
    renderer.autoClear = true;

    this.active = true;
    this.rig.visible = this.sky.visible = true;
    this.yaw = this.app.look.yaw - Math.PI / 2;
    this.place = this.app.placeText;
    this.showHelpSoon = true;
    this.drawn = false;
    this.byHand = false;
    this.rate = 0;
    this.previous = performance.now();
    this.lastUpdate = 0;
    this.adaptStart = this.previous;
    this.adaptFrames = 0;

    session.addEventListener('squeezestart', (event) => this.changeDensity(event.inputSource.handedness === 'left' ? 1 / BUDGET_BY_HAND.step : BUDGET_BY_HAND.step));
    session.addEventListener('end', () => this.left());
  }

  left() {
    const { renderer, cloud, camera, look } = this.app;
    renderer.setAnimationLoop(null);
    renderer.xr.enabled = false;
    renderer.autoClear = false;
    cloud.pointBudget = this.flat.budget;
    cloud.maxNewPoints = this.flat.maxNewPoints;
    cloud.minNodePoints = this.flat.minNodePoints;
    const { uniforms } = cloud.material;
    uniforms.uMinSize.value = this.flat.minSize;
    uniforms.uMaxSize.value = this.flat.maxSize;
    uniforms.uMinTone.value = this.flat.minTone;
    delete cloud.material.defines.SQUARE_POINTS;
    cloud.material.needsUpdate = true;
    // Back on the screen, looking the way the head last did.
    look.yaw = this.headYaw();
    look.pitch = 0;
    camera.updateMatrixWorld();
    this.app.applyLook();
    if (this.surfaceShown) this.showSurface(false);
    this.rig.visible = this.sky.visible = false;
    this.panel.hide();
    this.active = false;
    this.session = null;
    this.app.leftHeadset();
  }

  headYaw() {
    const forward = this.head.getWorldDirection(new THREE.Vector3());
    return Math.atan2(forward.y, forward.x);
  }

  // Turn around the head, not around the place where the session began.
  turn(angle) {
    const { camera } = this.app;
    const before = this.head.position.clone().applyQuaternion(this.rig.quaternion);
    this.yaw += angle;
    this.placeRig();
    const after = this.head.position.clone().applyQuaternion(this.rig.quaternion);
    camera.position.add(before).sub(after);
    camera.updateMatrixWorld();
  }

  placeRig() {
    this.rig.quaternion.setFromAxisAngle(Z_AXIS, this.yaw).multiply(Y_UP_TO_Z_UP);
    this.rig.position.copy(this.app.camera.position);
    this.rig.updateMatrixWorld(true);
    this.sky.position.copy(this.rig.position);
  }

  justPressed(side, index, button) {
    const key = `${side}${index}`;
    const was = this.pressed.get(key);
    this.pressed.set(key, button.pressed);
    return button.pressed && !was;
  }

  controls(dt) {
    const { camera, music } = this.app;
    let walkX = 0, walkY = 0, boost = 1;
    let stickX = 0, stickY = 0;
    for (const source of this.session.inputSources) {
      const pad = source.gamepad;
      if (!pad) continue;
      const left = source.handedness === 'left';
      const x = pad.axes[2] ?? 0, y = pad.axes[3] ?? 0;
      if (left) [walkX, walkY] = [x, y];
      else [stickX, stickY] = [x, y];
      boost = Math.max(boost, 1 + (pad.buttons[TRIGGER]?.value ?? 0) * (MAX_BOOST - 1));
      const lower = pad.buttons[LOWER_FACE], upper = pad.buttons[UPPER_FACE], click = pad.buttons[STICK_CLICK];
      if (lower && this.justPressed(source.handedness, LOWER_FACE, lower)) {
        if (left) this.toggleStory();
        else this.app.toggleTour();
      }
      if (upper && this.justPressed(source.handedness, UPPER_FACE, upper)) {
        if (left) this.toggleHelp();
        else this.app.jumpTour(1);
      }
      if (click && this.justPressed(source.handedness, STICK_CLICK, click)) {
        if (left) this.toggleSurface();
        else if (music.playing) music.pause();
        else music.play();
      }
    }

    const response = 1 - Math.exp(-dt * STICK_RESPONSE);
    // The right stick does one thing at a time: turning does not make the visitor climb.
    const turning = Math.abs(stickX) >= Math.abs(stickY);
    this.turnRate += (-(turning ? eased(stickX) : 0) * TURN_SPEED - this.turnRate) * response;
    if (Math.abs(this.turnRate) > 0.001) this.turn(this.turnRate * dt);
    else this.turnRate = 0;

    const moved = Math.hypot(walkX, walkY) > STICK_DEADZONE || (!turning && Math.abs(stickY) > STICK_DEADZONE);
    if (moved) this.app.stopTour();
    const pace = this.app.speed * boost;
    const goal = moving.set(0, 0, turning ? 0 : -eased(stickY) * pace);
    if (Math.hypot(walkX, walkY) > STICK_DEADZONE) {
      const forward = this.head.getWorldDirection(direction).setZ(0).normalize();
      const right = side.crossVectors(forward, Z_AXIS);
      goal.addScaledVector(forward, -eased(walkY) * pace).addScaledVector(right, eased(walkX) * pace);
    }
    this.walk.lerp(goal, response);
    if (this.walk.lengthSq() < 1e-5) {
      this.walk.set(0, 0, 0);
      return;
    }
    if (this.app.tour) return;
    camera.position.addScaledVector(this.walk, dt);
    camera.updateMatrixWorld();
  }

  async toggleSurface() {
    const { app } = this;
    if (this.surfaceLoading) return;
    if (!this.surface) {
      this.surfaceLoading = true;
      this.panel.show('surface', 'Surfaces', ['Chargement…'], STORY_TIME, this.head);
      try {
        this.surface = await loadSurface(app);
        app.scene.add(this.surface.mesh);
      } catch (error) {
        console.error(error);
        this.panel.show('surface', 'Surfaces', ["Elles n'ont pas pu être chargées."], TITLE_TIME, this.head);
        return;
      } finally {
        this.surfaceLoading = false;
      }
      this.surface.mesh.visible = false;
      if (!this.active) return;
    }
    this.showSurface(!this.surfaceShown);
    if (this.surfaceShown && !this.surface.box.containsPoint(app.camera.position)) {
      const place = app.tourPlan.places.find((p) => p.id === SURFACE_PLACE);
      const [x, y, z] = app.tourPlan.chains[place.chain][place.from];
      app.stopTour();
      app.camera.position.set(x, y, z);
      app.camera.updateMatrixWorld();
    }
    const count = (this.surface.triangles / 1e6).toFixed(1).replace('.', ',');
    this.panel.show('surface', this.surfaceShown ? 'Surfaces' : 'Points', this.surfaceShown
      ? [`Prototype : la galerie ouest et ses abords, ${count} millions de triangles. Le reste de l'abbaye reste en points.`]
      : ['Le nuage de points, comme ailleurs.'], TITLE_TIME, this.head);
  }

  showSurface(shown) {
    const { cloud } = this.app;
    this.surfaceShown = shown;
    this.surface.mesh.visible = shown;
    cloud.hiddenBox = shown ? this.surface.box : null;
    if (shown) {
      cloud.material.uniforms.uHiddenLow.value.copy(this.surface.box.min);
      cloud.material.uniforms.uHiddenHigh.value.copy(this.surface.box.max);
      cloud.material.defines.HIDDEN_BOX = 1;
    } else {
      delete cloud.material.defines.HIDDEN_BOX;
    }
    cloud.material.needsUpdate = true;
  }

  changeDensity(factor) {
    const { cloud } = this.app;
    this.byHand = true;
    cloud.pointBudget = THREE.MathUtils.clamp(cloud.pointBudget * factor, BUDGET_BY_HAND.min, BUDGET_BY_HAND.max);
    this.panel.show('density', 'Densité', this.densityLines(), DENSITY_TIME, this.head);
  }

  densityLines() {
    const { cloud } = this.app;
    const millions = (cloud.pointBudget / 1e6).toFixed(1).replace('.', ',');
    return [`${millions} millions de points demandés`, `${Math.round(this.rate)} images par seconde`];
  }

  toggleHelp() {
    if (this.panel.kind === 'help') this.panel.hide();
    else this.panel.show('help', 'Les manettes', HELP, HELP_TIME, this.head);
  }

  toggleStory() {
    if (this.panel.kind === 'story') {
      this.panel.hide();
      return;
    }
    const text = this.app.placeText;
    if (text) this.panel.show('story', text.title, [text.short], STORY_TIME, this.head);
  }

  watchPlace(now) {
    this.app.watchPlace(now);
    const text = this.app.placeText;
    if (text === this.place) return;
    this.place = text;
    if (text && this.panel.kind !== 'help') this.panel.show('title', text.title, [text.role], TITLE_TIME, this.head);
  }

  // A new place of the tour opens looking the way the walk goes. Afterwards, the head alone decides where to look.
  faceTheWalk() {
    const { tour, look } = this.app;
    if (tour?.phase !== 'loading') {
      this.aligned = false;
    } else if (!this.aligned) {
      this.aligned = true;
      this.turn(look.yaw - this.headYaw());
    }
  }

  fade(dt) {
    const material = this.dark.material;
    const goal = this.app.fadeLayer.classList.contains('dark') ? 1 : 0;
    material.opacity += THREE.MathUtils.clamp(goal - material.opacity, -dt * FADE_RATE, dt * FADE_RATE);
    this.dark.visible = material.opacity > 0.001;
  }

  select(now) {
    const { cloud, renderer } = this.app;
    if (now - this.lastUpdate < UPDATE_EVERY) return;
    this.lastUpdate = now;
    const { view, head } = this;
    view.position.setFromMatrixPosition(head.matrixWorld);
    view.matrixWorldInverse.copy(head.matrixWorldInverse);
    view.projectionMatrix.copy(this.selection);
    view.fov = head.fov;
    cloud.update(view, renderer.xr.getBaseLayer()?.framebufferHeight ?? 1584);
  }

  adapt(now) {
    this.adaptFrames += 1;
    if (now - this.adaptStart < ADAPT_EVERY) return;
    const { cloud } = this.app;
    const rate = (this.adaptFrames * 1000) / (now - this.adaptStart);
    const refresh = this.session.frameRate || 72;
    this.rate = rate;
    if (this.panel.kind === 'density') this.panel.write('Densité', this.densityLines());
    if (!this.byHand && rate < refresh * TOO_SLOW) cloud.pointBudget = Math.max(BUDGET.min, cloud.pointBudget * BUDGET_DOWN);
    else if (!this.byHand && rate > refresh * FAST_ENOUGH) cloud.pointBudget = Math.min(BUDGET.max, cloud.pointBudget * BUDGET_UP);
    this.adaptStart = now;
    this.adaptFrames = 0;
  }

  frame(now) {
    const { renderer, scene, cloud, settleTime } = this.app;
    const dt = Math.min((now - this.previous) / 1000, 0.1);
    this.previous = now;
    this.placeRig();
    if (this.drawn) {
      this.controls(dt);
      this.faceTheWalk();
      if (this.showHelpSoon) {
        this.showHelpSoon = false;
        this.toggleHelp();
      }
    }
    this.app.step(dt);
    this.placeRig();
    this.fade(dt);
    this.panel.tick(dt);
    cloud.settle(settleTime);
    this.watchPlace(now);
    if (this.drawn) this.select(now);
    this.adapt(now);
    renderer.render(scene, this.head);
    this.drawn = true;
  }
}
