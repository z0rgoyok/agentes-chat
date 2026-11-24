import {
  ACCESSORY_PALETTE,
  ACCESSORY_REACH,
  type AgentColorName,
  bodyTones,
  drawAccessory,
  drawAgent,
  EYE_COLOR,
  type EyeStyle,
  mixHex,
  rgbOf,
} from "@agenteschat/ui/agent/engine";

/*
 * An agent in cubes, the Code home's one 3D piece (ADR 0215). The agents' engine draws the avatar (body, eyes and
 * accessory on its 16×16 grid) and each pixel of that drawing becomes a cube: no shape of its own, so it is always the
 * agent people see everywhere else. Each face takes one of the agent's own tones through the 4×4 Bayer dither the sky
 * and the avatars use, laid on the cubes (it turns with them and never swims). The light comes from the top left.
 * Plain WebGL: one small figure doesn't justify a 3D library in the bundle.
 */

/** The avatar's grid, its accessories' too. */
const N = 16;
/** Canvas pixels per cell while sampling the drawing (odd: a cell's middle is a pixel's middle). */
const P = 9;
/** The body's depth, in cells. */
const DEPTH = 4;
/** How far the eyes stand out of the face, in cells. */
const EYE_OUT = 0.35;
/** Tones per ramp, deep to light. */
const RAMP = 10;
/** A face's tone against its front's: the top catches the light, the right side and the underside fall away. */
const FACE = { top: 2.4, left: -0.8, right: -2.6, bottom: -3.2 };
/**
 * How it builds itself when the home opens: each cube drops into its place from this many cells over it, row after row
 * from its foot up (a little earlier or later by column, so the rows never land as one), over `BUILD_SPREAD` seconds,
 * each fall taking `BUILD_FALL`; it settles a hair past its place and back.
 */
const BUILD_DROP = 7;
const BUILD_SPREAD = 0.5;
const BUILD_FALL = 0.42;
/** When the last cube has landed (ms after the first starts). */
export const BUILD_MS = Math.round((BUILD_SPREAD + BUILD_FALL) * 1000);
const LIGHT = (() => {
  const [x, y, z] = [-0.5, 0.75, 0.45];
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l] as const;
})();

export interface AgentShape {
  color: string;
  eyes: string;
  accessory: string;
}

/** A cube: its middle (cells, y up), its back and front, its ramp, each face's tone, and when it shows. */
interface Cube {
  x: number;
  y: number;
  z0: number;
  z1: number;
  ramp: number;
  front: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
  /** 0 always, 1 with the eyes open, 2 with them shut. */
  show: 0 | 1 | 2;
}

interface Ink {
  hex: string;
  ramp: number;
  level: number;
  eye?: boolean;
}

/** Ten tones per ramp: the body's five (the avatar's own) with two deeper and three lighter; the eyes; the accessory. */
function rampsOf(color: string) {
  const T = bodyTones(color as AgentColorName);
  const dark = (hex: string, k: number) => mixHex(hex, "#000000", k);
  const light = (hex: string, k: number) => mixHex(hex, "#ffffff", k);
  const K = ACCESSORY_PALETTE.K ?? "#1e1e22";
  const k = ACCESSORY_PALETTE.k ?? "#3a3a42";
  const R = ACCESSORY_PALETTE.R ?? "#e0453a";
  const top = T[4] ?? "#ffffff";
  const deep = T[0] ?? "#000000";
  const ramps = [
    [dark(deep, 0.55), dark(deep, 0.28), ...T, light(top, 0.35), light(top, 0.6), light(top, 0.82)],
    [0.46, 0.38, 0.3, 0.23, 0.17, 0.12, 0.08, 0.05, 0.02, 0].map((d) => dark(EYE_COLOR, d)),
    [
      "#000000",
      dark(K, 0.6),
      dark(K, 0.3),
      K,
      mixHex(K, k, 0.5),
      k,
      light(k, 0.08),
      light(k, 0.16),
      light(k, 0.26),
      light(k, 0.38),
    ],
    [
      dark(R, 0.7),
      dark(R, 0.55),
      dark(R, 0.4),
      dark(R, 0.25),
      dark(R, 0.12),
      R,
      light(R, 0.18),
      light(R, 0.34),
      light(R, 0.5),
      light(R, 0.68),
    ],
  ];
  const inks: Ink[] = [
    ...T.map((hex, i) => ({ hex, ramp: 0, level: 2 + i })),
    { hex: EYE_COLOR, ramp: 1, level: 9, eye: true },
    { hex: K, ramp: 2, level: 3 },
    { hex: k, ramp: 2, level: 5 },
    { hex: R, ramp: 3, level: 5 },
  ];
  return { ramps, inks };
}

