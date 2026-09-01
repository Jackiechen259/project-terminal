import { describe, expect, it } from "vitest";

import {
  ansi256ToRgb,
  contrastRatio,
  ensureContrastRgb,
  luminance,
  mix,
  parseCssColor,
} from "./terminalColorMath";

describe("ansi256ToRgb", () => {
  it("returns the 16 standard colors for indices 0-15", () => {
    expect(ansi256ToRgb(0)).toEqual([0, 0, 0]);
    expect(ansi256ToRgb(7)).toEqual([204, 204, 204]);
    expect(ansi256ToRgb(15)).toEqual([255, 255, 255]);
  });

  it("returns the 6x6x6 color cube for indices 16-231", () => {
    expect(ansi256ToRgb(16)).toEqual([0, 0, 0]);
    expect(ansi256ToRgb(231)).toEqual([255, 255, 255]);
  });

  it("returns the greyscale ramp for indices 232-255", () => {
    expect(ansi256ToRgb(232)).toEqual([8, 8, 8]);
    expect(ansi256ToRgb(255)).toEqual([238, 238, 238]);
  });
});

describe("parseCssColor", () => {
  it("parses a hex color as opaque", () => {
    expect(parseCssColor("#112233")).toEqual([17, 34, 51, 255]);
  });

  it("parses rgb() as opaque and rgba() with its alpha channel", () => {
    expect(parseCssColor("rgb(1, 2, 3)")).toEqual([1, 2, 3, 255]);
    expect(parseCssColor("rgba(1, 2, 3, 0.5)")).toEqual([1, 2, 3, 128]);
  });

  it("returns null for anything else", () => {
    expect(parseCssColor("not-a-color")).toBeNull();
    expect(parseCssColor("")).toBeNull();
  });
});

describe("luminance and contrastRatio", () => {
  it("gives black and white the extreme luminance values", () => {
    expect(luminance([0, 0, 0])).toBe(0);
    expect(luminance([255, 255, 255])).toBeCloseTo(1, 5);
  });

  it("gives black-on-white the maximum contrast ratio", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 0);
  });

  it("is order-independent", () => {
    const a: [number, number, number] = [10, 20, 30];
    const b: [number, number, number] = [200, 210, 220];
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
  });
});

describe("mix", () => {
  it("returns the endpoints at amount 0 and 1", () => {
    expect(mix([0, 0, 0], [255, 255, 255], 0)).toEqual([0, 0, 0]);
    expect(mix([0, 0, 0], [255, 255, 255], 1)).toEqual([255, 255, 255]);
  });

  it("blends proportionally", () => {
    expect(mix([0, 0, 0], [255, 255, 255], 0.5)).toEqual([128, 128, 128]);
  });
});

describe("ensureContrastRgb", () => {
  it("leaves the color unchanged when minimumContrast is 1 or below", () => {
    const foreground: [number, number, number] = [200, 200, 200];
    expect(ensureContrastRgb(foreground, [255, 255, 255], 1)).toBe(
      foreground,
    );
  });

  it("leaves the color unchanged when it already meets the threshold", () => {
    const foreground: [number, number, number] = [0, 0, 0];
    expect(ensureContrastRgb(foreground, [255, 255, 255], 4.5)).toBe(
      foreground,
    );
  });

  it("nudges a low-contrast foreground toward black or white", () => {
    // Mid-grey on white: pushed toward black (higher-contrast extreme).
    const adjusted = ensureContrastRgb([180, 180, 180], [255, 255, 255], 4.5);
    expect(contrastRatio(adjusted, [255, 255, 255])).toBeGreaterThanOrEqual(
      4.49,
    );
    expect(adjusted[0]).toBeLessThan(180);
  });
});
