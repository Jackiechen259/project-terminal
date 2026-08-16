/**
 * Backend window/workspace command bindings.
 *
 * Project Terminal is a single-process, single-main-window application. The
 * backend `WindowManager` owns the only desktop window (`main`); UI
 * components must never create windows through the raw Tauri API. This module
 * is the only place the frontend talks to the window manager.
 */

import { invoke } from "@tauri-apps/api/core";

/** Identity of the workspace this WebView belongs to. */
export interface WorkspaceInfo {
  windowLabel: string;
  workspaceId: string;
  /** Project the main window was opened with, if any. */
  projectId: string | null;
  /**
   * Id of the legacy multi-window workspace this install was migrated from,
   * when the migration ran. Lets boot run a one-time per-workspace layout
   * migration; `null` in the steady state.
   */
  migratedFromWorkspaceId: string | null;
}

/** Payload of the `window://close-request` event (backend-held close). */
export interface WindowCloseRequestPayload {
  workspaceId: string;
  runningCount: number;
}

export const WINDOW_CLOSE_REQUEST_EVENT = "window://close-request";

export const windowService = {
  /** Read the calling window's workspace identity (once, at boot). */
  workspaceInfo: (): Promise<WorkspaceInfo> =>
    invoke<WorkspaceInfo>("workspace_info"),

  /**
   * Tell the backend which project the main window has selected, so the
   * window title stays accurate and the project survives restarts.
   */
  setActiveProject: (projectId: string | null): Promise<void> =>
    invoke<void>("set_window_project", { projectId }),
};
