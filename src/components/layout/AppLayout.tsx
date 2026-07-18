import { ProjectSidebar } from "@/components/projects/ProjectSidebar";
import { TerminalWorkspace } from "@/components/terminal/TerminalWorkspace";
import { WindowTitleBar } from "@/components/layout/WindowTitleBar";

/**
 * Top-level application shell: sidebar on the left, terminal workspace on the
 * right. Phase 1 renders placeholders; later phases wire real stores.
 */
export function AppLayout() {
  return (
    <div className="app-frame flex h-full w-full flex-col overflow-hidden bg-bg text-fg">
      <WindowTitleBar />
      <div className="flex min-h-0 flex-1 flex-row">
        <ProjectSidebar />
        <TerminalWorkspace />
      </div>
    </div>
  );
}
