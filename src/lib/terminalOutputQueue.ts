export type TerminalOutputWriter = (data: Uint8Array) => void;
export type TerminalOutputScheduler = (
  callback: () => void,
  delay: number,
) => number;
export type TerminalOutputCanceller = (handle: number) => void;
export type TerminalOutputClock = () => number;

/**
 * Coalesces PTY output fragments and only hands xterm complete frames.
 *
 * A single dynamic-TUI redraw is often split across several OS reads and
 * Tauri Channel messages, and xterm re-renders after each `write()` - so a
 * flush boundary that lands inside a redraw paints the cursor at whatever
 * intermediate cell the redraw left it in. That is the "cursor jumping
 * between dynamic parts" artifact. ConPTY is the worst case: it does not
 * pass an application's sequences through, but re-synthesizes its own screen
 * buffer as one long `ESC[r;cH` + text sequence, parking the real cursor at
 * the end. Cutting that sequence in half renders the cursor at a random cell
 * of the redraw.
 *
 * The previous design coalesced fragments within a single
 * `requestAnimationFrame` window (~16 ms), but ConPTY fragmentation can split
 * one redraw across a frame boundary, which regressed the same artifact.
 *
 * This implementation keeps the short debounce (4 ms) and max-wait (16 ms)
 * pacing, but limits every flush to a safe cut point. An incremental escape
 * sequence scanner tracks, across fragments:
 *
 * - the tail of an unfinished escape sequence (a CSI/OSC/DCS/SOS/PM/APC that
 *   a fragment boundary split in half);
 * - unmatched `ESC[?25l` brackets (DECSET/DECRST parameters are split on `;`,
 *   so `ESC[?25;1049l` still counts);
 * - unmatched `ESC 7` / `ESC[s` save-cursor brackets.
 *
 * When any of these are pending, bytes from the earliest one onward are held
 * back; flushes stop at the bracket, so xterm only ever sees complete frames.
 * When the matching close sequence arrives, the whole frame is written at
 * once. The debounce/max-wait timers remain the floor pacing, but they now
 * only ever write the safe prefix - a slow redraw costs a few frames of
 * latency, never a corrupted one.
 *
 * Holdbacks are bounded so a program that hides the cursor and never restores
 * it (vim, htop) cannot freeze the screen: `MAX_HOLDBACK_MS` and
 * `MAX_HOLDBACK_BYTES` force the pending frame out, and the bracket state is
 * cleared afterwards so the next flush behaves normally again instead of
 * re-tripping the same wall every frame.
 *
 * Known boundary: this strategy depends on programs declaring their frames
 * with cursor-visible or save/restore brackets. A multi-line program that
 * redraws purely with cursor motion and never hides the cursor cannot be
 * recognized as "mid-frame" - its redraw may be flushed at a wall-clock cut.
 * Such programs are rare under ConPTY, which re-synthesizes redraws and
 * brackets them itself, but this does not claim 100% coverage.
 *
 * Scanning cost is O(bytes) per new fragment; parser state is carried on the
 * instance, never re-derived by re-scanning the buffer.
 */
export class TerminalOutputQueue {
  /** Growing byte buffer holding pending output. */
  private buffer = new Uint8Array(32 * 1024);
  /** First pending byte, i.e. what has already been written to xterm. */
  private head = 0;
  /**
   * Earliest byte being held back at a safe cut point.
   *
   * Everything from here on waits for its bracket to close (or the holdback
   * limits). When no bracket is open this equals the end of pending data.
   */
  private tailStart = 0;
  private byteLength = 0;
  private debounceHandle: number | null = null;
  private maxWaitHandle: number | null = null;
  private holdbackHandle: number | null = null;
  private lastSendAt = 0;
  private disposed = false;

  // Scanner state, carried across fragments. Positions are absolute offsets
  // into `buffer`; they survive head advances because `buffer` is compacted
  // as a whole, never shifted in place.
  private pos = 0;
  /** Offset of the current escape sequence's leading ESC byte. */
  private seqStart = 0;
  private state: "idle" | "esc" | "csi" | "string" = "idle";
  /** CSI parameter bytes, built up until the final byte arrives. */
  private csiParams = "";
  /**
   * Starts of unclosed `ESC[?25l` brackets, innermost last.
   *
   * DECSET/DECRST brackets nest (LIFO), so a stack is the exact model. The
   * bottom of the stack is the earliest still-open bracket of this kind.
   */
  private cursorHideStack: number[] = [];
  /** Starts of unclosed `ESC 7` / `ESC[s` brackets, innermost last. */
  private decscStack: number[] = [];
  /** When the current holdback started; null when nothing is held back. */
  private holdbackSince: number | null = null;

