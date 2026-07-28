import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectDialog } from "./ProjectDialog";

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  loadConnections: vi.fn(),
  selectDirectory: vi.fn(),
}));

vi.mock("@/services", () => ({
  environmentService: {
    detectWslDistributions: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("@/services/native", () => ({
  nativeDialogService: {
    selectDirectory: mocks.selectDirectory,
  },
}));

vi.mock("@/stores/projectStore", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) =>
    selector({ createProject: mocks.createProject }),
}));

vi.mock("@/stores/sshStore", () => ({
  useSshStore: (selector: (state: unknown) => unknown) =>
    selector({
      connections: [],
      loadConnections: mocks.loadConnections,
    }),
}));

vi.mock("@/stores/platformStore", () => ({
  usePlatformStore: (selector: (state: unknown) => unknown) =>
    selector({
      info: {
        wslSupported: true,
        availableProjectTypes: ["local", "wsl", "ssh"],
      },
    }),
}));

vi.mock("@/components/ssh/SshConnectionDialog", () => ({
  SshConnectionDialog: () => null,
}));

vi.mock("@/components/ssh/RemoteFolderPicker", () => ({
  RemoteFolderPicker: () => null,
}));

vi.mock("@/i18n", () => ({
  useTranslation: () => ({
    t: (value: string) => value,
  }),
}));

describe("ProjectDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConnections.mockResolvedValue(undefined);
  });

  it("shows the selected folder as soon as the native picker resolves", async () => {
    let resolveSelection!: (path: string) => void;
    mocks.selectDirectory.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveSelection = resolve;
        }),
    );

    render(<ProjectDialog openState onOpenChange={vi.fn()} />);

    const browseButton = screen.getByRole("button", {
      name: "Browse folder",
    });
    fireEvent.click(browseButton);

    expect(browseButton).toBeDisabled();
    fireEvent.click(browseButton);
    expect(mocks.selectDirectory).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSelection("D:\\Projects\\selected");
    });

    expect(screen.getByLabelText("Local path")).toHaveValue(
      "D:\\Projects\\selected",
    );
    expect(browseButton).toBeEnabled();
  });
});
