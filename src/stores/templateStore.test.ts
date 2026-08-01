import { describe, expect, it, beforeEach, vi } from "vitest";

import { useTemplateStore } from "@/stores/templateStore";
import { templateService } from "@/services";
import type { ProfileTemplate } from "@/types";

vi.mock("@/services", () => ({
  templateService: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    createFromTemplate: vi.fn(),
    scanWindowsTerminal: vi.fn(),
    importWindowsTerminal: vi.fn(),
  },
}));

const templateServiceMock = vi.mocked(templateService);

function template(id: string, name: string): ProfileTemplate {
  return {
    id,
    name,
    icon: "terminal",
    shellType: "powershell",
    environmentType: "none",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useTemplateStore.setState({
    templates: [],
    loaded: false,
    loading: false,
    error: null,
  });
});

describe("templateStore", () => {
  describe("importFromWindowsTerminal", () => {
    it("appends only the selected templates to the cached list", async () => {
      useTemplateStore.setState({
        templates: [template("tpl-existing", "Existing")],
        loaded: true,
      });
      templateServiceMock.importWindowsTerminal.mockResolvedValueOnce({
        imported: [template("tpl-imported", "PowerShell 7")],
        skippedCount: 1,
        sourceFiles: ["settings.json"],
      });

      const result = await useTemplateStore
        .getState()
        .importFromWindowsTerminal(["key-a"]);

      expect(templateServiceMock.importWindowsTerminal).toHaveBeenCalledWith([
        "key-a",
      ]);
      expect(result.imported).toHaveLength(1);
      expect(useTemplateStore.getState().templates.map((t) => t.id)).toEqual([
        "tpl-existing",
        "tpl-imported",
      ]);
    });

    it("leaves the cached list untouched when nothing new was imported", async () => {
      useTemplateStore.setState({
        templates: [template("tpl-existing", "Existing")],
        loaded: true,
      });
      templateServiceMock.importWindowsTerminal.mockResolvedValueOnce({
        imported: [],
        skippedCount: 3,
        sourceFiles: ["settings.json"],
      });

      const result = await useTemplateStore
        .getState()
        .importFromWindowsTerminal(["key-a"]);

      expect(result.skippedCount).toBe(3);
      expect(useTemplateStore.getState().templates).toHaveLength(1);
    });
  });
});
