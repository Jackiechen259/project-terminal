import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  detach: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  write: vi.fn(async () => undefined),
  resize: vi.fn(async () => undefined),
  findNext: vi.fn(),
  findPrevious: vi.fn(),
  clearSearch: vi.fn(),
  webglShouldThrow: false,
  readClipboardText: vi.fn(async () => ""),
  paste: vi.fn(),
  terminalActions: [] as Array<
    | { type: "write"; data: number[] }
    | { type: "resize"; rows: number; cols: number }
  >,
  customKeyHandler: undefined as
    | ((event: KeyboardEvent) => boolean)
    | undefined,
}));

vi.mock("@/services", () => ({
  terminalService: {
    attach: mocks.attach,
    detach: mocks.detach,
    close: mocks.close,
    write: mocks.write,
    resize: mocks.resize,
    readClipboardText: mocks.readClipboardText,
    decodeBase64: (value: string) =>
      Uint8Array.from(atob(value), (character) => character.charCodeAt(0)),
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    rows = 43;
    cols = 132;
    options: Record<string, unknown> = {};
    buffer = { active: { viewportY: 0, baseY: 0 } };
    element: HTMLElement | undefined;

    loadAddon() {}
    open(container: HTMLElement) {
      this.element = document.createElement("div");
      container.appendChild(this.element);
    }
    onData() {
      return { dispose: vi.fn() };
    }
    onTitleChange() {
      return { dispose: vi.fn() };
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      mocks.customKeyHandler = handler;
    }
    write(data: Uint8Array | string, callback?: () => void) {
      mocks.terminalActions.push({
        type: "write",
        data:
          typeof data === "string"
            ? [...new TextEncoder().encode(data)]
            : [...data],
      });
      callback?.();
    }
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      mocks.terminalActions.push({ type: "resize", rows, cols });
    }
    reset() {}
    paste = mocks.paste;
    focus() {}
    dispose() {}
    getSelection() {
      return "";
    }
    hasSelection() {
      return false;
    }
    clearSelection() {}
    scrollToBottom() {}
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    findNext = mocks.findNext;
    findPrevious = mocks.findPrevious;
    clearDecorations = mocks.clearSearch;
  },
}));
vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class {
    serialize() {
      return "";
    }
  },
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    constructor() {
      if (mocks.webglShouldThrow) throw new Error("WebGL unavailable");
    }
    onContextLoss() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-unicode-graphemes", () => ({
  UnicodeGraphemesAddon: class {},
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {},
}));

import { TerminalView } from "./TerminalView";

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mocks.webglShouldThrow = false;
  mocks.terminalActions.length = 0;
  mocks.customKeyHandler = undefined;
  mocks.readClipboardText.mockResolvedValue("");
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal(
    "requestAnimationFrame",
    (callback: FrameRequestCallback) => window.setTimeout(callback, 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (handle: number) =>
    window.clearTimeout(handle),
  );
  mocks.attach.mockResolvedValue({
    session: {
      sessionId: "session-one",
      projectId: "project-one",
      profileId: "profile-one",
      status: "running",
      createdAt: new Date(0).toISOString(),
    },
    scrollback: "",
    replay: [],
    truncated: false,
  });
});

