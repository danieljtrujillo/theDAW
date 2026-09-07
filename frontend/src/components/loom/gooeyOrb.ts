/**
 * gooeyOrb — the liquid gooey orb, as a WebGL2 atlas for the colony canvas.
 *
 * Ported from Tamino Martinius' "Liquid Gooey Orb Shader"
 * (https://codepen.io/TaminoMartinius/pen/MYJEyer, MIT © 2026 Tamino Martinius).
 * The vertex and fragment shaders are his: a raymarched blob whose radius is
 * modulated by drifting sine lobes, a short volumetric march of domain-warped
 * noise for the liquid inside, fresnel rim, two specular glints, and a glow
 * that stays OUTSIDE the silhouette. His pen draws several orbs into one
 * canvas with scissor regions; this file keeps that and only changes the
 * final composite so the region comes out with premultiplied alpha (the dish
 * is drawn beneath it on a 2D canvas) plus a `u_body` opacity for the inside,
 * so a colony can be a glass bubble and a loop a solid cell.
 *
 * `blobRadius` is the same `blobField` evaluated on a 2D rim, for the cells
 * that are not orbs (gates, mods, rules): nothing here is a rigid circle.
 */

export interface OrbParams {
  radius: number;        // base size of the blob (0.2–0.4 of the region)
  deform: number;        // how far the surface bulges in/out
  frequency: number;     // number of lobes across the surface
  morphSpeed: number;    // how fast the shape changes
  rotSpeed: number;      // how fast the blob tumbles
  specular: number;      // strength of the glints
  shininess: number;     // tightness of the glints
  glowStrength: number;  // brightness of the outer ring glow
  colorBlue: string;
  colorMagenta: string;
  glowA: string;
  glowB: string;
  liquidSpeed: number;   // how fast the liquid flows
  liquidScale: number;   // size of the swirls
  liquidBright: number;  // overall interior brightness
  filament: number;      // brightness of the bright threads
  core: number;          // glow at the very centre
  background: string;    // the dish colour (for ink mode and the body)
  blend: number;         // 0 = additive glow, 1 = ink (light backgrounds)
  body: number;          // opacity of the inside (1 = solid, 0.3 = bubble)
  seed: number;          // per-orb time offset so no two tumble in step
}

export interface OrbRegion { x: number; y: number; w: number; h: number; params: OrbParams; time: number }

