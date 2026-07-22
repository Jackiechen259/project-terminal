import { describe, expect, it } from "vitest";

import {
  BUILT_IN_PROFILE_PRESETS,
  findProfileByName,
  hasMaterializedPreset,
  isProfileShownInContextMenu,
  uniqueProfilesByName,
} from "./profilePresets";

describe("built-in profile presets", () => {
  it("defines the two built-in templates shown in settings", () => {
    expect(BUILT_IN_PROFILE_PRESETS).toEqual([
      {
        id: "codex-cli",
        name: "Codex CLI",
        startupCommands: ["codex"],
      },
      {
        id: "oh-my-pi",
        name: "Oh My Pi",
        startupCommands: ["omp"],
      },
    ]);
  });

  it("recognizes a preset after a same-name item has been created", () => {
    const preset = BUILT_IN_PROFILE_PRESETS[0];

    expect(hasMaterializedPreset([], preset)).toBe(false);
    expect(hasMaterializedPreset([{ name: "Codex CLI" }], preset)).toBe(true);
  });

  it("only hides profiles that explicitly opt out of the context menu", () => {
    expect(isProfileShownInContextMenu({})).toBe(true);
    expect(isProfileShownInContextMenu({ showInContextMenu: true })).toBe(true);
    expect(isProfileShownInContextMenu({ showInContextMenu: false })).toBe(
      false,
    );
  });

  it("matches materialized profiles by normalized name", () => {
    const profiles = [{ name: "  CODEX cli " }];
    expect(findProfileByName(profiles, "Codex CLI")).toBe(profiles[0]);
    expect(findProfileByName(profiles, "Oh My Pi")).toBeUndefined();
  });

  it("keeps one menu entry for same-name saved profiles", () => {
    const first = { name: "Codex CLI", id: "first" };
    const duplicate = { name: " codex cli ", id: "duplicate" };
    const other = { name: "Oh My Pi", id: "other" };

    expect(uniqueProfilesByName([first, duplicate, other])).toEqual([
      first,
      other,
    ]);
  });
});
