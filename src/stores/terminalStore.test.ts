import { describe, expect, it, beforeEach } from "vitest";

import { useTerminalStore } from "@/stores/terminalStore";
import type { TerminalTab } from "@/types";

function makeTab(id: string, projectId: string, title = id): TerminalTab {
  return {
    id,
    sessionId: `session-${id}`,
    projectId,
    profileId: `profile-${projectId}`,
    defaultTitle: title,
    title,
    cwd: "/",
    status: "running",
    createdAt: 0,
    lastActivatedAt: 0,
  };
}

beforeEach(() => {
  useTerminalStore.setState({
    activeProjectId: null,
    tabsById: {},
    tabGroupsByProjectId: {},
    splitViewsByProjectId: {},
  });
});

describe("terminalStore", () => {
  describe("tab groups", () => {
    it("creates a tab group when registering the first tab", () => {
      const { registerTab } = useTerminalStore.getState();
      registerTab(makeTab("t1", "p1"));
      const group = useTerminalStore.getState().tabGroupsByProjectId["p1"];
      expect(group).toBeDefined();
      expect(group.tabIds).toEqual(["t1"]);
      expect(group.activeTabId).toBe("t1");
    });

    it("appends subsequent tabs to the same group and activates the new one", () => {
      const { registerTab } = useTerminalStore.getState();
      registerTab(makeTab("t1", "p1"));
      registerTab(makeTab("t2", "p1"));
      const group = useTerminalStore.getState().tabGroupsByProjectId["p1"];
      expect(group.tabIds).toEqual(["t1", "t2"]);
      expect(group.activeTabId).toBe("t2");
    });
  });

  describe("project switching", () => {
    it("only changes activeProjectId - no tab teardown", () => {
      const { registerTab, setActiveProject, setActiveTab } =
        useTerminalStore.getState();
      registerTab(makeTab("t1", "p1"));
      registerTab(makeTab("t2", "p1"));
      registerTab(makeTab("t3", "p2"));
      setActiveTab("p1", "t1");

      // Switch to p2 - p1's tabs must remain.
      setActiveProject("p2");
      const tabsAfter = useTerminalStore.getState().tabsById;
      expect(Object.keys(tabsAfter).sort()).toEqual(["t1", "t2", "t3"]);

      // Switch back to p1 - active tab is restored.
      setActiveProject("p1");
      expect(
        useTerminalStore.getState().tabGroupsByProjectId["p1"].activeTabId,
      ).toBe("t1");
    });

    it("visibleTabs returns only the active project's tabs", () => {
      const { registerTab, setActiveProject } = useTerminalStore.getState();
      registerTab(makeTab("t1", "p1"));
      registerTab(makeTab("t2", "p1"));
      registerTab(makeTab("t3", "p2"));
      setActiveProject("p1");
      expect(
        useTerminalStore
          .getState()
          .visibleTabs()
          .map((t) => t.id),
      ).toEqual(["t1", "t2"]);
      setActiveProject("p2");
      expect(
        useTerminalStore
          .getState()
          .visibleTabs()
          .map((t) => t.id),
      ).toEqual(["t3"]);
    });

    it("different projects' tabs are isolated", () => {
      const { registerTab, setActiveProject } = useTerminalStore.getState();
      registerTab(makeTab("p1t1", "p1"));
      registerTab(makeTab("p1t2", "p1"));
      registerTab(makeTab("p2t1", "p2"));
      registerTab(makeTab("p2t2", "p2"));
      registerTab(makeTab("p2t3", "p2"));
      setActiveProject("p1");
      expect(useTerminalStore.getState().visibleTabs()).toHaveLength(2);
      setActiveProject("p2");
      expect(useTerminalStore.getState().visibleTabs()).toHaveLength(3);
    });
  });

  describe("close", () => {
    it("removes a tab and activates the right neighbor, else left", () => {
      const { registerTab, removeTab, setActiveTab } =
        useTerminalStore.getState();
      registerTab(makeTab("t1", "p1"));
      registerTab(makeTab("t2", "p1"));
      registerTab(makeTab("t3", "p1"));
      // Activate middle tab then remove it - should fall to right (t3).
      setActiveTab("p1", "t2");
      removeTab("t2");
      const group = useTerminalStore.getState().tabGroupsByProjectId["p1"];
      expect(group.tabIds).toEqual(["t1", "t3"]);
      expect(group.activeTabId).toBe("t3");
      // Remove rightmost - falls to left (t1).
      removeTab("t3");
      expect(
        useTerminalStore.getState().tabGroupsByProjectId["p1"].activeTabId,
      ).toBe("t1");
    });

    it("does not affect other projects when removing a tab", () => {
      const { registerTab, removeTab } = useTerminalStore.getState();
      registerTab(makeTab("t1", "p1"));
      registerTab(makeTab("t2", "p2"));
      removeTab("t1");
      expect(useTerminalStore.getState().tabsById["t2"]).toBeDefined();
      expect(
        useTerminalStore.getState().tabGroupsByProjectId["p2"].tabIds,
      ).toEqual(["t2"]);
    });
  });

  describe("updateTab", () => {
    it("patches the tab fields", () => {
      const { registerTab, updateTab } = useTerminalStore.getState();
      registerTab(makeTab("t1", "p1"));
      updateTab("t1", { status: "exited", exitCode: 0 });
      const tab = useTerminalStore.getState().tabsById["t1"];
      expect(tab.status).toBe("exited");
      expect(tab.exitCode).toBe(0);
    });
  });

  it("reorders a tab before or after another tab", () => {
    const { registerTab, reorderTab } = useTerminalStore.getState();
    registerTab(makeTab("t1", "p1"));
    registerTab(makeTab("t2", "p1"));
    registerTab(makeTab("t3", "p1"));
    reorderTab("p1", "t3", "t1", "before");
    reorderTab("p1", "t1", "t2", "after");

    expect(useTerminalStore.getState().tabGroupsByProjectId.p1.tabIds).toEqual([
      "t3",
      "t2",
      "t1",
    ]);
  });

  describe("split views", () => {
    it("keeps two selected tabs in a project-specific split view", () => {
      const { registerTab, setSplitView, replaceSplitTab } =
        useTerminalStore.getState();
      registerTab(makeTab("t1", "p1"));
      registerTab(makeTab("t2", "p1"));
      registerTab(makeTab("t3", "p1"));
      setSplitView("p1", ["t1", "t2"], "side-by-side");
      replaceSplitTab("p1", 1, "t3");

      expect(useTerminalStore.getState().splitViewsByProjectId.p1).toEqual({
        direction: "side-by-side",
        tabIds: ["t1", "t3"],
      });
    });

    it("collapses a split when one of its terminals is closed", () => {
      const { registerTab, setSplitView, removeTab } =
        useTerminalStore.getState();
      registerTab(makeTab("t1", "p1"));
      registerTab(makeTab("t2", "p1"));
      setSplitView("p1", ["t1", "t2"], "stacked");
      removeTab("t1");

      expect(
        useTerminalStore.getState().splitViewsByProjectId.p1,
      ).toBeUndefined();
      expect(
        useTerminalStore.getState().tabGroupsByProjectId.p1.activeTabId,
      ).toBe("t2");
    });
  });

  it("cleans up all tabs when a project is deleted", () => {
    const { registerTab, removeProjectTabs, setActiveProject } =
      useTerminalStore.getState();
    registerTab(makeTab("p1t1", "p1"));
    registerTab(makeTab("p1t2", "p1"));
    registerTab(makeTab("p2t1", "p2"));
    setActiveProject("p1");
    removeProjectTabs("p1");
    expect(useTerminalStore.getState().tabsById.p1t1).toBeUndefined();
    expect(useTerminalStore.getState().tabsById.p2t1).toBeDefined();
    expect(useTerminalStore.getState().tabGroupsByProjectId.p1).toBeUndefined();
    expect(useTerminalStore.getState().activeProjectId).toBeNull();
  });
});
