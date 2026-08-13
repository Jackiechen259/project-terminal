/**
 * Resolve which terminal a memo command should target.
 *
 * The memo panel must send commands to the terminal the user is actually
 * looking at: the active project's focused split pane when a split view is
 * open, otherwise the project's active tab. Never a pane from another
 * project, and never a session that has ended.
 */

import { focusedPane } from "@/lib/paneLayout";
import { useTerminalStore, type TerminalStoreState } from "@/stores/terminalStore";
import type { TerminalTab } from "@/types";

type TerminalStateSlice = Pick<
  TerminalStoreState,
  "tabsById" | "tabGroupsByProjectId" | "splitViewsByProjectId"
>;

/**
 * Pure resolution logic. Returns the target tab for a project, or null when
 * the project has no group, no active/focused tab, or the tab belongs to a
 * different project.
 */
export function resolveActiveTerminalForProject(
  state: TerminalStateSlice,
  projectId: string | null,
): TerminalTab | null {
  if (!projectId) return null;
  const group = state.tabGroupsByProjectId[projectId];
  if (!group) return null;

  const splitView = state.splitViewsByProjectId?.[projectId];
  const tabId = splitView
    ? (focusedPane(splitView)?.tabId ?? null)
    : group.activeTabId;
  if (!tabId) return null;

  const tab = state.tabsById[tabId];
  if (!tab || tab.projectId !== projectId) return null;
  return tab;
}

/**
 * A target is writable only while it owns a live session. The resolver has
 * already pinned the project, so this narrows the type to a session-bearing,
 * running tab.
 */
export function isMemoTerminalRunnable(
  tab: TerminalTab | null | undefined,
): tab is TerminalTab & { sessionId: string } {
  return Boolean(tab && tab.sessionId !== null && tab.status === "running");
}

/**
 * Reactive hook: subscribes to the terminal store with primitive selectors so
 * a memo panel re-renders only when the target tab actually changes (new
 * focused pane, tab activated, tab status/session updated).
 */
export function useMemoTerminalTarget(projectId: string | null): TerminalTab | null {
  const targetTabId = useTerminalStore((state) => {
    if (!projectId) return null;
    const group = state.tabGroupsByProjectId[projectId];
    if (!group) return null;
    const splitView = state.splitViewsByProjectId?.[projectId];
    if (splitView) return focusedPane(splitView)?.tabId ?? null;
    return group.activeTabId;
  });
  return useTerminalStore((state) =>
    targetTabId ? (state.tabsById[targetTabId] ?? null) : null,
  );
}
