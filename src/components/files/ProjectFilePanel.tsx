import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronUp,
  File,
  FileArchive,
  FileCode2,
  FileText,
  Folder,
  HardDrive,
  LoaderCircle,
  RefreshCw,
  Search,
  Server,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslation, type TranslateFn } from "@/i18n";
import {
  fileService,
  type FrontendError,
  type ProjectFileEntry,
  type ProjectFileListing,
} from "@/services";
import { nativeDialogService, nativeDragDropService } from "@/services/native";
import { useProjectStore } from "@/stores/projectStore";
import { useTerminalStore } from "@/stores/terminalStore";
import { cn } from "@/lib/utils";

const PROJECT_FILE_DRAG_TYPE = "application/x-project-terminal-file";

// Module scope so a listing of thousands of rows does not rebuild these on
// every render.
const CODE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "rs",
  "py",
  "go",
  "java",
  "c",
  "cpp",
  "sh",
]);
const TEXT_EXTENSIONS = new Set([
  "md",
  "txt",
  "json",
  "yaml",
  "yml",
  "toml",
  "xml",
  "csv",
]);
const ARCHIVE_EXTENSIONS = new Set([
  "zip",
  "gz",
  "tar",
  "7z",
  "rar",
  "bz2",
  "xz",
]);

export function ProjectFilePanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLElement>(null);
  const activeProjectId = useTerminalStore((state) => state.activeProjectId);
  const projects = useProjectStore((state) => state.projects);
  const activeProject = projects.find(
    (project) => project.id === activeProjectId,
  );
  const [listing, setListing] = useState<ProjectFileListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [nativeDragOver, setNativeDragOver] = useState(false);
  const [downloadDragOver, setDownloadDragOver] = useState(false);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (path?: string) => {
      if (!activeProjectId) {
        setListing(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        setListing(await fileService.list(activeProjectId, path));
      } catch (cause) {
        setError(
          (cause as FrontendError).message ??
            t("Unable to read project files."),
        );
      } finally {
        setLoading(false);
      }
    },
    [activeProjectId, t],
  );

  useEffect(() => {
    setListing(null);
    setQuery("");
    setMessage(null);
    setError(null);
    void load();
  }, [load]);

  const uploadPaths = useCallback(
    async (paths: string[]) => {
      if (!activeProjectId || !listing || paths.length === 0) return;
      setTransferring(true);
      setError(null);
      setMessage(t("Uploading {count} item(s)…", { count: paths.length }));
      try {
        await fileService.upload(activeProjectId, listing.path, paths);
        setMessage(t("Upload complete."));
        await load(listing.path);
      } catch (cause) {
        setMessage(null);
        setError((cause as FrontendError).message ?? t("Upload failed."));
      } finally {
        setTransferring(false);
      }
    },
    [activeProjectId, listing, load, t],
  );

  const downloadEntry = useCallback(
    async (entry: ProjectFileEntry) => {
      if (!activeProjectId) return;
      const destination = await nativeDialogService.selectDirectory();
      if (!destination) return;
      setTransferring(true);
      setError(null);
      setMessage(t("Downloading {name}…", { name: entry.name }));
      try {
        await fileService.download(
          activeProjectId,
          entry.path,
          destination,
          entry.isDirectory,
        );
        setMessage(t("Downloaded {name}.", { name: entry.name }));
      } catch (cause) {
        setMessage(null);
        setError((cause as FrontendError).message ?? t("Download failed."));
      } finally {
        setTransferring(false);
      }
    },
    [activeProjectId, t],
  );

  useEffect(() => {
    let disposed = false;
    const unlisten = nativeDragDropService.listen((event) => {
      if (disposed || !("position" in event)) {
        if (event.type === "leave") setNativeDragOver(false);
        return;
      }
      const bounds = panelRef.current?.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      const x = event.position.x / scale;
      const y = event.position.y / scale;
      const inside =
        Boolean(bounds) &&
        x >= bounds!.left &&
        x <= bounds!.right &&
        y >= bounds!.top &&
        y <= bounds!.bottom;
      setNativeDragOver(inside);
      if (event.type === "drop") {
        setNativeDragOver(false);
        if (inside) void uploadPaths(event.paths);
      }
    });
    return () => {
      disposed = true;
      void unlisten.then((dispose) => dispose());
    };
  }, [uploadPaths]);

  const filteredEntries = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return listing?.entries ?? [];
    return (listing?.entries ?? []).filter((entry) =>
      entry.name.toLocaleLowerCase().includes(needle),
    );
  }, [listing, query]);

  // Mirrored into refs so every row shares one callback identity and `memo`
  // can bail out. A listing can hold thousands of rows.
  const loadRef = useRef(load);
  loadRef.current = load;
  const downloadEntryRef = useRef(downloadEntry);
  downloadEntryRef.current = downloadEntry;
  const openEntry = useCallback((entry: ProjectFileEntry) => {
    if (entry.isDirectory) void loadRef.current(entry.path);
  }, []);
  const startDownload = useCallback((entry: ProjectFileEntry) => {
    void downloadEntryRef.current(entry);
  }, []);

  const remoteTransfer =
    activeProject?.type === "ssh" || activeProject?.type === "wsl";

  return (
    <aside
      ref={panelRef}
      className="relative flex w-[320px] min-w-[260px] max-w-[38vw] shrink-0 flex-col border-l border-border bg-surface/95"
      aria-label={t("Project files")}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        {activeProject?.type === "ssh" ? (
          <Server className="h-4 w-4 text-primary" />
        ) : (
          <HardDrive className="h-4 w-4 text-primary" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold">
            {t("Project files")}
          </div>
          <div className="truncate text-[10px] text-muted-foreground">
            {activeProject?.name ?? t("No project selected")}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title={t("Hide file sidebar")}
          aria-label={t("Hide file sidebar")}
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </header>

      {activeProject ? (
        <>
          <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={!listing?.parentPath || loading || transferring}
              title={t("Parent folder")}
              aria-label={t("Parent folder")}
              onClick={() =>
                listing?.parentPath && void load(listing.parentPath)
              }
            >
              <ChevronUp className="h-4 w-4" />
            </Button>
            <button
              type="button"
              className="min-w-0 flex-1 truncate rounded px-1.5 py-1 text-left font-mono text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
              title={listing?.path}
              onClick={() => listing && void load(listing.rootPath)}
            >
              {listing?.path ?? t("Loading…")}
            </button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={!listing || loading || transferring}
              title={t("Refresh files")}
              aria-label={t("Refresh files")}
              onClick={() => listing && void load(listing.path)}
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", loading && "animate-spin")}
              />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={!listing || loading || transferring}
              title={t("Upload files")}
              aria-label={t("Upload files")}
              onClick={() => {
                void nativeDialogService
                  .selectFiles()
                  .then((paths) => uploadPaths(paths));
              }}
            >
              <ArrowUpFromLine className="h-3.5 w-3.5" />
            </Button>
          </div>

          <div className="relative shrink-0 px-2 py-2">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("Filter files")}
              aria-label={t("Filter files")}
              className="h-7 pl-8 text-xs"
            />
          </div>

          <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            {loading && !listing ? (
              <EmptyState
                icon={<LoaderCircle className="h-5 w-5 animate-spin" />}
                text={t("Reading project files…")}
              />
            ) : error && !listing ? (
              <EmptyState
                icon={<File className="h-5 w-5" />}
                text={error}
                action={
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void load()}
                  >
                    {t("Try again")}
                  </Button>
                }
              />
            ) : filteredEntries.length === 0 ? (
              <EmptyState
                icon={<Folder className="h-5 w-5" />}
                text={
                  query ? t("No matching files.") : t("This folder is empty.")
                }
              />
            ) : (
              filteredEntries.map((entry) => (
                <FileRow
                  key={entry.path}
                  entry={entry}
                  draggable={remoteTransfer}
                  transferDisabled={transferring}
                  t={t}
                  onOpen={openEntry}
                  onDownload={startDownload}
                />
              ))
            )}
          </div>

          {remoteTransfer ? (
            <div
              className={cn(
                "mx-2 mb-2 flex min-h-12 shrink-0 items-center justify-center gap-2 rounded-md border border-dashed px-3 text-center text-[11px] text-muted-foreground transition-colors",
                downloadDragOver &&
                  "border-primary bg-primary/10 text-foreground",
              )}
              onDragEnter={(event) => {
                if (event.dataTransfer.types.includes(PROJECT_FILE_DRAG_TYPE)) {
                  event.preventDefault();
                  setDownloadDragOver(true);
                }
              }}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes(PROJECT_FILE_DRAG_TYPE)) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                }
              }}
              onDragLeave={() => setDownloadDragOver(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDownloadDragOver(false);
                const encoded = event.dataTransfer.getData(
                  PROJECT_FILE_DRAG_TYPE,
                );
                if (!encoded) return;
                try {
                  void downloadEntry(JSON.parse(encoded) as ProjectFileEntry);
                } catch {
                  setError(t("Download failed."));
                }
              }}
            >
              <ArrowDownToLine className="h-4 w-4 shrink-0" />
              {t("Drag a remote item here to download")}
            </div>
          ) : null}

          {(message || error) && (
            <div
              className={cn(
                "shrink-0 border-t border-border px-3 py-2 text-[11px]",
                error ? "text-destructive" : "text-muted-foreground",
              )}
              role="status"
            >
              {transferring ? (
                <LoaderCircle className="mr-1.5 inline h-3 w-3 animate-spin" />
              ) : null}
              {error ?? message}
            </div>
          )}
        </>
      ) : (
        <EmptyState
          icon={<Folder className="h-5 w-5" />}
          text={t("Select a project to browse its files.")}
        />
      )}

      {nativeDragOver ? (
        <div className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-primary bg-background/90 text-center text-sm font-medium shadow-xl">
          <ArrowUpFromLine className="h-7 w-7 text-primary" />
          {t("Drop files to upload")}
          <span className="max-w-[220px] text-[11px] font-normal text-muted-foreground">
            {listing?.path}
          </span>
        </div>
      ) : null}
    </aside>
  );
}

