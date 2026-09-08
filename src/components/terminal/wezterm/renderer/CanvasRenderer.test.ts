import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  RenderColor,
  TerminalRenderCell,
  TerminalRenderFrame,
  TerminalRenderRow,
} from "@/lib/terminalFrames";

import { CanvasRenderer, cellBlinkHidden } from "./CanvasRenderer";

function defaultColor(): RenderColor {
  return { kind: "default" };
}

function cell(column: number, text: string): TerminalRenderCell {
  return {
    column,
    width: 1,
    text,
    foreground: defaultColor(),
    background: defaultColor(),
    underlineColor: defaultColor(),
    intensity: "normal",
    underline: "none",
    italic: false,
    reverse: false,
    strikethrough: false,
    invisible: false,
    hyperlink: null,
    images: [],
  };
}

function row(stableRow: number, text: string): TerminalRenderRow {
  return {
    stableRow,
    cells: [...text].map((value, column) => cell(column, value)),
  };
}

/**
 * The backend omits every field carrying its default value (see the
 * `TerminalRenderCell` doc comment in @/lib/terminalFrames) - a plain cell
 * arrives as just `{column, text}`, not the fully-populated shape `cell()`
 * above builds for readability.
 */
function sparseCell(column: number, text: string): TerminalRenderCell {
  return { column, text } as TerminalRenderCell;
}

function sparseRow(stableRow: number, text: string): TerminalRenderRow {
  return {
    stableRow,
    cells: [...text].map((value, column) => sparseCell(column, value)),
  };
}

function frame(
  dirtyRows: TerminalRenderRow[],
  fullSnapshot = false,
  overrides: Partial<
    Pick<
      TerminalRenderFrame,
      "sequence" | "rows" | "cols" | "viewportTop" | "viewportBottom"
    >
  > = {},
): TerminalRenderFrame {
  return {
    sequence: overrides.sequence ?? (fullSnapshot ? 1 : 2),
    rows: overrides.rows ?? 2,
    cols: overrides.cols ?? 4,
    dirtyRows,
    cursor: {
      column: 0,
      row: 0,
      shape: "default",
      visibility: "hidden",
    },
    scrollbackLength: 0,
    viewportTop: overrides.viewportTop ?? 0,
    viewportBottom: overrides.viewportBottom ?? 0,
    alternateScreen: false,
    mouseReporting: false,
    fullSnapshot,
  };
}

describe("cellBlinkHidden", () => {
  it("toggles slow and rapid blink from the clock", () => {
    expect(cellBlinkHidden("slow", 0)).toBe(false);
    expect(cellBlinkHidden("slow", 500)).toBe(true);
    expect(cellBlinkHidden("rapid", 0)).toBe(false);
    expect(cellBlinkHidden("rapid", 200)).toBe(true);
    expect(cellBlinkHidden(undefined, 500)).toBe(false);
    expect(cellBlinkHidden("none", 500)).toBe(false);
  });
});

