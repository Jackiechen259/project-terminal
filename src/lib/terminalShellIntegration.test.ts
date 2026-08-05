import { describe, expect, it } from "vitest";

import {
  parsePromptMark,
  parseWorkingDirectory,
  workingDirectoryLabel,
} from "./terminalShellIntegration";

describe("parsePromptMark", () => {
  it("recognises the four command markers", () => {
    expect(parsePromptMark("A")).toEqual({ kind: "prompt-start" });
    expect(parsePromptMark("B")).toEqual({ kind: "command-start" });
    expect(parsePromptMark("C")).toEqual({ kind: "output-start" });
    expect(parsePromptMark("D;0")).toEqual({
      kind: "command-finished",
      exitCode: 0,
    });
    expect(parsePromptMark("D;130")).toEqual({
      kind: "command-finished",
      exitCode: 130,
    });
  });

  it("accepts a finish with no status, and the key=value form", () => {
    expect(parsePromptMark("D")).toEqual({
      kind: "command-finished",
      exitCode: null,
    });
    // Some shells append their own metadata; the letter is what matters.
    expect(parsePromptMark("A;cl=m")).toEqual({ kind: "prompt-start" });
  });

  it("ignores marks it does not implement rather than throwing", () => {
    // The sequence set grows. An unrecognised mark is not an error.
    expect(parsePromptMark("P;Cwd=/tmp")).toBeNull();
    expect(parsePromptMark("")).toBeNull();
    expect(parsePromptMark("D;not-a-number")).toEqual({
      kind: "command-finished",
      exitCode: null,
    });
  });
});

describe("parseWorkingDirectory", () => {
  it("reads a POSIX path", () => {
    expect(parseWorkingDirectory("file://localhost/home/user/project")).toBe(
      "/home/user/project",
    );
    expect(parseWorkingDirectory("file:///home/user")).toBe("/home/user");
  });

  it("converts a Windows path off its mandatory leading slash", () => {
    expect(parseWorkingDirectory("file:///C:/Users/me/project")).toBe(
      "C:\\Users\\me\\project",
    );
  });

  it("percent-decodes", () => {
    expect(parseWorkingDirectory("file:///home/user/my%20project")).toBe(
      "/home/user/my project",
    );
    expect(parseWorkingDirectory("file:///home/%E4%B8%AD%E6%96%87")).toBe(
      "/home/中文",
    );
  });

  it("rejects a host this terminal is not attached to", () => {
    // The value came out of the PTY. A path on another machine is not this
    // session's working directory whatever the program claims.
    expect(parseWorkingDirectory("file://other-host/home/user")).toBeNull();
  });

  it("rejects anything that is not a file URL", () => {
    for (const payload of [
      "/home/user",
      "http://example.com/x",
      "file:",
      "file://localhost",
      "",
    ]) {
      expect(parseWorkingDirectory(payload), payload).toBeNull();
    }
  });

  it("rejects control characters and malformed encoding", () => {
    // A NUL or newline means the value was assembled from something that is
    // not a directory.
    expect(parseWorkingDirectory("file:///home/%00etc")).toBeNull();
    expect(parseWorkingDirectory("file:///home/a%0Ab")).toBeNull();
    expect(parseWorkingDirectory("file:///home/%zz")).toBeNull();
    expect(parseWorkingDirectory(`file:///${"a".repeat(5000)}`)).toBeNull();
  });
});

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
