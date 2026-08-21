/**
 * Frame types on a terminal session's attachment channel.
 *
 * Output crosses the IPC boundary as raw bytes (`InvokeResponseBody::Raw`),
 * skipping base64 and JSON entirely; lifecycle events travel as JSON on the
 * same channel. Tauri's `Channel` reorders by message index, so the two kinds
 * stay in sequence.
 *
 * These live outside `@/services` so component tests that mock the service
 * layer still exercise the real classification logic.
 */

export type TerminalSessionFrame = ArrayBuffer | TerminalControlFrame;

export type TerminalControlFrame =
  | { type: "status"; status: "exited" | "error"; exitCode?: number | null }
  | { type: "lagged" };

export type RenderColor =
  | { kind: "default" }
  | { kind: "palette"; value: number }
  | { kind: "rgba"; value: [number, number, number, number] };

export interface TerminalCursorState {
  column: number;
  row: number;
  shape:
    | "default"
    | "blinking-block"
    | "steady-block"
    | "blinking-underline"
    | "steady-underline"
    | "blinking-bar"
    | "steady-bar";
  visibility: "hidden" | "visible";
}

export interface TerminalImageCellFrame {
  imageId?: number | null;
  placementId?: number | null;
  zIndex: number;
  topLeft: [number, number];
  bottomRight: [number, number];
  padding: [number, number, number, number];
  format: "encoded" | "rgba8";
  mimeType: string;
  width: number;
  height: number;
  dataBase64?: string | null;
  cacheKey: string;
}

export interface TerminalRenderCell {
  column: number;
  width: number;
  text: string;
  foreground: RenderColor;
  background: RenderColor;
  underlineColor: RenderColor;
  intensity: "normal" | "bold" | "half";
  underline: "none" | "single" | "double" | "curly" | "dotted" | "dashed";
  italic: boolean;
  reverse: boolean;
  strikethrough: boolean;
  invisible: boolean;
  hyperlink?: string | null;
  images: TerminalImageCellFrame[];
}

export interface TerminalRenderRow {
  stableRow: number;
  cells: TerminalRenderCell[];
}

export interface TerminalRenderFrame {
  sequence: number;
  rows: number;
  cols: number;
  dirtyRows: TerminalRenderRow[];
  cursor: TerminalCursorState;
  scrollbackLength: number;
  viewportTop: number;
  viewportBottom: number;
  alternateScreen: boolean;
  mouseReporting: boolean;
  fullSnapshot: boolean;
}

export interface TerminalSearchPosition {
  stableRow: number;
  column: number;
}

export type TerminalSearchDirection = "forward" | "backward";

export interface TerminalSelectionPoint {
  stableRow: number;
  column: number;
}

export interface TerminalSearchQuery {
  query: string;
  caseSensitive?: boolean;
  direction?: TerminalSearchDirection;
  start?: TerminalSearchPosition | null;
}

export interface TerminalSearchMatch {
  stableRow: number;
  startColumn: number;
  endColumn: number;
}

export type TerminalEngineControlEvent =
  | { type: "bell" }
  | { type: "titleChanged"; title: string }
  | { type: "cwdChanged"; cwd?: string | null }
  | { type: "commandFinished"; exitCode?: number | null };

export type TerminalRenderMessage =
  | { type: "frame"; frame: TerminalRenderFrame }
  | { type: "control"; event: TerminalEngineControlEvent }
  | {
      type: "status";
      status: "starting" | "running" | "exited" | "error";
      exitCode?: number | null;
    }
  | { type: "lagged" };

/**
 * Distinguish a JSON control frame from raw output bytes.
 *
 * Tests for the control shape rather than `instanceof ArrayBuffer`, which
 * returns false when the buffer originates in another JS realm. Misclassifying
 * output as control would silently drop terminal bytes.
 */
export function isTerminalControlFrame(
  frame: TerminalSessionFrame,
): frame is TerminalControlFrame {
  return (
    typeof frame === "object" &&
    frame !== null &&
    typeof (frame as { type?: unknown }).type === "string"
  );
}

export function isTerminalRenderMessage(
  frame: unknown,
): frame is TerminalRenderMessage {
  return (
    typeof frame === "object" &&
    frame !== null &&
    typeof (frame as { type?: unknown }).type === "string" &&
    ["frame", "control", "status", "lagged"].includes(
      (frame as { type: string }).type,
    )
  );
}
