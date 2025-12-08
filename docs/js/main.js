// main.js — updated: internal units = millimeters (Option A)
// Adds correct unit conversion for feedrates & coordinates, plus accurate arc-length timing.

// --- State ---
let machinePos = { x:0, y:0, z:0 };
let path = [];
let movesLog = []; // move entries: {type, distance_mm, time_sec, feed_mm_per_min}

const AXES = ['x','y','z'];

// Modal state
let modal = {
    absolute: true,          // G90 default
    unitsFactor: 1.0,        // mm per unit; G21 -> 1.0, G20 -> 25.4
    plane: 'XY',             // G17
    // feed (mm/min) is modal.currentFeed_mm_per_min
    currentFeed_mm_per_min: 1000, // default global feed (Option B from earlier)
    // rapid feed stored as "inches per minute" source and converted to mm/min on unit changes
    rapidFeed_in_in_per_min: 24.0,   // user-specified rapid in in/min
    rapidFeed_mm_per_min: 24.0 * 25.4 // computed from rapidFeed_in_in_per_min * unitsFactor
};

// --- Utilities ---
function cloneObject(o){ return Object.assign({}, o); }
function parseTokensFromLine(line) {
    // returns array of tokens like {letter:'G', value:'1'}.
    const matches = line.match(/[A-Z][+-]?[0-9]*\.?[0-9]*/ig) || [];
    return matches.map(t => ({ letter: t[0].toUpperCase(), value: t.slice(1) }));
}
function formatTimeSeconds(sec) {
    if (!isFinite(sec) || sec <= 0) return '0s';
    const hours = Math.floor(sec / 3600);
    sec -= hours*3600;
    const mins = Math.floor(sec / 60);
    const secs = Math.floor(sec % 60);
    let out = '';
    if (hours) out += hours + 'h ';
    if (mins || hours) out += mins + 'm ';
    out += secs + 's';
    return out;
}

// normalize angle to (-PI, PI]
function normalizeAngle(a) {
    while (a <= -Math.PI) a += 2*Math.PI;
    while (a > Math.PI) a -= 2*Math.PI;
    return a;
}

// --- Recording linear moves ---
function recordLinearMove(targetPos, feed_mm_per_min, motionType) {
    // compute delta and distance
    const sx = machinePos.x || 0, sy = machinePos.y || 0, sz = machinePos.z || 0;
    const ex = (targetPos.x != null) ? targetPos.x : sx;
    const ey = (targetPos.y != null) ? targetPos.y : sy;
    const ez = (targetPos.z != null) ? targetPos.z : sz;
    const dx = ex - sx, dy = ey - sy, dz = ez - sz;
    const distance = Math.hypot(dx, dy, dz);

    let timeSec = 0;
    if (feed_mm_per_min > 0) {
        timeSec = (distance / feed_mm_per_min) * 60.0;
    } else {
        console.warn("Zero or missing feedrate — time counted as 0 for this move.");
    }

    machinePos = { x: ex, y: ey, z: ez };
    path.push(cloneObject(machinePos));
    movesLog.push({ type: motionType, distance_mm: distance, time_sec: timeSec, feed_mm_per_min: feed_mm_per_min });

    return { distance, timeSec };
}

// --- Arc handling: compute exact arc length for timing, but still interpolate for visuals ---
function interpolateArcXYPoints(start, end, center, cw) {
    const sx = start.x, sy = start.y;
    const ex = end.x, ey = end.y;
    const cx = center.x, cy = center.y;

    const startAng = Math.atan2(sy - cy, sx - cx);
    let endAng = Math.atan2(ey - cy, ex - cx);

    let delta = endAng - startAng;
    if (cw) {
        if (delta >= 0) delta -= 2*Math.PI;
    } else {
        if (delta <= 0) delta += 2*Math.PI;
    }

    const radius = Math.hypot(sx - cx, sy - cy);
    const absDelta = Math.abs(delta);

    // choose segments for smooth display; time computation uses exact radius*absDelta
    const segments = Math.max(6, Math.ceil((absDelta * 180/Math.PI) / 10)); // ~10° per segment
    const points = [];
    for (let i = 1; i <= segments; i++) {
        const t = i / segments;
        const ang = startAng + t * delta;
        const x = cx + radius * Math.cos(ang);
        const y = cy + radius * Math.sin(ang);
        points.push({ x, y, z: start.z });
    }
    return { points, radius, absDelta };
}

