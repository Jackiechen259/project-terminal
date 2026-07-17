/**
 * Zustand store for SSH connections. Loaded once at app start (the list is
 * small) and reloaded after create/update/delete.
 */

import { create } from "zustand";

import {
  sshService,
  type FrontendError,
  type SshConnectionInput,
} from "@/services";
import type { SshConnection } from "@/types";

export interface SshStoreState {
  connections: SshConnection[];
  loading: boolean;
  error: FrontendError | null;
  sshClientPath: string | null | undefined; // undefined = not detected yet

  loadConnections: () => Promise<void>;
  detectSshClient: () => Promise<void>;
  createConnection: (input: SshConnectionInput) => Promise<SshConnection>;
  updateConnection: (input: SshConnectionInput) => Promise<SshConnection>;
  deleteConnection: (id: string) => Promise<void>;
  clearError: () => void;
}

export const useSshStore = create<SshStoreState>((set, get) => ({
  connections: [],
  loading: false,
  error: null,
  sshClientPath: undefined,

  loadConnections: async () => {
    set({ loading: true, error: null });
    try {
      const connections = await sshService.list();
      set({ connections, loading: false });
    } catch (e) {
      set({ loading: false, error: e as FrontendError });
    }
  },

  detectSshClient: async () => {
    try {
      const path = await sshService.detect();
      set({ sshClientPath: path });
    } catch (e) {
      set({ error: e as FrontendError });
    }
  },

  createConnection: async (input) => {
    const conn = await sshService.create(input);
    set({ connections: [...get().connections, conn] });
    return conn;
  },

  updateConnection: async (input) => {
    const updated = await sshService.update(input);
    set({
      connections: get().connections.map((c) =>
        c.id === updated.id ? updated : c,
      ),
    });
    return updated;
  },

  deleteConnection: async (id) => {
    await sshService.delete(id);
    set({ connections: get().connections.filter((c) => c.id !== id) });
  },

  clearError: () => set({ error: null }),
}));
