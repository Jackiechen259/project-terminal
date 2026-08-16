import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getTerminalWorkspaceStore,
  LEGACY_WORKSPACE_ID,
  resetWorkspaceStoreCacheForTests,
  TERMINAL_WORKSPACE_STORAGE_KEY,
  workspaceStorageKey,
} from "@/stores/terminalStore";
import { paneLeaves } from "@/lib/paneLayout";
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
  localStorage.clear();
  resetWorkspaceStoreCacheForTests();
});

afterEach(() => {
  localStorage.clear();
  resetWorkspaceStoreCacheForTests();
});

describe("per-workspace stores (the single main window is one of them)", () => {
  it("keeps two workspaces' tabs and active projects fully independent", () => {
    const windowA = getTerminalWorkspaceStore("ws-a");
    const windowB = getTerminalWorkspaceStore("ws-b");

    windowA.getState().registerTab(makeTab("a-t1", "p1"));
    windowB.getState().registerTab(makeTab("b-t1", "p1"));
    windowB.getState().setActiveProject("p1");

    expect(windowA.getState().activeProjectId).toBe("p1");
    expect(windowB.getState().activeProjectId).toBe("p1");
    expect(Object.keys(windowA.getState().tabsById)).toEqual(["a-t1"]);
    expect(Object.keys(windowB.getState().tabsById)).toEqual(["b-t1"]);

    // Closing a tab in A must not touch B.
    windowA.getState().removeTab("a-t1");
    expect(windowB.getState().tabsById["b-t1"]).toBeDefined();
  });

  it("keeps independent active tabs for the same project", () => {
    const windowA = getTerminalWorkspaceStore("ws-a");
    const windowB = getTerminalWorkspaceStore("ws-b");

    windowA.getState().registerTab(makeTab("a-1", "p1"));
    windowA.getState().registerTab(makeTab("a-2", "p1"));
    windowB.getState().registerTab(makeTab("b-1", "p1"));

    windowA.getState().setActiveTab("p1", "a-1");
    expect(windowA.getState().tabGroupsByProjectId.p1.activeTabId).toBe("a-1");
    expect(windowB.getState().tabGroupsByProjectId.p1.activeTabId).toBe("b-1");
  });

  it("keeps split layouts independent per workspace", () => {
    const windowA = getTerminalWorkspaceStore("ws-a");
    const windowB = getTerminalWorkspaceStore("ws-b");

    windowA.getState().registerTab(makeTab("a-1", "p1"));
    windowA.getState().registerTab(makeTab("a-2", "p1"));
    windowB.getState().registerTab(makeTab("b-1", "p1"));
    windowB.getState().registerTab(makeTab("b-2", "p1"));

    windowA.getState().setSplitView("p1", ["a-1", "a-2"], "side-by-side");
    expect(windowA.getState().splitViewsByProjectId.p1).toBeDefined();
    expect(windowB.getState().splitViewsByProjectId.p1).toBeUndefined();

    windowB.getState().setSplitView("p1", ["b-1", "b-2"], "stacked");
    const aPanes = paneLeaves(
      windowA.getState().splitViewsByProjectId.p1.root,
    ).map((pane) => pane.tabId);
    const bPanes = paneLeaves(
      windowB.getState().splitViewsByProjectId.p1.root,
    ).map((pane) => pane.tabId);
    expect(aPanes).toEqual(["a-1", "a-2"]);
    expect(bPanes).toEqual(["b-1", "b-2"]);
  });

  it("running-terminal counts are scoped to the workspace (close dialog)", () => {
    const windowA = getTerminalWorkspaceStore("ws-a");
    const windowB = getTerminalWorkspaceStore("ws-b");

    const countRunning = (
      store: ReturnType<typeof getTerminalWorkspaceStore>,
    ) =>
      Object.values(store.getState().tabsById).filter(
        (tab) => tab.status !== "exited" && tab.status !== "error",
      ).length;

    windowA.getState().registerTab(makeTab("a-1", "p1"));
    windowB.getState().registerTab(makeTab("b-1", "p1"));
    windowA.getState().updateTab("a-1", { status: "exited" });

    expect(countRunning(windowA)).toBe(0);
    expect(countRunning(windowB)).toBe(1);
  });

  it("persists each workspace under its own storage key", async () => {
    const windowA = getTerminalWorkspaceStore("ws-a");
    const windowB = getTerminalWorkspaceStore("ws-b");
    windowA.getState().registerTab(makeTab("a-1", "p1"));
    windowB.getState().registerTab(makeTab("b-1", "p2"));
    // The throttled storage flushes on pagehide.
    window.dispatchEvent(new Event("pagehide"));

    const rawA = localStorage.getItem(workspaceStorageKey("ws-a"));
    const rawB = localStorage.getItem(workspaceStorageKey("ws-b"));
    expect(rawA).toBeTruthy();
    expect(rawB).toBeTruthy();
    expect(rawA).not.toBe(rawB);

    // A fresh store rehydrates only its own key.
    resetWorkspaceStoreCacheForTests();
    const restoredA = getTerminalWorkspaceStore("ws-a");
    await restoredA.persist.rehydrate();
    expect(Object.keys(restoredA.getState().tabsById)).toEqual(["a-1"]);
    expect(restoredA.getState().tabsById["a-1"].projectId).toBe("p1");
  });

  it("migrates the legacy v1 layout into the first (main) workspace", async () => {
    localStorage.setItem(
      TERMINAL_WORKSPACE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: {
          activeProjectId: "p1",
          tabsById: { legacy: makeTab("legacy", "p1") },
          tabGroupsByProjectId: {
            p1: { projectId: "p1", tabIds: ["legacy"], activeTabId: "legacy" },
          },
          splitViewsByProjectId: {},
        },
      }),
    );

    const main = getTerminalWorkspaceStore(LEGACY_WORKSPACE_ID);
    await main.persist.rehydrate();
    expect(main.getState().activeProjectId).toBe("p1");
    expect(main.getState().tabsById.legacy).toBeDefined();

    // Writes must go to the v2 key, not the v1 key.
    main.getState().setActiveProject("p2");
    window.dispatchEvent(new Event("pagehide"));
    const written = JSON.parse(
      localStorage.getItem(workspaceStorageKey(LEGACY_WORKSPACE_ID)) ?? "null",
    );
    expect(written?.state?.activeProjectId).toBe("p2");
  });
});