function handleArc(gCode, params) {
    // gCode: 2 or 3; params: numeric object with raw values (units not yet converted)
    const cw = (gCode === 2);
    // convert numeric params to mm using modal.unitsFactor (unitsFactor should be correct at time of parsing)
    const conv = {};
    for (const k in params) {
        if (Object.prototype.hasOwnProperty.call(params, k)) conv[k] = params[k] * modal.unitsFactor;
    }

    const start = { x: machinePos.x, y: machinePos.y, z: machinePos.z };

    // compute target
    const target = { x: start.x, y: start.y, z: start.z };
    ['X','Y','Z'].forEach(axis => {
        if (axis in conv) {
            const val = conv[axis];
            if (modal.absolute) target[axis.toLowerCase()] = val;
            else target[axis.toLowerCase()] = start[axis.toLowerCase()] + val;
        }
    });

    // find center
    let center = null;
    if ('I' in conv || 'J' in conv) {
        const i = conv['I'] || 0;
        const j = conv['J'] || 0;
        center = { x: start.x + i, y: start.y + j };
    } else if ('R' in conv) {
        const R = conv['R'];
        const sx = start.x, sy = start.y;
        const ex = target.x, ey = target.y;
        const dx = ex - sx, dy = ey - sy;
        const d = Math.hypot(dx, dy);
        if (d === 0) {
            console.warn("Arc with identical start & end in R mode — ignored.");
            return { distance:0, timeSec:0 };
        }
        // midpoint and perpendicular direction
        const mx = (sx + ex)/2, my = (sy + ey)/2;
        const h2 = Math.max(0, R*R - (d/2)*(d/2));
        const h = Math.sqrt(h2);
        const ux = -dy / d, uy = dx / d;
        const c1 = { x: mx + ux*h, y: my + uy*h };
        const c2 = { x: mx - ux*h, y: my - uy*h };

        // pick proper center based on cw/ccw by computing delta sign
        const ang1s = Math.atan2(sy - c1.y, sx - c1.x);
        const ang1e = Math.atan2(ey - c1.y, ex - c1.x);
        let delta1 = normalizeAngle(ang1e - ang1s);

        if (cw) center = (delta1 < 0) ? c1 : c2;
        else center = (delta1 > 0) ? c1 : c2;
    } else {
        console.warn("Arc missing I/J or R — ignored.");
        return { distance:0, timeSec:0 };
    }

    // For timing use exact arc length = radius * sweep_angle
    const interp = interpolateArcXYPoints(start, target, center, cw);
    const radius = interp.radius;
    const sweep = interp.absDelta; // radians
    const distance = radius * sweep;

    // push interpolated points for visualization
    interp.points.forEach(p => path.push({ x: p.x, y: p.y, z: p.z }));
    // ensure exact terminal point
    const last = interp.points.length ? interp.points[interp.points.length - 1] : { x:start.x, y:start.y, z:start.z };
    const finalDx = target.x - last.x, finalDy = target.y - last.y, finalDz = (target.z || start.z) - (last.z || start.z);
    const finalSeg = Math.hypot(finalDx, finalDy, finalDz);
    if (finalSeg > 1e-9) {
        path.push({ x: target.x, y: target.y, z: target.z });
    }

    // compute time using modal feed
    const feed = modal.currentFeed_mm_per_min > 0 ? modal.currentFeed_mm_per_min : 0;
    const timeSec = feed > 0 ? (distance / feed) * 60.0 : 0.0;

    // update machinePos
    machinePos = { x: target.x, y: target.y, z: target.z };

    movesLog.push({ type: (gCode===2)?'G2':'G3', distance_mm: distance, time_sec: timeSec, feed_mm_per_min: feed });

    return { distance, timeSec };
}

