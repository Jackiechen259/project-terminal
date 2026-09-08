import { describe, expect, it } from "vitest";

import {
  POST_COMPOSITION_SUPPRESS_MS,
  committedCompositionText,
  imeInputStyle,
  isImeKeyEvent,
  isWithinPostCompositionWindow,
  shouldSuppressPostCompositionKey,
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