/** The avatar as the engine draws it, cell by cell (x across the body, y from the accessory's top down): its inks. */
function sample(look: AgentShape, inks: Ink[], blink: boolean) {
  const R = ACCESSORY_REACH;
  const ox = R.left * N;
  const oy = R.top * N;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round((N + (R.left + R.right) * N) * P);
  canvas.height = Math.round((N + (R.top + R.bottom) * N) * P);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const cells = new Map<string, Ink>();
  if (!ctx) return cells;
  drawAgent(ctx, ox * P, oy * P, N * P, {
    color: look.color as AgentColorName,
    eyes: look.eyes as EyeStyle,
    pose: { turn: [0, 0], squash: 0, blink },
    cells: N,
    after: (g, side, frame) => drawAccessory(g, side, look.accessory, frame),
  });
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const rgb = inks.map((ink) => rgbOf(ink.hex));
  for (let y = -oy; y < N + R.bottom * N; y++)
    for (let x = -ox; x < N + R.right * N; x++) {
      const i = (Math.floor((oy + y + 0.5) * P) * canvas.width + Math.floor((ox + x + 0.5) * P)) * 4;
      if ((data[i + 3] ?? 0) < 128) continue;
      // The nearest ink: edges drawn smooth (the eyes' round ends) count as whichever ink they mostly are.
      let best = 0;
      let gap = Number.POSITIVE_INFINITY;
      rgb.forEach(([r, g, b], j) => {
        const d = ((data[i] ?? 0) - r) ** 2 + ((data[i + 1] ?? 0) - g) ** 2 + ((data[i + 2] ?? 0) - b) ** 2;
        if (d < gap) [best, gap] = [j, d];
      });
      const ink = inks[best];
      if (ink) cells.set(`${x},${y}`, ink);
    }
  return cells;
}

/**
 * The agent's cubes, its tones and its height (cells, from its foot to its accessory's top). Its eyes are sampled
 * open and shut: a pixel that differs between them shows with one or the other.
 */
export function agentCubes(look: AgentShape) {
  const { ramps, inks } = rampsOf(look.color);
  const open = sample(look, inks, false);
  const shut = sample(look, inks, true);
  const cubes: Cube[] = [];
  const add = (key: string, ink: Ink, show: Cube["show"]) => {
    const [x = 0, y = 0] = key.split(",").map(Number);
    const l = ink.level;
    cubes.push({
      x: x - (N - 1) / 2,
      y: N - 0.5 - y,
      z0: -DEPTH / 2,
      z1: DEPTH / 2 + (ink.eye ? EYE_OUT : 0),
      ramp: ink.ramp,
      front: l,
      top: Math.min(RAMP - 1, l + FACE.top),
      left: Math.max(0, l + FACE.left),
      right: Math.max(0, l + FACE.right),
      bottom: Math.max(0, l + FACE.bottom),
      show,
    });
  };
  let top = 0;
  for (const [key, ink] of open) {
    top = Math.min(top, Number(key.split(",")[1]));
    const closed = shut.get(key);
    if (closed === ink) add(key, ink, 0);
    else {
      add(key, ink, 1);
      if (closed) add(key, closed, 2);
    }
  }
  return { cubes, ramps, height: N - top };
}

