import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Eye, PencilLine, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";
import { useMemoStore, type MarkdownMemo } from "@/stores/memoStore";

// react-markdown + remark-gfm pull in the whole unified/remark/micromark
// stack - the single largest dependency in the app after the terminal
// renderer. Nothing needs it until a user opens a note and clicks Preview,
// so it must not be a static import here (this editor sits on the app's
// eager render path via AppLayout -> ProjectMemoPanel).
const LazyMarkdownMemoPreview = lazy(() =>
  import("./MarkdownMemoPreview").then((module) => ({
    default: module.MarkdownMemoPreview,
  })),
);

const COMMIT_DEBOUNCE_MS = 400;

interface MarkdownMemoEditorProps {
  projectId: string;
  memo: MarkdownMemo;
  onClose: () => void;
}

/**
 * Title + body editor for a markdown memo. Local `title`/`content` state
 * updates on every keystroke for a responsive textarea; the store commit is
 * debounced, because `updateMarkdownMemo` rebuilds the project's whole memo
 * array on every call (and that array feeds a `useMemo`-sorted list in
 * ProjectMemoPanel) - both wasted per-keystroke work even while the list
 * itself is hidden behind this editor. The throttled persistence layer still
 * owns backend save timing on top of this; this debounce only reduces how
 * often the Zustand store itself changes. A pending edit is flushed on
 * unmount (closing the note, or switching to a different one - this
 * component is remounted with a new `key` per memo id) so closing quickly
 * never drops the last few keystrokes.
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
  const pendingPatchRef = useRef<{ title?: string; content?: string }>({});
  const commitTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (commitTimerRef.current !== null) {
        window.clearTimeout(commitTimerRef.current);
      }
      if (Object.keys(pendingPatchRef.current).length > 0) {
        updateMarkdownMemo(projectId, memo.id, pendingPatchRef.current);
      }
    };
  }, [memo.id, projectId, updateMarkdownMemo]);

  const commit = (patch: { title?: string; content?: string }) => {
    pendingPatchRef.current = { ...pendingPatchRef.current, ...patch };
    if (commitTimerRef.current !== null) {
      window.clearTimeout(commitTimerRef.current);
    }
    commitTimerRef.current = window.setTimeout(() => {
      commitTimerRef.current = null;
      const patchToCommit = pendingPatchRef.current;
      pendingPatchRef.current = {};
      updateMarkdownMemo(projectId, memo.id, patchToCommit);
    }, COMMIT_DEBOUNCE_MS);
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
        <Suspense fallback={null}>
          <LazyMarkdownMemoPreview content={content} />
        </Suspense>
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
