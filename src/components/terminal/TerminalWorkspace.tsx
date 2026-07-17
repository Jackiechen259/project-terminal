import { Button } from "@/components/ui/button";
import { Plus, Terminal as TerminalIcon } from "lucide-react";

import { useProjectStore } from "@/stores/projectStore";
import { useTerminalStore } from "@/stores/terminalStore";

/**
 * Terminal workspace: tab strip + terminal area. Phase 3 wires real PTY
 * sessions; Phase 4 wires the project-scoped tab group store. For now we
 * show the active project's tabs (none yet) and an empty state.
 */
export function TerminalWorkspace() {
  const activeProjectId = useTerminalStore((s) => s.activeProjectId);
  const projects = useProjectStore((s) => s.projects);
  const visibleTabs = useTerminalStore((s) => s.visibleTabs());
  const activeProject = projects.find((p) => p.id === activeProjectId);

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-10 items-center gap-1 border-b border-border bg-surface px-2">
        {activeProject && visibleTabs.length > 0 ? (
          visibleTabs.map((tab) => (
            <span
              key={tab.id}
              className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              {tab.title}
            </span>
          ))
        ) : (
          <span className="px-2 text-xs text-muted-foreground">
            {activeProject ? "No terminals open" : "Select a project"}
          </span>
        )}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          aria-label="New terminal"
          className="h-7 w-7 text-muted-foreground"
          disabled={!activeProject}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <div className="relative flex-1 bg-background">
        {activeProject ? (
          visibleTabs.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <TerminalIcon className="mr-2 h-4 w-4" />
              No terminals open for {activeProject.name}.
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Terminal view arrives in Phase 3.
            </div>
          )
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Select or create a project to start a terminal.
          </div>
        )}
      </div>
    </section>
  );
}
