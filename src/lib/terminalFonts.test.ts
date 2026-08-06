import { describe, expect, it } from "vitest";

import {
  BUNDLED_TERMINAL_FONT,
  buildTerminalFontStack,
  detectAvailableMonospaceFonts,
  hasNerdFontGlyphs,
  isFontAvailable,
  sanitizeFontFamily,
  type TextMeasurer,
} from "./terminalFonts";

const GENERIC_WIDTHS = { monospace: 10, serif: 12, "sans-serif": 14 };

/** Ink extents of the box a browser substitutes for a glyph a font lacks. */
const TOFU_INK = [1, 5, 8, 0] as const;

/**
 * A measurer standing in for a machine that has exactly `installed`, where
 * `withIcons` also draws the Nerd Fonts ranges.
 *
 * Mirrors the two behaviours the real probes depend on. A font stack resolves
 * to its first installed family, so an uninstalled family measures exactly
 * like the generic one beside it. And every character in a monospace font
 * advances by one cell whether or not the font has a glyph for it - only the
 * ink differs.
 */
function fakeMeasurer(
  installed: Record<string, number>,
  withIcons: string[] = [],
): TextMeasurer {
  return (text, font) => {
    const families = font
      .replace(/^\d+px\s+/, "")
      .split(",")
      .map((family) => family.trim().replace(/^"|"$/g, ""));
    const resolved = families.find(
      (family) => family in installed || family in GENERIC_WIDTHS,
    );
    const perChar =
      installed[resolved ?? ""] ??
      GENERIC_WIDTHS[resolved as keyof typeof GENERIC_WIDTHS] ??
      10;
    const drawsIcons = resolved !== undefined && withIcons.includes(resolved);
    const codePoints = [...text].map((c) => c.codePointAt(0) ?? 0);
    // Noncharacters are tofu in every font, by definition - that is what makes
    // one usable as the reference the real probe compares against.
    const isNoncharacter = codePoints.some((c) => c >= 0x10fffe);
    const isIcon = codePoints.every((c) => c >= 0xe000);
    const tofu = isNoncharacter || (isIcon && !drawsIcons);
    return {
      width: codePoints.length * perChar,
      ink: tofu ? TOFU_INK : [0, perChar, perChar, 1],
    };
  };
}

describe("isFontAvailable", () => {
  it("detects a family whose metrics differ from the generic fallback", () => {
    const measure = fakeMeasurer({ "JetBrains Mono": 11 });
    expect(isFontAvailable("JetBrains Mono", measure)).toBe(true);
  });

  it("reports an uninstalled family as absent", () => {
    // Nothing named this exists, so every probe falls through to the generic
    // family and measures exactly what the generic family measures.
    const measure = fakeMeasurer({});
    expect(isFontAvailable("Not Installed Mono", measure)).toBe(false);
  });

  it("still finds a family that matches one generic family's metrics", () => {
    // This is why three baselines are probed rather than one: a font whose
    // advance happens to equal the default monospace would otherwise read as
    // missing.
    const measure = fakeMeasurer({ "Twin Metrics Mono": 10 });
    expect(isFontAvailable("Twin Metrics Mono", measure)).toBe(true);
  });

  it("returns false without a measurer or a family", () => {
    expect(isFontAvailable("Consolas", null)).toBe(false);
    expect(isFontAvailable("  ", fakeMeasurer({ Consolas: 11 }))).toBe(false);
  });
});

describe("detectAvailableMonospaceFonts", () => {
  it("returns only the candidates this machine can render", () => {
    const measure = fakeMeasurer({ Consolas: 11, Hack: 13 });
    expect(detectAvailableMonospaceFonts(measure)).toEqual([
      "Consolas",
      "Hack",
    ]);
  });
});

describe("hasNerdFontGlyphs", () => {
  it("reports icons present when the family draws them", () => {
    const measure = fakeMeasurer({ "Hack Nerd Font": 10 }, ["Hack Nerd Font"]);
    expect(hasNerdFontGlyphs("Hack Nerd Font", measure)).toBe(true);
  });

  it("reports icons absent when the browser substitutes a box", () => {
    // The advance is identical either way - one monospace cell - so this can
    // only be told from the ink. Measuring width instead reported Consolas as
    // icon-capable, which is the bug this test pins.
    const measure = fakeMeasurer({ Consolas: 10 }, []);
    expect(hasNerdFontGlyphs("Consolas", measure)).toBe(false);
  });

  it("reports icons absent for a family that is not installed at all", () => {
    expect(hasNerdFontGlyphs("No Such Font", fakeMeasurer({}, []))).toBe(false);
  });
});

describe("buildTerminalFontStack", () => {
  it("leads with the chosen family and keeps the fallbacks behind it", () => {
    const stack = buildTerminalFontStack("JetBrains Mono");
    expect(stack.startsWith('"JetBrains Mono"')).toBe(true);
    expect(stack).toContain(`"${BUNDLED_TERMINAL_FONT}"`);
    expect(stack.endsWith("monospace")).toBe(true);
  });

  it("does not repeat a chosen family that is already a fallback", () => {
    const stack = buildTerminalFontStack("Consolas");
    expect(stack.match(/"Consolas"/g)).toHaveLength(1);
  });

  it("falls back to the bundled font when nothing is chosen", () => {
    const stack = buildTerminalFontStack("");
    expect(stack.startsWith(`"${BUNDLED_TERMINAL_FONT}"`)).toBe(true);
    expect(buildTerminalFontStack(undefined)).toBe(stack);
  });

  it("keeps a hostile saved value from escaping the CSS declaration", () => {
    const stack = buildTerminalFontStack('Evil"; color: red; font-family: "x');
    expect(stack).not.toContain(";");
    expect(stack.match(/"/g)?.length ?? 0).toBe(
      // Every quote is a delimiter this function wrote.
      stack.split(",").filter((f) => f.trim() !== "monospace").length * 2,
    );
  });
});

describe("sanitizeFontFamily", () => {
  it("strips characters that could close a CSS declaration", () => {
    expect(sanitizeFontFamily('Fira"; }')).toBe("Fira");
    expect(sanitizeFontFamily("Fira'Code")).toBe("FiraCode");
    expect(sanitizeFontFamily("Fira\\Code")).toBe("FiraCode");
  });

  it("collapses whitespace and caps the length", () => {
    expect(sanitizeFontFamily("  Fira   Code  ")).toBe("Fira Code");
    expect(sanitizeFontFamily("a".repeat(200))).toHaveLength(64);
  });

  it("leaves an ordinary family name untouched", () => {
    expect(sanitizeFontFamily("Cascadia Mono NF")).toBe("Cascadia Mono NF");
  });
});
