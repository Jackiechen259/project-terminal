import { describe, expect, it } from "vitest";

import {
  IME_CARET_HIDDEN_TRANSIENT_MS,
  IME_CARET_MAX_WAIT_MS,
  IME_CARET_SETTLE_MS,
  POST_COMPOSITION_SUPPRESS_MS,
  committedCompositionText,
  createImeCaretScheduler,
  imeInputStyle,
  isImeKeyEvent,
  isWithinPostCompositionWindow,
  shouldSuppressPostCompositionKey,
  type ImeCaretUpdate,
} from "./terminalIme";

describe("imeInputStyle", () => {
  it("returns null without a caret", () => {
    expect(imeInputStyle(null)).toBeNull();
  });

  it("sizes the input to at least one cell", () => {
    expect(imeInputStyle({ x: 24, y: 34, width: 8, height: 17 })).toEqual({
      left: 24,
      top: 34,
      width: 8,
      height: 17,
    });
  });

  it("grows the input to the preedit width", () => {
    expect(imeInputStyle({ x: 24, y: 34, width: 8, height: 17 }, 40)).toEqual({
      left: 24,
      top: 34,
      width: 40,
      height: 17,
    });
  });
});

describe("isImeKeyEvent", () => {
  it("treats composing, Process, and Unidentified keys as IME-owned", () => {
    expect(isImeKeyEvent({ key: "n", isComposing: true })).toBe(true);
    expect(isImeKeyEvent({ key: "Process" })).toBe(true);
    expect(isImeKeyEvent({ key: "Unidentified" })).toBe(true);
    expect(isImeKeyEvent({ key: "n" })).toBe(false);
    expect(isImeKeyEvent({ key: "Enter" })).toBe(false);
  });
});

describe("post-composition suppression", () => {
  it("suppresses confirming Space and Enter only inside the commit window", () => {
    const committedAt = 1_000;
    expect(
      shouldSuppressPostCompositionKey(
        { key: "Enter" },
        committedAt,
        committedAt + 10,
      ),
    ).toBe(true);
    expect(
      shouldSuppressPostCompositionKey(
        { key: " " },
        committedAt,
        committedAt + 10,
      ),
    ).toBe(true);
    expect(
      shouldSuppressPostCompositionKey(
        { key: "Enter" },
        committedAt,
        committedAt + POST_COMPOSITION_SUPPRESS_MS + 1,
      ),
    ).toBe(false);
    expect(
      shouldSuppressPostCompositionKey({ key: "Enter" }, null, 1_000),
    ).toBe(false);
    expect(
      shouldSuppressPostCompositionKey(
        { key: "a" },
        committedAt,
        committedAt + 10,
      ),
    ).toBe(false);
  });

  it("ignores fallback input events inside the same window", () => {
    expect(isWithinPostCompositionWindow(1_000, 1_040)).toBe(true);
    expect(
      isWithinPostCompositionWindow(
        1_000,
        1_000 + POST_COMPOSITION_SUPPRESS_MS + 1,
      ),
    ).toBe(false);
    expect(isWithinPostCompositionWindow(null, 1_000)).toBe(false);
  });
});

describe("committedCompositionText", () => {
  it("prefers compositionend data and falls back to the textarea value", () => {
    expect(committedCompositionText("你", "ni")).toBe("你");
    expect(committedCompositionText("", "你")).toBe("你");
    expect(committedCompositionText(null, "你")).toBe("你");
    expect(committedCompositionText("", "")).toBe("");
  });
});

/**
 * A deterministic stand-in for rAF/setTimeout/performance.now so the
 * scheduler's timing rules can be tested without real clocks or flakiness.
 */
function createHarness() {
  let currentTime = 0;
  let nextFrameHandle = 0;
  let nextTimerHandle = 0;
  const frameCallbacks = new Map<number, () => void>();
  const timers = new Map<number, { callback: () => void; due: number }>();
  const applied: ImeCaretUpdate[] = [];

  const scheduler = createImeCaretScheduler({
    apply: (rect) => applied.push(rect),
    now: () => currentTime,
    requestFrame: (callback) => {
      const handle = ++nextFrameHandle;
      frameCallbacks.set(handle, callback);
      return handle;
    },
    cancelFrame: (handle) => {
      frameCallbacks.delete(handle);
    },
    setTimer: (callback, ms) => {
      const handle = ++nextTimerHandle;
      timers.set(handle, { callback, due: currentTime + ms });
      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle);
    },
  });

  function flushFrame() {
    const pending = [...frameCallbacks.entries()];
    frameCallbacks.clear();
    for (const [, callback] of pending) callback();
  }

  function advance(ms: number) {
    currentTime += ms;
    for (;;) {
      const due = [...timers.entries()].find(([, timer]) => timer.due <= currentTime);
      if (!due) return;
      const [handle, timer] = due;
      timers.delete(handle);
      timer.callback();
    }
  }

  return {
    scheduler,
    applied,
    flushFrame,
    advance,
    get pendingFrames() {
      return frameCallbacks.size;
    },
    get pendingTimers() {
      return timers.size;
    },
  };
}

