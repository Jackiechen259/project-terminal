/**
 * Color math shared by both terminal renderers (Canvas2D and WebGL) and the
 * color-scheme picker's initial-contrast heuristic.
 *
 * Kept in plain RGB tuples rather than any one consumer's own representation
 * (a CSS color string, an RGBA tuple with alpha, a `#rrggbb` hex string) -
 * that is the one shape every consumer can cheaply convert to and from, and
 * it is what let three near-identical copies of this file collapse into one.
 * A caller that needs alpha or a CSS string wraps these with its own thin,
 * format-specific conversion; nothing here needs to know those formats.
 */

export type Rgb = [number, number, number];

/** The 16 standard ANSI colors, indices 0-15. */
export const ANSI_16_COLORS: Rgb[] = [
  [0, 0, 0],
  [204, 85, 85],
  [85, 204, 85],
  [205, 205, 85],
  [84, 85, 203],
  [204, 85, 204],
  [122, 202, 202],
  [204, 204, 204],
  [85, 85, 85],
  [255, 85, 85],
  [85, 255, 85],
  [255, 255, 85],
  [85, 85, 255],
  [255, 85, 255],
  [85, 255, 255],
  [255, 255, 255],
];

/** Theme color keys for ANSI palette indices 0-15, in index order. */
export const ANSI_THEME_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

const ANSI_256_RAMP = [0, 95, 135, 175, 215, 255];

/** Map a 256-color palette index to RGB, per the xterm 256-color cube. */
export function ansi256ToRgb(index: number): Rgb {
  if (index < 16) return ANSI_16_COLORS[index] ?? ANSI_16_COLORS[0];
  if (index < 232) {
    const color = index - 16;
    const red = Math.floor(color / 36);
    const green = Math.floor((color % 36) / 6);
    const blue = color % 6;
    return [ANSI_256_RAMP[red], ANSI_256_RAMP[green], ANSI_256_RAMP[blue]];
  }
  const grey = 8 + (index - 232) * 10;
  return [grey, grey, grey];
}

const HEX_COLOR_PATTERN = /^#([0-9a-f]{6})$/iu;
const RGB_FUNCTION_PATTERN =
  /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/iu;

/**
 * Parse a `#rrggbb` or `rgb()`/`rgba()` CSS color string into RGBA. Alpha is
 * `255` (opaque) for `#rrggbb` and `rgb()`, or `rgba()`'s fourth channel
 * (0-1) scaled to 0-255. Returns `null` for anything else - callers that
 * want a same-input fallback (rather than a default color) check for that
 * themselves.
 */
export function parseCssColor(
  value: string,
): [number, number, number, number] | null {
  const hex = HEX_COLOR_PATTERN.exec(value);
  if (hex) {
    return [
      parseInt(hex[1].slice(0, 2), 16),
      parseInt(hex[1].slice(2, 4), 16),
      parseInt(hex[1].slice(4, 6), 16),
      255,
    ];
  }
  const rgb = RGB_FUNCTION_PATTERN.exec(value);
  if (!rgb) return null;
  const alpha = rgb[4] === undefined ? 255 : Math.round(Number(rgb[4]) * 255);
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), alpha];
}

/** Relative luminance per WCAG 2.1. */
export function luminance([red, green, blue]: Rgb): number {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
  );
}

/** WCAG 2.1 contrast ratio between two colors. Order-independent. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const luminanceA = luminance(a);
  const luminanceB = luminance(b);
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Linear-interpolate between two colors; `amount` 0 = `from`, 1 = `to`. */
export function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  return from.map((channel, index) =>
    Math.round(channel + (to[index] - channel) * amount),
  ) as Rgb;
}

/**
 * Nudge `foreground` toward black or white (whichever contrasts more with
 * `background`) until it meets `minimumContrast` against `background`, via
 * binary search over the blend amount. Returns `foreground` unchanged if it
 * already meets the threshold or `minimumContrast` is `<= 1`; returns the
 * extreme (pure black/white) if even that cannot reach the threshold.
 */
export function ensureContrastRgb(
  foreground: Rgb,
  background: Rgb,
  minimumContrast = 1,
): Rgb {
  if (minimumContrast <= 1) return foreground;
  if (contrastRatio(foreground, background) >= minimumContrast) {
    return foreground;
  }
  const black: Rgb = [0, 0, 0];
  const white: Rgb = [255, 255, 255];
  const target =
    contrastRatio(black, background) > contrastRatio(white, background)
      ? black
      : white;
  if (contrastRatio(target, background) < minimumContrast) {
    return target;
  }
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 12; iteration++) {
    const midpoint = (low + high) / 2;
    if (
      contrastRatio(mix(foreground, target, midpoint), background) >=
      minimumContrast
    ) {
      high = midpoint;
    } else {
      low = midpoint;
    }
  }
  return mix(foreground, target, high);
}