const VERT = `#version 300 es
layout(location=0) in vec2 a_pos;
out vec2 v_uv;
void main(){ v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;

uniform float u_time;
uniform vec2  u_res;
uniform float u_radius;
uniform float u_deform;
uniform float u_freq;
uniform float u_morphSpeed;
uniform float u_rotSpeed;
uniform float u_specular;
uniform float u_shininess;
uniform float u_glowStrength;
uniform vec3  u_colBlue;
uniform vec3  u_colMag;
uniform vec3  u_glowA;
uniform vec3  u_glowB;
uniform float u_liquidSpeed;
uniform float u_liquidScale;
uniform float u_liquidBright;
uniform float u_filament;
uniform float u_core;
uniform vec3  u_bg;
uniform float u_blend;   // 0 = additive glow, 1 = ink (works on light backgrounds)
uniform float u_body;    // opacity of the inside of the orb

mat2 rot(float a){ float c=cos(a), s=sin(a); return mat2(c,-s,s,c); }

// organic blob: a sphere whose radius is modulated by slow drifting sine lobes
float blobField(vec3 p){
  float t = u_time * u_morphSpeed;
  float f = u_freq;
  float d = 0.0;
  d += sin(p.x * 2.6 * f + t * 1.00);
  d += sin(p.y * 2.9 * f - t * 0.80 + 1.3);
  d += sin(p.z * 3.2 * f + t * 1.20 + 2.7);
  d += sin((p.x + p.z) * 2.2 * f - t * 0.90 + 4.1);
  d += sin((p.y - p.x) * 2.4 * f + t * 0.70 + 0.6);
  return d * 0.2;
}

float mapBlob(vec3 p){
  float t = u_time * u_rotSpeed;
  p.xy *= rot(t * 0.7);
  p.yz *= rot(t * 0.5);
  float r = u_radius + u_deform * blobField(p);
  return length(p) - r;              // approx SDF; under-step while marching
}

vec3 calcNormal(vec3 p){
  vec2 e = vec2(0.0015, 0.0);
  return normalize(vec3(
    mapBlob(p + e.xyy) - mapBlob(p - e.xyy),
    mapBlob(p + e.yxy) - mapBlob(p - e.yxy),
    mapBlob(p + e.yyx) - mapBlob(p - e.yyx)));
}

// 3D noise for the swirling liquid inside the glass
float hash13(vec3 p3){ p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float vnoise3(vec3 p){
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i + vec3(0,0,0)), hash13(i + vec3(1,0,0)), f.x),
                 mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x),
                 mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm3(vec3 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 3; i++){ v += a * vnoise3(p); p *= 2.03; a *= 0.5; } return v; }

// domain-warped 3D field -> flowing liquid filaments
float liquid(vec3 p){
  float t = u_time * u_liquidSpeed;
  p *= u_liquidScale;
  p.xy *= rot(t * 0.15);
  p.yz *= rot(t * 0.10);
  vec3 w = vec3(fbm3(p + t * 0.2), fbm3(p + vec3(4.3, 1.2, -t * 0.15)), fbm3(p.zxy + vec3(7.7, 2.3, t * 0.10)));
  return fbm3(p + 1.8 * w);
}

void main(){
  vec2 p = v_uv * 2.0 - 1.0;
  p.x *= u_res.x / u_res.y;

  vec3 ro = vec3(0.0, 0.0, 3.0);
  vec3 rd = normalize(vec3(p, -1.8));

  // raymarch; track closest approach so the glow stays OUTSIDE the orb
  float t = 0.0;
  bool hit = false;
  vec3 pos = ro;
  float minD = 1e3;
  for (int i = 0; i < 96; i++) {
    pos = ro + rd * t;
    float d = mapBlob(pos);
    minD = min(minD, d);
    if (d < 0.002) { hit = true; break; }
    t += d * 0.5;
    if (t > 6.0) break;
  }

  vec3 E = vec3(0.0);   // emissive light the orb contributes

  if (hit) {
    vec3 n = calcNormal(pos);
    vec3 v = -rd;
    float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);

    // liquid interior: short volumetric march of swirling noise through the glass
    vec3 rp = pos + rd * 0.04;
    float trans = 1.0;
    vec3 inner = vec3(0.0);
    for (int k = 0; k < 8; k++) {
      float raw = liquid(rp);
      float dens = smoothstep(0.30, 0.70, raw);             // contrast -> distinct swirls
      float fil = pow(1.0 - abs(2.0 * raw - 1.0), 5.0);     // thin bright filaments
      vec3 c = mix(u_colMag, u_colBlue, 0.5 + 0.5 * sin(raw * 6.0 + u_time * 0.3 + rp.y * 2.5));
      vec3 emit = c * dens * 0.55 + c * fil * u_filament + vec3(1.0) * pow(fil, 3.0) * u_filament * 0.4;
      emit += u_colBlue * smoothstep(0.5, 0.0, length(rp)) * u_core;   // bright bluish core
      inner += trans * emit * 0.17;
      trans *= 0.84;
      rp += rd * 0.11;
      if (length(rp) > 1.0) break;
    }
    E += inner * (1.0 - fres * 0.6) * u_liquidBright;       // fades toward the rim

    // glassy rim + specular glints (front surface)
    vec3 rim = mix(u_colMag, u_colBlue, 0.5 + 0.5 * (n.x * 0.7 + n.y * 0.45));
    E += rim * fres * 1.3;
    vec3 l1 = normalize(vec3(0.6, 0.85, 0.6));
    vec3 l2 = normalize(vec3(-0.7, 0.25, 0.55));
    vec3 h1 = normalize(l1 + v);
    vec3 h2 = normalize(l2 + v);
    E += vec3(1.0) * pow(max(dot(n, h1), 0.0), u_shininess) * 1.3 * u_specular;
    E += vec3(0.8, 0.9, 1.0) * pow(max(dot(n, h2), 0.0), u_shininess * 0.45) * 0.6 * u_specular;
  } else {
    // glow ONLY outside: brightest at the silhouette, radiating outward
    float g = exp(-minD * 5.5);
    float ang = atan(rd.y, rd.x);
    vec3 gc = mix(u_glowA, u_glowB, 0.5 + 0.5 * sin(ang * 3.0 + u_time * 0.5));
    E += (gc * g * 1.4 + vec3(0.6, 0.8, 1.0) * pow(g, 3.0) * 0.7) * u_glowStrength;
  }

  // Premultiplied composite for a 2D canvas underneath:
  //  • Glow (additive) — the light the orb emits, coverage = brightness
  //  • Ink  (tone-mapped) — stays visible on light backgrounds
  //  • the inside of the orb also carries u_body of the background colour
  float cov = clamp(max(E.r, max(E.g, E.b)), 0.0, 1.0);
  vec3 Ec = mix(clamp(E, 0.0, 1.0), E / (1.0 + E), u_blend);
  float body = hit ? u_body : 0.0;
  float a = max(cov, body);
  vec3 rgb = min(Ec + u_bg * body, vec3(a));
  fragColor = vec4(rgb, a);
}`;

