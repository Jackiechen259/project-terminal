import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { createSplitView } from "@/lib/paneLayout";
import { terminalService } from "@/services";
import { useMemoStore, type CommandMemo } from "@/stores/memoStore";
import { useProjectStore } from "@/stores/projectStore";
import { useTerminalStore } from "@/stores/terminalStore";
import type { PaneNode, TerminalTab } from "@/types";

import { ProjectMemoPanel } from "./ProjectMemoPanel";

vi.mock("@/services", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services")>()),
  terminalService: {
    ...(await importOriginal<typeof import("@/services")>()).terminalService,
    write: vi.fn().mockResolvedValue(undefined),
  },
}));

const writeMock = vi.mocked(terminalService.write);

// jsdom ships no PointerEvent; Radix dropdown triggers open on `pointerdown`
// with `event.button === 0`, so without this the overflow menu never opens.
if (typeof window.PointerEvent === "undefined") {
  window.PointerEvent = window.MouseEvent as typeof PointerEvent;
}

const projectA = {
  id: "p1",
  name: "Project A",
  type: "local" as const,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};
const projectB = {
  id: "p2",
  name: "Project B",
  type: "local" as const,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

function runningTab(id: string, sessionId: string): TerminalTab {
  return {
    id,
    sessionId,
    projectId: "p1",
    profileId: "profile-1",
    defaultTitle: id,
    title: id,
    cwd: "",
    status: "running",
    createdAt: 1,
    lastActivatedAt: 1,
  };
}

function setRunningTerminal() {
  useTerminalStore.setState({
    activeProjectId: "p1",
    tabsById: { t1: runningTab("t1", "s1") },
    tabGroupsByProjectId: {
      p1: { projectId: "p1", tabIds: ["t1"], activeTabId: "t1" },
    },
    splitViewsByProjectId: {},
  });
}

function addCommand(command: string, title = "Dev server") {
  const id = useMemoStore.getState().createCommandMemo("p1");
  useMemoStore.getState().updateCommandMemo("p1", id, {
    title,
    command,
  });
  return id;
}

beforeEach(() => {
  localStorage.clear();
  writeMock.mockClear();
  useMemoStore.setState({ memosByProjectId: {} });
  useProjectStore.setState({
    projects: [projectA, projectB],
    loading: false,
    loaded: true,
    error: null,
  });
  useTerminalStore.setState({
    activeProjectId: "p1",
    tabsById: {},
    tabGroupsByProjectId: {},
    splitViewsByProjectId: {},
  });
});

describe("ProjectMemoPanel", () => {
  it("shows the empty state when no project is selected", () => {
    useTerminalStore.setState({ activeProjectId: null });
    render(<ProjectMemoPanel onClose={vi.fn()} />);
    expect(
      screen.getByText("Select a project to view its memos."),
    ).toBeInTheDocument();
  });

  it("switches between Notes and Commands tabs", () => {
    render(<ProjectMemoPanel onClose={vi.fn()} />);
    expect(screen.getByText("No notes yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Commands" }));
    expect(screen.getByText("No commands yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
    expect(screen.getByText("No notes yet")).toBeInTheDocument();
  });

  it("creates a note and autosaves edits into the store", () => {
    render(<ProjectMemoPanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "New note" }));

    fireEvent.change(screen.getByLabelText("Note title"), {
      target: { value: "API" },
    });
    fireEvent.change(screen.getByLabelText("Note content"), {
      target: { value: "# Hello\n\n- a\n- b" },
    });

    const memo = useMemoStore.getState().memosByProjectId.p1[0];
    expect(memo).toMatchObject({
      kind: "markdown",
      projectId: "p1",
      title: "API",
      content: "# Hello\n\n- a\n- b",
    });

    // Closing the editor returns to the list, which now shows the note.
    fireEvent.click(screen.getByRole("button", { name: "Close note" }));
    expect(screen.getByText("API")).toBeInTheDocument();
  });

  it("creates a command memo and saves it with the explicit Save button", () => {
    render(<ProjectMemoPanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Commands" }));
    fireEvent.click(screen.getByRole("button", { name: "New command" }));

    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Dev server" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Start Vite" },
    });
    fireEvent.change(screen.getByLabelText("Command"), {
      target: { value: "pnpm dev" },
    });
    fireEvent.click(save);

    expect(useMemoStore.getState().memosByProjectId.p1[0]).toMatchObject({
      kind: "command",
      title: "Dev server",
      description: "Start Vite",
      command: "pnpm dev",
    });
  });

  it("deletes a memo after confirming in the dialog", () => {
    const id = useMemoStore.getState().createMarkdownMemo("p1");
    useMemoStore.getState().updateMarkdownMemo("p1", id, { title: "TODO" });
    render(<ProjectMemoPanel onClose={vi.fn()} />);

    fireEvent.click(screen.getByLabelText("Delete memo"));
    expect(screen.getByText("Delete memo?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(useMemoStore.getState().memosByProjectId.p1).toHaveLength(0);
    expect(screen.getByText("No notes yet")).toBeInTheDocument();
  });

  it("copies the command through the clipboard API", async () => {
    addCommand("pnpm dev");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<ProjectMemoPanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Commands" }));

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "More command actions" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("pnpm dev");
  });

  it("disables Run and Insert without a running terminal and explains why", () => {
    addCommand("pnpm dev");
    render(<ProjectMemoPanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Commands" }));

    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Insert" })).toBeDisabled();
    expect(
      screen.getByText("Open a running terminal for this project first."),
    ).toBeInTheDocument();
  });

  it("runs the command with a trailing Enter in the active terminal session", async () => {
    setRunningTerminal();
    addCommand("pnpm dev");
    render(<ProjectMemoPanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Commands" }));

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() =>
      expect(writeMock).toHaveBeenCalledWith("s1", "pnpm dev\r"),
    );
  });

  it("inserts the command without Enter", async () => {
    setRunningTerminal();
    addCommand("pnpm dev");
    render(<ProjectMemoPanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Commands" }));

    fireEvent.click(screen.getByRole("button", { name: "Insert" }));
    await waitFor(() =>
      expect(writeMock).toHaveBeenCalledWith("s1", "pnpm dev"),
    );
  });

  it("reports a non-blocking error when the write fails, keeping the memo", async () => {
    setRunningTerminal();
    addCommand("pnpm dev", "Keep me");
    writeMock.mockRejectedValueOnce(new Error("session gone"));
    render(<ProjectMemoPanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Commands" }));

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(
      await screen.findByText("Could not send command to terminal."),
    ).toBeInTheDocument();
    expect(
      (useMemoStore.getState().memosByProjectId.p1[0] as CommandMemo).command,
    ).toBe("pnpm dev");
    expect(screen.getByText("Keep me")).toBeInTheDocument();
  });

  it("sends split-pane runs to the focused pane and follows focus changes", async () => {
    const view = createSplitView("t1", "t2", "side-by-side");
    useTerminalStore.setState({
      activeProjectId: "p1",
      tabsById: {
        t1: runningTab("t1", "s1"),
        t2: runningTab("t2", "s2"),
      },
      tabGroupsByProjectId: {
        p1: { projectId: "p1", tabIds: ["t1", "t2"], activeTabId: "t1" },
      },
      splitViewsByProjectId: { p1: view },
    });
    addCommand("echo pane-a");
    render(<ProjectMemoPanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Commands" }));

    // createSplitView focuses the second pane (t2, session s2).
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() =>
      expect(writeMock).toHaveBeenCalledWith("s2", "echo pane-a\r"),
    );

    // Re-focusing the first pane moves the command target with it.
    writeMock.mockClear();
    const firstPaneId = (view.root as Extract<PaneNode, { type: "split" }>)
      .first.paneId;
    useTerminalStore.setState(() => ({
      splitViewsByProjectId: {
        p1: { ...view, focusedPaneId: firstPaneId },
      },
    }));
    // Wait for the previous write's busy state to clear before clicking again.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Run" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() =>
      expect(writeMock).toHaveBeenCalledWith("s1", "echo pane-a\r"),
    );
  });

  it("keeps project memos fully isolated when switching projects", async () => {
    const id = useMemoStore.getState().createMarkdownMemo("p2");
    useMemoStore.getState().updateMarkdownMemo("p2", id, {
      title: "Docker Todo",
    });
    render(<ProjectMemoPanel onClose={vi.fn()} />);

    // Project A active: Project B's memo must not appear.
    expect(screen.queryByText("Docker Todo")).not.toBeInTheDocument();
    expect(screen.getByText("No notes yet")).toBeInTheDocument();

    // Switch to Project B: its memo appears.
    useTerminalStore.setState({ activeProjectId: "p2" });
    expect(await screen.findByText("Docker Todo")).toBeInTheDocument();

    // Project B memos stay in the store under their own key.
    expect(
      useMemoStore.getState().memosByProjectId.p2[0].title,
    ).toBe("Docker Todo");
  });
});
