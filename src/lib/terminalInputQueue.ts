export type TerminalInputWriter = (
  sessionId: string,
  data: string,
) => Promise<void>;

/**
 * Keeps keyboard input ordered across the asynchronous Tauri IPC boundary.
 * Input typed while a PTY is starting is buffered, and input arriving during
 * an in-flight write is coalesced into the next write to avoid an IPC request
 * per key repeat.
 */
export class TerminalInputQueue {
  private sessionId: string | null = null;
  private pending = "";
  private drainPromise: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly write: TerminalInputWriter) {}

  attach(sessionId: string) {
    if (this.disposed) return;
    this.sessionId = sessionId;
    this.startDrain();
  }

  send(data: string) {
    if (this.disposed || !data) return;
    this.pending += data;
    this.startDrain();
  }

  dispose() {
    this.disposed = true;
    this.sessionId = null;
    this.pending = "";
  }

  /** Wait until currently buffered input has crossed IPC. Used by tests. */
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
      const data = this.pending;
      this.pending = "";
      try {
        await this.write(sessionId, data);
      } catch {
        // Closing a tab can race the final input write. Do not let one failed
        // IPC call poison the queue or produce an unhandled rejection.
      }
    }
  }
}
