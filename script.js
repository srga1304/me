import * as THREE from 'https://unpkg.com/three@0.126.1/build/three.module.js';
import { GLTFLoader } from 'https://unpkg.com/three@0.126.1/examples/jsm/loaders/GLTFLoader.js';

const modelContainer = document.querySelector('.model');
const canvas = document.getElementById('modelCanvas');

// Scene setup
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, modelContainer.clientWidth / modelContainer.clientHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
renderer.setSize(modelContainer.clientWidth, modelContainer.clientHeight);

// Add ambient light
const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
scene.add(ambientLight);

// Add directional light
const directionalLight = new THREE.DirectionalLight(0xffffff, 0.6);
directionalLight.position.set(1, 1, 1).normalize();
scene.add(directionalLight);

let model;
const loader = new GLTFLoader();
loader.load(
    'Untitled.glb',
    function (gltf) {
        model = gltf.scene;
        model.scale.set(0.2, 0.2, 0.2); // Уменьшаем модель
        model.rotation.y = Math.PI;
        scene.add(model);

        // Center the model
        const bbox = new THREE.Box3().setFromObject(model);
        const center = bbox.getCenter(new THREE.Vector3());
        model.position.sub(center);

        // Adjust camera position based on model size
        const size = bbox.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const fov = camera.fov * (Math.PI / 180);
        let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));
        cameraZ *= 1.5; // Add some padding
        camera.position.z = cameraZ;
    },
    undefined,
    function (error) {
        console.error(error);
    }
);

// Animation loop
function animate() {
    requestAnimationFrame(animate);

    if (model) {
        model.rotation.y += 0.01; // Rotate around Y-axis
    }

    renderer.render(scene, camera);
}
animate();

// Handle window resize
window.addEventListener('resize', () => {
    const width = modelContainer.clientWidth;
    const height = modelContainer.clientHeight;
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
});
