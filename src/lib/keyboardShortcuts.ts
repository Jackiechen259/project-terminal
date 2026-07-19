export type AppShortcut =
  | { type: "new-terminal" }
  | { type: "close-terminal" }
  | { type: "next-tab" }
  | { type: "previous-tab" }
  | { type: "select-tab"; index: number }
  | { type: "copy-terminal" };

/** Maps app shortcuts before WebView2 gets a chance to handle browser ones. */
export function getAppShortcut(event: KeyboardEvent): AppShortcut | null {
  const command = event.ctrlKey || event.metaKey;
  if (!command) return null;

  const key = event.key.toLowerCase();
  if (event.shiftKey && key === "t") return { type: "new-terminal" };
  if (event.shiftKey && key === "w") return { type: "close-terminal" };
  if (event.shiftKey && key === "c") return { type: "copy-terminal" };
  if (key === "tab" || key === "pagedown") {
    return event.shiftKey ? { type: "previous-tab" } : { type: "next-tab" };
  }
  if (key === "pageup") return { type: "previous-tab" };
  if (/^[1-9]$/.test(key) && !event.shiftKey) {
    return { type: "select-tab", index: Number(key) - 1 };
  }
  return null;
}

/** WebView2/browser accelerators that have no place in the desktop shell. */
export function isBrowserShortcut(event: KeyboardEvent) {
  const key = event.key.toLowerCase();
  const command = event.ctrlKey || event.metaKey;
  return (
    event.key === "F5" ||
    event.key === "F12" ||
    (command && (key === "l" || key === "r")) ||
    (command && event.shiftKey && (key === "i" || key === "j"))
  );
}
