/**
 * Boot-step tests: workspace identity resolution, hydration, live-session
 * reconciliation, and the bounded-fallback behaviour that keeps a stuck IPC
 * or a corrupt persisted layout from leaving the startup shell on screen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionInfo } from "@/services";
import {
  getCurrentWorkspaceId,
  getTerminalWorkspaceStore,
  resetWorkspaceStoreCacheForTests,
} from "@/stores/terminalStore";
import type { TerminalTab } from "@/types";
import { windowService } from "./windowService";

vi.mock("@/services", () => ({
  terminalService: {
    listWorkspaceSessions: vi.fn(),
  },
}));

vi.mock("./windowService", () => ({
  windowService: {
    workspaceInfo: vi.fn(),
  },
}));

import { terminalService } from "@/services";
import { prepareWorkspace } from "./windowBoot";

const WORKSPACE_KEY = "project-terminal.workspace-layout.v2";

function makeTab(
  id: string,
  projectId: string,
  sessionId: string | null,
): TerminalTab {
  return {
    id,
    sessionId,
    projectId,
    profileId: `profile-${projectId}`,
    defaultTitle: id,
    title: id,
    cwd: "/",
    status: "running",
    createdAt: 0,
    lastActivatedAt: 0,
  };
}

function runningSession(id: string): SessionInfo {
  return {
    sessionId: id,
    projectId: "p1",
    profileId: "profile-p1",
    status: "running",
    exitCode: undefined,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  localStorage.clear();
  resetWorkspaceStoreCacheForTests();
  vi.mocked(windowService.workspaceInfo).mockReset();
  vi.mocked(terminalService.listWorkspaceSessions).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("prepareWorkspace", () => {
  it("selects the workspace, hydrates its layout and reconciles live sessions", async () => {
    // Persisted layout for workspace "ws-test": one tab whose session is
    // still alive on the backend ("keep running" across a window close).
    const tabId = "tab-1";
    localStorage.setItem(
      `${WORKSPACE_KEY}:ws-test`,
      JSON.stringify({
        version: 1,
        state: {
          activeProjectId: "p1",
          tabsById: { [tabId]: makeTab(tabId, "p1", "session-live") },
          tabGroupsByProjectId: {
            p1: { projectId: "p1", tabIds: [tabId], activeTabId: tabId },
          },
          splitViewsByProjectId: {},
          sidebarCollapsed: false,
          rightSidebarCollapsed: false,
          rightSidebarMode: "files",
        },
      }),
    );
    vi.mocked(windowService.workspaceInfo).mockResolvedValue({
      windowLabel: "ws-test",
      workspaceId: "ws-test",
      projectId: null,
    });
    vi.mocked(terminalService.listWorkspaceSessions).mockResolvedValue([
      runningSession("session-live"),
      runningSession("session-other"),
    ]);

    const info = await prepareWorkspace();

    expect(info.workspaceId).toBe("ws-test");
    expect(getCurrentWorkspaceId()).toBe("ws-test");

    // The persisted tab was hydrated with its session parked, and the
    // reconcile reattached it to the live backend session.
    const store = getTerminalWorkspaceStore("ws-test");
    expect(store.getState().tabsById[tabId]).toMatchObject({
      sessionId: "session-live",
      status: "running",
    });
    // A session owned by another workspace is never attached.
    expect(store.getState().savedSessionIdsByTabId[tabId]).toBe("session-live");
  });

  it("rejects when workspace identity resolution fails, so the caller can fall back", async () => {
    vi.mocked(windowService.workspaceInfo).mockRejectedValue(
      new Error("ipc down"),
    );
    await expect(prepareWorkspace()).rejects.toThrow("ipc down");
  });

  it("bounds workspace identity resolution instead of waiting forever", async () => {
    vi.mocked(windowService.workspaceInfo).mockImplementation(
      () => new Promise(() => {}), // never settles
    );
    await expect(prepareWorkspace(20)).rejects.toThrow(/timed out after 20ms/);
  });

  it("survives a corrupt persisted layout and starts with a clean store", async () => {
    localStorage.setItem(`${WORKSPACE_KEY}:ws-test`, "{ not valid json !!");
    vi.mocked(windowService.workspaceInfo).mockResolvedValue({
      windowLabel: "ws-test",
      workspaceId: "ws-test",
      projectId: null,
    });
    vi.mocked(terminalService.listWorkspaceSessions).mockResolvedValue([]);

    const info = await prepareWorkspace();
    expect(info.workspaceId).toBe("ws-test");
    expect(getTerminalWorkspaceStore("ws-test").getState().tabsById).toEqual(
      {},
    );
  });

  it("continues UI startup when the live-session reconcile fails", async () => {
    vi.mocked(windowService.workspaceInfo).mockResolvedValue({
      windowLabel: "ws-test",
      workspaceId: "ws-test",
      projectId: null,
    });
    vi.mocked(terminalService.listWorkspaceSessions).mockRejectedValue(
      new Error("backend unreachable"),
    );

    const info = await prepareWorkspace();
    expect(info.workspaceId).toBe("ws-test");
    // The store still hydrated (empty) and the boot resolved.
    expect(
      getTerminalWorkspaceStore("ws-test").getState().savedSessionIdsByTabId,
    ).toEqual({});
  });

  it("keeps two windows' boot state independent", async () => {
    vi.mocked(windowService.workspaceInfo).mockResolvedValueOnce({
      windowLabel: "ws-a",
      workspaceId: "ws-a",
      projectId: null,
    });
    vi.mocked(windowService.workspaceInfo).mockResolvedValueOnce({
      windowLabel: "ws-b",
      workspaceId: "ws-b",
      projectId: null,
    });
    vi.mocked(terminalService.listWorkspaceSessions).mockResolvedValue([]);

    await prepareWorkspace();
    expect(getCurrentWorkspaceId()).toBe("ws-a");
    await prepareWorkspace();
    expect(getCurrentWorkspaceId()).toBe("ws-b");

    // Each WebView has its own store instance keyed by its workspace.
    expect(getTerminalWorkspaceStore("ws-a")).not.toBe(
      getTerminalWorkspaceStore("ws-b"),
    );
  });
});
