/**
 * Zustand store for terminal tabs.
 *
 * Tabs and recursive pane layouts are indexed by project. Switching projects
 * only changes `activeProjectId`: tabs stay mounted, PTY readers keep running,
 * and terminal sessions are not disposed.
 *
 * Workspace scoping: the store instance is keyed by workspace id, which is
 * `main` in the single-window architecture (each WebView runs its own JS
 * heap, so the module-level cache holds at most the stores this window ever
 * touched). Each store persists under its own
 * `project-terminal.workspace-layout.v2:{id}` key; the `main` workspace falls
 * back to the v1 key for migration. The exported `useTerminalStore` hook and
 * `.getState()`/`.setState()` always target the store of the CURRENT
 * workspace, which is selected at boot by `setCurrentWorkspaceId()`.
 */

import { create, useStore, type UseBoundStore } from "zustand";
import type { Mutate, StoreApi } from "zustand/vanilla";
import { persist, type PersistStorage } from "zustand/middleware";

import type { RightSidebarMode } from "@/components/layout/rightSidebarState";
import { createThrottledJSONStorage } from "@/lib/throttledStorage";
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
import type { SessionInfo } from "@/services";
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
  /** Drop every tab and split view so nothing is restored on next launch. */
  clearAllTabs: () => void;
}

/** Workspace-scoped UI state that is NOT shared between windows. */
export interface WorkspaceUiState {
  sidebarCollapsed: boolean;
  rightSidebarCollapsed: boolean;
  rightSidebarMode: RightSidebarMode;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setRightSidebar: (collapsed: boolean, mode: RightSidebarMode) => void;
}

export interface TerminalWorkspaceState
  extends TerminalStoreState, WorkspaceUiState {
  /**
   * Session ids captured during rehydration, keyed by tab id.
   *
   * Rehydrated tabs are reset to `exited` with a null session id (a persisted
   * session id must never be trusted after a restart - the PTY is dead). The
   * original id is parked here instead so `reconcileWorkspaceSessions` can
   * revive the tabs whose sessions are actually still alive, which is how a
   * window reopened after "keep running" reattaches instead of restarting.
   * Never persisted.
   */
  savedSessionIdsByTabId: Record<string, string | null>;
  reconcileWorkspaceSessions: (sessions: SessionInfo[]) => void;
}

/** Legacy single-window storage key, kept for migration. */
export const TERMINAL_WORKSPACE_STORAGE_KEY =
  "project-terminal.workspace-layout.v1";
/** Per-workspace storage prefix (`project-terminal.workspace-layout.v2:{id}`). */
export const TERMINAL_WORKSPACE_STORAGE_PREFIX =
  "project-terminal.workspace-layout.v2";
/** Workspace id of the first window of the process. */
export const LEGACY_WORKSPACE_ID = "main";

export function workspaceStorageKey(workspaceId: string): string {
  return `${TERMINAL_WORKSPACE_STORAGE_PREFIX}:${workspaceId}`;
}

type PersistedTerminalState = Pick<
  TerminalWorkspaceState,
  | "activeProjectId"
  | "tabsById"
  | "tabGroupsByProjectId"
  | "splitViewsByProjectId"
  | "sidebarCollapsed"
  | "rightSidebarCollapsed"
  | "rightSidebarMode"
>;

/** The shape of one workspace's persisted + in-memory store. */
export type TerminalWorkspaceStore = UseBoundStore<
  Mutate<
    StoreApi<TerminalWorkspaceState>,
    [["zustand/persist", PersistedTerminalState]]
  >
>;

/**
 * Storage for one workspace's layout.
 *
 * Writes always go to the workspace's own v2 key. Reads fall back to the v1
 * key for the legacy `main` workspace so a single-window installation keeps
 * its tabs and split layout after the upgrade.
 */
export function createWorkspaceStorage<S>(
  workspaceId: string,
): PersistStorage<S> & { flush: () => void } {
  const base = createThrottledJSONStorage<S>();
  const ownKey = workspaceStorageKey(workspaceId);
  return {
    getItem: (name) => {
      const ownValue = base.getItem(name);
      if (ownValue !== null) return ownValue;
      if (workspaceId === LEGACY_WORKSPACE_ID && name === ownKey) {
        return base.getItem(TERMINAL_WORKSPACE_STORAGE_KEY);
      }
      return null;
    },
    setItem: (name, value) => base.setItem(name, value),
    removeItem: (name) => base.removeItem(name),
    flush: () => base.flush(),
  };
}

