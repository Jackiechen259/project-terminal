import type {
  PaneNode,
  TerminalSplitDirection,
  TerminalSplitView,
} from "@/types";

export const MAX_TERMINAL_PANES = 4;

export interface PaneBounds {
  paneId: string;
  tabId: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SplitBounds {
  paneId: string;
  direction: "horizontal" | "vertical";
  ratio: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

export function terminalPane(tabId: string, paneId = crypto.randomUUID()): PaneNode {
  return { type: "terminal", paneId, tabId };
}

export function paneLeaves(root: PaneNode): Extract<PaneNode, { type: "terminal" }>[] {
  return root.type === "terminal"
    ? [root]
    : [...paneLeaves(root.first), ...paneLeaves(root.second)];
}

export function paneTabIds(view: TerminalSplitView | undefined): string[] {
  return view ? paneLeaves(view.root).map((pane) => pane.tabId) : [];
}

export function focusedPane(view: TerminalSplitView | undefined) {
  if (!view) return undefined;
  return (
    paneLeaves(view.root).find((pane) => pane.paneId === view.focusedPaneId) ??
    paneLeaves(view.root)[0]
  );
}

export function createSplitView(
  firstTabId: string,
  secondTabId: string,
  direction: TerminalSplitDirection,
): TerminalSplitView {
  const first = terminalPane(firstTabId);
  const second = terminalPane(secondTabId);
  return {
    root: {
      type: "split",
      paneId: crypto.randomUUID(),
      direction: toNodeDirection(direction),
      ratio: 0.5,
      first,
      second,
    },
    focusedPaneId: second.paneId,
  };
}

export function splitPane(
  view: TerminalSplitView,
  targetPaneId: string,
  newTabId: string,
  direction: TerminalSplitDirection,
): TerminalSplitView {
  if (paneLeaves(view.root).length >= MAX_TERMINAL_PANES) return view;
  const created = terminalPane(newTabId);
  const replace = (node: PaneNode): PaneNode => {
    if (node.type === "terminal") {
      if (node.paneId !== targetPaneId) return node;
      return {
        type: "split",
        paneId: crypto.randomUUID(),
        direction: toNodeDirection(direction),
        ratio: 0.5,
        first: node,
        second: created,
      };
    }
    return {
      ...node,
      first: replace(node.first),
      second: replace(node.second),
    };
  };
  return { root: replace(view.root), focusedPaneId: created.paneId };
}

export function closePane(
  view: TerminalSplitView,
  paneId: string,
): TerminalSplitView | undefined {
  const remove = (node: PaneNode): PaneNode | undefined => {
    if (node.type === "terminal") return node.paneId === paneId ? undefined : node;
    const first = remove(node.first);
    const second = remove(node.second);
    if (!first) return second;
    if (!second) return first;
    return { ...node, first, second };
  };
  const root = remove(view.root);
  if (!root || root.type === "terminal") return undefined;
  const leaves = paneLeaves(root);
  return {
    root,
    focusedPaneId: leaves.some((pane) => pane.paneId === view.focusedPaneId)
      ? view.focusedPaneId
      : leaves[0].paneId,
  };
}

export function replacePaneTab(
  view: TerminalSplitView,
  paneId: string,
  tabId: string,
): TerminalSplitView {
  const target = paneLeaves(view.root).find((pane) => pane.paneId === paneId);
  if (!target || target.tabId === tabId) return view;
  const existing = paneLeaves(view.root).find((pane) => pane.tabId === tabId);
  const replace = (node: PaneNode): PaneNode => {
    if (node.type === "terminal") {
      if (node.paneId === paneId) return { ...node, tabId };
      if (existing && node.paneId === existing.paneId) {
        return { ...node, tabId: target.tabId };
      }
      return node;
    }
    return {
      ...node,
      first: replace(node.first),
      second: replace(node.second),
    };
  };
  return { ...view, root: replace(view.root), focusedPaneId: paneId };
}

export function focusRelativePane(
  view: TerminalSplitView,
  delta: 1 | -1,
): TerminalSplitView {
  const leaves = paneLeaves(view.root);
  const index = Math.max(
    0,
    leaves.findIndex((pane) => pane.paneId === view.focusedPaneId),
  );
  const next = (index + delta + leaves.length) % leaves.length;
  return { ...view, focusedPaneId: leaves[next].paneId };
}

export function resizePaneSplit(
  view: TerminalSplitView,
  splitId: string,
  ratio: number,
): TerminalSplitView {
  const resize = (node: PaneNode): PaneNode =>
    node.type === "terminal"
      ? node
      : {
          ...node,
          ratio:
            node.paneId === splitId
              ? Math.min(0.8, Math.max(0.2, ratio))
              : node.ratio,
          first: resize(node.first),
          second: resize(node.second),
        };
  return { ...view, root: resize(view.root) };
}

export function calculatePaneLayout(root: PaneNode): {
  panes: PaneBounds[];
  splits: SplitBounds[];
} {
  const panes: PaneBounds[] = [];
  const splits: SplitBounds[] = [];
  const walk = (
    node: PaneNode,
    left: number,
    top: number,
    width: number,
    height: number,
  ) => {
    if (node.type === "terminal") {
      panes.push({ paneId: node.paneId, tabId: node.tabId, left, top, width, height });
      return;
    }
    splits.push({
      paneId: node.paneId,
      direction: node.direction,
      ratio: node.ratio,
      left,
      top,
      width,
      height,
    });
    if (node.direction === "horizontal") {
      walk(node.first, left, top, width * node.ratio, height);
      walk(
        node.second,
        left + width * node.ratio,
        top,
        width * (1 - node.ratio),
        height,
      );
    } else {
      walk(node.first, left, top, width, height * node.ratio);
      walk(
        node.second,
        left,
        top + height * node.ratio,
        width,
        height * (1 - node.ratio),
      );
    }
  };
  walk(root, 0, 0, 100, 100);
  return { panes, splits };
}

function toNodeDirection(
  direction: TerminalSplitDirection,
): "horizontal" | "vertical" {
  return direction === "side-by-side" ? "horizontal" : "vertical";
}
