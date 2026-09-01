import { describe, expect, it } from "vitest";

import { workingDirectoryLabel } from "./terminalShellIntegration";

describe("workingDirectoryLabel", () => {
  it("takes the last segment", () => {
    expect(workingDirectoryLabel("/home/user/project")).toBe("project");
    expect(workingDirectoryLabel("C:\\Users\\me\\project")).toBe("project");
    expect(workingDirectoryLabel("/home/user/project/")).toBe("project");
  });

  it("falls back to the whole path at a root", () => {
    expect(workingDirectoryLabel("/")).toBe("/");
  });
});
