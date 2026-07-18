import { FolderOpen, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";

import { ContextMenu } from "@/components/ui/context-menu";
import { dispatchAppCommand } from "@/lib/appCommands";

interface ProjectContextMenuProps {
  project: { id: string; name: string; type: "local" | "ssh" };
  position: { x: number; y: number };
  onOpen: () => void;
  onRemove: () => void;
  onTestSsh?: () => void;
  onEdit: () => void;
  onOpenExplorer?: () => void;
  onClose: () => void;
}

/** Commands available when a project is right-clicked in the sidebar. */
export function ProjectContextMenu({
  project,
  position,
  onOpen,
  onRemove,
  onTestSsh,
  onEdit,
  onOpenExplorer,
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
        ...(project.type === "ssh" && onTestSsh
          ? [
              {
                label: "Test SSH connection",
                icon: ShieldCheck,
                onSelect: onTestSsh,
              },
            ]
          : []),
        { label: "Edit project", icon: Pencil, onSelect: onEdit },
        ...(project.type === "local" && onOpenExplorer
          ? [
              {
                label: "Open in File Explorer",
                icon: FolderOpen,
                onSelect: onOpenExplorer,
              },
            ]
          : []),
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