const U_NAMES = ['u_time', 'u_res', 'u_radius', 'u_deform', 'u_freq', 'u_morphSpeed', 'u_rotSpeed', 'u_specular', 'u_shininess', 'u_glowStrength', 'u_colBlue', 'u_colMag', 'u_glowA', 'u_glowB', 'u_liquidSpeed', 'u_liquidScale', 'u_liquidBright', 'u_filament', 'u_core', 'u_bg', 'u_blend', 'u_body'] as const;

export function hexToRgb01(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** The pen's Aurora preset, as the base every cell varies from. */
export const ORB_BASE: OrbParams = {
  radius: 0.30, deform: 0.36, frequency: 2.0, morphSpeed: 1.30, rotSpeed: 0.12, specular: 1.0, shininess: 140, glowStrength: 0.70,
  colorBlue: '#4099FF', colorMagenta: '#E633BF', glowA: '#33B5FF', glowB: '#E24DD0',
  liquidSpeed: 0.50, liquidScale: 2.20, liquidBright: 1.00, filament: 1.40, core: 0.30, background: '#070A18', blend: 0, body: 1, seed: 0,
};

/**
 * One WebGL2 canvas that holds every orb for a frame, each in its own scissor
 * region (the pen draws its preset thumbnails this way). `draw` lays the
 * regions out on shelves, renders them, and returns where each one landed so
 * the 2D canvas can drawImage the tile it needs.
 */
export class OrbAtlas {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private u: Partial<Record<(typeof U_NAMES)[number], WebGLUniformLocation | null>> = {};
  readonly ok: boolean;

  constructor() {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: false });
    if (!gl) { this.ok = false; return; }
    try {
      const program = gl.createProgram()!;
      gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'link failed');
      gl.useProgram(program);
      // fullscreen triangle-strip quad
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      for (const name of U_NAMES) this.u[name] = gl.getUniformLocation(program, name);
      this.gl = gl;
      this.program = program;
      this.ok = true;
    } catch {
      this.ok = false;
    }
  }

  /** Render every region; returns the same regions with x/y assigned in the atlas. */
  draw(regions: OrbRegion[]): OrbRegion[] {
    const gl = this.gl;
    if (!gl || !this.program || regions.length === 0) return [];
    // Shelf packing, widest first, into a canvas no wider than 2048.
    const maxW = 2048;
    const sorted = regions.slice().sort((a, b) => b.h - a.h);
    let x = 0; let y = 0; let shelf = 0; let width = 0;
    for (const r of sorted) {
      if (x + r.w > maxW) { x = 0; y += shelf; shelf = 0; }
      r.x = x; r.y = y;
      x += r.w;
      shelf = Math.max(shelf, r.h);
      width = Math.max(width, x);
    }
    const height = y + shelf;
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    gl.useProgram(this.program);
    for (const r of sorted) {
      // GL's origin is bottom-left; flip y so the 2D drawImage coordinates match.
      const gy = height - r.y - r.h;
      gl.viewport(r.x, gy, r.w, r.h);
      gl.scissor(r.x, gy, r.w, r.h);
      const v = r.params;
      const u = this.u;
      gl.uniform1f(u.u_time!, r.time + v.seed);
      gl.uniform2f(u.u_res!, r.w, r.h);
      gl.uniform1f(u.u_radius!, v.radius);
      gl.uniform1f(u.u_deform!, v.deform);
      gl.uniform1f(u.u_freq!, v.frequency);
      gl.uniform1f(u.u_morphSpeed!, v.morphSpeed);
      gl.uniform1f(u.u_rotSpeed!, v.rotSpeed);
      gl.uniform1f(u.u_specular!, v.specular);
      gl.uniform1f(u.u_shininess!, v.shininess);
      gl.uniform1f(u.u_glowStrength!, v.glowStrength);
      gl.uniform3fv(u.u_colBlue!, hexToRgb01(v.colorBlue));
      gl.uniform3fv(u.u_colMag!, hexToRgb01(v.colorMagenta));
      gl.uniform3fv(u.u_glowA!, hexToRgb01(v.glowA));
      gl.uniform3fv(u.u_glowB!, hexToRgb01(v.glowB));
      gl.uniform1f(u.u_liquidSpeed!, v.liquidSpeed);
      gl.uniform1f(u.u_liquidScale!, v.liquidScale);
      gl.uniform1f(u.u_liquidBright!, v.liquidBright);
      gl.uniform1f(u.u_filament!, v.filament);
      gl.uniform1f(u.u_core!, v.core);
      gl.uniform3fv(u.u_bg!, hexToRgb01(v.background));
      gl.uniform1f(u.u_blend!, v.blend);
      gl.uniform1f(u.u_body!, v.body);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disable(gl.SCISSOR_TEST);
    return sorted;
  }

  dispose(): void {
    const ext = this.gl?.getExtension('WEBGL_lose_context');
    ext?.loseContext();
    this.gl = null;
  }
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'shader compile failed');
  return sh;
}

