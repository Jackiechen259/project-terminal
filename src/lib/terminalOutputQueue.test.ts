import { describe, expect, it, vi } from "vitest";

import { TerminalOutputQueue } from "./terminalOutputQueue";

function createTimerScheduler() {
  let nextHandle = 1;
  let currentTime = 0;
  const timers = new Map<number, () => void>();
  const delays = new Map<number, number>();
  const dueTimes = new Map<number, number>();
  const schedule = vi.fn((callback: () => void, delay: number) => {
    const handle = nextHandle++;
    timers.set(handle, callback);
    delays.set(handle, delay);
    dueTimes.set(handle, currentTime + delay);
    return handle;
  });
  const cancel = vi.fn((handle: number) => {
    timers.delete(handle);
    delays.delete(handle);
    dueTimes.delete(handle);
  });
  /** Run all pending timers whose delay matches `delay`. */
  const run = (delay?: number) => {
    const matching = [...timers.entries()].filter(
      ([h]) => delay === undefined || delays.get(h) === delay,
    );
    for (const [handle, callback] of matching) {
      currentTime = Math.max(currentTime, dueTimes.get(handle) ?? currentTime);
      timers.delete(handle);
      delays.delete(handle);
      dueTimes.delete(handle);
      callback();
    }
  };
  const advance = (milliseconds: number) => {
    currentTime += milliseconds;
  };
  const now = () => currentTime;
  const pendingCount = () => timers.size;

  return { schedule, cancel, run, advance, now, pendingCount };
}

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

/** Concatenation of every flushed write; empty while the queue still holds data. */
function concatenated(writes: number[][]) {
  return Uint8Array.from(writes.flat());
}

function createQueue(
  writes: number[][],
  timers: ReturnType<typeof createTimerScheduler>,
) {
  return new TerminalOutputQueue(
    (data) => writes.push([...data]),
    timers.schedule,
    timers.cancel,
    timers.now,
  );
}

const DEBOUNCE = 4;
const MAX_WAIT = 16;
const HOLDBACK = 180;

