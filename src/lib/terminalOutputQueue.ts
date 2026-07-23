export type TerminalOutputWriter = (data: Uint8Array) => void;
export type TerminalOutputFrameScheduler = (
  callback: FrameRequestCallback,
) => number;
export type TerminalOutputFrameCanceller = (handle: number) => void;

/**
 * Coalesces PTY output received during the same animation frame.
 *
 * A single dynamic-TUI redraw is often split across several OS reads and
 * Tauri Channel messages. Writing every fragment to xterm immediately can
 * render temporary cursor positions between "move, update, restore" escape
 * sequences. Combining adjacent fragments lets xterm parse the complete
 * redraw before the browser paints it.
 */
export class TerminalOutputQueue {
  private chunks: Uint8Array[] = [];
  private byteLength = 0;
  private frameHandle: number | null = null;
  private disposed = false;

  constructor(
    private readonly write: TerminalOutputWriter,
    private readonly scheduleFrame: TerminalOutputFrameScheduler,
    private readonly cancelFrame: TerminalOutputFrameCanceller,
  ) {}

  send(data: Uint8Array) {
    if (this.disposed || data.byteLength === 0) return;

    this.chunks.push(data);
    this.byteLength += data.byteLength;
    if (this.frameHandle !== null) return;

    this.frameHandle = this.scheduleFrame(() => {
      this.frameHandle = null;
      this.flush();
    });
  }

  /** Immediately writes any buffered output, preserving fragment order. */
  flush() {
    if (this.disposed || this.byteLength === 0) return;

    if (this.frameHandle !== null) {
      this.cancelFrame(this.frameHandle);
      this.frameHandle = null;
    }

    const chunks = this.chunks;
    const byteLength = this.byteLength;
    this.chunks = [];
    this.byteLength = 0;

    if (chunks.length === 1) {
      this.write(chunks[0]);
      return;
    }

    const output = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.write(output);
  }

  dispose() {
    this.disposed = true;
    if (this.frameHandle !== null) {
      this.cancelFrame(this.frameHandle);
      this.frameHandle = null;
    }
    this.chunks = [];
    this.byteLength = 0;
  }
}