const VERT = `
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec2 aDither;
attribute float aLevel;
attribute float aRamp;
attribute float aShow;
attribute float aDelay;
uniform mat4 uMvp;
uniform float uBuild;
uniform mat3 uTurn;
uniform mat3 uRest;
uniform float uBlink;
varying vec2 vDither;
varying float vLevel;
varying float vRamp;
varying vec3 vNormal;
varying vec3 vRestNormal;
void main() {
  // Its place in the build: not started yet (not drawn), falling, or landed.
  float p = clamp((uBuild - aDelay * ${BUILD_SPREAD.toFixed(3)}) / ${BUILD_FALL.toFixed(3)}, 0.0, 1.0);
  if ((aShow == 1.0 && uBlink > 0.5) || (aShow == 2.0 && uBlink < 0.5) || p <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  // Out-back with a small overshoot (1.2): it lands a hair low and settles up into its place.
  float q = p - 1.0;
  float landed = 1.0 + 2.2 * q * q * q + 1.2 * q * q;
  vDither = aDither;
  vLevel = aLevel;
  vRamp = aRamp;
  vNormal = uTurn * aNormal;
  vRestNormal = uRest * aNormal;
  gl_Position = uMvp * vec4(aPos + vec3(0.0, (1.0 - landed) * ${BUILD_DROP.toFixed(1)}, 0.0), 1.0);
}`;

const FRAG = `
precision mediump float;
uniform sampler2D uTones;
uniform vec3 uLight;
uniform float uRamps;
varying vec2 vDither;
varying float vLevel;
varying float vRamp;
varying vec3 vNormal;
varying vec3 vRestNormal;
float b2(vec2 p) { return mod(2.0 * p.x + 3.0 * p.y, 4.0); }
float bayer(vec2 p) {
  vec2 q = mod(floor(p), 4.0);
  return (4.0 * b2(mod(q, 2.0)) + b2(floor(q / 2.0)) + 0.5) / 16.0;
}
void main() {
  // A face turned toward the light takes lighter tones than it has at rest, one turned away deeper ones.
  float turn = dot(normalize(vNormal), uLight) - dot(normalize(vRestNormal), uLight);
  float level = vLevel + 3.2 * turn;
  float i = clamp(floor(level) + step(bayer(vDither), fract(level)), 0.0, ${(RAMP - 1).toFixed(1)});
  gl_FragColor = texture2D(uTones, vec2((i + 0.5) / ${RAMP.toFixed(1)}, (vRamp + 0.5) / uRamps));
}`;

