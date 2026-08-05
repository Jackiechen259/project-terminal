import { lazy, memo, Suspense, useCallback, type CSSProperties } from "react";
import { LoaderCircle, RotateCcw } from "lucide-react";

import { useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";
import { useTerminalStore } from "@/stores/terminalStore";

import { loadTerminalView } from "./terminalViewLoader";

const LazyTerminalView = lazy(() =>
  loadTerminalView().then((module) => ({ default: module.TerminalView })),
);

interface TerminalPaneProps {
  tabId: string;
  visible: boolean;
  focused: boolean;
  /** True while this pane shares the workspace with other visible panes. */
  splitActive?: boolean;
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
  splitActive = false,
  panePosition,
  style,
  onSelect,
  onRestart,
}: TerminalPaneProps) {
  const tab = useTerminalStore((state) => state.tabsById[tabId]);
  const updateTab = useTerminalStore((state) => state.updateTab);
  const { t } = useTranslation();
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
        // Ring the pane the keyboard is talking to. `cursorInactiveStyle`
        // already outlines the cursor in the others; this reads at a glance
        // from across the window, which a cursor does not.
        splitActive && focused && "ring-1 ring-inset ring-primary/40",
      )}
      style={style}
      onMouseDown={select}
    >
      {tab.sessionId ? (
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center bg-background">
              <LoaderCircle className="h-6 w-6 animate-spin text-primary" />
            </div>
          }
        >
          <LazyTerminalView
            sessionId={tab.sessionId}
            active={visible}
            focused={focused}
            defaultTitle={tab.defaultTitle}
            onFocus={select}
            onExit={handleExit}
            onTitleChange={handleTitleChange}
          />
        </Suspense>
      ) : ["starting", "connecting", "initializing"].includes(tab.status) ? (
        <div
          role="status"
          aria-live="polite"
          className="flex h-full flex-col items-center justify-center gap-3 bg-background text-sm text-muted-foreground"
        >
          <LoaderCircle className="h-6 w-6 animate-spin text-primary" />
          <span>{t("Starting terminal…")}</span>
          <span className="text-xs opacity-70">{tab.defaultTitle}</span>
        </div>
      ) : (
        <div className="flex h-full items-center justify-center bg-background">
          <button
            type="button"
            className="flex items-center gap-2 rounded-md border border-border bg-surface px-4 py-3 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onRestart(tabId)}
          >
            <RotateCcw className="h-4 w-4" />
            {tab.status === "error"
              ? t("Terminal failed to start — click to retry")
              : t("Session ended — click to restart")}
          </button>
        </div>
      )}
      {splitActive && !focused ? (
        // A scrim rather than `opacity` on the pane itself: opacity promotes
        // the xterm canvas into its own compositing layer, which can cost the
        // WebGL fast path. Not focusable and click-through, so selecting this
        // pane still works.
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-background/20"
        />
      ) : null}
    </div>
  );
});
