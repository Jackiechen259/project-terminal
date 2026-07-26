import { describe, expect, it, beforeEach, vi } from "vitest";

import { useProjectStore } from "@/stores/projectStore";
import { projectService } from "@/services";

vi.mock("@/services", () => ({
  projectService: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    validate: vi.fn(),
  },
}));

const projectServiceMock = vi.mocked(projectService);

beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.setState({
    projects: [],
    loading: false,
    error: null,
  });
});

describe("projectStore", () => {
  describe("loadProjects", () => {
    it("loads projects into state", async () => {
      projectServiceMock.list.mockResolvedValueOnce([
        {
          id: "p1",
          name: "Demo",
          type: "local",
          local: { path: "D:\\Demo" },
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ]);
      await useProjectStore.getState().loadProjects();
      expect(useProjectStore.getState().projects).toHaveLength(1);
      expect(useProjectStore.getState().loading).toBe(false);
    });

    it("captures errors and clears loading", async () => {
      projectServiceMock.list.mockRejectedValueOnce({
        code: "io",
        message: "disk gone",
      });
      await useProjectStore.getState().loadProjects();
      expect(useProjectStore.getState().loading).toBe(false);
      expect(useProjectStore.getState().error?.message).toBe("disk gone");
    });
  });

  describe("createProject", () => {
    it("appends the created project", async () => {
      projectServiceMock.create.mockResolvedValueOnce({
        id: "p1",
        name: "Demo",
        type: "local",
        local: { path: "D:\\Demo" },
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      await useProjectStore.getState().createProject({
        name: "Demo",
        type: "local",
        local: { path: "D:\\Demo" },
      });
      expect(useProjectStore.getState().projects).toHaveLength(1);
    });
  });

  describe("deleteProject", () => {
    it("removes the deleted project", async () => {
      useProjectStore.setState({
        projects: [
          {
            id: "p1",
            name: "A",
            type: "local",
            local: { path: "D:\\A" },
            createdAt: "",
            updatedAt: "",
          },
          {
            id: "p2",
            name: "B",
            type: "local",
            local: { path: "D:\\B" },
            createdAt: "",
            updatedAt: "",
          },
        ],
      });
      projectServiceMock.delete.mockResolvedValueOnce(undefined);
      await useProjectStore.getState().deleteProject("p1");
      expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual([
        "p2",
      ]);
    });

    it("keeps the other projects when one is deleted", async () => {
      useProjectStore.setState({
        projects: [
          {
            id: "p1",
            name: "A",
            type: "local",
            local: { path: "D:\\A" },
            createdAt: "",
            updatedAt: "",
          },
          {
            id: "p2",
            name: "B",
            type: "local",
            local: { path: "D:\\B" },
            createdAt: "",
            updatedAt: "",
          },
        ],
      });
      projectServiceMock.delete.mockResolvedValueOnce(undefined);
      await useProjectStore.getState().deleteProject("p2");
      expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual([
        "p1",
      ]);
    });

    it("exposes a structured deletion error and preserves cached projects", async () => {
      const projects = [
        {
          id: "p1",
          name: "A",
          type: "local" as const,
          local: { path: "D:\\A" },
          createdAt: "",
          updatedAt: "",
        },
      ];
      useProjectStore.setState({ projects });
      const error = { code: "io", message: "Could not delete project" };
      projectServiceMock.delete.mockRejectedValueOnce(error);

      await expect(
        useProjectStore.getState().deleteProject("p1"),
      ).rejects.toEqual(error);
      expect(useProjectStore.getState().projects).toEqual(projects);
      expect(useProjectStore.getState().error).toEqual(error);
    });
  });
});
