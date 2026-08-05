import { create } from "zustand";
import { persist } from "zustand/middleware";

import { FOLLOW_APP_THEME } from "@/lib/terminalColorSchemes";
import { sanitizeFontFamily } from "@/lib/terminalFonts";
import { createThrottledJSONStorage } from "@/lib/throttledStorage";

export const MIN_TERMINAL_FONT_SIZE = 10;
export const MAX_TERMINAL_FONT_SIZE = 24;
export const MIN_TERMINAL_SCROLLBACK_LINES = 1_000;
export const MAX_TERMINAL_SCROLLBACK_LINES = 100_000;
export const MIN_TERMINAL_SCROLLBACK_MEGABYTES = 1;
export const MAX_TERMINAL_SCROLLBACK_MEGABYTES = 32;
/** CSS font-weight range. The bundled font's variable axis is 200-700. */
export const MIN_TERMINAL_FONT_WEIGHT = 100;
export const MAX_TERMINAL_FONT_WEIGHT = 900;
/** Below 1 clips descenders; above ~1.8 the grid stops reading as a grid. */
export const MIN_TERMINAL_LINE_HEIGHT = 1;
export const MAX_TERMINAL_LINE_HEIGHT = 1.8;
export const MIN_TERMINAL_LETTER_SPACING = -1;
export const MAX_TERMINAL_LETTER_SPACING = 3;
export const MIN_TERMINAL_PADDING = 0;
export const MAX_TERMINAL_PADDING = 24;
/** `0` derives the contrast from the colour scheme instead of forcing one. */
export const TERMINAL_CONTRAST_CHOICES = [0, 1, 4.5, 7] as const;
export type AppLanguage = "en" | "zh-CN";
export type AppTheme = "dark" | "eye-care" | "light";