const FileRow = memo(function FileRow({
  entry,
  draggable,
  transferDisabled,
  t,
  onOpen,
  onDownload,
}: {
  entry: ProjectFileEntry;
  draggable: boolean;
  transferDisabled: boolean;
  /** Passed down rather than pulled from the store per row. */
  t: TranslateFn;
  onOpen: (entry: ProjectFileEntry) => void;
  onDownload: (entry: ProjectFileEntry) => void;
}) {
  return (
    <div
      className="group flex h-8 select-none items-center gap-2 rounded px-2 text-xs hover:bg-accent"
      draggable={draggable && !transferDisabled}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData(
          PROJECT_FILE_DRAG_TYPE,
          JSON.stringify(entry),
        );
        event.dataTransfer.setData("text/plain", entry.path);
      }}
      onDoubleClick={() => onOpen(entry)}
      title={entry.path}
    >
      <FileKindIcon entry={entry} />
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left"
        onClick={entry.isDirectory ? () => onOpen(entry) : undefined}
      >
        {entry.name}
      </button>
      {!entry.isDirectory && entry.size !== undefined ? (
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground group-hover:hidden">
          {formatFileSize(entry.size)}
        </span>
      ) : null}
      {draggable ? (
        <button
          type="button"
          className="hidden h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground group-hover:flex"
          title={t("Download")}
          aria-label={t("Download {name}", { name: entry.name })}
          disabled={transferDisabled}
          onClick={() => onDownload(entry)}
        >
          <ArrowDownToLine className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
});

function FileKindIcon({ entry }: { entry: ProjectFileEntry }) {
  if (entry.isDirectory) {
    return <Folder className="h-4 w-4 shrink-0 fill-primary/20 text-primary" />;
  }
  const extension = entry.name.split(".").pop()?.toLocaleLowerCase();
  if (extension) {
    if (CODE_EXTENSIONS.has(extension)) {
      return <FileCode2 className="h-4 w-4 shrink-0 text-sky-400" />;
    }
    if (TEXT_EXTENSIONS.has(extension)) {
      return <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />;
    }
    if (ARCHIVE_EXTENSIONS.has(extension)) {
      return <FileArchive className="h-4 w-4 shrink-0 text-amber-400" />;
    }
  }
  return <File className="h-4 w-4 shrink-0 text-muted-foreground" />;
}

function EmptyState({
  icon,
  text,
  action,
}: {
  icon: React.ReactNode;
  text: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-32 flex-col items-center justify-center gap-2 px-5 text-center text-xs text-muted-foreground">
      {icon}
      <span>{text}</span>
      {action}
    </div>
  );
}

function formatFileSize(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) {
    return `${(bytes / 1_048_576).toFixed(1)} MB`;
  }
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
}
