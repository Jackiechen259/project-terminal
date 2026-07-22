/**
 * Zustand store for project collections (user-defined groups in the sidebar).
 *
 * Collections are a UI grouping concern: they reference projects by id and
 * do not need backend validation, so they persist via `localStorage` (matching
 * `settingsStore`). A project id appears in at most one collection at a time -
 * dragging a project into a collection removes it from its previous one.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { createId, nowIso } from "@/lib/utils";

export interface ProjectCollection {
  id: string;
  name: string;
  /** Ordered project ids. A given id appears in at most one collection. */
  projectIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CollectionStoreState {
  collections: ProjectCollection[];
  /** Per-collection collapsed state, keyed by collection id. */
  collapsed: Record<string, boolean>;
  /** User-defined order for projects that are not in a collection. */
  ungroupedProjectIds: string[];

  createCollection: (name: string) => ProjectCollection;
  renameCollection: (id: string, name: string) => void;
  deleteCollection: (id: string) => void;
  /**
   * Move a project into a collection (or out to "ungrouped" when
   * `targetCollectionId` is null). Removes the project from any other
   * collection first to enforce the one-collection invariant. When moving
   * into a collection, `insertBeforeProjectId` controls ordering: omit it
   * (or pass null) to append; pass a project id to insert before (or after,
   * when `insertPosition` is `"after"`) it.
   */
  moveProjectToCollection: (
    projectId: string,
    targetCollectionId: string | null,
    insertBeforeProjectId?: string | null,
    insertPosition?: "before" | "after",
  ) => void;
  /** Reorder collections in the sidebar. */
  reorderCollection: (fromIndex: number, toIndex: number) => void;
  /**
   * Move an ungrouped project before another one, or append when omitted.
   * Pass `position: "after"` to insert after the anchor instead.
   */
  reorderUngroupedProject: (
    projectId: string,
    insertBeforeProjectId?: string | null,
    currentProjectIds?: string[],
    position?: "before" | "after",
  ) => void;
  setCollapsed: (id: string, collapsed: boolean) => void;
  toggleCollapsed: (id: string) => void;
  /** Drop project ids that no longer exist. Called after projects load. */
  pruneDeletedProjects: (existingProjectIds: Set<string>) => void;
}

function withoutProject(
  collections: ProjectCollection[],
  projectId: string,
): ProjectCollection[] {
  return collections.map((c) =>
    c.projectIds.includes(projectId)
      ? { ...c, projectIds: c.projectIds.filter((id) => id !== projectId) }
      : c,
  );
}

function touch(
  collections: ProjectCollection[],
  id: string,
  fn: (c: ProjectCollection) => ProjectCollection,
): ProjectCollection[] {
  return collections.map((c) => (c.id === id ? fn(c) : c));
}

export const useCollectionStore = create<CollectionStoreState>()(
  persist(
    (set, get) => ({
      collections: [],
      collapsed: {},
      ungroupedProjectIds: [],

      createCollection: (name) => {
        const trimmed = name.trim();
        const now = nowIso();
        const collection: ProjectCollection = {
          id: createId("col"),
          name: trimmed || "New collection",
          projectIds: [],
          createdAt: now,
          updatedAt: now,
        };
        set({ collections: [...get().collections, collection] });
        return collection;
      },

      renameCollection: (id, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        set({
          collections: touch(get().collections, id, (c) => ({
            ...c,
            name: trimmed,
            updatedAt: nowIso(),
          })),
        });
      },

      deleteCollection: (id) => {
        set({
          collections: get().collections.filter((c) => c.id !== id),
          collapsed: stripKey(get().collapsed, id),
        });
      },

      moveProjectToCollection: (
        projectId,
        targetCollectionId,
        insertBeforeProjectId = null,
        insertPosition = "before",
      ) => {
        const current = get().collections;
        // Remove the project from any collection first (no-op if not present).
        const cleaned = withoutProject(current, projectId);
        if (targetCollectionId === null) {
          set({ collections: cleaned });
          return;
        }
        set({
          collections: touch(cleaned, targetCollectionId, (c) => {
            const next = [...c.projectIds];
            const insertIndex =
              insertBeforeProjectId && next.includes(insertBeforeProjectId)
                ? insertPosition === "after"
                  ? next.indexOf(insertBeforeProjectId) + 1
                  : next.indexOf(insertBeforeProjectId)
                : next.length;
            next.splice(insertIndex, 0, projectId);
            return { ...c, projectIds: next, updatedAt: nowIso() };
          }),
        });
      },

      reorderCollection: (fromIndex, toIndex) => {
        const list = [...get().collections];
        if (
          fromIndex < 0 ||
          fromIndex >= list.length ||
          toIndex < 0 ||
          toIndex >= list.length ||
          fromIndex === toIndex
        ) {
          return;
        }
        const [moved] = list.splice(fromIndex, 1);
        list.splice(toIndex, 0, moved);
        set({ collections: list });
      },

      reorderUngroupedProject: (
        projectId,
        insertBeforeProjectId = null,
        currentProjectIds,
        position = "before",
      ) => {
        // `ungroupedProjectIds` only contains projects the user has ordered
        // before. Start from the current visible list when provided so a
        // first-time reorder keeps every other project in its real position.
        const base = currentProjectIds ?? get().ungroupedProjectIds;
        const next = base.filter((id) => id !== projectId);
        const insertIndex =
          insertBeforeProjectId && next.includes(insertBeforeProjectId)
            ? position === "after"
              ? next.indexOf(insertBeforeProjectId) + 1
              : next.indexOf(insertBeforeProjectId)
            : next.length;
        next.splice(insertIndex, 0, projectId);
        set({ ungroupedProjectIds: next });
      },

      setCollapsed: (id, collapsed) => {
        set({ collapsed: { ...get().collapsed, [id]: collapsed } });
      },

      toggleCollapsed: (id) => {
        const next = { ...get().collapsed };
        if (next[id]) {
          delete next[id];
        } else {
          next[id] = true;
        }
        set({ collapsed: next });
      },

      pruneDeletedProjects: (existingProjectIds) => {
        let changed = false;
        const next = get().collections.map((c) => {
          if (c.projectIds.length === 0) return c;
          const filtered = c.projectIds.filter((id) =>
            existingProjectIds.has(id),
          );
          if (filtered.length === c.projectIds.length) return c;
          changed = true;
          return { ...c, projectIds: filtered, updatedAt: nowIso() };
        });
        const ungroupedProjectIds = get().ungroupedProjectIds.filter((id) =>
          existingProjectIds.has(id),
        );
        if (
          changed ||
          ungroupedProjectIds.length !== get().ungroupedProjectIds.length
        ) {
          set({ collections: next, ungroupedProjectIds });
        }
      },
    }),
    {
      name: "project-terminal.collections",
      version: 1,
      partialize: (state) => ({
        collections: state.collections,
        collapsed: state.collapsed,
        ungroupedProjectIds: state.ungroupedProjectIds,
      }),
    },
  ),
);

function stripKey<T extends Record<string, unknown>>(obj: T, key: string): T {
  if (!(key in obj)) return obj;
  const next = { ...obj };
  delete next[key];
  return next;
}
