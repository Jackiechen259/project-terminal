/**
 * Which monospace fonts this machine can actually render, and whether the
 * chosen one draws the icons modern shell prompts are built from.
 *
 * The Local Font Access API (`window.queryLocalFonts`) would answer the first
 * question directly, but it needs the `local-fonts` permission and the WebView
 * this application runs in does not grant it. So we probe instead: render the
 * same string in a candidate font and in a generic family, and compare. A font
 * that is not installed falls back to the generic one and measures identically.
 */

/** Bundled with the application, so it is always available. */
export const BUNDLED_TERMINAL_FONT = "Cascadia Mono NF";

/**
 * Appended after whatever the user picked.
 *
 * `Cascadia Mono` (without the icons) and `Consolas` are the shipped-with-
 * Windows rungs; the generic keyword is the floor. A CJK monospace sits in
 * between: without one, a Chinese Windows falls back to a proportional font
 * whose cell metrics do not match the Latin face, and columns stop lining up.
 */
const FALLBACK_STACK = [
  BUNDLED_TERMINAL_FONT,
  "Cascadia Mono",
  "Consolas",
  "Sarasa Mono SC",
  "Microsoft YaHei Mono",
  "monospace",
];

/**
 * Fonts worth offering. Enumerating every installed family is not possible
 * without the permission above, so this is a curated list of what terminal
 * users actually install, probed one by one.
 */
export const MONOSPACE_FONT_CANDIDATES = [
  BUNDLED_TERMINAL_FONT,
  "Cascadia Code NF",
  "Cascadia Mono",
  "Cascadia Code",
  "CaskaydiaCove Nerd Font",
  "Consolas",
  "JetBrains Mono",
  "JetBrainsMono Nerd Font",
  "Fira Code",
  "FiraCode Nerd Font",
  "Hack",
  "Hack Nerd Font",
  "MesloLGS NF",
  "Meslo LG M",
  "Source Code Pro",
  "SauceCodePro Nerd Font",
  "IBM Plex Mono",
  "Iosevka",
  "Iosevka Nerd Font",
  "Ubuntu Mono",
  "DejaVu Sans Mono",
  "Courier New",
  "Lucida Console",
  "Sarasa Mono SC",
  "Microsoft YaHei Mono",
  "NSimSun",
] as const;

/**
 * Generic families to compare a candidate against.
 *
 * One is not enough: a candidate whose metrics happen to match the default
 * monospace face would read as missing. A font has to measure the same as all
 * three to be judged absent.
 */
const BASELINE_FAMILIES = ["monospace", "serif", "sans-serif"];

/** Wide and narrow glyphs mixed, so a metric difference has room to show. */
const PROBE_TEXT = "mmmmmmmmwwwwwwww@@@@@@@@il1I0O";

/** Font size used for probing. Larger magnifies small metric differences. */
const PROBE_SIZE = 72;

/**
 * Icons from the Nerd Fonts private-use ranges, as used by starship and
 * oh-my-posh: code, python, rust, github, git, node.
 *
 * Note these are NOT Powerline separators. The WebGL renderer draws those
 * itself from `customGlyphs`, so they render correctly in any font - it is
 * this range that produces the boxes users report.
 */
export const NERD_FONT_PROBE_GLYPHS = "";

/**
 * What a rendered string occupies.
 *
 * `width` is the advance - how far the cursor moves - and `ink` is the
 * bounding box of the marks actually drawn. The two answer different
 * questions, and the distinction is what makes glyph detection work at all:
 * in a monospace font every character advances by exactly one cell, tofu
 * included, so only the ink tells a drawn glyph from a substituted box.
 */
export interface TextMetrics {
  width: number;
  /** `[left, right, ascent, descent]`, in pixels from the drawing origin. */
  ink: readonly [number, number, number, number];
}

/** Measures `text` rendered with a CSS `font` shorthand. */
export type TextMeasurer = (text: string, font: string) => TextMetrics;

/** Quote a family name for use in a CSS `font-family` list. */
function quote(family: string) {
  return `"${family.replace(/"/g, '\\"')}"`;
}

let sharedMeasurer: TextMeasurer | null = null;

/**
 * A measurer backed by an offscreen canvas.
 *
 * Canvas is used rather than a hidden DOM node because it reports a
 * sub-pixel advance width, and because it never touches layout.
 */
export function createCanvasMeasurer(): TextMeasurer | null {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return null;
  return (text, font) => {
    context.font = font;
    const metrics = context.measureText(text);
    return {
      width: metrics.width,
      ink: [
        metrics.actualBoundingBoxLeft,
        metrics.actualBoundingBoxRight,
        metrics.actualBoundingBoxAscent,
        metrics.actualBoundingBoxDescent,
      ],
    };
  };
}

function measurer(): TextMeasurer | null {
  sharedMeasurer ??= createCanvasMeasurer();
  return sharedMeasurer;
}

/**
 * Is `family` installed on this machine?
 *
 * An uninstalled family falls back to the generic family beside it in the
 * stack and measures exactly the same; an installed one almost never does.
 */
