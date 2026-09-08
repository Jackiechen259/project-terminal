import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  TerminalRenderFrame,
  TerminalRenderMessage,
} from "@/lib/terminalFrames";
import {
  IME_CARET_HIDDEN_TRANSIENT_MS,
  IME_CARET_SETTLE_MS,
} from "@/lib/terminalIme";
import {
  DEFAULT_GENERAL_SETTINGS,
  useSettingsStore,
} from "@/stores/settingsStore";

const mocks = vi.hoisted(() => {
  let attachedOnMessage: ((message: TerminalRenderMessage) => void) | null =
    null;
  let resolveResize: (() => void) | null = null;

  const renderer = {
    mount: vi.fn(),
    resize: vi.fn(),
    measureGrid: vi.fn(() => ({ rows: 40, cols: 120 })),
    render: vi.fn(() => true),
    renderImmediate: vi.fn(() => true),
    redraw: vi.fn(),
    setTheme: vi.fn(),
    setFont: vi.fn(),
    setCursorStyle: vi.fn(),
    setCursorBlink: vi.fn(),
    setFocused: vi.fn(),
    setVisible: vi.fn(),
    noteInputActivity: vi.fn(),
    setSelection: vi.fn(),
    setSearchMatch: vi.fn(),
    selectionText: vi.fn(() => ""),
    rowAtPoint: vi.fn(
      (): {
        column: number;
        row: number;
        xPixelOffset: number;
        yPixelOffset: number;
      } | null => null,
    ),
    linkAtPoint: vi.fn(() => null),
    cursorRect: vi.fn(() => ({
      x: 16,
      y: 34,
      width: 8,
      height: 17,
      visible: true,
    })),
    rowText: vi.fn(() => ""),
    dispose: vi.fn(),
  };

  const createTerminalRenderer = vi.fn(() => renderer);

  const terminalService = {
    attachRender: vi.fn(
      async (
        _sessionId: string,
        _clientId: string,
        onMessage: (message: TerminalRenderMessage) => void,
      ) => {
        attachedOnMessage = onMessage;
        return { session: { status: "running" } };
      },
    ),
    resize: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveResize = resolve;
        }),
    ),
    requestRenderSnapshot: vi.fn(async () => undefined),
    setRendererPaused: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
    search: vi.fn(async () => []),
    selectionText: vi.fn(async () => ""),
    writeClipboardText: vi.fn(async () => undefined),
    readClipboardText: vi.fn(async () => ""),
    paste: vi.fn(async () => undefined),
    bracketedPasteEnabled: vi.fn(async () => true),
    mouseEvent: vi.fn(async () => undefined),
    focusChanged: vi.fn(async () => undefined),
    keyDown: vi.fn(async () => undefined),
    textInput: vi.fn(async () => undefined),
  };

  return {
    renderer,
    createTerminalRenderer,
    terminalService,
    getAttachedOnMessage: () => attachedOnMessage,
    resolveResize: () => resolveResize?.(),
    setAttachedOnMessage: (
      onMessage: (message: TerminalRenderMessage) => void,
    ) => {
      attachedOnMessage = onMessage;
    },
    resetAttachment: () => {
      attachedOnMessage = null;
      resolveResize = null;
    },
  };
});

vi.mock("@/services", async () => {
  const actual =
    await vi.importActual<typeof import("@/services")>("@/services");
  return { ...actual, terminalService: mocks.terminalService };
});

vi.mock("@/lib/appCommands", () => ({
  listenForAppCommands: vi.fn(() => () => undefined),
}));

vi.mock("@/stores/colorSchemeStore", () => ({
  useColorSchemeStore: (
    selector: (state: {
      schemes: never[];
      load: () => Promise<never[]>;
    }) => unknown,
  ) => selector({ schemes: [], load: async () => [] }),
}));

vi.mock("./renderer/WebGLRenderer", () => ({
  createTerminalRenderer: mocks.createTerminalRenderer,
}));

function frame(
  rows: number,
  cols: number,
  sequence: number,
  fullSnapshot = true,
): TerminalRenderFrame {
  return {
    sequence,
    rows,
    cols,
    dirtyRows: [],
    cursor: {
      column: 0,
      row: 0,
      shape: "default",
      visibility: "hidden",
    },
    scrollbackLength: 0,
    viewportTop: 0,
    viewportBottom: rows,
    alternateScreen: false,
    mouseReporting: false,
    fullSnapshot,
  };
}

