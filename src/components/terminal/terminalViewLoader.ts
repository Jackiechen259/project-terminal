import { whenTerminalFontReady } from "@/lib/terminalFonts";

let weztermTerminalViewModule:
  Promise<typeof import("./wezterm/WeztermTerminalView")> | undefined;

/** Overlap renderer code download with backend PTY process creation. */
export function preloadTerminalView() {
  void loadWeztermTerminalView().catch(() => {
    // Let React.lazy retry if an early speculative fetch was interrupted.
    weztermTerminalViewModule = undefined;
  });
}

export function loadWeztermTerminalView() {
  weztermTerminalViewModule ??= Promise.all([
    import("./wezterm/WeztermTerminalView"),
    whenTerminalFontReady(),
  ]).then(([module]) => module);
  return weztermTerminalViewModule;
}
