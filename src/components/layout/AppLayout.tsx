import { ProjectSidebar } from "@/components/projects/ProjectSidebar";
import { TerminalWorkspace } from "@/components/terminal/TerminalWorkspace";
import { WindowTitleBar } from "@/components/layout/WindowTitleBar";
import { useState } from "react";
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
import { nativeAppService, nativeWindowService } from "@/services/native";

/** Top-level application shell and close-to-tray workflow. */
export function AppLayout() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [closePromptOpen, setClosePromptOpen] = useState(false);
  const { t } = useTranslation();

  return (
    <div className="app-frame flex h-full w-full flex-col overflow-hidden bg-bg text-fg">
      <WindowTitleBar
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed((collapsed) => !collapsed)}
        onCloseRequest={() => setClosePromptOpen(true)}
      />
      <div className="flex min-h-0 flex-1 flex-row">
        {!sidebarCollapsed ? <ProjectSidebar /> : null}
        <TerminalWorkspace />
      </div>
      <Dialog open={closePromptOpen} onOpenChange={setClosePromptOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("Close Project Terminal?")}</DialogTitle>
            <DialogDescription>
              {t("Choose whether running terminals should continue.")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 pt-2">
            <Button
              onClick={() => {
                setClosePromptOpen(false);
                void nativeWindowService.hide();
              }}
            >
              {t("Hide to tray and keep running")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                useTerminalStore.getState().clearAllTabs();
                void nativeAppService.exit();
              }}
            >
              {t("Stop all terminals and quit")}
            </Button>
            <Button variant="ghost" onClick={() => setClosePromptOpen(false)}>
              {t("Cancel")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
