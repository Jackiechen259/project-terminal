import { describe, expect, it, vi } from "vitest";

import { TerminalInputQueue } from "./terminalInputQueue";

describe("TerminalInputQueue", () => {
  it("buffers input until the PTY session is attached", async () => {
    const write = vi.fn(async () => undefined);
    const queue = new TerminalInputQueue(write);

    queue.send("hello");
    expect(write).not.toHaveBeenCalled();

    queue.attach("session-1");
    await queue.whenIdle();
    expect(write).toHaveBeenCalledWith("session-1", "hello");
  });

  it("preserves order and batches input received during an IPC write", async () => {
    let releaseFirstWrite: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const writes: string[] = [];
    const write = vi.fn(async (_sessionId: string, data: string) => {
      writes.push(data);
      if (writes.length === 1) await firstWrite;
    });
    const queue = new TerminalInputQueue(write);

    queue.attach("session-1");
    queue.send("a");
    await Promise.resolve();
    queue.send("b");
    queue.send("c");

    expect(writes).toEqual(["a"]);
    releaseFirstWrite?.();
    await queue.whenIdle();
    expect(writes).toEqual(["a", "bc"]);
  });

  it("drops buffered input after disposal", async () => {
    const write = vi.fn(async () => undefined);
    const queue = new TerminalInputQueue(write);

    queue.send("stale");
    queue.dispose();
    queue.attach("session-1");
    await queue.whenIdle();

    expect(write).not.toHaveBeenCalled();
  });
});
