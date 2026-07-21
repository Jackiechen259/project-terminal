import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  Pencil,
  Plus,
  Server,
  Terminal,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useProjectStore } from "@/stores/projectStore";
import {
  useCollectionStore,
  type ProjectCollection,
} from "@/stores/collectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTerminalStore } from "@/stores/terminalStore";
import { projectService, sshService, terminalService } from "@/services";
import { cn } from "@/lib/utils";
import type { Project } from "@/types";

import { ProjectDialog } from "./ProjectDialog";
import { ProjectContextMenu } from "./ProjectContextMenu";
import { ProjectEditDialog } from "./ProjectEditDialog";
import { CollectionDialog } from "./CollectionDialog";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { SshConnectionDialog } from "@/components/ssh/SshConnectionDialog";

type DropPosition = "before" | "after";

type DropTarget =
  | { kind: "collection"; collectionId: string }
  | {
      kind: "project";
      projectId: string;
      collectionId: string | null;
      position: DropPosition;
    }
  | { kind: "ungrouped" };

/**
 * Decide whether a pointer/drag position over a row should insert the dragged
 * project before or after that row. The top half of the row means "before",
 * the bottom half means "after" - so dropping on the bottom half of the last
 * row places the project at the very end of the list. When the row has no
 * layout height (jsdom / unmounted), default to "before" to preserve the
 * historical insert-above behaviour.
 */
function computeDropPosition(
  clientY: number,
  rect: DOMRect,
): DropPosition {
  if (rect.height === 0) return "before";
  return clientY - rect.top <= rect.height / 2 ? "before" : "after";
}

/**
 * Structural equality for drop targets. Used to skip the (flushSync) re-render
 * when `pointermove` fires over the same half of the same row - and to ignore
 * the row being dragged itself, so the drop indicator never shows on the
 * source row.
 */
function sameDropTarget(a: DropTarget | null, b: DropTarget): boolean {
  if (!a) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === "collection" && b.kind === "collection") {
    return a.collectionId === b.collectionId;
  }
  if (a.kind === "project" && b.kind === "project") {
    return (
      a.projectId === b.projectId &&
      a.collectionId === b.collectionId &&
      a.position === b.position
    );
  }
  return true;
}

