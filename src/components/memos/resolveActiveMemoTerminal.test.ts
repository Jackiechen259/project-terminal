import { describe, expect, it } from "vitest";

import { createSplitView, terminalPane } from "@/lib/paneLayout";
import type { TerminalStoreState } from "@/stores/terminalStore";
import type { PaneNode, TerminalTab } from "@/types";

import {
  isMemoTerminalRunnable,
  resolveActiveTerminalForProject,
} from "./resolveActiveMemoTerminal";

function makeTab(
  id: string,
  projectId: string,
  overrides: Partial<TerminalTab> = {},
): TerminalTab {
  return {
    id,
    sessionId: `session-${id}`,
    projectId,
    profileId: "profile-1",
    defaultTitle: id,
    title: id,
    cwd: "",
    status: "running",
    createdAt: 1,
    lastActivatedAt: 1,
    ...overrides,
  };
}

function makeState(
  overrides: Partial<
    Pick<
      TerminalStoreState,
      | "activeProjectId"
      | "tabsById"
      | "tabGroupsByProjectId"
      | "splitViewsByProjectId"
    >
  > = {},
): TerminalStoreState {
  return {
    activeProjectId: null,
    tabsById: {},
    tabGroupsByProjectId: {},
    splitViewsByProjectId: {},
    setActiveProject: () => {},
    registerTab: () => {},
    removeTab: () => {},
    updateTab: () => {},
    setActiveTab: () => {},
    reorderTab: () => {},
    setSplitView: () => {},
    splitPane: () => {},
    replaceSplitTab: () => {},
    focusSplitPane: () => {},
    focusRelativePane: () => {},
    resizeSplit: () => {},
    clearSplitView: () => {},
    visibleTabs: () => [],
    activeTab: () => null,
    ensureGroup: () => ({ projectId: "", tabIds: [], activeTabId: null }),
    removeProjectTabs: () => {},
    clearAllTabs: () => {},
    ...overrides,
  };
}

const singleTabState = {
  tabsById: { t1: makeTab("t1", "p1") },
  tabGroupsByProjectId: {
    p1: { projectId: "p1", tabIds: ["t1"], activeTabId: "t1" },
  },
  splitViewsByProjectId: {},
};

describe("resolveActiveTerminalForProject", () => {
  it("returns the active tab when the project has one terminal", () => {
    const tab = resolveActiveTerminalForProject(
      makeState(singleTabState),
      "p1",
    );
    expect(tab?.id).toBe("t1");
  });

  it("returns the group's activeTabId when several tabs exist", () => {
    const state = makeState({
      tabsById: {
        t1: makeTab("t1", "p1"),
        t2: makeTab("t2", "p1"),
      },
      tabGroupsByProjectId: {
        p1: { projectId: "p1", tabIds: ["t1", "t2"], activeTabId: "t2" },
      },
      splitViewsByProjectId: {},
    });
    expect(resolveActiveTerminalForProject(state, "p1")?.id).toBe("t2");
  });

  it("prefers the focused pane of a split view over the active tab", () => {
    const view = createSplitView("t1", "t2", "side-by-side");
    const state = makeState({
      tabsById: {
        t1: makeTab("t1", "p1"),
        t2: makeTab("t2", "p1"),
      },
      tabGroupsByProjectId: {
        p1: { projectId: "p1", tabIds: ["t1", "t2"], activeTabId: "t1" },
      },
      splitViewsByProjectId: { p1: view },
    });
    // createSplitView focuses the second pane.
    expect(resolveActiveTerminalForProject(state, "p1")?.id).toBe("t2");
  });

  it("follows a changed focused pane", () => {
    const view = createSplitView("t1", "t2", "side-by-side");
    const firstPaneId = (view.root as Extract<PaneNode, { type: "split" }>)
      .first.paneId;
    const state = makeState({
      tabsById: {
        t1: makeTab("t1", "p1"),
        t2: makeTab("t2", "p1"),
      },
      tabGroupsByProjectId: {
        p1: { projectId: "p1", tabIds: ["t1", "t2"], activeTabId: "t1" },
      },
      splitViewsByProjectId: { p1: view },
    });
    // createSplitView focuses the second pane...
    expect(resolveActiveTerminalForProject(state, "p1")?.id).toBe("t2");
    // ...and re-focusing the first pane moves the command target with it.
    state.splitViewsByProjectId = {
      p1: { ...view, focusedPaneId: firstPaneId },
    };
    expect(resolveActiveTerminalForProject(state, "p1")?.id).toBe("t1");
  });

  it("returns null when the project has no tab group", () => {
    expect(resolveActiveTerminalForProject(makeState(), "missing")).toBeNull();
  });

  it("returns null when the active tab's project does not match", () => {
    const state = makeState({
      tabsById: { t1: makeTab("t1", "other-project") },
      tabGroupsByProjectId: {
        p1: { projectId: "p1", tabIds: ["t1"], activeTabId: "t1" },
      },
      splitViewsByProjectId: {},
    });
    // A tab from another project must never be a target, even if the group
    // references it (defensive: the store should never allow this).
    expect(resolveActiveTerminalForProject(state, "p1")).toBeNull();
  });

  it("returns the focused pane's terminal when panes belong to the project", () => {
    const first = terminalPane("tA");
    const view = {
      root: {
        type: "split" as const,
        paneId: "root",
        direction: "horizontal" as const,
        ratio: 0.5,
        first,
        second: terminalPane("tB"),
      },
      focusedPaneId: first.paneId,
    };
    const state = makeState({
      tabsById: {
        tA: makeTab("tA", "p1"),
        tB: makeTab("tB", "p1"),
      },
      tabGroupsByProjectId: {
        p1: { projectId: "p1", tabIds: ["tA", "tB"], activeTabId: "tB" },
      },
      splitViewsByProjectId: { p1: view },
    });
    expect(resolveActiveTerminalForProject(state, "p1")?.id).toBe("tA");
  });
});

describe("isMemoTerminalRunnable", () => {
  it("rejects a tab without a sessionId", () => {
    expect(
      isMemoTerminalRunnable(makeTab("t1", "p1", { sessionId: null })),
    ).toBe(false);
  });

  it("rejects an exited or errored tab", () => {
    expect(
      isMemoTerminalRunnable(makeTab("t1", "p1", { status: "exited" })),
    ).toBe(false);
    expect(
      isMemoTerminalRunnable(makeTab("t1", "p1", { status: "error" })),
    ).toBe(false);
    expect(
      isMemoTerminalRunnable(makeTab("t1", "p1", { status: "starting" })),
    ).toBe(false);
  });

  it("accepts a running tab with a session", () => {
    expect(isMemoTerminalRunnable(makeTab("t1", "p1"))).toBe(true);
  });

  it("rejects null", () => {
    expect(isMemoTerminalRunnable(null)).toBe(false);
    expect(isMemoTerminalRunnable(undefined)).toBe(false);
  });
});
