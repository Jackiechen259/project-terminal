import { describe, expect, it, vi } from "vitest";

import type { ContextMenuItem } from "./context-menu";
import { joinContextMenuSections } from "./context-menu-items";

describe("joinContextMenuSections", () => {
  it("drops empty sections and inserts one separator between populated ones", () => {
    const first: ContextMenuItem = { label: "First", onSelect: vi.fn() };
    const second: ContextMenuItem = { label: "Second", onSelect: vi.fn() };

    expect(joinContextMenuSections([first], [], [second])).toEqual([
      first,
      { separator: true },
      second,
    ]);
  });

  it("does not add separators around a single section", () => {
    const item: ContextMenuItem = { label: "Only", onSelect: vi.fn() };
    expect(joinContextMenuSections([], [item], [])).toEqual([item]);
  });
});
