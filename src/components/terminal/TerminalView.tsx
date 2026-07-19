import { useCallback, useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";

import { listenForAppCommands } from "@/lib/appCommands";
import { terminalService } from "@/services";
import { useSettingsStore } from "@/stores/settingsStore";
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
  defaultTitle,
  onSessionId,
  onExit,
  onTitleChange,
}: {
  pending: PendingSession;
  active: boolean;
  /** Profile label to restore after a shell emits its executable path. */
  defaultTitle: string;
  onSessionId?: (sessionId: string) => void;
  onExit?: (code: number | null, status?: "exited" | "error") => void;
  /** Called when the terminal emits OSC 0/2 to update its window title. */
  onTitleChange?: (title: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusTimerRef = useRef<number | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const reportedExitRef = useRef(false);
  const onTitleChangeRef = useRef(onTitleChange);
  const terminalFontSize = useSettingsStore((state) => state.terminalFontSize);
  const cursorBlink = useSettingsStore((state) => state.cursorBlink);

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
      if (!active) return;
      if (command.type === "copy-terminal") void copySelection();
    });
  }, [active, copySelection]);

  useEffect(() => {
    const term = new Terminal({
      cursorBlink,
      cursorStyle: "block",
      scrollback: 10_000,
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
      fontSize: terminalFontSize,
      lineHeight: 1.2,
      allowTransparency: false,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current!);
    termRef.current = term;
    fitRef.current = fit;

    const fitAndResize = () => {
      const container = containerRef.current;
      if (!container || !container.clientWidth || !container.clientHeight) {
        return;
      }
      try {
        fit.fit();
        const sid = sessionIdRef.current;
        if (sid) {
          void terminalService.resize(sid, term.rows, term.cols);
        }
      } catch {
        // Fitting can fail while a tab is being attached or hidden.
      }
    };

    const disposable = term.onData((data) => {
      const sid = sessionIdRef.current;
      if (sid) void terminalService.write(sid, data);
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
    if (containerRef.current) ro.observe(containerRef.current);

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
          rows: 24,
          cols: 80,
        },
        (chunk) => {
          if (cancelled) return;
          if (!chunk.data) return;
          const bytes = terminalService.decodeBase64(chunk.data);
          term.write(bytes);
        },
      )
      .then((sessionId) => {
        if (cancelled) {
          void terminalService.close(sessionId);
          return;
        }
        sessionIdRef.current = sessionId;
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
          `\r\n\x1b[31mFailed to start terminal: ${
            err.message ?? "unknown error"
          }\x1b[0m\r\n`,
        );
        onExit?.(null);
      });

    return () => {
      cancelled = true;
      disposable.dispose();
      titleDisposable.dispose();
      ro.disconnect();
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      if (statusTimerRef.current) window.clearInterval(statusTimerRef.current);
      const sid = sessionIdRef.current;
      if (sid) void terminalService.close(sid);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
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
    const frame = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        const sid = sessionIdRef.current;
        if (sid) void terminalService.resize(sid, term.rows, term.cols);
      } catch {
        // The terminal may be hidden or closing while preferences update.
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [cursorBlink, terminalFontSize]);

  // When this view becomes visible again, re-fit so the terminal reports the
  // correct dimensions after being hidden.
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => {
      try {
        fitRef.current?.fit();
        const term = termRef.current;
        const sid = sessionIdRef.current;
        if (term && sid) {
          void terminalService.resize(sid, term.rows, term.cols);
        }
      } catch {
        // ignore
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [active]);

  return (
    <div className="h-full w-full p-2" onContextMenuCapture={handleContextMenu}>
      <div
        ref={containerRef}
        className="h-full w-full"
        style={{ display: active ? "block" : "none" }}
      />
    </div>
  );
}
