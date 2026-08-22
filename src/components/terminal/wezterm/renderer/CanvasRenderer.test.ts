import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  RenderColor,
  TerminalRenderCell,
  TerminalRenderFrame,
  TerminalRenderRow,
} from "@/lib/terminalFrames";

import { CanvasRenderer } from "./CanvasRenderer";

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

function frame(
  dirtyRows: TerminalRenderRow[],
  fullSnapshot = false,
): TerminalRenderFrame {
  return {
    sequence: fullSnapshot ? 1 : 2,
    rows: 2,
    cols: 4,
    dirtyRows,
    cursor: {
      column: 0,
      row: 0,
      shape: "default",
      visibility: "hidden",
    },
    scrollbackLength: 0,
    viewportTop: 0,
    viewportBottom: 0,
    alternateScreen: false,
    mouseReporting: false,
    fullSnapshot,
  };
}

describe("CanvasRenderer", () => {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrameId = 0;
  let context: {
    fillText: ReturnType<typeof vi.fn>;
    measureText: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    callbacks.clear();
    nextFrameId = 0;
    context = {
      fillText: vi.fn(),
      measureText: vi.fn(() => ({
        width: 16,
        actualBoundingBoxAscent: 10,
        actualBoundingBoxDescent: 3,
      })),
    };
    const canvasContext = {
      ...context,
      save: vi.fn(),
      restore: vi.fn(),
      setTransform: vi.fn(),
      fillRect: vi.fn(),
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
});
