/**
 * Zustand store for terminal tabs.
 *
 * Mirrors plan §9.3 - `tabsById: Record<id, TerminalTab>` and
 * `tabGroupsByProjectId: Record<projectId, ProjectTabGroup>`. Switching
 * projects only changes `activeProjectId` - tabs stay mounted, PTY readers
 * keep running, xterm instances are not disposed (plan §10).
 *
 * Phase 3/3.5 will add `createTerminal` that calls the backend PTY command.
 * For Phase 2 the store exists so components can be wired; terminal/session
 * management commands arrive in Phase 3.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

import {
  closePane,
  createSplitView,
  focusRelativePane,
  focusedPane,
  paneLeaves,
  replacePaneTab,
  resizePaneSplit,
  splitPane,
} from "@/lib/paneLayout";
import type {
  ProjectTabGroup,
  TerminalSplitDirection,
  TerminalSplitView,
  TerminalTab,
} from "@/types";

export interface TerminalStoreState {
  activeProjectId: string | null;
  tabsById: Record<string, TerminalTab>;
  tabGroupsByProjectId: Record<string, ProjectTabGroup>;
  splitViewsByProjectId: Record<string, TerminalSplitView>;

  /** Select a project and restore its last active tab. No PTY teardown. */
  setActiveProject: (projectId: string | null) => void;

  /** Register a tab in its project's tab group. */
  registerTab: (tab: TerminalTab) => void;

  /** Remove a tab, dispose its session, and select a neighbor. */
  removeTab: (tabId: string) => void;

  /** Update a tab's fields (status, exitCode, cwd, etc.). */
  updateTab: (tabId: string, patch: Partial<TerminalTab>) => void;

  /** Activate a tab within its project group. */
  setActiveTab: (projectId: string, tabId: string) => void;

  /** Move a tab before or after another tab in the same project. */
  reorderTab: (
    projectId: string,
    tabId: string,
    targetTabId: string,
    position: "before" | "after",
  ) => void;

  setSplitView: (
    projectId: string,
    tabIds: [string, string],
    direction: TerminalSplitDirection,
  ) => void;

  splitPane: (
    projectId: string,
    targetPaneId: string,
    tabId: string,
    direction: TerminalSplitDirection,
  ) => void;

  replaceSplitTab: (projectId: string, paneId: string, tabId: string) => void;

  focusSplitPane: (projectId: string, paneId: string) => void;

  focusRelativePane: (projectId: string, delta: 1 | -1) => void;

  resizeSplit: (projectId: string, splitId: string, ratio: number) => void;

  clearSplitView: (projectId: string) => void;

  /** Tabs visible for the active project. */
  visibleTabs: () => TerminalTab[];

  /** Active tab of the active project, or null. */
  activeTab: () => TerminalTab | null;

  /** Ensure every project has a tab group. */
  ensureGroup: (projectId: string) => ProjectTabGroup;

  /** Clear tabs for a deleted project after its PTYs have been closed. */
  removeProjectTabs: (projectId: string) => void;
}

export const TERMINAL_WORKSPACE_STORAGE_KEY =
  "project-terminal.workspace-layout.v1";