/** One store instance per workspace id, cached module-locally (per WebView). */
const workspaceStores = new Map<string, TerminalWorkspaceStore>();

export function getTerminalWorkspaceStore(
  workspaceId: string,
): TerminalWorkspaceStore {
  let store = workspaceStores.get(workspaceId);
  if (!store) {
    store = createTerminalWorkspaceStore(workspaceId);
    workspaceStores.set(workspaceId, store);
  }
  return store;
}

let currentWorkspaceId: string | null = null;

/** Select the workspace this WebView belongs to. Called once at boot. */
export function setCurrentWorkspaceId(workspaceId: string) {
  currentWorkspaceId = workspaceId;
}

export function getCurrentWorkspaceId(): string {
  return currentWorkspaceId ?? LEGACY_WORKSPACE_ID;
}

/**
 * Test-only: drop every cached store instance and the current-workspace
 * selection so each test starts from a clean slate.
 */
export function resetWorkspaceStoreCacheForTests() {
  workspaceStores.clear();
  currentWorkspaceId = null;
}

function activeWorkspaceStore(): TerminalWorkspaceStore {
  return getTerminalWorkspaceStore(getCurrentWorkspaceId());
}

/**
 * Workspace-aware terminal store hook.
 *
 * Components keep calling `useTerminalStore(selector)` / `useTerminalStore
 * .getState()`; both delegate to the store of the current workspace, so no
 * component needs to know which workspace it renders for.
 */
const useTerminalStoreBase = (selector?: unknown) =>
  useStore(
    activeWorkspaceStore(),
    selector as (state: TerminalWorkspaceState) => unknown,
  );

export const useTerminalStore = Object.assign(useTerminalStoreBase, {
  getState: () => activeWorkspaceStore().getState(),
  setState: (
    partial:
      | Partial<TerminalWorkspaceState>
      | ((
          state: TerminalWorkspaceState,
        ) => Partial<TerminalWorkspaceState> | TerminalWorkspaceState),
    replace?: boolean,
  ) =>
    (
      activeWorkspaceStore().setState as (
        partial: unknown,
        replace?: boolean,
      ) => unknown
    )(partial, replace),
  subscribe: (
    listener: (
      state: TerminalWorkspaceState,
      prevState: TerminalWorkspaceState,
    ) => void,
  ) => activeWorkspaceStore().subscribe(listener),
  getInitialState: () => activeWorkspaceStore().getInitialState(),
  persist: {
    rehydrate: () => activeWorkspaceStore().persist.rehydrate(),
    hasHydrated: () => activeWorkspaceStore().persist.hasHydrated(),
    onFinishHydration: (listener: (state?: TerminalWorkspaceState) => void) =>
      activeWorkspaceStore().persist.onFinishHydration(listener),
    onHydrate: (listener: (state?: TerminalWorkspaceState) => void) =>
      activeWorkspaceStore().persist.onHydrate(listener),
  },
}) as TerminalWorkspaceStore;

