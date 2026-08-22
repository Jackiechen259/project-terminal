import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { terminalService } from "@/services";

import {
  copyTextToClipboard,
  insertCommand,
  runCommand,
} from "./commandExecution";

vi.mock("@/services", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services")>()),
  terminalService: {
    ...(await importOriginal<typeof import("@/services")>()).terminalService,
    write: vi.fn().mockResolvedValue(undefined),
  },
}));

const writeMock = vi.mocked(terminalService.write);

beforeEach(() => {
  writeMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("insertCommand", () => {
  it("writes the command without Enter", async () => {
    await insertCommand("session-1", "pnpm dev");
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock).toHaveBeenCalledWith("session-1", "pnpm dev");
  });

  it("never appends a newline", async () => {
    await insertCommand("session-1", "git status");
    const data = writeMock.mock.calls[0][1];
    expect(data.endsWith("\r") || data.endsWith("\n")).toBe(false);
  });
});

describe("runCommand", () => {
  it("writes the command followed by Enter (\\r, the terminal sequence)", async () => {
    await runCommand("session-1", "pnpm dev");
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock).toHaveBeenCalledWith("session-1", "pnpm dev\r");
  });

  it("writes multiline commands verbatim with a single trailing Enter", async () => {
    await runCommand("session-1", "echo first\necho second");
    expect(writeMock).toHaveBeenCalledWith(
      "session-1",
      "echo first\necho second\r",
    );
  });

  it("only ever calls write - never creates a session or shell", async () => {
    const createSpy = vi.spyOn(terminalService, "create");
    await runCommand("session-1", "pwd");
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe("copyTextToClipboard", () => {
  it("uses the async clipboard API when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    await expect(copyTextToClipboard("pnpm dev")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("pnpm dev");
  });

  it("returns false when copying fails", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: vi.fn().mockRejectedValue(new Error("denied")),
      },
      configurable: true,
    });
    await expect(copyTextToClipboard("pnpm dev")).resolves.toBe(false);
  });
});
