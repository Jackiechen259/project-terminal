import type {
  TerminalRenderCell,
  TerminalRenderFrame,
  TerminalRenderRow,
} from "@/lib/terminalFrames";

/**
 * RenderFrame is an incremental protocol. `stableRow` identifies a model row
 * independently of its physical position in the current viewport, so a
 * viewport move must not invalidate retained rows.
 */
export const RENDER_CACHE_MARGIN_ROWS = 32;

export type MergedRenderFrame = TerminalRenderFrame & {
  /** Internal marker; never crosses the Tauri channel. */
  retainedSnapshot?: boolean;
};

export function isCompatibleRenderGrid(
  previous: Pick<TerminalRenderFrame, "rows" | "cols"> | null,
  next: Pick<TerminalRenderFrame, "rows" | "cols">,
) {
  return (
    previous !== null &&
    previous.rows === next.rows &&
    previous.cols === next.cols
  );
}

export interface RenderFrameCacheUpdate {
  viewportChanged: boolean;
  gridChanged: boolean;
  cacheCleared: boolean;
  accepted: boolean;
}

/**
 * Apply one frame to a stable-row cache.
 *
 * A renderer with no coherent previous frame cannot safely paint a delta, and
 * a dimension transition cannot be reconstructed from delta rows. In both
 * cases the cache is cleared and the caller waits for the backend's
 * authoritative full snapshot. A viewport move alone is always safe.
 */
export function applyFrameToRowCache(
  cache: Map<number, TerminalRenderRow>,
  previous: TerminalRenderFrame | null,
  next: MergedRenderFrame,
  expectedGrid: Pick<TerminalRenderFrame, "rows" | "cols"> | null = null,
): RenderFrameCacheUpdate {
  const previousGridChanged =
    previous !== null && !isCompatibleRenderGrid(previous, next);
  const expectedGridChanged =
    expectedGrid !== null && !isCompatibleRenderGrid(expectedGrid, next);
  const gridChanged = previousGridChanged || expectedGridChanged;
  const viewportChanged =
    previous !== null && previous.viewportTop !== next.viewportTop;
  const cacheCleared = previous === null || gridChanged || next.fullSnapshot;

  if (cacheCleared) cache.clear();

  const accepted =
    !expectedGridChanged &&
    (next.fullSnapshot ||
      (!previousGridChanged && previous !== null) ||
      (!gridChanged && next.retainedSnapshot === true));
  if (!accepted) {
    return { viewportChanged, gridChanged, cacheCleared, accepted };
  }

  for (const row of next.dirtyRows) cache.set(row.stableRow, row);
  pruneRowCache(cache, next);
  return { viewportChanged, gridChanged, cacheCleared, accepted };
}

/**
 * Keep the visible viewport and a small neighborhood, rather than retaining
 * every stable row ever seen while a terminal scrolls. Full snapshots on
 * explicit scrollback requests rehydrate rows outside this bounded window.
 */
/**
 * Walk a cell as column-sized clusters.
 *
 * Compacted runs keep one JSON object for a whole span (`text: "hello"`,
 * `width: 5`). Selection, search, and text extraction still need the
 * per-column view; painting can skip this and draw the run as one glyph.
 */
export function forEachCellCluster(
  cell: TerminalRenderCell,
  visit: (column: number, text: string, width: number) => void,
) {
  const chars = Array.from(cell.text);
  if (chars.length <= 1) {
    visit(cell.column, cell.text, Math.max(1, cell.width ?? 1));
    return;
  }
  const totalWidth = Math.max(1, cell.width ?? 1);
  const clusterWidth = Math.max(1, Math.round(totalWidth / chars.length));
  let column = cell.column;
  for (const text of chars) {
    visit(column, text, clusterWidth);
    column += clusterWidth;
  }
}

export function pruneRowCache(
  cache: Map<number, TerminalRenderRow>,
  frame: Pick<TerminalRenderFrame, "viewportTop" | "rows">,
) {
  const firstRetainedRow = frame.viewportTop - RENDER_CACHE_MARGIN_ROWS;
  const endRetainedRow =
    frame.viewportTop + frame.rows + RENDER_CACHE_MARGIN_ROWS;
  for (const stableRow of cache.keys()) {
    if (stableRow < firstRetainedRow || stableRow >= endRetainedRow) {
      cache.delete(stableRow);
    }
  }
}
