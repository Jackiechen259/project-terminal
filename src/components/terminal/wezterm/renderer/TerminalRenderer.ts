import type {
  TerminalRenderFrame,
  TerminalRenderRow,
  TerminalSearchMatch,
} from "@/lib/terminalFrames";

export interface TerminalRendererTheme {
  background: string;
  foreground: string;
  minimumContrast?: number;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionInactiveBackground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}

export interface TerminalFontOptions {
  family: string;
  size: number;
  weight: number;
  weightBold: number;
  lineHeight: number;
  letterSpacing: number;
}

export type TerminalCursorStyle = "block" | "bar" | "underline";
export type TerminalCursorInactiveStyle =
  "outline" | "block" | "bar" | "underline" | "none";

export interface TerminalSelectionPoint {
  stableRow: number;
  column: number;
}

export interface TerminalSelection {
  anchor: TerminalSelectionPoint;
  focus: TerminalSelectionPoint;
}

export interface TerminalRenderer {
  mount(canvas: HTMLCanvasElement): void;
  resize(width: number, height: number, rows: number, cols: number): void;
  measureGrid(width: number, height: number): { rows: number; cols: number };
  render(frame: TerminalRenderFrame): void;
  setTheme(theme: TerminalRendererTheme): void;
  setFont(font: TerminalFontOptions): void;
  setCursorStyle(
    style: TerminalCursorStyle,
    inactiveStyle: TerminalCursorInactiveStyle,
  ): void;
  setCursorBlink(enabled: boolean): void;
  setFocused(focused: boolean): void;
  setSelection(selection: TerminalSelection | null): void;
  setSearchMatch(match: TerminalSearchMatch | null): void;
  selectionText(
    anchor: TerminalSelectionPoint,
    focus: TerminalSelectionPoint,
  ): string;
  rowAtPoint(
    clientX: number,
    clientY: number,
  ): { column: number; row: number } | null;
  linkAtPoint(clientX: number, clientY: number): string | null;
  rowText(row: TerminalRenderRow): string;
  dispose(): void;
}
