import { whenTerminalFontReady } from "@/lib/terminalFonts";

let terminalViewModule: Promise<typeof import("./TerminalView")> | undefined;

export function loadTerminalView() {
  // The font has to be loaded before the first `new Terminal()`, not merely
  // before the first paint: xterm measures its character cell at construction
  // and keeps the result. Waiting here rather than inside the component keeps
  // the terminal's own effect synchronous, and costs nothing - the font is a
  // local asset and resolves well inside the module download it runs beside.
  terminalViewModule ??= Promise.all([
    import("./TerminalView"),
    whenTerminalFontReady(),
  ]).then(([module]) => module);
  return terminalViewModule;
}

/** Overlap xterm's code download with backend PTY process creation. */
export function preloadTerminalView() {
  void loadTerminalView().catch(() => {
    // Let React.lazy retry if an early speculative fetch was interrupted.
    terminalViewModule = undefined;
  });
}
