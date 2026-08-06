import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { StatusBar } from "./StatusBar";
import { useProfileStore } from "@/stores/profileStore";
import { useTerminalStore } from "@/stores/terminalStore";

beforeEach(() => {
  useTerminalStore.setState({
    activeProjectId: null,
    tabsById: {},
    tabGroupsByProjectId: {},
    splitViewsByProjectId: {},
  });
  useProfileStore.setState({ byProjectId: {} });
});

describe("StatusBar", () => {
  it("keeps the status bar edge rendered when there is no active terminal", () => {
    render(<StatusBar />);

    const statusBar = screen.getByRole("contentinfo", { name: "Status" });
    expect(statusBar).toHaveClass("border-t");
    expect(statusBar).toBeEmptyDOMElement();
  });

  it("shows active terminal details without changing the status bar shell", () => {
    useTerminalStore.setState({
      activeProjectId: "project-1",
      tabsById: {
        "tab-1": {
          id: "tab-1",
          sessionId: "session-1",
          projectId: "project-1",
          profileId: "profile-1",
          defaultTitle: "PowerShell",
          title: "PowerShell",
          cwd: "C:\\work",
          status: "running",
          lastCommandExitCode: 0,
          createdAt: 0,
          lastActivatedAt: 0,
        },
      },
      tabGroupsByProjectId: {
        "project-1": {
          projectId: "project-1",
          tabIds: ["tab-1"],
          activeTabId: "tab-1",
        },
      },
    });
    useProfileStore.setState({
      byProjectId: {
        "project-1": [
          {
            id: "profile-1",
            projectId: "project-1",
            name: "PowerShell",
            shellType: "powershell",
            environmentType: "none",
            isDefault: true,
            showInContextMenu: true,
            createdAt: "2026-08-06T00:00:00Z",
            updatedAt: "2026-08-06T00:00:00Z",
          },
        ],
      },
    });

    render(<StatusBar />);

    const statusBar = screen.getByRole("contentinfo", { name: "Status" });
    expect(statusBar).toHaveClass("border-t");
    expect(screen.getByText("PowerShell")).toBeInTheDocument();
    expect(screen.getByTitle("C:\\work")).toHaveTextContent("work");
    expect(
      screen.getByTitle("Exit status of the last command"),
    ).toHaveTextContent("✓");
  });
});
