import type { MouseEvent } from "react";
import { Minus, Square, Terminal, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const appWindow = getCurrentWindow();

/**
 * Application-owned title bar for the undecorated desktop window. Keeping the
 * window actions here means the chrome follows the rest of the dark UI rather
 * than Windows' light title bar.
 */
export function WindowTitleBar() {
  function startDragging(event: MouseEvent<HTMLElement>) {
    if (event.button === 0) {
      void appWindow.startDragging();
    }
  }

  function toggleMaximize() {
    void appWindow.toggleMaximize();
  }

  return (
    <header
      className="window-titlebar flex h-10 shrink-0 select-none items-center border-b border-border bg-surface text-foreground"
      aria-label="Window controls"
      onMouseDown={startDragging}
      onDoubleClick={toggleMaximize}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 px-3">
        <span className="flex h-5 w-5 items-center justify-center rounded-[5px] bg-[hsl(210_75%_56%)] text-white shadow-[0_0_12px_hsl(210_75%_56%_/_0.26)]">
          <Terminal className="h-3.5 w-3.5" strokeWidth={2.4} />
        </span>
        <span className="truncate text-[13px] font-medium tracking-[0.01em]">
          Project Terminal
        </span>
        <span className="hidden text-[11px] text-muted-foreground sm:inline">
          Workspace
        </span>
      </div>

      <div
        className="flex h-full"
        onMouseDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <WindowControl label="Minimize" onClick={() => void appWindow.minimize()}>
          <Minus />
        </WindowControl>
        <WindowControl label="Maximize or restore" onClick={toggleMaximize}>
          <Square />
        </WindowControl>
        <WindowControl label="Close" close onClick={() => void appWindow.close()}>
          <X />
        </WindowControl>
      </div>
    </header>
  );
}

function WindowControl({
  children,
  close = false,
  label,
  onClick,
}: {
  children: React.ReactNode;
  close?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`window-control${close ? " window-control--close" : ""}`}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
