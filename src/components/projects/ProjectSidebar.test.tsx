import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { useProjectStore } from "@/stores/projectStore";
import { useCollectionStore } from "@/stores/collectionStore";
import { ProjectSidebar } from "./ProjectSidebar";

const terminalState = vi.hoisted(() => {
  const state = {
    activeProjectId: null as string | null,
    tabGroupsByProjectId: {} as Record<string, unknown>,
    tabsById: {} as Record<string, unknown>,
    setActiveProject: vi.fn(),
    removeProjectTabs: vi.fn(),
  };
  state.setActiveProject.mockImplementation((projectId: string | null) => {
    state.activeProjectId = projectId;
  });
  return state;
});

// The sidebar composes many Tauri-backed stores. For this test we drive the
// project and collection stores directly and stub the rest so the rendering
// surface stays focused on collection grouping + drag and drop.
vi.mock("@/services", () => ({
  projectService: { openInExplorer: vi.fn() },
  sshService: { test: vi.fn().mockResolvedValue("ok") },
  terminalService: { close: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({
      restoreLastProject: false,
      lastProjectId: null,
      rememberProject: vi.fn(),
      showTerminalCount: true,
    }),
  ),
}));
vi.mock("@/stores/terminalStore", () => ({
  useTerminalStore: Object.assign(
    vi.fn((selector: (s: unknown) => unknown) => selector(terminalState)),
    { getState: () => terminalState },
  ),
}));
vi.mock("@/stores/sshStore", () => ({
  useSshStore: vi.fn(() => ({ connections: [], loadConnections: vi.fn() })),
}));
vi.mock("@/stores/platformStore", () => ({
  usePlatformStore: vi.fn(() => ({ info: { os: "windows" } })),
}));
// Stub the heavy dialogs so they don't pull in Tauri/dialog.
vi.mock("./ProjectDialog", () => ({
  ProjectDialog: () => null,
}));
vi.mock("./ProjectEditDialog", () => ({
  ProjectEditDialog: () => null,
}));
vi.mock("./ProjectContextMenu", () => ({
  ProjectContextMenu: () => null,
}));
vi.mock("@/components/settings/SettingsDialog", () => ({
  SettingsDialog: () => null,
}));
vi.mock("@/components/ssh/SshConnectionDialog", () => ({
  SshConnectionDialog: () => null,
}));

