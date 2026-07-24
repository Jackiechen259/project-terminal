import { create } from "zustand";

import { daemonService, type DaemonStatus } from "@/services";

interface DaemonStoreState {
  status: DaemonStatus | null;
  checking: boolean;
  refresh: () => Promise<void>;
  reconnect: () => Promise<void>;
}

export const useDaemonStore = create<DaemonStoreState>((set) => ({
  status: null,
  checking: false,
  refresh: async () => {
    set({ checking: true });
    try {
      set({ status: await daemonService.status() });
    } catch (error) {
      set({
        status: {
          connected: false,
          endpoint: "",
          error: (error as { message?: string }).message ?? "Unavailable",
        },
      });
    } finally {
      set({ checking: false });
    }
  },
  reconnect: async () => {
    set({ checking: true });
    try {
      set({ status: await daemonService.reconnect() });
    } finally {
      set({ checking: false });
    }
  },
}));
