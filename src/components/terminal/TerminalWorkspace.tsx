import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

/**
 * Terminal workspace placeholder: tab strip + terminal area. Phase 3 wires
 * real PTY sessions and Phase 4 wires the project-scoped tab group store.
 */
export function TerminalWorkspace() {
  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-10 items-center gap-1 border-b border-border bg-surface px-2">
        <span className="px-2 text-xs text-muted-foreground">
          No terminals open
        </span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          aria-label="New terminal"
          className="h-7 w-7 text-muted-foreground"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <div className="relative flex-1 bg-background">
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Select or create a project to start a terminal.
        </div>
      </div>
    </section>
  );
}
