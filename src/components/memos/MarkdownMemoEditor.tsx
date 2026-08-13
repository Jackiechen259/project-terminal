import { useState } from "react";
import { Eye, PencilLine, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";
import { useMemoStore, type MarkdownMemo } from "@/stores/memoStore";

import { MarkdownMemoPreview } from "./MarkdownMemoPreview";

interface MarkdownMemoEditorProps {
  projectId: string;
  memo: MarkdownMemo;
  onClose: () => void;
}

/**
 * Title + body editor for a markdown memo. Every change goes straight into
 * the Zustand store; the throttled persistence layer handles the debounce, so
 * there is no second autosave timer here. Edit/Preview toggle the body view.
 */
export function MarkdownMemoEditor({
  projectId,
  memo,
  onClose,
}: MarkdownMemoEditorProps) {
  const { t } = useTranslation();
  const updateMarkdownMemo = useMemoStore((s) => s.updateMarkdownMemo);
  const [previewing, setPreviewing] = useState(false);
  const [title, setTitle] = useState(memo.title);
  const [content, setContent] = useState(memo.content);

  const commit = (patch: { title?: string; content?: string }) => {
    updateMarkdownMemo(projectId, memo.id, patch);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Input
          value={title}
          placeholder={t("Untitled note")}
          aria-label={t("Note title")}
          className="h-7 flex-1 rounded-md border-transparent bg-transparent px-1.5 text-xs font-semibold focus-visible:border-ring focus-visible:bg-transparent"
          onChange={(event) => {
            setTitle(event.target.value);
            commit({ title: event.target.value });
          }}
        />
        <div
          className="flex shrink-0 items-center rounded-md border border-border p-0.5"
          role="tablist"
          aria-label={t("Note view")}
        >
          <button
            type="button"
            role="tab"
            aria-selected={!previewing}
            className={cn(
              "flex h-6 items-center gap-1 rounded px-2 text-[11px] transition-colors",
              !previewing
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setPreviewing(false)}
          >
            <PencilLine className="h-3 w-3" />
            {t("Edit")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={previewing}
            className={cn(
              "flex h-6 items-center gap-1 rounded px-2 text-[11px] transition-colors",
              previewing
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setPreviewing(true)}
          >
            <Eye className="h-3 w-3" />
            {t("Preview")}
          </button>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          title={t("Close note")}
          aria-label={t("Close note")}
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      {previewing ? (
        <MarkdownMemoPreview content={content} />
      ) : (
        <textarea
          value={content}
          placeholder={t("Write in Markdown…")}
          aria-label={t("Note content")}
          spellCheck={false}
          className="app-scrollbar min-h-0 flex-1 resize-none bg-transparent px-4 py-3 text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none"
          onChange={(event) => {
            setContent(event.target.value);
            commit({ content: event.target.value });
          }}
        />
      )}
    </div>
  );
}
