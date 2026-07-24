import { memo, useCallback, type CSSProperties } from "react";

import { cn } from "@/lib/utils";
import { useTerminalStore } from "@/stores/terminalStore";

import { TerminalView } from "./TerminalView";

interface TerminalPaneProps {
  tabId: string;
  visible: boolean;
  focused: boolean;
  panePosition: string;
  style?: CSSProperties;
  onSelect: (tabId: string) => void;
  onRestart: (tabId: string) => void;
}

/**
 * Isolates a live xterm instance from workspace-level updates. A title or
 * session status change now reconciles only this pane instead of every mounted
 * terminal across every project.
 */
export const TerminalPane = memo(function TerminalPane({
  tabId,
  visible,
  focused,
  panePosition,
  style,
  onSelect,
  onRestart,
}: TerminalPaneProps) {
  const tab = useTerminalStore((state) => state.tabsById[tabId]);
  const updateTab = useTerminalStore((state) => state.updateTab);
  const select = useCallback(() => {
    if (visible) onSelect(tabId);
  }, [onSelect, tabId, visible]);
  const handleExit = useCallback(
    (code: number | null, status: "exited" | "error" = "exited") => {
      updateTab(tabId, { status, exitCode: code ?? undefined });
    },
    [tabId, updateTab],
  );
  const handleTitleChange = useCallback(
    (title: string) => updateTab(tabId, { title }),
    [tabId, updateTab],
  );

  if (!tab) return null;

  return (
    <div
      className={cn(
        "absolute min-h-0 min-w-0",
        visible ? panePosition : "hidden",
      )}
      style={style}
      onMouseDown={select}
    >
      {tab.sessionId ? (
        <TerminalView
          sessionId={tab.sessionId}
          active={visible}
          focused={focused}
          defaultTitle={tab.defaultTitle}
          onFocus={select}
          onExit={handleExit}
          onTitleChange={handleTitleChange}
        />
      ) : (
        <div className="flex h-full items-center justify-center bg-background">
          <button
            type="button"
            className="rounded-md border border-border bg-surface px-4 py-3 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
            onClick={() => onRestart(tabId)}
          >
            Session ended — click to restart
          </button>
        </div>
      )}
    </div>
  );
});
