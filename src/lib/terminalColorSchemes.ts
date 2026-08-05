import type { ITheme } from "@xterm/xterm";

import { TERMINAL_THEMES } from "@/lib/terminalThemes";
import type { AppTheme } from "@/stores/settingsStore";

/**
 * Terminal colour schemes, decoupled from the application theme.
 *
 * The two were one setting, which meant three palettes total and no way to
 * run a dark application chrome around a light terminal - or to use any of the
 * palettes people already have. They stay linked by default: the
 * {@link FOLLOW_APP_THEME} sentinel is what an existing installation keeps, so
 * upgrading changes nothing until the user picks something.
 */

/** Selected scheme meaning "whatever the application theme uses". */
export const FOLLOW_APP_THEME = "follow-app-theme";

export interface TerminalColorScheme {
  id: string;
  name: string;
  /** Who to credit. Shown under the swatches; absent for our own. */
  attribution?: string;
  theme: ITheme;
}

/**
 * `#RRGGBB` only. Terminal palettes are opaque by definition, and accepting
 * shorthand or `rgb()` here would mean every consumer had to normalise.
 */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function isValidSchemeColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

/**
 * Relative luminance per WCAG 2.1, used only to tell a light background from
 * a dark one. Returns 0 for anything unparseable, i.e. treats it as dark.
 */
