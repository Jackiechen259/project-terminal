import { describe, expect, it } from "vitest";

import { selectRightSidebarMode } from "./rightSidebarState";

describe("selectRightSidebarMode", () => {
  it("opens a collapsed sidebar and shows the requested panel", () => {
    expect(
      selectRightSidebarMode({ collapsed: true, mode: "files" }, "memos"),
    ).toEqual({ collapsed: false, mode: "memos" });
    expect(
      selectRightSidebarMode({ collapsed: true, mode: "memos" }, "files"),
    ).toEqual({ collapsed: false, mode: "files" });
  });

  it("switches panels while the sidebar stays open", () => {
    expect(
      selectRightSidebarMode({ collapsed: false, mode: "files" }, "memos"),
    ).toEqual({ collapsed: false, mode: "memos" });
  });

  it("collapses the sidebar when its current panel is clicked again", () => {
    expect(
      selectRightSidebarMode({ collapsed: false, mode: "files" }, "files"),
    ).toEqual({ collapsed: true, mode: "files" });
  });
});
