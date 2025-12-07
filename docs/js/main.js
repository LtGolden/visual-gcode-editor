// G-CODE PARSER
let machinePos = {};
let path = [];

const REAL_NUMBER_REGEX = "[+-]?[0-9]+(?:[.][0-9]*)?";
const AXES = ['x', 'y', 'z'];
const AXES_DETECTORS = {};
AXES.forEach(axis => AXES_DETECTORS[axis] = new RegExp(axis.toUpperCase() + '(' + REAL_NUMBER_REGEX + ')'));

function detectAxisMove(s) {
    let result = {};
    AXES.forEach(axis => {
        let parsed = AXES_DETECTORS[axis].exec(s);
        if (parsed) result[axis] = parseFloat(parsed[1]);
    });
    return result;
}

function cloneObject(o) { return Object.assign({}, o); }

function move(parsedMove) {
    let newPos = Object.assign(cloneObject(machinePos), parsedMove);
    let moved = AXES.some(a => newPos[a] !== machinePos[a]);
    if (moved) {
        path.push(cloneObject(newPos));
        machinePos = newPos;
    }
}

function evaluateCode() {
    path = [];
    machinePos = { x:0, y:0, z:0 };
    path.push(cloneObject(machinePos));

    let lines = document.getElementById("codebox").value.split(/\r?\n/);
    lines.forEach(line => {
        line = line.replace(/[\t ]+/g, '').toUpperCase();
        line = line.replace(/^N[0-9]+/, '');
        let g = /^G([0-9.]+)(.*)/.exec(line);
        if (g) {
            let codeNum = parseFloat(g[1]);
            if (codeNum == 0 || codeNum == 1)
                move(detectAxisMove(g[2]));
        } else {
            let pm = detectAxisMove(line);
            if (Object.keys(pm).length) move(pm);
        }
    });

    drawToolpath();
}

document.getElementById("codebox").addEventListener("input", evaluateCode);

// Three.js
const container = document.getElementById("viewer");
let scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

let camera = new THREE.PerspectiveCamera(60, 1, 0.1, 10000);
let renderer = new THREE.WebGLRenderer({antialias:true});
container.appendChild(renderer.domElement);

scene.add(new THREE.AmbientLight(0xffffff,0.25));

let toolpathObject = null;
let cameraTarget = new THREE.Vector3();
let cameraRadius = 100;
let cameraAngle = 0; 
let cameraHeight = 50;
let vAngle = 0.3;  

// Toolpath
function drawToolpath(){
    if(toolpathObject) scene.remove(toolpathObject);

    const geom = new THREE.BufferGeometry();
    const verts = [];
    path.forEach(p => verts.push(p.x,p.y,p.z));
    geom.setAttribute('position', new THREE.Float32BufferAttribute(verts,3));

    toolpathObject = new THREE.Line(
        geom,
        new THREE.LineBasicMaterial({color:0xffffff})
    );
    scene.add(toolpathObject);

    // camera
    const box = new THREE.Box3().setFromObject(toolpathObject);
    cameraTarget.copy(box.getCenter(new THREE.Vector3()));
    const size = box.getSize(new THREE.Vector3());
    cameraRadius = Math.max(size.x,size.y,size.z) * 3;
    cameraHeight = cameraRadius / 2;

    updateCameraPosition();
}

// Camera Controls
const keys = { w: false, a: false, s: false, d: false };
document.addEventListener('keydown', (e) => { if(keys.hasOwnProperty(e.key)) keys[e.key] = true; });
document.addEventListener('keyup',   (e) => { if(keys.hasOwnProperty(e.key)) keys[e.key] = false; });

function updateCameraPosition() {
    const x = cameraTarget.x + cameraRadius * Math.cos(vAngle) * Math.cos(cameraAngle);
    const y = cameraTarget.y + cameraRadius * Math.sin(vAngle);
    const z = cameraTarget.z + cameraRadius * Math.cos(vAngle) * Math.sin(cameraAngle);

    camera.position.set(x, y, z);

    if (Math.cos(vAngle) < 0) {
        camera.up.set(0, -1, 0); 
    } else {
        camera.up.set(0, 1, 0);  
    }

    camera.lookAt(cameraTarget);
}

function handleCameraControls() {
    const speed = 0.02;
    if (keys.a) cameraAngle -= speed;
    if (keys.d) cameraAngle += speed;
    if (keys.w) vAngle += speed;
    if (keys.s) vAngle -= speed;

    const eps = 0.01;

    updateCameraPosition();
}

// Resizing
function resizeRenderer() {
    const width = container.clientWidth;
    const height = container.clientHeight;
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
}
resizeRenderer();
window.addEventListener('resize', resizeRenderer);

// Animation-
function animate() {
    requestAnimationFrame(animate);
    handleCameraControls();
    renderer.render(scene, camera);
}

// Initialize
evaluateCode();
animate();

// Exporting

function saveCodeAsTxt() {
    const text = document.getElementById("codebox").value;

    let encoder;
    try {
        encoder = new TextEncoder('windows-1252');
    } catch(e) {
        encoder = new TextEncoder();
        console.warn("Windows-1252 encoding not supported, saved as UTF-8 instead.");
    }

    const encoded = encoder.encode(text);

    
    const blob = new Blob([encoded], { type: "text/plain;charset=windows-1252" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = "gcode.txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}