describe("workspace session reconcile (keep-running reopen)", () => {
  it("revives tabs whose sessions are still live and drops stale ids", async () => {
    const workspaceId = "ws-reattach";
    // A main-window layout persisted with "keep terminals running": the persisted layout
    // still carries the session ids.
    localStorage.setItem(
      workspaceStorageKey(workspaceId),
      JSON.stringify({
        version: 1,
        state: {
          activeProjectId: "p1",
          tabsById: {
            live: makeTab("live", "p1"),
            stale: makeTab("stale", "p1"),
          },
          tabGroupsByProjectId: {
            p1: {
              projectId: "p1",
              tabIds: ["live", "stale"],
              activeTabId: "live",
            },
          },
          splitViewsByProjectId: {},
        },
      }),
    );

    const store = getTerminalWorkspaceStore(workspaceId);
    await store.persist.rehydrate();

    // After rehydration nothing is trusted: both tabs are exited and the
    // persisted session ids are parked for reconciliation.
    expect(store.getState().tabsById.live.sessionId).toBeNull();
    expect(store.getState().tabsById.live.status).toBe("exited");
    expect(store.getState().savedSessionIdsByTabId).toEqual({
      live: "session-live",
      stale: "session-stale",
    });

    // The backend reports that `session-live` is still running.
    store.getState().reconcileWorkspaceSessions([
      {
        sessionId: "session-live",
        projectId: "p1",
        profileId: "profile-p1",
        status: "running",
        createdAt: "2026-08-06T00:00:00Z",
      },
    ]);

    expect(store.getState().tabsById.live.sessionId).toBe("session-live");
    expect(store.getState().tabsById.live.status).toBe("running");
    // The stale tab stays exited with no session.
    expect(store.getState().tabsById.stale.sessionId).toBeNull();
    expect(store.getState().tabsById.stale.status).toBe("exited");
    expect(store.getState().savedSessionIdsByTabId).toEqual({
      live: "session-live",
    });
  });
});
