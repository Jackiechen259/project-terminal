import { useEffect, useState } from "react";
import { Folder, Plus, Server, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useProjectStore } from "@/stores/projectStore";
import { useTerminalStore } from "@/stores/terminalStore";
import { cn } from "@/lib/utils";

import { ProjectDialog } from "./ProjectDialog";
import { ProjectContextMenu } from "./ProjectContextMenu";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { SshConnectionDialog } from "@/components/ssh/SshConnectionDialog";

/**
 * Sidebar listing saved projects. Selecting a project switches the terminal
 * workspace to that project's tab group without tearing down any PTY or
 * xterm instance.
 */
export function ProjectSidebar() {
  const projects = useProjectStore((s) => s.projects);
  const loading = useProjectStore((s) => s.loading);
  const error = useProjectStore((s) => s.error);
  const activeProjectId = useTerminalStore((s) => s.activeProjectId);
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const setActiveProject = useTerminalStore((s) => s.setActiveProject);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  return (
    <aside
      className="flex w-[260px] shrink-0 flex-col border-r border-border bg-surface"
      aria-label="Projects"
    >
      <header className="flex h-11 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Projects
        </span>
        <ProjectDialog
          trigger={
            <Button variant="ghost" size="icon" className="h-7 w-7">
              <Plus className="h-4 w-4" />
            </Button>
          }
        />
      </header>

      <div className="app-scrollbar flex flex-1 flex-col gap-1 overflow-y-auto p-2">
        {loading && projects.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            Loading projects...
          </div>
        ) : projects.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            No projects yet.
            <br />
            Use the + button to add one.
          </div>
        ) : (
          projects.map((project) => (
            <ProjectRow
              key={project.id}
              project={project}
              active={project.id === activeProjectId}
              onSelect={() => setActiveProject(project.id)}
            />
          ))
        )}

        {error ? (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error.message}
          </div>
        ) : null}
      </div>

      <footer className="flex flex-row gap-1 border-t border-border p-2">
        <SshConnectionDialog trigger={<Button variant="ghost" size="sm" className="flex-1 justify-start text-xs"><Server className="mr-2 h-3.5 w-3.5" />SSH</Button>} />
        <SettingsDialog />
      </footer>
    </aside>
  );
}

function ProjectRow({
  project,
  active,
  onSelect,
}: {
  project: { id: string; name: string; type: "local" | "ssh" };
  active: boolean;
  onSelect: () => void;
}) {
  const Icon = project.type === "local" ? Folder : Server;
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);

  function removeProject() {
    if (window.confirm(`Remove project "${project.name}"?`)) {
      void deleteProject(project.id);
    }
  }

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onSelect();
          setMenuPosition({ x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
          }
        }}
        className={cn(
          "group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground",
          active && "bg-accent text-accent-foreground",
        )}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="flex-1 truncate">{project.name}</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 opacity-0 group-hover:opacity-100"
          aria-label="Remove project"
          onClick={(e) => {
            e.stopPropagation();
            removeProject();
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      {menuPosition ? (
        <ProjectContextMenu
          project={project}
          position={menuPosition}
          onOpen={onSelect}
          onRemove={removeProject}
          onClose={() => setMenuPosition(null)}
        />
      ) : null}
    </>
  );
}
