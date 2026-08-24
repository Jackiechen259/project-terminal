import type {
  RenderColor,
  TerminalRenderCell,
  TerminalRenderFrame,
  TerminalRenderRow,
  TerminalSearchMatch,
} from "@/lib/terminalFrames";

import { CanvasRenderer } from "./CanvasRenderer";
import { GlyphAtlas, type GlyphRecord } from "./GlyphAtlas";
import type {
  TerminalCursorInactiveStyle,
  TerminalCursorStyle,
  TerminalFontOptions,
  TerminalRenderer,
  TerminalRendererTheme,
  TerminalSelection,
  TerminalSelectionPoint,
} from "./TerminalRenderer";
import { applyFrameToRowCache, mergePendingFrame } from "./renderFrameMerge";

type Rgb = [number, number, number];
type Rgba = [number, number, number, number];

const ANSI_THEME_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

const DEFAULT_ANSI: Rgb[] = [
  [0, 0, 0],
  [204, 85, 85],
  [85, 204, 85],
  [205, 205, 85],
  [84, 85, 203],
  [204, 85, 204],
  [122, 202, 202],
  [204, 204, 204],
  [85, 85, 85],
  [255, 85, 85],
  [85, 255, 85],
  [255, 255, 85],
  [85, 85, 255],
  [255, 85, 255],
  [85, 255, 255],
  [255, 255, 255],
];

const SOLID_VERTEX_SHADER = [
  "#version 300 es",
  "in vec2 aPosition;",
  "in vec4 aColor;",
  "uniform vec2 uResolution;",
  "out vec4 vColor;",
  "void main() {",
  "  vec2 zeroToOne = aPosition / uResolution;",
  "  vec2 clipSpace = zeroToOne * 2.0 - 1.0;",
  "  gl_Position = vec4(clipSpace * vec2(1.0, -1.0), 0.0, 1.0);",
  "  vColor = aColor;",
  "}",
].join("\n");

const SOLID_FRAGMENT_SHADER = [
  "#version 300 es",
  "precision highp float;",
  "in vec4 vColor;",
  "out vec4 outColor;",
  "void main() {",
  "  outColor = vColor;",
  "}",
].join("\n");

const GLYPH_VERTEX_SHADER = [
  "#version 300 es",
  "in vec2 aPosition;",
  "in vec2 aTexCoord;",
  "in vec4 aColor;",
  "in float aColorGlyph;",
  "uniform vec2 uResolution;",
  "out vec2 vTexCoord;",
  "out vec4 vColor;",
  "out float vColorGlyph;",
  "void main() {",
  "  vec2 zeroToOne = aPosition / uResolution;",
  "  vec2 clipSpace = zeroToOne * 2.0 - 1.0;",
  "  gl_Position = vec4(clipSpace * vec2(1.0, -1.0), 0.0, 1.0);",
  "  vTexCoord = aTexCoord;",
  "  vColor = aColor;",
  "  vColorGlyph = aColorGlyph;",
  "}",
].join("\n");

const GLYPH_FRAGMENT_SHADER = [
  "#version 300 es",
  "precision highp float;",
  "uniform sampler2D uAtlas;",
  "in vec2 vTexCoord;",
  "in vec4 vColor;",
  "in float vColorGlyph;",
  "out vec4 outColor;",
  "void main() {",
  "  vec4 glyph = texture(uAtlas, vTexCoord);",
  "  if (vColorGlyph > 0.5) {",
  "    outColor = vec4(glyph.rgb, glyph.a * vColor.a);",
  "  } else {",
  "    outColor = vec4(vColor.rgb, vColor.a * glyph.a);",
  "  }",
  "}",
].join("\n");

function parseColor(value: string): Rgba {
  const hex = value.match(/^#([0-9a-f]{6})$/iu);
  if (hex) {
    return [
      parseInt(hex[1].slice(0, 2), 16),
      parseInt(hex[1].slice(2, 4), 16),
      parseInt(hex[1].slice(4, 6), 16),
      255,
    ];
  }
  const rgb = value.match(
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/iu,
  );
  if (!rgb) return [0, 0, 0, 255];
  const alpha = rgb[4] === undefined ? 255 : Math.round(Number(rgb[4]) * 255);
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), alpha];
}

