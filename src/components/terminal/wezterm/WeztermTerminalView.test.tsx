import { act, render } from "@testing-library/react";
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
    setTheme: vi.fn(),
    setFont: vi.fn(),
    setCursorStyle: vi.fn(),
    setCursorBlink: vi.fn(),
    setFocused: vi.fn(),
    setSelection: vi.fn(),
    setSearchMatch: vi.fn(),
    selectionText: vi.fn(() => ""),
    rowAtPoint: vi.fn(() => null),
    linkAtPoint: vi.fn(() => null),
    rowText: vi.fn(() => ""),
    dispose: vi.fn(),
  };

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
  };

  return {
    renderer,
    terminalService,
    getAttachedOnMessage: () => attachedOnMessage,
    resolveResize: () => resolveResize?.(),
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
  createTerminalRenderer: vi.fn(() => mocks.renderer),
}));

function frame(
  rows: number,
  cols: number,
  sequence: number,
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
    fullSnapshot: true,
  };
}

describe("WeztermTerminalView render synchronization", () => {
  beforeEach(() => {
    mocks.renderer.measureGrid.mockReturnValue({ rows: 40, cols: 120 });
    mocks.renderer.render.mockClear();
    mocks.renderer.resize.mockClear();
    mocks.renderer.setSearchMatch.mockClear();
    mocks.terminalService.attachRender.mockClear();
    mocks.terminalService.resize.mockClear();
    mocks.terminalService.requestRenderSnapshot.mockClear();
    mocks.terminalService.detach.mockClear();
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
    expect(mocks.renderer.render).toHaveBeenCalledWith(validFrame);

    view.unmount();
  });
});
