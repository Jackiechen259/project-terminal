import { describe, expect, it } from "vitest";

import {
  calculatePaneLayout,
  closePane,
  createSplitView,
  focusRelativePane,
  paneLeaves,
  replacePaneTab,
  resizePaneSplit,
  splitPane,
} from "@/lib/paneLayout";

describe("pane layout", () => {
  it("builds, resizes, focuses and collapses a recursive layout", () => {
    let view = createSplitView("one", "two", "side-by-side");
    const second = paneLeaves(view.root)[1];
    view = splitPane(view, second.paneId, "three", "stacked");
    expect(paneLeaves(view.root).map((pane) => pane.tabId)).toEqual([
      "one",
      "two",
      "three",
    ]);

    const rootId = view.root.paneId;
    view = resizePaneSplit(view, rootId, 0.7);
    expect(view.root.type === "split" && view.root.ratio).toBe(0.7);

    const before = view.focusedPaneId;
    view = focusRelativePane(view, -1);
    expect(view.focusedPaneId).not.toBe(before);

    const three = paneLeaves(view.root).find((pane) => pane.tabId === "three")!;
    view = closePane(view, three.paneId)!;
    expect(paneLeaves(view.root)).toHaveLength(2);
  });

  it("moves a session by swapping an already visible tab", () => {
    let view = createSplitView("one", "two", "side-by-side");
    const first = paneLeaves(view.root)[0];
    view = replacePaneTab(view, first.paneId, "two");
    expect(paneLeaves(view.root).map((pane) => pane.tabId)).toEqual([
      "two",
      "one",
    ]);
  });

  it("limits layouts to four panes and calculates non-overlapping bounds", () => {
    let view = createSplitView("one", "two", "side-by-side");
    for (const tabId of ["three", "four", "five"]) {
      view = splitPane(view, view.focusedPaneId, tabId, "stacked");
    }
    expect(paneLeaves(view.root)).toHaveLength(4);
    const layout = calculatePaneLayout(view.root);
    expect(layout.panes).toHaveLength(4);
    expect(layout.splits).toHaveLength(3);
  });
});
