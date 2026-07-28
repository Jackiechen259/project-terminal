import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectFilePanel } from "./ProjectFilePanel";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  upload: vi.fn(),
  download: vi.fn(),
  selectDirectory: vi.fn(),
}));

vi.mock("@/services", () => ({
  fileService: {
    list: mocks.list,
    upload: mocks.upload,
    download: mocks.download,
  },
}));

vi.mock("@/services/native", () => ({
  nativeDialogService: {
    selectDirectory: mocks.selectDirectory,
    selectFiles: vi.fn().mockResolvedValue([]),
  },
  nativeDragDropService: {
    listen: vi.fn().mockResolvedValue(() => {}),
  },
}));

vi.mock("@/stores/projectStore", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) =>
    selector({
      projects: [
        {
          id: "project-1",
          name: "Remote app",
          type: "ssh",
        },
      ],
    }),
}));

vi.mock("@/stores/terminalStore", () => ({
  useTerminalStore: (selector: (state: unknown) => unknown) =>
    selector({ activeProjectId: "project-1" }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ language: "en" }),
}));

describe("ProjectFilePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectDirectory.mockResolvedValue("D:\\Downloads");
    mocks.download.mockResolvedValue(undefined);
    mocks.list.mockImplementation((_projectId: string, path?: string) =>
      Promise.resolve(
        path === "/srv/app/src"
          ? {
              rootPath: "/srv/app",
              path: "/srv/app/src",
              parentPath: "/srv/app",
              entries: [
                {
                  name: "index.ts",
                  path: "/srv/app/src/index.ts",
                  isDirectory: false,
                  size: 42,
                },
              ],
            }
          : {
              rootPath: "/srv/app",
              path: "/srv/app",
              entries: [
                {
                  name: "src",
                  path: "/srv/app/src",
                  isDirectory: true,
                },
              ],
            },
      ),
    );
  });

  it("browses folders and downloads an SSH file", async () => {
    render(<ProjectFilePanel onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "src" }));
    expect(await screen.findByText("index.ts")).toBeInTheDocument();
    expect(mocks.list).toHaveBeenLastCalledWith("project-1", "/srv/app/src");

    fireEvent.click(screen.getByRole("button", { name: "Download index.ts" }));
    await waitFor(() =>
      expect(mocks.download).toHaveBeenCalledWith(
        "project-1",
        "/srv/app/src/index.ts",
        "D:\\Downloads",
        false,
      ),
    );
  });
});
