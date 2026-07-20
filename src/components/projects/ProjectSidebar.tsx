import { useEffect, useMemo, useState } from "react";
import { Folder, Plus, Server, Terminal, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useProjectStore } from "@/stores/projectStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTerminalStore } from "@/stores/terminalStore";
import { projectService, sshService, terminalService } from "@/services";
import { cn } from "@/lib/utils";
import type { Project } from "@/types";

import { ProjectDialog } from "./ProjectDialog";
import { ProjectContextMenu } from "./ProjectContextMenu";
import { ProjectEditDialog } from "./ProjectEditDialog";
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
  const tabGroups = useTerminalStore((s) => s.tabGroupsByProjectId);
  const tabsById = useTerminalStore((s) => s.tabsById);
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const setActiveProject = useTerminalStore((s) => s.setActiveProject);
  const restoreLastProject = useSettingsStore((s) => s.restoreLastProject);
  const lastProjectId = useSettingsStore((s) => s.lastProjectId);
  const rememberProject = useSettingsStore((s) => s.rememberProject);
  const showTerminalCount = useSettingsStore((s) => s.showTerminalCount);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (
      loading ||
      !restoreLastProject ||
      activeProjectId ||
      projects.length === 0
    ) {
      return;
    }
    const projectId =
      projects.find((project) => project.id === lastProjectId)?.id ??
      projects[0].id;
    setActiveProject(projectId);
    rememberProject(projectId);
  }, [
    activeProjectId,
    lastProjectId,
    loading,
    projects,
    rememberProject,
    restoreLastProject,
    setActiveProject,
  ]);

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
              tabs={
                tabGroups[project.id]?.tabIds
                  .map((id) => tabsById[id])
                  .filter(Boolean) ?? []
              }
              showTerminalCount={showTerminalCount}
              onTestSsh={async () => {
                if (project.type !== "ssh" || !project.ssh?.connectionId)
                  return;
                setNotice("Testing SSH connection…");
                try {
                  setNotice(await sshService.test(project.ssh.connectionId));
                } catch (cause) {
                  setNotice(
                    `SSH test failed: ${(cause as { message?: string }).message ?? "Unknown error"}`,
                  );
                }
              }}
              onSelect={() => {
                setActiveProject(project.id);
                rememberProject(project.id);
              }}
            />
          ))
        )}

        {error ? (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error.message}
          </div>
        ) : null}
        {notice ? (
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {notice}
          </div>
        ) : null}
      </div>

      <footer className="flex flex-row gap-1 border-t border-border p-2">
        <SshConnectionDialog
          trigger={
            <Button
              variant="ghost"
              size="sm"
              className="flex-1 justify-start text-xs"
            >
              <Server className="mr-2 h-3.5 w-3.5" />
              SSH
            </Button>
          }
        />
        <SettingsDialog />
      </footer>
    </aside>
  );
}

function ProjectRow({
  project,
  active,
  tabs,
  onTestSsh,
  onSelect,
  showTerminalCount,
}: {
  project: Project;
  active: boolean;
  tabs: Array<{
    status:
      | "starting"
      | "connecting"
      | "initializing"
      | "running"
      | "exited"
      | "error";
  }>;
  onTestSsh: () => void;
  onSelect: () => void;
  showTerminalCount: boolean;
}) {
  const Icon =
    project.type === "local"
      ? Folder
      : project.type === "wsl"
        ? Terminal
        : Server;
  const running = tabs.filter((tab) =>
    ["starting", "connecting", "initializing", "running"].includes(tab.status),
  ).length;
  const hasError = tabs.some((tab) => tab.status === "error");
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const projectGroup = useTerminalStore(
    (s) => s.tabGroupsByProjectId[project.id],
  );
  const allTabs = useTerminalStore((s) => s.tabsById);
  const projectTabs = useMemo(
    () => projectGroup?.tabIds.map((id) => allTabs[id]).filter(Boolean) ?? [],
    [allTabs, projectGroup],
  );
  const removeProjectTabs = useTerminalStore((s) => s.removeProjectTabs);
  const [menuPosition, setMenuPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [editing, setEditing] = useState(false);

  async function removeProject() {
    if (window.confirm(`Remove project "${project.name}"?`)) {
      try {
        await Promise.all(
          projectTabs
            .filter((tab) => tab.sessionId)
            .map((tab) => terminalService.close(tab.sessionId)),
        );
        await deleteProject(project.id);
        removeProjectTabs(project.id);
      } catch {
        // Keep state intact when persistence fails, so the user can recover.
      }
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
        {showTerminalCount && running ? (
          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-400">
            {running}
          </span>
        ) : null}
        {hasError ? (
          <span
            className="h-2 w-2 rounded-full bg-destructive"
            aria-label="Terminal error"
          />
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 opacity-0 group-hover:opacity-100"
          aria-label="Remove project"
          onClick={(e) => {
            e.stopPropagation();
            void removeProject();
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
          onRemove={() => void removeProject()}
          onTestSsh={onTestSsh}
          onEdit={() => setEditing(true)}
          onOpenExplorer={() => void projectService.openInExplorer(project.id)}
          onClose={() => setMenuPosition(null)}
        />
      ) : null}
      <ProjectEditDialog
        project={project}
        openState={editing}
        onOpenChange={setEditing}
      />
    </>
  );
}
