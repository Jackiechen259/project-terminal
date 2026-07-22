import { useCallback, useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { WebLinksAddon } from "@xterm/addon-web-links";

import { useTranslation } from "@/i18n";
import { listenForAppCommands } from "@/lib/appCommands";
import { TerminalInputQueue } from "@/lib/terminalInputQueue";
import { TerminalResizeQueue } from "@/lib/terminalResizeQueue";
import {
  getTerminalMinimumContrast,
  getTerminalTheme,
} from "@/lib/terminalThemes";
import { terminalService } from "@/services";
import {
  clampTerminalFontSize,
  useSettingsStore,
} from "@/stores/settingsStore";
import { resolveTerminalTabTitle } from "./terminalTitle";

/**
 * Single xterm.js view bound to a backend PTY session.
 *
 * Lifecycle (plan §25.5):
 * - Mounts once per tab and stays mounted while the project is active.
 * - When the parent project becomes inactive we only hide the container; the
 *   Terminal instance, PTY reader, and accumulated scrollback all survive.
 * - Disposes on unmount (tab close), which also closes the backend session.
 *
 * Channel ownership: this view opens its own Tauri Channel when it mounts.
 * The backend's create_terminal() is invoked by the workspace; the view
 * subscribes to output via a session-scoped callback registered below.
 *
 * Because Tauri Channels are per-call (each create_terminal creates a fresh
 * channel), the channel handler is owned by whoever calls create_terminal.
 * For Phase 3, the TerminalView owns the create call so the channel stays
 * paired with this xterm instance.
 */
export interface TerminalViewHandle {
  sessionId: string;
}

interface PendingSession {
  projectId: string;
  profileId: string;
}

/**
 * Mount an xterm.js terminal and create a backend PTY for the given project
 * + profile. Output bytes flow from the PTY through a Tauri Channel into the
 * Terminal. Input bytes flow from the Terminal through terminalService.write.
 */
export function TerminalView({
  pending,
  active,
  focused = active,
  defaultTitle,
  onSessionId,
  onExit,
  onTitleChange,
  onFocus,
}: {
  pending: PendingSession;
  active: boolean;
  /** Only the focused pane responds to workspace-level terminal commands. */
  focused?: boolean;
  /** Profile label to restore after a shell emits its executable path. */
  defaultTitle: string;
  onSessionId?: (sessionId: string) => void;
  onExit?: (code: number | null, status?: "exited" | "error") => void;
  /** Called when the terminal emits OSC 0/2 to update its window title. */
  onTitleChange?: (title: string) => void;
  /** Marks this terminal as the focused split pane. */
  onFocus?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const resizeQueueRef = useRef<TerminalResizeQueue | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusTimerRef = useRef<number | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const reportedExitRef = useRef(false);
  const onTitleChangeRef = useRef(onTitleChange);
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const terminalFontSize = useSettingsStore((state) => state.terminalFontSize);
  const cursorBlink = useSettingsStore((state) => state.cursorBlink);
  const theme = useSettingsStore((state) => state.theme);

  const copySelection = useCallback(async () => {
    const selection = termRef.current?.getSelection() ?? "";
    if (selection) await navigator.clipboard.writeText(selection);
    termRef.current?.focus();
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
      void terminalService
        .readClipboardText()
        .then((text) => {
          if (text) term.paste(text);
        })
        .finally(() => term.focus());
    },
    [copySelection],
  );

  // The terminal is intentionally not recreated when a parent callback gets
  // a new identity. Keep the latest callback available to its xterm listener.
  useEffect(() => {
    onTitleChangeRef.current = onTitleChange;
  }, [onTitleChange]);

  useEffect(() => {
    return listenForAppCommands((command) => {
      if (!focused) return;
      if (command.type === "copy-terminal") void copySelection();
    });
  }, [focused, copySelection]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink,
      cursorStyle: "block",
      scrollback: 10_000,
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
      fontSize: terminalFontSize,
      lineHeight: 1.2,
      minimumContrastRatio: getTerminalMinimumContrast(theme),
      allowTransparency: false,
      convertEol: false,
      theme: getTerminalTheme(theme),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new UnicodeGraphemesAddon());
    term.loadAddon(new WebLinksAddon());
    term.open(container);
    termRef.current = term;
    fitRef.current = fit;
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
    // grid. preventDefault stops both the browser page-zoom and xterm's own
    // scroll handling so the gesture only resizes text.
    const handleWheelZoom = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
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
    const disposable = term.onData((data) => inputQueue.send(data));
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

    // Full-screen programs are launched by the backend before create()
    // resolves, so they must receive the real grid size in the create request.
    // Starting every PTY at 80x24 and resizing later lets a dynamic TUI paint
    // its first frame against the wrong width, which desynchronizes its input
    // cursor from xterm's grid.
    fitAndResize();
    const initialDimensions = { rows: term.rows, cols: term.cols };

    // Create the backend PTY. Output chunks are decoded and written to the
    // terminal; we also detect a session-end by a 0-byte final chunk (the
    // backend's reader thread exits, which surfaces as EOF). A real
    // exit-code listener arrives with the next phase's status command.
    let cancelled = false;
    void terminalService
      .create(
        {
          projectId: pending.projectId,
          profileId: pending.profileId,
          rows: initialDimensions.rows,
          cols: initialDimensions.cols,
        },
        (chunk) => {
          if (cancelled) return;
          if (!chunk.data) return;
          const bytes = terminalService.decodeBase64(chunk.data);
          term.write(bytes);
        },
      )
      .then(async (sessionId) => {
        if (cancelled) {
          void terminalService.close(sessionId);
          return;
        }
        sessionIdRef.current = sessionId;
        resizeQueue.attach(sessionId, initialDimensions);
        // If the view changed size while the backend was starting the shell,
        // apply that latest grid before releasing any buffered keystrokes to
        // the TUI. This keeps its first editable frame and xterm in lockstep.
        await resizeQueue.whenIdle();
        if (cancelled) return;
        inputQueue.attach(sessionId);
        onSessionId?.(sessionId);
        const statusTimer = window.setInterval(() => {
          if (reportedExitRef.current) return;
          void terminalService
            .status(sessionId)
            .then((status) => {
              if (status.status === "exited" || status.status === "error") {
                reportedExitRef.current = true;
                onExit?.(status.exitCode ?? null, status.status);
                window.clearInterval(statusTimer);
              }
            })
            .catch(() => {
              // A tab can close while a poll is in flight; cleanup owns it.
            });
        }, 700);
        // The first ResizeObserver fit normally runs before the asynchronous
        // PTY session id exists. Resize once it is available so applications
        // in the shell receive the same grid dimensions as xterm.
        requestAnimationFrame(fitAndResize);
        // Cleanup is tied to the outer effect; see `statusTimer` below.
        statusTimerRef.current = statusTimer;
      })
      .catch((e) => {
        const err = e as { message?: string };
        term.write(
          `\r\n\x1b[31m${tRef.current("Failed to start terminal: {error}", {
            error: err.message ?? tRef.current("unknown error"),
          })}\x1b[0m\r\n`,
        );
        onExit?.(null);
      });

    return () => {
      cancelled = true;
      inputQueue.dispose();
      resizeQueue.dispose();
      disposable.dispose();
      titleDisposable.dispose();
      ro.disconnect();
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      if (statusTimerRef.current) window.clearInterval(statusTimerRef.current);
      if (viewportSyncFrame !== null) {
        window.cancelAnimationFrame(viewportSyncFrame);
      }
      viewport?.removeEventListener("scroll", handleViewportScroll);
      term.element?.removeEventListener("wheel", handleTerminalWheel);
      container.removeEventListener("wheel", handleWheelZoom);
      const sid = sessionIdRef.current;
      if (sid) void terminalService.close(sid);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      resizeQueueRef.current = null;
      sessionIdRef.current = null;
      reportedExitRef.current = false;
    };
    // We intentionally only re-create the session when the profile id changes;
    // changing `active` does NOT re-create it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.projectId, pending.profileId]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    term.options.fontSize = terminalFontSize;
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
  }, [cursorBlink, terminalFontSize, theme]);

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
      className="h-full w-full bg-background p-2"
      onContextMenuCapture={handleContextMenu}
      onFocusCapture={onFocus}
    >
      <div
        ref={containerRef}
        className="h-full w-full"
        style={{ display: active ? "block" : "none" }}
      />
    </div>
  );
}
