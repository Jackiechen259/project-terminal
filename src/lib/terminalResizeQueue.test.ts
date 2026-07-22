import { describe, expect, it, vi } from "vitest";

import { TerminalResizeQueue } from "./terminalResizeQueue";

describe("TerminalResizeQueue", () => {
  it("uses the newest size observed while the PTY is starting", async () => {
    const resize = vi.fn(async () => undefined);
    const queue = new TerminalResizeQueue(resize);

    queue.request(24, 80);
    queue.request(32, 120);
    queue.attach("session-1", { rows: 24, cols: 80 });
    await queue.whenIdle();

    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith("session-1", 32, 120);
  });

  it("serializes writes and coalesces in-flight changes to the latest size", async () => {
    let releaseFirstResize: (() => void) | undefined;
    const firstResize = new Promise<void>((resolve) => {
      releaseFirstResize = resolve;
    });
    const sizes: Array<[number, number]> = [];
    const resize = vi.fn(async (_sessionId, rows: number, cols: number) => {
      sizes.push([rows, cols]);
      if (sizes.length === 1) await firstResize;
    });
    const queue = new TerminalResizeQueue(resize);

    queue.attach("session-1", { rows: 24, cols: 80 });
    queue.request(30, 100);
    await Promise.resolve();
    queue.request(31, 110);
    queue.request(32, 120);

    expect(sizes).toEqual([[30, 100]]);
    releaseFirstResize?.();
    await queue.whenIdle();
    expect(sizes).toEqual([
      [30, 100],
      [32, 120],
    ]);
  });

  it("does not resend dimensions already applied during PTY creation", async () => {
    const resize = vi.fn(async () => undefined);
    const queue = new TerminalResizeQueue(resize);

    queue.request(24, 80);
    queue.attach("session-1", { rows: 24, cols: 80 });
    await queue.whenIdle();

    expect(resize).not.toHaveBeenCalled();
  });
});
