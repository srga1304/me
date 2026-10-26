import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// The robot head from EMT-01 Assembly Simulator, exported from the game's scene.
// Its parts fly in from the four sides of the frame in the game's build order,
// hold together for a while (eyes follow the cursor), then fly apart again.

const MODEL_URL = 'robot_head.glb';
// Build order in the game (data/parts.json). "Ears" is exported as "Ears5".
const PART_ORDER = ['Skull', 'Mouth', 'Teeth', 'Ears', 'EyeFrame', 'Eyes', 'Face'];
// Containers whose children fly one by one instead of as a single block.
const SPLIT_NODES = ['Motors'];

const PIXEL_SIZE = 2;          // one rendered pixel = 2 css pixels
const PART_GAP = 0.55;         // s between the starts of two parts
const PIECE_SPREAD = 0.5;      // s of random delay inside one part
const FLY_IN = 0.75;           // s for one piece to land
const FLY_OUT = 0.6;           // s for one piece to leave
const HOLD = 5.5;              // s the head stays whole
const EMPTY = 0.8;             // s of empty frame before the next build
const OUT_GAP = 0.25;          // s between parts while flying apart
const BASE_YAW = -0.35;        // a three-quarter view reads the depth
// Lid angles from the game's face_rig.gd (degrees about X).
const LID_CLOSED = 80, LID_OPEN = -70;   // the lower lids stay as they are
const WAKE = 0.6;              // s for the lids to open once the head is whole
const BLINK = 0.16;            // s one blink takes

const container = document.querySelector('.model');
const canvas = document.getElementById('modelCanvas');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator(renderer)
    .fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.6;

const camera = new THREE.PerspectiveCamera(28, 1, 0.01, 50);
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(1.5, 2, 2.5);
scene.add(key);
const rim = new THREE.DirectionalLight(0xbfd0ff, 1.4);
rim.position.set(-2, 1, -1.5);
scene.add(rim);

// PS1 look: vertices snap to the low-res pixel grid, so edges wobble as parts move.
const snapRes = { value: new THREE.Vector2(150, 150) };
function addVertexSnap(material) {
    material.onBeforeCompile = (shader) => {
        shader.uniforms.snapRes = snapRes;
        shader.vertexShader = 'uniform vec2 snapRes;\n' + shader.vertexShader.replace(
            '#include <project_vertex>',
            `#include <project_vertex>
            vec2 snapped = floor(gl_Position.xy / gl_Position.w * snapRes * 0.5 + 0.5) / (snapRes * 0.5);
            gl_Position.xy = snapped * gl_Position.w;`
        );
    };
}

const pivot = new THREE.Group();   // turns the head; centred on it
scene.add(pivot);

let pieces = [];
let eyes = [];
let lids = [];                 // upper lid pieces
let nextBlink = 0;
let cycleStart = 0;
let assembleEnd = 0;
let disassembleLen = 0;
let skipHold = false;
const pointer = new THREE.Vector2(0, 0);   // -1..1 over the page

const ease = {
    outBack: (t) => { const c = 1.4; const u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u; },
    inCubic: (t) => t * t * t,
};

function sideOf(center, fallback) {
    // The side of the frame nearest to where the piece sits on the head.
    const ax = Math.abs(center.x), ay = Math.abs(center.y);
    if (Math.max(ax, ay) < 0.025) return fallback;
    if (ax > ay) return new THREE.Vector3(Math.sign(center.x), 0, 0);
    return new THREE.Vector3(0, Math.sign(center.y), 0);
}

const SIDES = [
    new THREE.Vector3(0, -1, 0), new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 1, 0), new THREE.Vector3(-1, 0, 0),
];

function collectPieces(part) {
    const out = [];
    for (const child of part.children) {
        if (SPLIT_NODES.some((n) => child.name.startsWith(n))) out.push(...child.children);
        else out.push(child);
    }
    return out;
}

