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

const DEBOUNCE = 4;
const MAX_WAIT = 16;

describe("TerminalOutputQueue", () => {
  it("combines fragments that arrive within the debounce window", () => {
    const writes: number[][] = [];
    const timers = createTimerScheduler();
    const queue = new TerminalOutputQueue(
      (data) => writes.push([...data]),
      timers.schedule,
      timers.cancel,
      timers.now,
    );

    queue.send(Uint8Array.from([1, 2]));
    queue.send(Uint8Array.from([3]));
    queue.send(Uint8Array.from([4, 5]));

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
    const queue = new TerminalOutputQueue(
      (data) => writes.push([...data]),
      timers.schedule,
      timers.cancel,
      timers.now,
    );

    queue.send(Uint8Array.from([1, 2, 3]));
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
    const queue = new TerminalOutputQueue(
      (data) => writes.push([...data]),
      timers.schedule,
      timers.cancel,
      timers.now,
    );

    // Simulate continuous data: the max-wait timer must force a flush even
    // when the quiet-window deadline keeps moving.
    queue.send(Uint8Array.from([1]));
    queue.send(Uint8Array.from([2]));
    queue.send(Uint8Array.from([3]));

    expect(writes).toEqual([]);

    timers.run(MAX_WAIT);
    expect(writes).toEqual([[1, 2, 3]]);
    expect(timers.pendingCount()).toBe(0);
  });

  it("starts a fresh debounce cycle after a max-wait flush", () => {
    const writes: number[][] = [];
    const timers = createTimerScheduler();
    const queue = new TerminalOutputQueue(
      (data) => writes.push([...data]),
      timers.schedule,
      timers.cancel,
      timers.now,
    );

    queue.send(Uint8Array.from([1, 2]));
    queue.send(Uint8Array.from([3])); // reset debounce
    timers.run(MAX_WAIT); // force flush
    expect(writes).toEqual([[1, 2, 3]]);

    // New data after flush should start a new debounce + max-wait cycle.
    queue.send(Uint8Array.from([4, 5]));
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

    queue.send(Uint8Array.from([1]));
    queue.dispose();
    timers.run(DEBOUNCE);
    timers.run(MAX_WAIT);
    queue.send(Uint8Array.from([2]));
    queue.flush();

    expect(write).not.toHaveBeenCalled();
    expect(timers.cancel).toHaveBeenCalledTimes(2);
  });

  it("reschedules once when a fragment arrives near the debounce deadline", () => {
    const writes: number[][] = [];
    const timers = createTimerScheduler();
    const queue = new TerminalOutputQueue(
      (data) => writes.push([...data]),
      timers.schedule,
      timers.cancel,
      timers.now,
    );

    queue.send(Uint8Array.from([1]));
    timers.advance(3);
    queue.send(Uint8Array.from([2]));

    timers.run(DEBOUNCE);
    expect(writes).toEqual([]);
    expect(timers.schedule).toHaveBeenCalledTimes(3);

    timers.run(3);
    expect(writes).toEqual([[1, 2]]);
  });
});
