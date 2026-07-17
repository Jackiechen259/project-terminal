import { ProjectSidebar } from "@/components/projects/ProjectSidebar";
import { TerminalWorkspace } from "@/components/terminal/TerminalWorkspace";

/**
 * Top-level application shell: sidebar on the left, terminal workspace on the
 * right. Phase 1 renders placeholders; later phases wire real stores.
 */
export function AppLayout() {
  return (
    <div className="flex h-full w-full flex-row bg-bg text-fg">
      <ProjectSidebar />
      <TerminalWorkspace />
    </div>
  );
}
