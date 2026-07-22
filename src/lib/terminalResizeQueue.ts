export interface TerminalDimensions {
  rows: number;
  cols: number;
}

export type TerminalResizeWriter = (
  sessionId: string,
  rows: number,
  cols: number,
) => Promise<void>;

function normalizeDimension(value: number) {
  return Math.min(65_535, Math.max(1, Math.floor(value)));
}

function normalizeDimensions(rows: number, cols: number): TerminalDimensions {
  return {
    rows: normalizeDimension(rows),
    cols: normalizeDimension(cols),
  };
}

function sameDimensions(
  left: TerminalDimensions | null,
  right: TerminalDimensions,
) {
  return left?.rows === right.rows && left.cols === right.cols;
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
      ? normalizeDimensions(initiallyApplied.rows, initiallyApplied.cols)
      : null;
    this.startDrain();
  }

  request(rows: number, cols: number) {
    if (this.disposed) return;
    const dimensions = normalizeDimensions(rows, cols);
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
        await this.write(sessionId, dimensions.rows, dimensions.cols);
        this.applied = dimensions;
      } catch {
        // A tab can close while a resize is in flight. A later request can
        // still retry because failed dimensions are not marked as applied.
      }
    }
  }
}
