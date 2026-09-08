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
/**
 * How long a cursor that just went from visible to hidden is treated as
 * mid-repaint rather than parked.
 *
 * A TUI that owns the cursor hides it for the length of a repaint and reports
 * whatever cell the paint happened to reach - during scrolling output that is
 * the bottom-right corner, nowhere near where the user is typing. Following it
 * drags the native IME candidate window off to that corner. A repaint's hide
 * lasts milliseconds; an app that means to park its cursor keeps it hidden
 * indefinitely, so an order of magnitude of headroom separates the two.
 */
export const IME_CARET_HIDDEN_TRANSIENT_MS = 1_000;

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
  hiddenTransientMs?: number;
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
 * frame.
 *
 * A hidden cursor is ambiguous, and the two cases it covers want opposite
 * things. An app that keeps its cursor hidden for good (Ink-style CLIs draw
 * their own block and park the real cursor on the input cell) is telling us
 * where the caret belongs, so that position is honored once it holds still
 * for `settleMs`. But a cursor that was visible a moment ago is merely
 * mid-repaint, and the cell it reports is wherever the paint stopped - the
 * bottom-right corner while output scrolls. Those are ignored for
 * `hiddenTransientMs`, leaving the caret where the cursor actually lives, and
 * re-examined afterwards so an app that really did park there still wins.
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
    hiddenTransientMs = IME_CARET_HIDDEN_TRANSIENT_MS,
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
  /** Whether a visible cursor has ever been reported for this renderer. */
  let sawVisibleCursor = false;
  /**
   * When the cursor last went from visible to hidden. Measured on the
   * transition rather than from the last report, because frames only arrive
   * when something changes - an idle prompt can sit for seconds with an
   * obviously visible cursor and no updates at all.
   */
  let hiddenSince: number | null = null;

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

  /**
   * True while `rect` is a hide that followed a cursor we just saw visible,
   * i.e. a repaint in progress rather than a parked caret. A cursor that has
   * been hidden since before this renderer attached is never transient: there
   * is no visible position to prefer over it.
   */
  const isTransientHide = (rect: ImeCaretUpdate | null) =>
    rect !== null &&
    !rect.visible &&
    hiddenSince !== null &&
    now() - hiddenSince < hiddenTransientMs;

  /** The rect worth writing: a transient hide defers to what is on screen. */
  const targetRect = () =>
    isTransientHide(latestRect) ? appliedRect : latestRect;

  const commit = (rect: ImeCaretUpdate) => {
    cancelSchedule();
    appliedRect = rect;
    apply(rect);
  };
  const commitTarget = () => {
    const target = targetRect();
    if (!target || sameImeRect(target, appliedRect)) return;
    commit(target);
  };
  const scheduleVisible = () => {
    cancelSettleSchedule();
    divergedAt = null;
    if (frameHandle !== null) return;
    frameHandle = requestFrame(() => {
      frameHandle = null;
      commitTarget();
    });
  };
  const scheduleHidden = () => {
    cancelFrameSchedule();
    const current = now();
    if (divergedAt === null) divergedAt = current;
    const elapsed = current - divergedAt;
    if (elapsed >= maxWaitMs) {
      commitTarget();
      return;
    }
    cancelSettleSchedule();
    const wait = Math.min(settleMs, maxWaitMs - elapsed);
    settleHandle = setTimer(() => {
      settleHandle = null;
      commitTarget();
    }, wait);
  };
  /**
   * Hold a mid-repaint hide without dropping it: re-examine once the window
   * passes, so a cursor that turns out to be parked there still lands even
   * though a parked cursor produces no further frames to trigger a retry.
   */
  const scheduleTransientRecheck = () => {
    cancelFrameSchedule();
    cancelSettleSchedule();
    divergedAt = null;
    const remaining =
      hiddenSince === null
        ? 0
        : Math.max(0, hiddenTransientMs - (now() - hiddenSince));
    settleHandle = setTimer(() => {
      settleHandle = null;
      // Re-examine rather than assume the window has passed. The timer and
      // the clock can disagree, and simply giving up here would strand the
      // caret for good: a parked cursor paints nothing further, so there
      // would be no later frame to retry from.
      if (isTransientHide(latestRect)) {
        scheduleTransientRecheck();
        return;
      }
      commitTarget();
    }, remaining + settleMs);
  };

  return {
    update(rect) {
      // Maintained ahead of every early return: the hide clock has to keep
      // running even for reports that change nothing else.
      if (rect === null) {
        hiddenSince = null;
      } else if (rect.visible) {
        sawVisibleCursor = true;
        hiddenSince = null;
      } else if (sawVisibleCursor && hiddenSince === null) {
        hiddenSince = now();
      }

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
      else if (isTransientHide(rect)) scheduleTransientRecheck();
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
      commitTarget();
    },
    flush() {
      if (composing) {
        // Position stays frozen mid-composition; re-apply so the caller can
        // still resize the input for a widening preedit string.
        if (appliedRect) apply(appliedRect);
        return;
      }
      commitTarget();
    },
    dispose() {
      cancelSchedule();
    },
  };
}
