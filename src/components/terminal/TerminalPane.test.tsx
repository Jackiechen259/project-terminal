import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useTerminalStore } from "@/stores/terminalStore";
import type { TerminalTab } from "@/types";

import { TerminalPane } from "./TerminalPane";

const { terminalViewRender } = vi.hoisted(() => ({
  terminalViewRender: vi.fn(),
}));

vi.mock("./TerminalView", () => ({
  TerminalView: (props: { pending: { projectId: string } }) => {
    terminalViewRender(props.pending.projectId);
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
        />
        <TerminalPane
          tabId="two"
          visible={false}
          focused={false}
          panePosition="inset-0"
          onSelect={onSelect}
        />
      </>,
    );

    expect(terminalViewRender.mock.calls).toEqual([
      ["project-one"],
      ["project-two"],
    ]);

    act(() => {
      useTerminalStore.getState().updateTab("one", { title: "updated" });
    });

    expect(terminalViewRender.mock.calls).toEqual([
      ["project-one"],
      ["project-two"],
      ["project-one"],
    ]);
  });
});
