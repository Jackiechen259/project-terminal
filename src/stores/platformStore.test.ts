import { beforeEach, describe, expect, it, vi } from "vitest";

import { usePlatformStore } from "@/stores/platformStore";
import { platformService } from "@/services";
import type { PlatformInfo } from "@/types";

vi.mock("@/services", () => ({
  platformService: {
    getPlatformInfo: vi.fn(),
  },
}));

const platformServiceMock = vi.mocked(platformService);

beforeEach(() => {
  vi.clearAllMocks();
  usePlatformStore.setState({ info: null, loading: false, error: null });
});

describe("platformStore", () => {
  describe("load", () => {
    it("stores the backend snapshot on success", async () => {
      const info: PlatformInfo = {
        os: "linux",
        wslSupported: false,
        availableProjectTypes: ["local", "ssh"],
        availableLocalShells: ["bash", "zsh", "custom"],
        defaultLocalShell: "bash",
      };
      platformServiceMock.getPlatformInfo.mockResolvedValueOnce(info);
      const result = await usePlatformStore.getState().load();
      expect(result).toEqual(info);
      expect(usePlatformStore.getState().info).toEqual(info);
      expect(usePlatformStore.getState().loading).toBe(false);
      expect(usePlatformStore.getState().error).toBeNull();
    });

    it("falls back to a Windows-shaped snapshot when the backend fails", async () => {
      platformServiceMock.getPlatformInfo.mockRejectedValueOnce({
        code: "unknown",
        message: "command missing",
      });
      const result = await usePlatformStore.getState().load();
      expect(result?.wslSupported).toBe(true);
      expect(usePlatformStore.getState().info?.wslSupported).toBe(true);
      expect(usePlatformStore.getState().error).toBe("command missing");
    });

    it("coalesces concurrent callers onto a single backend request", async () => {
      const info: PlatformInfo = {
        os: "windows",
        wslSupported: true,
        availableProjectTypes: ["local", "wsl", "ssh"],
        availableLocalShells: [
          "powershell",
          "cmd",
          "git-bash",
          "wsl",
          "custom",
        ],
        defaultLocalShell: "powershell",
      };
      platformServiceMock.getPlatformInfo.mockResolvedValueOnce(info);
      const [a, b] = await Promise.all([
        usePlatformStore.getState().load(),
        usePlatformStore.getState().load(),
      ]);
      expect(a).toEqual(info);
      expect(b).toEqual(info);
      expect(platformServiceMock.getPlatformInfo).toHaveBeenCalledTimes(1);
    });

    it("re-issues the request after a prior load settles", async () => {
      const first: PlatformInfo = {
        os: "windows",
        wslSupported: true,
        availableProjectTypes: ["local", "wsl", "ssh"],
        availableLocalShells: [
          "powershell",
          "cmd",
          "git-bash",
          "wsl",
          "custom",
        ],
        defaultLocalShell: "powershell",
      };
      platformServiceMock.getPlatformInfo.mockResolvedValueOnce(first);
      await usePlatformStore.getState().load();
      const second: PlatformInfo = {
        os: "linux",
        wslSupported: false,
        availableProjectTypes: ["local", "ssh"],
        availableLocalShells: ["bash", "custom"],
        defaultLocalShell: "bash",
      };
      platformServiceMock.getPlatformInfo.mockResolvedValueOnce(second);
      await usePlatformStore.getState().load();
      expect(platformServiceMock.getPlatformInfo).toHaveBeenCalledTimes(2);
      expect(usePlatformStore.getState().info).toEqual(second);
    });
  });
});