/**
 * Sidebar listing saved projects, optionally grouped into collections.
 * Selecting a project switches the terminal workspace to that project's tab
 * group without tearing down any PTY or xterm instance. Projects can be
 * dragged into collections (or out to ungrouped) using pointer events, which
 * avoids platform-specific native drag-and-drop cursors.
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

  const collections = useCollectionStore((s) => s.collections);
  const collapsed = useCollectionStore((s) => s.collapsed);
  const ungroupedProjectIds = useCollectionStore((s) => s.ungroupedProjectIds);
  const moveProjectToCollection = useCollectionStore(
    (s) => s.moveProjectToCollection,
  );
  const toggleCollapsed = useCollectionStore((s) => s.toggleCollapsed);
  const reorderUngroupedProject = useCollectionStore(
    (s) => s.reorderUngroupedProject,
  );
  const deleteCollection = useCollectionStore((s) => s.deleteCollection);
  const pruneDeletedProjects = useCollectionStore(
    (s) => s.pruneDeletedProjects,
  );

  const [notice, setNotice] = useState<string | null>(null);
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  // Ref mirrors `draggedProjectId` for synchronous reads inside dragover
  // handlers. React state updates are async, so by the time the first
  // `dragover` fires the state may still be null - that makes the browser
  // refuse the drop. The ref is set the instant `dragstart` fires.
  const draggedProjectRef = useRef<string | null>(null);
  const dropTargetRef = useRef<DropTarget | null>(null);

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

  // Drop project ids that no longer exist from all collections.
  const existingProjectIds = useMemo(
    () => new Set(projects.map((p) => p.id)),
    [projects],
  );
  useEffect(() => {
    pruneDeletedProjects(existingProjectIds);
  }, [existingProjectIds, pruneDeletedProjects]);

  const projectsById = useMemo(() => {
    const map: Record<string, Project> = {};
    for (const p of projects) map[p.id] = p;
    return map;
  }, [projects]);

  const projectCollectionId = useMemo(() => {
    const map: Record<string, string> = {};
    for (const col of collections) {
      for (const pid of col.projectIds) map[pid] = col.id;
    }
    return map;
  }, [collections]);

  const ungroupedProjects = useMemo(() => {
    const ungrouped = projects.filter((p) => !projectCollectionId[p.id]);
    const orderIndex = new Map(
      ungroupedProjectIds.map((id, index) => [id, index]),
    );
    return [...ungrouped].sort(
      (a, b) =>
        (orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
        (orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
  }, [projects, projectCollectionId, ungroupedProjectIds]);

  const hasCollections = collections.length > 0;

  const clearDrag = useCallback(() => {
    draggedProjectRef.current = null;
    dropTargetRef.current = null;
    setDraggedProjectId(null);
    setDropTarget(null);
  }, []);

  function beginPointerDrag(
    projectId: string,
    event: React.PointerEvent<HTMLDivElement>,
  ) {
    if (
      event.button > 0 ||
      (event.target as HTMLElement).closest("button")
    ) {
      return;
    }
    // Touch and pen inputs get implicit pointer capture on `pointerdown`,
    // which redirects every subsequent pointer event to the source row.
    // That stops `pointerenter` from firing on drop targets, so the drag
    // goes nowhere. Release the capture so hit-testing behaves like mouse.
    const dragSource = event.currentTarget;
    if (dragSource.hasPointerCapture?.(event.pointerId)) {
      dragSource.releasePointerCapture?.(event.pointerId);
    }
    draggedProjectRef.current = projectId;
    dropTargetRef.current = null;
    setDraggedProjectId(projectId);
    setDropTarget(null);
  }

  function setPointerDropTarget(target: DropTarget) {
    if (!draggedProjectRef.current) return;
    // Never mark the row being dragged as a drop target - otherwise dragging
    // a project over its own row would light up the drop indicator on it.
    if (
      target.kind === "project" &&
      target.projectId === draggedProjectRef.current
    ) {
      return;
    }
    // `pointermove` fires very frequently while the pointer travels across a
    // row; bail out when nothing actually changed so we skip the flushSync
    // re-render on every pixel of motion within the same half of the row.
    if (sameDropTarget(dropTargetRef.current, target)) return;
    dropTargetRef.current = target;
    // `pointerenter` runs at ContinuousEventPriority, so React defers the
    // re-render. The ref above is read synchronously by the `pointerup`
    // handler; without flushing, the drop indicator (blue bar) lags behind
    // the actual drop target on fast drags - the user sees one target
    // highlighted while the project lands on another.
    flushSync(() => setDropTarget(target));
  }

  function isProjectDrag(event: React.DragEvent<HTMLElement>) {
    // WebView2 can report an empty `dataTransfer.types` list during
    // `dragover`, even when the drag started in this app. The ref is set at
    // drag start, so it is the reliable source of truth for our own drags.
    void event;
    return draggedProjectRef.current !== null;
  }

  const handleDropTarget = useCallback((target: DropTarget) => {
    const id = draggedProjectRef.current;
    if (!id) return;
    if (target.kind === "collection") {
      if (projectCollectionId[id] === target.collectionId) {
        clearDrag();
        return;
      }
      moveProjectToCollection(id, target.collectionId, null);
    } else if (target.kind === "project") {
      if (target.projectId === id) {
        clearDrag();
        return;
      }
      moveProjectToCollection(
        id,
        target.collectionId,
        target.projectId,
        target.position,
      );
      if (target.collectionId === null) {
        reorderUngroupedProject(
          id,
          target.projectId,
          ungroupedProjects.map((project) => project.id),
          target.position,
        );
      }
    } else {
      moveProjectToCollection(id, null);
      reorderUngroupedProject(
        id,
        null,
        ungroupedProjects.map((project) => project.id),
      );
    }
    clearDrag();
  }, [
    clearDrag,
    moveProjectToCollection,
    projectCollectionId,
    reorderUngroupedProject,
    ungroupedProjects,
  ]);

  useEffect(() => {
    const finishPointerDrag = () => {
      const target = dropTargetRef.current;
      if (draggedProjectRef.current && target) {
        handleDropTarget(target);
      } else {
        clearDrag();
      }
    };
    window.addEventListener("pointerup", finishPointerDrag);
    window.addEventListener("pointercancel", clearDrag);
    return () => {
      window.removeEventListener("pointerup", finishPointerDrag);
      window.removeEventListener("pointercancel", clearDrag);
    };
  }, [clearDrag, handleDropTarget]);

  function tabsFor(projectId: string) {
    return (
      tabGroups[projectId]?.tabIds.map((id) => tabsById[id]).filter(Boolean) ??
      []
    );
  }

  async function testSsh(project: Project) {
    if (project.type !== "ssh" || !project.ssh?.connectionId) return;
    setNotice("Testing SSH connection…");
    try {
      setNotice(await sshService.test(project.ssh.connectionId));
    } catch (cause) {
      setNotice(
        `SSH test failed: ${(cause as { message?: string }).message ?? "Unknown error"}`,
      );
    }
  }

  return (
    <aside
      className="flex w-[260px] shrink-0 select-none flex-col border-r border-border bg-surface"
      aria-label="Projects"
      onDragEnter={(e) => {
        // WebView2 determines the cursor from the first entered drop target.
        // Accept the in-app drag here as well as on individual targets so it
        // is shown as a move instead of the prohibited (red cross) cursor.
        if (isProjectDrag(e)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }
      }}
      onDragOver={(e) => {
        // Always allow the drop so the browser doesn't cancel the drag
        // operation while React state is still catching up.
        if (isProjectDrag(e)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        const id = draggedProjectRef.current;
        if (id) {
          setDraggedProjectId(null);
          setDropTarget(null);
          draggedProjectRef.current = null;
        }
      }}
      onDragEnd={() => {
        setDraggedProjectId(null);
        setDropTarget(null);
        draggedProjectRef.current = null;
      }}
      onPointerLeave={() => {
        // When the pointer exits the sidebar mid-drag, clear the drop
        // target so releasing outside (or over the header/footer) cancels
        // the drag instead of dropping on the last hovered row.
        if (draggedProjectRef.current) {
          dropTargetRef.current = null;
          setDropTarget(null);
        }
      }}
    >
      <header className="flex h-11 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Projects
        </span>
        <div className="flex flex-row gap-1">
          <CollectionDialog
            trigger={
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label="New collection"
                title="New collection"
              >
                <FolderPlus className="h-4 w-4" />
              </Button>
            }
          />
          <ProjectDialog
            trigger={
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label="Add project"
                title="Add project"
              >
                <Plus className="h-4 w-4" />
              </Button>
            }
          />
        </div>
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
          <>
            {collections.map((collection) => (
              <CollectionGroup
                key={collection.id}
                collection={collection}
                projects={collection.projectIds
                  .map((id) => projectsById[id])
                  .filter((p): p is Project => Boolean(p))}
                activeProjectId={activeProjectId}
                collapsed={Boolean(collapsed[collection.id])}
                draggedProjectId={draggedProjectId}
                dropTarget={dropTarget}
                tabsById={tabsById}
                tabGroups={tabGroups}
                showTerminalCount={showTerminalCount}
                onToggleCollapsed={() => toggleCollapsed(collection.id)}
                onDeleteCollection={() => {
                  if (
                    window.confirm(
                      `Delete collection "${collection.name}"? Projects inside will not be removed.`,
                    )
                  ) {
                    deleteCollection(collection.id);
                  }
                }}
                onSelectProject={(id) => {
                  setActiveProject(id);
                  rememberProject(id);
                }}
                onTestSsh={(p) => void testSsh(p)}
                onDragStartProject={(id) => {
                  draggedProjectRef.current = id;
                  setDraggedProjectId(id);
                }}
                onDropTarget={handleDropTarget}
                onDragEnterTarget={setDropTarget}
                isProjectDrag={isProjectDrag}
                onPointerEnterTarget={setPointerDropTarget}
                onPointerDownProject={beginPointerDrag}
              />
            ))}

            {hasCollections ? (
              <UngroupedHeader
                active={
                  draggedProjectId !== null &&
                  (dropTarget?.kind === "ungrouped" ||
                    (dropTarget?.kind === "project" &&
                      dropTarget.collectionId === null))
                }
                onDragOver={(e) => {
                  if (!isProjectDrag(e)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setDropTarget({ kind: "ungrouped" });
                }}
                onDrop={() => {
                  const id = draggedProjectRef.current;
                  if (id) {
                    moveProjectToCollection(id, null);
                    reorderUngroupedProject(
                      id,
                      null,
                      ungroupedProjects.map((project) => project.id),
                    );
                    clearDrag();
                  }
                }}
                onPointerEnter={() => setPointerDropTarget({ kind: "ungrouped" })}
                empty={ungroupedProjects.length === 0}
              />
            ) : null}

            <div className="flex flex-col gap-1">
              {ungroupedProjects.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  active={project.id === activeProjectId}
                  tabs={tabsFor(project.id).map((t) => ({
                    status: t.status,
                  }))}
                  showTerminalCount={showTerminalCount}
                  draggable={false}
                  isDragging={draggedProjectId === project.id}
                  isDropBefore={
                    dropTarget?.kind === "project" &&
                    dropTarget.projectId === project.id &&
                    dropTarget.collectionId === null &&
                    dropTarget.position === "before"
                  }
                  isDropAfter={
                    dropTarget?.kind === "project" &&
                    dropTarget.projectId === project.id &&
                    dropTarget.collectionId === null &&
                    dropTarget.position === "after"
                  }
                  onDragStart={() => {
                    draggedProjectRef.current = project.id;
                    setDraggedProjectId(project.id);
                  }}
                  onPointerDown={(event) => beginPointerDrag(project.id, event)}
                  onPointerEnter={(position) =>
                    setPointerDropTarget({
                      kind: "project",
                      projectId: project.id,
                      collectionId: null,
                      position,
                    })
                  }
                  onPointerMove={(position) =>
                    setPointerDropTarget({
                      kind: "project",
                      projectId: project.id,
                      collectionId: null,
                      position,
                    })
                  }
                  onDragOver={(e) => {
                    if (!isProjectDrag(e)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = "move";
                    setDropTarget({
                      kind: "project",
                      projectId: project.id,
                      collectionId: null,
                      position: computeDropPosition(
                        e.clientY,
                        e.currentTarget.getBoundingClientRect(),
                      ),
                    });
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleDropTarget({
                      kind: "project",
                      projectId: project.id,
                      collectionId: null,
                      position: computeDropPosition(
                        e.clientY,
                        e.currentTarget.getBoundingClientRect(),
                      ),
                    });
                  }}
                  onTestSsh={() => void testSsh(project)}
                  onSelect={() => {
                    setActiveProject(project.id);
                    rememberProject(project.id);
                  }}
                />
              ))}
            </div>
          </>
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

function CollectionGroup({
  collection,
  projects,
  activeProjectId,
  collapsed,
  draggedProjectId,
  dropTarget,
  tabGroups,
  tabsById,
  showTerminalCount,
  onToggleCollapsed,
  onDeleteCollection,
  onSelectProject,
  onTestSsh,
  onDragStartProject,
  onDropTarget,
  onDragEnterTarget,
  isProjectDrag,
  onPointerEnterTarget,
  onPointerDownProject,
}: {
  collection: ProjectCollection;
  projects: Project[];
  activeProjectId: string | null;
  collapsed: boolean;
  draggedProjectId: string | null;
  dropTarget: DropTarget | null;
  tabGroups: ReturnType<
    typeof useTerminalStore.getState
  >["tabGroupsByProjectId"];
  tabsById: ReturnType<typeof useTerminalStore.getState>["tabsById"];
  showTerminalCount: boolean;
  onToggleCollapsed: () => void;
  onDeleteCollection: () => void;
  onSelectProject: (id: string) => void;
  onTestSsh: (project: Project) => void;
  onDragStartProject: (id: string) => void;
  onDropTarget: (target: DropTarget) => void;
  onDragEnterTarget: (target: DropTarget) => void;
  isProjectDrag: (event: React.DragEvent<HTMLElement>) => boolean;
  onPointerEnterTarget: (target: DropTarget) => void;
  onPointerDownProject: (
    projectId: string,
    event: React.PointerEvent<HTMLDivElement>,
  ) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const isDropTarget =
    dropTarget?.kind === "collection" &&
    dropTarget.collectionId === collection.id;

  function tabsFor(projectId: string) {
    return (
      tabGroups[projectId]?.tabIds.map((id) => tabsById[id]).filter(Boolean) ??
      []
    );
  }

  return (
    <div
      data-project-drop-target="collection"
      className={cn(
        "rounded-md",
        isDropTarget && "bg-blue-500/10 ring-1 ring-inset ring-blue-500/40",
      )}
      onDragOver={(e) => {
        if (!isProjectDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        // Only flag as collection-level target when not hovering a child row.
        if (
          dropTarget?.kind !== "project" ||
          dropTarget.collectionId !== collection.id
        ) {
          onDragEnterTarget({
            kind: "collection",
            collectionId: collection.id,
          });
        }
      }}
      onPointerEnter={() =>
        onPointerEnterTarget({ kind: "collection", collectionId: collection.id })
      }
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onDropTarget({ kind: "collection", collectionId: collection.id });
      }}
    >
      <div className="group flex items-center gap-1 rounded-md px-1 py-1 text-sm hover:bg-accent hover:text-accent-foreground">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          aria-label={collapsed ? "Expand collection" : "Collapse collection"}
        >
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
        </button>
        <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="flex flex-1 items-center gap-2 truncate text-left"
        >
          <span className="truncate">{collection.name}</span>
          {collection.projectIds.length > 0 ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {collection.projectIds.length}
            </span>
          ) : null}
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 opacity-0 group-hover:opacity-100"
          aria-label="Rename collection"
          onClick={(e) => {
            e.stopPropagation();
            setRenaming(true);
          }}
        >
          <Pencil className="h-3 w-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 opacity-0 group-hover:opacity-100"
          aria-label="Delete collection"
          onClick={(e) => {
            e.stopPropagation();
            onDeleteCollection();
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {!collapsed ? (
        <div className="flex flex-col gap-0.5 pb-1 pl-3">
          {projects.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/60 px-2 py-3 text-center text-[11px] text-muted-foreground">
              Drag projects here
            </div>
          ) : (
            projects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                active={project.id === activeProjectId}
                tabs={tabsFor(project.id).map((t) => ({ status: t.status }))}
                showTerminalCount={showTerminalCount}
                indent={1}
                draggable={false}
                isDragging={draggedProjectId === project.id}
                isDropBefore={
                  dropTarget?.kind === "project" &&
                  dropTarget.projectId === project.id &&
                  dropTarget.collectionId === collection.id &&
                  dropTarget.position === "before"
                }
                isDropAfter={
                  dropTarget?.kind === "project" &&
                  dropTarget.projectId === project.id &&
                  dropTarget.collectionId === collection.id &&
                  dropTarget.position === "after"
                }
                onDragStart={() => onDragStartProject(project.id)}
                onPointerDown={(event) => onPointerDownProject(project.id, event)}
                onPointerEnter={(position) =>
                  onPointerEnterTarget({
                    kind: "project",
                    projectId: project.id,
                    collectionId: collection.id,
                    position,
                  })
                }
                onPointerMove={(position) =>
                  onPointerEnterTarget({
                    kind: "project",
                    projectId: project.id,
                    collectionId: collection.id,
                    position,
                  })
                }
                onDragOver={(e) => {
                  if (!isProjectDrag(e)) return;
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = "move";
                  onDragEnterTarget({
                    kind: "project",
                    projectId: project.id,
                    collectionId: collection.id,
                    position: computeDropPosition(
                      e.clientY,
                      e.currentTarget.getBoundingClientRect(),
                    ),
                  });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onDropTarget({
                    kind: "project",
                    projectId: project.id,
                    collectionId: collection.id,
                    position: computeDropPosition(
                      e.clientY,
                      e.currentTarget.getBoundingClientRect(),
                    ),
                  });
                }}
                onTestSsh={() => onTestSsh(project)}
                onSelect={() => onSelectProject(project.id)}
              />
            ))
          )}
        </div>
      ) : null}

      <CollectionDialog
        collection={collection}
        openState={renaming}
        onOpenChange={setRenaming}
      />
    </div>
  );
}

function UngroupedHeader({
  active,
  empty,
  onDragOver,
  onDrop,
  onPointerEnter,
}: {
  active: boolean;
  empty: boolean;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onPointerEnter: () => void;
}) {
  return (
    <div
      data-project-drop-target="ungrouped"
      className={cn(
        "mt-1 flex items-center rounded-md px-2 py-1.5",
        active && "bg-blue-500/10 ring-1 ring-inset ring-blue-500/40",
        empty && "border border-dashed border-border/60",
      )}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onPointerEnter={onPointerEnter}
    >
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {empty ? "Drag here to ungroup" : "Ungrouped"}
      </span>
    </div>
  );
}

interface ProjectRowProps {
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
  indent?: number;
  draggable?: boolean;
  isDragging?: boolean;
  isDropBefore?: boolean;
  isDropAfter?: boolean;
  onDragStart?: () => void;
  onDragOver?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop?: (e: React.DragEvent<HTMLDivElement>) => void;
  onPointerDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerEnter?: (position: DropPosition) => void;
  onPointerMove?: (position: DropPosition) => void;
}

function ProjectRow({
  project,
  active,
  tabs,
  onTestSsh,
  onSelect,
  showTerminalCount,
  indent = 0,
  draggable = false,
  isDragging = false,
  isDropBefore = false,
  isDropAfter = false,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onPointerDown,
  onPointerEnter,
  onPointerMove,
}: ProjectRowProps) {
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
        data-project-drop-target="project"
        draggable={draggable}
        onDragStart={(e) => {
          if (!draggable) return;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", project.id);
          onDragStart?.();
        }}
        onDragOver={(e) => onDragOver?.(e)}
        onDragLeave={(e) => onDragLeave?.(e)}
        onDrop={(e) => onDrop?.(e)}
        onPointerDown={onPointerDown}
        onPointerEnter={(e) => {
          if (!onPointerEnter) return;
          onPointerEnter(
            computeDropPosition(
              e.clientY,
              e.currentTarget.getBoundingClientRect(),
            ),
          );
        }}
        onPointerMove={(e) => {
          if (!onPointerMove) return;
          onPointerMove(
            computeDropPosition(
              e.clientY,
              e.currentTarget.getBoundingClientRect(),
            ),
          );
        }}
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
          "group relative flex select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground",
          onPointerDown && "cursor-grab active:cursor-grabbing",
          active && "bg-accent text-accent-foreground",
          isDragging && "opacity-40",
          indent === 1 && "ml-1",
        )}
        style={indent === 1 ? { paddingLeft: "0.5rem" } : undefined}
      >
        {isDropBefore ? (
          <span className="pointer-events-none absolute left-0 right-0 top-0 h-0.5 bg-blue-500" />
        ) : null}
        {isDropAfter ? (
          <span className="pointer-events-none absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500" />
        ) : null}
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
