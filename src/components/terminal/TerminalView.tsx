import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { SearchAddon } from "@xterm/addon-search";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ChevronDown, ChevronUp, Search, TriangleAlert, X } from "lucide-react";
import "@xterm/xterm/css/xterm.css";

import { useTranslation } from "@/i18n";
import { listenForAppCommands } from "@/lib/appCommands";
import { TerminalInputQueue } from "@/lib/terminalInputQueue";
import { resolveExtraKeySequence } from "@/lib/terminalKeys";
import {
  parsePromptMark,
  parseWorkingDirectory,
} from "@/lib/terminalShellIntegration";
import { TerminalOutputQueue } from "@/lib/terminalOutputQueue";
import { TerminalResizeQueue } from "@/lib/terminalResizeQueue";
import { buildTerminalFontStack } from "@/lib/terminalFonts";
import {
  minimumContrastFor,
  resolveColorScheme,
} from "@/lib/terminalColorSchemes";
import { getTerminalSearchDecorations } from "@/lib/terminalThemes";
import { TerminalRenderer, type RendererState } from "@/lib/terminalRenderer";
import { resolveWindowsPty } from "@/lib/terminalWindowsPty";
import {
  isTerminalControlFrame,
  type TerminalSessionFrame,
} from "@/lib/terminalFrames";
import { terminalService } from "@/services";
import { useColorSchemeStore } from "@/stores/colorSchemeStore";
import { usePlatformStore } from "@/stores/platformStore";
import {
  clampTerminalFontSize,
  useSettingsStore,
} from "@/stores/settingsStore";
import { resolveTerminalTabTitle } from "./terminalTitle";

/** How many times a single session may rebuild itself after dropped output. */
const MAX_LAGGED_RESYNCS = 3;

/** Per-terminal budget for decoded inline images, in MB. */
const TERMINAL_IMAGE_STORAGE_LIMIT_MB = 32;

/** Width of the gutter that marks off-screen search matches, in pixels. */
const OVERVIEW_RULER_WIDTH = 10;

/**
 * The grid's size in pixels, for `TIOCGWINSZ`.
 *
 * Image tools read it to decide how large a picture to draw; a pty that
 * reports zero makes them fall back to a fixed guess or refuse. Measured from
 * the xterm screen element rather than the container so it excludes padding
 * and the scrollbar, and returns zeroes rather than a guess when the terminal
 * has not been laid out yet - zero already means "unknown" over there.
 *
 * Measured from `.xterm-screen`, not `.xterm-rows`: the rows element belongs
 * to the DOM renderer only, and every terminal here starts on DOM and then
 * upgrades to WebGL asynchronously, whose renderer disposes the DOM row
 * container. `.xterm-screen` is created by the core and both renderers keep
 * it sized, so it stays measurable no matter which renderer is drawing.
 */
export function measureGridPixels(container: HTMLElement, term: Terminal) {
  const screen = container.querySelector<HTMLElement>(".xterm-screen");
  if (!screen || !screen.clientWidth || !screen.clientHeight) {
    return { width: 0, height: 0 };
  }
  const cellWidth = screen.clientWidth / Math.max(1, term.cols);
  const cellHeight = screen.clientHeight / Math.max(1, term.rows);
  return {
    width: Math.round(cellWidth * term.cols),
    height: Math.round(cellHeight * term.rows),
  };
}

/**
 * Open a link from terminal output.
 *
 * Both the OSC 8 handler and the plain-URL addon default to `window.open`,
 * which in a Tauri WebView either does nothing or opens a chromeless window
 * pointed at a URL that came out of program output. Neither is acceptable, so
 * both are routed to the browser through a backend command that re-validates
 * the scheme.
 *
 * Ctrl is required, matching Windows Terminal and VS Code: it keeps a link
 * from firing while the user is dragging out a selection.
 */
