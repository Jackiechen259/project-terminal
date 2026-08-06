export interface TerminalDimensions {
  rows: number;
  cols: number;
  /**
   * Grid size in pixels, when it is known.
   *
   * `TIOCGWINSZ` carries this alongside rows and columns, and image tools -
   * `chafa`, `img2sixel`, `timg` - read it to decide how large a picture to
   * draw. Reporting zero, which is what a pty defaults to, makes them fall
   * back to a fixed guess or refuse outright.
   */
  pixelWidth?: number;
  pixelHeight?: number;
}

export type TerminalResizeWriter = (
  sessionId: string,
  rows: number,
  cols: number,
  pixelWidth: number,
  pixelHeight: number,
) => Promise<void>;

function normalizeDimension(value: number) {
  return Math.min(65_535, Math.max(1, Math.floor(value)));
}

/** Pixel extents are optional, so 0 is the legitimate "unknown" value. */
function normalizePixels(value: number | undefined) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(65_535, Math.max(0, Math.floor(value as number)));
}

function normalizeDimensions(
  rows: number,
  cols: number,
  pixelWidth?: number,
  pixelHeight?: number,
): TerminalDimensions {
  return {
    rows: normalizeDimension(rows),
    cols: normalizeDimension(cols),
    pixelWidth: normalizePixels(pixelWidth),
    pixelHeight: normalizePixels(pixelHeight),
  };
}

function sameDimensions(
  left: TerminalDimensions | null,
  right: TerminalDimensions,
) {
  return (
    left?.rows === right.rows &&
    left.cols === right.cols &&
    left.pixelWidth === right.pixelWidth &&
    left.pixelHeight === right.pixelHeight
  );
}

/**
 * Keeps PTY resizes ordered across the asynchronous Tauri IPC boundary.
 *
 * ResizeObserver can report several sizes while a prior resize is still in
 * flight. Only the newest pending dimensions matter, but they must never be
 * overtaken by an older IPC call or a full-screen TUI can render against a
 * different grid than xterm and place its cursor on the wrong row/column.
 */
export class TerminalResizeQueue {
  private sessionId: string | null = null;
  private pending: TerminalDimensions | null = null;
  private applied: TerminalDimensions | null = null;
  private drainPromise: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly write: TerminalResizeWriter) {}

  attach(sessionId: string, initiallyApplied?: TerminalDimensions) {
    if (this.disposed) return;
    this.sessionId = sessionId;
    this.applied = initiallyApplied
      ? normalizeDimensions(
          initiallyApplied.rows,
          initiallyApplied.cols,
          initiallyApplied.pixelWidth,
          initiallyApplied.pixelHeight,
        )
      : null;
    this.startDrain();
  }

  request(
    rows: number,
    cols: number,
    pixelWidth?: number,
    pixelHeight?: number,
  ) {
    if (this.disposed) return;
    const dimensions = normalizeDimensions(rows, cols, pixelWidth, pixelHeight);
    if (sameDimensions(this.pending, dimensions)) return;
    if (!this.pending && sameDimensions(this.applied, dimensions)) return;
    this.pending = dimensions;
    this.startDrain();
  }

  dispose() {
    this.disposed = true;
    this.sessionId = null;
    this.pending = null;
    this.applied = null;
  }

  /** Wait until currently buffered resizes have crossed IPC. Used by tests. */
  async whenIdle() {
    while (this.drainPromise) await this.drainPromise;
  }

  private startDrain() {
    if (
      this.disposed ||
      !this.sessionId ||
      !this.pending ||
      this.drainPromise
    ) {
      return;
    }

    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = null;
      this.startDrain();
    });
  }

  private async drain() {
    while (!this.disposed && this.sessionId && this.pending) {
      const sessionId = this.sessionId;
      const dimensions = this.pending;
      this.pending = null;
      if (sameDimensions(this.applied, dimensions)) continue;

      try {
        await this.write(
          sessionId,
          dimensions.rows,
          dimensions.cols,
          dimensions.pixelWidth ?? 0,
          dimensions.pixelHeight ?? 0,
        );
        this.applied = dimensions;
      } catch {
        // A tab can close while a resize is in flight. A later request can
        // still retry because failed dimensions are not marked as applied.
      }
    }
  }
}