const sampleProjects = [
  {
    id: "p1",
    name: "Alpha",
    type: "local" as const,
    local: { path: "/tmp/alpha" },
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    id: "p2",
    name: "Beta",
    type: "local" as const,
    local: { path: "/tmp/beta" },
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
];

beforeEach(() => {
  localStorage.clear();
  terminalState.activeProjectId = null;
  terminalState.tabGroupsByProjectId = {};
  terminalState.tabsById = {};
  terminalState.setActiveProject.mockClear();
  terminalState.removeProjectTabs.mockClear();
  useCollectionStore.setState({
    collections: [],
    collapsed: {},
    ungroupedProjectIds: [],
  });
  useProjectStore.setState({
    projects: sampleProjects,
    loading: false,
    error: null,
    activeProjectId: null,
    loadProjects: vi.fn(),
    setActiveProject: vi.fn(),
    createProject: vi.fn(),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
    clearError: vi.fn(),
  });
});

describe("ProjectSidebar collections", () => {
  it("renders ungrouped projects when no collections exist", () => {
    render(<ProjectSidebar />);
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Beta")).toBeTruthy();
  });

  it("renders the new-collection button", () => {
    render(<ProjectSidebar />);
    expect(screen.getByLabelText("New collection")).toBeTruthy();
  });

  it("selects another terminal project before deleting the active project", async () => {
    const deleteProject = vi.fn(async () => {
      // Project removal must never leave TerminalWorkspace without an active
      // project while terminals in other projects are still mounted.
      expect(terminalState.activeProjectId).toBe("p2");
    });
    terminalState.activeProjectId = "p1";
    useProjectStore.setState({ deleteProject });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<ProjectSidebar />);
    fireEvent.click(screen.getAllByLabelText("Remove project")[0]);

    await waitFor(() => expect(deleteProject).toHaveBeenCalledWith("p1"));
    expect(terminalState.removeProjectTabs).toHaveBeenCalledWith("p1");
  });

  it("shows a collection group and groups its projects", async () => {
    useCollectionStore.getState().createCollection("Work");
    // Move Alpha into the collection via the store (simulating a drop).
    const colId = useCollectionStore.getState().collections[0].id;
    useCollectionStore.getState().moveProjectToCollection("p1", colId);

    render(<ProjectSidebar />);

    expect(screen.getByText("Work")).toBeTruthy();
    // Alpha is now inside the collection (still rendered).
    expect(screen.getByText("Alpha")).toBeTruthy();
    // Beta shows under the ungrouped header.
    expect(screen.getByText("Beta")).toBeTruthy();
    expect(screen.getByText("Ungrouped")).toBeTruthy();
  });

  it("collapses a collection on chevron click", async () => {
    useCollectionStore.getState().createCollection("Work");
    const colId = useCollectionStore.getState().collections[0].id;
    useCollectionStore.getState().moveProjectToCollection("p1", colId);

    render(<ProjectSidebar />);

    const collapseBtn = screen.getByLabelText("Collapse collection");
    fireEvent.click(collapseBtn);

    await waitFor(() => {
      expect(useCollectionStore.getState().collapsed[colId]).toBe(true);
    });
  });

  it("moves a project into a collection with pointer dragging", async () => {
    useCollectionStore.getState().createCollection("Work");
    const colId = useCollectionStore.getState().collections[0].id;

    render(<ProjectSidebar />);

    const projectRow = screen.getByText("Alpha").closest("[role='button']");
    expect(projectRow).toBeTruthy();
    const collectionGroup = screen
      .getByText("Work")
      .closest("[data-project-drop-target='collection']");
    expect(collectionGroup).toBeTruthy();
    fireEvent.pointerDown(projectRow!, { button: 0, pointerId: 1 });
    await waitFor(() => {
      expect(projectRow).toHaveClass("opacity-40");
    });
    fireEvent.pointerEnter(collectionGroup!);
    await waitFor(() => {
      expect(collectionGroup).toHaveClass("bg-blue-500/10");
    });
    fireEvent.pointerUp(window);

    await waitFor(() => {
      expect(useCollectionStore.getState().collections[0].projectIds).toContain(
        "p1",
      );
    });
    expect(colId).toBeTruthy();
  });

  it("reorders ungrouped projects with pointer dragging", async () => {
    render(<ProjectSidebar />);

    const alphaRow = screen.getByText("Alpha").closest("[role='button']");
    const betaRow = screen.getByText("Beta").closest("[role='button']");
    fireEvent.pointerDown(betaRow!, { button: 0, pointerId: 1 });
    fireEvent.pointerEnter(alphaRow!);
    fireEvent.pointerUp(window);

    await waitFor(() => {
      expect(useCollectionStore.getState().ungroupedProjectIds).toEqual([
        "p2",
        "p1",
      ]);
    });
    const projectRows = screen
      .getAllByRole("button")
      .filter((element) => element.dataset.projectDropTarget === "project");
    expect(projectRows[0]).toHaveTextContent("Beta");
    expect(projectRows[1]).toHaveTextContent("Alpha");
  });
  it("drops a project after the last row when dragging over its bottom half", async () => {
    render(<ProjectSidebar />);

    const alphaRow = screen
      .getByText("Alpha")
      .closest("[role='button']") as HTMLElement;
    const betaRow = screen
      .getByText("Beta")
      .closest("[role='button']") as HTMLElement;
    // jsdom reports a zero-height rect by default, which makes
    // computeDropPosition fall back to "before". Give Beta a real layout box
    // so a clientY in the bottom half resolves to "after".
    betaRow.getBoundingClientRect = vi.fn(() => ({
      top: 0,
      left: 0,
      right: 100,
      bottom: 40,
      width: 100,
      height: 40,
      x: 0,
      y: 0,
      toJSON: () => {},
    })) as unknown as typeof betaRow.getBoundingClientRect;

    fireEvent.pointerDown(alphaRow, { button: 0, pointerId: 1 });
    // Enter Beta near the bottom (clientY=30 > height/2=20) -> "after".
    fireEvent.pointerEnter(betaRow, { clientY: 30 });
    fireEvent.pointerUp(window);

    await waitFor(() => {
      // Alpha moved to after Beta (the last row) -> end of the list.
      expect(useCollectionStore.getState().ungroupedProjectIds).toEqual([
        "p2",
        "p1",
      ]);
    });
  });

  it("switches the drop position between before and after via pointermove", async () => {
    render(<ProjectSidebar />);

    const alphaRow = screen
      .getByText("Alpha")
      .closest("[role='button']") as HTMLElement;
    const betaRow = screen
      .getByText("Beta")
      .closest("[role='button']") as HTMLElement;
    betaRow.getBoundingClientRect = vi.fn(() => ({
      top: 0,
      left: 0,
      right: 100,
      bottom: 40,
      width: 100,
      height: 40,
      x: 0,
      y: 0,
      toJSON: () => {},
    })) as unknown as typeof betaRow.getBoundingClientRect;

    fireEvent.pointerDown(alphaRow, { button: 0, pointerId: 1 });
    // Start in the top half -> "before" Beta.
    fireEvent.pointerEnter(betaRow, { clientY: 5 });
    // Slide down to the bottom half -> should flip to "after".
    fireEvent.pointerMove(betaRow, { clientY: 35 });
    fireEvent.pointerUp(window);

    await waitFor(() => {
      expect(useCollectionStore.getState().ungroupedProjectIds).toEqual([
        "p2",
        "p1",
      ]);
    });
  });

  it("cancels the drag when the pointer leaves the sidebar before release", async () => {
    useCollectionStore.getState().createCollection("Work");

    render(<ProjectSidebar />);

    const projectRow = screen.getByText("Alpha").closest("[role='button']")!;
    const collectionGroup = screen
      .getByText("Work")
      .closest("[data-project-drop-target='collection']")!;
    const aside = screen.getByLabelText("Projects");

    fireEvent.pointerDown(projectRow, { button: 0, pointerId: 1 });
    fireEvent.pointerEnter(collectionGroup);
    // Pointer exits the sidebar before releasing - the drag must cancel
    // instead of dropping on the last hovered target inside the sidebar.
    fireEvent.pointerLeave(aside);
    fireEvent.pointerUp(window);

    await waitFor(() => {
      expect(
        useCollectionStore.getState().collections[0].projectIds,
      ).not.toContain("p1");
    });
  });

  it("does not use native draggable elements", () => {
    useCollectionStore.getState().createCollection("Work");
    render(<ProjectSidebar />);

    const projectRow = screen.getByText("Alpha").closest("[role='button']");
    expect(projectRow).not.toHaveAttribute("draggable", "true");
    expect(projectRow).toHaveClass("select-none");
  });
});
