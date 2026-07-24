import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";

import { useTranslation } from "@/i18n";
import { listenForAppCommands } from "@/lib/appCommands";
import { TerminalInputQueue } from "@/lib/terminalInputQueue";
import { TerminalOutputQueue } from "@/lib/terminalOutputQueue";
import { TerminalResizeQueue } from "@/lib/terminalResizeQueue";
import {
  getTerminalMinimumContrast,
  getTerminalTheme,
} from "@/lib/terminalThemes";
import { terminalService, type TerminalOutputChunk } from "@/services";
import {
  clampTerminalFontSize,
  useSettingsStore,
} from "@/stores/settingsStore";
import { resolveTerminalTabTitle } from "./terminalTitle";

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
  /** Marks this terminal as the focused split pane. */
  onFocus?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const resizeQueueRef = useRef<TerminalResizeQueue | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reportedExitRef = useRef(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const onTitleChangeRef = useRef(onTitleChange);
  const onExitRef = useRef(onExit);
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const terminalFontSize = useSettingsStore((state) => state.terminalFontSize);
  const terminalScrollbackLines = useSettingsStore(
    (state) => state.terminalScrollbackLines,
  );
  const cursorBlink = useSettingsStore((state) => state.cursorBlink);
  const theme = useSettingsStore((state) => state.theme);

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
    const requiresConfirmation = text.length >= 10_000 || lineCount > 20;
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

  useEffect(() => {
    return listenForAppCommands((command) => {
      if (!focused) return;
      if (command.type === "copy-terminal") void copySelection();
    });
  }, [focused, copySelection]);

  useEffect(() => {
    if (!focused) return;
    const handleSearchShortcut = (event: KeyboardEvent) => {
      if (
        event.ctrlKey &&
        event.shiftKey &&
        event.key.toLowerCase() === "f"
      ) {
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

  const findNext = useCallback(() => {
    if (searchQuery) {
      searchRef.current?.findNext(searchQuery, { caseSensitive: false });
    }
  }, [searchQuery]);

  const findPrevious = useCallback(() => {
    if (searchQuery) {
      searchRef.current?.findPrevious(searchQuery, { caseSensitive: false });
    }
  }, [searchQuery]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink,
      cursorStyle: "block",
      scrollback: terminalScrollbackLines,
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
      fontSize: terminalFontSize,
      lineHeight: 1.2,
      minimumContrastRatio: getTerminalMinimumContrast(theme),
      allowTransparency: false,
      convertEol: false,
      theme: getTerminalTheme(theme),
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    const serialize = new SerializeAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(serialize);
    term.loadAddon(new UnicodeGraphemesAddon());
    term.loadAddon(new WebLinksAddon());
    term.open(container);
    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl?.dispose();
        webgl = null;
      });
      term.loadAddon(webgl);
    } catch {
      webgl?.dispose();
      webgl = null;
    }
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;
    const snapshotKey = `project-terminal.snapshot.${sessionId}`;
    const previousSnapshot = sessionStorage.getItem(snapshotKey);
    if (previousSnapshot) {
      term.write(previousSnapshot);
    }
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
        resizeQueue.request(term.rows, term.cols);
      } catch {
        // Fitting can fail while a tab is being attached or hidden.
      }
    };

    const inputQueue = new TerminalInputQueue(terminalService.write);
    const outputQueue = new TerminalOutputQueue(
      (data) => term.write(data),
      (callback, delay) => window.setTimeout(callback, delay),
      (handle) => window.clearTimeout(handle),
    );
    const disposable = term.onData((data) => inputQueue.send(data));
    term.attachCustomKeyEventHandler((event) => {
      if (
        event.type === "keydown" &&
        event.ctrlKey &&
        !event.altKey &&
        event.key.toLowerCase() === "v"
      ) {
        void pasteClipboard();
        return false;
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
    const initialDimensions = { rows: term.rows, cols: term.cols };
    const clientId = crypto.randomUUID();
    let cancelled = false;
    let attached = false;
    const pendingLiveOutput: TerminalOutputChunk[] = [];
    const handleOutput = (chunk: TerminalOutputChunk) => {
      if (cancelled) return;
      if (chunk.status) {
        outputQueue.flush();
        if (!reportedExitRef.current) {
          reportedExitRef.current = true;
          onExitRef.current?.(chunk.exitCode ?? null, chunk.status);
        }
        return;
      }
      if (chunk.data) {
        outputQueue.send(terminalService.decodeBase64(chunk.data));
      }
    };
    const handleLiveOutput = (chunk: TerminalOutputChunk) => {
      if (attached) handleOutput(chunk);
      else pendingLiveOutput.push(chunk);
    };

    inputQueue.attach(sessionId);
    resizeQueue.attach(sessionId, initialDimensions);

    // Subscribe first on the backend, restore bounded history, then drain
    // events queued while the command response was in flight.
    void terminalService
      .attach(sessionId, clientId, handleLiveOutput)
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
        if (attachment.scrollback) {
          if (previousSnapshot) {
            term.reset();
          }
          outputQueue.send(
            terminalService.decodeBase64(attachment.scrollback),
          );
        }
        sessionStorage.removeItem(snapshotKey);
        attached = true;
        pendingLiveOutput.splice(0).forEach(handleOutput);
        if (
          attachment.session.status === "exited" ||
          attachment.session.status === "error"
        ) {
          handleOutput({
            sessionId,
            status: attachment.session.status,
            exitCode: attachment.session.exitCode,
          });
        }
        await resizeQueue.whenIdle();
        if (cancelled) return;
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
      titleDisposable.dispose();
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
      try {
        const snapshot = serialize.serialize();
        if (snapshot.length <= 1_000_000) {
          sessionStorage.setItem(snapshotKey, snapshot);
        }
      } catch {
        sessionStorage.removeItem(snapshotKey);
      }
      webgl?.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      resizeQueueRef.current = null;
      reportedExitRef.current = false;
    };
    // Changing `active` only hides/refits the existing xterm instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    term.options.fontSize = terminalFontSize;
    term.options.scrollback = terminalScrollbackLines;
    term.options.cursorBlink = cursorBlink;
    term.options.minimumContrastRatio = getTerminalMinimumContrast(theme);
    term.options.theme = getTerminalTheme(theme);
    const frame = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        resizeQueueRef.current?.request(term.rows, term.cols);
      } catch {
        // The terminal may be hidden or closing while preferences update.
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [cursorBlink, terminalFontSize, terminalScrollbackLines, theme]);

  // When this view becomes visible again, re-fit so the terminal reports the
  // correct dimensions after being hidden.
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => {
      try {
        fitRef.current?.fit();
        const term = termRef.current;
        if (term) {
          resizeQueueRef.current?.request(term.rows, term.cols);
        }
      } catch {
        // ignore
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [active]);

  return (
    <div
      className="relative h-full w-full bg-background p-2"
      onContextMenuCapture={handleContextMenu}
      onFocusCapture={onFocus}
    >
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
                searchRef.current?.findNext(query, { incremental: true });
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