// --- Evaluate G-code ---
function evaluateCode() {
    // reset
    path = [];
    movesLog = [];
    machinePos = { x:0, y:0, z:0 };
    path.push(cloneObject(machinePos));

    // restore defaults per evaluation (optional: remove reset if you want modal persistent)
    modal.absolute = true;
    modal.unitsFactor = 1.0;
    modal.plane = 'XY';
    modal.currentFeed_mm_per_min = 1000;
    // rapidFeed_in_in_per_min remains user-specified (24 in/min), recompute mm/min
    modal.rapidFeed_mm_per_min = modal.rapidFeed_in_in_per_min * modal.unitsFactor;

    const text = (document.getElementById('codebox')||{value:''}).value;
    const lines = text.split(/\r?\n/);
    lines.forEach(rawLine => {
        let line = rawLine.replace(/[\t ]+/g,'').toUpperCase();
        line = line.replace(/^N[0-9]+/,'');
        // strip parentheses comments and after semicolon
        line = line.replace(/\(.*?\)/g,'');
        const sc = line.indexOf(';');
        if (sc >= 0) line = line.slice(0, sc);
        if (!line.trim()) return;

        // tokenize
        const tokens = parseTokensFromLine(line);

        // We'll scan left-to-right and update modal as we encounter modal tokens
        let motionG = null; // found motion code (0/1/2/3)
        const params = {};  // X,Y,Z,I,J,K,R,F (numeric raw values)
        for (let tk of tokens) {
            const L = tk.letter;
            const V = tk.value;
            if (L === 'G') {
                const gnum = Math.floor(parseFloat(V));
                if (gnum === 20) {
                    modal.unitsFactor = 25.4;
                    // recompute mm rapid feed from stored inch value:
                    modal.rapidFeed_mm_per_min = modal.rapidFeed_in_in_per_min * modal.unitsFactor;
                } else if (gnum === 21) {
                    modal.unitsFactor = 1.0;
                    modal.rapidFeed_mm_per_min = modal.rapidFeed_in_in_per_min * modal.unitsFactor;
                } else if (gnum === 90) {
                    modal.absolute = true;
                } else if (gnum === 91) {
                    modal.absolute = false;
                } else if (gnum === 17) {
                    modal.plane = 'XY';
                } else if (gnum === 18) {
                    modal.plane = 'XZ';
                } else if (gnum === 19) {
                    modal.plane = 'YZ';
                } else if ([0,1,2,3].includes(gnum)) {
                    motionG = gnum;
                } else {
                    // ignore other G-codes for now
                }
            } else if (['X','Y','Z','I','J','K','R','F'].includes(L)) {
                if (V !== '') {
                    const num = parseFloat(V);
                    params[L] = num;
                    if (L === 'F') {
                        // convert F value to mm/min using current unitsFactor (unitsFactor may have been updated earlier in same line)
                        modal.currentFeed_mm_per_min = num * modal.unitsFactor;
                    }
                }
            } else {
                // ignore M and others
            }
        }

        // If motion present handle it
        if (motionG !== null) {
            if (motionG === 0) {
                // rapid linear
                const target = { x: machinePos.x, y: machinePos.y, z: machinePos.z };
                ['X','Y','Z'].forEach(axis => {
                    if (axis in params) {
                        const valMM = params[axis] * modal.unitsFactor;
                        if (modal.absolute) target[axis.toLowerCase()] = valMM;
                        else target[axis.toLowerCase()] = machinePos[axis.toLowerCase()] + valMM;
                    }
                });
                recordLinearMove(target, modal.rapidFeed_mm_per_min, 'G0');
            } else if (motionG === 1) {
                // linear feed
                const target = { x: machinePos.x, y: machinePos.y, z: machinePos.z };
                ['X','Y','Z'].forEach(axis => {
                    if (axis in params) {
                        const valMM = params[axis] * modal.unitsFactor;
                        if (modal.absolute) target[axis.toLowerCase()] = valMM;
                        else target[axis.toLowerCase()] = machinePos[axis.toLowerCase()] + valMM;
                    }
                });
                recordLinearMove(target, modal.currentFeed_mm_per_min, 'G1');
            } else if (motionG === 2 || motionG === 3) {
                // arc: pass raw params (they will be converted inside)
                handleArc(motionG, params);
            }
        } else {
            // no explicit G-motion: treat X/Y/Z as implicit G1
            if (['X','Y','Z'].some(k => k in params)) {
                const target = { x: machinePos.x, y: machinePos.y, z: machinePos.z };
                ['X','Y','Z'].forEach(axis => {
                    if (axis in params) {
                        const valMM = params[axis] * modal.unitsFactor;
                        if (modal.absolute) target[axis.toLowerCase()] = valMM;
                        else target[axis.toLowerCase()] = machinePos[axis.toLowerCase()] + valMM;
                    }
                });
                recordLinearMove(target, modal.currentFeed_mm_per_min, 'G1');
            }
        }
    });

    drawToolpath();
    updateStatsUI();
}

// --- Stats UI ---
function ensureStatsPanel() {
    let stats = document.getElementById('stats');
    if (!stats) {
        stats = document.createElement('div');
        stats.id = 'stats';
        stats.style.position = 'absolute';
        stats.style.right = '8px';
        stats.style.top = '8px';
        stats.style.background = 'rgba(0,0,0,0.6)';
        stats.style.color = 'white';
        stats.style.padding = '8px';
        stats.style.fontFamily = 'monospace';
        stats.style.fontSize = '12px';
        stats.style.borderRadius = '6px';
        stats.style.zIndex = '1000';
        const containerParent = document.getElementById('viewer').parentElement || document.body;
        containerParent.appendChild(stats);
    }
    return stats;
}

