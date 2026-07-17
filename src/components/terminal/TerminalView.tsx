import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";

import { terminalService } from "@/services";

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
  onSessionId,
  onExit,
}: {
  pending: PendingSession;
  active: boolean;
  onSessionId?: (sessionId: string) => void;
  onExit?: (code: number | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      scrollback: 10_000,
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 14,
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

    const disposable = term.onData((data) => {
      const sid = sessionIdRef.current;
      if (sid) void terminalService.write(sid, data);
    });

    const ro = new ResizeObserver(() => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(() => {
        if (!termRef.current || !fitRef.current) return;
        try {
          fitRef.current.fit();
          const sid = sessionIdRef.current;
          if (sid) {
            void terminalService.resize(
              sid,
              termRef.current.rows,
              termRef.current.cols,
            );
          }
        } catch {
          // Fit can throw if the container has no layout yet.
        }
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
      ro.disconnect();
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      const sid = sessionIdRef.current;
      if (sid) void terminalService.close(sid);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      sessionIdRef.current = null;
    };
    // We intentionally only re-create the session when the profile id changes;
    // changing `active` does NOT re-create it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.projectId, pending.profileId]);

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
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ display: active ? "block" : "none" }}
    />
  );
}