function ansi256(index: number): Rgb {
  if (index < 16) return DEFAULT_ANSI[index] ?? DEFAULT_ANSI[0];
  if (index < 232) {
    const color = index - 16;
    const red = Math.floor(color / 36);
    const green = Math.floor((color % 36) / 6);
    const blue = color % 6;
    const ramp = [0, 95, 135, 175, 215, 255];
    return [ramp[red], ramp[green], ramp[blue]];
  }
  const grey = 8 + (index - 232) * 10;
  return [grey, grey, grey];
}

function colorFor(
  color: RenderColor,
  theme: TerminalRendererTheme,
  defaultColor: "foreground" | "background",
): Rgba {
  if (color.kind === "default") return parseColor(theme[defaultColor]);
  if (color.kind === "rgba") return color.value;
  const key = ANSI_THEME_KEYS[color.value];
  const themed = key ? theme[key] : undefined;
  const rgb = themed ? parseColor(themed) : ansi256(color.value);
  return [rgb[0], rgb[1], rgb[2], 255];
}

function luminance([red, green, blue]: Rgb) {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
  );
}

function contrastRatio(foreground: Rgb, background: Rgb) {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  return from.map((channel, index) =>
    Math.round(channel + (to[index] - channel) * amount),
  ) as Rgb;
}

function ensureContrast(
  foreground: Rgba,
  background: Rgba,
  minimumContrast = 1,
): Rgba {
  if (minimumContrast <= 1) return foreground;
  const foregroundRgb: Rgb = [foreground[0], foreground[1], foreground[2]];
  const backgroundRgb: Rgb = [background[0], background[1], background[2]];
  if (contrastRatio(foregroundRgb, backgroundRgb) >= minimumContrast) {
    return foreground;
  }
  const target: Rgb =
    contrastRatio([0, 0, 0], backgroundRgb) >
    contrastRatio([255, 255, 255], backgroundRgb)
      ? [0, 0, 0]
      : [255, 255, 255];
  if (contrastRatio(target, backgroundRgb) < minimumContrast) {
    return [target[0], target[1], target[2], foreground[3]];
  }
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 12; iteration++) {
    const midpoint = (low + high) / 2;
    if (
      contrastRatio(mix(foregroundRgb, target, midpoint), backgroundRgb) >=
      minimumContrast
    ) {
      high = midpoint;
    } else {
      low = midpoint;
    }
  }
  const result = mix(foregroundRgb, target, high);
  return [result[0], result[1], result[2], foreground[3]];
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

