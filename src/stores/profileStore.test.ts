import { describe, expect, it, beforeEach, vi } from "vitest";

import { useProfileStore } from "@/stores/profileStore";
import { profileService, templateService } from "@/services";

vi.mock("@/services", () => ({
  profileService: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    duplicate: vi.fn(),
    scanWindowsTerminal: vi.fn(),
    importWindowsTerminal: vi.fn(),
    test: vi.fn(),
  },
  templateService: {
    createFromTemplate: vi.fn(),
  },
}));

const profileServiceMock = vi.mocked(profileService);
const templateServiceMock = vi.mocked(templateService);

beforeEach(() => {
  vi.clearAllMocks();
  useProfileStore.setState({
    byProjectId: {},
    loadingProjectIds: new Set(),
    error: null,
  });
});

describe("profileStore", () => {
  describe("loadForProject", () => {
    it("caches profiles by project id", async () => {
      profileServiceMock.list.mockResolvedValueOnce([
        {
          id: "p1",
          projectId: "proj-a",
          name: "PowerShell",
          shellType: "powershell",
          environmentType: "none",
          isDefault: true,
          showInContextMenu: true,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ]);
      await useProfileStore.getState().loadForProject("proj-a");
      expect(useProfileStore.getState().byProjectId["proj-a"]).toHaveLength(1);
      expect(useProfileStore.getState().loadingProjectIds.has("proj-a")).toBe(
        false,
      );
    });

    it("clears loadingProjectIds even on failure (regression for stuck loading)", async () => {
      profileServiceMock.list.mockRejectedValueOnce({
        code: "unknown",
        message: "boom",
      });
      await useProfileStore.getState().loadForProject("proj-a");
      expect(useProfileStore.getState().loadingProjectIds.has("proj-a")).toBe(
        false,
      );
      expect(useProfileStore.getState().error?.message).toBe("boom");
    });
  });

  describe("createProfile", () => {
    it("appends the profile and clears sibling isDefault when new profile is default", async () => {
      // Seed an existing default profile.
      useProfileStore.setState({
        byProjectId: {
          "proj-a": [
            {
              id: "old-default",
              projectId: "proj-a",
              name: "Old",
              shellType: "powershell",
              environmentType: "none",
              isDefault: true,
              showInContextMenu: true,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          ],
        },
      });
      profileServiceMock.create.mockResolvedValueOnce({
        id: "new-default",
        projectId: "proj-a",
        name: "New",
        shellType: "powershell",
        environmentType: "none",
        isDefault: true,
        showInContextMenu: true,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      await useProfileStore.getState().createProfile({
        projectId: "proj-a",
        name: "New",
        shellType: "powershell",
        environmentType: "none",
        isDefault: true,
        showInContextMenu: true,
      });
      const list = useProfileStore.getState().byProjectId["proj-a"];
      expect(list).toHaveLength(2);
      expect(list.find((p) => p.id === "new-default")?.isDefault).toBe(true);
      expect(list.find((p) => p.id === "old-default")?.isDefault).toBe(false);
    });
  });

  describe("createFromTemplate", () => {
    it("appends the materialized profile to the target project", async () => {
      useProfileStore.setState({
        byProjectId: {
          "proj-a": [
            {
              id: "existing",
              projectId: "proj-a",
              name: "Existing",
              shellType: "powershell",
              environmentType: "none",
              isDefault: true,
              showInContextMenu: true,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          ],
        },
      });
      templateServiceMock.createFromTemplate.mockResolvedValueOnce({
        id: "from-template",
        projectId: "proj-a",
        name: "Codex",
        shellType: "powershell",
        environmentType: "none",
        isDefault: false,
        showInContextMenu: true,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });

      await useProfileStore
        .getState()
        .createFromTemplate("tpl-1", "proj-a", "Codex");

      expect(templateServiceMock.createFromTemplate).toHaveBeenCalledWith(
        "tpl-1",
        "proj-a",
        "Codex",
      );
      expect(useProfileStore.getState().byProjectId["proj-a"]).toHaveLength(2);
      // Materializing a template never steals the project's default.
      expect(
        useProfileStore
          .getState()
          .byProjectId["proj-a"].find((p) => p.id === "existing")?.isDefault,
      ).toBe(true);
    });
  });

  describe("defaultForProject", () => {
    it("returns the marked default, falling back to first", () => {
      useProfileStore.setState({
        byProjectId: {
          "proj-a": [
            {
              id: "p1",
              projectId: "proj-a",
              name: "A",
              shellType: "powershell",
              environmentType: "none",
              isDefault: false,
              showInContextMenu: true,
              createdAt: "",
              updatedAt: "",
            },
            {
              id: "p2",
              projectId: "proj-a",
              name: "B",
              shellType: "powershell",
              environmentType: "none",
              isDefault: true,
              showInContextMenu: true,
              createdAt: "",
              updatedAt: "",
            },
          ],
        },
      });
      const def = useProfileStore.getState().defaultForProject("proj-a");
      expect(def?.id).toBe("p2");
    });

    it("returns null when the project has no profiles", () => {
      expect(useProfileStore.getState().defaultForProject("empty")).toBeNull();
    });
  });

  describe("importFromWindowsTerminal", () => {
    it("adds the selected imported profiles to the project", async () => {
      profileServiceMock.importWindowsTerminal.mockResolvedValueOnce({
        imported: [
          {
            id: "imported",
            projectId: "proj-a",
            name: "PowerShell 7",
            shellType: "powershell",
            shellExecutable: "pwsh.exe",
            environmentType: "none",
            isDefault: false,
            showInContextMenu: true,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
        skippedCount: 0,
        sourceFiles: ["settings.json"],
      });

      const result = await useProfileStore
        .getState()
        .importFromWindowsTerminal("proj-a", ["key-a"]);

      expect(profileServiceMock.importWindowsTerminal).toHaveBeenCalledWith(
        "proj-a",
        ["key-a"],
      );
      expect(result.imported).toHaveLength(1);
      expect(useProfileStore.getState().byProjectId["proj-a"]?.[0].id).toBe(
        "imported",
      );
    });
  });
});
