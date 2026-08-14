/**
 * Backend window/workspace command bindings.
 *
 * Every window in the process is owned by the backend `WindowManager`; UI
 * components must never create windows through the raw Tauri API. This module
 * is the only place the frontend talks to the window manager.
 */

import { invoke } from "@tauri-apps/api/core";

/** Identity of the workspace this WebView belongs to. */
export interface WorkspaceInfo {
  windowLabel: string;
  workspaceId: string;
  /** Project the window was opened with ("Open in New Window"), if any. */
  projectId: string | null;
}

/** One known workspace (open or detached), most recently active first. */
export interface WindowInfo {
  workspaceId: string;
  label: string;
  projectId: string | null;
  title: string;
  detached: boolean;
  visible: boolean;
}

/** Payload of the `window://close-request` event (backend-held close). */
export interface WindowCloseRequestPayload {
  workspaceId: string;
  runningCount: number;
}

export const WINDOW_CLOSE_REQUEST_EVENT = "window://close-request";

export const windowService = {
  /** Create a new workspace window; optionally with a project selected. */
  newWindow: (projectId?: string | null): Promise<string> =>
    invoke<string>("new_window", { projectId: projectId ?? null }),

  /**
   * Close this workspace's window.
   *
   * `keepSessions` keeps its PTYs running (they can be reattached by
   * reopening the workspace); `false` stops exactly this workspace's sessions
   * first. Other windows are never touched.
   */
  closeWindow: (workspaceId: string, keepSessions: boolean): Promise<void> =>
    invoke<void>("close_window", { workspaceId, keepSessions }),

  /** Show/focus an open workspace window, or reopen a detached one. */
  showWindow: (workspaceId: string): Promise<void> =>
    invoke<void>("show_window", { workspaceId }),

  showAll: (): Promise<void> => invoke<void>("show_all_windows"),

  hideAll: (): Promise<void> => invoke<void>("hide_all_windows"),

  listWindows: (): Promise<WindowInfo[]> =>
    invoke<WindowInfo[]>("list_windows"),

  /** Read the calling window's workspace identity (once, at boot). */
  workspaceInfo: (): Promise<WorkspaceInfo> =>
    invoke<WorkspaceInfo>("workspace_info"),

  /**
   * Tell the backend which project this window has selected, so the window
   * title and the tray's window list stay accurate.
   */
  setActiveProject: (projectId: string | null): Promise<void> =>
    invoke<void>("set_window_project", { projectId }),

  /** Reopen every workspace without a live window. Returns count created. */
  restorePreviousWindows: (): Promise<number> =>
    invoke<number>("restore_previous_windows"),
};
