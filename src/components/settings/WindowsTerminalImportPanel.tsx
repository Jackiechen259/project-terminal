import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import { launchSummary } from "@/lib/profileSummary";
import { cn } from "@/lib/utils";
import type { WindowsTerminalScanResult } from "@/services";

/**
 * Two-step Windows Terminal import: scan on mount, then import only the
 * entries the user ticked. Rendered inside the settings content pane rather
 * than as a nested dialog.
 */
export function WindowsTerminalImportPanel({
  description,
  scan,
  onImport,
  onCancel,
}: {
  description: string;
  scan: () => Promise<WindowsTerminalScanResult>;
  /** Resolves with the message to surface once the import succeeds. */
  onImport: (keys: string[]) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<WindowsTerminalScanResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runScan = useCallback(async () => {
    try {
      setScanning(true);
      setError(null);
      const scanned = await scan();
      setResult(scanned);
      // Pre-tick everything the destination does not already hold.
      setSelected(
        new Set(
          scanned.candidates
            .filter((candidate) => !candidate.alreadyExists)
            .map((candidate) => candidate.key),
        ),
      );
    } catch (cause) {
      setResult(null);
      setError(
        (cause as { message?: string }).message ??
          t("Could not read Windows Terminal settings."),
      );
    } finally {
      setScanning(false);
    }
  }, [scan, t]);

  useEffect(() => {
    void runScan();
  }, [runScan]);

  const selectable = useMemo(
    () => (result?.candidates ?? []).filter((c) => !c.alreadyExists),
    [result],
  );
  const allSelected =
    selectable.length > 0 && selectable.every((c) => selected.has(c.key));

  function toggle(key: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  async function runImport() {
    try {
      setImporting(true);
      setError(null);
      await onImport([...selected]);
    } catch (cause) {
      setError(
        (cause as { message?: string }).message ??
          t("Could not import from Windows Terminal."),
      );
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold">
          {t("Import from Windows Terminal")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>

      {scanning ? (
        <p className="py-6 text-sm text-muted-foreground">
          {t("Scanning Windows Terminal…")}
        </p>
      ) : null}

      {!scanning && result && result.candidates.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">
          {t("Windows Terminal has no profiles that can be imported.")}
        </p>
      ) : null}

      {!scanning && result && result.candidates.length > 0 ? (
        <>
          <div className="flex items-center justify-between border-b pb-2">
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-input accent-primary"
                checked={allSelected}
                disabled={selectable.length === 0}
                onChange={() =>
                  setSelected(
                    allSelected
                      ? new Set()
                      : new Set(selectable.map((c) => c.key)),
                  )
                }
              />
              {t("Select all")}
            </label>
            <span className="text-xs text-muted-foreground">
              {t("{count} selected", { count: selected.size })}
            </span>
          </div>

          <div className="app-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto">
            {result.candidates.map((candidate) => (
              <label
                key={candidate.key}
                className={cn(
                  "flex items-start gap-3 rounded-md px-2 py-2 text-sm",
                  candidate.alreadyExists
                    ? "opacity-60"
                    : "cursor-pointer hover:bg-accent",
                )}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
                  checked={selected.has(candidate.key)}
                  disabled={candidate.alreadyExists}
                  onChange={() => toggle(candidate.key)}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">
                      {candidate.name}
                    </span>
                    {candidate.isWindowsTerminalDefault ? (
                      <span className="rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                        {t("Windows Terminal default")}
                      </span>
                    ) : null}
                    {candidate.alreadyExists ? (
                      <span className="rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                        {t("Already imported")}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                    {launchSummary(candidate)}
                  </span>
                </span>
              </label>
            ))}
          </div>

          {result.skippedCount ? (
            <p className="text-xs text-muted-foreground">
              {t("Skipped {count} hidden or unsupported entries.", {
                count: result.skippedCount,
              })}
            </p>
          ) : null}
        </>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}

      <div className="flex items-center justify-between border-t pt-4">
        <Button variant="ghost" onClick={onCancel} disabled={importing}>
          <ChevronLeft className="h-4 w-4" /> {t("Cancel")}
        </Button>
        <div className="flex gap-2">
          {error && !result ? (
            <Button variant="outline" onClick={() => void runScan()}>
              {t("Retry")}
            </Button>
          ) : null}
          <Button
            onClick={() => void runImport()}
            disabled={importing || scanning || selected.size === 0}
          >
            {importing ? t("Importing…") : t("Import selected")}
          </Button>
        </div>
      </div>
    </div>
  );
}