export function createTerminalWorkspaceStore(
  workspaceId: string,
): TerminalWorkspaceStore {
  return create<TerminalWorkspaceState>()(
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
          const splitViewsByProjectId = {
            ...(get().splitViewsByProjectId ?? {}),
          };
          delete splitViewsByProjectId[projectId];
          set({
            tabsById,
            tabGroupsByProjectId,
            splitViewsByProjectId,
            activeProjectId:
              get().activeProjectId === projectId
                ? null
                : get().activeProjectId,
          });
        },
        clearAllTabs: () =>
          set({
            activeProjectId: null,
            tabsById: {},
            tabGroupsByProjectId: {},
            splitViewsByProjectId: {},
          }),

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
              ? (remainingIds[removedIdx] ??
                remainingIds[removedIdx - 1] ??
                null)
              : group.activeTabId;

          const splitView = get().splitViewsByProjectId?.[tab.projectId];
          const splitPane = splitView
            ? paneLeaves(splitView.root).find((pane) => pane.tabId === tabId)
            : undefined;
          const nextSplitView =
            splitView && splitPane
              ? closePane(splitView, splitPane.paneId)
              : splitView;
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

          const splitViewsByProjectId = {
            ...(get().splitViewsByProjectId ?? {}),
          };
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
          // Title/status writes repeat the current value constantly (OSC 0/2
          // fires per shell prompt). Skipping identical patches keeps
          // `tabsById` stable so the workspace and sidebar do not re-render.
          const keys = Object.keys(patch) as (keyof TerminalTab)[];
          if (keys.every((key) => existing[key] === patch[key])) return;
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
          if (group.activeTabId === tabId) return;
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
          if (splitView.focusedPaneId === paneId) return;
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
          // Fires per pointermove during a divider drag; `resizePaneSplit`
          // returns the same view once the ratio settles at a clamp boundary.
          const next = resizePaneSplit(splitView, splitId, ratio);
          if (next === splitView) return;
          set({
            splitViewsByProjectId: {
              ...(get().splitViewsByProjectId ?? {}),
              [projectId]: next,
            },
          });
        },

        clearSplitView: (projectId) => {
          if (!get().splitViewsByProjectId?.[projectId]) return;
          const splitViewsByProjectId = {
            ...(get().splitViewsByProjectId ?? {}),
          };
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

        // --- Workspace-scoped UI state ---
        sidebarCollapsed: false,
        rightSidebarCollapsed: false,
        rightSidebarMode: "files",
        setSidebarCollapsed: (collapsed) =>
          set({ sidebarCollapsed: collapsed }),
        setRightSidebar: (collapsed, mode) =>
          set({ rightSidebarCollapsed: collapsed, rightSidebarMode: mode }),

        // --- Live-session reconcile ---
        savedSessionIdsByTabId: {},
        reconcileWorkspaceSessions: (sessions) => {
          const live = new Map(
            sessions.map((session) => [session.sessionId, session]),
          );
          const saved = get().savedSessionIdsByTabId;
          const tabsById = { ...get().tabsById };
          const remaining: Record<string, string | null> = {};
          for (const tab of Object.values(tabsById)) {
            const savedId = saved[tab.id];
            if (!savedId) continue;
            const session = live.get(savedId);
            if (
              session &&
              (session.status === "running" || session.status === "starting")
            ) {
              // The PTY survived the window: reattach instead of restarting.
              tabsById[tab.id] = {
                ...tab,
                sessionId: savedId,
                status: session.status,
                exitCode: undefined,
              };
              remaining[tab.id] = savedId;
            }
            // Stale ids are dropped: the tab stays exited with no session.
          }
          set({ tabsById, savedSessionIdsByTabId: remaining });
        },
      }),
      {
        name: workspaceStorageKey(workspaceId),
        version: 1,
        storage: createWorkspaceStorage<PersistedTerminalState>(workspaceId),
        partialize: (state): PersistedTerminalState => ({
          activeProjectId: state.activeProjectId,
          tabsById: state.tabsById,
          tabGroupsByProjectId: state.tabGroupsByProjectId,
          splitViewsByProjectId: state.splitViewsByProjectId,
          sidebarCollapsed: state.sidebarCollapsed,
          rightSidebarCollapsed: state.rightSidebarCollapsed,
          rightSidebarMode: state.rightSidebarMode,
        }),
        merge: (persisted, current) => {
          const saved = persisted as Partial<TerminalWorkspaceState>;
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
          // Park the persisted session ids so a live-session reconcile can
          // revive them after a "keep running" window close.
          const savedSessionIdsByTabId: Record<string, string | null> = {};
          for (const [id, tab] of Object.entries(saved.tabsById ?? {})) {
            const sessionId = (tab as TerminalTab | undefined)?.sessionId;
            if (sessionId) savedSessionIdsByTabId[id] = sessionId;
          }
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
            savedSessionIdsByTabId,
            sidebarCollapsed: saved.sidebarCollapsed ?? false,
            rightSidebarCollapsed: saved.rightSidebarCollapsed ?? false,
            rightSidebarMode: saved.rightSidebarMode ?? "files",
          };
        },
      },
    ),
  );
}