export function relativeLuminance(color: string): number {
  if (!isValidSchemeColor(color)) return 0;
  const channel = (offset: number) => {
    const value = parseInt(color.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Above this the background counts as light. */
const LIGHT_BACKGROUND_LUMINANCE = 0.5;

/**
 * Minimum contrast xterm should enforce between text and its background.
 *
 * Derived from the scheme's own background rather than the application theme.
 * Keying it to the theme was correct while the two were the same setting and
 * wrong the moment they were not: a dark application chrome around Catppuccin
 * Latte would have got the dark theme's `1`, leaving dim ANSI colours
 * invisible on a near-white background.
 *
 * `1` disables the adjustment, which is what a dark background wants - it
 * preserves the palette exactly as its author intended.
 */
export function minimumContrastFor(theme: ITheme): number {
  const background = theme.background ?? "#000000";
  return relativeLuminance(background) > LIGHT_BACKGROUND_LUMINANCE ? 4.5 : 1;
}

function scheme(
  id: string,
  name: string,
  theme: ITheme,
  attribution?: string,
): TerminalColorScheme {
  return { id, name, theme, attribution };
}

/**
 * Built-in schemes.
 *
 * The first three are this application's own, keeping the ids they had so a
 * saved selection survives. The rest are the palettes people actually ask for,
 * each credited. A palette is a list of colours rather than an authored work,
 * but attribution costs nothing and is the right thing.
 */
export const BUILT_IN_COLOR_SCHEMES: TerminalColorScheme[] = [
  scheme("project-dark", "Project Dark", TERMINAL_THEMES.dark),
  scheme("project-warm", "Project Warm", TERMINAL_THEMES["eye-care"]),
  scheme("project-light", "Project Light", TERMINAL_THEMES.light),
  scheme(
    "campbell",
    "Campbell",
    {
      background: "#0c0c0c",
      foreground: "#cccccc",
      cursor: "#ffffff",
      cursorAccent: "#0c0c0c",
      selectionBackground: "#3a3a3a",
      selectionInactiveBackground: "#262626",
      black: "#0c0c0c",
      red: "#c50f1f",
      green: "#13a10e",
      yellow: "#c19c00",
      blue: "#0037da",
      magenta: "#881798",
      cyan: "#3a96dd",
      white: "#cccccc",
      brightBlack: "#767676",
      brightRed: "#e74856",
      brightGreen: "#16c60c",
      brightYellow: "#f9f1a5",
      brightBlue: "#3b78ff",
      brightMagenta: "#b4009e",
      brightCyan: "#61d6d6",
      brightWhite: "#f2f2f2",
    },
    "Windows Terminal default, Microsoft",
  ),
  scheme(
    "one-half-dark",
    "One Half Dark",
    {
      background: "#282c34",
      foreground: "#dcdfe4",
      cursor: "#dcdfe4",
      cursorAccent: "#282c34",
      selectionBackground: "#474e5d",
      selectionInactiveBackground: "#353b47",
      black: "#282c34",
      red: "#e06c75",
      green: "#98c379",
      yellow: "#e5c07b",
      blue: "#61afef",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#dcdfe4",
      brightBlack: "#5a6374",
      brightRed: "#e06c75",
      brightGreen: "#98c379",
      brightYellow: "#e5c07b",
      brightBlue: "#61afef",
      brightMagenta: "#c678dd",
      brightCyan: "#56b6c2",
      brightWhite: "#dcdfe4",
    },
    "Son A Pham, atom-one-dark",
  ),
  scheme(
    "one-half-light",
    "One Half Light",
    {
      background: "#fafafa",
      foreground: "#383a42",
      cursor: "#383a42",
      cursorAccent: "#fafafa",
      selectionBackground: "#bfceff",
      selectionInactiveBackground: "#dbe3f5",
      black: "#383a42",
      red: "#e45649",
      green: "#50a14f",
      yellow: "#c18301",
      blue: "#0184bc",
      magenta: "#a626a4",
      cyan: "#0997b3",
      white: "#fafafa",
      brightBlack: "#4f525d",
      brightRed: "#df6c75",
      brightGreen: "#98c379",
      brightYellow: "#e4c07a",
      brightBlue: "#61afef",
      brightMagenta: "#c577dd",
      brightCyan: "#56b5c1",
      brightWhite: "#ffffff",
    },
    "Son A Pham, atom-one-light",
  ),
  scheme(
    "solarized-dark",
    "Solarized Dark",
    {
      background: "#002b36",
      foreground: "#839496",
      cursor: "#93a1a1",
      cursorAccent: "#002b36",
      selectionBackground: "#073642",
      selectionInactiveBackground: "#03303b",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#586e75",
      brightRed: "#cb4b16",
      brightGreen: "#93a1a1",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    },
    "Ethan Schoonover",
  ),
  scheme(
    "solarized-light",
    "Solarized Light",
    {
      background: "#fdf6e3",
      foreground: "#657b83",
      cursor: "#586e75",
      cursorAccent: "#fdf6e3",
      selectionBackground: "#eee8d5",
      selectionInactiveBackground: "#f4eeda",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#586e75",
      brightRed: "#cb4b16",
      brightGreen: "#93a1a1",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    },
    "Ethan Schoonover",
  ),
  scheme(
    "gruvbox-dark",
    "Gruvbox Dark",
    {
      background: "#282828",
      foreground: "#ebdbb2",
      cursor: "#ebdbb2",
      cursorAccent: "#282828",
      selectionBackground: "#504945",
      selectionInactiveBackground: "#3c3836",
      black: "#282828",
      red: "#cc241d",
      green: "#98971a",
      yellow: "#d79921",
      blue: "#458588",
      magenta: "#b16286",
      cyan: "#689d6a",
      white: "#a89984",
      brightBlack: "#928374",
      brightRed: "#fb4934",
      brightGreen: "#b8bb26",
      brightYellow: "#fabd2f",
      brightBlue: "#83a598",
      brightMagenta: "#d3869b",
      brightCyan: "#8ec07c",
      brightWhite: "#ebdbb2",
    },
    "Pavel Pertsev",
  ),
  scheme(
    "nord",
    "Nord",
    {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#d8dee9",
      cursorAccent: "#2e3440",
      selectionBackground: "#434c5e",
      selectionInactiveBackground: "#3b4252",
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#4c566a",
      brightRed: "#bf616a",
      brightGreen: "#a3be8c",
      brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1",
      brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb",
      brightWhite: "#eceff4",
    },
    "Arctic Ice Studio",
  ),
  scheme(
    "catppuccin-mocha",
    "Catppuccin Mocha",
    {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      cursorAccent: "#1e1e2e",
      selectionBackground: "#585b70",
      selectionInactiveBackground: "#45475a",
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#f5c2e7",
      cyan: "#94e2d5",
      white: "#bac2de",
      brightBlack: "#585b70",
      brightRed: "#f38ba8",
      brightGreen: "#a6e3a1",
      brightYellow: "#f9e2af",
      brightBlue: "#89b4fa",
      brightMagenta: "#f5c2e7",
      brightCyan: "#94e2d5",
      brightWhite: "#a6adc8",
    },
    "Catppuccin",
  ),
  scheme(
    "catppuccin-latte",
    "Catppuccin Latte",
    {
      background: "#eff1f5",
      foreground: "#4c4f69",
      cursor: "#dc8a78",
      cursorAccent: "#eff1f5",
      selectionBackground: "#bcc0cc",
      selectionInactiveBackground: "#dce0e8",
      black: "#5c5f77",
      red: "#d20f39",
      green: "#40a02b",
      yellow: "#df8e1d",
      blue: "#1e66f5",
      magenta: "#ea76cb",
      cyan: "#179299",
      white: "#acb0be",
      brightBlack: "#6c6f85",
      brightRed: "#d20f39",
      brightGreen: "#40a02b",
      brightYellow: "#df8e1d",
      brightBlue: "#1e66f5",
      brightMagenta: "#ea76cb",
      brightCyan: "#179299",
      brightWhite: "#bcc0cc",
    },
    "Catppuccin",
  ),
  scheme(
    "tokyo-night",
    "Tokyo Night",
    {
      background: "#1a1b26",
      foreground: "#a9b1d6",
      cursor: "#c0caf5",
      cursorAccent: "#1a1b26",
      selectionBackground: "#33467c",
      selectionInactiveBackground: "#282e4a",
      black: "#32344a",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#ad8ee6",
      cyan: "#449dab",
      white: "#787c99",
      brightBlack: "#444b6a",
      brightRed: "#ff7a93",
      brightGreen: "#b9f27c",
      brightYellow: "#ff9e64",
      brightBlue: "#7da6ff",
      brightMagenta: "#bb9af7",
      brightCyan: "#0db9d7",
      brightWhite: "#acb0d0",
    },
    "Enkia",
  ),
];

/** The ANSI entries, in the order a 4x4 swatch grid should show them. */
export const ANSI_SWATCH_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const satisfies readonly (keyof ITheme)[];

/**
 * Resolve a saved selection to a palette.
 *
 * Falls back to the application theme for the sentinel, and for an id that no
 * longer resolves - an imported scheme deleted since, or a selection synced
 * from a machine that had it. Silently reverting beats a terminal with no
 * colours.
 */
export function resolveColorScheme(
  schemeId: string | undefined,
  appTheme: AppTheme | undefined,
  imported: TerminalColorScheme[] = [],
): TerminalColorScheme {
  const followTheme = () => {
    const id =
      appTheme === "light"
        ? "project-light"
        : appTheme === "eye-care"
          ? "project-warm"
          : "project-dark";
    return BUILT_IN_COLOR_SCHEMES.find((s) => s.id === id)!;
  };
  if (!schemeId || schemeId === FOLLOW_APP_THEME) return followTheme();
  return (
    [...BUILT_IN_COLOR_SCHEMES, ...imported].find((s) => s.id === schemeId) ??
    followTheme()
  );
}
