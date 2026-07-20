import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

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
    startDragging: () => Promise.resolve(),
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