export function isFontAvailable(
  family: string,
  measure: TextMeasurer | null = measurer(),
): boolean {
  if (!measure || !family.trim()) return false;
  return BASELINE_FAMILIES.some((baseline) => {
    const fallback = measure(PROBE_TEXT, `${PROBE_SIZE}px ${baseline}`);
    const candidate = measure(
      PROBE_TEXT,
      `${PROBE_SIZE}px ${quote(family)}, ${baseline}`,
    );
    return Math.abs(candidate.width - fallback.width) > 0.5;
  });
}

/** The subset of {@link MONOSPACE_FONT_CANDIDATES} this machine can render. */
export function detectAvailableMonospaceFonts(
  measure: TextMeasurer | null = measurer(),
): string[] {
  return MONOSPACE_FONT_CANDIDATES.filter((family) =>
    isFontAvailable(family, measure),
  );
}

/**
 * A codepoint permanently guaranteed to have no glyph anywhere.
 *
 * U+10FFFE is a noncharacter: Unicode reserves it against ever being
 * assigned, so every font substitutes for it and every substitution is the
 * same tofu the browser would draw for any other missing glyph. That makes it
 * a reference for "this font does not have this character".
 */
const MISSING_GLYPH_CONTROL = "\u{10FFFE}";

/**
 * Does `family` draw the Nerd Fonts icon range?
 *
 * Answers the question a user actually has - "will my starship prompt look
 * right?" - which font availability alone does not.
 *
 * Compares each icon's ink against the control above, in the same font stack.
 * Advance width cannot answer this: in a monospace font every character
 * advances by one cell whether it is a glyph or a substituted box, so the
 * widths always match. The ink does not - a drawn icon has different extents
 * from a tofu rectangle.
 */
export function hasNerdFontGlyphs(
  family: string,
  measure: TextMeasurer | null = measurer(),
): boolean {
  if (!measure || !family.trim()) return false;
  const font = `${PROBE_SIZE}px ${quote(family)}, monospace`;
  const control = measure(MISSING_GLYPH_CONTROL, font).ink;
  const differs = (ink: TextMetrics["ink"]) =>
    ink.some((value, index) => Math.abs(value - control[index]) > 0.5);
  // Iterated by code point, not UTF-16 unit: the Nerd Fonts v3 ranges reach
  // into plane 15, where each icon is a surrogate pair.
  const glyphs = [...NERD_FONT_PROBE_GLYPHS];
  // Checked one at a time: a stack that resolves some icons from a fallback
  // font would otherwise pass on the strength of a single hit.
  const drawn = glyphs.filter((glyph) => differs(measure(glyph, font).ink));
  return drawn.length > glyphs.length / 2;
}

/**
 * Build the `fontFamily` xterm should use.
 *
 * The user's choice leads; the bundled font and the shipped-with-Windows
 * faces follow so a stale saved family, or one uninstalled since, still
 * degrades to something monospaced rather than to the default proportional
 * font.
 */
export function buildTerminalFontStack(family: string | undefined): string {
  const chosen = sanitizeFontFamily(family ?? "");
  const families = chosen
    ? [chosen, ...FALLBACK_STACK.filter((f) => f !== chosen)]
    : FALLBACK_STACK;
  return families.map((f) => (f === "monospace" ? f : quote(f))).join(", ");
}

/**
 * Reduce a saved family name to something safe to interpolate into CSS.
 *
 * The value reaches a `font-family` declaration, so quotes, semicolons and
 * braces would let a stored setting close the declaration and open another.
 * Rather than escape them, drop them: no real font name contains any.
 */
export function sanitizeFontFamily(value: string): string {
  return value
    .replace(/["'`;{}<>()\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
}

/**
 * How long to wait for the bundled font before building a terminal anyway.
 *
 * It is a local asset, so it resolves in single-digit milliseconds. The
 * timeout only exists so a font that somehow never loads leaves the user with
 * a terminal in the fallback face rather than with no terminal at all.
 */
const FONT_LOAD_TIMEOUT_MS = 250;

let bundledFontReady: Promise<void> | undefined;

/**
 * Resolve once the bundled font is usable for measurement.
 *
 * xterm sizes its character cell by rendering into a hidden element the
 * moment it is constructed. Build it before the webfont has loaded and it
 * measures the fallback, leaving the grid wrong for the rest of the session -
 * a resize does not fix it, because the cached cell size is what the resize
 * is computed from.
 */
export function whenTerminalFontReady(): Promise<void> {
  bundledFontReady ??= (async () => {
    if (typeof document === "undefined" || !document.fonts) return;
    const load = document.fonts
      .load(`16px ${quote(BUNDLED_TERMINAL_FONT)}`)
      .then(() => undefined);
    const timeout = new Promise<void>((resolve) => {
      setTimeout(resolve, FONT_LOAD_TIMEOUT_MS);
    });
    await Promise.race([load, timeout]).catch(() => undefined);
  })();
  return bundledFontReady;
}

/**
 * Lines for the settings preview, chosen to answer the three questions users
 * have about a terminal font.
 */
export const FONT_PREVIEW_LINES = [
  // Are the characters that get confused distinguishable?
  "0OIl1 {}[]()<>/\\|",
  // Powerline separators - these already render in any font, because the
  // WebGL renderer draws them itself.
  "",
  // The Nerd Fonts icons that actually decide whether a prompt looks broken.
  NERD_FONT_PROBE_GLYPHS,
] as const;
