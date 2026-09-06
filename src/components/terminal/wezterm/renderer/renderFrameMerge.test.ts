import { describe, expect, it } from "vitest";

import type {
  RenderColor,
  TerminalRenderCell,
  TerminalRenderFrame,
  TerminalRenderRow,
} from "@/lib/terminalFrames";

import { applyFrameToRowCache, forEachCellCluster } from "./renderFrameMerge";

function defaultColor(): RenderColor {
  return { kind: "default" };
}

function cell(text: string): TerminalRenderCell {
  return {
    column: 0,
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

function row(stableRow: number, text = ""): TerminalRenderRow {
  return { stableRow, cells: text ? [cell(text)] : [] };
}

function frame(
  sequence: number,
  viewportTop: number,
  dirtyRows: TerminalRenderRow[],
  options: Partial<
    Pick<TerminalRenderFrame, "fullSnapshot" | "rows" | "cols">
  > = {},
): TerminalRenderFrame {
  return {
    sequence,
    rows: options.rows ?? 4,
    cols: options.cols ?? 8,
    dirtyRows,
    cursor: {
      column: 0,
      row: 0,
      shape: "default",
      visibility: "hidden",
    },
    scrollbackLength: sequence,
    viewportTop,
    viewportBottom: viewportTop + 20,
    alternateScreen: sequence % 2 === 0,
    mouseReporting: sequence % 3 === 0,
    fullSnapshot: options.fullSnapshot ?? false,
  };
}

describe("compacted render runs", () => {
  it("walks a compacted ASCII run as one cluster per column", () => {
    const clusters: Array<[number, string, number]> = [];
    forEachCellCluster(
      { column: 2, text: "hello", width: 5 },
      (column, text, width) => {
        clusters.push([column, text, width]);
      },
    );
    expect(clusters).toEqual([
      [2, "h", 1],
      [3, "e", 1],
      [4, "l", 1],
      [5, "l", 1],
      [6, "o", 1],
    ]);
  });

  it("keeps a single wide cluster intact", () => {
    const clusters: Array<[number, string, number]> = [];
    forEachCellCluster(
      { column: 0, text: "界", width: 2 },
      (column, text, width) => {
        clusters.push([column, text, width]);
      },
    );
    expect(clusters).toEqual([[0, "界", 2]]);
  });
});

describe("RenderFrame cache semantics", () => {
  it("retains overlapping rows when automatic scrolling moves the viewport", () => {
    const cache = new Map<number, TerminalRenderRow>();
    const initial = frame(
      1,
      100,
      [row(100, "AAA"), row(101, "BBB"), row(102, "CCC"), row(103, "DDD")],
      { fullSnapshot: true },
    );
    applyFrameToRowCache(cache, null, initial);

    const delta = frame(2, 101, [row(104, "EEE")]);
    const update = applyFrameToRowCache(cache, initial, delta);

    expect(update.accepted).toBe(true);
    expect([...cache.keys()]).toEqual([100, 101, 102, 103, 104]);
    expect(
      [101, 102, 103, 104].every((stableRow) => cache.has(stableRow)),
    ).toBe(true);
  });

  it("requires a full snapshot to rebuild an empty or incompatible cache", () => {
    const cache = new Map<number, TerminalRenderRow>([
      [100, row(100, "STALE")],
    ]);
    const delta = frame(1, 100, [row(100, "DELTA")]);
    expect(applyFrameToRowCache(cache, null, delta).accepted).toBe(false);
    expect(cache.size).toBe(0);

    cache.set(100, row(100, "STALE"));
    const previous = frame(2, 100, [row(100)], { rows: 4 });
    const snapshot = frame(3, 200, [row(200, "FRESH")], {
      fullSnapshot: true,
      rows: 5,
    });
    expect(applyFrameToRowCache(cache, previous, snapshot).accepted).toBe(true);
    expect(cache.has(100)).toBe(false);
    expect(cache.get(200)).toEqual(row(200, "FRESH"));
  });

  it("rejects a snapshot for a grid the renderer has not configured yet", () => {
    const cache = new Map<number, TerminalRenderRow>();
    const snapshot = frame(1, 0, [row(0, "OLD")], {
      fullSnapshot: true,
      rows: 4,
      cols: 8,
    });

    const update = applyFrameToRowCache(cache, null, snapshot, {
      rows: 3,
      cols: 8,
    });

    expect(update.accepted).toBe(false);
    expect(cache.size).toBe(0);
  });
});
