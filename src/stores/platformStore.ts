/**
 * Platform capability store.
 *
 * Holds the single `PlatformInfo` snapshot loaded from the backend at startup.
 * Components read `wslSupported`, `availableProjectTypes`,
 * `availableLocalShells`, and `defaultLocalShell` from here instead of
 * hardcoding `navigator.platform` / `process.platform` checks - saved
 * profiles stay portable across hosts that way.
 *
 * `load()` is called once during app bootstrap. The snapshot is immutable for
 * the rest of the session; concurrent callers reuse the cached promise.
 */

import { create } from "zustand";

import { platformService } from "@/services";
import type { PlatformInfo } from "@/types";

interface PlatformStoreState {
  info: PlatformInfo | null;
  loading: boolean;
  error: string | null;
  load: () => Promise<PlatformInfo | null>;
}

const FALLBACK_INFO: PlatformInfo = {
  os: "windows",
  wslSupported: true,
  availableProjectTypes: ["local", "wsl", "ssh"],
  availableLocalShells: ["powershell", "cmd", "git-bash", "wsl", "custom"],
  defaultLocalShell: "powershell",
};

function errorMessage(cause: unknown): string {
  if (
    cause !== null &&
    typeof cause === "object" &&
    "message" in cause &&
    typeof (cause as { message?: unknown }).message === "string"
  ) {
    return (cause as { message: string }).message;
  }
  return typeof cause === "string" ? cause : "Unexpected error";
}

export const usePlatformStore = create<PlatformStoreState>((set) => {
  let inflight: Promise<PlatformInfo | null> | null = null;
  return {
    info: null,
    loading: false,
    error: null,
    load: async () => {
      if (inflight) return inflight;
      // Coalesce concurrent callers onto a single load.
      inflight = (async () => {
        set({ loading: true, error: null });
        try {
          const info = await platformService.getPlatformInfo();
          set({ info, loading: false });
          return info;
        } catch (e) {
          // Fall back to a Windows-shaped snapshot so the app remains usable
          // even if the backend command is unavailable (e.g. dev mode running
          // only the frontend). Surface the error so it is not silent.
          set({
            info: FALLBACK_INFO,
            loading: false,
            error: errorMessage(e),
          });
          return FALLBACK_INFO;
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },
  };
});
