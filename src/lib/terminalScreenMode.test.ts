import { afterEach, describe, expect, it } from "vitest";

import {
  isTerminalAlternateScreen,
  setTerminalAlternateScreen,
} from "./terminalScreenMode";

describe("terminalScreenMode", () => {
  afterEach(() => {
    setTerminalAlternateScreen("session-1", false);
  });

  it("tracks alternate-screen membership per session", () => {
    expect(isTerminalAlternateScreen("session-1")).toBe(false);
    setTerminalAlternateScreen("session-1", true);
    expect(isTerminalAlternateScreen("session-1")).toBe(true);
    setTerminalAlternateScreen("session-1", false);
    expect(isTerminalAlternateScreen("session-1")).toBe(false);
    expect(isTerminalAlternateScreen(null)).toBe(false);
  });
});
