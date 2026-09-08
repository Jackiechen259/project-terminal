import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  TerminalRenderCell,
  TerminalRenderFrame,
  TerminalRenderRow,
} from "@/lib/terminalFrames";

import { WebGLRenderer } from "./WebGLRenderer";

function row(stableRow: number): TerminalRenderRow {
  return { stableRow, cells: [] };
}

function frame(
  sequence: number,
  viewportTop: number,
  dirtyRows: TerminalRenderRow[],
  fullSnapshot = false,
): TerminalRenderFrame {
  return {
    sequence,
    rows: 2,
    cols: 4,
    dirtyRows,
    cursor: {
      column: 0,
      row: 0,
      shape: "default",
      visibility: "hidden",
    },
    scrollbackLength: 20,
    viewportTop,
    viewportBottom: 120,
    alternateScreen: false,
    mouseReporting: false,
    fullSnapshot,
  };
}

describe("WebGLRenderer stable-row cache", () => {
  beforeEach(() => {
    callbacks.clear();
    nextFrameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = ++nextFrameId;
      callbacks.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      callbacks.delete(id);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("retains the GPU cache across a viewport shift and uses Canvas fallback", () => {
    const renderer = new WebGLRenderer();
    configureGrid(renderer);

    renderer.render(frame(1, 100, [row(100), row(101)], true));
    flushPrimaryFrame();

    renderer.render(frame(2, 101, [row(102)]));
    flushPrimaryFrame();

    const cache = (
      renderer as unknown as { rowCache: Map<number, TerminalRenderRow> }
    ).rowCache;
    expect([101, 102].every((stableRow) => cache.has(stableRow))).toBe(true);
    expect((renderer as unknown as { gpuFallback: boolean }).gpuFallback).toBe(
      true,
    );
    renderer.dispose();
  });

  it("does not lose pending dirty rows when the viewport changes before paint", () => {
    const renderer = new WebGLRenderer();
    configureGrid(renderer);
    renderer.render(frame(1, 100, [row(100), row(101)], true));
    flushPrimaryFrame();

    renderer.render(frame(10, 100, [row(101)]));
    renderer.render(frame(11, 101, [row(102)]));
    flushPrimaryFrame();

    const cache = (
      renderer as unknown as { rowCache: Map<number, TerminalRenderRow> }
    ).rowCache;
    expect(cache.has(101)).toBe(true);
    expect(cache.has(102)).toBe(true);
    renderer.dispose();
  });

  it("paints authoritative frames without waiting for animation frame batching", () => {
    const renderer = new WebGLRenderer();
    configureGrid(renderer);
    configureGpu(renderer, document.createElement("canvas"));

    const snapshot = frame(1, 0, [row(0)], true);
    renderer.renderImmediate(snapshot);

    expect(callbacks.size).toBe(0);
    expect(
      (renderer as unknown as { frame: TerminalRenderFrame | null }).frame,
    ).toBe(snapshot);
    renderer.dispose();
  });

  it("consumes hidden frames without scheduling GPU paints", () => {
    const renderer = new WebGLRenderer();
    const canvas = document.createElement("canvas");
    configureGrid(renderer);
    configureGpu(renderer, canvas);
    callbacks.clear();
    renderer.setVisible(false);

    renderer.render(frame(1, 0, [row(0)], true));
    renderer.render(frame(2, 0, [row(1)]));

    expect(callbacks.size).toBe(0);
    expect(
      (renderer as unknown as { frame: TerminalRenderFrame | null }).frame
        ?.sequence,
    ).toBe(2);

    renderer.setVisible(true);
    renderer.redraw();
    expect(callbacks.size).toBe(0);
    renderer.dispose();
  });

  it("retains the previous frame through a grid resize", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: vi.fn(() => ({
        width: 16,
        actualBoundingBoxAscent: 10,
        actualBoundingBoxDescent: 3,
      })),
    } as unknown as CanvasRenderingContext2D);
    const renderer = new WebGLRenderer();
    const canvas = document.createElement("canvas");
    configureGrid(renderer);
    configureGpu(renderer, canvas);

    const previous = frame(1, 0, [row(0)], true);
    renderer.renderImmediate(previous);
    renderer.resize(96, 51, 3, 4);

    expect(
      (renderer as unknown as { frame: TerminalRenderFrame | null }).frame,
    ).toBe(previous);
    renderer.dispose();
  });

  it("returns false from render/renderImmediate when the frame is rejected", () => {
    const renderer = new WebGLRenderer();
    configureGrid(renderer);
    configureGpu(renderer, document.createElement("canvas"));
    renderer.renderImmediate(frame(1, 0, [row(0)], true));

    // A grid mismatch against what the renderer was configured for is
    // rejected outright, whether or not the frame claims to be a full
    // snapshot.
    const mismatched = { ...frame(2, 0, [row(0)], false), cols: 5 };
    expect(renderer.render(mismatched)).toBe(false);
    expect(renderer.renderImmediate(mismatched)).toBe(false);
    renderer.dispose();
  });
});

