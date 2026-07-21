import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { useCollectionStore } from "@/stores/collectionStore";
import { CollectionDialog } from "./CollectionDialog";

// ProjectSidebar pulls in many Tauri-backed stores; we only need the
// collection store here, so the project/terminal/settings/ssh stores are
// stubbed. ProjectDialog is heavy and not under test, so we stub it too.
vi.mock("@/stores/projectStore", () => ({
  useProjectStore: vi.fn(() => ({ projects: [], loading: false, error: null })),
}));
vi.mock("@/stores/terminalStore", () => ({
  useTerminalStore: vi.fn(() => ({
    tabGroupsByProjectId: {},
    tabsById: {},
  })),
}));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: vi.fn(() => ({
    restoreLastProject: false,
    lastProjectId: null,
    rememberProject: vi.fn(),
    showTerminalCount: true,
  })),
}));
vi.mock("@/stores/sshStore", () => ({
  useSshStore: vi.fn(() => ({ connections: [], loadConnections: vi.fn() })),
}));
vi.mock("@/stores/platformStore", () => ({
  usePlatformStore: vi.fn(() => ({ info: null })),
}));
vi.mock("@/services", () => ({
  projectService: { openInExplorer: vi.fn() },
  sshService: { test: vi.fn() },
  terminalService: { close: vi.fn() },
}));
vi.mock("./ProjectDialog", () => ({
  ProjectDialog: () => null,
}));

beforeEach(() => {
  localStorage.clear();
  useCollectionStore.setState({ collections: [], collapsed: {} });
});

describe("CollectionDialog", () => {
  it("creates a collection when the form is submitted", async () => {
    render(<CollectionDialog trigger={<button>open</button>} />);

    fireEvent.click(screen.getByText("open"));
    const input = await screen.findByLabelText("Collection name");
    fireEvent.change(input, { target: { value: "Backend" } });
    fireEvent.click(screen.getByText("Create collection"));

    await waitFor(() => {
      expect(useCollectionStore.getState().collections).toHaveLength(1);
    });
    expect(useCollectionStore.getState().collections[0].name).toBe("Backend");
  });

  it("disables the submit button when the name is blank", async () => {
    render(<CollectionDialog trigger={<button>open</button>} />);
    fireEvent.click(screen.getByText("open"));
    const button = await screen.findByText("Create collection");
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("renames an existing collection", async () => {
    const collection = useCollectionStore.getState().createCollection("Old");
    render(
      <CollectionDialog
        collection={collection}
        openState={true}
        onOpenChange={() => {}}
      />,
    );

    const input = await screen.findByLabelText("Collection name");
    expect((input as HTMLInputElement).value).toBe("Old");
    fireEvent.change(input, { target: { value: "New" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(useCollectionStore.getState().collections[0].name).toBe("New");
    });
  });
});
