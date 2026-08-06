import { describe, expect, it } from "vitest";

import {
  renderThemeTokensCss,
  THEME_COLOR_SCHEME,
  THEME_TOKENS,
  type ThemeName,
} from "./tokens";

const THEMES = Object.keys(THEME_TOKENS) as ThemeName[];

describe("theme tokens", () => {
  it("defines every token in every theme", () => {
    // A missing token used to be invisible: the theme silently kept the dark
    // value inherited from `:root`, which is how the startup accent stayed
    // blue in the light and eye-care themes.
    const expected = Object.keys(THEME_TOKENS.dark).sort();
    for (const theme of THEMES) {
      expect(Object.keys(THEME_TOKENS[theme]).sort(), theme).toEqual(expected);
    }
  });

  it("states every token as bare HSL components", () => {
    // `hsl(var(--token) / <alpha>)` is how Tailwind expresses `bg-primary/40`,
    // and it only composes if the variable holds components rather than a
    // finished colour.
    const components = /^-?\d+(\.\d+)? \d+(\.\d+)?% \d+(\.\d+)?%$/;
    for (const theme of THEMES) {
      for (const [token, value] of Object.entries(THEME_TOKENS[theme])) {
        expect(value, `${theme}/${token}`).toMatch(components);
      }
    }
  });

  it("declares a colour scheme for every theme", () => {
    for (const theme of THEMES) {
      expect(THEME_COLOR_SCHEME[theme], theme).toMatch(/^(dark|light)$/);
    }
  });

  it("renders a bare :root rule so an unstamped document is still styled", () => {
    const css = renderThemeTokensCss();

    // The inline script in index.html stamps `data-theme` during parse, but a
    // document with no persisted setting never gets stamped at all.
    expect(css).toContain(':root,\n:root[data-theme="dark"] {');
    expect(css).toContain(':root[data-theme="eye-care"] {');
    expect(css).toContain(':root[data-theme="light"] {');
    expect(css).toContain("--radius:");
    for (const theme of THEMES) {
      expect(css).toContain(`--primary: ${THEME_TOKENS[theme].primary};`);
    }
  });
});
