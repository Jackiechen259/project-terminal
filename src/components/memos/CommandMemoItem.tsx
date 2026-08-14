import {
  Check,
  Copy,
  CornerDownLeft,
  MoreHorizontal,
  Pencil,
  Play,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTranslation } from "@/i18n";
import type { CommandMemo } from "@/stores/memoStore";

import { memoDisplayTitle } from "./memoFormat";

interface CommandMemoItemProps {
  memo: CommandMemo;
  canSend: boolean;
  busy: boolean;
  copied: boolean;
  onInsert: (memo: CommandMemo) => void;
  onRun: (memo: CommandMemo) => void;
  onCopy: (memo: CommandMemo) => void;
  onEdit: (memo: CommandMemo) => void;
  onDelete: (memo: CommandMemo) => void;
}

/**
 * One command memo card: title, description, the command itself, and the
 * Insert / Run actions (disabled without a running terminal for this
 * project). Copy / Edit / Delete live in the overflow menu.
 */
export function CommandMemoItem({
  memo,
  canSend,
  busy,
  copied,
  onInsert,
  onRun,
  onCopy,
  onEdit,
  onDelete,
}: CommandMemoItemProps) {
  const { t } = useTranslation();
  const blockedTitle = t("Open a running terminal for this project first.");

  return (
    <div className="group rounded-md border border-border bg-background/40 px-2.5 py-2 transition-colors hover:border-primary/30">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-foreground">
            {memoDisplayTitle(memo, t)}
          </div>
          {memo.description ? (
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {memo.description}
            </div>
          ) : null}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 text-muted-foreground opacity-70 transition-opacity hover:opacity-100"
              aria-label={copied ? t("Copied") : t("More command actions")}
              title={copied ? t("Copied") : t("More command actions")}
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-ok" />
              ) : (
                <MoreHorizontal className="h-3.5 w-3.5" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={4} className="min-w-36">
            <DropdownMenuItem onSelect={() => onCopy(memo)}>
              <Copy className="h-3.5 w-3.5" />
              {t("Copy")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onEdit(memo)}>
              <Pencil className="h-3.5 w-3.5" />
              {t("Edit")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={() => onDelete(memo)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t("Delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div
        className="mt-1.5 truncate rounded bg-surface-2 px-2 py-1 font-mono text-[11px] text-foreground"
        title={memo.command}
      >
        {memo.command || t("No command")}
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="h-6 flex-1 text-[11px]"
          disabled={!canSend || busy}
          title={canSend ? t("Insert into terminal") : blockedTitle}
          onClick={() => onInsert(memo)}
        >
          <CornerDownLeft className="h-3 w-3" />
          {t("Insert")}
        </Button>
        <Button
          variant="default"
          size="sm"
          className="h-6 flex-1 text-[11px]"
          disabled={!canSend || busy}
          title={canSend ? t("Run in terminal") : blockedTitle}
          onClick={() => onRun(memo)}
        >
          <Play className="h-3 w-3" />
          {t("Run")}
        </Button>
      </div>
    </div>
  );
}
