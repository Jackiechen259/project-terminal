import { FileText, Trash2 } from "lucide-react";

import { useTranslation } from "@/i18n";
import type { CommandMemo, ProjectMemo } from "@/stores/memoStore";

import { CommandMemoItem } from "./CommandMemoItem";
import { formatMemoUpdatedAt, memoDisplayTitle } from "./memoFormat";

interface MemoListProps {
  memos: readonly ProjectMemo[];
  /** Which kind this list shows; both kinds are never rendered at once. */
  kind: "markdown" | "command";
  language: string;
  canSend: boolean;
  busyId: string | null;
  copiedId: string | null;
  onOpen: (memo: ProjectMemo) => void;
  onDelete: (memo: ProjectMemo) => void;
  onInsert: (memo: CommandMemo) => void;
  onRun: (memo: CommandMemo) => void;
  onCopy: (memo: CommandMemo) => void;
  onEdit: (memo: CommandMemo) => void;
}

/**
 * Sorted memo list for one tab. Markdown memos render as compact rows;
 * command memos render as action cards.
 */
export function MemoList({
  memos,
  kind,
  language,
  canSend,
  busyId,
  copiedId,
  onOpen,
  onDelete,
  onInsert,
  onRun,
  onCopy,
  onEdit,
}: MemoListProps) {
  const { t } = useTranslation();

  if (memos.length === 0) {
    return (
      <div className="flex min-h-32 flex-col items-center justify-center gap-2 px-5 text-center text-xs text-muted-foreground">
        <FileText className="h-5 w-5" />
        <span>
          {kind === "markdown" ? t("No notes yet") : t("No commands yet")}
        </span>
        <span>{t("Use the + button to add one.")}</span>
      </div>
    );
  }

  if (kind === "command") {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 py-2">
        {memos.map((memo) =>
          memo.kind === "command" ? (
            <CommandMemoItem
              key={memo.id}
              memo={memo}
              canSend={canSend}
              busy={busyId === memo.id}
              copied={copiedId === memo.id}
              onInsert={onInsert}
              onRun={onRun}
              onCopy={onCopy}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ) : null,
        )}
      </div>
    );
  }

  return (
    <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
      {memos.map((memo) => (
        <div
          key={memo.id}
          role="button"
          tabIndex={0}
          className="group flex cursor-default items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onOpen(memo)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onOpen(memo);
            }
          }}
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-foreground">
              {memoDisplayTitle(memo, t)}
            </div>
            <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
              {memo.kind === "markdown" && memo.content.trim()
                ? memo.content.replace(/\s+/g, " ").trim()
                : formatMemoUpdatedAt(memo.updatedAt, t, language)}
            </div>
            <div className="text-[10px] text-muted-foreground/70">
              {formatMemoUpdatedAt(memo.updatedAt, t, language)}
            </div>
          </div>
          <button
            type="button"
            className="hidden h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-destructive group-hover:flex"
            title={t("Delete memo")}
            aria-label={t("Delete memo")}
            onClick={(event) => {
              event.stopPropagation();
              onDelete(memo);
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
