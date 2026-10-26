import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// The robot head from EMT-01 Assembly Simulator, exported from the game's scene.
// It turns all the time. First the frame is empty, then the parts arrive one by
// one, each whole, in the game's build order, from the four sides of the frame.
// Whole, it wakes: the lids open, it blinks, the eyes follow the cursor. Then it
// shuts its eyes and comes apart, last part first.

const MODEL_URL = 'robot_head.glb';
// Build order in the game (data/parts.json) and the side each part comes from.
// "Ears" is exported as "Ears5".
const PARTS = [
    { name: 'Skull', side: [0, -1] },
    { name: 'Mouth', side: [-1, 0] },
    { name: 'Teeth', side: [1, 0] },
    { name: 'Ears', side: [0, 1] },
    { name: 'EyeFrame', side: [-1, 0] },
    { name: 'Eyes', side: [1, 0] },
    { name: 'Face', side: [0, 1] },
];

const PIXEL_SIZE = 2;          // one rendered pixel = 2 css pixels
const EMPTY = 1.5;             // s of empty frame before the skull comes
const FLY_IN = 1.6;            // s for one part to land
const SETTLE = 0.5;            // s between one part landing and the next leaving the edge
const HOLD = 7;                // s the head stays whole
const FLY_OUT = 1.0;           // s for one part to leave
const OUT_GAP = 0.45;          // s between parts while it comes apart
const TURN_PERIOD = 9;         // s per turn, roughly: the head never stops turning
const TILT = 0.12;             // rad, a slight look from above
const TUMBLE = 0.6;            // rad, how askew a part is while it flies
// Lid angles from the game's face_rig.gd (degrees about X); the lower lids stay as they are.
const LID_CLOSED = 80, LID_OPEN = -70;
const WAKE = 0.8;              // s for the lids to open once the head is whole
const BLINK = 0.16;            // s one blink takes
const EYE_MAX = 0.6;           // rad, how far the eyes turn in their sockets

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

let parts = [];                // { obj, restPos, restQuat, side, tumble, inAt, outAt }
let eyes = [];                 // { obj, rest }
let lids = [];                 // { obj }
let offFrame = 1;
let assembleEnd = 0, holdEnd = 0, cycleEnd = 0;
let cycleStart = 0;
let turnsPerCycle = 1;
let skipHold = false;
let nextBlink = 0;
const pointer = new THREE.Vector2(0, 0);   // -1..1 around the head

const ease = {
    outBack: (t) => { const c = 0.8; const u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u; },
    inCubic: (t) => t * t * t,
    smooth: (t) => { t = Math.min(Math.max(t, 0), 1); return t * t * (3 - 2 * t); },
};

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
    const size = box.getSize(new THREE.Vector3());
    head.position.sub(box.getCenter(new THREE.Vector3()));
    pivot.add(head);

    // Turning, the head sweeps a circle: fit that, not the front view.
    const radius = Math.max(Math.hypot(size.x, size.z), size.y) * 0.5;
    const dist = radius / Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * 1.1;
    camera.position.set(0, 0, dist);
    camera.lookAt(0, 0, 0);
    offFrame = radius * 3;     // well past the frame edge at the head's depth

    const root = head.getObjectByName('RobotHead') || head.children[0];
    let t = EMPTY;
    PARTS.forEach((p) => {
        const obj = root.children.find((c) => c.name.startsWith(p.name));
        if (!obj) return;
        parts.push({
            obj,
            restPos: obj.position.clone(),
            restQuat: obj.quaternion.clone(),
            side: new THREE.Vector3(p.side[0], p.side[1], 0),
            tumble: new THREE.Euler(
                (Math.random() - 0.5) * TUMBLE, (Math.random() - 0.5) * TUMBLE, (Math.random() - 0.5) * TUMBLE),
            inAt: t,
        });
        t += FLY_IN + SETTLE;
    });
    assembleEnd = t;
    holdEnd = assembleEnd + HOLD;
    parts.slice().reverse().forEach((p, i) => { p.outAt = holdEnd + i * OUT_GAP; });
    cycleEnd = holdEnd + (parts.length - 1) * OUT_GAP + FLY_OUT;
    // A whole number of turns per cycle, so the loop is seamless and the face
    // looks at you each time it wakes.
    turnsPerCycle = Math.max(1, Math.round(cycleEnd / TURN_PERIOD));

    root.traverse((o) => {
        if (/^Eye[LR]$/.test(o.name)) eyes.push({ obj: o, rest: o.quaternion.clone() });
        if (/^Lid[LR]$/.test(o.name)) lids.push({ obj: o });
    });

    resize();
    cycleStart = performance.now() / 1000;
}

