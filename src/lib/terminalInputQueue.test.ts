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

  it("keeps binary chunks byte-exact and ordered against text", async () => {
    const calls: Array<{ kind: "text" | "binary"; data: string | number[] }> =
      [];
    const write = vi.fn(async (_sessionId: string, data: string) => {
      calls.push({ kind: "text", data });
    });
    const writeBinary = vi.fn(async (_sessionId: string, data: Uint8Array) => {
      calls.push({ kind: "binary", data: Array.from(data) });
    });
    const queue = new TerminalInputQueue(write, writeBinary);

    queue.attach("session-1");
    queue.send("abc");
    // A legacy-encoding mouse report: `CSI M` then button, column, row as raw
    // byte values. 0xe9 must arrive as one byte, not as UTF-8's 0xc3 0xa9.
    queue.sendBinary("\x1b[M\x20\xe9\x24");
    queue.send("d");
    await queue.whenIdle();

    expect(calls).toEqual([
      { kind: "text", data: "abc" },
      { kind: "binary", data: [0x1b, 0x5b, 0x4d, 0x20, 0xe9, 0x24] },
      { kind: "text", data: "d" },
    ]);
  });

  it("coalesces only adjacent chunks of the same kind", async () => {
    const calls: string[] = [];
    const write = vi.fn(async (_sessionId: string, data: string) => {
      calls.push(`text:${data}`);
    });
    const writeBinary = vi.fn(async (_sessionId: string, data: Uint8Array) => {
      calls.push(`binary:${data.length}`);
    });
    const queue = new TerminalInputQueue(write, writeBinary);

    queue.send("a");
    queue.send("b");
    queue.sendBinary("\xff");
    queue.sendBinary("\xfe");
    queue.attach("session-1");
    await queue.whenIdle();

    expect(calls).toEqual(["text:ab", "binary:2"]);
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
