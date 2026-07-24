import { useEffect, useState } from "react";
import type { MouseEvent } from "react";
import {
  Copy,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Square,
  Terminal,
  X,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "@/i18n";

/**
 * Application-owned title bar for the undecorated desktop window. Keeping the
 * window actions here means the chrome follows the rest of the dark UI rather
 * than Windows' light title bar.
 */
export function WindowTitleBar({
  sidebarCollapsed = false,
  onToggleSidebar,
  onCloseRequest,
}: {
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onCloseRequest?: () => void;
}) {
  const { t } = useTranslation();
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    const syncMaximized = () => {
      void win
        .isMaximized()
        .then(setIsMaximized)
        .catch(() => {});
    };
    syncMaximized();
    const promise = win.onResized(syncMaximized);
    return () => {
      void promise.then((unlisten) => unlisten());
    };
  }, []);

  function startDragging(event: MouseEvent<HTMLElement>) {
    if (event.button === 0) {
      void getCurrentWindow().startDragging();
    }
  }

  function toggleMaximize() {
    void getCurrentWindow().toggleMaximize();
  }

  return (
    <header
      className="window-titlebar flex h-10 shrink-0 select-none items-center border-b border-border bg-surface text-foreground"
      aria-label={t("Window controls")}
      onMouseDown={startDragging}
      onDoubleClick={toggleMaximize}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 px-3">
        {onToggleSidebar ? (
          <button
            type="button"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={
              sidebarCollapsed
                ? t("Show projects sidebar")
                : t("Hide projects sidebar")
            }
            aria-expanded={!sidebarCollapsed}
            title={
              sidebarCollapsed
                ? t("Show projects sidebar")
                : t("Hide projects sidebar")
            }
            onMouseDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onClick={onToggleSidebar}
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </button>
        ) : null}
        <span className="flex h-5 w-5 items-center justify-center rounded-[5px] bg-[hsl(210_75%_56%)] text-white shadow-[0_0_12px_hsl(210_75%_56%_/_0.26)]">
          <Terminal className="h-3.5 w-3.5" strokeWidth={2.4} />
        </span>
        <span className="truncate text-[13px] font-medium tracking-[0.01em]">
          Project Terminal
        </span>
        <span className="hidden text-[11px] text-muted-foreground sm:inline">
          {t("Workspace")}
        </span>
      </div>

      <div
        className="flex h-full"
        onMouseDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <WindowControl
          label={t("Minimize")}
          onClick={() => void getCurrentWindow().minimize()}
        >
          <Minus />
        </WindowControl>
        <WindowControl
          label={isMaximized ? t("Restore") : t("Maximize")}
          onClick={toggleMaximize}
        >
          {isMaximized ? <Copy /> : <Square />}
        </WindowControl>
        <WindowControl
          label={t("Close")}
          close
          onClick={() =>
            onCloseRequest ? onCloseRequest() : void getCurrentWindow().close()
          }
        >
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
