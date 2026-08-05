import { describe, expect, it } from "vitest";

import type { PlatformInfo } from "@/types";

import { CONPTY_REFLOW_BUILD, resolveWindowsPty } from "./terminalWindowsPty";

function platform(overrides: Partial<PlatformInfo>): PlatformInfo {
  return {
    os: "windows",
    windowsBuild: 26100,
    wslSupported: true,
    availableProjectTypes: ["local"],
    availableLocalShells: ["powershell"],
    defaultLocalShell: "powershell",
    ...overrides,
  };
}

describe("resolveWindowsPty", () => {
  it("describes ConPTY with the host build on Windows", () => {
    expect(resolveWindowsPty(platform({ windowsBuild: 26100 }))).toEqual({
      backend: "conpty",
      buildNumber: 26100,
    });
  });

  it("passes a pre-reflow build through unchanged", () => {
    // xterm compares against 21376 itself; reporting the real build is what
    // lets it disable reflow on Windows 10, where ConPTY never marked wrapped
    // lines.
    const resolved = resolveWindowsPty(
      platform({ windowsBuild: CONPTY_REFLOW_BUILD - 1 }),
    );
    expect(resolved).toEqual({
      backend: "conpty",
      buildNumber: CONPTY_REFLOW_BUILD - 1,
    });
  });

  it("names the backend without guessing an unknown build", () => {
    // Naming the backend alone still stops rows being pulled out of scrollback
    // when the window grows; inventing a build would also change reflow.
    expect(resolveWindowsPty(platform({ windowsBuild: null }))).toEqual({
      backend: "conpty",
    });
  });

  it("leaves xterm's default model in place off Windows", () => {
    expect(resolveWindowsPty(platform({ os: "linux" }))).toBeUndefined();
    expect(resolveWindowsPty(platform({ os: "macos" }))).toBeUndefined();
    expect(resolveWindowsPty(null)).toBeUndefined();
  });
});
