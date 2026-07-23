export type TerminalOutputWriter = (data: Uint8Array) => void;
export type TerminalOutputScheduler = (callback: () => void, delay: number) => number;
export type TerminalOutputCanceller = (handle: number) => void;

/**
 * Coalesces PTY output fragments that arrive within a short debounce window.
 *
 * A single dynamic-TUI redraw is often split across several OS reads and
 * Tauri Channel messages. Writing every fragment to xterm immediately can
 * render temporary cursor positions between "move, update, restore" escape
 * sequences. The previous design coalesced fragments within a single
 * `requestAnimationFrame` window (~16 ms), but ConPTY fragmentation can split
 * one redraw across a frame boundary. Each partial flush leaves the cursor at
 * an intermediate position (e.g. the spinner cell) for a full frame, producing
 * the visible "cursor jumping between dynamic parts" artifact.
 *
 * This implementation uses a short debounce timer (4 ms) that resets on every
 * incoming fragment, so a burst of fragments arriving within 4 ms of each
 * other is always combined into a single `term.write()` call — regardless of
 * where the animation-frame boundary falls. A max-wait timer (16 ms) acts as a
 * safety valve: if data arrives continuously and the debounce keeps resetting,
 * the queue still flushes at least once per frame so the terminal never
 * appears frozen.
 */
export class TerminalOutputQueue {
  private chunks: Uint8Array[] = [];
  private byteLength = 0;
  private debounceHandle: number | null = null;
  private maxWaitHandle: number | null = null;
  private disposed = false;

  /** Delay (ms) after the last received fragment before flushing. */
  private static readonly DEBOUNCE_MS = 4;
  /** Maximum delay (ms) from the first fragment before a forced flush. */
  private static readonly MAX_WAIT_MS = 16;

  constructor(
    private readonly write: TerminalOutputWriter,
    private readonly schedule: TerminalOutputScheduler,
    private readonly cancel: TerminalOutputCanceller,
  ) {}

  send(data: Uint8Array) {
    if (this.disposed || data.byteLength === 0) return;

    this.chunks.push(data);
    this.byteLength += data.byteLength;

    // Reset the debounce timer so a burst of fragments is flushed together.
    if (this.debounceHandle !== null) {
      this.cancel(this.debounceHandle);
    }
    // Start the max-wait timer on the first fragment of a new batch.
    if (this.maxWaitHandle === null) {
      this.maxWaitHandle = this.schedule(
        () => {
          this.maxWaitHandle = null;
          this.flush();
        },
        TerminalOutputQueue.MAX_WAIT_MS,
      );
    }
    this.debounceHandle = this.schedule(
      () => {
        this.debounceHandle = null;
        this.flush();
      },
      TerminalOutputQueue.DEBOUNCE_MS,
    );
  }

  /** Immediately writes any buffered output, preserving fragment order. */
  flush() {
    if (this.disposed || this.byteLength === 0) return;

    if (this.debounceHandle !== null) {
      this.cancel(this.debounceHandle);
      this.debounceHandle = null;
    }
    if (this.maxWaitHandle !== null) {
      this.cancel(this.maxWaitHandle);
      this.maxWaitHandle = null;
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
    if (this.debounceHandle !== null) {
      this.cancel(this.debounceHandle);
      this.debounceHandle = null;
    }
    if (this.maxWaitHandle !== null) {
      this.cancel(this.maxWaitHandle);
      this.maxWaitHandle = null;
    }
    this.chunks = [];
    this.byteLength = 0;
  }
}
