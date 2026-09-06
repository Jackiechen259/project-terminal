import { describe, expect, it } from "vitest";

import { glyphMayBeColor } from "./GlyphAtlas";

describe("glyphMayBeColor", () => {
  it("skips the colour-emoji scan for ASCII runs", () => {
    expect(glyphMayBeColor("")).toBe(false);
    expect(glyphMayBeColor("hello")).toBe(false);
    expect(glyphMayBeColor("0123456789 +-*/")).toBe(false);
  });

  it("scans non-ASCII glyphs that may be colour emoji", () => {
    expect(glyphMayBeColor("界")).toBe(true);
    expect(glyphMayBeColor("😀")).toBe(true);
  });
});