  /** Delay (ms) after the last received fragment before flushing. */
  private static readonly DEBOUNCE_MS = 4;
  /** Maximum delay (ms) from the first fragment before a forced flush. */
  private static readonly MAX_WAIT_MS = 16;
  /**
   * Buffered bytes that force a flush regardless of the timers.
   *
   * Neither timer bounds memory. A process writing faster than the WebView
   * can schedule a callback - `cat` on a large binary, a build printing at
   * full tilt - keeps arriving inside the debounce window, and the max-wait
   * timer only fires when the event loop gets a turn. Without a cap the array
   * grows for as long as that lasts.
   *
   * Sized generously: a full redraw of a large grid is well under this, so a
   * normal TUI never trips it and never loses the coalescing this class
   * exists for.
   */
  private static readonly MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
  /**
   * How long a frame may be held back waiting for its bracket to close.
   *
   * Some programs (vim, htop) hide the cursor for minutes at a time and
   * never send the matching `ESC[?25h` while nothing changes. Without a
   * deadline, their output would sit in the queue until the bracket closed,
   * freezing the screen. 180 ms is several frames of latency for a redraw
   * that fails to close its bracket - visible to the eye, but the frame
   * still renders promptly when the program is merely slow.
   */
  private static readonly MAX_HOLDBACK_MS = 180;
  /**
   * Byte cap on the held-back tail, same reasoning as `MAX_HOLDBACK_MS` but
   * for output volume: a program that floods output inside one unclosed
   * bracket (or a ConPTY re-synthesis that never terminates) must not sit in
   * the queue until a bracket closes that may never come.
   */
  private static readonly MAX_HOLDBACK_BYTES = 256 * 1024;

  constructor(
    private readonly write: TerminalOutputWriter,
    private readonly schedule: TerminalOutputScheduler,
    private readonly cancel: TerminalOutputCanceller,
    private readonly now: TerminalOutputClock = () => performance.now(),
  ) {}

  /** Buffer a fragment and let the scanner update the safe cut point. */
  send(data: Uint8Array) {
    if (this.disposed || data.byteLength === 0) return;

    this.ensureCapacity(data.byteLength);
    const at = this.head + this.byteLength;
    this.buffer.set(data, at);
    this.byteLength += data.byteLength;
    // New bytes are safe to render by default; the scan below pulls the cut
    // back to any unfinished sequence or open bracket it lands on, and
    // recomputing afterwards keeps it at the earliest open bracket even when
    // that bracket lives in earlier bytes.
    this.tailStart = this.head + this.byteLength;
    this.scan(this.buffer, at, at + data.byteLength);
    this.recomputeTail();
    this.lastSendAt = this.now();

    if (this.byteLength >= TerminalOutputQueue.MAX_BUFFERED_BYTES) {
      // Hand it to xterm now rather than hold it. Coalescing exists to avoid
      // rendering intermediate cursor positions; there is no cursor artifact
      // worth two megabytes of buffered output.
      this.flush();
      return;
    }

    this.armTimers();
  }

