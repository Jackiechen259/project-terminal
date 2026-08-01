/**
 * Zustand store for reusable profile templates. Templates are global
 * (project-independent); they are loaded once and cached in `templates`.
 */

import { create } from "zustand";

import {
  templateService,
  type FrontendError,
  type TemplateInput,
  type WindowsTerminalScanResult,
  type WindowsTerminalTemplateImportResult,
} from "@/services";
import type { ProfileTemplate } from "@/types";

export interface TemplateStoreState {
  templates: ProfileTemplate[];
  loaded: boolean;
  loading: boolean;
  error: FrontendError | null;

  loadTemplates: () => Promise<void>;
  createTemplate: (input: TemplateInput) => Promise<ProfileTemplate>;
  updateTemplate: (input: TemplateInput) => Promise<ProfileTemplate>;
  deleteTemplate: (id: string) => Promise<void>;
  scanWindowsTerminal: () => Promise<WindowsTerminalScanResult>;
  importFromWindowsTerminal: (
    keys: string[],
  ) => Promise<WindowsTerminalTemplateImportResult>;
  clearError: () => void;
}

export const useTemplateStore = create<TemplateStoreState>((set, get) => ({
  templates: [],
  loaded: false,
  loading: false,
  error: null,

  loadTemplates: async () => {
    set({ loading: true, error: null });
    try {
      const templates = await templateService.list();
      set({ templates, loaded: true, loading: false });
    } catch (e) {
      set({ error: e as FrontendError, loading: false });
    }
  },

  createTemplate: async (input) => {
    const template = await templateService.create(input);
    set({ templates: [...get().templates, template] });
    return template;
  },

  updateTemplate: async (input) => {
    const updated = await templateService.update(input);
    set({
      templates: get().templates.map((t) =>
        t.id === updated.id ? updated : t,
      ),
    });
    return updated;
  },

  deleteTemplate: async (id) => {
    await templateService.delete(id);
    set({ templates: get().templates.filter((t) => t.id !== id) });
  },

  // Read-only preview of what the settings files offer; touches no state.
  scanWindowsTerminal: () => templateService.scanWindowsTerminal(),

  importFromWindowsTerminal: async (keys) => {
    const result = await templateService.importWindowsTerminal(keys);
    if (result.imported.length) {
      const importedIds = new Set(result.imported.map((item) => item.id));
      set({
        templates: [
          ...get().templates.filter((item) => !importedIds.has(item.id)),
          ...result.imported,
        ],
        loaded: true,
      });
    }
    return result;
  },

  clearError: () => set({ error: null }),
}));
