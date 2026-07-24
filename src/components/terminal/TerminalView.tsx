import { memo, useCallback, useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { WebLinksAddon } from "@xterm/addon-web-links";

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
  const resizeQueueRef = useRef<TerminalResizeQueue | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reportedExitRef = useRef(false);
  const onTitleChangeRef = useRef(onTitleChange);
  const onExitRef = useRef(onExit);
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
    onExitRef.current = onExit;
  }, [onExit]);

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
          outputQueue.send(
            terminalService.decodeBase64(attachment.scrollback),
          );
        }
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
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
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
});
