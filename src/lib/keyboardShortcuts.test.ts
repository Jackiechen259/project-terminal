import { describe, expect, it } from "vitest";

import { getAppShortcut } from "./keyboardShortcuts";

function shortcutEvent(init: KeyboardEventInit) {
  return new KeyboardEvent("keydown", {
    ctrlKey: true,
    shiftKey: true,
    ...init,
  });
}

describe("getAppShortcut", () => {
  it("recognizes side-by-side split on the shifted backslash key", () => {
    expect(
      getAppShortcut(shortcutEvent({ key: "|", code: "Backslash" })),
    ).toEqual({ type: "split-pane", direction: "side-by-side" });
  });

  it("recognizes stacked split on the shifted minus key", () => {
    expect(getAppShortcut(shortcutEvent({ key: "_", code: "Minus" }))).toEqual({
      type: "split-pane",
      direction: "stacked",
    });
  });

  it("keeps regular terminal shortcuts intact", () => {
    expect(getAppShortcut(shortcutEvent({ key: "t" }))).toEqual({
      type: "new-terminal",
    });
    expect(getAppShortcut(shortcutEvent({ key: "w" }))).toEqual({
      type: "close-terminal",
    });
  });
});