/** The cubes as quads: positions, normals, dither coordinates, tones, ramps and when they show. */
function geometry(cubes: Cube[], dither: number) {
  const pos: number[] = [];
  const nor: number[] = [];
  const dit: number[] = [];
  const lev: number[] = [];
  const ramp: number[] = [];
  const show: number[] = [];
  const delay: number[] = [];
  const idx: number[] = [];
  // Its turn in the build (0..1): its row from the foot up, nudged by a fixed noise of its column.
  const ys = cubes.map((c) => c.y);
  const [low, high] = [Math.min(...ys), Math.max(...ys)];
  const turnOf = (c: Cube) => {
    const row = high > low ? (c.y - low) / (high - low) : 0;
    const noise = Math.abs(Math.sin(c.x * 12.9898 + c.y * 78.233) * 43758.5453) % 1;
    return Math.min(1, row * 0.85 + noise * 0.15);
  };
  const quad = (corners: number[][], n: number[], ditherOf: (p: number[]) => number[], level: number, c: Cube) => {
    const base = pos.length / 3;
    for (const p of corners) {
      pos.push(...p);
      nor.push(...n);
      dit.push(...ditherOf(p));
      lev.push(level);
      ramp.push(c.ramp);
      show.push(c.show);
      delay.push(turnOf(c));
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const d = dither;
  for (const c of cubes) {
    const [x0, x1, y0, y1, zb, zf] = [c.x - 0.5, c.x + 0.5, c.y - 0.5, c.y + 0.5, c.z0, c.z1];
    const xy = (p: number[]) => [(p[0] ?? 0) * d, -(p[1] ?? 0) * d];
    const xz = (p: number[]) => [(p[0] ?? 0) * d, (p[2] ?? 0) * d];
    const zy = (p: number[]) => [(p[2] ?? 0) * d, -(p[1] ?? 0) * d];
    quad(
      [
        [x0, y0, zf],
        [x1, y0, zf],
        [x1, y1, zf],
        [x0, y1, zf],
      ],
      [0, 0, 1],
      xy,
      c.front,
      c,
    );
    quad(
      [
        [x0, y1, zf],
        [x1, y1, zf],
        [x1, y1, zb],
        [x0, y1, zb],
      ],
      [0, 1, 0],
      xz,
      c.top,
      c,
    );
    quad(
      [
        [x0, y0, zb],
        [x1, y0, zb],
        [x1, y0, zf],
        [x0, y0, zf],
      ],
      [0, -1, 0],
      xz,
      c.bottom,
      c,
    );
    quad(
      [
        [x0, y0, zb],
        [x0, y0, zf],
        [x0, y1, zf],
        [x0, y1, zb],
      ],
      [-1, 0, 0],
      zy,
      c.left,
      c,
    );
    quad(
      [
        [x1, y0, zf],
        [x1, y0, zb],
        [x1, y1, zb],
        [x1, y1, zf],
      ],
      [1, 0, 0],
      zy,
      c.right,
      c,
    );
  }
  return { pos, nor, dit, lev, ramp, show, delay, idx };
}

type Mat4 = number[];
const multiply = (a: Mat4, b: Mat4): Mat4 => {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) out[c * 4 + r] = (out[c * 4 + r] ?? 0) + (a[k * 4 + r] ?? 0) * (b[c * 4 + k] ?? 0);
  return out;
};
const translation = (x: number, y: number, z: number): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
/** A turn by `pitch` about x, then `yaw` about y (yaw applied last: the figure turns toward the pointer). */
const rotation = (pitch: number, yaw: number): Mat4 => {
  const [cx, sx, cy, sy] = [Math.cos(pitch), Math.sin(pitch), Math.cos(yaw), Math.sin(yaw)];
  const ry: Mat4 = [cy, 0, -sy, 0, 0, 1, 0, 0, sy, 0, cy, 0, 0, 0, 0, 1];
  const rx: Mat4 = [1, 0, 0, 0, 0, cx, sx, 0, 0, -sx, cx, 0, 0, 0, 0, 1];
  return multiply(ry, rx);
};
const mat3Of = (m: Mat4) => [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]] as number[];
const perspective = (fov: number, aspect: number, near: number, far: number): Mat4 => {
  const f = 1 / Math.tan(fov / 2);
  return [
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    (far + near) / (near - far),
    -1,
    0,
    0,
    (2 * far * near) / (near - far),
    0,
  ];
};

export interface VoxelView {
  /**
   * Draws it turned by `yaw` and `pitch` (radians, beyond its rest), its eyes shut or open, `build` seconds into its
   * building itself (`BUILD_MS`; left out: built).
   */
  draw(yaw: number, pitch: number, blink: boolean, build?: number): void;
  /** What it drew last, in the canvas's CSS pixels (read back), or null. */
  inked(): { left: number; top: number; right: number; bottom: number } | null;
  destroy(): void;
}

/**
 * Draws `cubes` on `canvas` (its CSS size, `width` × `height`): `unit` CSS px per cell, turning round `middle` (cells),
 * at rest by `rest` (radians). Null where WebGL is missing: the caller shows the flat avatar instead.
 */
