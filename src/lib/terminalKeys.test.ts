import { describe, expect, it } from "vitest";

import { resolveExtraKeySequence } from "./terminalKeys";

function key(init: KeyboardEventInit & { key: string }) {
  return new KeyboardEvent("keydown", init);
}

describe("resolveExtraKeySequence", () => {
  it("distinguishes Shift+Enter from Enter", () => {
    // xterm's Enter handling consults only altKey, so shift is dropped and
    // an agent prompt that wanted a newline submits the message instead.
    expect(resolveExtraKeySequence(key({ key: "Enter", shiftKey: true }))).toBe(
      "\x1b[13;2u",
    );
  });

  it("distinguishes Ctrl+Enter and Ctrl+Shift+Enter", () => {
    expect(resolveExtraKeySequence(key({ key: "Enter", ctrlKey: true }))).toBe(
      "\x1b[13;5u",
    );
    expect(
      resolveExtraKeySequence(
        key({ key: "Enter", ctrlKey: true, shiftKey: true }),
      ),
    ).toBe("\x1b[13;6u");
  });

  it("leaves plain Enter to xterm", () => {
    expect(resolveExtraKeySequence(key({ key: "Enter" }))).toBeNull();
  });

  it("leaves Alt+Enter to xterm, which already implements it", () => {
    expect(
      resolveExtraKeySequence(key({ key: "Enter", altKey: true })),
    ).toBeNull();
    expect(
      resolveExtraKeySequence(
        key({ key: "Enter", altKey: true, shiftKey: true }),
      ),
    ).toBeNull();
  });

  it("claims nothing else", () => {
    // Every chord claimed here is one the program can no longer receive in
    // its unmodified form, so the list has to stay narrow.
    for (const k of ["a", "Tab", "Escape", "ArrowUp", "i", "m"]) {
      expect(
        resolveExtraKeySequence(key({ key: k, ctrlKey: true })),
        k,
      ).toBeNull();
      expect(
        resolveExtraKeySequence(key({ key: k, shiftKey: true })),
        k,
      ).toBeNull();
    }
  });
});
