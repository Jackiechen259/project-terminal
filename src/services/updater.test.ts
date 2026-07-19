import { describe, expect, it, vi } from "vitest";

const { check, relaunch } = vi.hoisted(() => ({
  check: vi.fn(),
  relaunch: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch }));

import { checkForUpdate, installUpdate, type AvailableUpdate } from "./updater";

describe("updater service", () => {
  it("delegates signed-release checks to the Tauri updater", async () => {
    const available = { version: "0.2.0" };
    check.mockResolvedValue(available);

    await expect(checkForUpdate()).resolves.toBe(available);
    expect(check).toHaveBeenCalledOnce();
  });

  it("reports download progress and restarts after installation", async () => {
    const downloadAndInstall = vi.fn(async (onEvent) => {
      onEvent({ event: "Started", data: { contentLength: 100 } });
      onEvent({ event: "Progress", data: { chunkLength: 40 } });
      onEvent({ event: "Progress", data: { chunkLength: 60 } });
    });
    const progress: Array<{ downloaded: number; total?: number }> = [];

    await installUpdate(
      { downloadAndInstall } as unknown as AvailableUpdate,
      (next) => progress.push(next),
    );

    expect(progress).toEqual([
      { downloaded: 40, total: 100 },
      { downloaded: 100, total: 100 },
    ]);
    expect(relaunch).toHaveBeenCalledOnce();
  });
});
