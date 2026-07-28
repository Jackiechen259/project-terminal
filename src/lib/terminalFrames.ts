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
