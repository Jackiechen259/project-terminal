import { describe, expect, it } from "vitest";

import { resolveTerminalTabTitle } from "./terminalTitle";

describe("resolveTerminalTabTitle", () => {
  const defaultTitle = "PowerShell";

  it("preserves a normal shell or application title", () => {
    expect(resolveTerminalTabTitle("nvim", defaultTitle)).toBe("nvim");
  });

  it("falls back for Windows executable paths", () => {
    expect(
      resolveTerminalTabTitle(
        "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        defaultTitle,
      ),
    ).toBe(defaultTitle);
  });

  it("falls back for UNC paths", () => {
    expect(resolveTerminalTabTitle("\\\\server\\path", defaultTitle)).toBe(
      defaultTitle,
    );
  });

  it("falls back for an empty title", () => {
    expect(resolveTerminalTabTitle("", defaultTitle)).toBe(defaultTitle);
  });

  it("removes terminal control characters", () => {
    expect(resolveTerminalTabTitle("nvim\u0000\u001b", defaultTitle)).toBe(
      "nvim",
    );
    expect(resolveTerminalTabTitle("\u0000\u001b", defaultTitle)).toBe(
      defaultTitle,
    );
  });

  it("limits titles to a tab-safe length", () => {
    expect(resolveTerminalTabTitle("x".repeat(200), defaultTitle)).toBe(
      "x".repeat(160),
    );
  });
});
