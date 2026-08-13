import { useEffect, useState } from "react";
import {
  Copy,
  Files,
  Minus,
  NotebookPen,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Square,
  X,
} from "lucide-react";
import { useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";
import { nativeWindowService } from "@/services/native";
import { BrandMark } from "./BrandMark";

/** Which panel the right sidebar shows. */
export type RightSidebarMode = "files" | "memos";

/**
 * Application-owned title bar for the undecorated desktop window. Keeping the
 * window actions here means the chrome follows the rest of the dark UI rather
 * than Windows' light title bar.
 */
export function WindowTitleBar({
  sidebarCollapsed = false,
  onToggleSidebar,
  rightSidebarCollapsed = false,
  rightSidebarMode = "files",
  onSelectRightSidebar,
  onToggleRightSidebar,
  onCloseRequest,
}: {
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  rightSidebarCollapsed?: boolean;
  rightSidebarMode?: RightSidebarMode;
  onSelectRightSidebar?: (mode: RightSidebarMode) => void;
  onToggleRightSidebar?: () => void;
  onCloseRequest?: () => void;
}) {
  const { t } = useTranslation();
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const win = nativeWindowService.current();
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

  function toggleMaximize() {
    void nativeWindowService.toggleMaximize();
  }

  const rightSidebarOpen = !rightSidebarCollapsed;

  return (
    <header
      className="window-titlebar flex h-10 shrink-0 select-none items-center border-b border-border bg-surface text-foreground"
      aria-label={t("Window controls")}
      data-tauri-drag-region
      onDoubleClick={toggleMaximize}
    >
      <div
        className="flex min-w-0 flex-1 items-center gap-2 px-3"
        data-tauri-drag-region
      >
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
        <span className="pointer-events-none flex h-5 w-5 items-center justify-center rounded-[5px] bg-primary/15">
          <BrandMark className="h-[18px] w-[18px]" />
        </span>
        <span className="pointer-events-none truncate text-[13px] font-medium tracking-[0.01em]">
          Project Terminal
        </span>
        <span className="pointer-events-none hidden text-[11px] text-muted-foreground sm:inline">
          {t("Workspace")}
        </span>
        {onSelectRightSidebar ? (
          <div
            className="ml-auto flex shrink-0 items-center gap-0.5 rounded-md border border-border p-0.5"
            role="tablist"
            aria-label={t("Right panel")}
          >
            <button
              type="button"
              role="tab"
              aria-selected={rightSidebarOpen && rightSidebarMode === "files"}
              className={cn(
                "flex h-6 items-center gap-1 rounded px-2 text-[11px] transition-colors",
                rightSidebarOpen && rightSidebarMode === "files"
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              title={t("Files panel")}
              onMouseDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onClick={() => onSelectRightSidebar("files")}
            >
              <Files className="h-3 w-3" />
              {t("Files")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={rightSidebarOpen && rightSidebarMode === "memos"}
              className={cn(
                "flex h-6 items-center gap-1 rounded px-2 text-[11px] transition-colors",
                rightSidebarOpen && rightSidebarMode === "memos"
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              title={t("Memo panel")}
              onMouseDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onClick={() => onSelectRightSidebar("memos")}
            >
              <NotebookPen className="h-3 w-3" />
              {t("Memo")}
            </button>
          </div>
        ) : null}
        {onToggleRightSidebar ? (
          <button
            type="button"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={
              rightSidebarCollapsed
                ? t("Show right sidebar")
                : t("Hide right sidebar")
            }
            aria-expanded={!rightSidebarCollapsed}
            title={
              rightSidebarCollapsed
                ? t("Show right sidebar")
                : t("Hide right sidebar")
            }
            onMouseDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onClick={onToggleRightSidebar}
          >
            {rightSidebarCollapsed ? (
              <PanelRightOpen className="h-4 w-4" />
            ) : (
              <PanelRightClose className="h-4 w-4" />
            )}
          </button>
        ) : null}
      </div>

      <div
        className="flex h-full"
        onMouseDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <WindowControl
          label={t("Minimize")}
          onClick={() => void nativeWindowService.minimize()}
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
            onCloseRequest ? onCloseRequest() : void nativeWindowService.close()
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