describe("TerminalView session lifecycle", () => {
  it("attaches on mount and detaches without closing on unmount", async () => {
    const view = render(
      <TerminalView
        sessionId="session-one"
        active
        defaultTitle="PowerShell"
      />,
    );

    await waitFor(() =>
      expect(mocks.attach).toHaveBeenCalledWith(
        "session-one",
        expect.any(String),
        expect.any(Function),
      ),
    );

    view.unmount();

    await waitFor(() =>
      expect(mocks.detach).toHaveBeenCalledWith(
        "session-one",
        expect.any(String),
      ),
    );
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it("always sends the fitted grid when attaching an existing 80x24 PTY", async () => {
    render(
      <TerminalView
        sessionId="session-one"
        active
        defaultTitle="PowerShell"
      />,
    );

    await waitFor(() =>
      expect(mocks.resize).toHaveBeenCalledWith("session-one", 43, 132),
    );
  });

  it("replays output using the grid active when each TUI frame was emitted", async () => {
    mocks.attach.mockResolvedValue({
      session: {
        sessionId: "session-one",
        projectId: "project-one",
        profileId: "profile-one",
        status: "running",
        createdAt: new Date(0).toISOString(),
      },
      scrollback: "",
      replay: [
        { type: "resize", rows: 24, cols: 80 },
        { type: "output", data: btoa("first") },
        { type: "resize", rows: 40, cols: 120 },
        { type: "output", data: btoa("second") },
      ],
      truncated: false,
    });

    render(
      <TerminalView
        sessionId="session-one"
        active
        defaultTitle="PowerShell"
      />,
    );

    await waitFor(() =>
      expect(mocks.terminalActions).toEqual(
        expect.arrayContaining([
          { type: "resize", rows: 24, cols: 80 },
          { type: "write", data: [...new TextEncoder().encode("first")] },
          { type: "resize", rows: 40, cols: 120 },
          { type: "write", data: [...new TextEncoder().encode("second")] },
        ]),
      ),
    );
    const replay = mocks.terminalActions.slice(0, 4);
    expect(replay).toEqual([
      { type: "resize", rows: 24, cols: 80 },
      { type: "write", data: [...new TextEncoder().encode("first")] },
      { type: "resize", rows: 40, cols: 120 },
      { type: "write", data: [...new TextEncoder().encode("second")] },
    ]);
  });

  it("detaches the old session and attaches the replacement on restart", async () => {
    const view = render(
      <TerminalView
        sessionId="session-one"
        active
        defaultTitle="PowerShell"
      />,
    );
    await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(1));

    mocks.attach.mockResolvedValue({
      session: {
        sessionId: "session-two",
        projectId: "project-one",
        profileId: "profile-one",
        status: "running",
        createdAt: new Date(0).toISOString(),
      },
      scrollback: "",
      replay: [],
      truncated: false,
    });
    view.rerender(
      <TerminalView
        sessionId="session-two"
        active
        defaultTitle="PowerShell"
      />,
    );

    await waitFor(() => {
      expect(mocks.detach).toHaveBeenCalledWith(
        "session-one",
        expect.any(String),
      );
      expect(mocks.attach).toHaveBeenCalledWith(
        "session-two",
        expect.any(String),
        expect.any(Function),
      );
    });
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it("opens search from the keyboard and searches incrementally", async () => {
    render(
      <TerminalView
        sessionId="session-one"
        active
        focused
        defaultTitle="PowerShell"
      />,
    );
    await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(window, { key: "f", ctrlKey: true, shiftKey: true });
    const input = await screen.findByRole("textbox", {
      name: "Search terminal",
    });
    fireEvent.change(input, { target: { value: "needle" } });
    expect(mocks.findNext).toHaveBeenCalledWith("needle", {
      incremental: true,
    });
  });

  it("falls back when WebGL initialization fails", async () => {
    mocks.webglShouldThrow = true;
    render(
      <TerminalView
        sessionId="session-one"
        active
        defaultTitle="PowerShell"
      />,
    );

    await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(1));
  });

  it("confirms a large keyboard paste before sending it to xterm", async () => {
    mocks.readClipboardText.mockResolvedValue("x".repeat(10_000));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <TerminalView
        sessionId="session-one"
        active
        defaultTitle="PowerShell"
      />,
    );
    await waitFor(() => expect(mocks.customKeyHandler).toBeTypeOf("function"));

    mocks.customKeyHandler?.(
      new KeyboardEvent("keydown", { key: "v", ctrlKey: true }),
    );

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(mocks.paste).not.toHaveBeenCalled();
  });
});
