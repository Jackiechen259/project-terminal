import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  checkForUpdate,
  installUpdate,
  onUpdateCheckRequested,
  type AvailableUpdate,
  type UpdateProgress,
} from "@/services/updater";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTranslation } from "@/i18n";

type InstallState =
  | { kind: "idle" }
  | { kind: "installing"; progress: UpdateProgress }
  | { kind: "error"; message: string };

type CheckState = "idle" | "checking" | "upToDate" | "error";

/** Checks for signed GitHub releases once per application launch. */
export function UpdateManager() {
  const { t } = useTranslation();
  const autoCheckForUpdates = useSettingsStore(
    (state) => state.autoCheckForUpdates,
  );
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [installState, setInstallState] = useState<InstallState>({
    kind: "idle",
  });
  const [checkState, setCheckState] = useState<CheckState>("idle");

  const checkUpdates = useCallback(async (showResult: boolean) => {
    if (showResult) setCheckState("checking");

    try {
      const available = await checkForUpdate();
      if (available) {
        setUpdate(available);
        setCheckState("idle");
      } else if (showResult) {
        setCheckState("upToDate");
      }
    } catch {
      // A missing release, offline launch, or development server must not
      // interrupt normal app startup. Manual checks surface a useful result.
      if (showResult) setCheckState("error");
    }
  }, []);

  useEffect(() => {
    if (autoCheckForUpdates) void checkUpdates(false);
  }, [autoCheckForUpdates, checkUpdates]);

  useEffect(
    () => onUpdateCheckRequested(() => void checkUpdates(true)),
    [checkUpdates],
  );

  async function install() {
    if (!update) return;

    try {
      setInstallState({
        kind: "installing",
        progress: { downloaded: 0 },
      });
      await installUpdate(update, (progress) => {
        setInstallState({ kind: "installing", progress });
      });
    } catch (cause) {
      setInstallState({
        kind: "error",
        message:
          cause instanceof Error
            ? cause.message
            : t("The update could not be installed. Please try again later."),
      });
    }
  }

  const installing = installState.kind === "installing";
  const progress = installing ? installState.progress : undefined;
  const dialogOpen = Boolean(update) || checkState !== "idle";

  return (
    <Dialog
      open={dialogOpen}
      onOpenChange={(open) => {
        if (!open && !installing) {
          setUpdate(null);
          setCheckState("idle");
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {update
              ? t("Update available")
              : checkState === "checking"
                ? t("Checking for updates")
                : checkState === "upToDate"
                  ? t("You’re up to date")
                  : t("Could not check for updates")}
          </DialogTitle>
          <DialogDescription>
            {update
              ? t("Project Terminal {version} is ready to install.", {
                  version: update.version,
                })
              : checkState === "checking"
                ? t("Looking for a newer signed release…")
                : checkState === "upToDate"
                  ? t(
                      "You already have the latest version of Project Terminal.",
                    )
                  : t("Check your internet connection and try again.")}
          </DialogDescription>
        </DialogHeader>

        {update?.body ? (
          <p className="max-h-36 overflow-y-auto whitespace-pre-wrap text-sm text-muted-foreground">
            {update.body}
          </p>
        ) : null}

        {installing ? (
          <div className="space-y-2" aria-live="polite">
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-[width]"
                style={{ width: `${progressPercent(progress)}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t("Downloading {downloaded}{total}…", {
                downloaded: formatBytes(progress?.downloaded ?? 0),
                total: progress?.total
                  ? t(" of {total}", { total: formatBytes(progress.total) })
                  : "",
              })}
            </p>
          </div>
        ) : null}

        {installState.kind === "error" ? (
          <p role="alert" className="text-sm text-destructive">
            {installState.message}
          </p>
        ) : null}

        <DialogFooter>
          {update ? (
            <>
              <Button
                variant="outline"
                disabled={installing}
                onClick={() => setUpdate(null)}
              >
                {t("Later")}
              </Button>
              <Button disabled={installing} onClick={() => void install()}>
                {installing ? t("Installing…") : t("Install and restart")}
              </Button>
            </>
          ) : (
            <Button
              disabled={checkState === "checking"}
              onClick={() => setCheckState("idle")}
            >
              {t("Close")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function progressPercent(progress?: UpdateProgress) {
  if (!progress?.total) return 15;
  return Math.min(
    100,
    Math.round((progress.downloaded / progress.total) * 100),
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
