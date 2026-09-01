import { describe, expect, it } from "vitest";

import { getTerminalTheme, TERMINAL_THEMES } from "./terminalThemes";

describe("terminal themes", () => {
  it("provides distinct palettes for every application theme", () => {
    expect(TERMINAL_THEMES.dark.background).toBe("#09090b");
    expect(TERMINAL_THEMES["eye-care"].background).toBe("#f5f1e5");
    expect(TERMINAL_THEMES.light.background).toBe("#ffffff");
  });

  it("falls back to the dark palette for settings without a theme", () => {
    expect(getTerminalTheme(undefined)).toBe(TERMINAL_THEMES.dark);
  });
});