describe("TerminalOutputQueue", () => {
  it("flushes on a byte cap rather than buffering without bound", () => {
    // Neither timer bounds memory: a process writing faster than the WebView
    // schedules callbacks keeps landing inside the debounce window, and the
    // max-wait timer only fires when the event loop gets a turn.
    const writes: number[] = [];
    let time = 0;
    const queue = new TerminalOutputQueue(
      (data) => writes.push(data.byteLength),
      // Timers that never fire, standing in for a starved event loop.
      () => 1,
      () => undefined,
      () => time,
    );

    const megabyte = new Uint8Array(1024 * 1024);
    queue.send(megabyte);
    expect(writes).toEqual([]);

    time += 1;
    queue.send(megabyte);
    expect(writes).toEqual([2 * 1024 * 1024]);
  });

  it("combines fragments that arrive within the debounce window", () => {
    const writes: number[][] = [];
    const timers = createTimerScheduler();
    const queue = createQueue(writes, timers);

    queue.send(bytes(1, 2));
    queue.send(bytes(3));
    queue.send(bytes(4, 5));

    // One max-wait and one debounce timer serve the entire synchronous burst.
    expect(timers.schedule).toHaveBeenCalledTimes(2);
    expect(timers.cancel).not.toHaveBeenCalled();
    expect(writes).toEqual([]);

    timers.run(DEBOUNCE);
    expect(writes).toEqual([[1, 2, 3, 4, 5]]);
  });

  it("flushes pending output immediately and cancels all timers", () => {
    const writes: number[][] = [];
    const timers = createTimerScheduler();
    const queue = createQueue(writes, timers);

    queue.send(bytes(1, 2, 3));
    queue.flush();

    expect(writes).toEqual([[1, 2, 3]]);
    expect(timers.cancel).toHaveBeenCalledTimes(2);
    expect(timers.pendingCount()).toBe(0);

    // Running the debounce timer after flush should be a no-op.
    timers.run(DEBOUNCE);
    expect(writes).toHaveLength(1);
  });

  it("forces a flush via max-wait when data arrives continuously", () => {
    const writes: number[][] = [];
    const timers = createTimerScheduler();
    const queue = createQueue(writes, timers);

    // Simulate continuous data: the max-wait timer must force a flush even
    // when the quiet-window deadline keeps moving.
    queue.send(bytes(1));
    queue.send(bytes(2));
    queue.send(bytes(3));

    expect(writes).toEqual([]);

    timers.run(MAX_WAIT);
    expect(writes).toEqual([[1, 2, 3]]);
    expect(timers.pendingCount()).toBe(0);
  });

  it("starts a fresh debounce cycle after a max-wait flush", () => {
    const writes: number[][] = [];
    const timers = createTimerScheduler();
    const queue = createQueue(writes, timers);

    queue.send(bytes(1, 2));
    queue.send(bytes(3)); // reset debounce
    timers.run(MAX_WAIT); // force flush
    expect(writes).toEqual([[1, 2, 3]]);

    // New data after flush should start a new debounce + max-wait cycle.
    queue.send(bytes(4, 5));
    expect(timers.pendingCount()).toBe(2); // debounce + max-wait
    timers.run(DEBOUNCE);
    expect(writes).toEqual([
      [1, 2, 3],
      [4, 5],
    ]);
  });

  it("drops buffered output when disposed", () => {
    const write = vi.fn();
    const timers = createTimerScheduler();
    const queue = new TerminalOutputQueue(
      write,
      timers.schedule,
      timers.cancel,
      timers.now,
    );

    queue.send(bytes(1));
    queue.dispose();
    timers.run(DEBOUNCE);
    timers.run(MAX_WAIT);
    queue.send(bytes(2));
    queue.flush();

    expect(write).not.toHaveBeenCalled();
    expect(timers.cancel).toHaveBeenCalledTimes(2);
  });

  it("reschedules once when a fragment arrives near the debounce deadline", () => {
    const writes: number[][] = [];
    const timers = createTimerScheduler();
    const queue = createQueue(writes, timers);

    queue.send(bytes(1));
    timers.advance(3);
    queue.send(bytes(2));

    timers.run(DEBOUNCE);
    expect(writes).toEqual([]);
    expect(timers.schedule).toHaveBeenCalledTimes(3);

    timers.run(3);
    expect(writes).toEqual([[1, 2]]);
  });

  it("holds bytes after an unclosed hide-cursor bracket at the safety-valve flush", () => {
    const writes: number[][] = [];
    const timers = createTimerScheduler();
    const queue = createQueue(writes, timers);

    // Bytes before the hide are safe to render; the hide and everything
    // after it is mid-redraw and must stay queued.
    queue.send(
      bytes(
        0x68,
        0x65,
        0x6c,
        0x6c,
        0x6f,
        0x20,
        0x1b,
        0x5b,
        0x3f,
        0x32,
        0x35,
        0x6c,
        1,
        2,
        3,
      ),
    );

    // Continuous output trips the max-wait valve at 16 ms: only the safe
    // prefix goes out.
    timers.run(MAX_WAIT);
    expect(writes).toEqual([[0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x20]]); // "hello "
    expect(queue.pendingCount()).toBe(9);

    queue.send(bytes(4, 5));
    timers.run(MAX_WAIT);
    // The prefix had already gone out; 4, 5 are still inside the bracket.
    expect(writes).toHaveLength(1);
    expect(queue.pendingCount()).toBe(11);
    // The show closes the frame: the full redraw goes out in one write, in
    // the exact order the program produced it.
    queue.send(bytes(0x1b, 0x5b, 0x3f, 0x32, 0x35, 0x68, 6, 7));
    timers.run(MAX_WAIT);
    expect(writes).toEqual([
      [0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x20],
      [
        0x1b, 0x5b, 0x3f, 0x32, 0x35, 0x6c, 1, 2, 3, 4, 5, 0x1b, 0x5b, 0x3f,
        0x32, 0x35, 0x68, 6, 7,
      ],
    ]);
    expect(queue.pendingCount()).toBe(0);
  });

  it("writes the full frame at once when the close arrives in the same burst", () => {
    const writes: number[][] = [];
    const timers = createTimerScheduler();
    const queue = createQueue(writes, timers);

    queue.send(
      bytes(
        0x1b,
        0x5b,
        0x3f,
        0x32,
        0x35,
        0x6c, // hide
        1,
        2,
        3,
        0x1b,
        0x5b,
        0x3f,
        0x32,
        0x35,
        0x68, // show
        4,
      ),
    );
    timers.run(MAX_WAIT);

    // The whole frame - hide, payload, show, and the trailing byte that
    // landed in the same burst - is written together: the show closed the
    // bracket, and the trailing byte was queued before any flush ran.
    expect(writes).toEqual([
      [
        0x1b, 0x5b, 0x3f, 0x32, 0x35, 0x6c, 1, 2, 3, 0x1b, 0x5b, 0x3f, 0x32,
        0x35, 0x68, 4,
      ],
    ]);
    expect(queue.pendingCount()).toBe(0);
  });

  it("holds a CSI split across send boundaries until it completes", () => {
    const writes: number[][] = [];
    const timers = createTimerScheduler();
    const queue = createQueue(writes, timers);

    // The cursor-position CSI is cut mid-sequence.
    queue.send(bytes(0x1b, 0x5b, 0x31, 0x32, 0x3b, 0x34));
    timers.run(MAX_WAIT);
    expect(writes).toEqual([]);

    // The final byte arrives; the whole sequence is written as one unit.
    queue.send(bytes(0x30, 0x48)); // `0H`
    timers.run(MAX_WAIT);
    expect(writes).toEqual([[0x1b, 0x5b, 0x31, 0x32, 0x3b, 0x34, 0x30, 0x48]]);
  });

  it("holds bytes after an unclosed DECSC and releases them on DECRC", () => {
    const writes: number[][] = [];
    const timers = createTimerScheduler();
    const queue = createQueue(writes, timers);

    queue.send(bytes(0x1b, 0x37, 1, 2)); // ESC 7 (DECSC)
    timers.run(MAX_WAIT);
    expect(writes).toEqual([]);

    // `ESC[s` is the DECSC equivalent; the same bracket must hold it back.
    queue.send(bytes(0x1b, 0x5b, 0x73, 3, 4));
    timers.run(MAX_WAIT);
    expect(writes).toEqual([]);

    // `ESC[u` closes the `ESC[s`; `ESC 7` is still open, so the hold stays.
    queue.send(bytes(0x1b, 0x5b, 0x75));
    timers.run(DEBOUNCE);
    expect(writes).toEqual([]);

    // `ESC 8` (DECRC) closes the remaining bracket: the whole frame goes out.
    queue.send(bytes(0x1b, 0x38, 5));
    timers.run(DEBOUNCE);
    expect(writes).toEqual([
      [
        0x1b, 0x37, 1, 2, 0x1b, 0x5b, 0x73, 3, 4, 0x1b, 0x5b, 0x75, 0x1b, 0x38,
        5,
      ],
    ]);
  });

  it("recognizes hide-cursor in a multi-parameter DECRST", () => {
    const writes: number[][] = [];
    const timers = createTimerScheduler();
    const queue = createQueue(writes, timers);

    // `ESC[?25;1049l` hides the cursor and enters the alternate screen.
    queue.send(
      bytes(
        0x1b,
        0x5b,
        0x3f,
        0x32,
        0x35,
        0x3b,
        0x31,
        0x30,
        0x34,
        0x39,
        0x6c,
        7,
        8,
      ),
    );
    timers.run(MAX_WAIT);
    expect(writes).toEqual([]);

    queue.send(bytes(0x1b, 0x5b, 0x3f, 0x32, 0x35, 0x68));
    timers.run(DEBOUNCE);
    expect(writes).toHaveLength(1);
    expect(concatenated(writes)).toEqual(
      bytes(
        0x1b,
        0x5b,
        0x3f,
        0x32,
        0x35,
        0x3b,
        0x31,
        0x30,
        0x34,
        0x39,
        0x6c,
        7,
        8,
        0x1b,
        0x5b,
        0x3f,
        0x32,
        0x35,
        0x68,
      ),
    );
  });

  it("releases the holdback when MAX_HOLDBACK_MS expires and stays released", () => {
    const writes: number[][] = [];
    const timers = createTimerScheduler();
    const queue = createQueue(writes, timers);

    queue.send(bytes(0x1b, 0x5b, 0x3f, 0x32, 0x35, 0x6c, 1, 2, 3));
    timers.advance(HOLDBACK);
    timers.run();
    expect(writes).toEqual([[0x1b, 0x5b, 0x3f, 0x32, 0x35, 0x6c, 1, 2, 3]]);

    // The bracket state is cleared: a vim that hid the cursor and never
    // restores it must not re-trip the holdback wall on every frame.
    queue.send(bytes(4));
    timers.run(MAX_WAIT);
    expect(writes).toEqual([
      [0x1b, 0x5b, 0x3f, 0x32, 0x35, 0x6c, 1, 2, 3],
      [4],
    ]);

    // A brand-new hide opens a fresh bracket and holds again.
    queue.send(bytes(0x1b, 0x5b, 0x3f, 0x32, 0x35, 0x6c, 5));
    timers.run(MAX_WAIT);
    expect(writes).toHaveLength(2);
    timers.advance(HOLDBACK);
    timers.run();
    expect(concatenated(writes)).toEqual(
      bytes(
        0x1b,
        0x5b,
        0x3f,
        0x32,
        0x35,
        0x6c,
        1,
        2,
        3,
        4,
        0x1b,
        0x5b,
        0x3f,
        0x32,
        0x35,
        0x6c,
        5,
      ),
    );
  });

  it("releases the holdback when MAX_HOLDBACK_BYTES is exceeded", () => {
    const writes: number[][] = [];
    const timers = createTimerScheduler();
    const queue = createQueue(writes, timers);

    queue.send(bytes(0x1b, 0x5b, 0x3f, 0x32, 0x35, 0x6c));
    // 256 KiB of output inside one unclosed bracket must not stay queued.
    const flood = new Uint8Array(256 * 1024);
    queue.send(flood);
    timers.run(MAX_WAIT);

    expect(writes).toHaveLength(1);
    expect(writes[0]).toHaveLength(6 + flood.byteLength);
    expect(queue.pendingCount()).toBe(0);
  });

  it("never drops or reorders bytes across all holdback paths", () => {
    const writes: number[][] = [];
    const timers = createTimerScheduler();
    const queue = createQueue(writes, timers);
    const sent: number[] = [];

    const push = (values: number[]) => {
      sent.push(...values);
      queue.send(bytes(...values));
    };

    push([0x1b, 0x5b, 0x3f, 0x32, 0x35, 0x6c]); // hide
    timers.run(MAX_WAIT);
    push([10, 11, 0x1b]); // mid-sequence fragment
    timers.run(MAX_WAIT);
    push([0x5b, 0x3f, 0x32, 0x35, 0x68, 12]); // rest of the show + more
    timers.run(DEBOUNCE);

    expect(concatenated(writes)).toEqual(Uint8Array.from(sent));
  });

  it("hands xterm bytes it owns, not a view that later output rewrites", () => {
    // xterm's WriteBuffer stores the array it is given and parses it on a
    // later macrotask, so a view into the queue's own storage is read after
    // the queue has compacted and refilled it - xterm ends up parsing a newer
    // frame's cursor addressing in place of the bytes it was handed.
    const handedOut: Uint8Array[] = [];
    const timers = createTimerScheduler();
    const queue = new TerminalOutputQueue(
      (data) => handedOut.push(data),
      timers.schedule,
      timers.cancel,
      timers.now,
    );

    // Each chunk is filled with its own marker, and 6 KiB a piece cycles well
    // past the 32 KiB internal buffer so compaction runs several times.
    const markers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    for (const marker of markers) {
      queue.send(new Uint8Array(6 * 1024).fill(marker));
      timers.run(DEBOUNCE);
    }

    expect(handedOut).toHaveLength(markers.length);
    // Read every buffer only now, the way a deferred parse would.
    expect(handedOut.map((data) => [...new Set(data)])).toEqual(
      markers.map((marker) => [marker]),
    );
  });

  it("keeps writing after the holdback valve releases a partial sequence", () => {
    const writes: number[][] = [];
    const timers = createTimerScheduler();
    const queue = createQueue(writes, timers);

    // Hide the cursor, then flood past MAX_HOLDBACK_BYTES ending mid-CSI, so
    // the valve releases a tail whose escape sequence is still unfinished.
    queue.send(bytes(0x1b, 0x5b, 0x3f, 0x32, 0x35, 0x6c));
    const flood = new Uint8Array(256 * 1024);
    flood[flood.length - 2] = 0x1b;
    flood[flood.length - 1] = 0x5b; // trailing `ESC[`
    queue.send(flood);
    timers.run(MAX_WAIT);
    expect(queue.pendingCount()).toBe(0);

    // The scanner is still mid-sequence over bytes xterm already has, and its
    // parser carries that state itself. A fragment that does not finish the
    // sequence must not be cut behind the already-written `ESC[`, which leaves
    // the queue with nothing to write and no timer to retry.
    queue.send(bytes(0x33)); // a CSI parameter byte, sequence still open
    timers.run(DEBOUNCE);
    expect(writes.at(-1)).toEqual([0x33]);
    expect(queue.pendingCount()).toBe(0);
  });

  it("re-arms both timers after flush() on an empty queue", () => {
    const writes: number[][] = [];
    const timers = createTimerScheduler();
    const queue = createQueue(writes, timers);

    queue.send(bytes(1, 2, 3));
    queue.flush();
    expect(queue.pendingCount()).toBe(0);
    expect(timers.pendingCount()).toBe(0);

    // The leaked max-wait handle from the previous flush must not inherit its
    // old deadline into the new cycle.
    queue.send(bytes(4, 5));
    expect(timers.pendingCount()).toBe(2); // debounce + max-wait
    timers.run(DEBOUNCE);
    expect(writes).toEqual([
      [1, 2, 3],
      [4, 5],
    ]);
    expect(timers.pendingCount()).toBe(0);
  });
});
