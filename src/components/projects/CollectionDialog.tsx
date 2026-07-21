import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCollectionStore } from "@/stores/collectionStore";
import type { ProjectCollection } from "@/stores/collectionStore";

/**
 * Create or rename a project collection. When `collection` is provided the
 * dialog operates in rename mode and is controlled by `openState`/
 * `onOpenChange`. Otherwise it is in create mode and is triggered by the
 * `trigger` element.
 */
export function CollectionDialog({
  trigger,
  collection,
  openState,
  onOpenChange,
}: {
  trigger?: React.ReactNode;
  collection?: ProjectCollection;
  openState?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const isRename = Boolean(collection);
  const [internalOpen, setInternalOpen] = useState(false);
  const open = openState ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const createCollection = useCollectionStore((s) => s.createCollection);
  const renameCollection = useCollectionStore((s) => s.renameCollection);

  useEffect(() => {
    if (!open) return;
    setName(collection?.name ?? "");
    setSubmitting(false);
    // Focus the input after the dialog paints.
    const id = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, [open, collection]);

  function reset() {
    setName("");
    setSubmitting(false);
  }

  async function handleSubmit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      if (collection) {
        renameCollection(collection.id, trimmed);
      } else {
        createCollection(trimmed);
      }
      setOpen(false);
      reset();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>
            {isRename ? "Rename collection" : "New collection"}
          </DialogTitle>
          <DialogDescription>
            Group related projects together. Drag projects into the collection
            from the sidebar.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 py-2">
          <Label htmlFor="collection-name">Collection name</Label>
          <Input
            ref={inputRef}
            id="collection-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleSubmit();
              }
            }}
          />
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || !name.trim()}>
            {submitting ? "Saving..." : isRename ? "Save" : "Create collection"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
