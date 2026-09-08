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

/** Time the IME caret waits at a still, hidden position before settling. */
export const IME_CARET_SETTLE_MS = 100;
/** Hard cap on how long a hidden caret can keep dodging before it commits. */
export const IME_CARET_MAX_WAIT_MS = 400;

/** A caret rect plus the backend's DECTCEM visibility for that cursor. */
export interface ImeCaretUpdate extends ImeCaretRect {
  visible: boolean;
}

export interface ImeCaretScheduler {
  /** Report the renderer's current cursor rect (or none while unmounted). */
  update(rect: ImeCaretUpdate | null): void;
  /** Freeze (true) or release (false) the caret across one IME composition. */
  setComposing(composing: boolean): void;
  /** Apply the current target synchronously - composing re-applies in place. */
  flush(): void;
  dispose(): void;
}

export interface ImeCaretSchedulerOptions {
  /** Write the given rect to the DOM. */
  apply: (rect: ImeCaretUpdate) => void;
  now?: () => number;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
  setTimer?: (callback: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
  settleMs?: number;
  maxWaitMs?: number;
}

function sameImeRect(
  a: ImeCaretUpdate | null,
  b: ImeCaretUpdate | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.visible === b.visible
  );
}

/**
 * Batches IME caret placement so the hidden textarea (and its native
 * candidate window) stops dragging across every intermediate model cursor
 * position on every accepted frame.
 *
 * A visible cursor is authoritative once the backend has coalesced a whole
 * redraw burst into one frame, so it applies on the very next animation
 * frame. A hidden cursor (common in full-screen TUIs, which often park it
 * near the last edit rather than truly moving it) debounces: it waits for
 * the position to hold still for `settleMs`, but never longer than
 * `maxWaitMs` from the first time it diverged from what's on screen, so a
 * cursor that never stops moving cannot starve the caret forever.
 */
export function createImeCaretScheduler(
  options: ImeCaretSchedulerOptions,
): ImeCaretScheduler {
  const {
    apply,
    now = () => performance.now(),
    requestFrame = (callback) =>
      window.requestAnimationFrame(() => callback()),
    cancelFrame = (handle) => window.cancelAnimationFrame(handle),
    setTimer = (callback, ms) =>
      window.setTimeout(callback, ms) as unknown as number,
    clearTimer = (handle) => window.clearTimeout(handle),
    settleMs = IME_CARET_SETTLE_MS,
    maxWaitMs = IME_CARET_MAX_WAIT_MS,
  } = options;

  let composing = false;
  /** Most recent rect reported via `update()`, applied or not. */
  let latestRect: ImeCaretUpdate | null = null;
  /** What is actually written to the DOM right now. */
  let appliedRect: ImeCaretUpdate | null = null;
  let frameHandle: number | null = null;
  let settleHandle: number | null = null;
  /** When `latestRect` first started differing from `appliedRect` while hidden. */
  let divergedAt: number | null = null;

  const cancelFrameSchedule = () => {
    if (frameHandle === null) return;
    cancelFrame(frameHandle);
    frameHandle = null;
  };
  const cancelSettleSchedule = () => {
    if (settleHandle === null) return;
    clearTimer(settleHandle);
    settleHandle = null;
  };
  const cancelSchedule = () => {
    cancelFrameSchedule();
    cancelSettleSchedule();
    divergedAt = null;
  };
  const commit = (rect: ImeCaretUpdate) => {
    cancelSchedule();
    appliedRect = rect;
    apply(rect);
  };
  const scheduleVisible = () => {
    cancelSettleSchedule();
    divergedAt = null;
    if (frameHandle !== null) return;
    frameHandle = requestFrame(() => {
      frameHandle = null;
      if (latestRect) commit(latestRect);
    });
  };
  const scheduleHidden = () => {
    cancelFrameSchedule();
    const current = now();
    if (divergedAt === null) divergedAt = current;
    const elapsed = current - divergedAt;
    if (elapsed >= maxWaitMs) {
      if (latestRect) commit(latestRect);
      return;
    }
    cancelSettleSchedule();
    const wait = Math.min(settleMs, maxWaitMs - elapsed);
    settleHandle = setTimer(() => {
      settleHandle = null;
      if (latestRect) commit(latestRect);
    }, wait);
  };

  return {
    update(rect) {
      // Still the same target already in flight (or already applied) -
      // nothing to (re)schedule.
      if (sameImeRect(rect, latestRect)) return;
      if (composing) {
        // Frozen: remember where it should end up, but do not touch the DOM
        // until composition ends.
        latestRect = rect;
        return;
      }
      latestRect = rect;
      if (rect === null) {
        cancelSchedule();
        return;
      }
      if (sameImeRect(rect, appliedRect)) {
        // Bounced back to what's already on screen.
        cancelSchedule();
        return;
      }
      if (rect.visible) scheduleVisible();
      else scheduleHidden();
    },
    setComposing(value) {
      if (composing === value) return;
      composing = value;
      if (value) {
        // Freeze: a frame/settle callback may already be in flight from an
        // `update()` that ran just before composition started. Cancel it
        // so it cannot write to the DOM mid-composition - `update()` itself
        // never schedules one while `composing` is true, so this is the
        // only place such a callback can still be pending.
        cancelSchedule();
        return;
      }
      if (latestRect) commit(latestRect);
    },
    flush() {
      if (!latestRect) return;
      if (composing) {
        // Position stays frozen mid-composition; re-apply so the caller can
        // still resize the input for a widening preedit string.
        if (appliedRect) apply(appliedRect);
        return;
      }
      if (!sameImeRect(latestRect, appliedRect)) commit(latestRect);
    },
    dispose() {
      cancelSchedule();
    },
  };
}
