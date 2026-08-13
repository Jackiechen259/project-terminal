import { useState } from "react";
import { Save, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslation } from "@/i18n";
import { useMemoStore, type CommandMemo } from "@/stores/memoStore";

interface CommandMemoEditorProps {
  projectId: string;
  memo: CommandMemo;
  onClose: () => void;
}

/**
 * Editor for a command memo: title, description, and the command body
 * (monospace, multiline). Fields are drafts until Save commits them to the
 * store; closing with unsaved changes asks first.
 */
export function CommandMemoEditor({
  projectId,
  memo,
  onClose,
}: CommandMemoEditorProps) {
  const { t } = useTranslation();
  const updateCommandMemo = useMemoStore((s) => s.updateCommandMemo);
  const [title, setTitle] = useState(memo.title);
  const [description, setDescription] = useState(memo.description);
  const [command, setCommand] = useState(memo.command);
  const [dirty, setDirty] = useState(false);

  const handleClose = () => {
    if (
      dirty &&
      !window.confirm(t("Discard unsaved changes?"))
    ) {
      return;
    }
    onClose();
  };

  const save = () => {
    updateCommandMemo(projectId, memo.id, { title, description, command });
    setDirty(false);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">
          {memo.title || t("Untitled command")}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          title={t("Close command editor")}
          aria-label={t("Close command editor")}
          onClick={handleClose}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="app-scrollbar flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="memo-command-title" className="text-[11px] text-muted-foreground">
            {t("Title")}
          </Label>
          <Input
            id="memo-command-title"
            value={title}
            placeholder={t("Development server")}
            className="h-8 text-xs"
            onChange={(event) => {
              setTitle(event.target.value);
              setDirty(true);
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="memo-command-description" className="text-[11px] text-muted-foreground">
            {t("Description")}
          </Label>
          <Input
            id="memo-command-description"
            value={description}
            placeholder={t("What this command does")}
            className="h-8 text-xs"
            onChange={(event) => {
              setDescription(event.target.value);
              setDirty(true);
            }}
          />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-1">
          <Label htmlFor="memo-command-body" className="text-[11px] text-muted-foreground">
            {t("Command")}
          </Label>
          <textarea
            id="memo-command-body"
            value={command}
            placeholder={t("pnpm dev")}
            spellCheck={false}
            className="min-h-28 flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs leading-relaxed text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onChange={(event) => {
              setCommand(event.target.value);
              setDirty(true);
            }}
          />
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-[11px]"
          onClick={handleClose}
        >
          {t("Cancel")}
        </Button>
        <Button
          variant="default"
          size="sm"
          className="h-7 text-[11px]"
          disabled={!dirty}
          onClick={save}
        >
          <Save className="h-3 w-3" />
          {t("Save")}
        </Button>
      </div>
    </div>
  );
}
