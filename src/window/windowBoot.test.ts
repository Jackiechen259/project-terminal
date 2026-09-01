/**
 * Boot-step tests: workspace identity resolution, hydration, live-session
 * reconciliation, and the bounded-fallback behaviour that keeps a stuck IPC
 * or a corrupt persisted layout from leaving the startup shell on screen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionInfo } from "@/services";
import { useCollectionStore } from "@/stores/collectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  getCurrentWorkspaceId,
  getTerminalWorkspaceStore,
  resetWorkspaceStoreCacheForTests,
  TERMINAL_WORKSPACE_STORAGE_KEY,
  workspaceStorageKey,
} from "@/stores/terminalStore";
import type { TerminalTab } from "@/types";
import { windowService, type WorkspaceInfo } from "./windowService";

vi.mock("@/services", () => ({
  terminalService: {
    listWorkspaceSessions: vi.fn(),
  },
  persistenceService: {
    loadWorkspaceState: vi.fn(),
  },
}));

vi.mock("./windowService", () => ({
  windowService: {
    workspaceInfo: vi.fn(),
  },
}));

vi.mock("@/lib/runtime", () => ({
  isTauriRuntime: vi.fn(() => false),
}));

vi.mock("./persistenceBridge", () => ({
  migrateLocalPersistence: vi.fn(() => Promise.resolve(null)),
}));

import { persistenceService, terminalService } from "@/services";
import { isTauriRuntime } from "@/lib/runtime";
import { migrateLegacyWorkspaceLayout, prepareWorkspace } from "./windowBoot";
import { migrateLocalPersistence } from "./persistenceBridge";

const WORKSPACE_KEY = "project-terminal.workspace-layout.v2";

function workspaceInfo(overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return {
    windowLabel: "ws-test",
    workspaceId: "ws-test",
    projectId: null,
    migratedFromWorkspaceId: null,
    ...overrides,
  };
}

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
  vi.mocked(persistenceService.loadWorkspaceState).mockReset();
  vi.mocked(migrateLocalPersistence)
    .mockReset()
    .mockResolvedValue(null);
  // Matches every other test file's assumption: JSDOM is not the Tauri
  // WebView. Tests below that need the Tauri branch opt in explicitly.
  vi.mocked(isTauriRuntime).mockReset().mockReturnValue(false);
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
    vi.mocked(windowService.workspaceInfo).mockResolvedValue(
      workspaceInfo({
        windowLabel: "ws-test",
        workspaceId: "ws-test",
      }),
    );
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
    vi.mocked(windowService.workspaceInfo).mockResolvedValue(
      workspaceInfo({
        windowLabel: "ws-test",
        workspaceId: "ws-test",
      }),
    );
    vi.mocked(terminalService.listWorkspaceSessions).mockResolvedValue([]);

    const info = await prepareWorkspace();
    expect(info.workspaceId).toBe("ws-test");
    expect(getTerminalWorkspaceStore("ws-test").getState().tabsById).toEqual(
      {},
    );
  });

  it("continues UI startup when the live-session reconcile fails", async () => {
    vi.mocked(windowService.workspaceInfo).mockResolvedValue(
      workspaceInfo({
        windowLabel: "ws-test",
        workspaceId: "ws-test",
      }),
    );
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

  it("keeps two workspaces' boot state independent", async () => {
    vi.mocked(windowService.workspaceInfo).mockResolvedValueOnce(
      workspaceInfo({
        windowLabel: "ws-a",
        workspaceId: "ws-a",
      }),
    );
    vi.mocked(windowService.workspaceInfo).mockResolvedValueOnce(
      workspaceInfo({
        windowLabel: "ws-b",
        workspaceId: "ws-b",
      }),
    );
    vi.mocked(terminalService.listWorkspaceSessions).mockResolvedValue([]);

    await prepareWorkspace();
    expect(getCurrentWorkspaceId()).toBe("ws-a");
    await prepareWorkspace();
    expect(getCurrentWorkspaceId()).toBe("ws-b");

    // Each workspace has its own store instance keyed by its id.
    expect(getTerminalWorkspaceStore("ws-a")).not.toBe(
      getTerminalWorkspaceStore("ws-b"),
    );
  });

  describe("in the Tauri runtime", () => {
    it("loads settings, collections, and this workspace's layout in parallel", async () => {
      vi.mocked(isTauriRuntime).mockReturnValue(true);
      vi.mocked(windowService.workspaceInfo).mockResolvedValue(
        workspaceInfo({ windowLabel: "ws-test", workspaceId: "ws-test" }),
      );
      vi.mocked(terminalService.listWorkspaceSessions).mockResolvedValue([]);
      const tabId = "tab-1";
      vi.mocked(persistenceService.loadWorkspaceState).mockResolvedValue({
        version: 1,
        state: {
          activeProjectId: "p1",
          tabsById: { [tabId]: makeTab(tabId, "p1", null) },
          tabGroupsByProjectId: {
            p1: { projectId: "p1", tabIds: [tabId], activeTabId: tabId },
          },
          splitViewsByProjectId: {},
          sidebarCollapsed: false,
          rightSidebarCollapsed: false,
          rightSidebarMode: "files",
        },
      });
      const settingsHydrate = vi
        .spyOn(useSettingsStore.getState(), "hydrateFromBackend")
        .mockResolvedValue(undefined);
      const collectionsHydrate = vi
        .spyOn(useCollectionStore.getState(), "hydrateFromBackend")
        .mockResolvedValue(undefined);

      const info = await prepareWorkspace();

      expect(info.workspaceId).toBe("ws-test");
      expect(migrateLocalPersistence).toHaveBeenCalled();
      expect(settingsHydrate).toHaveBeenCalled();
      expect(collectionsHydrate).toHaveBeenCalled();
      // The backend-persisted layout for this workspace was applied, the
      // same way a locally-persisted (non-Tauri) layout would be.
      expect(
        getTerminalWorkspaceStore("ws-test").getState().tabsById[tabId],
      ).toMatchObject({ projectId: "p1" });
    });

    it("starts with an empty layout when the backend has none, without treating that as an error", async () => {
      vi.mocked(isTauriRuntime).mockReturnValue(true);
      vi.mocked(windowService.workspaceInfo).mockResolvedValue(
        workspaceInfo({ windowLabel: "ws-test", workspaceId: "ws-test" }),
      );
      vi.mocked(terminalService.listWorkspaceSessions).mockResolvedValue([]);
      vi.mocked(persistenceService.loadWorkspaceState).mockResolvedValue(null);
      vi.spyOn(
        useSettingsStore.getState(),
        "hydrateFromBackend",
      ).mockResolvedValue(undefined);
      vi.spyOn(
        useCollectionStore.getState(),
        "hydrateFromBackend",
      ).mockResolvedValue(undefined);

      const info = await prepareWorkspace();

      expect(info.workspaceId).toBe("ws-test");
      expect(getTerminalWorkspaceStore("ws-test").getState().tabsById).toEqual(
        {},
      );
    });

    it("starts with a clean layout and logs when the workspace-state load fails, without losing settings/collections hydration", async () => {
      vi.mocked(isTauriRuntime).mockReturnValue(true);
      vi.mocked(windowService.workspaceInfo).mockResolvedValue(
        workspaceInfo({ windowLabel: "ws-test", workspaceId: "ws-test" }),
      );
      vi.mocked(terminalService.listWorkspaceSessions).mockResolvedValue([]);
      vi.mocked(persistenceService.loadWorkspaceState).mockRejectedValue(
        new Error("sqlite unavailable"),
      );
      const settingsHydrate = vi
        .spyOn(useSettingsStore.getState(), "hydrateFromBackend")
        .mockResolvedValue(undefined);
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const info = await prepareWorkspace();

      expect(info.workspaceId).toBe("ws-test");
      // Promise.allSettled means one rejected entry never stops the other
      // independent loads from completing.
      expect(settingsHydrate).toHaveBeenCalled();
      expect(getTerminalWorkspaceStore("ws-test").getState().tabsById).toEqual(
        {},
      );
      expect(consoleError).toHaveBeenCalledWith(
        "Workspace layout hydration failed; starting with a clean layout",
        expect.any(Error),
      );
    });
  });
});

describe("migrateLegacyWorkspaceLayout", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("copies the migrated workspace's layout into the main key once", () => {
    const legacy = JSON.stringify({
      version: 1,
      state: { tabsById: { t: 1 } },
    });
    localStorage.setItem(workspaceStorageKey("workspace-old-a"), legacy);

    migrateLegacyWorkspaceLayout(
      workspaceInfo({
        windowLabel: "main",
        workspaceId: "main",
        migratedFromWorkspaceId: "workspace-old-a",
      }),
    );

    expect(localStorage.getItem(workspaceStorageKey("main"))).toBe(legacy);
    // One-time: the source key is removed so a later launch cannot re-copy
    // stale data over a newer main layout.
    expect(localStorage.getItem(workspaceStorageKey("workspace-old-a"))).toBe(
      null,
    );
  });

  it("keeps an existing main layout and never overwrites it", () => {
    const own = JSON.stringify({ version: 1, state: { tabsById: { x: 1 } } });
    localStorage.setItem(workspaceStorageKey("main"), own);
    localStorage.setItem(
      workspaceStorageKey("workspace-old-a"),
      JSON.stringify({ version: 1, state: { tabsById: { y: 1 } } }),
    );

    migrateLegacyWorkspaceLayout(
      workspaceInfo({
        windowLabel: "main",
        workspaceId: "main",
        migratedFromWorkspaceId: "workspace-old-a",
      }),
    );

    expect(localStorage.getItem(workspaceStorageKey("main"))).toBe(own);
    expect(
      localStorage.getItem(workspaceStorageKey("workspace-old-a")),
    ).not.toBe(null);
  });

  it("keeps the legacy v1 layout when present (it wins over any v2 workspace)", () => {
    const v1 = JSON.stringify({ version: 1, state: { tabsById: { v: 1 } } });
    localStorage.setItem(TERMINAL_WORKSPACE_STORAGE_KEY, v1);
    localStorage.setItem(
      workspaceStorageKey("workspace-old-a"),
      JSON.stringify({ version: 1, state: { tabsById: { y: 1 } } }),
    );

    migrateLegacyWorkspaceLayout(
      workspaceInfo({
        windowLabel: "main",
        workspaceId: "main",
        migratedFromWorkspaceId: "workspace-old-a",
      }),
    );

    expect(localStorage.getItem(workspaceStorageKey("main"))).toBe(null);
    expect(localStorage.getItem(TERMINAL_WORKSPACE_STORAGE_KEY)).toBe(v1);
  });

  it("does nothing without a migrated workspace", () => {
    migrateLegacyWorkspaceLayout(workspaceInfo());
    expect(localStorage.length).toBe(0);
  });

  it("does nothing for a non-main workspace or a main-to-main migration", () => {
    const legacy = JSON.stringify({
      version: 1,
      state: { tabsById: { t: 1 } },
    });
    localStorage.setItem(workspaceStorageKey("workspace-old-a"), legacy);

    // Non-main workspace: migration never applies.
    migrateLegacyWorkspaceLayout(
      workspaceInfo({
        workspaceId: "ws-other",
        migratedFromWorkspaceId: "workspace-old-a",
      }),
    );
    expect(localStorage.getItem(workspaceStorageKey("main"))).toBe(null);

    // Backend migrated from a main record: nothing to copy.
    migrateLegacyWorkspaceLayout(
      workspaceInfo({
        windowLabel: "main",
        workspaceId: "main",
        migratedFromWorkspaceId: "main",
      }),
    );
    expect(localStorage.getItem(workspaceStorageKey("main"))).toBe(null);
  });

  it("only copies keys that actually exist", () => {
    migrateLegacyWorkspaceLayout(
      workspaceInfo({
        windowLabel: "main",
        workspaceId: "main",
        migratedFromWorkspaceId: "workspace-ghost",
      }),
    );
    expect(localStorage.length).toBe(0);
  });
});
