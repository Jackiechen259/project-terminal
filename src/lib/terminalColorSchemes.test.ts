import { describe, expect, it } from "vitest";

import {
  ANSI_SWATCH_KEYS,
  BUILT_IN_COLOR_SCHEMES,
  FOLLOW_APP_THEME,
  isValidSchemeColor,
  minimumContrastFor,
  relativeLuminance,
  resolveColorScheme,
  type TerminalColorScheme,
} from "./terminalColorSchemes";

describe("built-in colour schemes", () => {
  it("gives every scheme a full palette in #RRGGBB", () => {
    for (const scheme of BUILT_IN_COLOR_SCHEMES) {
      const required = [
        "background",
        "foreground",
        "cursor",
        "cursorAccent",
        "selectionBackground",
        ...ANSI_SWATCH_KEYS,
      ] as const;
      for (const key of required) {
        const value = scheme.theme[key];
        expect(
          isValidSchemeColor(value),
          `${scheme.id}/${key} = ${String(value)}`,
        ).toBe(true);
      }
    }
  });

  it("keeps every id unique and stable", () => {
    const ids = BUILT_IN_COLOR_SCHEMES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    // These three predate the setting. Renaming one silently resets the
    // terminal of anyone who had selected it.
    expect(ids).toContain("project-dark");
    expect(ids).toContain("project-warm");
    expect(ids).toContain("project-light");
  });

  it("credits every scheme it did not author", () => {
    for (const scheme of BUILT_IN_COLOR_SCHEMES) {
      if (scheme.id.startsWith("project-")) continue;
      expect(scheme.attribution, scheme.id).toBeTruthy();
    }
  });
});

describe("minimumContrastFor", () => {
  it("leaves a dark scheme's palette exactly as its author set it", () => {
    for (const id of ["catppuccin-mocha", "nord", "gruvbox-dark"]) {
      const scheme = BUILT_IN_COLOR_SCHEMES.find((s) => s.id === id)!;
      expect(minimumContrastFor(scheme.theme), id).toBe(1);
    }
  });

  it("enforces readability on a light scheme", () => {
    // The bug this replaces: keyed to the application theme, a dark chrome
    // around Catppuccin Latte got `1`, and dim ANSI vanished into near-white.
    for (const id of ["catppuccin-latte", "solarized-light", "one-half-light"]) {
      const scheme = BUILT_IN_COLOR_SCHEMES.find((s) => s.id === id)!;
      expect(minimumContrastFor(scheme.theme), id).toBe(4.5);
    }
  });

  it("treats an unparseable background as dark rather than throwing", () => {
    expect(minimumContrastFor({ background: "not a colour" })).toBe(1);
    expect(minimumContrastFor({})).toBe(1);
  });
});

describe("relativeLuminance", () => {
  it("spans black to white", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
  });

  it("returns 0 for anything it cannot parse", () => {
    expect(relativeLuminance("#fff")).toBe(0);
    expect(relativeLuminance("rgb(1,2,3)")).toBe(0);
  });
});

describe("resolveColorScheme", () => {
  const custom: TerminalColorScheme = {
    id: "imported-1",
    name: "Imported",
    theme: { background: "#123456", foreground: "#ffffff" },
  };

  it("follows the application theme for the sentinel", () => {
    expect(resolveColorScheme(FOLLOW_APP_THEME, "dark").id).toBe("project-dark");
    expect(resolveColorScheme(FOLLOW_APP_THEME, "light").id).toBe(
      "project-light",
    );
    expect(resolveColorScheme(FOLLOW_APP_THEME, "eye-care").id).toBe(
      "project-warm",
    );
  });

  it("treats an unset selection as following the theme", () => {
    // Which is what every installation predating this setting has.
    expect(resolveColorScheme(undefined, "light").id).toBe("project-light");
    expect(resolveColorScheme("", "dark").id).toBe("project-dark");
  });

  it("resolves built-in and imported schemes by id", () => {
    expect(resolveColorScheme("nord", "dark").id).toBe("nord");
    expect(resolveColorScheme("imported-1", "dark", [custom]).id).toBe(
      "imported-1",
    );
  });

  it("reverts to the theme when an id no longer resolves", () => {
    // An imported scheme deleted since, or a selection synced from a machine
    // that had it. A terminal with no colours would be worse.
    expect(resolveColorScheme("deleted-scheme", "dark").id).toBe("project-dark");
  });
});
