import { create } from "zustand";
import { persist } from "zustand/middleware";

export const MIN_TERMINAL_FONT_SIZE = 10;
export const MAX_TERMINAL_FONT_SIZE = 24;
export const MIN_TERMINAL_SCROLLBACK_LINES = 1_000;
export const MAX_TERMINAL_SCROLLBACK_LINES = 100_000;
export const MIN_TERMINAL_SCROLLBACK_MEGABYTES = 1;
export const MAX_TERMINAL_SCROLLBACK_MEGABYTES = 32;
export type AppLanguage = "en" | "zh-CN";
export type AppTheme = "dark" | "eye-care" | "light";

export interface GeneralSettings {
  language: AppLanguage;
  theme: AppTheme;
  restoreLastProject: boolean;
  confirmCloseTerminal: boolean;
  showTerminalCount: boolean;
  terminalFontSize: number;
  terminalScrollbackLines: number;
  terminalScrollbackMegabytes: number;
  cursorBlink: boolean;
  autoCheckForUpdates: boolean;
}

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  language: "en",
  theme: "dark",
  restoreLastProject: true,
  confirmCloseTerminal: true,
  showTerminalCount: true,
  terminalFontSize: 14,
  terminalScrollbackLines: 10_000,
  terminalScrollbackMegabytes: 4,
  cursorBlink: true,
  autoCheckForUpdates: true,
};

interface SettingsStoreState extends GeneralSettings {
  lastProjectId: string | null;
  updateGeneralSettings: (patch: Partial<GeneralSettings>) => void;
  rememberProject: (projectId: string | null) => void;
  resetGeneralSettings: () => void;
}

export function clampTerminalFontSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_GENERAL_SETTINGS.terminalFontSize;
  return Math.min(
    MAX_TERMINAL_FONT_SIZE,
    Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(value)),
  );
}

export function clampTerminalScrollbackLines(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_GENERAL_SETTINGS.terminalScrollbackLines;
  }
  return Math.min(
    MAX_TERMINAL_SCROLLBACK_LINES,
    Math.max(MIN_TERMINAL_SCROLLBACK_LINES, Math.round(value)),
  );
}

export function clampTerminalScrollbackMegabytes(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_GENERAL_SETTINGS.terminalScrollbackMegabytes;
  }
  return Math.min(
    MAX_TERMINAL_SCROLLBACK_MEGABYTES,
    Math.max(MIN_TERMINAL_SCROLLBACK_MEGABYTES, Math.round(value)),
  );
}

export const useSettingsStore = create<SettingsStoreState>()(
  persist(
    (set) => ({
      ...DEFAULT_GENERAL_SETTINGS,
      lastProjectId: null,

      updateGeneralSettings: (patch) =>
        set((state) => ({
          ...patch,
          terminalFontSize:
            patch.terminalFontSize === undefined
              ? state.terminalFontSize
              : clampTerminalFontSize(patch.terminalFontSize),
          terminalScrollbackLines:
            patch.terminalScrollbackLines === undefined
              ? state.terminalScrollbackLines
              : clampTerminalScrollbackLines(patch.terminalScrollbackLines),
          terminalScrollbackMegabytes:
            patch.terminalScrollbackMegabytes === undefined
              ? state.terminalScrollbackMegabytes
              : clampTerminalScrollbackMegabytes(
                  patch.terminalScrollbackMegabytes,
                ),
        })),

      rememberProject: (lastProjectId) => set({ lastProjectId }),

      resetGeneralSettings: () => set({ ...DEFAULT_GENERAL_SETTINGS }),
    }),
    {
      name: "project-terminal.general-settings",
      version: 1,
      partialize: (state) => ({
        language: state.language,
        theme: state.theme,
        restoreLastProject: state.restoreLastProject,
        confirmCloseTerminal: state.confirmCloseTerminal,
        showTerminalCount: state.showTerminalCount,
        terminalFontSize: state.terminalFontSize,
        terminalScrollbackLines: state.terminalScrollbackLines,
        terminalScrollbackMegabytes: state.terminalScrollbackMegabytes,
        cursorBlink: state.cursorBlink,
        autoCheckForUpdates: state.autoCheckForUpdates,
        lastProjectId: state.lastProjectId,
      }),
    },
  ),
);
