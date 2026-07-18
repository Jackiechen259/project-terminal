import { FolderOpen, Plus, Trash2 } from "lucide-react";

import { ContextMenu } from "@/components/ui/context-menu";
import { dispatchAppCommand } from "@/lib/appCommands";

interface ProjectContextMenuProps {
  project: { id: string; name: string };
  position: { x: number; y: number };
  onOpen: () => void;
  onRemove: () => void;
  onClose: () => void;
}

/** Commands available when a project is right-clicked in the sidebar. */
export function ProjectContextMenu({
  project,
  position,
  onOpen,
  onRemove,
  onClose,
}: ProjectContextMenuProps) {
  return (
    <ContextMenu
      position={position}
      onClose={onClose}
      items={[
        { label: "Open project", icon: FolderOpen, onSelect: onOpen },
        {
          label: "New terminal",
          shortcut: "Ctrl+Shift+T",
          icon: Plus,
          onSelect: () =>
            dispatchAppCommand({ type: "new-terminal", projectId: project.id }),
        },
        {
          label: "Remove project",
          icon: Trash2,
          destructive: true,
          onSelect: onRemove,
        },
      ]}
    />
  );
}