describe("WebGLRenderer surface initialization", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: vi.fn(() => ({
        width: 16,
        actualBoundingBoxAscent: 10,
        actualBoundingBoxDescent: 3,
      })),
    } as unknown as CanvasRenderingContext2D);
    callbacks.clear();
    nextFrameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = ++nextFrameId;
      callbacks.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      callbacks.delete(id);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("paints the configured background before the first terminal frame", () => {
    const renderer = new WebGLRenderer();
    const canvas = document.createElement("canvas");
    const gl = configureGpu(renderer, canvas);
    renderer.resize(80, 34, 2, 4);
    vi.mocked(gl.viewport).mockClear();

    // setTheme() coalesces its repaint to the next animation frame instead
    // of painting synchronously (the same batching render()/setSelection()/
    // setSearchMatch() already use), so the background draw is not visible
    // until that frame is flushed.
    renderer.setTheme({ background: "#fafafa", foreground: "#111111" });
    flushPrimaryFrame();

    expect(gl.viewport).toHaveBeenCalledWith(0, 0, 80, 34);
    expect(gl.uniform2f).toHaveBeenCalledWith(expect.anything(), 80, 34);
    renderer.dispose();
  });

  it("paints a sparse cell (every optional field omitted) without producing NaN vertex data", () => {
    // The backend omits every field carrying its default value (see the
    // `TerminalRenderCell` doc comment in @/lib/terminalFrames) - a plain
    // cell arrives as just `{column, text}`. `reverse: true` here forces the
    // cell into the background-quad pass (otherwise a default-background
    // cell is skipped entirely) so `pushRect`'s `Math.max(1, cell.width ?? 1)`
    // is actually exercised - `Math.max(1, undefined)` would be NaN.
    const renderer = new WebGLRenderer();
    const canvas = document.createElement("canvas");
    const gl = configureGpu(renderer, canvas);
    renderer.resize(80, 34, 2, 4);
    gl.bufferData.mockClear();

    const sparseRow: TerminalRenderRow = {
      stableRow: 0,
      cells: [{ column: 0, text: "x", reverse: true } as TerminalRenderCell],
    };
    renderer.render(frame(1, 0, [sparseRow], true));
    flushPrimaryFrame();

    const backgroundCall = gl.bufferData.mock.calls.find(
      (call) => (call[1] as Float32Array)?.length > 12,
    );
    expect(backgroundCall).toBeDefined();
    const vertices = Array.from(backgroundCall?.[1] as Float32Array);
    expect(vertices.some((value) => Number.isNaN(value))).toBe(false);
    renderer.dispose();
  });

  it("draws a compacted ASCII run as per-column atlas glyphs", () => {
    const renderer = new WebGLRenderer();
    const canvas = document.createElement("canvas");
    configureGpu(renderer, canvas);
    const atlas = configureAtlas(renderer);
    configureGrid(renderer);
    renderer.resize(80, 34, 2, 8);

    const compactedRow: TerminalRenderRow = {
      stableRow: 0,
      cells: [{ column: 0, text: "hello", width: 5 }],
    };
    renderer.render({ ...frame(1, 0, [compactedRow], true), cols: 8 });
    flushPrimaryFrame();

    expect(
      atlas.get.mock.calls.map((call) => [call[0], call[1]] as const),
    ).toEqual([
      ["h", 1],
      ["e", 1],
      ["l", 1],
      ["l", 1],
      ["o", 1],
    ]);
    renderer.dispose();
  });

  it("does not enter Canvas fallback after the atlas recycles mid-pass", () => {
    const renderer = new WebGLRenderer();
    const canvas = document.createElement("canvas");
    configureGpu(renderer, canvas);
    const atlas = configureAtlas(renderer);
    configureGrid(renderer);
    renderer.resize(80, 34, 2, 8);

    const record = {
      u0: 0,
      v0: 0,
      u1: 1,
      v1: 1,
      padding: 2,
      color: false,
    };
    let pass = 0;
    atlas.beginPass.mockImplementation(() => {
      pass += 1;
    });
    atlas.get.mockImplementation(() => (pass === 1 ? null : record));
    atlas.wasResetDuringPass.mockImplementation(() => pass === 1);

    const compactedRow: TerminalRenderRow = {
      stableRow: 0,
      cells: [{ column: 0, text: "ab", width: 2 }],
    };
    renderer.render({ ...frame(1, 0, [compactedRow], true), cols: 8 });
    flushPrimaryFrame();

    expect((renderer as unknown as { gpuFallback: boolean }).gpuFallback).toBe(
      false,
    );
    expect(pass).toBe(2);
    renderer.dispose();
  });

  it("does not schedule a GPU paint when the selection changes", () => {
    const renderer = new WebGLRenderer();
    const canvas = document.createElement("canvas");
    configureGpu(renderer, canvas);
    configureAtlas(renderer);
    configureGrid(renderer);
    renderer.resize(80, 34, 2, 4);

    renderer.renderImmediate(frame(1, 0, [row(0)], true));
    callbacks.clear();

    renderer.setSelection({
      anchor: { stableRow: 0, column: 0 },
      focus: { stableRow: 0, column: 2 },
    });

    expect(
      (renderer as unknown as { frameRequest: number | null }).frameRequest,
    ).toBeNull();
    renderer.dispose();
  });

  it("uses the complete fractional-DPR drawing buffer for the background", () => {
    const renderer = new WebGLRenderer();
    const canvas = document.createElement("canvas");
    const gl = configureGpu(renderer, canvas);
    const previousDpr = window.devicePixelRatio;
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 1.25,
    });

    try {
      renderer.resize(801, 100, 2, 4);

      expect(canvas.width).toBe(1002);
      expect(canvas.height).toBe(125);
      expect(gl.viewport).toHaveBeenLastCalledWith(0, 0, 1002, 125);
      expect(gl.uniform2f).toHaveBeenLastCalledWith(
        expect.anything(),
        1002,
        125,
      );
      const vertices = gl.bufferData.mock.calls.at(-1)?.[1] as Float32Array;
      expect(Array.from(vertices)).toEqual([
        0, 0, 1002, 0, 0, 125, 0, 125, 1002, 0, 1002, 125,
      ]);
    } finally {
      Object.defineProperty(window, "devicePixelRatio", {
        configurable: true,
        value: previousDpr,
      });
      renderer.dispose();
    }
  });

  it("redraw() repaints the overlay incrementally instead of a full redraw each call", () => {
    const renderer = new WebGLRenderer();
    const canvas = document.createElement("canvas");
    configureGpu(renderer, canvas);
    configureAtlas(renderer);
    configureGrid(renderer);
    renderer.resize(80, 34, 2, 4);

    const canvasRenderer = (
      renderer as unknown as {
        canvasRenderer: { paintOverlayPending: () => void; redraw: () => void };
      }
    ).canvasRenderer;
    const paintOverlaySpy = vi.spyOn(canvasRenderer, "paintOverlayPending");
    const fullRedrawSpy = vi.spyOn(canvasRenderer, "redraw");

    renderer.renderImmediate(frame(1, 0, [row(0)], true));
    paintOverlaySpy.mockClear();
    fullRedrawSpy.mockClear();

    // Tab activation, a cell-blink tick, and a resize-triggered redraw can
    // all call this back to back - none of them should force the overlay
    // through a full wipe-and-repaint (which would stack the cursor's alpha
    // right back in, defeating CanvasRenderer's own dedup).
    renderer.redraw();
    renderer.redraw();
    renderer.redraw();

    expect(paintOverlaySpy).toHaveBeenCalledTimes(3);
    expect(fullRedrawSpy).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it("forces a full overlay redraw only when the backing store actually resizes", () => {
    const renderer = new WebGLRenderer();
    const canvas = document.createElement("canvas");
    configureGpu(renderer, canvas);
    configureAtlas(renderer);
    configureGrid(renderer);

    // A minimal stand-in for the overlay canvas - only `width`/`height` (set
    // by `syncOverlayBackingStore`) and `remove` (called by `dispose`)
    // matter here.
    const overlay = { width: 0, height: 0, remove: vi.fn() } as unknown as
      HTMLCanvasElement;
    (renderer as unknown as { overlay: HTMLCanvasElement }).overlay = overlay;
    const canvasRenderer = (
      renderer as unknown as { canvasRenderer: { redraw: () => void } }
    ).canvasRenderer;
    const redrawSpy = vi.spyOn(canvasRenderer, "redraw");

    renderer.resize(80, 34, 2, 4);
    // Assigning `width`/`height` on a real canvas clears its bitmap, so the
    // overlay's cursor tracking must be told to repaint from scratch - but
    // only on the resize that actually changed the backing store.
    expect(overlay.width).toBe(canvas.width);
    expect(redrawSpy).toHaveBeenCalledTimes(1);

    redrawSpy.mockClear();
    renderer.resize(80, 34, 2, 4);
    expect(redrawSpy).not.toHaveBeenCalled();

    renderer.dispose();
  });
});

