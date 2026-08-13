import { useEffect, useMemo, useState } from "react";
import { FileText, NotebookPen, Plus, TerminalSquare, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/stores/projectStore";
import {
  EMPTY_MEMOS,
  useMemoStore,
  type CommandMemo,
  type ProjectMemo,
} from "@/stores/memoStore";
import { useTerminalStore } from "@/stores/terminalStore";

import { CommandMemoEditor } from "./CommandMemoEditor";
import {
  copyTextToClipboard,
  insertCommand,
  runCommand,
} from "./commandExecution";
import { MarkdownMemoEditor } from "./MarkdownMemoEditor";
import { MemoList } from "./MemoList";
import { memoDisplayTitle } from "./memoFormat";
import {
  isMemoTerminalRunnable,
  useMemoTerminalTarget,
} from "./resolveActiveMemoTerminal";

type MemoTab = "notes" | "commands";

interface ProjectMemoPanelProps {
  onClose: () => void;
  /** Kept mounted (but hidden) so switching Files/Memo preserves state. */
  hidden?: boolean;
}

/**
 * Memo sidebar: per-project notes and commands.
 *
 * Notes autosave straight into the memo store (the throttled persistence
 * layer debounces). Commands are edited with an explicit Save, and executed
 * through the project's existing, focused terminal session - never a spawned
 * shell.
 */
export function ProjectMemoPanel({ onClose, hidden = false }: ProjectMemoPanelProps) {
  const { t, language } = useTranslation();
  const activeProjectId = useTerminalStore((state) => state.activeProjectId);
  const projects = useProjectStore((state) => state.projects);
  const activeProject = projects.find(
    (project) => project.id === activeProjectId,
  );
  const memos = useMemoStore((state) =>
    activeProjectId
      ? (state.memosByProjectId[activeProjectId] ?? EMPTY_MEMOS)
      : EMPTY_MEMOS,
  );
  const createMarkdownMemo = useMemoStore((state) => state.createMarkdownMemo);
  const createCommandMemo = useMemoStore((state) => state.createCommandMemo);
  const deleteMemo = useMemoStore((state) => state.deleteMemo);

  const [tab, setTab] = useState<MemoTab>("notes");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProjectMemo | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const targetTab = useMemoTerminalTarget(activeProjectId);
  const canSend = isMemoTerminalRunnable(targetTab);

  // A different project's memos are never shown: close any editor opened for
  // the previous project.
  useEffect(() => {
    setEditingId(null);
    setPendingDelete(null);
    setActionError(null);
  }, [activeProjectId]);

  // Non-blocking error feedback: visible for a few seconds, then gone.
  useEffect(() => {
    if (!actionError) return;
    const timer = window.setTimeout(() => setActionError(null), 5000);
    return () => window.clearTimeout(timer);
  }, [actionError]);

  useEffect(() => {
    if (!copiedId) return;
    const timer = window.setTimeout(() => setCopiedId(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copiedId]);

  const sortedMemos = useMemo(
    () =>
      [...memos].sort((a, b) => b.updatedAt - a.updatedAt),
    [memos],
  );
  const notes = useMemo(
    () => sortedMemos.filter((memo) => memo.kind === "markdown"),
    [sortedMemos],
  );
  const commands = useMemo(
    () => sortedMemos.filter((memo) => memo.kind === "command"),
    [sortedMemos],
  );
  const visibleMemos = tab === "notes" ? notes : commands;

  const editingMemo = useMemo(
    () =>
      editingId
        ? (memos.find((memo) => memo.id === editingId) ?? null)
        : null,
    [editingId, memos],
  );

  const selectTab = (next: MemoTab) => {
    setTab(next);
    setEditingId(null);
  };

  const handleNew = () => {
    if (!activeProjectId) return;
    const id =
      tab === "notes"
        ? createMarkdownMemo(activeProjectId)
        : createCommandMemo(activeProjectId);
    setEditingId(id);
  };

  const handleInsert = async (memo: CommandMemo) => {
    if (!canSend || !targetTab?.sessionId) return;
    setActionError(null);
    setBusyId(memo.id);
    try {
      await insertCommand(targetTab.sessionId, memo.command);
    } catch {
      setActionError(t("Could not send command to terminal."));
    } finally {
      setBusyId(null);
    }
  };

  const handleRun = async (memo: CommandMemo) => {
    if (!canSend || !targetTab?.sessionId) return;
    setActionError(null);
    setBusyId(memo.id);
    try {
      await runCommand(targetTab.sessionId, memo.command);
    } catch {
      setActionError(t("Could not send command to terminal."));
    } finally {
      setBusyId(null);
    }
  };

  const handleCopy = async (memo: CommandMemo) => {
    const ok = await copyTextToClipboard(memo.command);
    if (ok) {
      setCopiedId(memo.id);
    } else {
      setActionError(t("Could not copy command."));
    }
  };

  const confirmDelete = () => {
    if (!activeProjectId || !pendingDelete) return;
    deleteMemo(activeProjectId, pendingDelete.id);
    if (editingId === pendingDelete.id) setEditingId(null);
    setPendingDelete(null);
  };

  return (
    <aside
      className={cn(
        "relative flex w-[320px] min-w-[260px] max-w-[38vw] shrink-0 flex-col border-l border-border bg-surface/95",
        hidden && "hidden",
      )}
      aria-label={t("Memo")}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <NotebookPen className="h-4 w-4 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold">{t("Memo")}</div>
          <div className="truncate text-[10px] text-muted-foreground">
            {activeProject?.name ?? t("No project selected")}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title={t("Hide memo sidebar")}
          aria-label={t("Hide memo sidebar")}
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </header>

      {!activeProject ? (
        <div className="flex min-h-32 flex-col items-center justify-center gap-2 px-5 text-center text-xs text-muted-foreground">
          <NotebookPen className="h-5 w-5" />
          <span>{t("Select a project to view its memos.")}</span>
        </div>
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-1.5">
            <div
              className="flex min-w-0 flex-1 items-center rounded-md border border-border p-0.5"
              role="tablist"
              aria-label={t("Memo type")}
            >
              <button
                type="button"
                role="tab"
                aria-selected={tab === "notes"}
                className={cn(
                  "flex h-6 min-w-0 flex-1 items-center justify-center gap-1 rounded px-2 text-[11px] transition-colors",
                  tab === "notes"
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => selectTab("notes")}
              >
                <FileText className="h-3 w-3 shrink-0" />
                <span className="truncate">{t("Notes")}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "commands"}
                className={cn(
                  "flex h-6 min-w-0 flex-1 items-center justify-center gap-1 rounded px-2 text-[11px] transition-colors",
                  tab === "commands"
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => selectTab("commands")}
              >
                <TerminalSquare className="h-3 w-3 shrink-0" />
                <span className="truncate">{t("Commands")}</span>
              </button>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 text-muted-foreground"
              title={
                tab === "notes" ? t("New note") : t("New command")
              }
              aria-label={tab === "notes" ? t("New note") : t("New command")}
              onClick={handleNew}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>

          {actionError ? (
            <div
              role="alert"
              className="flex shrink-0 items-center gap-2 border-b border-border bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive"
            >
              <span className="min-w-0 flex-1 truncate">{actionError}</span>
              <button
                type="button"
                className="shrink-0 rounded p-0.5 transition-colors hover:bg-destructive/20"
                aria-label={t("Dismiss")}
                onClick={() => setActionError(null)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : null}

          {tab === "commands" && commands.length > 0 && !canSend ? (
            <div className="shrink-0 border-b border-border bg-warn/10 px-3 py-1.5 text-[11px] text-warn">
              {t("Open a running terminal for this project first.")}
            </div>
          ) : null}

          {editingMemo ? (
            editingMemo.kind === "markdown" ? (
              <MarkdownMemoEditor
                key={editingMemo.id}
                projectId={activeProject.id}
                memo={editingMemo}
                onClose={() => setEditingId(null)}
              />
            ) : (
              <CommandMemoEditor
                key={editingMemo.id}
                projectId={activeProject.id}
                memo={editingMemo}
                onClose={() => setEditingId(null)}
              />
            )
          ) : (
            <MemoList
              memos={visibleMemos}
              kind={tab === "notes" ? "markdown" : "command"}
              language={language}
              canSend={canSend}
              busyId={busyId}
              copiedId={copiedId}
              onOpen={(memo) => setEditingId(memo.id)}
              onDelete={setPendingDelete}
              onInsert={(memo) => void handleInsert(memo)}
              onRun={(memo) => void handleRun(memo)}
              onCopy={(memo) => void handleCopy(memo)}
              onEdit={(memo) => setEditingId(memo.id)}
            />
          )}
        </>
      )}

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <DialogContent className="max-w-[420px] gap-0 overflow-hidden p-0">
          <DialogHeader className="space-y-0 border-b border-border bg-surface px-5 py-4 text-left">
            <DialogTitle className="text-[15px]">
              {t("Delete memo?")}
            </DialogTitle>
            <DialogDescription className="pt-1 text-xs leading-relaxed">
              {pendingDelete
                ? t('The memo "{title}" will be permanently removed.', {
                    title: memoDisplayTitle(pendingDelete, t),
                  })
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 border-t border-border bg-surface px-4 py-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPendingDelete(null)}
            >
              {t("Cancel")}
            </Button>
            <Button variant="destructive" size="sm" onClick={confirmDelete}>
              {t("Delete")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
