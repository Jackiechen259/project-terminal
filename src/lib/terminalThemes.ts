import type { ISearchDecorationOptions } from "@xterm/addon-search";
import type { ITheme } from "@xterm/xterm";

import type { AppTheme } from "@/stores/settingsStore";

// `selectionForeground` is deliberately left unset in every theme. Setting it
// flattens selected text to a single colour, discarding the ANSI colours that
// are the whole point of selecting terminal output. Readability of the
// selection is instead handled by `minimumContrastRatio`, which xterm applies
// against the selection background.

const dark: ITheme = {
  background: "#09090b",
  foreground: "#fafafa",
  cursor: "#fafafa",
  cursorAccent: "#09090b",
  selectionBackground: "#3f3f46",
  selectionInactiveBackground: "#27272a",
  black: "#18181b",
  red: "#ef4444",
  green: "#22c55e",
  yellow: "#eab308",
  blue: "#3b82f6",
  magenta: "#a855f7",
  cyan: "#06b6d4",
  white: "#e4e4e7",
  brightBlack: "#71717a",
  brightRed: "#f87171",
  brightGreen: "#4ade80",
  brightYellow: "#facc15",
  brightBlue: "#60a5fa",
  brightMagenta: "#c084fc",
  brightCyan: "#22d3ee",
  brightWhite: "#fafafa",
};

const eyeCare: ITheme = {
  background: "#f5f1e5",
  foreground: "#362f26",
  cursor: "#655b47",
  cursorAccent: "#f5f1e5",
  selectionBackground: "#d8c9a9",
  selectionInactiveBackground: "#e6dcc4",
  black: "#39342b",
  red: "#a33b32",
  green: "#4d713e",
  yellow: "#8a651d",
  blue: "#386b8c",
  magenta: "#76517d",
  cyan: "#39736d",
  white: "#e8dfca",
  brightBlack: "#756c5c",
  brightRed: "#bd4d42",
  brightGreen: "#638b50",
  brightYellow: "#a77c28",
  brightBlue: "#4b82a5",
  brightMagenta: "#906696",
  brightCyan: "#4b8b84",
  brightWhite: "#fffaf0",
};

const light: ITheme = {
  background: "#ffffff",
  foreground: "#18181b",
  cursor: "#27272a",
  cursorAccent: "#ffffff",
  selectionBackground: "#cbd5e1",
  selectionInactiveBackground: "#e2e8f0",
  black: "#18181b",
  red: "#b91c1c",
  green: "#15803d",
  yellow: "#a16207",
  blue: "#1d4ed8",
  magenta: "#7e22ce",
  cyan: "#0e7490",
  white: "#e4e4e7",
  brightBlack: "#71717a",
  brightRed: "#dc2626",
  brightGreen: "#16a34a",
  brightYellow: "#ca8a04",
  brightBlue: "#2563eb",
  brightMagenta: "#9333ea",
  brightCyan: "#0891b2",
  brightWhite: "#fafafa",
};

export const TERMINAL_THEMES: Record<AppTheme, ITheme> = {
  dark,
  "eye-care": eyeCare,
  light,
};

const TERMINAL_MINIMUM_CONTRAST: Record<AppTheme, number> = {
  dark: 1,
  "eye-care": 4.5,
  light: 4.5,
};

export function getTerminalTheme(theme: AppTheme | undefined): ITheme {
  return TERMINAL_THEMES[theme ?? "dark"] ?? dark;
}

/** Keep agent-generated ANSI and truecolor text readable on pale backgrounds. */
export function getTerminalMinimumContrast(theme: AppTheme | undefined) {
  return TERMINAL_MINIMUM_CONTRAST[theme ?? "dark"] ?? 1;
}

/**
 * Highlight colours for search matches, including the overview ruler marks
 * that make an off-screen match visible in the scrollbar gutter.
 *
 * Search decorations are opt-in per query: without this object the addon
 * renders no highlight at all, and the terminal only scrolls to each match.
 */
const TERMINAL_SEARCH_DECORATIONS: Record<AppTheme, ISearchDecorationOptions> = {
  dark: {
    matchBackground: "#3f3f46",
    matchBorder: "#52525b",
    matchOverviewRuler: "#a1a1aa",
    activeMatchBackground: "#a16207",
    activeMatchBorder: "#facc15",
    activeMatchColorOverviewRuler: "#facc15",
  },
  "eye-care": {
    matchBackground: "#e0d3b2",
    matchBorder: "#b9a97f",
    matchOverviewRuler: "#8a7b56",
    activeMatchBackground: "#e8c46a",
    activeMatchBorder: "#8a651d",
    activeMatchColorOverviewRuler: "#8a651d",
  },
  light: {
    matchBackground: "#dbeafe",
    matchBorder: "#93c5fd",
    matchOverviewRuler: "#60a5fa",
    activeMatchBackground: "#fde68a",
    activeMatchBorder: "#a16207",
    activeMatchColorOverviewRuler: "#a16207",
  },
};

export function getTerminalSearchDecorations(
  theme: AppTheme | undefined,
): ISearchDecorationOptions {
  return (
    TERMINAL_SEARCH_DECORATIONS[theme ?? "dark"] ??
    TERMINAL_SEARCH_DECORATIONS.dark
  );
}
