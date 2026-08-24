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
