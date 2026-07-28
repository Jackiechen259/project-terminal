import { useEffect, useState } from "react";
import {
  Copy,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Square,
  X,
} from "lucide-react";
import { useTranslation } from "@/i18n";
import { nativeWindowService } from "@/services/native";
import { BrandMark } from "./BrandMark";

/**
 * Application-owned title bar for the undecorated desktop window. Keeping the
 * window actions here means the chrome follows the rest of the dark UI rather
 * than Windows' light title bar.
 */
export function WindowTitleBar({
  sidebarCollapsed = false,
  onToggleSidebar,
  fileSidebarCollapsed = false,
  onToggleFileSidebar,
  onCloseRequest,
}: {
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  fileSidebarCollapsed?: boolean;
  onToggleFileSidebar?: () => void;
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
        <span className="pointer-events-none flex h-5 w-5 items-center justify-center rounded-[5px] bg-[linear-gradient(145deg,#203a73,#291a57)] shadow-[0_0_12px_hsl(210_75%_56%_/_0.26)]">
          <BrandMark className="h-[18px] w-[18px]" />
        </span>
        <span className="pointer-events-none truncate text-[13px] font-medium tracking-[0.01em]">
          Project Terminal
        </span>
        <span className="pointer-events-none hidden text-[11px] text-muted-foreground sm:inline">
          {t("Workspace")}
        </span>
        {onToggleFileSidebar ? (
          <button
            type="button"
            className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={
              fileSidebarCollapsed
                ? t("Show file sidebar")
                : t("Hide file sidebar")
            }
            aria-expanded={!fileSidebarCollapsed}
            title={
              fileSidebarCollapsed
                ? t("Show file sidebar")
                : t("Hide file sidebar")
            }
            onMouseDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onClick={onToggleFileSidebar}
          >
            {fileSidebarCollapsed ? (
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
