import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("paints the configured background before the first terminal frame", () => {
    const renderer = new WebGLRenderer();
    const canvas = document.createElement("canvas");
    const gl = configureGpu(renderer, canvas);
    renderer.resize(80, 34, 2, 4);
    vi.mocked(gl.viewport).mockClear();

    renderer.setTheme({ background: "#fafafa", foreground: "#111111" });

    expect(gl.viewport).toHaveBeenCalledWith(0, 0, 80, 34);
    expect(gl.uniform2f).toHaveBeenCalledWith(expect.anything(), 80, 34);
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
});

const callbacks = new Map<number, FrameRequestCallback>();
let nextFrameId = 0;

function configureGrid(renderer: WebGLRenderer) {
  const internals = renderer as unknown as {
    rows: number;
    cols: number;
  };
  internals.rows = 2;
  internals.cols = 4;
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

  return gl as WebGL2RenderingContext & {
    viewport: ReturnType<typeof vi.fn>;
    bufferData: ReturnType<typeof vi.fn>;
    uniform2f: ReturnType<typeof vi.fn>;
  };
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