const tmpVec = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const invPivot = new THREE.Quaternion();

function place(p, k) {
    // k = 0 off the frame, 1 at rest. The side is on screen, so it is turned
    // back by the head's own turn to get the offset in the head's space.
    p.obj.visible = k > 0.001;
    if (!p.obj.visible) return;
    invPivot.copy(pivot.quaternion).invert();
    tmpVec.copy(p.side).applyQuaternion(invPivot).multiplyScalar(offFrame * (1 - k));
    p.obj.position.copy(p.restPos).add(tmpVec);
    tmpQuat.setFromEuler(p.tumble).slerp(new THREE.Quaternion(), Math.min(Math.max(k, 0), 1));
    p.obj.quaternion.copy(p.restQuat).multiply(tmpQuat);
}

function updateCycle(now) {
    if (reduceMotion) {
        for (const p of parts) place(p, 1);
        return 1;
    }
    let t = now - cycleStart;
    if (skipHold && t > assembleEnd && t < holdEnd) {
        cycleStart -= holdEnd - t;
        t = holdEnd;
    }
    skipHold = false;
    if (t > cycleEnd) {
        cycleStart = now;
        t = 0;
    }
    for (const p of parts) {
        if (t < holdEnd) place(p, t < p.inAt ? 0 : ease.outBack(Math.min((t - p.inAt) / FLY_IN, 1)));
        else place(p, 1 - ease.inCubic(Math.min(Math.max((t - p.outAt) / FLY_OUT, 0), 1)));
    }
    // How awake it is: opens once whole, shuts just before it comes apart.
    return ease.smooth((t - assembleEnd) / WAKE) * (1 - ease.smooth((t - holdEnd + WAKE) / WAKE));
}

function poseFace(t, awake, dt) {
    let open = awake;
    if (awake < 1) nextBlink = t + 1.5 + Math.random() * 2;
    else if (t > nextBlink) {
        const b = (t - nextBlink) / BLINK;
        if (b > 1) nextBlink = t + 2 + Math.random() * 3;
        else open *= Math.abs(b * 2 - 1);
    }
    for (const l of lids) {
        l.obj.rotation.set(THREE.MathUtils.degToRad(THREE.MathUtils.lerp(LID_CLOSED, LID_OPEN, open)), 0, 0);
    }
    // The eyes look at a point in front of the frame where the cursor is.
    const k = 1 - Math.exp(-dt * 6);
    const target = new THREE.Vector3(pointer.x, -pointer.y, 0).multiplyScalar(offFrame * 0.5);
    target.z = camera.position.z;
    for (const e of eyes) {
        const local = e.obj.parent.worldToLocal(target.clone()).sub(e.obj.position).normalize();
        const yawE = THREE.MathUtils.clamp(Math.atan2(local.x, local.z), -EYE_MAX, EYE_MAX);
        const pitchE = THREE.MathUtils.clamp(-Math.asin(local.y), -EYE_MAX, EYE_MAX);
        tmpQuat.setFromEuler(new THREE.Euler(pitchE * awake, yawE * awake, 0, 'YXZ'));
        e.obj.quaternion.slerp(e.rest.clone().multiply(tmpQuat), k);
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
    if (!visible || document.hidden || parts.length === 0) {
        // Don't let the cycle jump ahead while nobody watches.
        cycleStart += dt;
        return;
    }
    const turn = reduceMotion ? 0
        : (now - cycleStart - assembleEnd - WAKE * 0.5) / cycleEnd * turnsPerCycle * Math.PI * 2;
    pivot.rotation.set(TILT, turn, 0);
    pivot.updateMatrixWorld(true);
    const awake = updateCycle(now);
    pivot.updateMatrixWorld(true);
    poseFace(now - cycleStart, awake, dt);
    renderer.render(scene, camera);
}

new GLTFLoader().load(MODEL_URL, setup, undefined, (error) => console.error(error));
animate();

window.addEventListener('resize', resize);
window.addEventListener('pointermove', (e) => {
    const r = container.getBoundingClientRect();
    const x = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
    const y = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
    pointer.set(THREE.MathUtils.clamp(x, -3, 3), THREE.MathUtils.clamp(y, -3, 3));
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
