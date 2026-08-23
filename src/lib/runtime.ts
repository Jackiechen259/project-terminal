/** True when the UI is running inside the Tauri WebView. */
export function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in
      (window as Window & { __TAURI_INTERNALS__?: unknown })
  );
}
