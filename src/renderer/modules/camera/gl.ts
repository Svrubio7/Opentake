// WebGL2 colour pipeline: camera frame -> (background blur passes at quarter size) -> one grading
// pass to the output canvas. The tone maths mirrors camera-core.ts (toneCurve, shoulder, wbGains).
import type { Adjust, Rect } from "./camera-core";

export type BgMode = "none" | "blur" | "color" | "image";

export interface RenderParams {
  adjust: Adjust;
  /** linear white balance gains from wbGains() */
  wb: [number, number, number];
  lookAmount: number;
  crop: Rect;
  mirror: boolean;
  bgMode: BgMode;
  /** 0..1 */
  bgBlur: number;
  bgColor: [number, number, number];
  /** a segmentation mask has been uploaded */
  maskReady: boolean;
}

const VERT = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Quarter-size copy of the frame, weighted so the person does not bleed into the blurred background.
const DOWN = `#version 300 es
precision highp float;
uniform sampler2D uVideo, uMask;
uniform vec2 uSize, uSrcTexel;
uniform float uMaskOn;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec2 d = uSrcTexel;
  vec3 c = 0.25 * (texture(uVideo, uv + vec2(-d.x, -d.y)).rgb + texture(uVideo, uv + vec2(d.x, -d.y)).rgb
                 + texture(uVideo, uv + vec2(-d.x, d.y)).rgb + texture(uVideo, uv + vec2(d.x, d.y)).rgb);
  float m = texture(uMask, uv).r;
  float w = mix(1.0, 1.0 - smoothstep(0.2, 0.6, m), uMaskOn) + 0.004;
  o = vec4(c * w, w);
}`;

