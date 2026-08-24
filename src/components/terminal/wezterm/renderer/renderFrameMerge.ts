import type {
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

/**
 * Coalesce frames queued for one animation frame.
 *
 * The newest frame owns all metadata. Dirty rows are merged by stable row when
 * both frames describe the same grid. A pending full snapshot remains a full
 * snapshot only while its viewport is still the viewport described by the
 * newest frame; otherwise its overlapping rows are useful retained state, but
 * the coalesced frame is an incremental delta for the new viewport.
 */
export function mergePendingFrame(
  pending: MergedRenderFrame | null,
  next: TerminalRenderFrame,
): MergedRenderFrame {
  if (!pending) return next;
  if (next.fullSnapshot || !isCompatibleRenderGrid(pending, next)) return next;

  const rows = new Map<number, TerminalRenderRow>();
  for (const row of pending.dirtyRows) rows.set(row.stableRow, row);
  for (const row of next.dirtyRows) rows.set(row.stableRow, row);

  const viewportChanged =
    pending.viewportTop !== next.viewportTop ||
    pending.viewportBottom !== next.viewportBottom;
  const mergedRows = new Set(rows.keys());
  const coversCurrentViewport = Array.from(
    { length: next.rows },
    (_, offset) => next.viewportTop + offset,
  ).every((stableRow) => mergedRows.has(stableRow));
  const fullSnapshot = pending.fullSnapshot && !viewportChanged;
  const hasRetainedSnapshotBase =
    pending.fullSnapshot || pending.retainedSnapshot === true;

  return {
    ...next,
    dirtyRows: [...rows.values()],
    fullSnapshot,
    retainedSnapshot:
      !fullSnapshot && hasRetainedSnapshotBase && coversCurrentViewport,
  };
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
