import { Button } from "@/components/ui/button";
import { Folder, Plus, Server, Settings } from "lucide-react";

/**
 * Sidebar placeholder. Phase 2 will render saved projects from the project
 * store; for now it shows a static header, empty hint, and add/settings
 * buttons wired through shadcn/ui primitives.
 */
export function ProjectSidebar() {
  return (
    <aside
      className="flex w-[260px] shrink-0 flex-col border-r border-border bg-surface"
      aria-label="Projects"
    >
      <header className="flex h-11 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Projects
        </span>
      </header>

      <div className="flex flex-1 flex-col gap-1 overflow-y-auto p-2 no-scrollbar">
        <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          No projects yet.
          <br />
          Use the + button to add one.
        </div>

        <PlaceholderProject label="Local Project A" kind="local" />
        <PlaceholderProject label="SSH: Server A" kind="ssh" />
      </div>

      <footer className="flex flex-row gap-1 border-t border-border p-2">
        <Button variant="secondary" size="sm" className="flex-1">
          <Plus className="h-3.5 w-3.5" />
          Add Project
        </Button>
        <Button variant="secondary" size="icon" aria-label="Settings">
          <Settings className="h-4 w-4" />
        </Button>
      </footer>
    </aside>
  );
}

function PlaceholderProject({
  label,
  kind,
}: {
  label: string;
  kind: "local" | "ssh";
}) {
  const Icon = kind === "local" ? Folder : Server;
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground">
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{label}</span>
    </div>
  );
}
