import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";

import { formatMemoUpdatedAt, memoDisplayTitle } from "./memoFormat";

const t = (
  source: string,
  params?: Record<string, string | number>,
): string => translate("en", source, params);

describe("memoDisplayTitle", () => {
  it("falls back to kind-specific untitled labels", () => {
    expect(memoDisplayTitle({ title: "   ", kind: "markdown" }, t)).toBe(
      "Untitled note",
    );
    expect(memoDisplayTitle({ title: "", kind: "command" }, t)).toBe(
      "Untitled command",
    );
  });

  it("returns the trimmed title when present", () => {
    expect(memoDisplayTitle({ title: "API", kind: "markdown" }, t)).toBe("API");
  });
});

describe("formatMemoUpdatedAt", () => {
  const now = Date.now();
  const minutesAgo = (minutes: number) => now - minutes * 60_000;

  it("labels recent updates in minutes", () => {
    expect(formatMemoUpdatedAt(minutesAgo(1), t, "en")).toBe("Updated 1m ago");
    expect(formatMemoUpdatedAt(minutesAgo(30), t, "en")).toBe("Updated 30m ago");
  });

  it("labels the first minute as just now", () => {
    expect(formatMemoUpdatedAt(now - 5_000, t, "en")).toBe("Just now");
  });

  it("labels hours and days", () => {
    expect(formatMemoUpdatedAt(minutesAgo(60), t, "en")).toBe("Updated 1h ago");
    expect(formatMemoUpdatedAt(minutesAgo(60 * 50), t, "en")).toBe(
      "Updated 2d ago",
    );
  });

  it("labels yesterday distinctly", () => {
    expect(formatMemoUpdatedAt(minutesAgo(60 * 24), t, "en")).toBe(
      "Updated yesterday",
    );
  });

  it("falls back to a date for older entries", () => {
    const old = formatMemoUpdatedAt(minutesAgo(60 * 24 * 30), t, "en");
    expect(old).toMatch(/^Updated /);
    expect(old).not.toContain("ago");
  });
});