  /**
   * Immediately writes any safe prefix, preserving fragment order. When a
   * bracket is open the held-back tail stays queued, waiting for its close.
   */
  flush() {
    if (this.disposed) return;
    if (this.debounceHandle !== null) {
      this.cancel(this.debounceHandle);
      this.debounceHandle = null;
    }
    if (this.maxWaitHandle !== null) {
      this.cancel(this.maxWaitHandle);
      this.maxWaitHandle = null;
    }
    if (this.holdbackHandle !== null) {
      this.cancel(this.holdbackHandle);
      this.holdbackHandle = null;
    }
    if (this.byteLength === 0) return;

    const prefixLength = this.tailStart - this.head;
    const heldBack = this.byteLength - prefixLength;
    // The holdback limits are the escape valve for a bracket that never
    // closes. Releasing advances the cut to the end, clearing the bracket
    // state so the next flush does not trip the same wall again.
    if (
      heldBack > 0 &&
      (heldBack >= TerminalOutputQueue.MAX_HOLDBACK_BYTES ||
        (this.holdbackSince !== null &&
          this.now() - this.holdbackSince >=
            TerminalOutputQueue.MAX_HOLDBACK_MS))
    ) {
      this.releaseHoldback();
    }

    const writeLength = this.tailStart - this.head;
    if (writeLength > 0) {
      const output = this.buffer.subarray(this.head, this.tailStart);
      // A one-element copy keeps `write` from holding a view into the
      // growing buffer; every write of multiple bytes already allocates.
      this.write(output.byteLength === 1 ? output.slice() : output);
      this.head = this.tailStart;
      this.byteLength -= writeLength;
    }

    if (this.byteLength === 0) return;
    if (writeLength > 0) {
      // Pacing for the surviving tail: debounce and max-wait keep polling so
      // a bracket that closes in the next fragment is written promptly.
      this.armTimers();
    } else {
      // Nothing new was written and nothing new arrived; only the holdback
      // deadline is worth scheduling. New data re-arms the rest via `send`.
      this.armHoldback();
    }
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
    if (this.holdbackHandle !== null) {
      this.cancel(this.holdbackHandle);
      this.holdbackHandle = null;
    }
    this.byteLength = 0;
  }

  /** Byte count still queued, for tests. */
  pendingCount(): number {
    return this.byteLength;
  }

  private armTimers() {
    if (this.debounceHandle === null) {
      this.scheduleDebounce(TerminalOutputQueue.DEBOUNCE_MS);
    }
    if (this.maxWaitHandle === null) {
      this.maxWaitHandle = this.schedule(() => {
        this.maxWaitHandle = null;
        this.flush();
      }, TerminalOutputQueue.MAX_WAIT_MS);
    }
    this.armHoldback();
  }

  private armHoldback() {
    if (
      this.holdbackSince === null ||
      this.holdbackHandle !== null ||
      this.tailStart >= this.head + this.byteLength
    ) {
      return;
    }
    const remaining =
      TerminalOutputQueue.MAX_HOLDBACK_MS - (this.now() - this.holdbackSince);
    if (remaining > 0) {
      this.holdbackHandle = this.schedule(() => {
        this.holdbackHandle = null;
        this.flush();
      }, remaining);
    }
  }

  private scheduleDebounce(delay: number) {
    this.debounceHandle = this.schedule(() => {
      this.debounceHandle = null;
      const remaining =
        TerminalOutputQueue.DEBOUNCE_MS - (this.now() - this.lastSendAt);
      if (remaining > 0) {
        this.scheduleDebounce(remaining);
        return;
      }
      this.flush();
    }, delay);
  }

  /** Cut to the end of pending data and forget the open brackets. */
  private releaseHoldback() {
    this.tailStart = this.head + this.byteLength;
    this.cursorHideStack.length = 0;
    this.decscStack.length = 0;
    this.holdbackSince = null;
  }

  /**
   * Recompute the safe cut point from the scanner state.
   *
   * Runs after every scan. `send` set the cut to the end of pending data
   * before scanning; this recomputes it from what the scan found, so the cut
   * is the earliest of: an unfinished escape sequence's start, the bottom of
   * the cursor-hide stack, the bottom of the DECSC stack, or the end of
   * pending data. When every bracket is closed the cut is the end, and the
   * next flush writes the complete frame.
   */
  private recomputeTail() {
    const pendingEnd = this.head + this.byteLength;
    const cut = Math.min(
      this.cursorHideStack[0] ?? pendingEnd,
      this.decscStack[0] ?? pendingEnd,
      this.state !== "idle" ? this.seqStart : pendingEnd,
    );
    this.tailStart = Math.min(cut, this.tailStart);
    if (
      this.cursorHideStack.length === 0 &&
      this.decscStack.length === 0 &&
      this.state === "idle"
    ) {
      this.tailStart = pendingEnd;
      this.holdbackSince = null;
    }
  }

