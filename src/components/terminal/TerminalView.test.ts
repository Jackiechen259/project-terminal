import { describe, expect, it } from "vitest";

import { resolveTerminalTabTitle } from "./terminalTitle";
import { measureGridPixels } from "./TerminalView";

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

describe("measureGridPixels", () => {
  /** A container that only knows `.xterm-screen`, like a WebGL-rendered one. */
  function createContainer(options?: { screen?: boolean }) {
    const container = document.createElement("div");
    if (options?.screen) {
      const screen = document.createElement("div");
      screen.className = "xterm-screen";
      Object.defineProperty(screen, "clientWidth", { value: 900 });
      Object.defineProperty(screen, "clientHeight", { value: 300 });
      container.appendChild(screen);
    }
    const term = { rows: 30, cols: 100 } as {
      rows: number;
      cols: number;
    };
    return { container, term };
  }

  it("measures the grid from .xterm-screen", () => {
    const { container, term } = createContainer({ screen: true });
    expect(measureGridPixels(container, term)).toEqual({
      width: 900,
      height: 300,
    });
  });

  it("returns zeroes when the screen element is missing", () => {
    const { container, term } = createContainer();
    expect(measureGridPixels(container, term)).toEqual({ width: 0, height: 0 });
  });

  it("returns zeroes when the screen element has not been laid out", () => {
    const container = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    Object.defineProperty(screen, "clientWidth", { value: 900 });
    Object.defineProperty(screen, "clientHeight", { value: 0 });
    container.appendChild(screen);
    const term = { rows: 30, cols: 100 } as { rows: number; cols: number };
    expect(measureGridPixels(container, term)).toEqual({ width: 0, height: 0 });
  });

  it("returns zeroes when the terminal has no grid yet", () => {
    const container = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    Object.defineProperty(screen, "clientWidth", { value: 900 });
    Object.defineProperty(screen, "clientHeight", { value: 300 });
    container.appendChild(screen);
    const term = { rows: 0, cols: 0 } as { rows: number; cols: number };
    expect(measureGridPixels(container, term)).toEqual({ width: 0, height: 0 });
  });

  it("preserves non-integer cell sizes until rounding", () => {
    const container = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    Object.defineProperty(screen, "clientWidth", { value: 995 });
    Object.defineProperty(screen, "clientHeight", { value: 300 });
    container.appendChild(screen);
    const term = { rows: 30, cols: 100 } as { rows: number; cols: number };
    expect(measureGridPixels(container, term)).toEqual({
      width: Math.round((995 / 100) * 100),
      height: Math.round((300 / 30) * 30),
    });
  });
});