/* ── the same lobes, on a 2D rim ─────────────────────────────────────────── */

/**
 * `blobField` evaluated at the rim point (cosθ, sinθ, z) — the radius
 * multiplier of an organic outline at angle θ. `z` is a per-cell slice so
 * two cells with the same colour never share a shape.
 */
export function blobRadius(theta: number, time: number, opts: { deform?: number; frequency?: number; morphSpeed?: number; z?: number } = {}): number {
  const t = time * (opts.morphSpeed ?? 1.3);
  const f = opts.frequency ?? 2.0;
  const x = Math.cos(theta);
  const y = Math.sin(theta);
  const z = opts.z ?? 0;
  let d = 0;
  d += Math.sin(x * 2.6 * f + t * 1.0);
  d += Math.sin(y * 2.9 * f - t * 0.8 + 1.3);
  d += Math.sin(z * 3.2 * f + t * 1.2 + 2.7);
  d += Math.sin((x + z) * 2.2 * f - t * 0.9 + 4.1);
  d += Math.sin((y - x) * 2.4 * f + t * 0.7 + 0.6);
  return 1 + (opts.deform ?? 0.36) * d * 0.2;
}

/** Trace an organic outline (a deformed circle, diamond or hexagon) as a path. */
export function blobPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, time: number, shape: 'round' | 'diamond' | 'hex', z: number, deform = 0.36): void {
  const n = 36;
  for (let i = 0; i <= n; i += 1) {
    const th = (i / n) * Math.PI * 2 - Math.PI / 2;
    let base = 1;
    if (shape === 'diamond') { const c = Math.abs(Math.cos(th)) + Math.abs(Math.sin(th)); base = 1 / c; }
    else if (shape === 'hex') { const a = ((th % (Math.PI / 3)) + Math.PI / 3) % (Math.PI / 3) - Math.PI / 6; base = Math.cos(Math.PI / 6) / Math.cos(a); }
    const rr = r * base * blobRadius(th, time, { deform, z, frequency: 1.6 });
    const px = x + Math.cos(th) * rr;
    const py = y + Math.sin(th) * rr;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}