// Separable gaussian, 9 taps through 5 linear fetches.
const BLUR = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uSize, uDir;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec2 st = uDir / uSize;
  vec4 c = texture(uSrc, uv) * 0.2270270270;
  c += (texture(uSrc, uv + st * 1.3846153846) + texture(uSrc, uv - st * 1.3846153846)) * 0.3162162162;
  c += (texture(uSrc, uv + st * 3.2307692308) + texture(uSrc, uv - st * 3.2307692308)) * 0.0702702703;
  o = c;
}`;

const MAIN = `#version 300 es
precision highp float;
precision mediump sampler3D;
in vec2 vUv;
out vec4 o;
uniform sampler2D uVideo, uMask, uBlur, uBg;
uniform sampler3D uLut;
uniform float uLutSize, uLutAmt;
uniform vec2 uTexel, uMaskTexel;
uniform vec4 uCrop;
uniform bool uMirror;
uniform vec3 uWb;
uniform float uExposure, uContrast, uHigh, uShadow, uSat, uVib, uSharpen, uVignette, uSmooth, uSmoothR;
uniform int uBgMode;
uniform vec3 uBgColor;
uniform vec4 uBgFit;
uniform float uMaskOn, uAspect;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 toLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 shoulder(vec3 x, float rec) {
  float k = 0.8 - 0.3 * rec;
  vec3 y = k + (1.0 - k) * (1.0 - exp(-(x - k) / (1.0 - k)));
  return mix(x, y, step(k, x));
}
float toneCurve(float L) {
  float ws = L * (1.0 - L) * (1.0 - L) * 4.0;
  float wh = L * L * (1.0 - L) * 6.75;
  float y = clamp(L + uShadow * 0.4 * ws + uHigh * 0.15 * wh, 0.0, 1.0);
  if (uContrast >= 0.0) y = mix(y, y * y * (3.0 - 2.0 * y), uContrast);
  else y = mix(y, 0.5 + (y - 0.5) * 0.5, -uContrast);
  return clamp(y, 0.0, 1.0);
}
float skinOf(vec3 c) {
  float y = luma(c);
  float cb = (c.b - y) * 0.564 + 0.5;
  float cr = (c.r - y) * 0.713 + 0.5;
  float d = max(abs(cr - 0.60) / 0.085, abs(cb - 0.40) / 0.10);
  return (1.0 - smoothstep(0.6, 1.0, d)) * smoothstep(0.08, 0.2, y);
}
float maskAt(vec2 uv) {
  vec2 d = uMaskTexel * 1.5;
  float m = texture(uMask, uv).r * 0.4
    + (texture(uMask, uv + vec2(d.x, 0.0)).r + texture(uMask, uv - vec2(d.x, 0.0)).r
     + texture(uMask, uv + vec2(0.0, d.y)).r + texture(uMask, uv - vec2(0.0, d.y)).r) * 0.15;
  return smoothstep(0.3, 0.7, m);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 outUv = vec2(vUv.x, 1.0 - vUv.y);       // y down, like the source image
  vec2 o2 = outUv;
  if (uMirror) o2.x = 1.0 - o2.x;
  vec2 uv = uCrop.xy + o2 * uCrop.zw;
  vec3 src = texture(uVideo, uv).rgb;
  vec3 c = src;
  float m = uMaskOn > 0.5 ? maskAt(uv) : 1.0;

  // skin smoothing: edge preserving (bilateral) average, only on skin coloured pixels
  float skin = 0.0;
  if (uSmooth > 0.001) {
    skin = skinOf(src) * mix(1.0, m, uMaskOn);
    if (skin > 0.02) {
      vec3 acc = src; float ws = 1.0;
      for (int i = 0; i < 8; i++) {
        float a = float(i) * 0.785398 + 0.3927;
        vec2 dir = vec2(cos(a), sin(a)) * uTexel * uSmoothR;
        for (int r = 1; r <= 2; r++) {
          vec3 s = texture(uVideo, uv + dir * float(r)).rgb;
          vec3 dd = s - src;
          float w = exp(-dot(dd, dd) * 160.0) * (r == 1 ? 1.0 : 0.7);
          acc += s * w; ws += w;
        }
      }
      c = mix(src, acc / ws, clamp(uSmooth * skin, 0.0, 0.95));
    }
  }
  // sharpening: unsharp mask against the 4 neighbours, softer on smoothed skin
  if (uSharpen > 0.001) {
    vec3 n = 0.25 * (texture(uVideo, uv + vec2(uTexel.x, 0.0)).rgb + texture(uVideo, uv - vec2(uTexel.x, 0.0)).rgb
                   + texture(uVideo, uv + vec2(0.0, uTexel.y)).rgb + texture(uVideo, uv - vec2(0.0, uTexel.y)).rgb);
    float detail = luma(src - n);
    c += detail * uSharpen * 1.4 * (1.0 - skin * uSmooth * 0.8);
  }
  // background blur is mixed before grading so the room keeps the same colour as you
  if (uBgMode == 1) {
    vec4 bl = texture(uBlur, uv);
    c = mix(bl.rgb / max(bl.a, 0.004), c, m);
  }

  // grade: white balance + exposure in linear light, soft highlight shoulder
  vec3 lin = toLin(clamp(c, 0.0, 1.0)) * uWb * exp2(uExposure);
  lin = shoulder(lin, max(-uHigh, 0.0));
  c = toSrgb(lin);
  float L = luma(c);
  float L2 = toneCurve(clamp(L, 0.0, 1.0));
  c = L > 1e-4 ? c * min(L2 / L, 4.0) : c + L2;
  float Lc = luma(c);
  float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  c = mix(vec3(Lc), c, 1.0 + uSat + uVib * (1.0 - clamp(sat * 1.5, 0.0, 1.0)));
  c = clamp(c, 0.0, 1.0);
  vec3 lc = c * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize;
  c = mix(c, texture(uLut, lc).rgb, uLutAmt);

  if (uBgMode == 2) c = mix(uBgColor, c, m);
  if (uBgMode == 3) c = mix(texture(uBg, uBgFit.zw + outUv * uBgFit.xy).rgb, c, m);

  vec2 vd = (outUv - 0.5) * vec2(uAspect, 1.0) / max(uAspect, 1.0);
  c *= 1.0 - uVignette * 0.7 * smoothstep(0.25, 0.75, length(vd));
  c += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  o = vec4(c, 1.0);
}`;

interface Prog { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> }
interface Target { tex: WebGLTexture; fb: WebGLFramebuffer; w: number; h: number }

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private main: Prog;
  private down: Prog;
  private blur: Prog;
  private vao: WebGLVertexArrayObject;
  private video: WebGLTexture;
  private mask: WebGLTexture;
  private lut: WebGLTexture;
  private bg: WebGLTexture;
  private lutSize = 2;
  private maskSize: [number, number] = [1, 1];
  private bgSize: [number, number] = [1, 1];
  private targets: [Target, Target] | null = null;
  private halfFloat: boolean;
  private srcSize: [number, number] = [0, 0];

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.halfFloat = !!gl.getExtension("EXT_color_buffer_float");
    this.main = this.program(MAIN);
    this.down = this.program(DOWN);
    this.blur = this.program(BLUR);
    this.vao = gl.createVertexArray()!;
    this.video = this.texture(gl.LINEAR);
    this.mask = this.texture(gl.LINEAR);
    this.bg = this.texture(gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.upload1x1(this.mask, 255);
    this.upload1x1(this.bg, 0);
    this.lut = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, this.lut);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]])
      gl.texParameteri(gl.TEXTURE_3D, k, v);
    // identity 2x2x2 until a look is set
    this.setLut(new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255, 0, 255, 255, 0, 0, 0, 255, 255, 0, 255, 0, 255, 255, 255, 255, 255]), 2);
  }

  private program(fs: string): Prog {
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
    const u: Prog["u"] = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      if (info) u[info.name] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
  }

  private texture(filter: number) {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private upload1x1(t: WebGLTexture, v: number) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([v, v, v, 255]));
  }

  private target(w: number, h: number): Target {
    const gl = this.gl;
    const tex = this.texture(gl.LINEAR);
    if (this.halfFloat) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, w, h };
  }

  private ensureTargets(w: number, h: number) {
    const tw = Math.max(16, Math.round(w / 4)), th = Math.max(16, Math.round(h / 4));
    if (this.targets && this.targets[0].w === tw && this.targets[0].h === th) return;
    this.freeTargets();
    this.targets = [this.target(tw, th), this.target(tw, th)];
  }

  private freeTargets() {
    if (!this.targets) return;
    for (const t of this.targets) { this.gl.deleteTexture(t.tex); this.gl.deleteFramebuffer(t.fb); }
    this.targets = null;
  }

  setLut(data: Uint8Array, size: number) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_3D, this.lut);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, size, size, size, 0, gl.RGB, gl.UNSIGNED_BYTE, data);
    this.lutSize = size;
  }

  /** person confidence, one byte a pixel, row 0 = top of the frame */
  setMask(data: Uint8Array, w: number, h: number) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.mask);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (this.maskSize[0] !== w || this.maskSize[1] !== h) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, data);
      this.maskSize = [w, h];
    } else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.UNSIGNED_BYTE, data);
  }

  setBackgroundImage(img: TexImageSource | null, w = 1, h = 1) {
    if (!img) { this.upload1x1(this.bg, 0); this.bgSize = [1, 1]; return; }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.bg);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    this.bgSize = [w, h];
  }

  get backgroundAspect() { return this.bgSize[0] / this.bgSize[1]; }

  /** Uploads the current video frame and draws one output frame. */
  render(video: TexImageSource, vw: number, vh: number, p: RenderParams, bgFit: { sx: number; sy: number; ox: number; oy: number }) {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    if (this.canvas.width !== vw || this.canvas.height !== vh) { this.canvas.width = vw; this.canvas.height = vh; }
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.video);
    if (this.srcSize[0] !== vw || this.srcSize[1] !== vh) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, video);
      this.srcSize = [vw, vh];
    } else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);

    const maskOn = p.maskReady && p.bgMode !== "none" ? 1 : 0;
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.mask);

    let blurTex: WebGLTexture = this.video;
    if (p.bgMode === "blur") {
      this.ensureTargets(vw, vh);
      const [a, b] = this.targets!;
      gl.useProgram(this.down.p);
      gl.uniform1i(this.down.u.uVideo, 0);
      gl.uniform1i(this.down.u.uMask, 1);
      gl.uniform2f(this.down.u.uSize, a.w, a.h);
      gl.uniform2f(this.down.u.uSrcTexel, 1 / vw, 1 / vh);
      gl.uniform1f(this.down.u.uMaskOn, maskOn);
      this.draw(a);
      gl.useProgram(this.blur.p);
      gl.uniform1i(this.blur.u.uSrc, 2);
      gl.uniform2f(this.blur.u.uSize, a.w, a.h);
      const passes = 1 + Math.round(p.bgBlur * 2);
      const radius = 0.6 + p.bgBlur * 2.6;
      for (let i = 0; i < passes; i++) {
        const r = radius * (1 + i * 0.7);
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, a.tex);
        gl.uniform2f(this.blur.u.uDir, r, 0);
        this.draw(b);
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, b.tex);
        gl.uniform2f(this.blur.u.uDir, 0, r);
        this.draw(a);
      }
      blurTex = a.tex;
    } else if (this.targets) this.freeTargets();

    const u = this.main.u;
    const A = p.adjust;
    gl.useProgram(this.main.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.video);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.mask);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, blurTex);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.bg);
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_3D, this.lut);
    gl.uniform1i(u.uVideo, 0); gl.uniform1i(u.uMask, 1); gl.uniform1i(u.uBlur, 2); gl.uniform1i(u.uBg, 3); gl.uniform1i(u.uLut, 4);
    gl.uniform1f(u.uLutSize, this.lutSize);
    gl.uniform1f(u.uLutAmt, p.lookAmount);
    gl.uniform2f(u.uTexel, 1 / vw, 1 / vh);
    gl.uniform2f(u.uMaskTexel, 1 / this.maskSize[0], 1 / this.maskSize[1]);
    gl.uniform4f(u.uCrop, p.crop.x, p.crop.y, p.crop.w, p.crop.h);
    gl.uniform1i(u.uMirror, p.mirror ? 1 : 0);
    gl.uniform3f(u.uWb, p.wb[0], p.wb[1], p.wb[2]);
    gl.uniform1f(u.uExposure, A.exposure);
    gl.uniform1f(u.uContrast, A.contrast);
    gl.uniform1f(u.uHigh, A.highlights);
    gl.uniform1f(u.uShadow, A.shadows);
    gl.uniform1f(u.uSat, A.saturation);
    gl.uniform1f(u.uVib, A.vibrance);
    gl.uniform1f(u.uSharpen, A.sharpen);
    gl.uniform1f(u.uVignette, A.vignette);
    gl.uniform1f(u.uSmooth, A.smoothing);
    gl.uniform1f(u.uSmoothR, Math.max(1.5, (vh / 1080) * 5));
    gl.uniform1i(u.uBgMode, { none: 0, blur: 1, color: 2, image: 3 }[p.bgMode]);
    gl.uniform3f(u.uBgColor, p.bgColor[0], p.bgColor[1], p.bgColor[2]);
    gl.uniform4f(u.uBgFit, bgFit.sx, bgFit.sy, bgFit.ox, bgFit.oy);
    gl.uniform1f(u.uMaskOn, maskOn);
    gl.uniform1f(u.uAspect, vw / vh);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, vw, vh);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private draw(t: Target) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.viewport(0, 0, t.w, t.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose() {
    this.freeTargets();
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
