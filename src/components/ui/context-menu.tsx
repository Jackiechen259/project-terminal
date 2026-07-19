import { useEffect, useRef } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface ContextMenuItem {
  label: string;
  shortcut?: string;
  icon?: LucideIcon;
  disabled?: boolean;
  destructive?: boolean;
  onSelect: () => void;
}

interface ContextMenuProps {
  position: { x: number; y: number };
  items: ContextMenuItem[];
  onClose: () => void;
}

/**
 * Small application-owned context menu. Rendering it in the webview keeps
 * WebView2's browser menu out of the terminal and lets every surface expose
 * commands that match the desktop app.
 */
export function ContextMenu({ position, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const dismissOnPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const dismissOnKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    document.addEventListener("pointerdown", dismissOnPointerDown);
    document.addEventListener("keydown", dismissOnKeyDown);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("pointerdown", dismissOnPointerDown);
      document.removeEventListener("keydown", dismissOnKeyDown);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Application context menu"
      className="fixed z-50 min-w-48 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg"
      style={{ left: position.x, top: position.y }}
    >
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={cn(
              "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus:bg-accent disabled:pointer-events-none disabled:opacity-50",
              item.destructive &&
                "text-destructive hover:bg-destructive/10 focus:bg-destructive/10",
            )}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {Icon ? <Icon className="h-4 w-4 shrink-0" /> : null}
            <span className="flex-1">{item.label}</span>
            {item.shortcut ? (
              <span className="text-xs tracking-wider text-muted-foreground">
                {item.shortcut}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
