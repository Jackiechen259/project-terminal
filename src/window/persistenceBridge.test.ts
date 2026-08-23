import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services", () => ({
  persistenceService: {
    migrateFrontendPersistence: vi.fn(),
  },
}));

import { persistenceService } from "@/services";
import {
  COLLECTIONS_STORAGE_KEY,
  GENERAL_SETTINGS_STORAGE_KEY,
  LEGACY_WORKSPACE_STORAGE_KEY,
  MEMOS_STORAGE_KEY,
  migrateLocalPersistence,
} from "./persistenceBridge";

const workspaceKey = (id: string) =>
  `project-terminal.workspace-layout.v2:${id}`;

beforeEach(() => {
  localStorage.clear();
  vi.mocked(persistenceService.migrateFrontendPersistence).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("migrateLocalPersistence", () => {
  it("imports valid Zustand snapshots and removes only successful sources", async () => {
    localStorage.setItem(
      GENERAL_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        state: { theme: "light", lastProjectId: "p1" },
      }),
    );
    localStorage.setItem(
      COLLECTIONS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: {
          collections: [
            {
              id: "col-1",
              name: "Work",
              projectIds: ["p1"],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          collapsed: { "col-1": false },
          ungroupedProjectIds: ["p2"],
        },
      }),
    );
    localStorage.setItem(
      MEMOS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: {
          memosByProjectId: {
            p1: [
              {
                id: "memo-1",
                projectId: "p1",
                kind: "markdown",
                title: "Note",
                content: "hello",
                createdAt: 1,
                updatedAt: 2,
              },
            ],
          },
        },
      }),
    );
    localStorage.setItem(
      LEGACY_WORKSPACE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: { activeProjectId: "p1", tabsById: {} },
      }),
    );
    localStorage.setItem(
      workspaceKey("secondary"),
      JSON.stringify({ version: 1, state: { activeProjectId: "p2" } }),
    );

    vi.mocked(persistenceService.migrateFrontendPersistence).mockResolvedValue({
      generalSettings: true,
      collections: true,
      projectMemos: true,
      workspaces: ["main", "secondary"],
    });

    await expect(migrateLocalPersistence()).resolves.toMatchObject({
      generalSettings: true,
      collections: true,
    });
    const [payload] = vi.mocked(persistenceService.migrateFrontendPersistence)
      .mock.calls[0];
    expect(payload.generalSettings).toMatchObject({ theme: "light" });
    expect(payload.collections?.collections[0].projectIds).toEqual(["p1"]);
    expect(payload.projectMemos?.p1[0]).toMatchObject({
      projectId: "p1",
      kind: "markdown",
      content: "hello",
    });
    expect(payload.workspaceStates).toMatchObject({
      main: { activeProjectId: "p1", tabsById: {} },
      secondary: { activeProjectId: "p2" },
    });

    expect(localStorage.getItem(GENERAL_SETTINGS_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(COLLECTIONS_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(MEMOS_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_WORKSPACE_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(workspaceKey("secondary"))).toBeNull();
  });

  it("keeps every source when the backend migration fails", async () => {
    const source = JSON.stringify({ state: { theme: "light" } });
    localStorage.setItem(GENERAL_SETTINGS_STORAGE_KEY, source);
    vi.mocked(persistenceService.migrateFrontendPersistence).mockRejectedValue(
      new Error("database unavailable"),
    );

    await expect(migrateLocalPersistence()).resolves.toBeNull();
    expect(localStorage.getItem(GENERAL_SETTINGS_STORAGE_KEY)).toBe(source);
  });

  it("does not send malformed snapshots or delete them", async () => {
    const corrupt = "{not-json";
    localStorage.setItem(MEMOS_STORAGE_KEY, corrupt);
    localStorage.setItem(
      GENERAL_SETTINGS_STORAGE_KEY,
      JSON.stringify({ state: { theme: "dark" } }),
    );
    vi.mocked(persistenceService.migrateFrontendPersistence).mockResolvedValue({
      generalSettings: true,
      collections: false,
      projectMemos: false,
      workspaces: [],
    });

    await migrateLocalPersistence();

    expect(
      vi.mocked(persistenceService.migrateFrontendPersistence).mock.calls[0][0],
    ).not.toHaveProperty("projectMemos");
    expect(localStorage.getItem(MEMOS_STORAGE_KEY)).toBe(corrupt);
  });
});