describe("CanvasRenderer", () => {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrameId = 0;
  const intervalCallbacks = new Map<number, () => void>();
  let nextIntervalId = 0;
  let context: {
    fillText: ReturnType<typeof vi.fn>;
    measureText: ReturnType<typeof vi.fn>;
    fillRect: ReturnType<typeof vi.fn>;
    clearRect: ReturnType<typeof vi.fn>;
    strokeRect: ReturnType<typeof vi.fn>;
  };

  /** Fire every pending `setInterval` callback (the cursor-blink tick). */
  function tickIntervals() {
    for (const callback of [...intervalCallbacks.values()]) callback();
  }

  beforeEach(() => {
    callbacks.clear();
    nextFrameId = 0;
    intervalCallbacks.clear();
    nextIntervalId = 0;
    context = {
      fillText: vi.fn(),
      measureText: vi.fn(() => ({
        width: 16,
        actualBoundingBoxAscent: 10,
        actualBoundingBoxDescent: 3,
      })),
      fillRect: vi.fn(),
      clearRect: vi.fn(),
      strokeRect: vi.fn(),
    };
    const canvasContext = {
      ...context,
      save: vi.fn(),
      restore: vi.fn(),
      setTransform: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      stroke: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      canvasContext,
    );
    vi.spyOn(
      HTMLCanvasElement.prototype,
      "getBoundingClientRect",
    ).mockReturnValue(new DOMRect(0, 0, 80, 34));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = ++nextFrameId;
      callbacks.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      callbacks.delete(id);
    });
    // A deterministic stand-in for the cursor-blink interval, in the same
    // manual-stub style as the requestAnimationFrame mock above (rather than
    // vi's global fake-timer engine, which would also swallow the
    // `performance.now()` spies other tests in this file rely on).
    vi.stubGlobal("setInterval", (callback: () => void) => {
      const id = ++nextIntervalId;
      intervalCallbacks.set(id, callback);
      return id;
    });
    vi.stubGlobal("clearInterval", (id: number) => {
      intervalCallbacks.delete(id);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("coalesces multiple model frames and paints only the latest dirty rows", () => {
    const renderer = new CanvasRenderer();
    const canvas = document.createElement("canvas");
    renderer.mount(canvas);
    renderer.resize(80, 34, 2, 4);

    renderer.render(frame([row(0, "old "), row(1, "line")], true));
    renderer.render(frame([row(1, "new ")]));
    expect(context.fillText).not.toHaveBeenCalled();
    expect(callbacks.size).toBe(1);

    const [id, callback] = [...callbacks.entries()][0];
    callbacks.delete(id);
    callback(16);

    expect(context.fillText.mock.calls.map(([text]) => text)).toEqual(
      expect.arrayContaining(["n", "e", "w"]),
    );
    renderer.dispose();
  });

  it("hides SGR-blink text during the off phase", () => {
    vi.spyOn(performance, "now").mockReturnValue(500);
    const renderer = new CanvasRenderer();
    const canvas = document.createElement("canvas");
    renderer.mount(canvas);
    renderer.resize(80, 34, 2, 4);

    const blinking = { ...cell(0, "X"), blink: "slow" as const };
    renderer.renderImmediate(
      frame([{ stableRow: 0, cells: [blinking, cell(1, "Y")] }], true),
    );

    expect(context.fillText.mock.calls.map(([text]) => text)).toEqual(["Y"]);
    renderer.dispose();
  });

  it("paints an authoritative frame synchronously", () => {
    const renderer = new CanvasRenderer();
    const canvas = document.createElement("canvas");
    renderer.mount(canvas);
    renderer.resize(80, 34, 2, 4);

    renderer.renderImmediate(frame([row(0, "now")], true));

    expect(callbacks.size).toBe(0);
    expect(context.fillText).toHaveBeenCalled();
    renderer.dispose();
  });

  it("consumes hidden frames without painting and redraws the latest cache on resume", () => {
    const renderer = new CanvasRenderer();
    const canvas = document.createElement("canvas");
    renderer.mount(canvas);
    renderer.resize(80, 34, 2, 4);
    renderer.setVisible(false);

    renderer.renderImmediate(frame([row(0, "10%")], true, { sequence: 1 }));
    renderer.render(frame([row(0, "20%")], false, { sequence: 2 }));
    renderer.render(frame([row(0, "30%")], false, { sequence: 3 }));
    renderer.render(frame([row(0, "50%")], false, { sequence: 4 }));

    expect(callbacks.size).toBe(0);
    expect(
      (renderer as unknown as { frame: TerminalRenderFrame | null }).frame
        ?.sequence,
    ).toBe(4);
    expect(
      (
        renderer as unknown as { rowCache: Map<number, TerminalRenderRow> }
      ).rowCache.get(0)?.cells[0]?.text,
    ).toBe("5");
    expect(context.fillText).not.toHaveBeenCalled();

    renderer.setVisible(true);
    renderer.redraw();

    expect(context.fillText.mock.calls.map(([text]) => text)).toContain("5");
    renderer.dispose();
  });

  it("repaints cursor-only updates even when no rows are dirty", () => {
    const renderer = new CanvasRenderer();
    const canvas = document.createElement("canvas");
    renderer.mount(canvas);
    renderer.resize(80, 34, 2, 4);

    const initial = frame([row(0, "text")], true, { sequence: 1 });
    initial.cursor = {
      ...initial.cursor,
      column: 0,
      visibility: "visible",
    };
    renderer.renderImmediate(initial);
    context.fillRect.mockClear();

    const cursorOnly = frame([], false, { sequence: 2 });
    cursorOnly.cursor = {
      ...cursorOnly.cursor,
      column: 1,
      visibility: "visible",
    };
    renderer.render(cursorOnly);

    expect(callbacks.size).toBe(1);
    const [id, callback] = [...callbacks.entries()][0];
    callbacks.delete(id);
    callback(16);

    expect(context.fillRect).toHaveBeenCalled();
    renderer.dispose();
  });

  it("keeps the last frame visible while the grid waits for a snapshot", () => {
    const renderer = new CanvasRenderer();
    const canvas = document.createElement("canvas");
    renderer.mount(canvas);
    renderer.resize(80, 34, 2, 4);
    const previous = frame([row(0, "old")], true);
    renderer.renderImmediate(previous);
    context.fillText.mockClear();

    renderer.resize(96, 51, 3, 4);

    expect(
      (renderer as unknown as { frame: TerminalRenderFrame | null }).frame,
    ).toBe(previous);
    expect(context.fillText).toHaveBeenCalled();

    const next = frame([row(0, "new")], true, {
      sequence: 2,
      rows: 3,
      cols: 4,
    });
    renderer.renderImmediate(next);
    expect(
      (renderer as unknown as { frame: TerminalRenderFrame | null }).frame,
    ).toBe(next);
    renderer.dispose();
  });

  it("retains overlapping stable rows when the viewport scrolls", () => {
    const renderer = new CanvasRenderer();
    const canvas = document.createElement("canvas");
    renderer.mount(canvas);
    renderer.resize(80, 68, 4, 4);
    renderer.render(
      frame(
        [row(100, "AAA"), row(101, "BBB"), row(102, "CCC"), row(103, "DDD")],
        true,
        {
          sequence: 1,
          rows: 4,
          cols: 4,
          viewportTop: 100,
          viewportBottom: 120,
        },
      ),
    );
    const [, initialPaint] = [...callbacks.entries()][0];
    callbacks.clear();
    initialPaint(16);
    context.fillText.mockClear();

    renderer.render(
      frame([row(104, "EEE")], false, {
        sequence: 2,
        rows: 4,
        cols: 4,
        viewportTop: 101,
        viewportBottom: 120,
      }),
    );
    const [, scrollPaint] = [...callbacks.entries()][0];
    callbacks.clear();
    scrollPaint(32);

    expect(context.fillText.mock.calls.map(([text]) => text)).toEqual(
      expect.arrayContaining(["B", "C", "D", "E"]),
    );
    renderer.dispose();
  });

  it("keeps both dirty rows when coalescing a pending viewport shift", () => {
    const renderer = new CanvasRenderer();
    const canvas = document.createElement("canvas");
    renderer.mount(canvas);
    renderer.resize(80, 68, 4, 4);
    renderer.render(
      frame(
        [row(100, "AAA"), row(101, "BBB"), row(102, "CCC"), row(103, "DDD")],
        true,
        {
          sequence: 1,
          rows: 4,
          cols: 4,
          viewportTop: 100,
          viewportBottom: 120,
        },
      ),
    );
    const [, initialPaint] = [...callbacks.entries()][0];
    callbacks.clear();
    initialPaint(16);
    context.fillText.mockClear();

    renderer.render(
      frame([row(102, "changed-A")], false, {
        sequence: 10,
        rows: 4,
        cols: 4,
        viewportTop: 100,
        viewportBottom: 120,
      }),
    );
    renderer.render(
      frame([row(104, "changed-B")], false, {
        sequence: 11,
        rows: 4,
        cols: 4,
        viewportTop: 101,
        viewportBottom: 120,
      }),
    );
    const [, mergedPaint] = [...callbacks.entries()][0];
    callbacks.clear();
    mergedPaint(32);

    expect(context.fillText.mock.calls.map(([text]) => text)).toEqual(
      expect.arrayContaining(["A", "B"]),
    );
    renderer.dispose();
  });

  it("uses the latest stable-row update when two pending frames overlap", () => {
    const renderer = new CanvasRenderer();
    const canvas = document.createElement("canvas");
    renderer.mount(canvas);
    renderer.resize(80, 34, 2, 4);
    renderer.render(
      frame([row(0, "old"), row(1, "line")], true, {
        sequence: 1,
        viewportTop: 0,
      }),
    );
    const [, initialPaint] = [...callbacks.entries()][0];
    callbacks.clear();
    initialPaint(16);
    context.fillText.mockClear();

    renderer.render(frame([row(1, "A")], false, { sequence: 10 }));
    renderer.render(frame([row(1, "B")], false, { sequence: 11 }));
    const [, mergedPaint] = [...callbacks.entries()][0];
    callbacks.clear();
    mergedPaint(32);

    expect(context.fillText.mock.calls.map(([text]) => text)).toContain("B");
    expect(context.fillText.mock.calls.map(([text]) => text)).not.toContain(
      "A",
    );
    renderer.dispose();
  });

  it("clears stale rows when an authoritative full snapshot arrives", () => {
    const renderer = new CanvasRenderer();
    const canvas = document.createElement("canvas");
    renderer.mount(canvas);
    renderer.resize(80, 34, 2, 4);
    renderer.render(
      frame([row(100, "OLD"), row(101, "KEEP")], true, {
        sequence: 1,
        viewportTop: 100,
        viewportBottom: 120,
      }),
    );
    const [, initialPaint] = [...callbacks.entries()][0];
    callbacks.clear();
    initialPaint(16);

    renderer.render(
      frame([row(101, "FRESH"), row(102, "NEW")], true, {
        sequence: 2,
        viewportTop: 101,
        viewportBottom: 120,
      }),
    );
    const [, snapshotPaint] = [...callbacks.entries()][0];
    callbacks.clear();
    snapshotPaint(32);
    context.fillText.mockClear();

    renderer.render(
      frame([row(103, "DELTA")], false, {
        sequence: 3,
        viewportTop: 100,
        viewportBottom: 120,
      }),
    );
    const [, deltaPaint] = [...callbacks.entries()][0];
    callbacks.clear();
    deltaPaint(48);

    expect(context.fillText.mock.calls.map(([text]) => text)).not.toContain(
      "O",
    );
    renderer.dispose();
  });

  it("keeps selection text in stable row coordinates", () => {
    const renderer = new CanvasRenderer();
    const canvas = document.createElement("canvas");
    renderer.mount(canvas);
    renderer.resize(80, 34, 2, 4);
    renderer.render(frame([row(7, "abcd")], true));

    const [, callback] = [...callbacks.entries()][0];
    callbacks.clear();
    callback(16);

    expect(
      renderer.selectionText(
        { stableRow: 7, column: 1 },
        { stableRow: 7, column: 3 },
      ),
    ).toBe("bc");
    renderer.dispose();
  });

  it("paints a sparse cell (every optional field omitted) as plain, non-underlined text", () => {
    const renderer = new CanvasRenderer();
    const canvas = document.createElement("canvas");
    renderer.mount(canvas);
    renderer.resize(80, 34, 2, 4);
    const canvasContext = (
      renderer as unknown as { context: CanvasRenderingContext2D }
    ).context as unknown as { stroke: ReturnType<typeof vi.fn> };

    renderer.renderImmediate(frame([sparseRow(0, "abc")], true));

    expect(context.fillText.mock.calls.map(([text]) => text)).toEqual(
      expect.arrayContaining(["a", "b", "c"]),
    );
    // Regression: `cell.underline !== "none"` on an omitted (undefined)
    // field would treat every plain cell as underlined.
    expect(canvasContext.stroke).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it("detects plain web links without a separate DOM link layer", () => {
    const renderer = new CanvasRenderer();
    const canvas = document.createElement("canvas");
    renderer.mount(canvas);
    renderer.resize(80, 34, 2, 4);
    renderer.render(frame([row(0, "界 https://example.com!")], true));

    const [, callback] = [...callbacks.entries()][0];
    callbacks.clear();
    callback(16);

    expect(renderer.linkAtPoint(24, 8)).toBe("https://example.com");
    renderer.dispose();
  });

  it("reports the cursor cell rect in CSS pixels for IME caret placement", () => {
    const renderer = new CanvasRenderer();
    const canvas = document.createElement("canvas");
    renderer.mount(canvas);
    renderer.resize(80, 34, 2, 4);

    expect(renderer.cursorRect()).toBeNull();

    const next = frame([row(0, "text")], true);
    next.cursor = {
      ...next.cursor,
      column: 3,
      row: 1,
      visibility: "visible",
    };
    renderer.renderImmediate(next);

    expect(renderer.cursorRect()).toEqual({
      x: 24,
      y: 16.8,
      width: 8,
      height: 16.8,
      visible: true,
    });
    renderer.dispose();
  });

  it("marks the cursor rect not visible when DECTCEM hides it", () => {
    const renderer = new CanvasRenderer();
    const canvas = document.createElement("canvas");
    renderer.mount(canvas);
    renderer.resize(80, 34, 2, 4);

    const next = frame([row(0, "text")], true);
    next.cursor = { ...next.cursor, column: 3, row: 1, visibility: "hidden" };
    renderer.renderImmediate(next);

    expect(renderer.cursorRect()).toEqual({
      x: 24,
      y: 16.8,
      width: 8,
      height: 16.8,
      visible: false,
    });
    renderer.dispose();
  });

  it("returns false from render/renderImmediate when the frame is rejected", () => {
    const renderer = new CanvasRenderer();
    const canvas = document.createElement("canvas");
    renderer.mount(canvas);
    renderer.resize(80, 34, 2, 4);
    renderer.renderImmediate(frame([row(0, "abcd")], true));

    // A grid mismatch against what the renderer was actually sized to is
    // rejected outright (see `applyFrameToRowCache`'s `expectedGridChanged`),
    // whether or not the frame claims to be a full snapshot.
    const mismatched = frame([row(0, "zzzz")], false, {
      sequence: 2,
      cols: 5,
    });
    expect(renderer.render(mismatched)).toBe(false);
    expect(renderer.renderImmediate(mismatched)).toBe(false);
    renderer.dispose();
  });

  describe("cursor overlay", () => {
    /**
     * The initial frame is always a full snapshot carrying both rows'
     * content. A later cursor-only move must be a plain delta (no dirty
     * rows, `fullSnapshot: false`) or `applyFrameToRowCache` would clear the
     * cache and force a full redraw on every call, which would trivially
     * "pass" the erase/dedup assertions below without actually exercising
     * the incremental repaint path they exist to cover.
     */
    function visibleCursorFrame(
      fullSnapshot: boolean,
      overrides: Partial<
        Pick<TerminalRenderFrame, "sequence" | "viewportTop" | "viewportBottom">
      > = {},
      cursor: Partial<TerminalRenderFrame["cursor"]> = {},
    ) {
      const dirtyRows = fullSnapshot
        ? [row(0, "abcd"), row(1, "efgh")]
        : [];
      const built = frame(dirtyRows, fullSnapshot, {
        rows: 2,
        cols: 4,
        ...overrides,
      });
      built.cursor = {
        ...built.cursor,
        row: 0,
        column: 0,
        visibility: "visible",
        ...cursor,
      };
      return built;
    }

    function paintedCursor(renderer: CanvasRenderer) {
      return (
        renderer as unknown as {
          paintedCursor: { stableRow: number; column: number; visible: boolean } | null;
        }
      ).paintedCursor;
    }

    it("starts blinking regardless of whether setCursorBlink or setVisible(true) runs first", () => {
      const first = new CanvasRenderer();
      const canvas1 = document.createElement("canvas");
      first.mount(canvas1);
      first.resize(80, 34, 2, 4);
      first.renderImmediate(visibleCursorFrame(true));
      // Already visible by default; toggling the setting on must itself
      // start the interval.
      first.setCursorBlink(true);
      expect(
        (first as unknown as { cursorBlinkTimer: number | null })
          .cursorBlinkTimer,
      ).not.toBeNull();
      first.dispose();

      const second = new CanvasRenderer();
      const canvas2 = document.createElement("canvas");
      second.mount(canvas2);
      second.resize(80, 34, 2, 4);
      second.setVisible(false);
      // The setting is enabled while hidden - nothing to blink yet.
      second.setCursorBlink(true);
      expect(
        (second as unknown as { cursorBlinkTimer: number | null })
          .cursorBlinkTimer,
      ).toBeNull();
      second.renderImmediate(visibleCursorFrame(true));
      // Becoming visible afterward must still pick it up.
      second.setVisible(true);
      expect(
        (second as unknown as { cursorBlinkTimer: number | null })
          .cursorBlinkTimer,
      ).not.toBeNull();
      second.dispose();
    });

    it("does not blink an unfocused cursor", () => {
      const renderer = new CanvasRenderer();
      const canvas = document.createElement("canvas");
      renderer.mount(canvas);
      renderer.resize(80, 34, 2, 4);
      renderer.setCursorBlink(true);
      renderer.renderImmediate(visibleCursorFrame(true));
      expect(
        (renderer as unknown as { cursorBlinkTimer: number | null })
          .cursorBlinkTimer,
      ).not.toBeNull();

      renderer.setFocused(false);
      expect(
        (renderer as unknown as { cursorBlinkTimer: number | null })
          .cursorBlinkTimer,
      ).toBeNull();
      renderer.dispose();
    });

    it("does not paint an out-of-bounds cursor, and does not throw", () => {
      const renderer = new CanvasRenderer();
      const canvas = document.createElement("canvas");
      renderer.mount(canvas);
      renderer.resize(80, 34, 2, 4);

      expect(() =>
        renderer.renderImmediate(
          visibleCursorFrame(true, {}, { row: 5, column: 0 }),
        ),
      ).not.toThrow();
      expect(paintedCursor(renderer)?.visible).toBe(false);
      renderer.dispose();
    });

    it("resets blink phase to visible when the cursor moves", () => {
      const renderer = new CanvasRenderer();
      const canvas = document.createElement("canvas");
      renderer.mount(canvas);
      renderer.resize(80, 34, 2, 4);
      renderer.setCursorBlink(true);
      renderer.renderImmediate(visibleCursorFrame(true, { sequence: 1 }));

      tickIntervals(); // flips the blink phase off
      expect(paintedCursor(renderer)?.visible).toBe(false);

      renderer.render(
        visibleCursorFrame(false, { sequence: 2 }, { row: 0, column: 1 }),
      );
      const [id, callback] = [...callbacks.entries()][0];
      callbacks.delete(id);
      callback(16);

      expect(paintedCursor(renderer)?.visible).toBe(true);
      renderer.dispose();
    });

    it("noteInputActivity immediately lights up a blinked-off cursor", () => {
      const renderer = new CanvasRenderer();
      const canvas = document.createElement("canvas");
      renderer.mount(canvas);
      renderer.resize(80, 34, 2, 4);
      renderer.setCursorBlink(true);
      renderer.renderImmediate(visibleCursorFrame(true));

      tickIntervals();
      expect(paintedCursor(renderer)?.visible).toBe(false);

      renderer.noteInputActivity();
      expect(paintedCursor(renderer)?.visible).toBe(true);
      renderer.dispose();
    });

    it("a blink tick repaints only the cursor's row", () => {
      const renderer = new CanvasRenderer();
      const canvas = document.createElement("canvas");
      renderer.mount(canvas);
      renderer.resize(80, 34, 2, 4);
      renderer.setCursorBlink(true);
      renderer.renderImmediate(visibleCursorFrame(true));
      context.fillText.mockClear();

      tickIntervals();

      const painted = context.fillText.mock.calls.map(([text]) => text);
      expect(painted).toEqual(expect.arrayContaining(["a", "b", "c", "d"]));
      expect(painted).not.toEqual(expect.arrayContaining(["e"]));
      renderer.dispose();
    });

    it("erases the previous cell when the cursor moves off it", () => {
      const renderer = new CanvasRenderer();
      const canvas = document.createElement("canvas");
      renderer.mount(canvas);
      // A transparent background erases via clearRect instead of a
      // background-color fillRect, making the erasure unambiguous to assert.
      renderer.setBackgroundVisible(false);
      renderer.resize(80, 34, 2, 4);
      renderer.renderImmediate(visibleCursorFrame(true, { sequence: 1 }));
      // Only count clearRect calls from the incremental repaint below - the
      // initial full redraw already clears every row once, which would
      // otherwise make this assertion pass even without the erase-on-move
      // fix it exists to cover.
      context.clearRect.mockClear();

      renderer.render(
        visibleCursorFrame(false, { sequence: 2 }, { row: 1, column: 0 }),
      );
      const [id, callback] = [...callbacks.entries()][0];
      callbacks.delete(id);
      callback(16);

      // Row 0 (where the cursor used to be) is erased even though it is not
      // itself a dirty row in this delta - and nothing else needed erasing,
      // since row 1's cell content never changed (only the cursor overlay
      // moved onto it).
      expect(context.clearRect).toHaveBeenCalledTimes(1);
      expect(context.clearRect).toHaveBeenCalledWith(0, 0, 80, 16.8);
      renderer.dispose();
    });

    it("does not stack alpha across repeated overlay paints of an unchanged cursor", () => {
      const renderer = new CanvasRenderer();
      const canvas = document.createElement("canvas");
      renderer.mount(canvas);
      renderer.resize(80, 34, 2, 4);
      renderer.renderImmediate(visibleCursorFrame(true));
      const fillRectCallsAfterFirstPaint = context.fillRect.mock.calls.length;

      // WebGLRenderer calls this once per GL frame (redraw/resize/blink
      // tick); with nothing new queued it must be a no-op for the cursor.
      (renderer as unknown as { paintOverlayPending: () => void }).paintOverlayPending();
      (renderer as unknown as { paintOverlayPending: () => void }).paintOverlayPending();

      expect(context.fillRect.mock.calls.length).toBe(
        fillRectCallsAfterFirstPaint,
      );
      renderer.dispose();
    });

    it("maps DECSCUSR shapes to cursor styles and honors steady (non-blinking) shapes", () => {
      const renderer = new CanvasRenderer();
      const canvas = document.createElement("canvas");
      renderer.mount(canvas);
      renderer.resize(80, 34, 2, 4);
      renderer.setCursorBlink(true);

      renderer.renderImmediate(
        visibleCursorFrame(true, { sequence: 1 }, { shape: "steady-bar" }),
      );
      // A steady shape never enters the blink-off phase.
      tickIntervals();
      expect(paintedCursor(renderer)?.visible).toBe(true);
      // "bar" paints a 2px-wide fillRect, distinct from the 8px-wide block.
      expect(context.fillRect).toHaveBeenCalledWith(0, 0, 2, 16.8);

      renderer.dispose();
    });
  });
});