describe("WeztermTerminalView render synchronization", () => {
  beforeEach(() => {
    mocks.renderer.measureGrid.mockReturnValue({ rows: 40, cols: 120 });
    mocks.renderer.render.mockReset();
    mocks.renderer.render.mockReturnValue(true);
    mocks.renderer.renderImmediate.mockReset();
    mocks.renderer.renderImmediate.mockReturnValue(true);
    mocks.renderer.redraw.mockClear();
    mocks.renderer.resize.mockClear();
    mocks.renderer.dispose.mockClear();
    mocks.renderer.setVisible.mockClear();
    mocks.renderer.setCursorBlink.mockClear();
    mocks.renderer.setCursorStyle.mockClear();
    mocks.renderer.setSearchMatch.mockClear();
    mocks.renderer.noteInputActivity.mockClear();
    mocks.createTerminalRenderer.mockClear();
    mocks.terminalService.attachRender.mockClear();
    mocks.terminalService.resize.mockClear();
    mocks.terminalService.requestRenderSnapshot.mockClear();
    mocks.terminalService.setRendererPaused.mockClear();
    mocks.terminalService.detach.mockClear();
    mocks.terminalService.selectionText.mockReset();
    mocks.terminalService.selectionText.mockResolvedValue("");
    mocks.terminalService.writeClipboardText.mockReset();
    mocks.terminalService.writeClipboardText.mockResolvedValue(undefined);
    mocks.terminalService.readClipboardText.mockReset();
    mocks.terminalService.readClipboardText.mockResolvedValue("");
    mocks.terminalService.paste.mockReset();
    mocks.terminalService.paste.mockResolvedValue(undefined);
    mocks.terminalService.bracketedPasteEnabled.mockReset();
    mocks.terminalService.bracketedPasteEnabled.mockResolvedValue(true);
    mocks.terminalService.mouseEvent.mockReset();
    mocks.terminalService.mouseEvent.mockResolvedValue(undefined);
    mocks.terminalService.focusChanged.mockReset();
    mocks.terminalService.focusChanged.mockResolvedValue(undefined);
    mocks.terminalService.keyDown.mockReset();
    mocks.terminalService.keyDown.mockResolvedValue(undefined);
    mocks.terminalService.textInput.mockReset();
    mocks.terminalService.textInput.mockResolvedValue(undefined);
    mocks.renderer.rowAtPoint.mockReset();
    mocks.renderer.rowAtPoint.mockReturnValue(null);
    mocks.renderer.cursorRect.mockReset();
    mocks.renderer.cursorRect.mockReturnValue({
      x: 16,
      y: 34,
      width: 8,
      height: 17,
      visible: true,
    });
    mocks.resetAttachment();
    useSettingsStore.setState({
      ...DEFAULT_GENERAL_SETTINGS,
      theme: "light",
      terminalRenderer: "dom",
    });

    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(680);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: ResizeObserverCallback) {}

        observe() {
          this.callback([], this as unknown as ResizeObserver);
        }

        disconnect() {}
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    // A no-op unless an individual test opted into fake timers for the IME
    // caret's settle debounce - guards against leaking them into later
    // tests if one exits early.
    vi.useRealTimers();
  });

  it("requests and renders a new-size snapshot after a delayed resize", async () => {
    const { WeztermTerminalView } = await import("./WeztermTerminalView");
    const view = render(
      <WeztermTerminalView
        sessionId="session-1"
        active
        defaultTitle="Terminal"
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.terminalService.resize).toHaveBeenCalledWith(
      "session-1",
      40,
      120,
      1200,
      680,
    );
    const onMessage = mocks.getAttachedOnMessage();
    expect(onMessage).not.toBeNull();

    const staleFrame = frame(24, 80, 1);
    act(() => {
      onMessage?.({ type: "frame", frame: staleFrame });
    });
    expect(mocks.terminalService.requestRenderSnapshot).not.toHaveBeenCalled();
    expect(mocks.renderer.render).not.toHaveBeenCalled();

    await act(async () => {
      mocks.resolveResize();
      await Promise.resolve();
    });

    expect(mocks.terminalService.requestRenderSnapshot).toHaveBeenCalledTimes(
      1,
    );

    const validFrame = frame(40, 120, 2);
    act(() => {
      onMessage?.({ type: "frame", frame: validFrame });
    });
    expect(mocks.renderer.renderImmediate).toHaveBeenCalledWith(validFrame);

    view.unmount();
  });

  it("keeps one renderer and one render subscription across tab switches", async () => {
    const { WeztermTerminalView } = await import("./WeztermTerminalView");
    const view = render(
      <WeztermTerminalView
        sessionId="session-1"
        active
        defaultTitle="Terminal"
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    const onMessage = mocks.getAttachedOnMessage();
    const cachedFrame = frame(40, 120, 10);
    act(() => {
      onMessage?.({ type: "frame", frame: cachedFrame });
    });
    expect(mocks.renderer.renderImmediate).toHaveBeenCalledWith(cachedFrame);

    const resizeCalls = mocks.renderer.resize.mock.calls.length;
    mocks.renderer.redraw.mockClear();
    view.rerender(
      <WeztermTerminalView
        sessionId="session-1"
        active={false}
        defaultTitle="Terminal"
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.renderer.dispose).not.toHaveBeenCalled();
    expect(mocks.terminalService.attachRender).toHaveBeenCalledTimes(1);
    expect(mocks.terminalService.detach).not.toHaveBeenCalled();

    view.rerender(
      <WeztermTerminalView
        sessionId="session-1"
        active
        defaultTitle="Terminal"
      />,
    );

    expect(mocks.createTerminalRenderer).toHaveBeenCalledTimes(1);
    expect(mocks.renderer.redraw).toHaveBeenCalledTimes(1);
    expect(mocks.renderer.resize).toHaveBeenCalledTimes(resizeCalls);
    expect(mocks.terminalService.attachRender).toHaveBeenCalledTimes(1);
    expect(mocks.terminalService.detach).not.toHaveBeenCalled();

    view.unmount();
    expect(mocks.renderer.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.terminalService.detach).toHaveBeenCalledTimes(1);
  });

  it("pauses render delivery while hidden and snapshots on show", async () => {
    const { WeztermTerminalView } = await import("./WeztermTerminalView");
    const view = render(
      <WeztermTerminalView
        sessionId="session-1"
        active
        defaultTitle="Terminal"
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });
    const clientId = mocks.terminalService.attachRender.mock.calls[0]?.[1] as
      string | undefined;
    expect(clientId).toBeTruthy();
    const firstAttachment = mocks.getAttachedOnMessage();
    act(() => {
      firstAttachment?.({ type: "frame", frame: frame(40, 120, 10) });
    });

    mocks.terminalService.requestRenderSnapshot.mockClear();
    mocks.terminalService.setRendererPaused.mockClear();
    view.rerender(
      <WeztermTerminalView
        sessionId="session-1"
        active={false}
        defaultTitle="Terminal"
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.terminalService.setRendererPaused).toHaveBeenCalledWith(
      "session-1",
      clientId,
      true,
    );
    expect(mocks.terminalService.requestRenderSnapshot).not.toHaveBeenCalled();
    expect(mocks.renderer.setVisible).toHaveBeenCalledWith(false);

    mocks.renderer.redraw.mockClear();
    mocks.terminalService.setRendererPaused.mockClear();
    view.rerender(
      <WeztermTerminalView
        sessionId="session-1"
        active
        defaultTitle="Terminal"
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.terminalService.setRendererPaused).toHaveBeenCalledWith(
      "session-1",
      clientId,
      false,
    );
    expect(mocks.terminalService.requestRenderSnapshot).toHaveBeenCalled();
    expect(mocks.renderer.redraw).toHaveBeenCalledTimes(1);
    expect(mocks.terminalService.attachRender).toHaveBeenCalledTimes(1);
    expect(mocks.terminalService.detach).not.toHaveBeenCalled();

    view.unmount();
    expect(mocks.terminalService.detach).toHaveBeenCalledTimes(1);
  });

  it("copies a dragged selection through the native clipboard after the model fetch", async () => {
    // WebView2 denies clipboard.writeText once the user-activation token is
    // consumed by the awaited selection IPC. Copy must not depend on it.
    const writeText = vi.fn(async () => {
      throw new DOMException("Write permission denied", "NotAllowedError");
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    mocks.terminalService.selectionText.mockImplementation(async () => {
      await Promise.resolve();
      return "hello";
    });

    const { WeztermTerminalView } = await import("./WeztermTerminalView");
    const view = render(
      <WeztermTerminalView
        sessionId="session-1"
        active
        defaultTitle="Terminal"
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      mocks.resolveResize();
      await Promise.resolve();
    });
    act(() => {
      mocks.getAttachedOnMessage()?.({
        type: "frame",
        frame: frame(40, 120, 1),
      });
    });

    mocks.renderer.rowAtPoint
      .mockReturnValueOnce({
        column: 0,
        row: 0,
        xPixelOffset: 0,
        yPixelOffset: 0,
      })
      .mockReturnValueOnce({
        column: 5,
        row: 0,
        xPixelOffset: 0,
        yPixelOffset: 0,
      })
      .mockReturnValueOnce({
        column: 5,
        row: 0,
        xPixelOffset: 0,
        yPixelOffset: 0,
      });

    const canvas = view.getByLabelText("Terminal");
    fireEvent.mouseDown(canvas, { clientX: 8, clientY: 8, button: 0 });
    fireEvent.mouseMove(canvas, { clientX: 48, clientY: 8, buttons: 1 });
    fireEvent.mouseUp(canvas, { clientX: 48, clientY: 8, button: 0 });

    await act(async () => {
      fireEvent.contextMenu(canvas.closest(".terminal-renderer")!);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.terminalService.selectionText).toHaveBeenCalledWith(
      "session-1",
      { stableRow: 0, column: 0 },
      { stableRow: 0, column: 5 },
    );
    expect(mocks.terminalService.writeClipboardText).toHaveBeenCalledWith(
      "hello",
    );
    expect(writeText).not.toHaveBeenCalled();

    view.unmount();
  });

  it("pastes on right-click when the click left only a collapsed selection", async () => {
    mocks.terminalService.readClipboardText.mockResolvedValue("paste-me");

    const { WeztermTerminalView } = await import("./WeztermTerminalView");
    const view = render(
      <WeztermTerminalView
        sessionId="session-1"
        active
        defaultTitle="Terminal"
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      mocks.resolveResize();
      await Promise.resolve();
    });
    act(() => {
      mocks.getAttachedOnMessage()?.({
        type: "frame",
        frame: frame(40, 120, 1),
      });
    });

    mocks.renderer.rowAtPoint.mockReturnValue({
      column: 3,
      row: 0,
      xPixelOffset: 0,
      yPixelOffset: 0,
    });
    const canvas = view.getByLabelText("Terminal");
    fireEvent.mouseDown(canvas, { clientX: 24, clientY: 8, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 24, clientY: 8, button: 0 });

    await act(async () => {
      fireEvent.contextMenu(canvas.closest(".terminal-renderer")!);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.terminalService.selectionText).not.toHaveBeenCalled();
    expect(mocks.terminalService.writeClipboardText).not.toHaveBeenCalled();
    expect(mocks.terminalService.paste).toHaveBeenCalledWith(
      "session-1",
      "paste-me",
    );

    view.unmount();
  });

  it("forwards hover mouse moves while a TUI has mouse reporting enabled", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);

    const { WeztermTerminalView } = await import("./WeztermTerminalView");
    const view = render(
      <WeztermTerminalView
        sessionId="session-1"
        active
        defaultTitle="Terminal"
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      mocks.resolveResize();
      await Promise.resolve();
    });
    act(() => {
      mocks.getAttachedOnMessage()?.({
        type: "frame",
        frame: { ...frame(40, 120, 1), mouseReporting: true },
      });
    });

    mocks.renderer.rowAtPoint.mockReturnValue({
      column: 4,
      row: 2,
      xPixelOffset: 3,
      yPixelOffset: 5,
    });
    const canvas = view.getByLabelText("Terminal");
    fireEvent.mouseMove(canvas, { clientX: 40, clientY: 20, buttons: 0 });

    expect(mocks.terminalService.mouseEvent).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        kind: "move",
        button: "none",
        x: 4,
        y: 2,
        xPixelOffset: 3,
        yPixelOffset: 5,
      }),
    );

    view.unmount();
  });

  it("reports focus changes to the terminal model", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { WeztermTerminalView } = await import("./WeztermTerminalView");
    const view = render(
      <WeztermTerminalView
        sessionId="session-1"
        active
        focused
        defaultTitle="Terminal"
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.terminalService.focusChanged).toHaveBeenCalledWith(
      "session-1",
      true,
    );

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(mocks.terminalService.focusChanged).toHaveBeenCalledWith(
      "session-1",
      false,
    );

    view.unmount();
  });

  async function mountReadyView() {
    const { WeztermTerminalView } = await import("./WeztermTerminalView");
    const view = render(
      <WeztermTerminalView
        sessionId="session-1"
        active
        defaultTitle="Terminal"
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      mocks.resolveResize();
      await Promise.resolve();
    });
    act(() => {
      mocks.getAttachedOnMessage()?.({
        type: "frame",
        frame: frame(40, 120, 1),
      });
    });
    return view;
  }

  it("parks the IME caret on the cursor cell", async () => {
    const view = await mountReadyView();
    const input = view.getByLabelText("Terminal input");
    expect(input.style.left).toBe("16px");
    expect(input.style.top).toBe("34px");
    expect(input.style.width).toBe("8px");
    expect(input.style.height).toBe("17px");
    view.unmount();
  });

  it("shows preedit at the cursor without sending composing text", async () => {
    const view = await mountReadyView();
    const input = view.getByLabelText("Terminal input");
    fireEvent.compositionStart(input);
    fireEvent.compositionUpdate(input, { data: "ni" });
    expect(view.getByTestId("terminal-ime-preedit")).toHaveTextContent("ni");
    expect(mocks.terminalService.textInput).not.toHaveBeenCalled();
    expect(mocks.terminalService.keyDown).not.toHaveBeenCalled();
    view.unmount();
  });

  it("commits composed text once and swallows the confirming key", async () => {
    const view = await mountReadyView();
    const input = view.getByLabelText("Terminal input") as HTMLTextAreaElement;
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "n", isComposing: true });
    fireEvent.compositionUpdate(input, { data: "你" });
    fireEvent.compositionEnd(input, { data: "你" });
    input.value = "你";
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: "Enter", isComposing: false });

    expect(mocks.terminalService.textInput).toHaveBeenCalledTimes(1);
    expect(mocks.terminalService.textInput).toHaveBeenCalledWith(
      "session-1",
      "你",
    );
    expect(mocks.terminalService.keyDown).not.toHaveBeenCalled();
    expect(view.queryByTestId("terminal-ime-preedit")).toBeNull();
    view.unmount();
  });

  it("does not advance past a rejected frame and requests exactly one recovery snapshot", async () => {
    const view = await mountReadyView();
    mocks.terminalService.requestRenderSnapshot.mockClear();
    // The renderer could not apply this frame to its row cache (e.g. it
    // depends on rows the cache no longer has).
    mocks.renderer.render.mockReturnValueOnce(false);

    act(() => {
      mocks.getAttachedOnMessage()?.({
        type: "frame",
        frame: frame(40, 120, 2, false),
      });
    });
    expect(mocks.terminalService.requestRenderSnapshot).toHaveBeenCalledTimes(
      1,
    );

    // The backend answers with a fresh full snapshot, accepted normally (the
    // mock's default return value) - proving the component recovered rather
    // than getting stuck behind the rejected sequence number, and that it
    // did not ask for a second recovery snapshot on top of the first.
    const recovery = frame(40, 120, 3, true);
    act(() => {
      mocks.getAttachedOnMessage()?.({ type: "frame", frame: recovery });
    });
    expect(mocks.renderer.renderImmediate).toHaveBeenCalledWith(recovery);
    expect(mocks.terminalService.requestRenderSnapshot).toHaveBeenCalledTimes(
      1,
    );

    view.unmount();
  });

  it("freezes the IME caret during composition and re-docks it once composition ends", async () => {
    const view = await mountReadyView();
    const input = view.getByLabelText("Terminal input") as HTMLTextAreaElement;
    expect(input.style.left).toBe("16px");

    fireEvent.compositionStart(input);

    // The model cursor moves mid-composition (e.g. a status line redrawing
    // elsewhere) - the caret must not chase it while composing.
    mocks.renderer.cursorRect.mockReturnValue({
      x: 64,
      y: 34,
      width: 8,
      height: 17,
      visible: true,
    });
    act(() => {
      mocks.getAttachedOnMessage()?.({
        type: "frame",
        frame: frame(40, 120, 2, false),
      });
    });
    expect(input.style.left).toBe("16px");

    fireEvent.compositionEnd(input, { data: "" });
    expect(input.style.left).toBe("64px");

    view.unmount();
  });

  it("ignores a hidden cursor reported while a repaint is in flight", async () => {
    // `performance` is faked alongside the timers because the caret weighs a
    // hide against the clock, not against timer ticks - letting the two run
    // on different clocks would test a situation that cannot occur.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const view = await mountReadyView();
      const input = view.getByLabelText(
        "Terminal input",
      ) as HTMLTextAreaElement;
      expect(input.style.left).toBe("16px");

      // Output starts scrolling. The model reports the cursor hidden at
      // whatever cell the repaint reached, and it holds there long enough to
      // look settled - following it would drag the IME candidate window off
      // to that cell, far from where the user is typing.
      mocks.renderer.cursorRect.mockReturnValue({
        x: 632,
        y: 34,
        width: 8,
        height: 17,
        visible: false,
      });
      act(() => {
        mocks.getAttachedOnMessage()?.({
          type: "frame",
          frame: frame(40, 120, 2, false),
        });
      });
      expect(input.style.left).toBe("16px");

      act(() => {
        vi.advanceTimersByTime(IME_CARET_SETTLE_MS + 1);
      });
      expect(input.style.left).toBe("16px");

      // Output stops and the cursor comes back where it belongs.
      mocks.renderer.cursorRect.mockReturnValue({
        x: 24,
        y: 34,
        width: 8,
        height: 17,
        visible: true,
      });
      act(() => {
        mocks.getAttachedOnMessage()?.({
          type: "frame",
          frame: frame(40, 120, 3, false),
        });
      });
      expect(input.style.left).toBe("24px");

      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("parks the IME caret on a cursor that stays hidden after the repaint", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const view = await mountReadyView();
      const input = view.getByLabelText(
        "Terminal input",
      ) as HTMLTextAreaElement;
      expect(input.style.left).toBe("16px");

      // An Ink-style CLI draws its own cursor and parks the real one on its
      // input cell. Nothing further is painted, so the caret has to settle
      // there on its own rather than wait for output that never comes.
      mocks.renderer.cursorRect.mockReturnValue({
        x: 48,
        y: 34,
        width: 8,
        height: 17,
        visible: false,
      });
      act(() => {
        mocks.getAttachedOnMessage()?.({
          type: "frame",
          frame: frame(40, 120, 2, false),
        });
      });
      expect(input.style.left).toBe("16px");

      act(() => {
        vi.advanceTimersByTime(
          IME_CARET_HIDDEN_TRANSIENT_MS + IME_CARET_SETTLE_MS + 1,
        );
      });
      expect(input.style.left).toBe("48px");

      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls noteInputActivity on a key press", async () => {
    const view = await mountReadyView();
    const input = view.getByLabelText("Terminal input");

    fireEvent.keyDown(input, { key: "ArrowRight" });

    expect(mocks.renderer.noteInputActivity).toHaveBeenCalled();
    expect(mocks.terminalService.keyDown).toHaveBeenCalled();
    view.unmount();
  });

  it("calls setCursorBlink after switching terminalRenderer and recreating the renderer", async () => {
    const view = await mountReadyView();
    mocks.renderer.setCursorBlink.mockClear();
    mocks.renderer.setCursorStyle.mockClear();
    mocks.createTerminalRenderer.mockClear();

    act(() => {
      useSettingsStore.setState({ terminalRenderer: "webgl" });
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Regression: the mount effect used to only mount/theme/font the fresh
    // renderer, relying on a *different* effect (keyed on font/theme/typo,
    // not on the renderer identity) to apply cursor style/blink - which
    // never re-ran here since none of its own deps changed.
    expect(mocks.createTerminalRenderer).toHaveBeenCalledTimes(1);
    expect(mocks.renderer.setCursorBlink).toHaveBeenCalledWith(
      DEFAULT_GENERAL_SETTINGS.cursorBlink,
    );
    expect(mocks.renderer.setCursorStyle).toHaveBeenCalled();

    view.unmount();
  });
});
