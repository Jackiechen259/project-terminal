import { memo, useCallback, useMemo } from "react";

import { cn } from "@/lib/utils";
import { useTerminalStore } from "@/stores/terminalStore";

import { TerminalView } from "./TerminalView";

interface TerminalPaneProps {
  tabId: string;
  visible: boolean;
  focused: boolean;
  panePosition: string;
  onSelect: (tabId: string) => void;
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
  onSelect,
}: TerminalPaneProps) {
  const tab = useTerminalStore((state) => state.tabsById[tabId]);
  const updateTab = useTerminalStore((state) => state.updateTab);
  const pending = useMemo(
    () => ({
      projectId: tab?.projectId ?? "",
      profileId: tab?.profileId ?? "",
    }),
    [tab?.profileId, tab?.projectId],
  );
  const select = useCallback(() => {
    if (visible) onSelect(tabId);
  }, [onSelect, tabId, visible]);
  const handleSessionId = useCallback(
    (sessionId: string) => {
      updateTab(tabId, {
        sessionId,
        status: "running",
        exitCode: undefined,
      });
    },
    [tabId, updateTab],
  );
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
      onMouseDown={select}
    >
      <TerminalView
        pending={pending}
        active={visible}
        focused={focused}
        defaultTitle={tab.defaultTitle}
        onFocus={select}
        onSessionId={handleSessionId}
        onExit={handleExit}
        onTitleChange={handleTitleChange}
      />
    </div>
  );
});