const callbacks = new Map<number, FrameRequestCallback>();
let nextFrameId = 0;

function configureGrid(renderer: WebGLRenderer) {
  const internals = renderer as unknown as {
    rows: number;
    cols: number;
    canvasRenderer: { rows: number; cols: number };
  };
  internals.rows = 2;
  internals.cols = 4;
  // The overlay CanvasRenderer keeps its own independent rows/cols (set via
  // its own resize(), normally called from WebGLRenderer.resize()). Frame
  // acceptance in fallback mode now routes entirely through it, so it needs
  // the same grid the test frames describe, not its class-field defaults.
  internals.canvasRenderer.rows = 2;
  internals.canvasRenderer.cols = 4;
}

function configureGpu(renderer: WebGLRenderer, canvas: HTMLCanvasElement) {
  const gl = {
    ARRAY_BUFFER: 0x8892,
    STREAM_DRAW: 0x88e0,
    FLOAT: 0x1406,
    TRIANGLES: 0x0004,
    viewport: vi.fn(),
    useProgram: vi.fn(),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    disableVertexAttribArray: vi.fn(),
    vertexAttrib4f: vi.fn(),
    uniform2f: vi.fn(),
    uniform1i: vi.fn(),
    activeTexture: vi.fn(),
    bindTexture: vi.fn(),
    drawArrays: vi.fn(),
    deleteBuffer: vi.fn(),
    deleteProgram: vi.fn(),
  } as unknown as WebGL2RenderingContext;
  Object.defineProperties(gl, {
    drawingBufferWidth: {
      configurable: true,
      get: () => canvas.width,
    },
    drawingBufferHeight: {
      configurable: true,
      get: () => canvas.height,
    },
  });

  const internals = renderer as unknown as Record<string, unknown>;
  internals.canvas = canvas;
  internals.gl = gl;
  internals.solidProgram = {};
  internals.solidBuffer = {};
  internals.solidPositionLocation = 0;
  internals.solidColorLocation = 1;
  internals.solidResolutionLocation = {};
  internals.glyphProgram = {};
  internals.glyphBuffer = {};
  internals.glyphPositionLocation = 0;
  internals.glyphTexCoordLocation = 1;
  internals.glyphColorLocation = 2;
  internals.glyphColorGlyphLocation = 3;
  internals.glyphResolutionLocation = {};
  internals.glyphAtlasLocation = {};

  return gl as WebGL2RenderingContext & {
    viewport: ReturnType<typeof vi.fn>;
    bufferData: ReturnType<typeof vi.fn>;
    uniform2f: ReturnType<typeof vi.fn>;
  };
}

function configureAtlas(renderer: WebGLRenderer) {
  const record = {
    u0: 0,
    v0: 0,
    u1: 1,
    v1: 1,
    padding: 2,
    color: false,
  };
  const atlas = {
    configure: vi.fn(),
    beginPass: vi.fn(),
    wasResetDuringPass: vi.fn(() => false),
    getTexture: vi.fn(() => ({})),
    dispose: vi.fn(),
    get: vi.fn((_text: string, _cols: number): typeof record | null => record),
  };
  (renderer as unknown as { atlas: typeof atlas }).atlas = atlas;
  return atlas;
}

function flushPrimaryFrame() {
  const [id, callback] = [...callbacks.entries()][0] ?? [];
  if (typeof id !== "number" || !callback) {
    throw new Error("expected a WebGL animation frame");
  }
  callbacks.delete(id);
  callback(16);
  // The fallback CanvasRenderer schedules its own overlay paint. The cache
  // assertions above concern the WebGL frame and do not need that second tick.
  callbacks.clear();
}
