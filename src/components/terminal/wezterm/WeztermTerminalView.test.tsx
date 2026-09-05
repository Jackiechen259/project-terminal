import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  TerminalRenderFrame,
  TerminalRenderMessage,
} from "@/lib/terminalFrames";
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
    render: vi.fn(),
    renderImmediate: vi.fn(),
    redraw: vi.fn(),
    setTheme: vi.fn(),
    setFont: vi.fn(),
    setCursorStyle: vi.fn(),
    setCursorBlink: vi.fn(),
    setFocused: vi.fn(),
    setVisible: vi.fn(),
    setSelection: vi.fn(),
    setSearchMatch: vi.fn(),
    selectionText: vi.fn(() => ""),
    rowAtPoint: vi.fn((): { column: number; row: number } | null => null),
    linkAtPoint: vi.fn(() => null),
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
    detach: vi.fn(async () => undefined),
    search: vi.fn(async () => []),
    selectionText: vi.fn(async () => ""),
    writeClipboardText: vi.fn(async () => undefined),
    readClipboardText: vi.fn(async () => ""),
    paste: vi.fn(async () => undefined),
    bracketedPasteEnabled: vi.fn(async () => true),
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
    mocks.renderer.render.mockClear();
    mocks.renderer.renderImmediate.mockClear();
    mocks.renderer.redraw.mockClear();
    mocks.renderer.resize.mockClear();
    mocks.renderer.dispose.mockClear();
    mocks.renderer.setVisible.mockClear();
    mocks.renderer.setSearchMatch.mockClear();
    mocks.createTerminalRenderer.mockClear();
    mocks.terminalService.attachRender.mockClear();
    mocks.terminalService.resize.mockClear();
    mocks.terminalService.requestRenderSnapshot.mockClear();
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
    mocks.renderer.rowAtPoint.mockReset();
    mocks.renderer.rowAtPoint.mockReturnValue(null);
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

  it("accepts live frames while visible and hidden without a visibility snapshot", async () => {
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
    const firstAttachment = mocks.getAttachedOnMessage();
    act(() => {
      firstAttachment?.({ type: "frame", frame: frame(40, 120, 10) });
    });

    mocks.renderer.render.mockClear();
    mocks.terminalService.requestRenderSnapshot.mockClear();
    act(() => {
      firstAttachment?.({
        type: "frame",
        frame: frame(40, 120, 11, false),
      });
      firstAttachment?.({
        type: "frame",
        frame: frame(40, 120, 12, false),
      });
      firstAttachment?.({
        type: "frame",
        frame: frame(40, 120, 13, false),
      });
    });
    expect(mocks.renderer.render).toHaveBeenCalledTimes(3);
    expect(mocks.terminalService.requestRenderSnapshot).not.toHaveBeenCalled();

    view.rerender(
      <WeztermTerminalView
        sessionId="session-1"
        active={false}
        defaultTitle="Terminal"
      />,
    );
    mocks.renderer.redraw.mockClear();
    act(() => {
      firstAttachment?.({
        type: "frame",
        frame: frame(40, 120, 14, false),
      });
      firstAttachment?.({
        type: "frame",
        frame: frame(40, 120, 15, false),
      });
    });
    expect(mocks.renderer.render).toHaveBeenCalledTimes(5);
    expect(mocks.terminalService.requestRenderSnapshot).not.toHaveBeenCalled();

    view.rerender(
      <WeztermTerminalView
        sessionId="session-1"
        active
        defaultTitle="Terminal"
      />,
    );
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
      .mockReturnValueOnce({ column: 0, row: 0 })
      .mockReturnValueOnce({ column: 5, row: 0 })
      .mockReturnValueOnce({ column: 5, row: 0 });

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

    mocks.renderer.rowAtPoint.mockReturnValue({ column: 3, row: 0 });
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
});
