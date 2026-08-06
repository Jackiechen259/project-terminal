import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview, type DragDropEvent } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";

/**
 * Narrow adapter around Tauri-owned APIs.
 *
 * UI components use this module instead of importing Tauri directly. Keeping
 * the native boundary in one place makes browser tests easier to isolate and
 * prevents command names and platform details from leaking into components.
 */
export const nativeAppService = {
  version: () => getVersion(),
  exit: () => invoke<void>("exit_application"),
};

export const nativeWindowService = {
  current: () => getCurrentWindow(),
  hide: () => getCurrentWindow().hide(),
  minimize: () => getCurrentWindow().minimize(),
  close: () => getCurrentWindow().close(),
  toggleMaximize: () => getCurrentWindow().toggleMaximize(),
};

export const nativeDialogService = {
  selectDirectory: async (): Promise<string | null> => {
    const selected = await open({ directory: true, multiple: false });
    return typeof selected === "string" ? selected : null;
  },
  selectFiles: async (): Promise<string[]> => {
    const selected = await open({ directory: false, multiple: true });
    if (typeof selected === "string") return [selected];
    return Array.isArray(selected) ? selected : [];
  },
  /** One file, filtered to a named extension set. Null if cancelled. */
  selectFile: async (
    name: string,
    extensions: string[],
  ): Promise<string | null> => {
    const selected = await open({
      directory: false,
      multiple: false,
      filters: [{ name, extensions }],
    });
    return typeof selected === "string" ? selected : null;
  },
};

export const nativeDragDropService = {
  listen: (handler: (event: DragDropEvent) => void) =>
    getCurrentWebview().onDragDropEvent(({ payload }) => handler(payload)),
};
