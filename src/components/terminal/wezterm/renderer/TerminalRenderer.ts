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
  /**
   * Ingest one frame into the retained row cache and (for a visible
   * renderer) schedule or perform its paint. Returns whether the frame was
   * accepted into the cache - a caller must not advance its own frame
   * sequence past a rejected frame, since the renderer's retained state
   * still reflects an earlier one.
   */
  render(frame: TerminalRenderFrame): boolean;
  renderImmediate(frame: TerminalRenderFrame): boolean;
  redraw(): void;
  setTheme(theme: TerminalRendererTheme): void;
  setFont(font: TerminalFontOptions): void;
  setCursorStyle(
    style: TerminalCursorStyle,
    inactiveStyle: TerminalCursorInactiveStyle,
  ): void;
  setCursorBlink(enabled: boolean): void;
  setFocused(focused: boolean): void;
  /**
   * Toggle visual painting without disposing resources or stopping frame
   * ingestion. Hidden renderers keep their latest logical state and paint it
   * when the caller invokes redraw after becoming visible.
   */
  setVisible(visible: boolean): void;
  /**
   * Reset cursor-blink phase to visible in response to local input activity
   * (a keypress, text input, or paste about to be sent). Does not itself
   * schedule a full repaint; renderers repaint only the cursor's row.
   */
  noteInputActivity(): void;
  setSelection(selection: TerminalSelection | null): void;
  setSearchMatch(match: TerminalSearchMatch | null): void;
  selectionText(
    anchor: TerminalSelectionPoint,
    focus: TerminalSelectionPoint,
  ): string;
  rowAtPoint(
    clientX: number,
    clientY: number,
  ): {
    column: number;
    row: number;
    xPixelOffset: number;
    yPixelOffset: number;
  } | null;
  /**
   * CSS-pixel rect of the cursor cell relative to the canvas. Used to park
   * the IME caret; null when no frame has been accepted yet.
   */
  cursorRect(): {
    x: number;
    y: number;
    width: number;
    height: number;
    /** Backend cursor visibility (DECTCEM). Ignores focus and blink phase. */
    visible: boolean;
  } | null;
  linkAtPoint(clientX: number, clientY: number): string | null;
  rowText(row: TerminalRenderRow): string;
  dispose(): void;
}
