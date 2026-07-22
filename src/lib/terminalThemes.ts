import type { ITheme } from "@xterm/xterm";

import type { AppTheme } from "@/stores/settingsStore";

const dark: ITheme = {
  background: "#09090b",
  foreground: "#fafafa",
  cursor: "#fafafa",
  cursorAccent: "#09090b",
  selectionBackground: "#3f3f46",
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

export function getTerminalTheme(theme: AppTheme | undefined): ITheme {
  return TERMINAL_THEMES[theme ?? "dark"] ?? dark;
}
