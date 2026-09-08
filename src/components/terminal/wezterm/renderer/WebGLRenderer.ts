import type {
  RenderColor,
  TerminalRenderCell,
  TerminalRenderFrame,
  TerminalRenderRow,
  TerminalSearchMatch,
} from "@/lib/terminalFrames";
import {
  ansi256ToRgb,
  ANSI_THEME_KEYS,
  ensureContrastRgb,
  parseCssColor,
} from "@/lib/terminalColorMath";

import {
  CanvasRenderer,
  cellBlinkHidden,
  rowsHaveBlink,
} from "./CanvasRenderer";
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
import { applyFrameToRowCache, forEachCellCluster } from "./renderFrameMerge";

type Rgba = [number, number, number, number];

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
  return parseCssColor(value) ?? [0, 0, 0, 255];
}

function ensureContrast(
  foreground: Rgba,
  background: Rgba,
  minimumContrast = 1,
): Rgba {
  if (minimumContrast <= 1) return foreground;
  const adjusted = ensureContrastRgb(
    [foreground[0], foreground[1], foreground[2]],
    [background[0], background[1], background[2]],
    minimumContrast,
  );
  return [adjusted[0], adjusted[1], adjusted[2], foreground[3]];
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

function isSpaceOnly(text: string) {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 32) return false;
  }
  return true;
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
  private fontNormal = "400 14px monospace";
  private fontBold = "700 14px monospace";
  private fontItalic = "italic 400 14px monospace";
  private fontBoldItalic = "italic 700 14px monospace";
  private canvasRenderer = new CanvasRenderer();
  private rowCache = new Map<number, TerminalRenderRow>();
  private frame: TerminalRenderFrame | null = null;
  private frameRequest: number | null = null;
  private gpuFallback = false;
  private visible = true;
  private cellBlinkTimer: number | null = null;
  /** Reused, geometrically-grown vertex scratch buffers - see `pushRect`/
   * `pushGlyph`. Avoids allocating a `number[]` plus a fresh `Float32Array`
   * on every cell-background/glyph draw call. */
  private solidVertexData = new Float32Array(0);
  private solidVertexCount = 0;
  private glyphVertexData = new Float32Array(0);
  private glyphVertexCount = 0;
  /** Memoizes `parseColor`/`ensureContrast` for the lifetime of one theme -
   * both are pure but were otherwise re-parsing/re-solving the same handful
   * of theme colors for every cell on every frame. */
  private colorParseCache = new Map<string, Rgba>();
  private contrastCache = new Map<string, Rgba>();
  private metricsContext: CanvasRenderingContext2D | null = null;

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
      const backingWidth = Math.ceil(this.width * this.dpr);
      const backingHeight = Math.ceil(this.height * this.dpr);
      if (this.canvas.width !== backingWidth) this.canvas.width = backingWidth;
      if (this.canvas.height !== backingHeight)
        this.canvas.height = backingHeight;
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
    }
    if (!this.visible) return;
    this.drawBackground();
    if (this.frame) this.paintCurrentFrame();
  }

  measureGrid(width: number, height: number) {
    const grid = this.canvasRenderer.measureGrid(width, height);
    this.updateMetrics();
    return grid;
  }

  render(frame: TerminalRenderFrame): boolean {
    if (!this.acceptFrame(frame)) return false;
    if (this.gpuFallback) {
      // The GPU draws nothing in fallback mode - `paintCurrentFrame` would
      // just proxy straight to the overlay - so let CanvasRenderer own its
      // own incremental paint schedule directly instead of scheduling a
      // second rAF here that does nothing but call back into it.
      return this.canvasRenderer.render(frame);
    }
    this.canvasRenderer.ingestFrame(frame);
    this.refreshCellBlinkTimer();
    this.schedulePaint();
    return true;
  }

  renderImmediate(frame: TerminalRenderFrame): boolean {
    if (this.frameRequest !== null) {
      window.cancelAnimationFrame(this.frameRequest);
      this.frameRequest = null;
    }
    if (!this.acceptFrame(frame)) return false;
    if (this.gpuFallback) {
      return this.canvasRenderer.renderImmediate(frame);
    }
    this.canvasRenderer.ingestFrame(frame);
    this.refreshCellBlinkTimer();
    if (this.visible) this.paintCurrentFrame();
    return true;
  }

  redraw() {
    // A forced full repaint (for example on tab activation) must work
    // whether or not the GPU is currently in use - unlike the frame-cadence
    // path above, this cannot rely on CanvasRenderer's own scheduling
    // already having run.
    if (this.gpuFallback) {
      this.canvasRenderer.redraw();
      return;
    }
    this.paintCurrentFrame();
  }

  private schedulePaint() {
    if (!this.visible || this.frameRequest !== null) return;
    this.frameRequest = window.requestAnimationFrame(() => {
      this.frameRequest = null;
      this.paintCurrentFrame();
    });
  }

  private refreshCellBlinkTimer() {
    const needed =
      !this.gpuFallback && rowsHaveBlink(this.frame, this.rowCache);
    if (needed) this.startCellBlink();
    else this.stopCellBlink();
  }

  private startCellBlink() {
    if (!this.visible || this.cellBlinkTimer !== null) return;
    this.cellBlinkTimer = window.setInterval(() => {
      this.schedulePaint();
    }, 100);
  }

  private stopCellBlink() {
    if (this.cellBlinkTimer === null) return;
    window.clearInterval(this.cellBlinkTimer);
    this.cellBlinkTimer = null;
  }

  setTheme(theme: TerminalRendererTheme) {
    this.theme = theme;
    this.clearColorCache();
    this.canvasRenderer.setTheme(theme);
    this.schedulePaint();
  }

  setFont(font: TerminalFontOptions) {
    this.font = font;
    this.fontNormal = `${font.weight} ${font.size}px ${font.family}`;
    this.fontBold = `${font.weightBold} ${font.size}px ${font.family}`;
    this.fontItalic = `italic ${font.weight} ${font.size}px ${font.family}`;
    this.fontBoldItalic = `italic ${font.weightBold} ${font.size}px ${font.family}`;
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

  setVisible(visible: boolean) {
    this.visible = visible;
    this.canvasRenderer.setVisible(visible);
    if (!visible && this.frameRequest !== null) {
      window.cancelAnimationFrame(this.frameRequest);
      this.frameRequest = null;
    }
    if (visible) this.refreshCellBlinkTimer();
    else this.stopCellBlink();
  }

  noteInputActivity() {
    this.canvasRenderer.noteInputActivity();
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

  cursorRect() {
    if (!this.frame) return null;
    return {
      x: this.frame.cursor.column * this.cellWidth,
      y: this.frame.cursor.row * this.cellHeight,
      width: this.cellWidth,
      height: this.cellHeight,
      visible: this.frame.cursor.visibility === "visible",
    };
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
    this.atlas?.dispose();
    this.stopCellBlink();
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
    this.metricsContext = null;
    this.colorParseCache.clear();
    this.contrastCache.clear();
  }

  private acceptFrame(frame: TerminalRenderFrame): boolean {
    const cacheUpdate = applyFrameToRowCache(this.rowCache, this.frame, frame, {
      rows: this.rows,
      cols: this.cols,
    });
    if (!cacheUpdate.accepted) return false;
    this.frame = frame;
    return true;
  }

  private paintCurrentFrame() {
    if (!this.visible) return;
    if (this.gpuFallback) {
      // Reached only via resize()/redraw(), which call this unconditionally
      // after already asking CanvasRenderer to repaint itself; render() and
      // renderImmediate() never schedule a paint at all while in fallback,
      // so there is nothing for the GPU to contribute here.
      return;
    }
    this.drawBackground();
    const frame = this.frame;
    if (!frame) return;
    this.drawCellBackgrounds(frame);
    if (!this.drawGlyphs(frame)) {
      this.gpuFallback = true;
      this.stopCellBlink();
      this.canvasRenderer.setBackgroundVisible(true);
      this.canvasRenderer.setCellBackgroundVisible(true);
      this.canvasRenderer.setTextVisible(true);
      this.canvasRenderer.redraw();
      return;
    }
    // Only the overlay's own dirty rows repaint here, not the full grid -
    // the GPU already redrew every cached row above.
    this.canvasRenderer.paintOverlayPending();
  }

  private updateMetrics() {
    // `measureGrid` runs from every ResizeObserver callback, so this used to
    // allocate a throwaway canvas + 2D context per call (e.g. per frame of a
    // split-divider drag). One measuring context, reused for the renderer's
    // lifetime, does the same measurement for free.
    if (!this.metricsContext) {
      this.metricsContext =
        document.createElement("canvas").getContext("2d") ?? null;
    }
    const context = this.metricsContext;
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
    let resized = false;
    if (this.overlay.width !== this.canvas.width) {
      this.overlay.width = this.canvas.width;
      resized = true;
    }
    if (this.overlay.height !== this.canvas.height) {
      this.overlay.height = this.canvas.height;
      resized = true;
    }
    // Assigning `width`/`height` clears the backing bitmap, so anything the
    // overlay's cursor tracker thinks is already painted is gone with it -
    // a plain `paintOverlayPending` afterward would then skip repainting a
    // cursor it believes is still on-screen. Force a full repaint so the
    // overlay's retained state and its bitmap agree again.
    if (resized) this.canvasRenderer.redraw();
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
    this.solidVertexCount = 0;
    for (let rowOffset = 0; rowOffset < frame.rows; rowOffset++) {
      const stableRow = frame.viewportTop + rowOffset;
      const row = this.rowCache.get(stableRow);
      if (!row) continue;
      for (const cell of row.cells) {
        const width = Math.max(1, cell.width ?? 1);
        if ((cell.background?.kind ?? "default") === "default" && !cell.reverse)
          continue;
        const colors = this.cellColors(cell);
        this.pushRect(
          cell.column * this.cellWidth,
          rowOffset * this.cellHeight,
          this.cellWidth * width,
          colors[1],
        );
      }
    }
    if (this.solidVertexCount === 0) return;
    const { width, height } = this.drawingBufferSize();
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.solidVertexData.subarray(0, this.solidVertexCount),
      gl.STREAM_DRAW,
    );
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
    gl.drawArrays(gl.TRIANGLES, 0, this.solidVertexCount / 6);
  }

  private drawGlyphs(frame: TerminalRenderFrame) {
    const gl = this.gl;
    const program = this.glyphProgram;
    const buffer = this.glyphBuffer;
    const atlas = this.atlas;
    if (!gl || !program || !buffer || !atlas) return false;
    atlas.configure(this.cellWidth, this.cellHeight, this.baseline, this.dpr);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      atlas.beginPass();
      this.glyphVertexCount = 0;
      let restart = false;
      rowLoop: for (let rowOffset = 0; rowOffset < frame.rows; rowOffset++) {
        const stableRow = frame.viewportTop + rowOffset;
        const row = this.rowCache.get(stableRow);
        if (!row) continue;
        for (const cell of row.cells) {
          if (cell.invisible || !cell.text) continue;
          if (cellBlinkHidden(cell.blink)) continue;
          const font = this.fontForCell(cell);
          const draw = (column: number, text: string, width: number) => {
            if (!text || isSpaceOnly(text)) return true;
            const record = atlas.get(text, width, font);
            if (!record) return false;
            const colors = this.cellColors(cell)[0];
            const alpha =
              (colors[3] / 255) * (cell.intensity === "half" ? 0.5 : 1);
            this.pushGlyph(
              column * this.cellWidth,
              rowOffset * this.cellHeight,
              this.cellWidth * width,
              this.cellHeight,
              record,
              colors[0] / 255,
              colors[1] / 255,
              colors[2] / 255,
              alpha,
            );
            return true;
          };
          let failed = false;
          forEachCellCluster(cell, (column, text, clusterWidth) => {
            if (!failed && !draw(column, text, clusterWidth)) failed = true;
          });
          if (failed) {
            if (atlas.wasResetDuringPass()) {
              restart = true;
              break rowLoop;
            }
            return false;
          }
        }
      }
      if (!restart) break;
      if (attempt === 1) return false;
    }
    if (this.glyphVertexCount === 0) return true;
    const { width, height } = this.drawingBufferSize();
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.glyphVertexData.subarray(0, this.glyphVertexCount),
      gl.STREAM_DRAW,
    );
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
    gl.drawArrays(gl.TRIANGLES, 0, this.glyphVertexCount / 9);
    return true;
  }

  /** Grow `this.solidVertexData` (preserving its used prefix) if the next
   * write would overflow it. Geometric growth keeps this amortized O(1). */
  private reserveSolid(extraFloats: number) {
    const needed = this.solidVertexCount + extraFloats;
    if (needed <= this.solidVertexData.length) return;
    let size = this.solidVertexData.length || 512;
    while (size < needed) size *= 2;
    const grown = new Float32Array(size);
    grown.set(this.solidVertexData.subarray(0, this.solidVertexCount));
    this.solidVertexData = grown;
  }

  private reserveGlyph(extraFloats: number) {
    const needed = this.glyphVertexCount + extraFloats;
    if (needed <= this.glyphVertexData.length) return;
    let size = this.glyphVertexData.length || 512;
    while (size < needed) size *= 2;
    const grown = new Float32Array(size);
    grown.set(this.glyphVertexData.subarray(0, this.glyphVertexCount));
    this.glyphVertexData = grown;
  }

  private pushRect(x: number, y: number, width: number, color: Rgba) {
    this.reserveSolid(36);
    const left = x * this.dpr;
    const top = y * this.dpr;
    const right = (x + width) * this.dpr;
    const bottom = (y + this.cellHeight) * this.dpr;
    const red = color[0] / 255;
    const green = color[1] / 255;
    const blue = color[2] / 255;
    const alpha = color[3] / 255;
    const data = this.solidVertexData;
    let i = this.solidVertexCount;
    data[i++] = left;
    data[i++] = top;
    data[i++] = red;
    data[i++] = green;
    data[i++] = blue;
    data[i++] = alpha;
    data[i++] = right;
    data[i++] = top;
    data[i++] = red;
    data[i++] = green;
    data[i++] = blue;
    data[i++] = alpha;
    data[i++] = left;
    data[i++] = bottom;
    data[i++] = red;
    data[i++] = green;
    data[i++] = blue;
    data[i++] = alpha;
    data[i++] = left;
    data[i++] = bottom;
    data[i++] = red;
    data[i++] = green;
    data[i++] = blue;
    data[i++] = alpha;
    data[i++] = right;
    data[i++] = top;
    data[i++] = red;
    data[i++] = green;
    data[i++] = blue;
    data[i++] = alpha;
    data[i++] = right;
    data[i++] = bottom;
    data[i++] = red;
    data[i++] = green;
    data[i++] = blue;
    data[i++] = alpha;
    this.solidVertexCount = i;
  }

  private pushGlyph(
    x: number,
    y: number,
    width: number,
    height: number,
    record: GlyphRecord,
    red: number,
    green: number,
    blue: number,
    alpha: number,
  ) {
    this.reserveGlyph(54);
    const padding = record.padding / this.dpr;
    const left = (x - padding) * this.dpr;
    const top = (y - padding) * this.dpr;
    const right = (x + width + padding) * this.dpr;
    const bottom = (y + height + padding) * this.dpr;
    const { u0, v0, u1, v1 } = record;
    const colorGlyph = record.color ? 1 : 0;
    const data = this.glyphVertexData;
    let i = this.glyphVertexCount;
    const write = (px: number, py: number, u: number, v: number) => {
      data[i++] = px;
      data[i++] = py;
      data[i++] = u;
      data[i++] = v;
      data[i++] = red;
      data[i++] = green;
      data[i++] = blue;
      data[i++] = alpha;
      data[i++] = colorGlyph;
    };
    write(left, top, u0, v0);
    write(right, top, u1, v0);
    write(left, bottom, u0, v1);
    write(left, bottom, u0, v1);
    write(right, top, u1, v0);
    write(right, bottom, u1, v1);
    this.glyphVertexCount = i;
  }

  private colorFor(
    color: RenderColor | undefined,
    defaultColor: "foreground" | "background",
  ): Rgba {
    // An absent color means the backend omitted a `{"kind":"default"}` value
    // - see the `TerminalRenderCell` doc comment in @/lib/terminalFrames.
    if (!color || color.kind === "default") {
      return this.cachedParseColor(this.theme[defaultColor]);
    }
    if (color.kind === "rgba") return color.value;
    const key = ANSI_THEME_KEYS[color.value];
    const themed = key ? this.theme[key] : undefined;
    const rgb = themed
      ? this.cachedParseColor(themed)
      : ansi256ToRgb(color.value);
    return [rgb[0], rgb[1], rgb[2], 255];
  }

  private cachedParseColor(value: string): Rgba {
    const cached = this.colorParseCache.get(value);
    if (cached) return cached;
    const parsed = parseColor(value);
    this.colorParseCache.set(value, parsed);
    return parsed;
  }

  private cachedEnsureContrast(
    foreground: Rgba,
    background: Rgba,
    minimumContrast: number | undefined,
  ): Rgba {
    const key = `${foreground.join(",")}|${background.join(",")}|${minimumContrast ?? ""}`;
    const cached = this.contrastCache.get(key);
    if (cached) return cached;
    const result = ensureContrast(foreground, background, minimumContrast);
    this.contrastCache.set(key, result);
    return result;
  }

  private clearColorCache() {
    this.colorParseCache.clear();
    this.contrastCache.clear();
  }

  private cellColors(cell: TerminalRenderCell): [Rgba, Rgba] {
    let foreground = this.colorFor(cell.foreground, "foreground");
    let background = this.colorFor(cell.background, "background");
    if (cell.reverse) [foreground, background] = [background, foreground];
    foreground = this.cachedEnsureContrast(
      foreground,
      background,
      this.theme.minimumContrast,
    );
    return [foreground, background];
  }

  private fontForCell(cell: TerminalRenderCell) {
    if (cell.italic) {
      return cell.intensity === "bold" ? this.fontBoldItalic : this.fontItalic;
    }
    return cell.intensity === "bold" ? this.fontBold : this.fontNormal;
  }
}

export type TerminalRendererPreference = "auto" | "webgl" | "dom";

export function createTerminalRenderer(
  preference: TerminalRendererPreference,
): TerminalRenderer {
  return preference === "dom" ? new CanvasRenderer() : new WebGLRenderer();
}
