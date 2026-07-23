import { describe, expect, it, vi } from "vitest";

import { TerminalOutputQueue } from "./terminalOutputQueue";

function createFrameScheduler() {
  let nextHandle = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const schedule = vi.fn((callback: FrameRequestCallback) => {
    const handle = nextHandle++;
    callbacks.set(handle, callback);
    return handle;
  });
  const cancel = vi.fn((handle: number) => {
    callbacks.delete(handle);
  });
  const runFrame = () => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const callback of pending) callback(0);
  };

  return { schedule, cancel, runFrame };
}

describe("TerminalOutputQueue", () => {
  it("combines same-frame PTY fragments in their original order", () => {
    const writes: number[][] = [];
    const frames = createFrameScheduler();
    const queue = new TerminalOutputQueue(
      (data) => writes.push([...data]),
      frames.schedule,
      frames.cancel,
    );

    queue.send(Uint8Array.from([1, 2]));
    queue.send(Uint8Array.from([3]));
    queue.send(Uint8Array.from([4, 5]));

    expect(frames.schedule).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);

    frames.runFrame();
    expect(writes).toEqual([[1, 2, 3, 4, 5]]);
  });

  it("flushes pending output immediately and cancels the scheduled frame", () => {
    const writes: number[][] = [];
    const frames = createFrameScheduler();
    const queue = new TerminalOutputQueue(
      (data) => writes.push([...data]),
      frames.schedule,
      frames.cancel,
    );

    queue.send(Uint8Array.from([1, 2, 3]));
    queue.flush();

    expect(writes).toEqual([[1, 2, 3]]);
    expect(frames.cancel).toHaveBeenCalledTimes(1);

    frames.runFrame();
    expect(writes).toHaveLength(1);
  });

  it("drops buffered output when disposed", () => {
    const write = vi.fn();
    const frames = createFrameScheduler();
    const queue = new TerminalOutputQueue(
      write,
      frames.schedule,
      frames.cancel,
    );

    queue.send(Uint8Array.from([1]));
    queue.dispose();
    frames.runFrame();
    queue.send(Uint8Array.from([2]));
    queue.flush();

    expect(write).not.toHaveBeenCalled();
    expect(frames.cancel).toHaveBeenCalledTimes(1);
  });
});
