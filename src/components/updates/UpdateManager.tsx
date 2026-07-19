import { useEffect, useState } from "react";

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
  type AvailableUpdate,
  type UpdateProgress,
} from "@/services/updater";

type InstallState =
  | { kind: "idle" }
  | { kind: "installing"; progress: UpdateProgress }
  | { kind: "error"; message: string };

/** Checks for signed GitHub releases once per application launch. */
export function UpdateManager() {
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [installState, setInstallState] = useState<InstallState>({
    kind: "idle",
  });

  useEffect(() => {
    let cancelled = false;

    void checkForUpdate()
      .then((available) => {
        if (!cancelled && available) setUpdate(available);
      })
      // A missing release, offline launch, or development server must not
      // interrupt normal app startup. The updater will try again next launch.
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

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
            : "The update could not be installed. Please try again later.",
      });
    }
  }

  const installing = installState.kind === "installing";
  const progress = installing ? installState.progress : undefined;

  return (
    <Dialog
      open={Boolean(update)}
      onOpenChange={(open) => {
        if (!open && !installing) setUpdate(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update available</DialogTitle>
          <DialogDescription>
            Project Terminal {update?.version} is ready to install.
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
              Downloading {formatBytes(progress?.downloaded ?? 0)}
              {progress?.total ? ` of ${formatBytes(progress.total)}` : ""}…
            </p>
          </div>
        ) : null}

        {installState.kind === "error" ? (
          <p role="alert" className="text-sm text-destructive">
            {installState.message}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            disabled={installing}
            onClick={() => setUpdate(null)}
          >
            Later
          </Button>
          <Button disabled={installing} onClick={() => void install()}>
            {installing ? "Installing…" : "Install and restart"}
          </Button>
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
