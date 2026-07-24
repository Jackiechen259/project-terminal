import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useTerminalStore } from "@/stores/terminalStore";
import type { TerminalTab } from "@/types";

import { TerminalPane } from "./TerminalPane";

const { terminalViewRender } = vi.hoisted(() => ({
  terminalViewRender: vi.fn(),
}));

vi.mock("./TerminalView", () => ({
  TerminalView: (props: { sessionId: string }) => {
    terminalViewRender(props.sessionId);
    return null;
  },
}));

function makeTab(id: string, projectId: string): TerminalTab {
  return {
    id,
    sessionId: `session-${id}`,
    projectId,
    profileId: `profile-${projectId}`,
    defaultTitle: id,
    title: id,
    cwd: "/",
    status: "running",
    createdAt: 0,
    lastActivatedAt: 0,
  };
}

beforeEach(() => {
  terminalViewRender.mockClear();
  useTerminalStore.setState({
    activeProjectId: "project-one",
    tabsById: {
      one: makeTab("one", "project-one"),
      two: makeTab("two", "project-two"),
    },
    tabGroupsByProjectId: {},
    splitViewsByProjectId: {},
  });
});

describe("TerminalPane", () => {
  it("isolates unrelated terminal views from tab metadata updates", () => {
    const onSelect = vi.fn();
    render(
      <>
        <TerminalPane
          tabId="one"
          visible
          focused
          panePosition="inset-0"
          onSelect={onSelect}
          onRestart={vi.fn()}
        />
        <TerminalPane
          tabId="two"
          visible={false}
          focused={false}
          panePosition="inset-0"
          onSelect={onSelect}
          onRestart={vi.fn()}
        />
      </>,
    );

    expect(terminalViewRender.mock.calls).toEqual([
      ["session-one"],
      ["session-two"],
    ]);

    act(() => {
      useTerminalStore.getState().updateTab("one", { title: "updated" });
    });

    expect(terminalViewRender.mock.calls).toEqual([
      ["session-one"],
      ["session-two"],
      ["session-one"],
    ]);
  });

  it("shows immediate progress while the backend session is being created", () => {
    useTerminalStore.getState().updateTab("one", {
      sessionId: null,
      status: "starting",
    });

    render(
      <TerminalPane
        tabId="one"
        visible
        focused
        panePosition="inset-0"
        onSelect={vi.fn()}
        onRestart={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Starting terminal…",
    );
    expect(terminalViewRender).not.toHaveBeenCalled();
  });

  it("offers an in-place retry when startup fails", () => {
    const onRestart = vi.fn();
    useTerminalStore.getState().updateTab("one", {
      sessionId: null,
      status: "error",
    });

    render(
      <TerminalPane
        tabId="one"
        visible
        focused
        panePosition="inset-0"
        onSelect={vi.fn()}
        onRestart={onRestart}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Terminal failed to start — click to retry",
      }),
    );
    expect(onRestart).toHaveBeenCalledWith("one");
  });
});