  /**
   * Advance the scanner over `[start, end)` of `buffer`, tracking unfinished
   * escape sequences and cursor/save brackets as they complete.
   */
  private scan(buffer: Uint8Array, start: number, end: number) {
    this.pos = Math.max(this.pos, start);
    while (this.pos < end) {
      const state = this.state;
      if (state === "idle") {
        if (buffer[this.pos] === 0x1b /* ESC */) {
          this.seqStart = this.pos;
          this.state = "esc";
          this.pos += 1;
        } else {
          this.pos += 1;
        }
        continue;
      }
      if (state === "esc") {
        const byte = buffer[this.pos];
        this.pos += 1;
        if (byte === 0x5b /* `[` */) {
          this.state = "csi";
          this.csiParams = "";
          continue;
        }
        if (
          byte === 0x5d /* `]` */ ||
          byte === 0x50 /* P */ ||
          byte === 0x58 /* X */ ||
          byte === 0x5e /* `^` */ ||
          byte === 0x5f /* `_` */
        ) {
          this.state = "string";
          continue;
        }
        // Single-character escape sequence.
        this.state = "idle";
        if (byte === 0x37 /* `7` DECSC */) {
          this.openDecsc(this.seqStart);
        } else if (byte === 0x38 /* `8` DECRC */) {
          this.closeDecsc();
        }
        continue;
      }
      if (state === "csi") {
        const byte = buffer[this.pos];
        // Final bytes are 0x40-0x7E; `;`, `?`, digits and intermediates
        // accumulate in the parameter string until one arrives.
        if (byte >= 0x40 && byte <= 0x7e) {
          this.csiParams += String.fromCharCode(byte);
          this.state = "idle";
          this.pos += 1;
          this.applyCsi();
        } else {
          this.csiParams += String.fromCharCode(byte);
          this.pos += 1;
        }
        continue;
      }
      // OSC/DCS/SOS/PM/APC: consume until BEL or `ESC \` (ST).
      const byte = buffer[this.pos];
      this.pos += 1;
      if (byte === 0x07 /* BEL */) {
        this.state = "idle";
      } else if (byte === 0x1b) {
        if (this.pos < end && buffer[this.pos] === 0x5c /* `\` */) {
          this.pos += 1;
          this.state = "idle";
        }
      }
    }
  }

  /**
   * `this.pos` is just past the CSI final byte when this runs.
   *
   * The DECSC/DECRC save-cursor brackets come through as plain CSIs: `ESC[s`
   * with an empty parameter string, `ESC[u` likewise.
   */
  private applyCsi() {
    const params = this.csiParams;
    this.csiParams = "";
    if (params === "s") {
      this.openDecsc(this.seqStart);
      return;
    }
    if (params === "u") {
      this.closeDecsc();
      return;
    }
    // DECSET/DECRST carry their private marker in the parameter string.
    if (params[0] !== "?") return;
    const numbers = params.slice(1, -1).split(";");
    if (!numbers.some((p) => p === "25")) return;
    if (params.endsWith("l")) {
      this.openCursorHide(this.seqStart);
    } else {
      this.closeCursorHide();
    }
  }

  private openCursorHide(start: number) {
    if (this.cursorHideStack.length === 0) {
      this.holdbackSince ??= this.now();
    }
    this.cursorHideStack.push(start);
    if (this.tailStart > start) {
      this.tailStart = start;
    }
  }

  private closeCursorHide() {
    this.cursorHideStack.pop();
  }

  private openDecsc(start: number) {
    if (this.decscStack.length === 0) {
      this.holdbackSince ??= this.now();
    }
    this.decscStack.push(start);
    if (this.tailStart > start) {
      this.tailStart = start;
    }
  }

  private closeDecsc() {
    this.decscStack.pop();
  }

  private ensureCapacity(extra: number) {
    const needed = this.head + this.byteLength + extra;
    if (needed <= this.buffer.length) return;
    // Compact first: the head (written prefix) may leave a lot of dead space.
    if (this.head > 0) {
      this.buffer.copyWithin(0, this.head, this.head + this.byteLength);
      const shifted = this.head;
      this.head = 0;
      this.pos -= shifted;
      this.tailStart -= shifted;
      this.seqStart -= shifted;
      for (let i = 0; i < this.cursorHideStack.length; i++) {
        this.cursorHideStack[i] -= shifted;
      }
      for (let i = 0; i < this.decscStack.length; i++) {
        this.decscStack[i] -= shifted;
      }
    }
    if (this.head + this.byteLength + extra <= this.buffer.length) return;
    let size = this.buffer.length;
    while (size < this.head + this.byteLength + extra) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(
      this.buffer.subarray(this.head, this.head + this.byteLength),
      this.head,
    );
    this.buffer = grown;
  }
}
