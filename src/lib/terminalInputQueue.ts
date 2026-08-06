export type TerminalInputWriter = (
  sessionId: string,
  data: string,
) => Promise<void>;

export type TerminalBinaryWriter = (
  sessionId: string,
  data: Uint8Array,
) => Promise<void>;

/** Which xterm event produced a chunk, and therefore how it must be encoded. */
type InputKind = "text" | "binary";

interface InputChunk {
  kind: InputKind;
  data: string;
}

/**
 * Translate an xterm `onBinary` payload into the bytes it stands for.
 *
 * xterm reports binary as a string whose char codes are the byte values, so
 * it must never be re-encoded as UTF-8: a mouse report column of 0xe9 would
 * otherwise reach the PTY as the two bytes 0xc3 0xa9.
 */
export function latin1ToBytes(data: string): Uint8Array {
  const bytes = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 1) bytes[i] = data.charCodeAt(i) & 0xff;
  return bytes;
}

/**
 * Keeps keyboard input ordered across the asynchronous Tauri IPC boundary.
 * Input typed while a PTY is starting is buffered, and input arriving during
 * an in-flight write is coalesced into the next write to avoid an IPC request
 * per key repeat.
 *
 * Two lanes share one queue. `onData` carries UTF-8 text; `onBinary` carries
 * raw bytes (xterm routes mouse reports there whenever the program selected
 * the default encoding rather than SGR). They travel over different commands
 * but must stay in the order the terminal produced them, so only adjacent
 * chunks of the same kind are coalesced.
 */
export class TerminalInputQueue {
  private sessionId: string | null = null;
  private pending: InputChunk[] = [];
  private drainPromise: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly write: TerminalInputWriter,
    private readonly writeBinary?: TerminalBinaryWriter,
  ) {}

  attach(sessionId: string) {
    if (this.disposed) return;
    this.sessionId = sessionId;
    this.startDrain();
  }

  send(data: string) {
    this.enqueue("text", data);
  }

  /** Raw bytes from `Terminal.onBinary`, as a string of byte-valued chars. */
  sendBinary(data: string) {
    this.enqueue("binary", data);
  }

  dispose() {
    this.disposed = true;
    this.sessionId = null;
    this.pending = [];
  }

  /** Wait until currently buffered input has crossed IPC. Used by tests. */
  async whenIdle() {
    while (this.drainPromise) await this.drainPromise;
  }

  private enqueue(kind: InputKind, data: string) {
    if (this.disposed || !data) return;
    const last = this.pending[this.pending.length - 1];
    if (last && last.kind === kind) last.data += data;
    else this.pending.push({ kind, data });
    this.startDrain();
  }

  private startDrain() {
    if (
      this.disposed ||
      !this.sessionId ||
      this.pending.length === 0 ||
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
    while (!this.disposed && this.sessionId && this.pending.length > 0) {
      const sessionId = this.sessionId;
      const chunk = this.pending.shift();
      if (!chunk) return;
      try {
        if (chunk.kind === "binary") {
          // Without a binary writer the only faithful option is to drop the
          // chunk: sending it as text would corrupt every byte above 0x7f.
          await this.writeBinary?.(sessionId, latin1ToBytes(chunk.data));
        } else {
          await this.write(sessionId, chunk.data);
        }
      } catch {
        // Closing a tab can race the final input write. Do not let one failed
        // IPC call poison the queue or produce an unhandled rejection.
      }
    }
  }
}