function activateTerminalLink(event: MouseEvent, uri: string) {
  if (!event.ctrlKey) return;
  void terminalService.openExternalUrl(uri).catch(() => {
    // A rejected link is not worth interrupting the session for; the backend
    // refuses anything that is not plainly an http(s) URL.
  });
}

/**
 * Single xterm.js view bound to a backend PTY session.
 *
 * The workspace owns session creation/closure. This view only attaches while
 * mounted and detaches during cleanup, so React reconstruction never kills
 * the backend PTY.
 */
export const TerminalView = memo(function TerminalView({
  sessionId,
  active,
  focused = active,
  defaultTitle,
  onExit,
  onTitleChange,
  onCwdChange,
  onCommandFinished,
  colorSchemeId,
  onFocus,
}: {
  sessionId: string;
  active: boolean;
  /** Only the focused pane responds to workspace-level terminal commands. */
  focused?: boolean;
  /** Profile label to restore after a shell emits its executable path. */
  defaultTitle: string;
  onExit?: (code: number | null, status?: "exited" | "error") => void;
  /** Called when the terminal emits OSC 0/2 to update its window title. */
  onTitleChange?: (title: string) => void;
  /** Called when shell integration reports the working directory (OSC 7). */
  onCwdChange?: (cwd: string) => void;
  /** Called when shell integration reports a command finishing (OSC 133 D). */
  onCommandFinished?: (exitCode: number | null) => void;
  /** Palette from this terminal's profile, overriding the global choice. */
  colorSchemeId?: string;
  /** Marks this terminal as the focused split pane. */
  onFocus?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const resizeQueueRef = useRef<TerminalResizeQueue | null>(null);
  const rendererRef = useRef<TerminalRenderer | null>(null);
  const [rendererState, setRendererState] = useState<RendererState>("dom");
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Report a resize from outside the terminal's own effect. */
  const requestResize = useCallback((term: Terminal) => {
    const container = containerRef.current;
    const { width, height } = container
      ? measureGridPixels(container, term)
      : { width: 0, height: 0 };
    resizeQueueRef.current?.request(term.rows, term.cols, width, height);
  }, []);

  const reportedExitRef = useRef(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  /** Bumped to force a re-attach after the backend reports dropped output. */
  const [attachEpoch, setAttachEpoch] = useState(0);
  const resyncAttemptsRef = useRef(0);
  const onTitleChangeRef = useRef(onTitleChange);
  const onExitRef = useRef(onExit);
  const onCwdChangeRef = useRef(onCwdChange);
  onCwdChangeRef.current = onCwdChange;
  const onCommandFinishedRef = useRef(onCommandFinished);
  onCommandFinishedRef.current = onCommandFinished;
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const terminalFontFamily = useSettingsStore(
    (state) => state.terminalFontFamily,
  );
  const terminalFontSize = useSettingsStore((state) => state.terminalFontSize);
  const typography = useSettingsStore(
    useShallow((state) => ({
      fontWeight: state.terminalFontWeight,
      fontWeightBold: state.terminalFontWeightBold,
      lineHeight: state.terminalLineHeight,
      letterSpacing: state.terminalLetterSpacing,
      cursorStyle: state.terminalCursorStyle,
      cursorInactiveStyle: state.terminalCursorInactiveStyle,
      padding: state.terminalPadding,
      minimumContrast: state.terminalMinimumContrast,
    })),
  );
  const terminalScrollbackLines = useSettingsStore(
    (state) => state.terminalScrollbackLines,
  );
  const cursorBlink = useSettingsStore((state) => state.cursorBlink);
  const terminalRenderer = useSettingsStore((state) => state.terminalRenderer);
  const theme = useSettingsStore((state) => state.theme);
  const terminalColorScheme = useSettingsStore(
    (state) => state.terminalColorScheme,
  );
  const importedSchemes = useColorSchemeStore((state) => state.schemes);
  const loadColorSchemes = useColorSchemeStore((state) => state.load);
  const platformInfo = usePlatformStore((state) => state.info);

  // Only needed once a selection names something that is not built in. The
  // store coalesces the calls every open terminal makes here.
  useEffect(() => {
    void loadColorSchemes();
  }, [loadColorSchemes]);

  const palette = useMemo(
    () =>
      // The profile wins when it names one. Resolution falls back to the
      // global choice for an id that no longer exists, so deleting a scheme
      // does not leave a profile without colours.
      resolveColorScheme(
        colorSchemeId || terminalColorScheme,
        theme,
        importedSchemes,
      ).theme,
    [colorSchemeId, terminalColorScheme, theme, importedSchemes],
  );
  // `0` means derive it from the scheme, which is right almost always; the
  // override is for agent output that uses dim truecolor the palette's own
  // contrast cannot rescue.
  const resolvedContrast =
    typography.minimumContrast || minimumContrastFor(palette);

  const copySelection = useCallback(async () => {
    const selection = termRef.current?.getSelection() ?? "";
    if (selection) await navigator.clipboard.writeText(selection);
    termRef.current?.focus();
  }, []);

  const pasteClipboard = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    const text = await terminalService.readClipboardText();
    if (!text) return;
    const lineCount = text.split(/\r\n|\r|\n/).length;
    // Newlines are only dangerous when the shell will execute them. With
    // bracketed paste on - which is every modern shell's line editor - a
    // multi-line paste lands in the editor and cannot run, so warning about
    // it is pure noise. Size stays unconditional: a multi-megabyte paste is
    // a hang risk either way.
    const bracketed = term.modes.bracketedPasteMode;
    const requiresConfirmation =
      text.length >= 10_000 || (!bracketed && lineCount > 20);
    if (
      requiresConfirmation &&
      !window.confirm(
        tRef.current(
          "Paste {characters} characters across {lines} lines into the terminal?",
          { characters: text.length, lines: lineCount },
        ),
      )
    ) {
      return;
    }
    term.paste(text);
    term.focus();
  }, []);

  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();

      const term = termRef.current;
      if (!term) return;

      if (term.hasSelection()) {
        void copySelection().finally(() => term.clearSelection());
        return;
      }

      // Read through the native process instead of the Web Clipboard API: the
      // latter asks the user to allow each paste in the WebView.
      void pasteClipboard().finally(() => term.focus());
    },
    [copySelection, pasteClipboard],
  );

  // The terminal is intentionally not recreated when a parent callback gets
  // a new identity. Keep the latest callback available to its xterm listener.
  useEffect(() => {
    onTitleChangeRef.current = onTitleChange;
  }, [onTitleChange]);

  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);

  // A new session starts with a clean resync budget.
  useEffect(() => {
    resyncAttemptsRef.current = 0;
  }, [sessionId]);

  useEffect(() => {
    return listenForAppCommands((command) => {
      if (!focused) return;
      if (command.type === "copy-terminal") void copySelection();
    });
  }, [focused, copySelection]);

  useEffect(() => {
    if (!focused) return;
    const handleSearchShortcut = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        event.stopPropagation();
        setSearchOpen(true);
      } else if (event.key === "Escape" && searchOpen) {
        event.preventDefault();
        setSearchOpen(false);
        searchRef.current?.clearDecorations();
        termRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleSearchShortcut, {
      capture: true,
    });
    return () =>
      window.removeEventListener("keydown", handleSearchShortcut, {
        capture: true,
      });
  }, [focused, searchOpen]);

  // Without `decorations` the addon highlights nothing - it only scrolls each
  // match into view - and `clearDecorations()` has nothing to clear.
  const searchOptions = useMemo(
    () => ({
      caseSensitive: false,
      decorations: getTerminalSearchDecorations(theme),
    }),
    [theme],
  );

  const findNext = useCallback(() => {
    if (searchQuery) searchRef.current?.findNext(searchQuery, searchOptions);
  }, [searchQuery, searchOptions]);

  const findPrevious = useCallback(() => {
    if (searchQuery) {
      searchRef.current?.findPrevious(searchQuery, searchOptions);
    }
  }, [searchQuery, searchOptions]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // Read the platform snapshot rather than subscribing: it is immutable once
    // loaded, and making it a dependency would tear down and re-attach every
    // terminal the moment app bootstrap resolves. A separate effect below
    // applies it if it arrives after this terminal was built.
    const windowsPty = resolveWindowsPty(usePlatformStore.getState().info);
    const linkHandler = {
      activate: activateTerminalLink,
      // Leave false: xterm uses it to reject `file:` and `javascript:` URIs
      // before `activate` is ever reached.
      allowNonHttpProtocols: false,
    };
    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink,
      cursorStyle: typography.cursorStyle,
      // Split panes have no other focus affordance: the focused pane keeps a
      // solid cursor, the rest fall back to an outline.
      cursorInactiveStyle: typography.cursorInactiveStyle,
      scrollback: terminalScrollbackLines,
      fontFamily: buildTerminalFontStack(terminalFontFamily),
      fontSize: terminalFontSize,
      fontWeight: typography.fontWeight,
      fontWeightBold: typography.fontWeightBold,
      lineHeight: typography.lineHeight,
      letterSpacing: typography.letterSpacing,
      minimumContrastRatio: resolvedContrast,
      allowTransparency: false,
      convertEol: false,
      // Bold is a weight, not a palette shift. The default remaps `\e[1;30m`
      // to bright black, which modern prompts and `ls --color` do not expect.
      drawBoldTextInBrightColors: false,
      // Shrink glyphs whose font outline spills past the cell they occupy in
      // the model - CJK punctuation and roman numerals in a Latin font.
      rescaleOverlappingGlyphs: true,
      // `clear`/`cls` should push the screen into scrollback rather than eat
      // it. This only applies to the normal screen buffer: xterm applies the
      // option unconditionally to whichever buffer is active, but scrolling
      // the viewport on `ESC[2J` is not what the alternate screen's clear
      // sequences mean. `onBufferChange` below flips it back off there.
      scrollOnEraseInDisplay: true,
      overviewRuler: { width: OVERVIEW_RULER_WIDTH },
      windowsPty,
      linkHandler,
      theme: palette,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new UnicodeGraphemesAddon());
    // The addon detects plain-text URLs, which is a separate code path from
    // the OSC 8 handler above and needs the same treatment.
    term.loadAddon(new WebLinksAddon(activateTerminalLink));
    // Sixel/IIP rendering. This one must be loaded before `open()`: the addon
    // wraps the core's `open` and `setRenderer`, and the latter is what keeps
    // images alive across the asynchronous WebGL upgrade below.
    term.loadAddon(
      new ImageAddon({
        // The 128 MB default is sized for a single terminal; this app keeps one
        // instance per tab, and the images we expect (agent mascots, plots) are
        // small.
        storageLimit: TERMINAL_IMAGE_STORAGE_LIMIT_MB,
      }),
    );
    term.open(container);
    // xterm applies `scrollOnEraseInDisplay` to whichever buffer is active,
    // with no buffer-type check; scrolling the viewport on the alternate
    // screen's `ESC[2J` is not what that clear sequence means. Flip the
    // option off while a full-screen TUI is showing.
    const scrollOnEraseDisposable = term.buffer.onBufferChange((buffer) => {
      term.options.scrollOnEraseInDisplay = buffer.type === "normal";
    });
    // DOM rendering can display the first prompt immediately. The renderer
    // upgrades to WebGL once its separate chunk arrives, and gets it back
    // after the GPU takes the context away.
    const renderer = new TerminalRenderer(term, {
      loadAddon: () =>
        import("@xterm/addon-webgl").then(({ WebglAddon }) => WebglAddon),
      onStateChange: setRendererState,
    });
    rendererRef.current = renderer;
    renderer.start(useSettingsStore.getState().terminalRenderer);
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;
    const snapshotKey = `project-terminal.snapshot.${sessionId}`;
    // Older builds cached a visual ANSI snapshot in sessionStorage. Replaying
    // it alongside backend PTY history duplicates cursor-addressed TUI frames.
    sessionStorage.removeItem(snapshotKey);
    const resizeQueue = new TerminalResizeQueue(terminalService.resize);
    resizeQueueRef.current = resizeQueue;

    // xterm keeps its scroll bar virtual: the native viewport's scroll range
    // is translated back into a buffer row. In WebView2 that range can
    // occasionally lag behind the buffer after a terminal was hidden and
    // receives output. Reaching the native end then leaves a few buffer rows
    // inaccessible until xterm processes keyboard input (which scrolls to the
    // bottom as a side effect). Detect that precise case and ask xterm to
    // perform the missing logical scroll. This only runs at the visible end,
    // so it does not disturb users reading earlier output.
    const viewport = container.querySelector<HTMLElement>(".xterm-viewport");
    let viewportSyncFrame: number | null = null;
    const syncBottomAtNativeViewportEnd = () => {
      if (!viewport || viewportSyncFrame !== null) return;
      viewportSyncFrame = window.requestAnimationFrame(() => {
        viewportSyncFrame = null;
        const buffer = term.buffer.active;
        const isAtNativeBottom =
          viewport.scrollTop + viewport.clientHeight >=
          viewport.scrollHeight - 1;
        if (isAtNativeBottom && buffer.viewportY < buffer.baseY) {
          term.scrollToBottom();
        }
      });
    };
    const handleViewportScroll = () => syncBottomAtNativeViewportEnd();
    const handleTerminalWheel = (event: WheelEvent) => {
      if (event.deltaY > 0) syncBottomAtNativeViewportEnd();
    };
    viewport?.addEventListener("scroll", handleViewportScroll);
    // A wheel event at an already-clamped native scroll position does not
    // emit another `scroll` event, so listen for it as well.
    term.element?.addEventListener("wheel", handleTerminalWheel, {
      passive: true,
    });
    // Ctrl+wheel adjusts the terminal font size. The settings store clamps
    // to the supported range and the existing fontSize effect re-fits the
    // grid. Capture the event before xterm consumes wheel input inside its
    // scroll range; cancelling propagation keeps the gesture resize-only.
    const handleWheelZoom = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      const { terminalFontSize, updateGeneralSettings } =
        useSettingsStore.getState();
      const next = clampTerminalFontSize(
        terminalFontSize + (event.deltaY < 0 ? 1 : -1),
      );
      if (next !== terminalFontSize) {
        updateGeneralSettings({ terminalFontSize: next });
      }
    };
    container.addEventListener("wheel", handleWheelZoom, {
      capture: true,
      passive: false,
    });

    const fitAndResize = () => {
      if (!container || !container.clientWidth || !container.clientHeight) {
        return;
      }
      try {
        fit.fit();
        const { width, height } = measureGridPixels(container, term);
        resizeQueue.request(term.rows, term.cols, width, height);
      } catch {
        // Fitting can fail while a tab is being attached or hidden.
      }
    };

    const inputQueue = new TerminalInputQueue(
      terminalService.write,
      terminalService.writeBinary,
    );
    const outputQueue = new TerminalOutputQueue(
      (data) => term.write(data),
      (callback, delay) => window.setTimeout(callback, delay),
      (handle) => window.clearTimeout(handle),
    );
    const disposable = term.onData((data) => inputQueue.send(data));
    // Mouse reports use this event instead of `onData` whenever the program
    // selected the default encoding rather than SGR - `vim` with
    // `ttymouse=xterm2`, `mc`, `w3m`. Without it their clicks are discarded.
    const binaryDisposable = term.onBinary((data) =>
      inputQueue.sendBinary(data),
    );
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      // AltGr arrives as ctrl+alt on Windows layouts. xterm has its own
      // AltGraph guard; excluding altKey here keeps this handler from
      // swallowing the composed character before that guard runs.
      if (event.altKey) return true;

      const { terminalPasteShortcut } = useSettingsStore.getState();
      const pasteChord =
        terminalPasteShortcut === "ctrl-shift-v"
          ? event.ctrlKey && event.shiftKey
          : event.ctrlKey && !event.shiftKey;
      if (pasteChord && event.key.toLowerCase() === "v") {
        void pasteClipboard();
        return false;
      }

      const sequence = resolveExtraKeySequence(event);
      if (sequence !== null) {
        inputQueue.send(sequence);
        return false;
      }
      return true;
    });
    // OSC 7: the shell reporting where it is. Only present when the profile
    // opted into shell integration; xterm silently swallows the sequence
    // otherwise, so there is nothing to clean up when it is off.
    term.parser.registerOscHandler(7, (payload) => {
      const cwd = parseWorkingDirectory(payload);
      // The value came out of the PTY, so it is a claim rather than a fact.
      // It is used for display, and re-validated by the backend before
      // anything acts on it.
      if (cwd) onCwdChangeRef.current?.(cwd);
      // Consume it either way: a malformed report is not something to print.
      return true;
    });
    // OSC 133: command boundaries. Recorded so the exit status of the last
    // command is available without parsing output.
    term.parser.registerOscHandler(133, (payload) => {
      const mark = parsePromptMark(payload);
      if (mark?.kind === "command-finished") {
        onCommandFinishedRef.current?.(mark.exitCode);
      }
      return true;
    });
    const titleDisposable = term.onTitleChange((nextTitle) => {
      const title = resolveTerminalTabTitle(nextTitle, defaultTitle);
      if (title) onTitleChangeRef.current?.(title);
    });

    const ro = new ResizeObserver(() => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(() => {
        fitAndResize();
      }, 80);
    });
    ro.observe(container);

    fitAndResize();
    const clientId = crypto.randomUUID();
    let cancelled = false;
    let attached = false;
    let resyncRequested = false;
    let dropNoticeShown = false;
    const pendingLiveOutput: TerminalSessionFrame[] = [];
    const reportExit = (
      status: "exited" | "error",
      exitCode: number | null,
    ) => {
      outputQueue.flush();
      if (!reportedExitRef.current) {
        reportedExitRef.current = true;
        onExitRef.current?.(exitCode, status);
      }
    };
    const handleFrame = (frame: TerminalSessionFrame) => {
      if (cancelled) return;
      if (!isTerminalControlFrame(frame)) {
        outputQueue.send(new Uint8Array(frame));
        return;
      }
      if (frame.type === "status") {
        reportExit(frame.status, frame.exitCode ?? null);
        return;
      }
      if (frame.type !== "lagged") return;
      // The backend dropped output because this client fell behind, leaving an
      // invisible hole in the stream that would corrupt any cursor-addressed
      // TUI. Re-attaching rebuilds the view from a fresh snapshot. The attempt
      // cap keeps a persistently slow client from thrashing xterm teardown.
      //
      // More lagged frames can arrive before this attachment tears down; they
      // are the same lag, so they must not each spend a resync or repeat the
      // notice. Both flags live in the attachment closure, so a successful
      // re-attach starts clean.
      if (resyncRequested) return;
      if (resyncAttemptsRef.current >= MAX_LAGGED_RESYNCS) {
        if (dropNoticeShown) return;
        dropNoticeShown = true;
        outputQueue.send(
          new TextEncoder().encode(
            "\r\n\x1b[33m[Some terminal output was dropped]\x1b[0m\r\n",
          ),
        );
        return;
      }
      resyncRequested = true;
      resyncAttemptsRef.current += 1;
      outputQueue.flush();
      setAttachEpoch((epoch) => epoch + 1);
    };
    const handleLiveFrame = (frame: TerminalSessionFrame) => {
      if (attached) handleFrame(frame);
      else pendingLiveOutput.push(frame);
    };

    // This view attaches to an already-running PTY, which may still be at its
    // 80x24 creation size. Do not mark the fitted UI dimensions as applied:
    // doing so suppresses the first real PTY resize and makes dynamic TUIs
    // render against a different grid than xterm.
    resizeQueue.attach(sessionId);

    // Subscribe first on the backend, restore bounded history, then drain
    // events queued while the command response was in flight.
    void terminalService
      .attach(sessionId, clientId, handleLiveFrame)
      .then(async (attachment) => {
        if (cancelled) {
          void terminalService.detach(sessionId, clientId);
          return;
        }
        if (attachment.truncated) {
          term.write(
            "\r\n\x1b[33m[Earlier terminal output was truncated]\x1b[0m\r\n",
          );
        }
        if (attachment.replay?.length) {
          // The backend merges consecutive output into one event per grid, so
          // this loop runs a handful of times rather than once per 16 KiB.
          for (const event of attachment.replay) {
            if (cancelled) return;
            if (event.type === "resize") {
              term.resize(event.cols, event.rows);
            } else if (event.data) {
              const data = event.data;
              await new Promise<void>((resolve) => {
                term.write(terminalService.decodeBase64(data), resolve);
              });
            }
          }
        } else if (attachment.scrollback) {
          const scrollback = attachment.scrollback;
          await new Promise<void>((resolve) => {
            term.write(terminalService.decodeBase64(scrollback), resolve);
          });
        }
        // Restore the grid dictated by the actual container, then deliver the
        // resize to the PTY before releasing buffered input/live redraws.
        fitAndResize();
        await resizeQueue.whenIdle();
        if (cancelled) return;
        inputQueue.attach(sessionId);
        attached = true;
        pendingLiveOutput.splice(0).forEach(handleFrame);
        if (
          attachment.session.status === "exited" ||
          attachment.session.status === "error"
        ) {
          reportExit(
            attachment.session.status,
            attachment.session.exitCode ?? null,
          );
        }
        requestAnimationFrame(fitAndResize);
      })
      .catch((e) => {
        const err = e as { message?: string };
        outputQueue.flush();
        term.write(
          `\r\n\x1b[31m${tRef.current("Failed to start terminal: {error}", {
            error: err.message ?? tRef.current("unknown error"),
          })}\x1b[0m\r\n`,
        );
        if (!reportedExitRef.current) {
          reportedExitRef.current = true;
          onExitRef.current?.(null, "error");
        }
      });

    return () => {
      cancelled = true;
      inputQueue.dispose();
      outputQueue.dispose();
      resizeQueue.dispose();
      disposable.dispose();
      binaryDisposable.dispose();
      titleDisposable.dispose();
      scrollOnEraseDisposable.dispose();
      ro.disconnect();
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      if (viewportSyncFrame !== null) {
        window.cancelAnimationFrame(viewportSyncFrame);
      }
      viewport?.removeEventListener("scroll", handleViewportScroll);
      term.element?.removeEventListener("wheel", handleTerminalWheel);
      container.removeEventListener("wheel", handleWheelZoom, {
        capture: true,
      });
      void terminalService.detach(sessionId, clientId);
      sessionStorage.removeItem(snapshotKey);
      renderer.dispose();
      rendererRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      resizeQueueRef.current = null;
      reportedExitRef.current = false;
    };
    // Changing `active` only hides/refits the existing xterm instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, attachEpoch]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    term.options.fontFamily = buildTerminalFontStack(terminalFontFamily);
    term.options.fontSize = terminalFontSize;
    term.options.fontWeight = typography.fontWeight;
    term.options.fontWeightBold = typography.fontWeightBold;
    term.options.lineHeight = typography.lineHeight;
    term.options.letterSpacing = typography.letterSpacing;
    term.options.cursorStyle = typography.cursorStyle;
    term.options.cursorInactiveStyle = typography.cursorInactiveStyle;
    term.options.scrollback = terminalScrollbackLines;
    term.options.cursorBlink = cursorBlink;
    term.options.minimumContrastRatio = resolvedContrast;
    term.options.theme = palette;
    const frame = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        requestResize(term);
      } catch {
        // The terminal may be hidden or closing while preferences update.
      }
    });
    return () => cancelAnimationFrame(frame);
    // Every option here changes the cell size or the palette, so each needs
    // the refit above; none of them requires rebuilding the terminal.
  }, [
    cursorBlink,
    palette,
    requestResize,
    resolvedContrast,
    terminalFontFamily,
    terminalFontSize,
    terminalScrollbackLines,
    typography,
  ]);

  useEffect(() => {
    rendererRef.current?.setPreference(terminalRenderer);
  }, [terminalRenderer]);

  // A terminal opened before app bootstrap resolved was built without a pty
  // description. xterm reads it at resize time, so applying it late is enough
  // and costs nothing - unlike rebuilding the terminal, which would detach the
  // PTY and replay its scrollback.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !platformInfo) return;
    const windowsPty = resolveWindowsPty(platformInfo);
    if (windowsPty) term.options.windowsPty = windowsPty;
  }, [platformInfo]);

  // When this view becomes visible again, re-fit so the terminal reports the
  // correct dimensions after being hidden.
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => {
      try {
        fitRef.current?.fit();
        const term = termRef.current;
        if (term) {
          requestResize(term);
        }
      } catch {
        // ignore
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [active, requestResize]);

  return (
    <div
      className="relative h-full w-full"
      // The gutter takes the terminal's own background rather than the app's,
      // so a colour scheme that differs from the chrome does not read as a
      // mis-sized panel. Inline because it is a user setting, and the refit
      // above depends on it: padding changes the fittable grid.
      style={{
        padding: `${typography.padding}px`,
        background: palette.background,
      }}
      onContextMenuCapture={handleContextMenu}
      onFocusCapture={onFocus}
    >
      {rendererState === "degraded" && active ? (
        // Rendered as UI, never written into the terminal: a notice in the
        // byte stream would corrupt whatever TUI is on screen.
        <div
          role="status"
          className="pointer-events-none absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-md border border-border bg-popover/95 px-2 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur"
        >
          <TriangleAlert className="h-3.5 w-3.5 text-warn" />
          {t("Hardware rendering is unavailable; using software rendering.")}
        </div>
      ) : null}
      {searchOpen && active ? (
        <form
          className="absolute right-4 top-3 z-20 flex items-center gap-1 rounded-md border border-border bg-popover/95 p-1 shadow-lg backdrop-blur"
          onSubmit={(event) => {
            event.preventDefault();
            findNext();
          }}
        >
          <Search className="ml-1 h-3.5 w-3.5 text-muted-foreground" />
          <input
            autoFocus
            aria-label={t("Search terminal")}
            value={searchQuery}
            onChange={(event) => {
              const query = event.target.value;
              setSearchQuery(query);
              if (query) {
                searchRef.current?.findNext(query, {
                  ...searchOptions,
                  incremental: true,
                });
              } else {
                searchRef.current?.clearDecorations();
              }
            }}
            className="h-7 w-56 bg-transparent px-1 text-xs outline-none"
            placeholder={t("Search terminal")}
          />
          <button
            type="button"
            aria-label={t("Previous match")}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={findPrevious}
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="submit"
            aria-label={t("Next match")}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label={t("Close search")}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => {
              setSearchOpen(false);
              searchRef.current?.clearDecorations();
              termRef.current?.focus();
            }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </form>
      ) : null}
      <div
        ref={containerRef}
        className="h-full w-full"
        style={{ display: active ? "block" : "none" }}
      />
    </div>
  );
});
