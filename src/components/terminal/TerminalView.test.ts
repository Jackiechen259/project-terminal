import { describe, expect, it } from "vitest";

import { resolveTerminalTabTitle } from "./terminalTitle";

describe("resolveTerminalTabTitle", () => {
  it("restores the profile name when PowerShell emits an executable path", () => {
    expect(
      resolveTerminalTabTitle(
        "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        "PowerShell",
      ),
    ).toBe("PowerShell");
  });

  it("keeps meaningful titles emitted by an interactive program", () => {
    expect(resolveTerminalTabTitle("Codex", "PowerShell")).toBe("Codex");
  });
});
