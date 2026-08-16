import { ProjectSidebar } from "@/components/projects/ProjectSidebar";
import { ProjectFilePanel } from "@/components/files/ProjectFilePanel";
import { ProjectMemoPanel } from "@/components/memos/ProjectMemoPanel";
import { TerminalWorkspace } from "@/components/terminal/TerminalWorkspace";
import { StatusBar } from "@/components/layout/StatusBar";
import { WindowTitleBar } from "@/components/layout/WindowTitleBar";
import {
  selectRightSidebarMode,
  type RightSidebarMode,
} from "@/components/layout/rightSidebarState";
import { useEffect, useState } from "react";
import {
  ChevronRight,
  Minimize2,
  PowerOff,
  SquareTerminal,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import { useTerminalStore } from "@/stores/terminalStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useProjectStore } from "@/stores/projectStore";
import { nativeAppService, nativeWindowService } from "@/services/native";
import {
  windowService,
  WINDOW_CLOSE_REQUEST_EVENT,
  type WindowCloseRequestPayload,
} from "@/window/windowService";
import { useWindowWorkspace } from "@/window/useWindowWorkspace";

/** Top-level application shell and the main window's close workflow. */
export function AppLayout() {
  const { t } = useTranslation();
  const { projectId: bootProjectId } = useWindowWorkspace();
  const sidebarCollapsed = useTerminalStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useTerminalStore((s) => s.setSidebarCollapsed);
  const rightSidebarCollapsed = useTerminalStore(
    (s) => s.rightSidebarCollapsed,
  );
  const rightSidebarMode = useTerminalStore((s) => s.rightSidebarMode);
  const setRightSidebar = useTerminalStore((s) => s.setRightSidebar);
  const activeProjectId = useTerminalStore((s) => s.activeProjectId);
  const setActiveProject = useTerminalStore((s) => s.setActiveProject);
  const [closePromptOpen, setClosePromptOpen] = useState(false);
  // There is exactly one window, so the running count is global: closing the
  // window reports every terminal of the application.
  const runningTerminalCount = useTerminalStore(
    (state) =>
      Object.values(state.tabsById).filter(
        (tab) => tab.status !== "exited" && tab.status !== "error",
      ).length,
  );

  /**
   * Title-bar Files/Memo behavior: opening a collapsed sidebar shows the
   * requested panel; an open sidebar switches panels; clicking the panel that
   * is already showing collapses the sidebar.
   */
  const handleSelectRightSidebar = (mode: RightSidebarMode) => {
    const next = selectRightSidebarMode(
      { collapsed: rightSidebarCollapsed, mode: rightSidebarMode },
      mode,
    );
    setRightSidebar(next.collapsed, next.mode);
  };
  const handleToggleRightSidebar = () => {
    setRightSidebar(!rightSidebarCollapsed, rightSidebarMode);
  };

  // The close button hides the main window to the tray. When terminals are
  // still running the user is asked first: hide and keep them running, or
  // stop everything and quit. Without running terminals the window hides
  // directly - the process and the tray stay alive.
  const handleCloseRequest = () => {
    if (runningTerminalCount > 0) {
      setClosePromptOpen(true);
      return;
    }
    void nativeWindowService.hide();
  };

  // Backend-held close (Alt+F4 / taskbar close while terminals run): surface
  // the same hide-vs-quit dialog.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void nativeWindowService
      .listen<WindowCloseRequestPayload>(WINDOW_CLOSE_REQUEST_EVENT, () =>
        setClosePromptOpen(true),
      )
      .then((dispose) => {
        unlisten = dispose;
      });
    return () => unlisten?.();
  }, []);

  // Keep the backend's window title and persisted active project in sync
  // with the workspace's active project.
  useEffect(() => {
    void windowService.setActiveProject(activeProjectId).catch(() => {});
  }, [activeProjectId]);

  // Restore the last project once the project list is available (only when
  // the window itself has no restored selection).
  const projects = useProjectStore((s) => s.projects);
  const projectsLoaded = useProjectStore((s) => s.loaded);
  const rememberProject = useSettingsStore((s) => s.rememberProject);
  useEffect(() => {
    if (!projectsLoaded || activeProjectId || !bootProjectId) return;
    if (!projects.some((project) => project.id === bootProjectId)) return;
    setActiveProject(bootProjectId);
    rememberProject(bootProjectId);
  }, [
    activeProjectId,
    bootProjectId,
    projects,
    projectsLoaded,
    rememberProject,
    setActiveProject,
  ]);

  return (
    <div className="app-frame flex h-full w-full flex-col overflow-hidden bg-bg text-foreground">
      <WindowTitleBar
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
        rightSidebarCollapsed={rightSidebarCollapsed}
        rightSidebarMode={rightSidebarMode}
        onSelectRightSidebar={handleSelectRightSidebar}
        onToggleRightSidebar={handleToggleRightSidebar}
        onCloseRequest={handleCloseRequest}
      />
      <div className="flex min-h-0 flex-1 flex-row">
        {!sidebarCollapsed ? <ProjectSidebar /> : null}
        <TerminalWorkspace />
        {!rightSidebarCollapsed ? (
          <div className="relative flex h-full">
            <ProjectFilePanel
              onClose={handleToggleRightSidebar}
              hidden={rightSidebarMode !== "files"}
            />
            <ProjectMemoPanel
              onClose={handleToggleRightSidebar}
              hidden={rightSidebarMode !== "memos"}
            />
          </div>
        ) : null}
      </div>
      <StatusBar />
      <Dialog open={closePromptOpen} onOpenChange={setClosePromptOpen}>
        <DialogContent className="max-w-[420px] gap-0 overflow-hidden p-0">
          <DialogHeader className="space-y-0 border-b border-border bg-surface px-5 py-4 pr-12 text-left">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <SquareTerminal className="h-[18px] w-[18px]" />
              </span>
              <div className="flex min-w-0 flex-col gap-1">
                <DialogTitle className="text-[15px]">
                  {t("Close this window?")}
                </DialogTitle>
                <DialogDescription className="text-xs leading-relaxed">
                  {t("{count} terminal(s) are still running.", {
                    count: runningTerminalCount,
                  })}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className="flex flex-col gap-2 p-4">
            <button
              type="button"
              autoFocus
              onClick={() => {
                setClosePromptOpen(false);
                void nativeWindowService.hide();
              }}
              className="group flex w-full items-center gap-3 rounded-md border border-border px-3 py-3 text-left transition-colors hover:border-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Minimize2 className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium">
                  {t("Hide window and keep terminals running")}
                </span>
                <span className="text-xs leading-relaxed text-muted-foreground">
                  {t(
                    "Terminals keep working in the background. Reopen from the tray icon.",
                  )}
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-primary" />
            </button>
            <button
              type="button"
              onClick={() => {
                setClosePromptOpen(false);
                void nativeAppService.exit();
              }}
              className="group flex w-full items-center gap-3 rounded-md border border-border px-3 py-3 text-left transition-colors hover:border-destructive hover:bg-destructive/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <PowerOff className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-destructive" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium transition-colors group-hover:text-destructive">
                  {t("Stop terminals and quit")}
                </span>
                <span className="text-xs leading-relaxed text-muted-foreground">
                  {t("All running terminals will be stopped.")}
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-destructive" />
            </button>
          </div>
          <div className="flex justify-end border-t border-border bg-surface px-4 py-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setClosePromptOpen(false)}
            >
              {t("Cancel")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
