/**
 * One-time boot step for a workspace window.
 *
 * Runs before React renders: resolves which workspace this WebView belongs to,
 * selects the matching per-workspace terminal store, waits for its persisted
 * layout to hydrate, then reconciles it against the workspace's live backend
 * sessions. The reconcile is what makes a window reopened after "keep
 * running" reattach to its surviving PTYs instead of starting fresh shells.
 */

import { terminalService } from "@/services";
import {
  getTerminalWorkspaceStore,
  setCurrentWorkspaceId,
} from "@/stores/terminalStore";
import { windowService, type WorkspaceInfo } from "./windowService";

export async function prepareWorkspace(): Promise<WorkspaceInfo> {
  const info = await windowService.workspaceInfo();
  setCurrentWorkspaceId(info.workspaceId);
  const store = getTerminalWorkspaceStore(info.workspaceId);
  await store.persist.rehydrate();
  try {
    // Ownership is derived by the backend from the calling webview; the
    // workspace id here is only a label for the user-facing listing.
    const sessions = await terminalService.listWorkspaceSessions();
    store.getState().reconcileWorkspaceSessions(sessions);
  } catch {
    // Backend unreachable (plain browser dev, tests): restored tabs stay
    // exited and the restart button still works.
  }
  return info;
}
