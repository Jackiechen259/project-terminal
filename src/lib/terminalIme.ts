/** Time window in which a confirming IME key must not reach the PTY. */
export const POST_COMPOSITION_SUPPRESS_MS = 50;

export interface ImeCaretRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImeInputStyle {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Position the hidden IME caret on a terminal cell, growing with preedit. */
export function imeInputStyle(
  caret: ImeCaretRect | null,
  contentWidth = 0,
): ImeInputStyle | null {
  if (!caret) return null;
  return {
    left: caret.x,
    top: caret.y,
    width: Math.max(caret.width, contentWidth),
    height: caret.height,
  };
}

export function isImeKeyEvent(event: {
  isComposing?: boolean;
  key: string;
}): boolean {
  return (
    Boolean(event.isComposing) ||
    event.key === "Process" ||
    event.key === "Unidentified"
  );
}

export function isWithinPostCompositionWindow(
  committedAt: number | null,
  now: number,
): boolean {
  return (
    committedAt !== null && now - committedAt <= POST_COMPOSITION_SUPPRESS_MS
  );
}

export function shouldSuppressPostCompositionKey(
  event: { key: string },
  committedAt: number | null,
  now: number,
): boolean {
  if (!isWithinPostCompositionWindow(committedAt, now)) return false;
  return (
    event.key === "Enter" ||
    event.key === " " ||
    event.key === "Spacebar" ||
    event.key === "Process"
  );
}

export function committedCompositionText(
  eventData: string | null | undefined,
  textareaValue: string,
): string {
  return eventData || textareaValue;
}