function caret(x: number, visible: boolean): ImeCaretUpdate {
  return { x, y: 16, width: 8, height: 17, visible };
}

describe("createImeCaretScheduler", () => {
  it("applies a visible rect on the next frame, not synchronously", () => {
    const harness = createHarness();
    const { scheduler, applied, flushFrame } = harness;
    const rect = caret(8, true);

    scheduler.update(rect);
    expect(applied).toEqual([]);
    expect(harness.pendingFrames).toBe(1);

    flushFrame();
    expect(applied).toEqual([rect]);
  });

  it("skips scheduling when the rect has not changed", () => {
    const harness = createHarness();
    const { scheduler, applied, flushFrame } = harness;
    const rect = caret(8, true);

    scheduler.update(rect);
    expect(harness.pendingFrames).toBe(1);
    // A structurally identical rect (a fresh object each frame, as the
    // renderer produces) must not reset or duplicate the pending schedule.
    scheduler.update({ ...rect });
    expect(harness.pendingFrames).toBe(1);
    flushFrame();
    expect(applied).toEqual([rect]);

    // Once applied, reporting the same rect again is a pure no-op.
    scheduler.update({ ...rect });
    flushFrame();
    expect(applied).toEqual([rect]);
  });

  it("debounces a moving hidden caret and applies once it settles", () => {
    const { scheduler, applied, advance } = createHarness();

    scheduler.update(caret(8, false));
    advance(50);
    scheduler.update(caret(16, false));

    advance(IME_CARET_SETTLE_MS - 1);
    expect(applied).toEqual([]);

    advance(1);
    expect(applied).toEqual([caret(16, false)]);
  });

  it("forces the caret to catch up after maxWaitMs of continuous hidden movement", () => {
    const { scheduler, applied, advance } = createHarness();
    const step = Math.floor(IME_CARET_SETTLE_MS / 2); // never lets it settle
    let x = 0;
    scheduler.update(caret(x, false));

    let iterations = 0;
    while (applied.length === 0 && iterations < 50) {
      advance(step);
      iterations += 1;
      // The forced catch-up can fire from the timer that `advance` just
      // ran - stop immediately so `x` still names the rect that was
      // actually committed, instead of one step further along.
      if (applied.length > 0) break;
      x += 8;
      scheduler.update(caret(x, false));
    }

    expect(applied).toEqual([caret(x, false)]);
    // It should not have taken drastically longer than the hard cap to
    // force a catch-up.
    expect(iterations * step).toBeLessThan(IME_CARET_MAX_WAIT_MS + step * 2);
  });

  it("freezes the caret during composition and applies the latest rect once it ends", () => {
    const { scheduler, applied, flushFrame } = createHarness();
    const before = caret(8, true);
    scheduler.update(before);
    flushFrame();
    expect(applied).toEqual([before]);

    scheduler.setComposing(true);
    const duringComposition = caret(24, true);
    scheduler.update(duringComposition);
    flushFrame();
    // No DOM write while composing, even though a visible rect would
    // normally apply on the very next frame.
    expect(applied).toEqual([before]);

    scheduler.setComposing(false);
    expect(applied).toEqual([before, duringComposition]);
  });

  it("cancels a frame already scheduled before composition starts", () => {
    const harness = createHarness();
    const { scheduler, applied, flushFrame } = harness;

    // A terminal frame arrives and schedules a caret move for the next
    // rAF, but composition starts (a native compositionstart event) before
    // that rAF fires - a real race between two independent event sources.
    const race = caret(24, true);
    scheduler.update(race);
    expect(harness.pendingFrames).toBe(1);

    scheduler.setComposing(true);
    expect(harness.pendingFrames).toBe(0);

    // The rAF the browser had already queued still fires; it must not
    // write to the DOM mid-composition.
    flushFrame();
    expect(applied).toEqual([]);

    scheduler.setComposing(false);
    expect(applied).toEqual([race]);
  });

  it("cancels a settle timer already scheduled before composition starts", () => {
    const harness = createHarness();
    const { scheduler, applied, advance } = harness;

    // Same race as above, but for a hidden caret's settle debounce instead
    // of a visible caret's next-frame schedule.
    const race = caret(24, false);
    scheduler.update(race);
    expect(harness.pendingTimers).toBe(1);

    scheduler.setComposing(true);
    expect(harness.pendingTimers).toBe(0);

    advance(IME_CARET_MAX_WAIT_MS + 100);
    expect(applied).toEqual([]);

    scheduler.setComposing(false);
    expect(applied).toEqual([race]);
  });

  describe("flush", () => {
    it("synchronously applies the latest rect outside composition", () => {
      const { scheduler, applied } = createHarness();
      const rect = caret(8, false);
      scheduler.update(rect);
      expect(applied).toEqual([]);

      scheduler.flush();
      expect(applied).toEqual([rect]);
    });

    it("re-applies the already-fixed rect in place while composing", () => {
      const { scheduler, applied } = createHarness();
      const initial = caret(8, true);
      scheduler.update(initial);
      scheduler.flush();
      expect(applied).toEqual([initial]);

      scheduler.setComposing(true);
      scheduler.update(caret(40, true));
      scheduler.flush();
      // Position must not move mid-composition even though a newer rect
      // arrived - only the already-applied (frozen) rect is re-emitted, so
      // a caller can still resize for a widening preedit string.
      expect(applied).toEqual([initial, initial]);
    });
  });


  describe("a cursor hidden by a repaint in progress", () => {
    /**
     * The measured bug: while output scrolls, the model reports the cursor
     * hidden at whatever cell the repaint reached - the bottom-right corner -
     * and it holds there long enough to look settled. Following it drags the
     * native IME candidate window into that corner, far from where the user
     * is actually typing.
     */
    it("leaves the caret where the cursor really lives", () => {
      const { scheduler, applied, advance, flushFrame } = createHarness();
      const prompt = caret(8, true);
      scheduler.update(prompt);
      flushFrame();
      expect(applied).toEqual([prompt]);

      // Output starts scrolling: every frame reports the same mid-repaint
      // cell, which the settle debounce alone would happily accept.
      const midRepaint = caret(632, false);
      for (let tick = 0; tick < 12; tick += 1) {
        scheduler.update({ ...midRepaint });
        advance(20);
      }
      expect(applied).toEqual([prompt]);

      // Output stops and the cursor comes back where it belongs.
      const movedPrompt = caret(16, true);
      scheduler.update(movedPrompt);
      flushFrame();
      expect(applied).toEqual([prompt, movedPrompt]);
    });

    it("still follows a cursor that turns out to be parked there", () => {
      const { scheduler, applied, advance, flushFrame } = createHarness();
      const prompt = caret(8, true);
      scheduler.update(prompt);
      flushFrame();

      // An app hides its cursor and leaves it on its own input cell. No
      // further frames arrive, so the caret has to re-examine on its own
      // rather than wait for output that never comes.
      const parked = caret(48, false);
      scheduler.update(parked);
      advance(IME_CARET_HIDDEN_TRANSIENT_MS + IME_CARET_SETTLE_MS + 1);
      expect(applied).toEqual([prompt, parked]);
    });

    it("parks immediately for an app whose cursor was never visible", () => {
      const { scheduler, applied, advance } = createHarness();

      // Attaching to a running Ink-style CLI: the cursor has been hidden
      // since before this renderer existed, so there is no visible position
      // to prefer and nothing to wait for.
      const inkInput = caret(48, false);
      scheduler.update(inkInput);
      advance(IME_CARET_SETTLE_MS);
      expect(applied).toEqual([inkInput]);
    });

    it("does not leak through flush", () => {
      const { scheduler, applied, flushFrame } = createHarness();
      const prompt = caret(8, true);
      scheduler.update(prompt);
      flushFrame();

      scheduler.update(caret(632, false));
      // A resize flushes synchronously; it must not pick up the mid-repaint
      // cell just because it is the newest thing reported.
      scheduler.flush();
      expect(applied).toEqual([prompt]);
    });

    it("does not leak through the end of a composition", () => {
      const { scheduler, applied, flushFrame } = createHarness();
      const prompt = caret(8, true);
      scheduler.update(prompt);
      flushFrame();

      scheduler.setComposing(true);
      scheduler.update(caret(632, false));
      scheduler.setComposing(false);
      expect(applied).toEqual([prompt]);
    });

    it("measures the hide from the transition, not the last report", () => {
      const { scheduler, applied, advance, flushFrame } = createHarness();
      const prompt = caret(8, true);
      scheduler.update(prompt);
      flushFrame();

      // An idle prompt produces no frames at all; the cursor is plainly
      // still visible the whole time. Time passing here must not make the
      // next repaint's hide look like a long-established one.
      advance(IME_CARET_HIDDEN_TRANSIENT_MS * 5);

      scheduler.update(caret(632, false));
      advance(IME_CARET_SETTLE_MS + 1);
      expect(applied).toEqual([prompt]);
    });
  });

  it("cancels pending frame and settle timers on dispose", () => {
    const harness = createHarness();
    const { scheduler, applied, flushFrame, advance } = harness;

    scheduler.update(caret(8, true));
    expect(harness.pendingFrames).toBe(1);
    scheduler.dispose();
    expect(harness.pendingFrames).toBe(0);
    flushFrame();
    expect(applied).toEqual([]);

    scheduler.update(caret(8, false));
    expect(harness.pendingTimers).toBe(1);
    scheduler.dispose();
    expect(harness.pendingTimers).toBe(0);
    advance(IME_CARET_MAX_WAIT_MS + 100);
    expect(applied).toEqual([]);
  });
});
