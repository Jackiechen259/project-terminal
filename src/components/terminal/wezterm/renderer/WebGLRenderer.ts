import type {
  TerminalRenderFrame,
  TerminalRenderRow,
  TerminalSearchMatch,
} from "@/lib/terminalFrames";

import { CanvasRenderer } from "./CanvasRenderer";
import type {
  TerminalCursorInactiveStyle,
  TerminalCursorStyle,
  TerminalFontOptions,
  TerminalRenderer,
  TerminalRendererTheme,
  TerminalSelection,
  TerminalSelectionPoint,
} from "./TerminalRenderer";

type Rgb = [number, number, number];

const VERTEX_SHADER = [
  "#version 300 es",
  "in vec2 aPosition;",
  "uniform vec2 uResolution;",
  "void main() {",
  "  vec2 zeroToOne = aPosition / uResolution;",
  "  vec2 zeroToTwo = zeroToOne * 2.0;",
  "  vec2 clipSpace = zeroToTwo - 1.0;",
  "  gl_Position = vec4(clipSpace * vec2(1.0, -1.0), 0.0, 1.0);",
  "}",
].join("\n");

const FRAGMENT_SHADER = [
  "#version 300 es",
  "precision highp float;",
  "uniform vec4 uColor;",
  "out vec4 outColor;",
  "void main() {",
  "  outColor = uColor;",
  "}",
].join("\n");

function parseColor(value: string): Rgb {
  const hex = value.match(/^#([0-9a-f]{6})$/iu);
  if (hex) {
    return [
      parseInt(hex[1].slice(0, 2), 16),
      parseInt(hex[1].slice(2, 4), 16),
      parseInt(hex[1].slice(4, 6), 16),
    ];
  }
  const rgb = value.match(
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\s*\)$/iu,
  );
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : [0, 0, 0];
}

function createShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("WebGL2 could not create a shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "unknown shader error";
    gl.deleteShader(shader);
    throw new Error("WebGL2 shader compilation failed: " + message);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext) {
  const vertex = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!program) throw new Error("WebGL2 could not create a program");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "unknown program error";
    gl.deleteProgram(program);
    throw new Error("WebGL2 program linking failed: " + message);
  }
  return program;
}

/**
 * WebGL2 terminal renderer.
 *
 * The GPU owns the full-surface background pass (one draw call per frame).
 * Canvas2D is retained as a transparent correctness overlay for glyph shaping,
 * combining marks, emoji, hyperlinks, images, selection, and decorations.
 * This keeps the renderer replaceable while we collect real-world profiling
 * data before moving the glyph atlas into a texture batch.
 */
export class WebGLRenderer implements TerminalRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private overlay: HTMLCanvasElement | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private positionLocation = -1;
  private resolutionLocation: WebGLUniformLocation | null = null;
  private colorLocation: WebGLUniformLocation | null = null;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private theme: TerminalRendererTheme = {
    background: "#000000",
    foreground: "#ffffff",
  };
  private canvasRenderer = new CanvasRenderer();

  mount(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error("WebGL2 is unavailable");
    const parent = canvas.parentElement;
    if (!parent) throw new Error("WebGL2 renderer requires a parent element");

    this.canvas = canvas;
    this.gl = gl;
    this.program = createProgram(gl);
    this.buffer = gl.createBuffer();
    if (!this.buffer) throw new Error("WebGL2 could not create a vertex buffer");
    this.positionLocation = gl.getAttribLocation(this.program, "aPosition");
    this.resolutionLocation = gl.getUniformLocation(
      this.program,
      "uResolution",
    );
    this.colorLocation = gl.getUniformLocation(this.program, "uColor");

    this.overlay = document.createElement("canvas");
    this.overlay.className = "absolute inset-0 block h-full w-full";
    this.overlay.setAttribute("aria-hidden", "true");
    this.overlay.style.pointerEvents = "none";
    parent.append(this.overlay);
    this.canvasRenderer.mount(this.overlay);
    this.canvasRenderer.setBackgroundVisible(false);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
  }

  resize(width: number, height: number, rows: number, cols: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.dpr = window.devicePixelRatio || 1;
    if (this.canvas) {
      this.canvas.style.width = this.width + "px";
      this.canvas.style.height = this.height + "px";
      this.canvas.width = Math.ceil(this.width * this.dpr);
      this.canvas.height = Math.ceil(this.height * this.dpr);
    }
    this.gl?.viewport(
      0,
      0,
      Math.ceil(this.width * this.dpr),
      Math.ceil(this.height * this.dpr),
    );
    this.canvasRenderer.resize(width, height, rows, cols);
    this.drawBackground();
  }

  measureGrid(width: number, height: number) {
    return this.canvasRenderer.measureGrid(width, height);
  }

  render(frame: TerminalRenderFrame) {
    this.drawBackground();
    this.canvasRenderer.render(frame);
  }

  setTheme(theme: TerminalRendererTheme) {
    this.theme = theme;
    this.canvasRenderer.setTheme(theme);
    this.drawBackground();
  }

  setFont(font: TerminalFontOptions) {
    this.canvasRenderer.setFont(font);
  }

  setCursorStyle(
    style: TerminalCursorStyle,
    inactiveStyle: TerminalCursorInactiveStyle,
  ) {
    this.canvasRenderer.setCursorStyle(style, inactiveStyle);
  }

  setCursorBlink(enabled: boolean) {
    this.canvasRenderer.setCursorBlink(enabled);
  }

  setFocused(focused: boolean) {
    this.canvasRenderer.setFocused(focused);
  }

  setSelection(selection: TerminalSelection | null) {
    this.canvasRenderer.setSelection(selection);
  }

  setSearchMatch(match: TerminalSearchMatch | null) {
    this.canvasRenderer.setSearchMatch(match);
  }

  selectionText(anchor: TerminalSelectionPoint, focus: TerminalSelectionPoint) {
    return this.canvasRenderer.selectionText(anchor, focus);
  }

  rowAtPoint(clientX: number, clientY: number) {
    return this.canvasRenderer.rowAtPoint(clientX, clientY);
  }

  linkAtPoint(clientX: number, clientY: number) {
    return this.canvasRenderer.linkAtPoint(clientX, clientY);
  }

  rowText(row: TerminalRenderRow) {
    return this.canvasRenderer.rowText(row);
  }

  dispose() {
    this.canvasRenderer.dispose();
    this.overlay?.remove();
    const gl = this.gl;
    if (gl) {
      if (this.buffer) gl.deleteBuffer(this.buffer);
      if (this.program) gl.deleteProgram(this.program);
    }
    this.canvas = null;
    this.overlay = null;
    this.gl = null;
    this.program = null;
    this.buffer = null;
  }

  private drawBackground() {
    const gl = this.gl;
    const program = this.program;
    const buffer = this.buffer;
    if (!gl || !program || !buffer) return;
    const [red, green, blue] = parseColor(this.theme.background);
    const width = this.width * this.dpr;
    const height = this.height * this.dpr;
    gl.viewport(0, 0, width, height);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, width, 0, 0, height]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(this.positionLocation);
    gl.vertexAttribPointer(
      this.positionLocation,
      2,
      gl.FLOAT,
      false,
      0,
      0,
    );
    gl.uniform2f(this.resolutionLocation, width, height);
    gl.uniform4f(this.colorLocation, red / 255, green / 255, blue / 255, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

export type TerminalRendererPreference = "auto" | "webgl" | "dom";

export function createTerminalRenderer(
  preference: TerminalRendererPreference,
): TerminalRenderer {
  return preference === "dom" ? new CanvasRenderer() : new WebGLRenderer();
}
