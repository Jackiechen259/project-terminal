import type { TranslateFn } from "@/i18n";

/** Fallback label shown for a memo whose title is empty. */
export function memoDisplayTitle(
  memo: { title: string; kind: "markdown" | "command" },
  t: TranslateFn,
): string {
  if (memo.title.trim()) return memo.title;
  return memo.kind === "markdown" ? t("Untitled note") : t("Untitled command");
}

/**
 * Compact "last updated" label for memo lists: minutes/hours/days ago, then a
 * plain date. `language` picks the date locale for older entries.
 */
export function formatMemoUpdatedAt(
  updatedAt: number,
  t: TranslateFn,
  language: string,
): string {
  const diffMinutes = Math.floor((Date.now() - updatedAt) / 60_000);
  if (diffMinutes < 1) return t("Just now");
  if (diffMinutes < 60) {
    return t("Updated {n}m ago", { n: diffMinutes });
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return t("Updated {n}h ago", { n: diffHours });
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return t("Updated yesterday");
  if (diffDays < 7) return t("Updated {n}d ago", { n: diffDays });
  const date = new Date(updatedAt).toLocaleDateString(
    language === "zh-CN" ? "zh-CN" : "en-US",
    { month: "short", day: "numeric" },
  );
  return t("Updated {date}", { date });
}
