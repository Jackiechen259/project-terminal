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

import type { ProjectTabGroup, TerminalTab } from "@/types";

export interface TerminalStoreState {
  activeProjectId: string | null;
  tabsById: Record<string, TerminalTab>;
  tabGroupsByProjectId: Record<string, ProjectTabGroup>;

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

  /** Tabs visible for the active project. */
  visibleTabs: () => TerminalTab[];

  /** Active tab of the active project, or null. */
  activeTab: () => TerminalTab | null;

  /** Ensure every project has a tab group. */
  ensureGroup: (projectId: string) => ProjectTabGroup;

  /** Clear tabs for a deleted project after its PTYs have been closed. */
  removeProjectTabs: (projectId: string) => void;
}

export const useTerminalStore = create<TerminalStoreState>((set, get) => ({
  activeProjectId: null,
  tabsById: {},
  tabGroupsByProjectId: {},

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
    set({
      tabsById,
      tabGroupsByProjectId,
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

    const updatedGroup: ProjectTabGroup = {
      ...group,
      tabIds: remainingIds,
      activeTabId: newActiveId,
    };

    const nextTabsById = { ...get().tabsById };
    delete nextTabsById[tabId];

    set({
      tabsById: nextTabsById,
      tabGroupsByProjectId: {
        ...get().tabGroupsByProjectId,
        [tab.projectId]: updatedGroup,
      },
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
}));
