import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronUp, Folder, FolderOpen, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { sshService, type RemoteDirectoryListing } from "@/services";
import { useTranslation } from "@/i18n";

function parentDirectory(path: string) {
  const trimmed = path.replace(/\/+$/, "") || "/";
  if (trimmed === "/") return "/";
  const separator = trimmed.lastIndexOf("/");
  return separator <= 0 ? "/" : trimmed.slice(0, separator);
}

/** Browse folders exposed by a saved SSH connection without creating a project. */
export function RemoteFolderPicker({
  connectionId,
  initialPath,
  onSelect,
}: {
  connectionId: string;
  initialPath: string;
  onSelect: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState(initialPath || "~");
  const [listing, setListing] = useState<RemoteDirectoryListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = useCallback(
    async (nextPath: string) => {
      const id = ++requestId.current;
      setLoading(true);
      setError(null);
      try {
        const result = await sshService.listDirectories(connectionId, nextPath);
        if (id !== requestId.current) return;
        setListing(result);
        setPath(result.path);
      } catch (cause) {
        if (id !== requestId.current) return;
        setError(
          (cause as { message?: string }).message ??
            t("Unable to read remote directories."),
        );
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [connectionId, t],
  );

  useEffect(() => {
    if (!open || !connectionId) return;
    setListing(null);
    void load(initialPath || "~");
    return () => {
      requestId.current += 1;
    };
  }, [connectionId, initialPath, load, open]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="secondary"
        size="icon"
        aria-label={t("Browse remote folders")}
        title={
          connectionId
            ? t("Browse remote folders")
            : t("Choose an SSH connection first")
        }
        disabled={!connectionId}
        onClick={() => setOpen(true)}
      >
        <FolderOpen className="h-4 w-4" />
      </Button>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{t("Browse remote folders")}</DialogTitle>
          <DialogDescription>
            {t(
              "Select a folder on the connected SSH host. Authentication must be available through the saved connection, SSH agent, or SSH config.",
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-3">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void load(path || "~");
            }}
          >
            <Button
              type="button"
              variant="secondary"
              size="icon"
              aria-label={t("Parent remote folder")}
              disabled={loading || !listing || listing.path === "/"}
              onClick={() =>
                listing && void load(parentDirectory(listing.path))
              }
            >
              <ChevronUp className="h-4 w-4" />
            </Button>
            <Input
              aria-label={t("Remote folder path")}
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder={t("~ or /home/user/project")}
            />
            <Button
              type="submit"
              variant="secondary"
              size="icon"
              disabled={loading}
              aria-label={t("Open remote path")}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </form>

          <div className="h-64 overflow-y-auto rounded-md border border-border">
            {loading ? (
              <div className="p-3 text-sm text-muted-foreground">
                {t("Reading remote folders…")}
              </div>
            ) : error ? (
              <div className="p-3 text-sm text-destructive">{error}</div>
            ) : listing?.directories.length ? (
              <div className="p-1">
                {listing.directories.map((directory) => (
                  <Button
                    key={directory.path}
                    type="button"
                    variant="ghost"
                    className="w-full justify-start gap-2"
                    onClick={() => void load(directory.path)}
                  >
                    <Folder className="h-4 w-4 shrink-0" />
                    <span className="truncate">{directory.name}</span>
                  </Button>
                ))}
              </div>
            ) : listing ? (
              <div className="p-3 text-sm text-muted-foreground">
                {t("No subfolders in this directory.")}
              </div>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            {t("Cancel")}
          </Button>
          <Button
            type="button"
            disabled={!listing || loading}
            onClick={() => {
              if (!listing) return;
              onSelect(listing.path);
              setOpen(false);
            }}
          >
            {t("Use this folder")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
