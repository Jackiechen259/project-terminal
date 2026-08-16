/**
 * One-time boot step for a workspace window.
 *
 * Runs before React renders: resolves which workspace this WebView belongs to,
 * selects the matching per-workspace terminal store, waits for its persisted
 * layout to hydrate, then reconciles it against the workspace's live backend
 * sessions. The reconcile is what makes a window reopened after "keep
 * running" reattach to its surviving PTYs instead of starting fresh shells.
 *
 * Boot is bounded: `workspaceInfo` must answer within `timeoutMs` or the boot
 * rejects so the caller can fall back to rendering the UI with the window's
 * own label as its workspace. A stuck IPC must never leave the startup shell
 * on screen forever.
 */

import { terminalService } from "@/services";
import {
  getTerminalWorkspaceStore,
  setCurrentWorkspaceId,
} from "@/stores/terminalStore";
import { windowService, type WorkspaceInfo } from "./windowService";

/** How long `workspaceInfo` may take before boot falls back. */
export const WORKSPACE_INFO_TIMEOUT_MS = 5000;

/**
 * Resolve `promise` but reject with a readable error when it does not settle
 * within `ms`. The losing promise is left to settle on its own; its result is
 * discarded (its handlers are attached, so a late rejection is not unhandled).
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} timed out after ${ms}ms`));
    }, ms);
    promise.then(resolve, reject);
  }).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Resolve the workspace identity, hydrate its layout and reconcile live
 * sessions. Rejects only when the workspace identity itself cannot be
 * resolved in time - the caller renders the UI with a workspace fallback.
 */
export async function prepareWorkspace(
  timeoutMs: number = WORKSPACE_INFO_TIMEOUT_MS,
): Promise<WorkspaceInfo> {
  const info = await withTimeout(
    windowService.workspaceInfo(),
    timeoutMs,
    "workspace_info",
  );
  setCurrentWorkspaceId(info.workspaceId);
  const store = getTerminalWorkspaceStore(info.workspaceId);
  try {
    await store.persist.rehydrate();
  } catch (error) {
    // A corrupted or unreadable persisted layout must not block the UI: the
    // store starts from its empty defaults instead.
    console.error(
      "Workspace layout hydration failed; starting with a clean layout",
      error,
    );
  }
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
