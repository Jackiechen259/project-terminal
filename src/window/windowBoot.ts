/**
 * One-time boot step for the main window.
 *
 * Runs before React renders: resolves the workspace identity (always `main`
 * in the single-window architecture), selects the matching terminal store,
 * waits for its persisted layout to hydrate, then reconciles it against the
 * workspace's live backend sessions. The reconcile is what makes a window
 * reopened after "keep running" reattach to its surviving PTYs instead of
 * starting fresh shells.
 *
 * Legacy migration: an install upgraded from the multi-window architecture
 * may have its most recent layout stored under a `workspace-{uuid}` key. When
 * the backend reports which workspace it migrated (see
 * `WorkspaceInfo.migratedFromWorkspaceId`), that layout is copied to the
 * `main` key once, before hydration - but only when `main` has no layout of
 * its own and no legacy v1 layout to fall back to.
 *
 * Boot is bounded: `workspaceInfo` must answer within `timeoutMs` or the boot
 * rejects so the caller can fall back to rendering the UI with the window's
 * own label as its workspace. A stuck IPC must never leave the startup shell
 * on screen forever.
 */

import { terminalService } from "@/services";
import {
  getTerminalWorkspaceStore,
  LEGACY_WORKSPACE_ID,
  setCurrentWorkspaceId,
  TERMINAL_WORKSPACE_STORAGE_KEY,
  workspaceStorageKey,
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
 * One-time layout migration for installs upgraded from the multi-window
 * architecture. Copies the layout of the workspace the backend migrated from
 * into the `main` key, unless `main` already has its own layout or a legacy
 * v1 layout to fall back to.
 */
export function migrateLegacyWorkspaceLayout(info: WorkspaceInfo): void {
  if (info.workspaceId !== LEGACY_WORKSPACE_ID) return;
  const migratedFrom = info.migratedFromWorkspaceId;
  if (!migratedFrom || migratedFrom === LEGACY_WORKSPACE_ID) return;

  const ownKey = workspaceStorageKey(LEGACY_WORKSPACE_ID);
  if (localStorage.getItem(ownKey) !== null) return;
  // The v1 key is the true legacy single-window layout and wins over any
  // per-workspace v2 key.
  if (localStorage.getItem(TERMINAL_WORKSPACE_STORAGE_KEY) !== null) return;

  const sourceKey = workspaceStorageKey(migratedFrom);
  const raw = localStorage.getItem(sourceKey);
  if (raw === null) return;

  localStorage.setItem(ownKey, raw);
  // One-time: a later launch (with the backend file already collapsed) must
  // not re-copy stale data over a newer `main` layout.
  localStorage.removeItem(sourceKey);
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
  migrateLegacyWorkspaceLayout(info);
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