function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
) {
  const vertex = createShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
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

function normalizeSelection(
  anchor: TerminalSelectionPoint,
  focus: TerminalSelectionPoint,
): [TerminalSelectionPoint, TerminalSelectionPoint] {
  const anchorBeforeFocus =
    anchor.stableRow < focus.stableRow ||
    (anchor.stableRow === focus.stableRow && anchor.column <= focus.column);
  return anchorBeforeFocus ? [anchor, focus] : [focus, anchor];
}

function fontForCell(cell: TerminalRenderCell, font: TerminalFontOptions) {
  const style = cell.italic ? "italic " : "";
  const weight = cell.intensity === "bold" ? font.weightBold : font.weight;
  return `${style}${weight} ${font.size}px ${font.family}`;
}

/**
 * WebGL2 terminal renderer with a bounded glyph atlas.
 *
 * The GPU draws the full background, cell background quads, and all visible
 * glyphs in a small number of batched calls. Canvas2D remains as a transparent
 * overlay for image protocols, underline/strike decorations, and cursor
 * treatment. If the atlas cannot represent a workload, the complete Canvas2D
 * renderer is restored for correctness.
 */
export class WebGLRenderer implements TerminalRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private overlay: HTMLCanvasElement | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private solidProgram: WebGLProgram | null = null;
  private glyphProgram: WebGLProgram | null = null;
  private solidBuffer: WebGLBuffer | null = null;
  private glyphBuffer: WebGLBuffer | null = null;
  private atlas: GlyphAtlas | null = null;
  private solidPositionLocation = -1;
  private solidColorLocation = -1;
  private glyphPositionLocation = -1;
  private glyphTexCoordLocation = -1;
  private glyphColorLocation = -1;
  private glyphColorGlyphLocation = -1;
  private solidResolutionLocation: WebGLUniformLocation | null = null;
  private glyphResolutionLocation: WebGLUniformLocation | null = null;
  private glyphAtlasLocation: WebGLUniformLocation | null = null;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private cellWidth = 8;
  private cellHeight = 17;
  private baseline = 14;
  private rows = 24;
  private cols = 80;
  private theme: TerminalRendererTheme = {
    background: "#000000",
    foreground: "#ffffff",
  };
  private font: TerminalFontOptions = {
    family: "monospace",
    size: 14,
    weight: 400,
    weightBold: 700,
    lineHeight: 1.2,
    letterSpacing: 0,
  };
  private canvasRenderer = new CanvasRenderer();
  private rowCache = new Map<number, TerminalRenderRow>();
  private frame: TerminalRenderFrame | null = null;
  private pendingFrame: TerminalRenderFrame | null = null;
  private frameRequest: number | null = null;
  private selection: TerminalSelection | null = null;
  private searchMatch: TerminalSearchMatch | null = null;
  private gpuFallback = false;

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
    this.solidProgram = createProgram(
      gl,
      SOLID_VERTEX_SHADER,
      SOLID_FRAGMENT_SHADER,
    );
    this.glyphProgram = createProgram(
      gl,
      GLYPH_VERTEX_SHADER,
      GLYPH_FRAGMENT_SHADER,
    );
    this.solidBuffer = gl.createBuffer();
    this.glyphBuffer = gl.createBuffer();
    this.atlas = new GlyphAtlas(gl);
    if (!this.solidBuffer || !this.glyphBuffer) {
      throw new Error("WebGL2 could not create terminal buffers");
    }
    this.solidPositionLocation = gl.getAttribLocation(
      this.solidProgram,
      "aPosition",
    );
    this.solidColorLocation = gl.getAttribLocation(this.solidProgram, "aColor");
    this.solidResolutionLocation = gl.getUniformLocation(
      this.solidProgram,
      "uResolution",
    );
    this.glyphPositionLocation = gl.getAttribLocation(
      this.glyphProgram,
      "aPosition",
    );
    this.glyphTexCoordLocation = gl.getAttribLocation(
      this.glyphProgram,
      "aTexCoord",
    );
    this.glyphColorLocation = gl.getAttribLocation(this.glyphProgram, "aColor");
    this.glyphColorGlyphLocation = gl.getAttribLocation(
      this.glyphProgram,
      "aColorGlyph",
    );
    this.glyphResolutionLocation = gl.getUniformLocation(
      this.glyphProgram,
      "uResolution",
    );
    this.glyphAtlasLocation = gl.getUniformLocation(
      this.glyphProgram,
      "uAtlas",
    );

    this.overlay = document.createElement("canvas");
    this.overlay.className = "absolute inset-0 z-[1] block h-full w-full";
    this.overlay.setAttribute("aria-hidden", "true");
    this.overlay.style.pointerEvents = "none";
    parent.append(this.overlay);
    this.canvasRenderer.mount(this.overlay);
    this.canvasRenderer.setBackgroundVisible(false);
    this.canvasRenderer.setCellBackgroundVisible(false);
    this.canvasRenderer.setTextVisible(false);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  resize(width: number, height: number, rows: number, cols: number) {
    const nextRows = Math.max(1, rows);
    const nextCols = Math.max(1, cols);
    const gridChanged = this.rows !== nextRows || this.cols !== nextCols;
    this.rows = nextRows;
    this.cols = nextCols;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.dpr = window.devicePixelRatio || 1;
    if (this.canvas) {
      this.canvas.style.width = `${this.width}px`;
      this.canvas.style.height = `${this.height}px`;
      this.canvas.width = Math.ceil(this.width * this.dpr);
      this.canvas.height = Math.ceil(this.height * this.dpr);
    }
    this.updateMetrics();
    this.atlas?.configure(
      this.cellWidth,
      this.cellHeight,
      this.baseline,
      this.dpr,
    );
    this.canvasRenderer.resize(width, height, nextRows, nextCols);
    this.syncOverlayBackingStore();
    const drawingBuffer = this.drawingBufferSize();
    this.gl?.viewport(0, 0, drawingBuffer.width, drawingBuffer.height);
    if (gridChanged) {
      if (this.frameRequest !== null) {
        window.cancelAnimationFrame(this.frameRequest);
        this.frameRequest = null;
      }
      this.pendingFrame = null;
      this.rowCache.clear();
      this.frame = null;
    }
    this.drawBackground();
    if (!gridChanged && this.frame) this.paintFrame(this.frame);
  }

  measureGrid(width: number, height: number) {
    const grid = this.canvasRenderer.measureGrid(width, height);
    this.updateMetrics();
    return grid;
  }

  render(frame: TerminalRenderFrame) {
    this.pendingFrame = mergePendingFrame(this.pendingFrame, frame);
    if (this.frameRequest !== null) return;
    this.frameRequest = window.requestAnimationFrame(() => {
      this.frameRequest = null;
      const next = this.pendingFrame;
      this.pendingFrame = null;
      if (next) this.paintFrame(next);
    });
  }

  setTheme(theme: TerminalRendererTheme) {
    this.theme = theme;
    this.canvasRenderer.setTheme(theme);
    this.paintCurrentFrame();
  }

  setFont(font: TerminalFontOptions) {
    this.font = font;
    this.canvasRenderer.setFont(font);
    this.updateMetrics();
    this.atlas?.configure(
      this.cellWidth,
      this.cellHeight,
      this.baseline,
      this.dpr,
    );
    this.gpuFallback = false;
    this.canvasRenderer.setBackgroundVisible(false);
    this.canvasRenderer.setCellBackgroundVisible(false);
    this.canvasRenderer.setTextVisible(false);
    this.paintCurrentFrame();
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
    this.selection = selection;
    this.canvasRenderer.setSelection(selection);
    this.paintCurrentFrame();
  }

  setSearchMatch(match: TerminalSearchMatch | null) {
    this.searchMatch = match;
    this.canvasRenderer.setSearchMatch(match);
    this.paintCurrentFrame();
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
    if (this.frameRequest !== null) {
      window.cancelAnimationFrame(this.frameRequest);
      this.frameRequest = null;
    }
    this.pendingFrame = null;
    this.atlas?.dispose();
    this.canvasRenderer.dispose();
    this.overlay?.remove();
    const gl = this.gl;
    if (gl) {
      if (this.solidBuffer) gl.deleteBuffer(this.solidBuffer);
      if (this.glyphBuffer) gl.deleteBuffer(this.glyphBuffer);
      if (this.solidProgram) gl.deleteProgram(this.solidProgram);
      if (this.glyphProgram) gl.deleteProgram(this.glyphProgram);
    }
    this.canvas = null;
    this.overlay = null;
    this.gl = null;
    this.solidProgram = null;
    this.glyphProgram = null;
    this.solidBuffer = null;
    this.glyphBuffer = null;
    this.atlas = null;
    this.rowCache.clear();
    this.frame = null;
  }

  private paintFrame(frame: TerminalRenderFrame) {
    const cacheUpdate = applyFrameToRowCache(this.rowCache, this.frame, frame, {
      rows: this.rows,
      cols: this.cols,
    });
    if (cacheUpdate.cacheCleared) this.drawBackground();
    if (!cacheUpdate.accepted) return;
    this.frame = frame;
    if (this.gpuFallback) {
      this.canvasRenderer.render(frame);
      return;
    }
    this.drawBackground();
    this.drawCellBackgrounds(frame);
    if (!this.drawGlyphs(frame)) {
      this.gpuFallback = true;
      this.canvasRenderer.setBackgroundVisible(true);
      this.canvasRenderer.setCellBackgroundVisible(true);
      this.canvasRenderer.setTextVisible(true);
      this.canvasRenderer.render(frame);
      return;
    }
    this.canvasRenderer.render(frame);
  }

  private paintCurrentFrame() {
    if (this.gpuFallback) {
      this.canvasRenderer.redraw();
      return;
    }
    this.drawBackground();
    const frame = this.frame;
    if (!frame) return;
    this.drawCellBackgrounds(frame);
    if (!this.drawGlyphs(frame)) {
      this.gpuFallback = true;
      this.canvasRenderer.setBackgroundVisible(true);
      this.canvasRenderer.setCellBackgroundVisible(true);
      this.canvasRenderer.setTextVisible(true);
      this.canvasRenderer.redraw();
      return;
    }
    this.canvasRenderer.redraw();
  }

  private updateMetrics() {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return;
    context.font = `${this.font.size}px ${this.font.family}`;
    const metrics = context.measureText("Mg");
    this.cellWidth = Math.max(1, metrics.width / 2 + this.font.letterSpacing);
    this.cellHeight = Math.max(1, this.font.size * this.font.lineHeight);
    this.baseline = Math.max(
      1,
      (this.cellHeight -
        metrics.actualBoundingBoxAscent -
        metrics.actualBoundingBoxDescent) /
        2 +
        metrics.actualBoundingBoxAscent,
    );
  }

  /**
   * Return the actual physical drawing-buffer size used by WebGL.
   *
   * CSS size multiplied by DPR can be fractional, while both the canvas
   * backing store and the WebGL viewport are integer pixel dimensions. Every
   * shader resolution must use this same final size or the last row/column of
   * the opaque framebuffer can remain untouched.
   */
  private drawingBufferSize() {
    const fallbackWidth = Math.ceil(this.width * this.dpr);
    const fallbackHeight = Math.ceil(this.height * this.dpr);
    return {
      width: Math.max(
        1,
        this.gl?.drawingBufferWidth || this.canvas?.width || fallbackWidth,
      ),
      height: Math.max(
        1,
        this.gl?.drawingBufferHeight || this.canvas?.height || fallbackHeight,
      ),
    };
  }

  /** Keep the transparent Canvas2D overlay on the same backing store. */
  private syncOverlayBackingStore() {
    if (!this.canvas || !this.overlay) return;
    if (this.overlay.width !== this.canvas.width) {
      this.overlay.width = this.canvas.width;
    }
    if (this.overlay.height !== this.canvas.height) {
      this.overlay.height = this.canvas.height;
    }
  }

  private drawBackground() {
    const gl = this.gl;
    const program = this.solidProgram;
    const buffer = this.solidBuffer;
    if (!gl || !program || !buffer) return;
    const { width, height } = this.drawingBufferSize();
    gl.viewport(0, 0, width, height);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        0,
        0,
        width,
        0,
        0,
        height,
        0,
        height,
        width,
        0,
        width,
        height,
      ]),
      gl.STREAM_DRAW,
    );
    gl.enableVertexAttribArray(this.solidPositionLocation);
    gl.vertexAttribPointer(
      this.solidPositionLocation,
      2,
      gl.FLOAT,
      false,
      0,
      0,
    );
    gl.disableVertexAttribArray(this.solidColorLocation);
    const [red, green, blue, alpha] = parseColor(this.theme.background);
    gl.vertexAttrib4f(
      this.solidColorLocation,
      red / 255,
      green / 255,
      blue / 255,
      alpha / 255,
    );
    gl.uniform2f(this.solidResolutionLocation, width, height);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private drawCellBackgrounds(frame: TerminalRenderFrame) {
    const gl = this.gl;
    const program = this.solidProgram;
    const buffer = this.solidBuffer;
    if (!gl || !program || !buffer) return;
    const values: number[] = [];
    for (let rowOffset = 0; rowOffset < frame.rows; rowOffset++) {
      const stableRow = frame.viewportTop + rowOffset;
      const row = this.rowCache.get(stableRow);
      if (!row) continue;
      for (const cell of row.cells) {
        const selected = this.cellIsSelected(stableRow, cell);
        const searched = this.cellIsSearchMatched(stableRow, cell);
        if (
          cell.background.kind === "default" &&
          !cell.reverse &&
          !selected &&
          !searched
        )
          continue;
        const colors = this.cellColors(cell, stableRow);
        this.pushRect(
          values,
          cell.column * this.cellWidth,
          rowOffset * this.cellHeight,
          this.cellWidth * Math.max(1, cell.width),
          colors[1],
        );
      }
    }
    if (!values.length) return;
    const { width, height } = this.drawingBufferSize();
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(values), gl.STREAM_DRAW);
    const stride = 6 * Float32Array.BYTES_PER_ELEMENT;
    gl.enableVertexAttribArray(this.solidPositionLocation);
    gl.vertexAttribPointer(
      this.solidPositionLocation,
      2,
      gl.FLOAT,
      false,
      stride,
      0,
    );
    gl.enableVertexAttribArray(this.solidColorLocation);
    gl.vertexAttribPointer(
      this.solidColorLocation,
      4,
      gl.FLOAT,
      false,
      stride,
      2 * Float32Array.BYTES_PER_ELEMENT,
    );
    gl.uniform2f(this.solidResolutionLocation, width, height);
    gl.drawArrays(gl.TRIANGLES, 0, values.length / 6);
  }

  private drawGlyphs(frame: TerminalRenderFrame) {
    const gl = this.gl;
    const program = this.glyphProgram;
    const buffer = this.glyphBuffer;
    const atlas = this.atlas;
    if (!gl || !program || !buffer || !atlas) return false;
    atlas.configure(this.cellWidth, this.cellHeight, this.baseline, this.dpr);
    const values: number[] = [];
    for (let rowOffset = 0; rowOffset < frame.rows; rowOffset++) {
      const stableRow = frame.viewportTop + rowOffset;
      const row = this.rowCache.get(stableRow);
      if (!row) continue;
      for (const cell of row.cells) {
        if (cell.invisible || !cell.text) continue;
        const record = atlas.get(
          cell.text,
          Math.max(1, cell.width),
          fontForCell(cell, this.font),
        );
        if (!record) return false;
        const colors = this.cellColors(cell, stableRow)[0];
        const alpha = (colors[3] / 255) * (cell.intensity === "half" ? 0.5 : 1);
        this.pushGlyph(
          values,
          cell.column * this.cellWidth,
          rowOffset * this.cellHeight,
          this.cellWidth * Math.max(1, cell.width),
          this.cellHeight,
          record,
          [colors[0] / 255, colors[1] / 255, colors[2] / 255, alpha],
        );
      }
    }
    if (!values.length) return true;
    const { width, height } = this.drawingBufferSize();
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(values), gl.STREAM_DRAW);
    const stride = 9 * Float32Array.BYTES_PER_ELEMENT;
    gl.enableVertexAttribArray(this.glyphPositionLocation);
    gl.vertexAttribPointer(
      this.glyphPositionLocation,
      2,
      gl.FLOAT,
      false,
      stride,
      0,
    );
    gl.enableVertexAttribArray(this.glyphTexCoordLocation);
    gl.vertexAttribPointer(
      this.glyphTexCoordLocation,
      2,
      gl.FLOAT,
      false,
      stride,
      2 * Float32Array.BYTES_PER_ELEMENT,
    );
    gl.enableVertexAttribArray(this.glyphColorLocation);
    gl.vertexAttribPointer(
      this.glyphColorLocation,
      4,
      gl.FLOAT,
      false,
      stride,
      4 * Float32Array.BYTES_PER_ELEMENT,
    );
    gl.enableVertexAttribArray(this.glyphColorGlyphLocation);
    gl.vertexAttribPointer(
      this.glyphColorGlyphLocation,
      1,
      gl.FLOAT,
      false,
      stride,
      8 * Float32Array.BYTES_PER_ELEMENT,
    );
    gl.uniform2f(this.glyphResolutionLocation, width, height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlas.getTexture());
    gl.uniform1i(this.glyphAtlasLocation, 0);
    gl.drawArrays(gl.TRIANGLES, 0, values.length / 9);
    return true;
  }

  private pushRect(
    values: number[],
    x: number,
    y: number,
    width: number,
    color: Rgba,
  ) {
    const left = x * this.dpr;
    const top = y * this.dpr;
    const right = (x + width) * this.dpr;
    const bottom = (y + this.cellHeight) * this.dpr;
    const rgba: Rgba = [
      color[0] / 255,
      color[1] / 255,
      color[2] / 255,
      color[3] / 255,
    ];
    values.push(
      left,
      top,
      ...rgba,
      right,
      top,
      ...rgba,
      left,
      bottom,
      ...rgba,
      left,
      bottom,
      ...rgba,
      right,
      top,
      ...rgba,
      right,
      bottom,
      ...rgba,
    );
  }

  private pushGlyph(
    values: number[],
    x: number,
    y: number,
    width: number,
    height: number,
    record: GlyphRecord,
    color: [number, number, number, number],
  ) {
    const padding = record.padding / this.dpr;
    const left = (x - padding) * this.dpr;
    const top = (y - padding) * this.dpr;
    const right = (x + width + padding) * this.dpr;
    const bottom = (y + height + padding) * this.dpr;
    const [u0, v0, u1, v1] = [record.u0, record.v0, record.u1, record.v1];
    const vertex = (px: number, py: number, u: number, v: number) => {
      values.push(px, py, u, v, ...color, record.color ? 1 : 0);
    };
    vertex(left, top, u0, v0);
    vertex(right, top, u1, v0);
    vertex(left, bottom, u0, v1);
    vertex(left, bottom, u0, v1);
    vertex(right, top, u1, v0);
    vertex(right, bottom, u1, v1);
  }

  private cellColors(
    cell: TerminalRenderCell,
    stableRow: number,
  ): [Rgba, Rgba] {
    let foreground = colorFor(cell.foreground, this.theme, "foreground");
    let background = colorFor(cell.background, this.theme, "background");
    if (cell.reverse) [foreground, background] = [background, foreground];
    if (this.cellIsSelected(stableRow, cell)) {
      background = parseColor(
        this.theme.selectionBackground ?? this.theme.foreground,
      );
      foreground = parseColor(this.theme.foreground);
    } else if (this.cellIsSearchMatched(stableRow, cell)) {
      background = parseColor(this.theme.yellow ?? "#a68b00");
      foreground = parseColor(this.theme.background);
    } else {
      foreground = ensureContrast(
        foreground,
        background,
        this.theme.minimumContrast,
      );
    }
    return [foreground, background];
  }

  private cellIsSelected(stableRow: number, cell: TerminalRenderCell) {
    if (!this.selection) return false;
    const [start, end] = normalizeSelection(
      this.selection.anchor,
      this.selection.focus,
    );
    if (start.stableRow === end.stableRow && start.column === end.column)
      return false;
    if (stableRow < start.stableRow || stableRow > end.stableRow) return false;
    const from = stableRow === start.stableRow ? start.column : 0;
    const to =
      stableRow === end.stableRow ? end.column : Number.MAX_SAFE_INTEGER;
    return cell.column < to && cell.column + Math.max(1, cell.width) > from;
  }

  private cellIsSearchMatched(stableRow: number, cell: TerminalRenderCell) {
    const match = this.searchMatch;
    if (!match || match.stableRow !== stableRow) return false;
    return (
      cell.column < match.endColumn &&
      cell.column + Math.max(1, cell.width) > match.startColumn
    );
  }
}

export type TerminalRendererPreference = "auto" | "webgl" | "dom";

export function createTerminalRenderer(
  preference: TerminalRendererPreference,
): TerminalRenderer {
  return preference === "dom" ? new CanvasRenderer() : new WebGLRenderer();
}