export const useTerminalStore = create<TerminalStoreState>()(
  persist(
    (set, get) => ({
  activeProjectId: null,
  tabsById: {},
  tabGroupsByProjectId: {},
  splitViewsByProjectId: {},

  setActiveProject: (projectId) => set({ activeProjectId: projectId }),

  ensureGroup: (projectId) => {
    const existing = get().tabGroupsByProjectId[projectId];
    if (existing) return existing;
    const fresh: ProjectTabGroup = {
      projectId,
      tabIds: [],
      activeTabId: null,
    };
    set({
      tabGroupsByProjectId: {
        ...get().tabGroupsByProjectId,
        [projectId]: fresh,
      },
    });
    return fresh;
  },

  removeProjectTabs: (projectId) => {
    const group = get().tabGroupsByProjectId[projectId];
    if (!group) return;
    const tabsById = { ...get().tabsById };
    for (const tabId of group.tabIds) delete tabsById[tabId];
    const tabGroupsByProjectId = { ...get().tabGroupsByProjectId };
    delete tabGroupsByProjectId[projectId];
    const splitViewsByProjectId = { ...(get().splitViewsByProjectId ?? {}) };
    delete splitViewsByProjectId[projectId];
    set({
      tabsById,
      tabGroupsByProjectId,
      splitViewsByProjectId,
      activeProjectId:
        get().activeProjectId === projectId ? null : get().activeProjectId,
    });
  },

  registerTab: (tab) => {
    const group = get().ensureGroup(tab.projectId);
    const updatedGroup: ProjectTabGroup = {
      ...group,
      tabIds: [...group.tabIds, tab.id],
      activeTabId: tab.id,
    };
    set({
      tabsById: { ...get().tabsById, [tab.id]: tab },
      tabGroupsByProjectId: {
        ...get().tabGroupsByProjectId,
        [tab.projectId]: updatedGroup,
      },
      activeProjectId: get().activeProjectId ?? tab.projectId,
    });
  },

  removeTab: (tabId) => {
    const tab = get().tabsById[tabId];
    if (!tab) return;
    const group = get().tabGroupsByProjectId[tab.projectId];
    if (!group) return;

    const remainingIds = group.tabIds.filter((id) => id !== tabId);
    // §26.3: activate right neighbor, else left, else none.
    const removedIdx = group.tabIds.indexOf(tabId);
    const newActiveId =
      group.activeTabId === tabId
        ? (remainingIds[removedIdx] ?? remainingIds[removedIdx - 1] ?? null)
        : group.activeTabId;

    const splitView = get().splitViewsByProjectId?.[tab.projectId];
    const splitPane = splitView
      ? paneLeaves(splitView.root).find((pane) => pane.tabId === tabId)
      : undefined;
    const nextSplitView =
      splitView && splitPane ? closePane(splitView, splitPane.paneId) : splitView;
    const otherSplitTabId = nextSplitView
      ? focusedPane(nextSplitView)?.tabId
      : null;
    const updatedGroup: ProjectTabGroup = {
      ...group,
      tabIds: remainingIds,
      activeTabId:
        splitPane &&
        otherSplitTabId &&
        remainingIds.includes(otherSplitTabId)
          ? otherSplitTabId
          : newActiveId,
    };

    const nextTabsById = { ...get().tabsById };
    delete nextTabsById[tabId];

    const splitViewsByProjectId = { ...(get().splitViewsByProjectId ?? {}) };
    if (splitPane) {
      if (nextSplitView) {
        splitViewsByProjectId[tab.projectId] = nextSplitView;
      } else {
        delete splitViewsByProjectId[tab.projectId];
      }
    }

    set({
      tabsById: nextTabsById,
      tabGroupsByProjectId: {
        ...get().tabGroupsByProjectId,
        [tab.projectId]: updatedGroup,
      },
      splitViewsByProjectId,
    });
  },

  updateTab: (tabId, patch) => {
    const existing = get().tabsById[tabId];
    if (!existing) return;
    set({
      tabsById: {
        ...get().tabsById,
        [tabId]: { ...existing, ...patch },
      },
    });
  },

  setActiveTab: (projectId, tabId) => {
    const group = get().tabGroupsByProjectId[projectId];
    if (!group) return;
    if (!group.tabIds.includes(tabId)) return;
    set({
      tabGroupsByProjectId: {
        ...get().tabGroupsByProjectId,
        [projectId]: { ...group, activeTabId: tabId },
      },
    });
  },

  reorderTab: (projectId, tabId, targetTabId, position) => {
    const group = get().tabGroupsByProjectId[projectId];
    if (
      !group ||
      tabId === targetTabId ||
      !group.tabIds.includes(tabId) ||
      !group.tabIds.includes(targetTabId)
    ) {
      return;
    }
    const tabIds = group.tabIds.filter((id) => id !== tabId);
    const targetIndex = tabIds.indexOf(targetTabId);
    tabIds.splice(targetIndex + (position === "after" ? 1 : 0), 0, tabId);
    set({
      tabGroupsByProjectId: {
        ...get().tabGroupsByProjectId,
        [projectId]: { ...group, tabIds },
      },
    });
  },

  setSplitView: (projectId, tabIds, direction) => {
    const group = get().tabGroupsByProjectId[projectId];
    if (
      !group ||
      tabIds[0] === tabIds[1] ||
      !tabIds.every((tabId) => group.tabIds.includes(tabId))
    ) {
      return;
    }
    set({
      splitViewsByProjectId: {
        ...(get().splitViewsByProjectId ?? {}),
        [projectId]: createSplitView(tabIds[0], tabIds[1], direction),
      },
    });
  },

  splitPane: (projectId, targetPaneId, tabId, direction) => {
    const splitView = get().splitViewsByProjectId?.[projectId];
    const group = get().tabGroupsByProjectId[projectId];
    if (!splitView || !group?.tabIds.includes(tabId)) return;
    set({
      splitViewsByProjectId: {
        ...(get().splitViewsByProjectId ?? {}),
        [projectId]: splitPane(splitView, targetPaneId, tabId, direction),
      },
    });
  },

  replaceSplitTab: (projectId, paneId, tabId) => {
    const splitView = get().splitViewsByProjectId?.[projectId];
    const group = get().tabGroupsByProjectId[projectId];
    if (!splitView || !group?.tabIds.includes(tabId)) return;
    set({
      splitViewsByProjectId: {
        ...(get().splitViewsByProjectId ?? {}),
        [projectId]: replacePaneTab(splitView, paneId, tabId),
      },
    });
  },

  focusSplitPane: (projectId, paneId) => {
    const splitView = get().splitViewsByProjectId?.[projectId];
    if (
      !splitView ||
      !paneLeaves(splitView.root).some((pane) => pane.paneId === paneId)
    ) {
      return;
    }
    set({
      splitViewsByProjectId: {
        ...(get().splitViewsByProjectId ?? {}),
        [projectId]: { ...splitView, focusedPaneId: paneId },
      },
    });
  },

  focusRelativePane: (projectId, delta) => {
    const splitView = get().splitViewsByProjectId?.[projectId];
    if (!splitView) return;
    set({
      splitViewsByProjectId: {
        ...(get().splitViewsByProjectId ?? {}),
        [projectId]: focusRelativePane(splitView, delta),
      },
    });
  },

  resizeSplit: (projectId, splitId, ratio) => {
    const splitView = get().splitViewsByProjectId?.[projectId];
    if (!splitView) return;
    set({
      splitViewsByProjectId: {
        ...(get().splitViewsByProjectId ?? {}),
        [projectId]: resizePaneSplit(splitView, splitId, ratio),
      },
    });
  },

  clearSplitView: (projectId) => {
    if (!get().splitViewsByProjectId?.[projectId]) return;
    const splitViewsByProjectId = { ...(get().splitViewsByProjectId ?? {}) };
    delete splitViewsByProjectId[projectId];
    set({ splitViewsByProjectId });
  },

  visibleTabs: () => {
    const { activeProjectId, tabGroupsByProjectId, tabsById } = get();
    if (!activeProjectId) return [];
    const group = tabGroupsByProjectId[activeProjectId];
    if (!group) return [];
    return group.tabIds.map((id) => tabsById[id]).filter(Boolean);
  },

  activeTab: () => {
    const { activeProjectId, tabGroupsByProjectId, tabsById } = get();
    if (!activeProjectId) return null;
    const group = tabGroupsByProjectId[activeProjectId];
    if (!group?.activeTabId) return null;
    return tabsById[group.activeTabId] ?? null;
  },
    }),
    {
      name: TERMINAL_WORKSPACE_STORAGE_KEY,
      version: 1,
      partialize: (state) => ({
        activeProjectId: state.activeProjectId,
        tabsById: state.tabsById,
        tabGroupsByProjectId: state.tabGroupsByProjectId,
        splitViewsByProjectId: state.splitViewsByProjectId,
      }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<TerminalStoreState>;
        const tabsById = Object.fromEntries(
          Object.entries(saved.tabsById ?? {}).map(([id, tab]) => [
            id,
            {
              ...tab,
              sessionId: null,
              status: "exited" as const,
              exitCode: undefined,
            },
          ]),
        );
        const splitViewsByProjectId = Object.fromEntries(
          Object.entries(saved.splitViewsByProjectId ?? {}).flatMap(
            ([projectId, rawView]) => {
              const view = rawView as TerminalSplitView & {
                direction?: TerminalSplitDirection;
                tabIds?: [string, string];
              };
              if (view.root) return [[projectId, view]];
              if (view.tabIds?.length === 2 && view.direction) {
                return [
                  [
                    projectId,
                    createSplitView(
                      view.tabIds[0],
                      view.tabIds[1],
                      view.direction,
                    ),
                  ],
                ];
              }
              return [];
            },
          ),
        );
        return {
          ...current,
          ...saved,
          tabsById,
          splitViewsByProjectId,
        };
      },
    },
  ),
);
