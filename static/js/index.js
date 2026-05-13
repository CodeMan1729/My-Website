'use strict';

// ===== Configuration =====
const IS_MOBILE = window.innerWidth < 768;
const NUM_PARTICLES = IS_MOBILE ? 50000 : 180000;
const FADE = 0.993;
// Brushstroke dimensions in normalized canvas units
const STROKE_LEN = IS_MOBILE ? 0.018 : 0.014;
const STROKE_WID = IS_MOBILE ? 0.008 : 0.0065;

// ===== Canvas & WebGL2 =====
const canvas = document.getElementById('c');
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
if (!gl) {
    document.getElementById('loading').textContent = 'WebGL2 is not supported in this browser.';
    throw new Error('No WebGL2');
}

const dpr = Math.min(window.devicePixelRatio || 1, 2);

function resize() {
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
}
resize();

// ===== Shader helpers =====
function compileShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error('Shader compile error:', gl.getShaderInfoLog(s));
        gl.deleteShader(s);
        return null;
    }
    return s;
}

function createProgram(vSrc, fSrc) {
    const p = gl.createProgram();
    gl.attachShader(p, compileShader(gl.VERTEX_SHADER, vSrc));
    gl.attachShader(p, compileShader(gl.FRAGMENT_SHADER, fSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        console.error('Program link error:', gl.getProgramInfoLog(p));
        return null;
    }
    return p;
}

// ===== Shaders =====

// -- Brushstroke particle (instanced quads) --
const strokeVS = `#version 300 es
// Per-vertex: unit quad corner
in vec2 a_corner;

// Per-instance (one per particle)
in vec2 a_center;      // particle center position (0-1 canvas UV)
in vec2 a_spawnUV;     // painting UV where particle was born (locked color)
in vec2 a_dir;         // flow direction (unit vector)
in float a_opacity;
in float a_seed;

uniform vec2 u_strokeSize;
uniform vec2 u_aspect;

out vec2 v_spawnUV;    // locked spawn color UV
out float v_opacity;
out vec2 v_localUV;
out float v_seed;

void main() {
    vec2 tang = normalize(a_dir + vec2(0.0001, 0.0));
    vec2 norm = vec2(-tang.y, tang.x);

    vec2 off = (a_corner.x - 0.5) * tang * u_strokeSize.x
             + (a_corner.y - 0.5) * norm * u_strokeSize.y;
    off.x *= u_aspect.y;

    vec2 pos = a_center + off;

    // Color comes from spawn position, NOT current position
    v_spawnUV = a_spawnUV;
    v_opacity = a_opacity;
    v_localUV = a_corner;
    v_seed = a_seed;

    vec2 clip = pos * 2.0 - 1.0;
    clip.y = -clip.y;
    gl_Position = vec4(clip, 0.0, 1.0);
}`;

const strokeFS = `#version 300 es
precision mediump float;
uniform sampler2D u_painting;
in vec2 v_spawnUV;
in float v_opacity;
in vec2 v_localUV;
in float v_seed;
out vec4 outColor;

float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
    // Color locked from spawn position — this is the key to visible flow
    vec3 c = texture(u_painting, v_spawnUV).rgb;

    // Boost brightness
    float lum = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(lum), c, 1.3);
    c = c * 1.1 + 0.06;
    c = min(c, vec3(1.0));

    // Irregular brushstroke edges using noise
    float edgeX = v_localUV.x;
    float edgeY = v_localUV.y;

    // Create ragged edges at the short ends (left/right of the stroke)
    float noiseL = hash(vec2(v_seed, edgeY * 4.0)) * 0.35;
    float noiseR = hash(vec2(v_seed + 7.0, edgeY * 4.0)) * 0.35;
    float noiseT = hash(vec2(edgeX * 6.0, v_seed + 13.0)) * 0.2;
    float noiseB = hash(vec2(edgeX * 6.0, v_seed + 23.0)) * 0.2;

    // Soft alpha mask with irregular edges
    float maskX = smoothstep(0.0 + noiseL, 0.08 + noiseL, edgeX)
                * smoothstep(0.0 + noiseR, 0.08 + noiseR, 1.0 - edgeX);
    float maskY = smoothstep(0.0 + noiseT, 0.15 + noiseT, edgeY)
                * smoothstep(0.0 + noiseB, 0.15 + noiseB, 1.0 - edgeY);

    float mask = maskX * maskY;

    // Slight texture variation across the stroke (bristle simulation)
    float bristle = 0.85 + 0.15 * hash(vec2(v_seed * 3.0, floor(edgeY * 3.0)));

    float alpha = v_opacity * mask * bristle;

    outColor = vec4(c, alpha);
}`;

// -- Fullscreen quad shaders (for FBO compositing) --
const quadVS = `#version 300 es
in vec2 a_pos;
out vec2 v_tc;
void main() {
    v_tc = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const fadeFS = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform float u_fade;
in vec2 v_tc;
out vec4 outColor;
void main() {
    outColor = texture(u_tex, v_tc) * u_fade;
}`;

const copyFS = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
in vec2 v_tc;
out vec4 outColor;
void main() {
    outColor = texture(u_tex, v_tc);
}`;

// ===== Create programs =====
const progStroke = createProgram(strokeVS, strokeFS);
const progFade   = createProgram(quadVS, fadeFS);
const progCopy   = createProgram(quadVS, copyFS);

// ===== Uniform locations =====
const loc = {
    stroke: {
        painting:   gl.getUniformLocation(progStroke, 'u_painting'),
        strokeSize: gl.getUniformLocation(progStroke, 'u_strokeSize'),
        aspect:     gl.getUniformLocation(progStroke, 'u_aspect'),
    },
    fade: {
        tex:  gl.getUniformLocation(progFade, 'u_tex'),
        fade: gl.getUniformLocation(progFade, 'u_fade'),
    },
    copy: {
        tex: gl.getUniformLocation(progCopy, 'u_tex'),
    }
};

// ===== Fullscreen quad geometry =====
const quadBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

function makeQuadVAO(program) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    const a = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return vao;
}

const vaoFadeQuad = makeQuadVAO(progFade);
const vaoCopyQuad = makeQuadVAO(progCopy);

// ===== Instanced brushstroke geometry =====
// Unit quad: 2 triangles, 6 vertices
const cornerBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    0,0, 1,0, 0,1,  // tri 1
    1,0, 1,1, 0,1   // tri 2
]), gl.STATIC_DRAW);

// Per-instance buffers
const instCenter  = new Float32Array(NUM_PARTICLES * 2);
const instSpawnUV = new Float32Array(NUM_PARTICLES * 2);  // locked painting UV from birth
const instDir     = new Float32Array(NUM_PARTICLES * 2);
const instOpacity = new Float32Array(NUM_PARTICLES);
const instSeed    = new Float32Array(NUM_PARTICLES);

const bufCenter  = gl.createBuffer();
const bufSpawnUV = gl.createBuffer();
const bufDir     = gl.createBuffer();
const bufOpacity = gl.createBuffer();
const bufSeed    = gl.createBuffer();

// Pre-fill seeds (constant per particle)
for (let i = 0; i < NUM_PARTICLES; i++) instSeed[i] = Math.random() * 100;
gl.bindBuffer(gl.ARRAY_BUFFER, bufSeed);
gl.bufferData(gl.ARRAY_BUFFER, instSeed, gl.STATIC_DRAW);

// Allocate dynamic buffers
gl.bindBuffer(gl.ARRAY_BUFFER, bufCenter);
gl.bufferData(gl.ARRAY_BUFFER, instCenter.byteLength, gl.DYNAMIC_DRAW);
gl.bindBuffer(gl.ARRAY_BUFFER, bufSpawnUV);
gl.bufferData(gl.ARRAY_BUFFER, instSpawnUV.byteLength, gl.DYNAMIC_DRAW);
gl.bindBuffer(gl.ARRAY_BUFFER, bufDir);
gl.bufferData(gl.ARRAY_BUFFER, instDir.byteLength, gl.DYNAMIC_DRAW);
gl.bindBuffer(gl.ARRAY_BUFFER, bufOpacity);
gl.bufferData(gl.ARRAY_BUFFER, instOpacity.byteLength, gl.DYNAMIC_DRAW);

// Build VAO
const vaoStrokes = gl.createVertexArray();
gl.bindVertexArray(vaoStrokes);

// Corner (per-vertex, divisor 0)
const aCorner = gl.getAttribLocation(progStroke, 'a_corner');
gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
gl.enableVertexAttribArray(aCorner);
gl.vertexAttribPointer(aCorner, 2, gl.FLOAT, false, 0, 0);

// Center (per-instance, divisor 1)
const aCenter = gl.getAttribLocation(progStroke, 'a_center');
gl.bindBuffer(gl.ARRAY_BUFFER, bufCenter);
gl.enableVertexAttribArray(aCenter);
gl.vertexAttribPointer(aCenter, 2, gl.FLOAT, false, 0, 0);
gl.vertexAttribDivisor(aCenter, 1);

// SpawnUV (per-instance, divisor 1)
const aSpawnUV = gl.getAttribLocation(progStroke, 'a_spawnUV');
gl.bindBuffer(gl.ARRAY_BUFFER, bufSpawnUV);
gl.enableVertexAttribArray(aSpawnUV);
gl.vertexAttribPointer(aSpawnUV, 2, gl.FLOAT, false, 0, 0);
gl.vertexAttribDivisor(aSpawnUV, 1);

// Dir (per-instance)
const aDir = gl.getAttribLocation(progStroke, 'a_dir');
gl.bindBuffer(gl.ARRAY_BUFFER, bufDir);
gl.enableVertexAttribArray(aDir);
gl.vertexAttribPointer(aDir, 2, gl.FLOAT, false, 0, 0);
gl.vertexAttribDivisor(aDir, 1);

// Opacity (per-instance)
const aOpacity = gl.getAttribLocation(progStroke, 'a_opacity');
gl.bindBuffer(gl.ARRAY_BUFFER, bufOpacity);
gl.enableVertexAttribArray(aOpacity);
gl.vertexAttribPointer(aOpacity, 1, gl.FLOAT, false, 0, 0);
gl.vertexAttribDivisor(aOpacity, 1);

// Seed (per-instance, static)
const aSeed = gl.getAttribLocation(progStroke, 'a_seed');
gl.bindBuffer(gl.ARRAY_BUFFER, bufSeed);
gl.enableVertexAttribArray(aSeed);
gl.vertexAttribPointer(aSeed, 1, gl.FLOAT, false, 0, 0);
gl.vertexAttribDivisor(aSeed, 1);

gl.bindVertexArray(null);

// ===== Particle CPU state =====
// Layout: [x, y, vx, vy, life, maxLife, speed, spawnUV_x, spawnUV_y] per particle
const S = 9;
const state = new Float32Array(NUM_PARTICLES * S);

function spawnParticle(i) {
    const b = i * S;
    const px = Math.random();
    const py = Math.random();
    state[b    ] = px;
    state[b + 1] = py;
    const angle  = Math.random() * Math.PI * 2;
    const spd    = 0.00012 + Math.random() * 0.00022;
    state[b + 2] = Math.cos(angle) * spd;
    state[b + 3] = Math.sin(angle) * spd;
    const life   = 150 + Math.random() * 350;
    state[b + 4] = life;
    state[b + 5] = life;
    state[b + 6] = spd;
    // Lock painting UV at spawn time using cover transform
    state[b + 7] = px * cover[0] + cover[2];  // spawnUV_x
    state[b + 8] = py * cover[1] + cover[3];  // spawnUV_y
}

// Particles will be spawned in boot sequence after cover is computed

// ===== FBO ping-pong =====
let fboW = 0, fboH = 0;
const fbos = [null, null];
const fboTex = [null, null];

function makeFBO(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex };
}

function rebuildFBOs() {
    fboW = canvas.width;
    fboH = canvas.height;
    for (let i = 0; i < 2; i++) {
        if (fbos[i]) gl.deleteFramebuffer(fbos[i]);
        if (fboTex[i]) gl.deleteTexture(fboTex[i]);
        const r = makeFBO(fboW, fboH);
        fbos[i] = r.fbo;
        fboTex[i] = r.tex;
        // Clear to black
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbos[i]);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

// ===== Cover transform (maps canvas UV → painting UV) =====
const cover = new Float32Array([1, 1, 0, 0]);
let imgW = 0, imgH = 0;

function computeCover() {
    if (!imgW) return;
    const ca = canvas.width / canvas.height;
    const ia = imgW / imgH;
    if (ca > ia) {
        const s = ia / ca;
        cover[0] = 1; cover[1] = s; cover[2] = 0; cover[3] = (1 - s) * 0.5;
    } else {
        const s = ca / ia;
        cover[0] = s; cover[1] = 1; cover[2] = (1 - s) * 0.5; cover[3] = 0;
    }
}

// ===== Load painting texture =====
let paintingTex = null;

function loadPainting() {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            try {
                imgW = img.width;
                imgH = img.height;
                paintingTex = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, paintingTex);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                computeCover();
                resolve(img);
            } catch (e) {
                reject(new Error('Texture upload failed: ' + e.message));
            }
        };
        img.onerror = () => reject(new Error('Failed to load painting image.'));
        // No timeout — let the browser download at whatever speed the server allows
        img.src = './static/img/starry-night.jpg';
    });
}

// ===== Flow field (Sobel-derived from source image) =====
const FLOW_RES = 200; // grid cells along the long axis
let flowW = 0, flowH = 0;
let flowField = null; // Float32Array, 2 floats per cell (cos, sin)

function buildFlowField(img) {
    // Draw image to offscreen canvas at reduced resolution
    const aspect = img.width / img.height;
    let gw, gh;
    if (aspect >= 1) { gw = FLOW_RES; gh = Math.round(FLOW_RES / aspect); }
    else             { gh = FLOW_RES; gw = Math.round(FLOW_RES * aspect); }

    const oc = document.createElement('canvas');
    oc.width = gw; oc.height = gh;
    const ctx = oc.getContext('2d');
    ctx.drawImage(img, 0, 0, gw, gh);
    const data = ctx.getImageData(0, 0, gw, gh).data;

    // Convert to grayscale float array
    const gray = new Float32Array(gw * gh);
    for (let i = 0; i < gw * gh; i++) {
        const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
        gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    }

    // Sobel filter: compute gradient direction at each pixel
    flowW = gw; flowH = gh;
    flowField = new Float32Array(gw * gh * 2);

    for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
            // Clamp neighbors
            const xm = Math.max(0, x - 1), xp = Math.min(gw - 1, x + 1);
            const ym = Math.max(0, y - 1), yp = Math.min(gh - 1, y + 1);

            // Sobel kernels
            const gx =
                -gray[ym * gw + xm] + gray[ym * gw + xp]
                -2 * gray[y * gw + xm] + 2 * gray[y * gw + xp]
                -gray[yp * gw + xm] + gray[yp * gw + xp];

            const gy =
                -gray[ym * gw + xm] - 2 * gray[ym * gw + x] - gray[ym * gw + xp]
                +gray[yp * gw + xm] + 2 * gray[yp * gw + x] + gray[yp * gw + xp];

            // Gradient angle, rotated 90° for flow along brushstrokes
            let angle = Math.atan2(gy, gx) + Math.PI * 0.5;

            const idx = (y * gw + x) * 2;
            flowField[idx]     = Math.cos(angle);
            flowField[idx + 1] = Math.sin(angle);
        }
    }

    // Enhance with explicit swirl attractors at major vortex positions
    // Coordinates in normalized [0,1] space based on the painting composition
    const swirls = [
        // Sky swirls (the 11 major ones)
        { x: 0.28, y: 0.32, r: 0.10, str: 1.8 },   // large left swirl
        { x: 0.38, y: 0.25, r: 0.08, str: 1.5 },   // upper center-left
        { x: 0.50, y: 0.30, r: 0.09, str: 1.6 },   // center
        { x: 0.60, y: 0.22, r: 0.07, str: 1.4 },   // upper center-right
        { x: 0.70, y: 0.28, r: 0.08, str: 1.5 },   // right swirl
        { x: 0.20, y: 0.18, r: 0.06, str: 1.2 },   // far upper-left
        { x: 0.45, y: 0.15, r: 0.07, str: 1.3 },   // upper sky
        { x: 0.55, y: 0.38, r: 0.06, str: 1.1 },   // lower sky center
        { x: 0.35, y: 0.42, r: 0.05, str: 1.0 },   // sky-hill boundary
        { x: 0.75, y: 0.18, r: 0.06, str: 1.2 },   // near moon
        { x: 0.15, y: 0.35, r: 0.05, str: 1.0 },   // left edge sky
    ];

    for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
            const nx = x / gw; // normalized x
            const ny = y / gh; // normalized y
            const idx = (y * gw + x) * 2;

            let swirlCos = 0, swirlSin = 0;

            for (const sw of swirls) {
                const dx = nx - sw.x;
                const dy = ny - sw.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < sw.r * 2.5) {
                    // Rotational force (tangent to the circle)
                    const falloff = Math.exp(-(dist * dist) / (2 * sw.r * sw.r));
                    const tang_x = -dy;
                    const tang_y = dx;
                    const len = Math.sqrt(tang_x * tang_x + tang_y * tang_y) || 1;
                    swirlCos += (tang_x / len) * falloff * sw.str;
                    swirlSin += (tang_y / len) * falloff * sw.str;
                }
            }

            // Blend: base Sobel + swirl influence
            const bx = flowField[idx];
            const by = flowField[idx + 1];
            const mx = bx + swirlCos;
            const my = by + swirlSin;
            const len = Math.sqrt(mx * mx + my * my) || 1;
            flowField[idx]     = mx / len;
            flowField[idx + 1] = my / len;
        }
    }

    // ===== Region-specific flow directions =====

    for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
            const nx = x / gw;  // 0-1
            const ny = y / gh;  // 0-1
            const idx = (y * gw + x) * 2;

            // --- Cypress tree region (the dark trunk, narrower bounds) ---
            // Only the actual trunk: x 5-15%, y 20-95%, narrower at top
            const trunkWidth = 0.05 + (ny - 0.20) * 0.08; // widens toward bottom
            const trunkCenter = 0.12;
            const inCypress = ny > 0.20 && nx > (trunkCenter - trunkWidth * 0.5)
                           && nx < (trunkCenter + trunkWidth * 0.5) && nx > 0.05;
            if (inCypress) {
                const distFromCenter = Math.abs(nx - trunkCenter) / (trunkWidth * 0.5);
                const blend = 1.0 - distFromCenter * 0.5; // strong at center, softer at edges
                const bx = flowField[idx];
                const by = flowField[idx + 1];
                // Upward = (0, -1) in normalized coords
                const mx = bx * (1 - blend) + 0.0 * blend;
                const my = by * (1 - blend) + (-1.0) * blend;
                const len = Math.sqrt(mx * mx + my * my) || 1;
                flowField[idx]     = mx / len;
                flowField[idx + 1] = my / len;
                continue;
            }

            // --- Village region (buildings cluster, bottom center-right) ---
            // Approximate: y > 78%, x between 35% and 80%
            const inVillage = ny > 0.78 && nx > 0.35 && nx < 0.80;
            if (inVillage) {
                // Nearly static — very slow, near-zero flow
                flowField[idx]     = 0.0;
                flowField[idx + 1] = 0.0;
                continue;
            }

            // --- Hills/mountains (below sky, not village, not cypress) ---
            if (ny > 0.58) {
                const t = (ny - 0.58) / 0.42; // 0→1 from sky boundary to bottom
                const hillBlend = Math.min(1.0, t * 1.8); // ramp up faster
                const bx = flowField[idx];
                const by = flowField[idx + 1];
                // Diagonal downward-LEFT flow for hills
                const hx = -0.6;  // leftward
                const hy = 0.5;   // downward
                const mx = bx * (1 - hillBlend) + hx * hillBlend;
                const my = by * (1 - hillBlend) + hy * hillBlend;
                const len = Math.sqrt(mx * mx + my * my) || 1;
                flowField[idx]     = mx / len;
                flowField[idx + 1] = my / len;
            }
            // Sky area: keep Sobel + swirl as-is
        }
    }
}

// Sample flow field at normalized (0-1) position
function sampleFlow(nx, ny) {
    const gx = nx * (flowW - 1);
    const gy = ny * (flowH - 1);
    const ix = Math.min(Math.floor(gx), flowW - 2);
    const iy = Math.min(Math.floor(gy), flowH - 2);
    const fx = gx - ix;
    const fy = gy - iy;

    // Bilinear interpolation
    const i00 = (iy * flowW + ix) * 2;
    const i10 = i00 + 2;
    const i01 = ((iy + 1) * flowW + ix) * 2;
    const i11 = i01 + 2;

    const cx = (1-fx)*(1-fy)*flowField[i00]   + fx*(1-fy)*flowField[i10]
             + (1-fx)*fy*flowField[i01]        + fx*fy*flowField[i11];
    const cy = (1-fx)*(1-fy)*flowField[i00+1] + fx*(1-fy)*flowField[i10+1]
             + (1-fx)*fy*flowField[i01+1]      + fx*fy*flowField[i11+1];
    return [cx, cy];
}

// ===== Click/Touch disturbance =====
const MAX_DISTURB = 10;  // support up to 10 simultaneous touch points
const disturbs = [];     // { x, y, strength, life }

function addDisturbance(canvasX, canvasY) {
    // Convert screen coords to 0-1 normalized
    const nx = canvasX / window.innerWidth;
    const ny = canvasY / window.innerHeight;
    disturbs.push({ x: nx, y: ny, strength: 1.0, life: 90 });
    if (disturbs.length > MAX_DISTURB) disturbs.shift();

    // Visual flash feedback
    const flash = document.createElement('div');
    flash.className = 'click-flash';
    flash.style.left = canvasX + 'px';
    flash.style.top = canvasY + 'px';
    document.body.appendChild(flash);
    flash.addEventListener('animationend', () => flash.remove());
}

// Mouse
canvas.addEventListener('click', (e) => {
    addDisturbance(e.clientX, e.clientY);
});

// Touch (multi-touch support)
canvas.addEventListener('touchstart', (e) => {
    for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        addDisturbance(t.clientX, t.clientY);
    }
}, { passive: true });

// ===== Resize =====
window.addEventListener('resize', () => {
    resize();
    rebuildFBOs();
    computeCover();
});

// ===== Update =====
const FLOW_LERP = 0.05;

function updateParticles() {
    if (!flowField) return;

    for (let i = 0; i < NUM_PARTICLES; i++) {
        const b = i * S;
        let x    = state[b];
        let y    = state[b + 1];
        let vx   = state[b + 2];
        let vy   = state[b + 3];
        let life = state[b + 4];
        const spd = state[b + 6];

        // Sample flow field direction
        const nx = Math.max(0, Math.min(1, x));
        const ny = Math.max(0, Math.min(1, y));
        const [fx, fy] = sampleFlow(nx, ny);

        vx += (fx * spd - vx) * FLOW_LERP;
        vy += (fy * spd - vy) * FLOW_LERP;

        // Apply click/touch disturbance forces
        for (let d = 0; d < disturbs.length; d++) {
            const dist = disturbs[d];
            const ddx = x - dist.x;
            const ddy = y - dist.y;
            const r = Math.sqrt(ddx * ddx + ddy * ddy);
            const radius = 0.08;  // disturbance radius in normalized coords
            if (r < radius && r > 0.001) {
                // Radial push: stronger near center, decays with distance
                const force = dist.strength * (1.0 - r / radius) * 0.004;
                vx += (ddx / r) * force;
                vy += (ddy / r) * force;
            }
        }

        vx += (Math.random() - 0.5) * 0.000012;
        vy += (Math.random() - 0.5) * 0.000012;

        x += vx;
        y += vy;
        life--;

        if (life <= 0 || x < -0.02 || x > 1.02 || y < -0.02 || y > 1.02) {
            spawnParticle(i);
        } else {
            state[b]     = x;
            state[b + 1] = y;
            state[b + 2] = vx;
            state[b + 3] = vy;
            state[b + 4] = life;
        }

        // Write instance data
        instCenter[i * 2]     = state[b];
        instCenter[i * 2 + 1] = state[b + 1];

        // Spawn UV (locked at birth)
        instSpawnUV[i * 2]     = state[b + 7];
        instSpawnUV[i * 2 + 1] = state[b + 8];

        // Direction for quad orientation
        const dvx = state[b + 2], dvy = state[b + 3];
        const dlen = Math.sqrt(dvx * dvx + dvy * dvy) || 1;
        instDir[i * 2]     = dvx / dlen;
        instDir[i * 2 + 1] = dvy / dlen;

        // Opacity: fade in, sustain, fade out
        const ratio = state[b + 4] / state[b + 5];
        const fadeIn = Math.min(1.0, (state[b + 5] - state[b + 4]) / 25);
        instOpacity[i] = fadeIn * ratio * 0.92;
    }

    // Decay and remove expired disturbances
    for (let d = disturbs.length - 1; d >= 0; d--) {
        disturbs[d].strength *= 0.94;  // exponential decay
        disturbs[d].life--;
        if (disturbs[d].life <= 0 || disturbs[d].strength < 0.01) {
            disturbs.splice(d, 1);
        }
    }
}

// ===== Render =====
let ping = 0;

function render() {
    updateParticles();

    // Upload instance data
    gl.bindBuffer(gl.ARRAY_BUFFER, bufCenter);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, instCenter);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufSpawnUV);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, instSpawnUV);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufDir);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, instDir);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufOpacity);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, instOpacity);

    const read  = ping;
    const write = 1 - ping;

    // --- Step 1: Fade previous frame into write FBO ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbos[write]);
    gl.viewport(0, 0, fboW, fboH);

    gl.useProgram(progFade);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fboTex[read]);
    gl.uniform1i(loc.fade.tex, 0);
    gl.uniform1f(loc.fade.fade, FADE);
    gl.bindVertexArray(vaoFadeQuad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // --- Step 2: Draw brushstroke quads (instanced) ---
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(progStroke);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, paintingTex);
    gl.uniform1i(loc.stroke.painting, 0);
    gl.uniform2f(loc.stroke.strokeSize, STROKE_LEN, STROKE_WID);
    const asp = canvas.width / canvas.height;
    gl.uniform2f(loc.stroke.aspect, 1.0, 1.0 / asp);

    gl.bindVertexArray(vaoStrokes);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, NUM_PARTICLES);

    gl.disable(gl.BLEND);

    // --- Step 3: Copy write FBO to screen ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);

    gl.useProgram(progCopy);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fboTex[write]);
    gl.uniform1i(loc.copy.tex, 0);
    gl.bindVertexArray(vaoCopyQuad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    ping = write;
    requestAnimationFrame(render);
}

// ===== Background Music =====
const bgMusic = document.getElementById('bgMusic');
const musicBtn = document.getElementById('musicBtn');
const TARGET_VOLUME = 0.45;
const FADE_STEP = 0.005;
let musicStarted = false;
let musicReady = false;
let musicLoading = false;

// Preload full audio into memory as blob URL — prevents streaming stutter
function preloadMusic() {
    if (musicReady || musicLoading) return Promise.resolve();
    musicLoading = true;
    return fetch('./my-theme.mp3', { cache: 'no-cache' })
        .then(r => {
            if (!r.ok) throw new Error(r.status);
            return r.blob();
        })
        .then(blob => {
            if (blob.size < 1000) { musicLoading = false; return; }
            bgMusic.src = URL.createObjectURL(blob);
            musicReady = true;
        })
        .catch(() => {
            // Fallback: let <audio> handle it natively
            bgMusic.src = './my-theme.mp3';
            musicReady = true;
            musicLoading = false;
        });
}

// Start preloading after page becomes interactive (not blocking first paint)
if ('requestIdleCallback' in window) {
    requestIdleCallback(() => preloadMusic());
} else {
    setTimeout(() => preloadMusic(), 3000);
}

function fadeInMusic() {
    const doPlay = () => {
        bgMusic.volume = 0;
        bgMusic.play().then(() => {
            musicStarted = true;
            musicBtn.classList.remove('muted');
            const fadeTimer = setInterval(() => {
                if (bgMusic.volume < TARGET_VOLUME - FADE_STEP) {
                    bgMusic.volume = Math.min(bgMusic.volume + FADE_STEP, TARGET_VOLUME);
                } else {
                    bgMusic.volume = TARGET_VOLUME;
                    clearInterval(fadeTimer);
                }
            }, 30);
        }).catch(() => {});
    };
    if (musicReady) { doPlay(); }
    else { preloadMusic().then(doPlay); }
}

// Try autoplay on first user interaction (browsers require gesture)
function tryStartMusic() {
    if (!musicStarted) {
        fadeInMusic();
        document.removeEventListener('click', tryStartMusic);
        document.removeEventListener('touchstart', tryStartMusic);
    }
}
document.addEventListener('click', tryStartMusic);
document.addEventListener('touchstart', tryStartMusic, { passive: true });

// Toggle button
musicBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!musicStarted) {
        fadeInMusic();
        document.removeEventListener('click', tryStartMusic);
        document.removeEventListener('touchstart', tryStartMusic);
        return;
    }
    if (bgMusic.paused) {
        bgMusic.play();
        musicBtn.classList.remove('muted');
    } else {
        bgMusic.pause();
        musicBtn.classList.add('muted');
    }
});

// ===== Boot =====
loadPainting().then((img) => {
    buildFlowField(img);
    rebuildFBOs();
    // Re-spawn all particles now that cover transform is computed
    for (let i = 0; i < NUM_PARTICLES; i++) spawnParticle(i);
    // Hide loading screen
    const el = document.getElementById('loading');
    el.classList.add('hidden');
    setTimeout(() => el.remove(), 1500);
    // Start
    requestAnimationFrame(render);
}).catch(err => {
    document.getElementById('loading').textContent = 'Error: ' + err.message;
});