export interface GeneralSettings {
  language: AppLanguage;
  theme: AppTheme;
  restoreLastProject: boolean;
  confirmCloseTerminal: boolean;
  confirmDeleteProject: boolean;
  showTerminalCount: boolean;
  openFileSidebarByDefault: boolean;
  /**
   * Terminal colour scheme id, or the `follow-app-theme` sentinel.
   *
   * A sentinel rather than a concrete default so an existing installation
   * sees no change on upgrade - the palette stays tied to the app theme until
   * the user picks something else.
   */
  terminalColorScheme: string;
  /**
   * Terminal font family name only, not a full CSS stack. Empty means "use
   * the bundled font"; `buildTerminalFontStack` appends the fallbacks.
   */
  terminalFontFamily: string;
  terminalFontSize: number;
  /** Weight of normal text. Uses the bundled font's variable axis. */
  terminalFontWeight: number;
  terminalFontWeightBold: number;
  /** Multiplier on the font size. Below 1 clips descenders. */
  terminalLineHeight: number;
  /** Extra pixels between cells. Negative tightens. */
  terminalLetterSpacing: number;
  terminalCursorStyle: "block" | "bar" | "underline";
  /** How the cursor draws in a split pane that does not have focus. */
  terminalCursorInactiveStyle:
    "outline" | "block" | "bar" | "underline" | "none";
  /** Padding between the terminal grid and its container, in pixels. */
  terminalPadding: number;
  /**
   * Contrast xterm enforces between text and background.
   *
   * `0` means derive it from the colour scheme's background, which is the
   * right answer almost always. The override exists because agent output
   * frequently uses dim truecolor that is unreadable at the palette's own
   * contrast, even on a dark background.
   */
  terminalMinimumContrast: number;
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
  confirmDeleteProject: true,
  showTerminalCount: true,
  openFileSidebarByDefault: false,
  terminalColorScheme: FOLLOW_APP_THEME,
  terminalFontFamily: "",
  terminalFontSize: 14,
  terminalFontWeight: 400,
  terminalFontWeightBold: 700,
  terminalLineHeight: 1.2,
  terminalLetterSpacing: 0,
  terminalCursorStyle: "block",
  terminalCursorInactiveStyle: "outline",
  terminalPadding: 10,
  terminalMinimumContrast: 0,
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

/** Clamp into `[min, max]`, falling back to `fallback` for a non-number. */
function clampNumber(
  value: number,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function clampTerminalFontWeight(value: number): number {
  return Math.round(
    clampNumber(
      value,
      MIN_TERMINAL_FONT_WEIGHT,
      MAX_TERMINAL_FONT_WEIGHT,
      DEFAULT_GENERAL_SETTINGS.terminalFontWeight,
    ),
  );
}

export function clampTerminalLineHeight(value: number): number {
  const clamped = clampNumber(
    value,
    MIN_TERMINAL_LINE_HEIGHT,
    MAX_TERMINAL_LINE_HEIGHT,
    DEFAULT_GENERAL_SETTINGS.terminalLineHeight,
  );
  // Two decimals: the cell height is rounded to a pixel anyway, and a long
  // float in the persisted blob is just noise.
  return Math.round(clamped * 100) / 100;
}

export function clampTerminalLetterSpacing(value: number): number {
  return (
    Math.round(
      clampNumber(
        value,
        MIN_TERMINAL_LETTER_SPACING,
        MAX_TERMINAL_LETTER_SPACING,
        DEFAULT_GENERAL_SETTINGS.terminalLetterSpacing,
      ) * 10,
    ) / 10
  );
}

export function clampTerminalPadding(value: number): number {
  return Math.round(
    clampNumber(
      value,
      MIN_TERMINAL_PADDING,
      MAX_TERMINAL_PADDING,
      DEFAULT_GENERAL_SETTINGS.terminalPadding,
    ),
  );
}

/** Snap to an offered choice; anything else falls back to "derive it". */
export function clampTerminalMinimumContrast(value: number): number {
  return TERMINAL_CONTRAST_CHOICES.includes(
    value as (typeof TERMINAL_CONTRAST_CHOICES)[number],
  )
    ? value
    : DEFAULT_GENERAL_SETTINGS.terminalMinimumContrast;
}

type PersistedSettings = GeneralSettings & { lastProjectId: string | null };

export const generalSettingsStorage =
  createThrottledJSONStorage<PersistedSettings>();

export const useSettingsStore = create<SettingsStoreState>()(
  persist(
    (set) => ({
      ...DEFAULT_GENERAL_SETTINGS,
      lastProjectId: null,

      updateGeneralSettings: (patch) =>
        set((state) => ({
          ...patch,
          // This value is interpolated into a CSS font-family declaration.
          terminalFontFamily:
            patch.terminalFontFamily === undefined
              ? state.terminalFontFamily
              : sanitizeFontFamily(patch.terminalFontFamily),
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
          terminalFontWeight:
            patch.terminalFontWeight === undefined
              ? state.terminalFontWeight
              : clampTerminalFontWeight(patch.terminalFontWeight),
          terminalFontWeightBold:
            patch.terminalFontWeightBold === undefined
              ? state.terminalFontWeightBold
              : clampTerminalFontWeight(patch.terminalFontWeightBold),
          terminalLineHeight:
            patch.terminalLineHeight === undefined
              ? state.terminalLineHeight
              : clampTerminalLineHeight(patch.terminalLineHeight),
          terminalLetterSpacing:
            patch.terminalLetterSpacing === undefined
              ? state.terminalLetterSpacing
              : clampTerminalLetterSpacing(patch.terminalLetterSpacing),
          terminalPadding:
            patch.terminalPadding === undefined
              ? state.terminalPadding
              : clampTerminalPadding(patch.terminalPadding),
          terminalMinimumContrast:
            patch.terminalMinimumContrast === undefined
              ? state.terminalMinimumContrast
              : clampTerminalMinimumContrast(patch.terminalMinimumContrast),
        })),

      rememberProject: (lastProjectId) => set({ lastProjectId }),

      resetGeneralSettings: () => set({ ...DEFAULT_GENERAL_SETTINGS }),
    }),
    {
      name: "project-terminal.general-settings",
      version: 1,
      storage: generalSettingsStorage,
      partialize: (state): PersistedSettings => ({
        language: state.language,
        theme: state.theme,
        restoreLastProject: state.restoreLastProject,
        confirmCloseTerminal: state.confirmCloseTerminal,
        confirmDeleteProject: state.confirmDeleteProject,
        showTerminalCount: state.showTerminalCount,
        openFileSidebarByDefault: state.openFileSidebarByDefault,
        terminalColorScheme: state.terminalColorScheme,
        terminalFontFamily: state.terminalFontFamily,
        terminalFontSize: state.terminalFontSize,
        terminalFontWeight: state.terminalFontWeight,
        terminalFontWeightBold: state.terminalFontWeightBold,
        terminalLineHeight: state.terminalLineHeight,
        terminalLetterSpacing: state.terminalLetterSpacing,
        terminalCursorStyle: state.terminalCursorStyle,
        terminalCursorInactiveStyle: state.terminalCursorInactiveStyle,
        terminalPadding: state.terminalPadding,
        terminalMinimumContrast: state.terminalMinimumContrast,
        terminalScrollbackLines: state.terminalScrollbackLines,
        terminalScrollbackMegabytes: state.terminalScrollbackMegabytes,
        cursorBlink: state.cursorBlink,
        autoCheckForUpdates: state.autoCheckForUpdates,
        lastProjectId: state.lastProjectId,
      }),
    },
  ),
);
