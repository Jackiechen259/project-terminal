import { ProjectSidebar } from "@/components/projects/ProjectSidebar";
import { ProjectFilePanel } from "@/components/files/ProjectFilePanel";
import { TerminalWorkspace } from "@/components/terminal/TerminalWorkspace";
import { WindowTitleBar } from "@/components/layout/WindowTitleBar";
import { useState } from "react";
import { ChevronRight, LogOut, Minimize2, PowerOff } from "lucide-react";
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
import { nativeAppService, nativeWindowService } from "@/services/native";

/** Top-level application shell and close-to-tray workflow. */
export function AppLayout() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const openFileSidebarByDefault = useSettingsStore(
    (state) => state.openFileSidebarByDefault,
  );
  const [fileSidebarCollapsed, setFileSidebarCollapsed] = useState(
    () => !openFileSidebarByDefault,
  );
  const [closePromptOpen, setClosePromptOpen] = useState(false);
  const runningTerminalCount = useTerminalStore(
    (state) =>
      Object.values(state.tabsById).filter(
        (tab) => tab.status !== "exited" && tab.status !== "error",
      ).length,
  );
  const { t } = useTranslation();

  return (
    <div className="app-frame flex h-full w-full flex-col overflow-hidden bg-bg text-foreground">
      <WindowTitleBar
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed((collapsed) => !collapsed)}
        fileSidebarCollapsed={fileSidebarCollapsed}
        onToggleFileSidebar={() =>
          setFileSidebarCollapsed((collapsed) => !collapsed)
        }
        onCloseRequest={() => setClosePromptOpen(true)}
      />
      <div className="flex min-h-0 flex-1 flex-row">
        {!sidebarCollapsed ? <ProjectSidebar /> : null}
        <TerminalWorkspace />
        {!fileSidebarCollapsed ? (
          <ProjectFilePanel onClose={() => setFileSidebarCollapsed(true)} />
        ) : null}
      </div>
      <Dialog open={closePromptOpen} onOpenChange={setClosePromptOpen}>
        <DialogContent className="max-w-[420px] gap-0 overflow-hidden p-0">
          <DialogHeader className="space-y-0 border-b border-border bg-surface px-5 py-4 pr-12 text-left">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <LogOut className="h-[18px] w-[18px]" />
              </span>
              <div className="flex min-w-0 flex-col gap-1">
                <DialogTitle className="text-[15px]">
                  {t("Close Project Terminal?")}
                </DialogTitle>
                <DialogDescription className="text-xs leading-relaxed">
                  {runningTerminalCount > 0
                    ? t("{count} terminal(s) are still running.", {
                        count: runningTerminalCount,
                      })
                    : t("Choose whether running terminals should continue.")}
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
                  {t("Hide to tray and keep running")}
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
                useTerminalStore.getState().clearAllTabs();
                void nativeAppService.exit();
              }}
              className="group flex w-full items-center gap-3 rounded-md border border-border px-3 py-3 text-left transition-colors hover:border-destructive hover:bg-destructive/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <PowerOff className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-destructive" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium transition-colors group-hover:text-destructive">
                  {t("Stop all terminals and quit")}
                </span>
                <span className="text-xs leading-relaxed text-muted-foreground">
                  {t("All sessions end immediately and unsaved work is lost.")}
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