function setup(gltf) {
    const head = gltf.scene;
    head.traverse((o) => {
        if (o.isMesh) {
            o.material = o.material.clone();
            addVertexSnap(o.material);
        }
    });

    // Centre the head on the pivot.
    const box = new THREE.Box3().setFromObject(head);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    head.position.sub(center);
    pivot.add(head);
    pivot.updateMatrixWorld(true);

    const radius = Math.max(size.x, size.y) * 0.5;
    const dist = radius / Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * 1.25;
    camera.position.set(0, 0, dist);
    camera.lookAt(0, 0, 0);
    // How far a piece starts: well past the frame edge at the head's depth.
    const offFrame = radius * 3.2;

    const root = head.children.length === 1 && !PART_ORDER.some((p) => head.name.startsWith(p))
        ? head.children[0] : head;
    const parts = PART_ORDER
        .map((name) => root.children.find((c) => c.name.startsWith(name)))
        .filter(Boolean);

    let t = 0;
    parts.forEach((part, partIndex) => {
        const fallback = SIDES[partIndex % SIDES.length];
        for (const obj of collectPieces(part)) {
            const b = new THREE.Box3().setFromObject(obj);
            if (b.isEmpty()) continue;
            const c = b.getCenter(new THREE.Vector3());
            const side = sideOf(c, fallback);
            const worldPos = obj.getWorldPosition(new THREE.Vector3());
            const startWorld = worldPos.clone()
                .addScaledVector(side, offFrame * (1 + Math.random() * 0.4))
                .add(new THREE.Vector3(
                    side.x === 0 ? (Math.random() - 0.5) * radius : 0,
                    side.y === 0 ? (Math.random() - 0.5) * radius : 0,
                    (Math.random() - 0.5) * radius));
            const restPos = obj.position.clone();
            const startPos = obj.parent.worldToLocal(startWorld.clone());
            const restQuat = obj.quaternion.clone();
            const spin = new THREE.Quaternion().setFromEuler(new THREE.Euler(
                (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4));
            pieces.push({
                obj, restPos, startPos, restQuat,
                startQuat: restQuat.clone().multiply(spin),
                partIndex,
                inAt: partIndex * PART_GAP + Math.random() * PIECE_SPREAD,
                outAt: (parts.length - 1 - partIndex) * OUT_GAP + Math.random() * PIECE_SPREAD * 0.6,
            });
        }
        t = Math.max(t, partIndex * PART_GAP + PIECE_SPREAD + FLY_IN);
    });
    assembleEnd = t;
    disassembleLen = (parts.length - 1) * OUT_GAP + PIECE_SPREAD * 0.6 + FLY_OUT;

    const eyesNode = root.children.find((c) => c.name.startsWith('Eyes'));
    if (eyesNode) {
        eyes = eyesNode.children
            .filter((c) => /^Eye[LR]/.test(c.name))
            .map((obj) => ({ obj, rest: obj.quaternion.clone() }));
    }

    for (const p of pieces) {
        if (/^Lid[LR]/.test(p.obj.name)) lids.push(p);
    }

    resize();
    cycleStart = performance.now() / 1000;
}

function place(p, k) {
    // k = 0 at the start position, 1 at rest.
    p.obj.position.lerpVectors(p.startPos, p.restPos, k);
    p.obj.quaternion.slerpQuaternions(p.startQuat, p.restQuat, Math.min(Math.max(k, 0), 1));
    p.obj.visible = k > 0.001;
}

function updateCycle(now) {
    if (reduceMotion) {
        for (const p of pieces) place(p, 1);
        return true;
    }
    let t = now - cycleStart;
    const holdEnd = assembleEnd + HOLD;
    if (skipHold && t > assembleEnd && t < holdEnd) {
        cycleStart -= holdEnd - t;
        t = holdEnd;
    }
    skipHold = false;
    const outEnd = holdEnd + disassembleLen;
    if (t > outEnd + EMPTY) {
        cycleStart = now;
        t = 0;
    }
    for (const p of pieces) {
        if (t < holdEnd) {
            const k = Math.min(Math.max((t - p.inAt) / FLY_IN, 0), 1);
            place(p, k === 0 ? 0 : ease.outBack(k));
        } else {
            const k = Math.min(Math.max((t - holdEnd - p.outAt) / FLY_OUT, 0), 1);
            place(p, 1 - ease.inCubic(k));
        }
    }
    poseLids(t, holdEnd);
    return t > assembleEnd && t < holdEnd;   // whole
}

const lidEuler = new THREE.Euler();
function poseLids(t, holdEnd) {
    // Shut while it is being built; it wakes once whole, blinks, shuts before it comes apart.
    const smooth = (x) => { x = Math.min(Math.max(x, 0), 1); return x * x * (3 - 2 * x); };
    let open = smooth((t - assembleEnd) / WAKE) * (1 - smooth((t - holdEnd + WAKE * 0.5) / (WAKE * 0.5)));
    if (t < assembleEnd || t > holdEnd) nextBlink = t + 1.5 + Math.random() * 2;
    else if (t > nextBlink) {
        const b = (t - nextBlink) / BLINK;
        if (b > 1) nextBlink = t + 2 + Math.random() * 3;
        else open *= Math.abs(b * 2 - 1);
    }
    for (const piece of lids) {
        const deg = THREE.MathUtils.lerp(LID_CLOSED, LID_OPEN, open);
        piece.restQuat.setFromEuler(lidEuler.set(THREE.MathUtils.degToRad(deg), 0, 0));
        if (t > assembleEnd && t < holdEnd) piece.obj.quaternion.copy(piece.restQuat);
    }
}

const lookQuat = new THREE.Quaternion();
const lookEuler = new THREE.Euler();
let yaw = BASE_YAW, pitch = 0;

function updateLook(whole, dt) {
    // The head turns a little toward the cursor; the eyes turn further.
    const targetYaw = whole ? BASE_YAW * 0.4 + pointer.x * 0.45 : BASE_YAW;
    const targetPitch = whole ? -pointer.y * 0.25 : 0;
    const k = 1 - Math.exp(-dt * 3);
    yaw += (targetYaw - yaw) * k;
    pitch += (targetPitch - pitch) * k;
    pivot.rotation.set(pitch, yaw, 0);
    for (const e of eyes) {
        lookEuler.set(whole ? -pointer.y * 0.35 : 0, whole ? pointer.x * 0.5 : 0, 0);
        lookQuat.setFromEuler(lookEuler);
        e.obj.quaternion.slerp(e.rest.clone().multiply(lookQuat), k);
    }
}

function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    const rw = Math.max(1, Math.round(w / PIXEL_SIZE)), rh = Math.max(1, Math.round(h / PIXEL_SIZE));
    renderer.setSize(rw, rh, false);
    snapRes.value.set(rw, rh);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
}

