import { describe, expect, it } from "vitest";

import {
  getTerminalMinimumContrast,
  getTerminalTheme,
  TERMINAL_THEMES,
} from "./terminalThemes";

describe("terminal themes", () => {
  it("provides distinct palettes for every application theme", () => {
    expect(TERMINAL_THEMES.dark.background).toBe("#09090b");
    expect(TERMINAL_THEMES["eye-care"].background).toBe("#f5f1e5");
    expect(TERMINAL_THEMES.light.background).toBe("#ffffff");
  });

  it("falls back to the dark palette for settings without a theme", () => {
    expect(getTerminalTheme(undefined)).toBe(TERMINAL_THEMES.dark);
  });

  it("enforces readable text contrast only on pale themes", () => {
    expect(getTerminalMinimumContrast("dark")).toBe(1);
    expect(getTerminalMinimumContrast("eye-care")).toBe(4.5);
    expect(getTerminalMinimumContrast("light")).toBe(4.5);
    expect(getTerminalMinimumContrast(undefined)).toBe(1);
  });
});
