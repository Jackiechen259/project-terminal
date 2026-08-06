import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  detach: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  write: vi.fn(async () => undefined),
  writeBinary: vi.fn(async () => undefined),
  resize: vi.fn(async () => undefined),
  findNext: vi.fn(),
  findPrevious: vi.fn(),
  clearSearch: vi.fn(),
  webglShouldThrow: false,
  readClipboardText: vi.fn(async () => ""),
  openExternalUrl: vi.fn(async () => undefined),
  paste: vi.fn(),
  terminalActions: [] as Array<
    | { type: "write"; data: number[] }
    | { type: "resize"; rows: number; cols: number }
  >,
  customKeyHandler: undefined as
    ((event: KeyboardEvent) => boolean) | undefined,
  binaryHandler: undefined as ((data: string) => void) | undefined,
  terminalOptions: undefined as Record<string, unknown> | undefined,
  liveTerminal:
    undefined as
      | {
          options: Record<string, unknown>;
          element: HTMLElement | undefined;
          textarea: HTMLTextAreaElement | undefined;
        }
      | undefined,
  oscHandlers: new Map<number, (payload: string) => boolean>(),
  csiHandlers: [] as ((params: (number | number[])[]) => boolean)[],
}));

vi.mock("@/services", () => ({
  terminalService: {
    attach: mocks.attach,
    detach: mocks.detach,
    close: mocks.close,
    write: mocks.write,
    writeBinary: mocks.writeBinary,
    resize: mocks.resize,
    readClipboardText: mocks.readClipboardText,
    openExternalUrl: mocks.openExternalUrl,
    decodeBase64: (value: string) =>
      Uint8Array.from(atob(value), (character) => character.charCodeAt(0)),
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    rows = 43;
    cols = 132;
    options: Record<string, unknown> = {};
    buffer = {
      active: { viewportY: 0, baseY: 0, type: "normal" },
      onBufferChange: () => ({ dispose: vi.fn() }),
    };
    modes = { bracketedPasteMode: false };
    parser = {
      registerOscHandler: (
        identifier: number,
        handler: (payload: string) => boolean,
      ) => {
        mocks.oscHandlers.set(identifier, handler);
        return { dispose: vi.fn() };
      },
      registerCsiHandler: (
        _id: { prefix?: string; final?: string },
        handler: (params: (number | number[])[]) => boolean,
      ) => {
        mocks.csiHandlers.push(handler);
        return { dispose: vi.fn() };
      },
    };
    element: HTMLElement | undefined;
    textarea: HTMLTextAreaElement | undefined;

    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      mocks.terminalOptions = { ...options };
      mocks.liveTerminal = this;
    }

    loadAddon() {}
    open(container: HTMLElement) {
      this.element = document.createElement("div");
      this.textarea = document.createElement("textarea");
      this.textarea.className = "xterm-helper-textarea";
      this.element.appendChild(this.textarea);
      container.appendChild(this.element);
    }
    onData() {
      return { dispose: vi.fn() };
    }
    onBinary(handler: (data: string) => void) {
      mocks.binaryHandler = handler;
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

import { usePlatformStore } from "@/stores/platformStore";
import { useSettingsStore } from "@/stores/settingsStore";

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
  mocks.binaryHandler = undefined;
  mocks.terminalOptions = undefined;
  mocks.oscHandlers.clear();
  mocks.csiHandlers.length = 0;
  mocks.readClipboardText.mockResolvedValue("");
  usePlatformStore.setState({
    info: {
      os: "windows",
      windowsBuild: 26100,
      wslSupported: true,
      availableProjectTypes: ["local", "wsl", "ssh"],
      availableLocalShells: ["powershell", "cmd", "git-bash", "wsl", "custom"],
      defaultLocalShell: "powershell",
    },
  });
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(callback, 0),
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
      <TerminalView sessionId="session-one" active defaultTitle="PowerShell" />,
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

  it("routes links to the browser only on ctrl-click, never the WebView", async () => {
    render(
      <TerminalView sessionId="session-one" active defaultTitle="PowerShell" />,
    );

    await waitFor(() => expect(mocks.terminalOptions).toBeDefined());
    const linkHandler = mocks.terminalOptions?.linkHandler as {
      activate: (event: MouseEvent, uri: string) => void;
      allowNonHttpProtocols: boolean;
    };

    // xterm rejects `file:`/`javascript:` before `activate` runs, but only
    // while this stays false.
    expect(linkHandler.allowNonHttpProtocols).toBe(false);

    linkHandler.activate(
      new MouseEvent("click", { ctrlKey: false }),
      "https://example.com",
    );
    expect(mocks.openExternalUrl).not.toHaveBeenCalled();

    linkHandler.activate(
      new MouseEvent("click", { ctrlKey: true }),
      "https://example.com",
    );
    expect(mocks.openExternalUrl).toHaveBeenCalledWith("https://example.com");
  });

  it("applies typography changes live instead of rebuilding the terminal", async () => {
    // xterm only requires a rebuild for `allowTransparency` and
    // `allowProposedApi`. Rebuilding for a font change would detach the PTY
    // and replay its scrollback, which the user would see as a flash.
    const view = render(
      <TerminalView sessionId="session-one" active defaultTitle="PowerShell" />,
    );
    await waitFor(() => expect(mocks.attach).toHaveBeenCalled());
    const attachCalls = mocks.attach.mock.calls.length;

    act(() => {
      useSettingsStore.getState().updateGeneralSettings({
        terminalFontWeight: 600,
        terminalLineHeight: 1.4,
        terminalLetterSpacing: 1,
        terminalCursorStyle: "bar",
        terminalCursorInactiveStyle: "none",
        terminalMinimumContrast: 7,
      });
    });

    await waitFor(() => {
      const options = mocks.liveTerminal?.options ?? {};
      expect(options.fontWeight).toBe(600);
      expect(options.lineHeight).toBe(1.4);
      expect(options.letterSpacing).toBe(1);
      expect(options.cursorStyle).toBe("bar");
      expect(options.cursorInactiveStyle).toBe("none");
      expect(options.minimumContrastRatio).toBe(7);
    });
    // No re-attach, so no terminal was disposed.
    expect(mocks.attach.mock.calls.length).toBe(attachCalls);

    view.unmount();
  });

  it("describes the ConPTY backend to xterm", async () => {
    render(
      <TerminalView sessionId="session-one" active defaultTitle="PowerShell" />,
    );

    await waitFor(() => expect(mocks.terminalOptions).toBeDefined());
    expect(mocks.terminalOptions?.windowsPty).toEqual({
      backend: "conpty",
      buildNumber: 26100,
    });
  });

  it("forwards legacy-encoding mouse reports byte-exactly", async () => {
    render(
      <TerminalView sessionId="session-one" active defaultTitle="PowerShell" />,
    );

    await waitFor(() => expect(mocks.binaryHandler).toBeDefined());
    await waitFor(() => expect(mocks.attach).toHaveBeenCalled());

    mocks.binaryHandler?.("\x1b[M\x20\xe9\x24");

    await waitFor(() =>
      expect(mocks.writeBinary).toHaveBeenCalledWith(
        "session-one",
        Uint8Array.from([0x1b, 0x5b, 0x4d, 0x20, 0xe9, 0x24]),
      ),
    );
  });

  it("always sends the fitted grid when attaching an existing 80x24 PTY", async () => {
    render(
      <TerminalView sessionId="session-one" active defaultTitle="PowerShell" />,
    );

    await waitFor(() =>
      expect(mocks.resize).toHaveBeenCalledWith("session-one", 43, 132, 0, 0),
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
      <TerminalView sessionId="session-one" active defaultTitle="PowerShell" />,
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

  it("writes raw binary output frames straight to the terminal", async () => {
    render(
      <TerminalView sessionId="session-one" active defaultTitle="PowerShell" />,
    );
    await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(1));

    const onFrame = mocks.attach.mock.calls[0][2] as (frame: unknown) => void;
    const payload = new TextEncoder().encode("hello Ã¿  world");
    onFrame(payload.buffer);

    await waitFor(() =>
      expect(mocks.terminalActions).toContainEqual({
        type: "write",
        data: [...payload],
      }),
    );
  });

  it("reports exit through a status control frame", async () => {
    const onExit = vi.fn();
    render(
      <TerminalView
        sessionId="session-one"
        active
        defaultTitle="PowerShell"
        onExit={onExit}
      />,
    );
    await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(1));

    const onFrame = mocks.attach.mock.calls[0][2] as (frame: unknown) => void;
    onFrame({ type: "status", status: "exited", exitCode: 7 });

    await waitFor(() => expect(onExit).toHaveBeenCalledWith(7, "exited"));
  });

  it("re-attaches when the backend reports dropped output", async () => {
    render(
      <TerminalView sessionId="session-one" active defaultTitle="PowerShell" />,
    );
    await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(1));

    const onFrame = mocks.attach.mock.calls[0][2] as (frame: unknown) => void;
    onFrame({ type: "lagged" });

    await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(mocks.detach).toHaveBeenCalledWith(
        "session-one",
        expect.any(String),
      ),
    );
  });

  it("detaches the old session and attaches the replacement on restart", async () => {
    const view = render(
      <TerminalView sessionId="session-one" active defaultTitle="PowerShell" />,
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
      <TerminalView sessionId="session-two" active defaultTitle="PowerShell" />,
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
    // Decorations must travel with every search call: without them the addon
    // scrolls to a match but highlights nothing.
    expect(mocks.findNext).toHaveBeenCalledWith("needle", {
      caseSensitive: false,
      incremental: true,
      decorations: expect.objectContaining({
        matchOverviewRuler: expect.any(String),
        activeMatchColorOverviewRuler: expect.any(String),
      }),
    });
  });

  it("falls back when WebGL initialization fails", async () => {
    mocks.webglShouldThrow = true;
    render(
      <TerminalView sessionId="session-one" active defaultTitle="PowerShell" />,
    );

    await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(1));
  });

  it("confirms a large keyboard paste before sending it to xterm", async () => {
    mocks.readClipboardText.mockResolvedValue("x".repeat(10_000));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <TerminalView sessionId="session-one" active defaultTitle="PowerShell" />,
    );
    await waitFor(() => expect(mocks.customKeyHandler).toBeTypeOf("function"));

    mocks.customKeyHandler?.(
      new KeyboardEvent("keydown", { key: "v", ctrlKey: true }),
    );

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(mocks.paste).not.toHaveBeenCalled();
  });

  it("does not warn about newlines the shell's line editor will hold", async () => {
    // With bracketed paste on - every modern shell's line editor - a
    // multi-line paste lands in the editor and cannot execute, so the
    // confirmation was pure noise. Size stays unconditional.
    mocks.readClipboardText.mockResolvedValue("a\n".repeat(50));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <TerminalView sessionId="session-one" active defaultTitle="PowerShell" />,
    );
    await waitFor(() => expect(mocks.customKeyHandler).toBeTypeOf("function"));
    if (mocks.liveTerminal) {
      (
        mocks.liveTerminal as unknown as {
          modes: { bracketedPasteMode: boolean };
        }
      ).modes.bracketedPasteMode = true;
    }

    mocks.customKeyHandler?.(
      new KeyboardEvent("keydown", { key: "v", ctrlKey: true }),
    );

    await waitFor(() => expect(mocks.paste).toHaveBeenCalledTimes(1));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("reports the working directory the shell claims, and rejects the rest", async () => {
    const onCwdChange = vi.fn();
    render(
      <TerminalView
        sessionId="session-one"
        active
        defaultTitle="PowerShell"
        onCwdChange={onCwdChange}
      />,
    );
    await waitFor(() => expect(mocks.oscHandlers.has(7)).toBe(true));
    const osc7 = mocks.oscHandlers.get(7)!;

    expect(osc7("file:///C:/Users/me/project")).toBe(true);
    expect(onCwdChange).toHaveBeenCalledWith("C:\\Users\\me\\project");

    onCwdChange.mockClear();
    // The value came out of the PTY, so it is a claim rather than a fact. A
    // path on another machine is not this session's directory, and a
    // malformed report is consumed rather than printed.
    expect(osc7("file://other-host/tmp")).toBe(true);
    expect(osc7("not a url")).toBe(true);
    expect(onCwdChange).not.toHaveBeenCalled();
  });

  it("records the exit status a command reports", async () => {
    const onCommandFinished = vi.fn();
    render(
      <TerminalView
        sessionId="session-one"
        active
        defaultTitle="PowerShell"
        onCommandFinished={onCommandFinished}
      />,
    );
    await waitFor(() => expect(mocks.oscHandlers.has(133)).toBe(true));
    const osc133 = mocks.oscHandlers.get(133)!;

    expect(osc133("A")).toBe(true);
    expect(osc133("C")).toBe(true);
    expect(onCommandFinished).not.toHaveBeenCalled();

    expect(osc133("D;130")).toBe(true);
    expect(onCommandFinished).toHaveBeenCalledWith(130);
  });

  it("sends a CSI-u sequence for chords xterm collapses", async () => {
    render(
      <TerminalView sessionId="session-one" active defaultTitle="PowerShell" />,
    );
    await waitFor(() => expect(mocks.customKeyHandler).toBeTypeOf("function"));
    await waitFor(() => expect(mocks.attach).toHaveBeenCalled());

    // xterm's Enter handling consults only altKey, so Shift+Enter would
    // otherwise reach the program as a bare carriage return.
    const handled = mocks.customKeyHandler?.(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: true }),
    );
    expect(handled).toBe(false);
    await waitFor(() =>
      expect(mocks.write).toHaveBeenCalledWith("session-one", "\x1b[13;2u"),
    );
  });

  it("pins the helper textarea while the cursor is hidden", async () => {
    render(
      <TerminalView sessionId="session-one" active defaultTitle="PowerShell" />,
    );
    await waitFor(() =>
      expect(mocks.csiHandlers.length).toBe(2), // hide + show handlers
    );

    const terminal = mocks.liveTerminal!;
    const textarea = terminal.textarea!;
    // Simulate xterm moving the textarea to an intermediate redraw cell.
    textarea.style.left = "320px";
    textarea.style.top = "96px";

    // `ESC[?25l` hides the cursor: the textarea must be pinned out of the
    // way so the IME does not follow the redraw's intermediate positions.
    mocks.csiHandlers[0]([25]);
    expect(textarea.style.getPropertyPriority("left")).toBe("important");
    expect(textarea.style.left).toBe("0px");
    expect(textarea.style.top).toBe("0px");
    expect(textarea.style.opacity).toBe("0");

    // xterm's internal sync must not override the pin mid-frame.
    textarea.style.left = "480px";
    expect(textarea.style.left).toBe("480px");
    expect(textarea.style.opacity).toBe("0");

    // `ESC[?25h` shows the cursor again: the pin lifts and xterm's own
    // positioning takes over once more.
    mocks.csiHandlers[1]([25]);
    expect(textarea.style.getPropertyPriority("left")).toBe("");
  });
});