let visible = true;
new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }).observe(container);

let last = performance.now() / 1000;
function animate() {
    requestAnimationFrame(animate);
    const now = performance.now() / 1000;
    const dt = Math.min(now - last, 0.1);
    last = now;
    if (!visible || document.hidden || pieces.length === 0) {
        // Don't let the cycle jump ahead while nobody watches.
        cycleStart += dt;
        return;
    }
    const whole = updateCycle(now);
    updateLook(whole, dt);
    renderer.render(scene, camera);
}

new GLTFLoader().load(MODEL_URL, setup, undefined, (error) => console.error(error));
animate();

window.addEventListener('resize', resize);
window.addEventListener('pointermove', (e) => {
    const r = container.getBoundingClientRect();
    // Relative to the head, clamped so far-away cursors don't overturn it.
    const x = (e.clientX - (r.left + r.width / 2)) / (window.innerWidth / 2);
    const y = (e.clientY - (r.top + r.height / 2)) / (window.innerHeight / 2);
    pointer.set(THREE.MathUtils.clamp(x, -1, 1), THREE.MathUtils.clamp(y, -1, 1));
});
// A click on the whole head takes it apart early.
container.addEventListener('click', () => { skipHold = true; });

const AKA_REVEAL_THRESHOLD = 5;

function setupAkaToggle() {
  const akaToggle = document.getElementById('akaToggle');
  const moreAka = document.getElementById('moreAka');
  const akaPavelKaimakovText = moreAka ? moreAka.querySelector('.aka-pavel-kaimakov-text') : null;
  let akaOpenCount = 0;

  if (akaToggle && moreAka) {
    akaToggle.addEventListener('click', () => {
      moreAka.classList.toggle('hidden-aka');

      if (!moreAka.classList.contains('hidden-aka')) {
        // moreAka is now visible
        akaOpenCount++;
        if (akaOpenCount >= AKA_REVEAL_THRESHOLD && akaPavelKaimakovText) {
          akaPavelKaimakovText.classList.add('is-visible');
        }
      } else {
        // moreAka is now hidden, ensure akaPavelKaimakovText is hidden too
        if (akaPavelKaimakovText) {
          akaPavelKaimakovText.classList.remove('is-visible');
        }
      }
    });
  }
}

// Module scripts run after parsing, so DOMContentLoaded may already be gone.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupAkaToggle);
else setupAkaToggle();
