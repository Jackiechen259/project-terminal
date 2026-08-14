import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { WindowTitleBar } from "./WindowTitleBar";

/**
 * The title bar reflects the live window state by querying Tauri's window API.
 * These tests drive that contract through a mock so we can observe the maximize
 * button swapping its icon and accessible label when the window is maximized.
 */

// Mutated by the mock to simulate the OS reporting a new window state.
let maximized = false;
// Captured when the component subscribes so a test can fire a resize event.
let resizeHandler: (() => void) | null = null;

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: () => Promise.resolve(maximized),
    onResized: (handler: () => void) => {
      resizeHandler = handler;
      return Promise.resolve(() => {
        resizeHandler = null;
      });
    },
    toggleMaximize: () => {
      maximized = !maximized;
      return Promise.resolve();
    },
    minimize: () => Promise.resolve(),
    close: () => Promise.resolve(),
  }),
}));

beforeEach(() => {
  maximized = false;
  resizeHandler = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("WindowTitleBar maximize button", () => {
  it("exposes a native drag region as soon as the title bar is rendered", () => {
    render(<WindowTitleBar />);

    const titleBar = screen.getByLabelText("Window controls");
    expect(titleBar).toHaveAttribute("data-tauri-drag-region");
    expect(titleBar.querySelector("[data-tauri-drag-region]")).not.toBeNull();
  });

  it("shows the maximize icon and label when the window is not maximized", async () => {
    render(<WindowTitleBar />);

    const button = await screen.findByRole("button", { name: "Maximize" });
    expect(button.querySelector(".lucide-square")).not.toBeNull();
    expect(button.querySelector(".lucide-copy")).toBeNull();
  });

  it("switches to the restore icon and label after the window is maximized", async () => {
    render(<WindowTitleBar />);

    await screen.findByRole("button", { name: "Maximize" });

    // Simulate the OS reporting that the window was maximized.
    maximized = true;
    resizeHandler!();

    const button = await screen.findByRole("button", { name: "Restore" });
    expect(button.querySelector(".lucide-copy")).not.toBeNull();
    expect(button.querySelector(".lucide-square")).toBeNull();
  });

  it("returns to the maximize icon after the window is restored", async () => {
    render(<WindowTitleBar />);

    await screen.findByRole("button", { name: "Maximize" });

    maximized = true;
    resizeHandler!();
    await screen.findByRole("button", { name: "Restore" });

    maximized = false;
    resizeHandler!();

    const button = await screen.findByRole("button", { name: "Maximize" });
    expect(button.querySelector(".lucide-square")).not.toBeNull();
    expect(button.querySelector(".lucide-copy")).toBeNull();
  });
});

describe("WindowTitleBar right sidebar mode", () => {
  it("reports Files and Memo selections", () => {
    const onSelect = vi.fn();
    render(
      <WindowTitleBar
        rightSidebarMode="files"
        onSelectRightSidebar={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Memo" }));
    expect(onSelect).toHaveBeenCalledWith("memos");
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(onSelect).toHaveBeenCalledWith("files");
  });

  it("marks the visible panel selected and dims it when the sidebar is collapsed", () => {
    const { rerender } = render(
      <WindowTitleBar
        rightSidebarMode="files"
        rightSidebarCollapsed={false}
        onSelectRightSidebar={vi.fn()}
      />,
    );
    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Memo" })).toHaveAttribute(
      "aria-selected",
      "false",
    );

    rerender(
      <WindowTitleBar
        rightSidebarMode="files"
        rightSidebarCollapsed
        onSelectRightSidebar={vi.fn()}
      />,
    );
    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });
});