export function voxelView(
  canvas: HTMLCanvasElement,
  shape: ReturnType<typeof agentCubes>,
  {
    width,
    height,
    unit,
    dither,
    rest,
  }: {
    width: number;
    height: number;
    unit: number;
    dither: number;
    rest: { yaw: number; pitch: number };
  },
): VoxelView | null {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const gl = canvas.getContext("webgl", { alpha: true, antialias: true, premultipliedAlpha: true });
  if (!gl) return null;
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  };
  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's own method, not a React hook.
  gl.useProgram(program);

  const g = geometry(shape.cubes, dither);
  const attribute = (name: string, data: number[], size: number) => {
    const loc = gl.getAttribLocation(program, name);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    return buffer;
  };
  const buffers = [
    attribute("aPos", g.pos, 3),
    attribute("aNormal", g.nor, 3),
    attribute("aDither", g.dit, 2),
    attribute("aLevel", g.lev, 1),
    attribute("aRamp", g.ramp, 1),
    attribute("aShow", g.show, 1),
    attribute("aDelay", g.delay, 1),
  ];
  const indices = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(g.idx), gl.STATIC_DRAW);

  // The ramps as a texture: a row of RAMP tones each, deep to light, read by the nearest texel.
  const tones = new Uint8Array(RAMP * shape.ramps.length * 4);
  for (const [r, row] of shape.ramps.entries())
    for (const [i, hex] of row.entries()) {
      const [cr, cg, cb] = rgbOf(hex);
      tones.set([cr, cg, cb, 255], (r * RAMP + i) * 4);
    }
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, RAMP, shape.ramps.length, 0, gl.RGBA, gl.UNSIGNED_BYTE, tones);
  for (const [k, v] of [
    [gl.TEXTURE_MIN_FILTER, gl.NEAREST],
    [gl.TEXTURE_MAG_FILTER, gl.NEAREST],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
    [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
  ] as const)
    gl.texParameteri(gl.TEXTURE_2D, k, v);

  const u = (name: string) => gl.getUniformLocation(program, name);
  gl.uniform1i(u("uTones"), 0);
  gl.uniform1f(u("uRamps"), shape.ramps.length);
  gl.uniform3f(u("uLight"), ...LIGHT);
  gl.uniformMatrix3fv(u("uRest"), false, mat3Of(rotation(rest.pitch, rest.yaw)));

  // A long lens from far away: depth without the figure bulging at its ends.
  const fov = (7 * Math.PI) / 180;
  const distance = height / unit / 2 / Math.tan(fov / 2);
  const projection = perspective(fov, width / height, distance * 0.5, distance * 2);
  const view = translation(0, 0, -distance);
  const toMiddle = translation(0, -shape.height / 2, 0);
  gl.enable(gl.DEPTH_TEST);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 0);

  return {
    draw(yaw, pitch, blink, build = BUILD_MS / 1000) {
      const turn = rotation(rest.pitch + pitch, rest.yaw + yaw);
      gl.uniform1f(u("uBuild"), build);
      gl.uniformMatrix4fv(u("uMvp"), false, multiply(projection, multiply(view, multiply(turn, toMiddle))));
      gl.uniformMatrix3fv(u("uTurn"), false, mat3Of(turn));
      gl.uniform1f(u("uBlink"), blink ? 1 : 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.drawElements(gl.TRIANGLES, g.idx.length, gl.UNSIGNED_SHORT, 0);
    },
    inked() {
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let [x0, x1, y0, y1] = [w, -1, h, -1];
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          if ((px[(y * w + x) * 4 + 3] ?? 0) > 8) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
      if (x1 < 0) return null;
      const k = w / width;
      return { left: x0 / k, right: (x1 + 1) / k, top: (h - 1 - y1) / k, bottom: (h - y0) / k };
    },
    destroy() {
      for (const b of buffers) gl.deleteBuffer(b);
      gl.deleteBuffer(indices);
      gl.deleteTexture(texture);
      gl.deleteProgram(program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
