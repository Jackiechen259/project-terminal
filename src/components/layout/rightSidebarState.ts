/** Which panel the right sidebar shows. */
export type RightSidebarMode = "files" | "memos";

export interface RightSidebarState {
  collapsed: boolean;
  mode: RightSidebarMode;
}

/**
 * Title-bar Files/Memo behavior:
 * - sidebar collapsed → open it showing the requested panel;
 * - sidebar open on the other panel → switch panels;
 * - sidebar open on the requested panel → collapse it.
 */
export function selectRightSidebarMode(
  state: RightSidebarState,
  mode: RightSidebarMode,
): RightSidebarState {
  if (state.collapsed) return { collapsed: false, mode };
  if (state.mode !== mode) return { ...state, mode };
  return { ...state, collapsed: true };
}