function updateStatsUI() {
    const stats = ensureStatsPanel();
    const totalDistance = movesLog.reduce((s,m) => s + (m.distance_mm||0),0);
    const totalTimeSec = movesLog.reduce((s,m) => s + (m.time_sec||0),0);

    let html = `<div><strong>Toolpath stats</strong></div>`;
    html += `<div>Total moves: ${movesLog.length}</div>`;
    html += `<div>Total distance: ${totalDistance.toFixed(3)} mm</div>`;
    html += `<div>Total time: ${formatTimeSeconds(totalTimeSec)} (${Math.round(totalTimeSec)} s)</div>`;
    html += `<div>Modal feed (F): ${modal.currentFeed_mm_per_min.toFixed(3)} mm/min</div>`;
    html += `<div>Rapid (G0): ${modal.rapidFeed_mm_per_min.toFixed(3)} mm/min</div>`;
    html += `<hr style="border:0;border-top:1px solid rgba(255,255,255,0.1);margin:6px 0;">`;

    const last = movesLog.slice(-8).reverse();
    if (last.length) {
        html += `<div style="max-height:160px;overflow:auto">`;
        html += `<div style="opacity:0.9">Recent moves (type | dist mm | time):</div>`;
        last.forEach(m => {
            html += `<div>${m.type} | ${m.distance_mm.toFixed(3)} mm | ${formatTimeSeconds(m.time_sec)}</div>`;
        });
        html += `</div>`;
    }
    stats.innerHTML = html;
}

// --- Three.js viewer (kept similar to your previous setup) ---
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

function drawToolpath(){
    if(toolpathObject) scene.remove(toolpathObject);

    const geom = new THREE.BufferGeometry();
    const verts = [];
    path.forEach(p => verts.push(p.x,p.y,p.z));
    geom.setAttribute('position', new THREE.Float32BufferAttribute(verts,3));

    toolpathObject = new THREE.Line(geom, new THREE.LineBasicMaterial({color:0xffffff}));
    scene.add(toolpathObject);

    const box = new THREE.Box3().setFromObject(toolpathObject);
    cameraTarget.copy(box.getCenter(new THREE.Vector3()));
    const size = box.getSize(new THREE.Vector3());
    cameraRadius = Math.max(size.x,size.y,size.z) * 3 || 100;
    cameraHeight = cameraRadius / 2;

    updateCameraPosition();
}

// Camera controls
const keys = { w:false,a:false,s:false,d:false };
document.addEventListener('keydown', e => { if(keys.hasOwnProperty(e.key)) keys[e.key]=true; });
document.addEventListener('keyup',   e => { if(keys.hasOwnProperty(e.key)) keys[e.key]=false; });

function updateCameraPosition() {
    const x = cameraTarget.x + cameraRadius * Math.cos(vAngle) * Math.cos(cameraAngle);
    const y = cameraTarget.y + cameraRadius * Math.sin(vAngle);
    const z = cameraTarget.z + cameraRadius * Math.cos(vAngle) * Math.sin(cameraAngle);
    camera.position.set(x,y,z);
    camera.up.set(Math.cos(vAngle) < 0 ? 0 : 0, Math.cos(vAngle) < 0 ? -1 : 1, 0); // keep up roughly correct
    camera.lookAt(cameraTarget);
}

function handleCameraControls(){
    const speed = 0.02;
    if (keys.a) cameraAngle -= speed;
    if (keys.d) cameraAngle += speed;
    if (keys.w) vAngle += speed;
    if (keys.s) vAngle -= speed;
    updateCameraPosition();
}

function resizeRenderer(){
    const width = container.clientWidth, height = container.clientHeight;
    renderer.setSize(width,height);
    camera.aspect = width/height;
    camera.updateProjectionMatrix();
}
resizeRenderer();
window.addEventListener('resize', resizeRenderer);

function animate(){
    requestAnimationFrame(animate);
    handleCameraControls();
    renderer.render(scene, camera);
}

// wire up codebox
document.getElementById('codebox').addEventListener('input', evaluateCode);

// init
evaluateCode();
animate();

// Export helper (unchanged)
function saveCodeAsTxt(){
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
    const a = document.createElement('a');
    a.href = url;
    a.download = 'gcode.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

