let terminalViewModule:
  | Promise<typeof import("./TerminalView")>
  | undefined;

export function loadTerminalView() {
  terminalViewModule ??= import("./TerminalView");
  return terminalViewModule;
}

/** Overlap xterm's code download with backend PTY process creation. */
export function preloadTerminalView() {
  void loadTerminalView().catch(() => {
    // Let React.lazy retry if an early speculative fetch was interrupted.
    terminalViewModule = undefined;
  });
}
