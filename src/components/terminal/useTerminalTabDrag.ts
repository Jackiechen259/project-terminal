import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useRef,
  useState,
} from "react";

import { useDragPreviewPosition } from "@/lib/useDragPreviewPosition";
import { focusedPane, paneTabIds } from "@/lib/paneLayout";
import type {
  TerminalSplitDirection,
  TerminalSplitView,
  TerminalTab,
} from "@/types";

export type TerminalDropZone = "left" | "right" | "top" | "bottom";
type TabDropPosition = "before" | "after";
export type TabDropTarget = {
  tabId: string;
  position: TabDropPosition;
};

interface TerminalTabDragOptions {
  activeProjectId: string | null;
  activeTabId: string | null;
  tabIds: string[];
  tabsById: Record<string, TerminalTab>;
  splitView?: TerminalSplitView;
  onSelectTab: (tabId: string) => void;
  setActiveTab: (projectId: string, tabId: string) => void;
  setSplitView: (
    projectId: string,
    tabIds: [string, string],
    direction: TerminalSplitDirection,
  ) => void;
  clearSplitView: (projectId: string) => void;
  reorderTab: (
    projectId: string,
    tabId: string,
    targetTabId: string,
    position: TabDropPosition,
  ) => void;
}

/**
 * Pointer-driven tab reorder/split behavior.
 *
 * The workspace owns terminal lifecycle and rendering; this hook owns the DOM
 * hit-testing and transient pointer state required by drag interactions.
 */
export function useTerminalTabDrag({
  activeProjectId,
  activeTabId,
  tabIds,
  tabsById,
  splitView,
  onSelectTab,
  setActiveTab,
  setSplitView,
  clearSplitView,
  reorderTab,
}: TerminalTabDragOptions) {
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [dropZone, setDropZone] = useState<TerminalDropZone | null>(null);
  const [tabDropTarget, setTabDropTarget] =
    useState<TabDropTarget | null>(null);
  const tabListRef = useRef<HTMLDivElement>(null);
  const splitTabGroupRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const pointerDragRef = useRef<{
    tabId: string;
    pointerId: number;
    startX: number;
    startY: number;
    started: boolean;
  } | null>(null);
  const dropZoneRef = useRef<TerminalDropZone | null>(null);
  const tabDropTargetRef = useRef<TabDropTarget | null>(null);
  const suppressTabClickRef = useRef(false);
  const { previewRef, updatePreviewPosition, resetPreviewPosition } =
    useDragPreviewPosition();

  const finishTabDrag = useCallback(() => {
    pointerDragRef.current = null;
    dropZoneRef.current = null;
    tabDropTargetRef.current = null;
    setDraggedTabId(null);
    resetPreviewPosition();
    setDropZone(null);
    setTabDropTarget(null);
  }, [resetPreviewPosition]);

  const getDropAnchorTabId = useCallback(
    (sourceTabId: string) => {
      const focusedTabId = focusedPane(splitView)?.tabId ?? activeTabId;
      if (focusedTabId && focusedTabId !== sourceTabId) return focusedTabId;
      return tabIds.find((tabId) => tabId !== sourceTabId) ?? null;
    },
    [activeTabId, splitView, tabIds],
  );

  const canSplitWithTab = useCallback(
    (sourceTabId: string | null) =>
      Boolean(
        sourceTabId &&
        activeProjectId &&
        tabsById[sourceTabId]?.projectId === activeProjectId &&
        getDropAnchorTabId(sourceTabId),
      ),
    [activeProjectId, getDropAnchorTabId, tabsById],
  );

  const getPointerDropZone = useCallback(
    (clientX: number, clientY: number): TerminalDropZone | null => {
      const rect = workspaceRef.current?.getBoundingClientRect();
      if (!rect || !rect.width || !rect.height) return null;
      if (
        clientX < rect.left ||
        clientX > rect.right ||
        clientY < rect.top ||
        clientY > rect.bottom
      ) {
        return null;
      }
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const horizontalEdge = Math.min(x, rect.width - x) / rect.width;
      const verticalEdge = Math.min(y, rect.height - y) / rect.height;
      return horizontalEdge < verticalEdge
        ? x < rect.width / 2
          ? "left"
          : "right"
        : y < rect.height / 2
          ? "top"
          : "bottom";
    },
    [],
  );

  const updateTabDropTarget = useCallback(
    (sourceTabId: string, clientX: number, clientY: number) => {
      let targetElement = document
        .elementFromPoint(clientX, clientY)
        ?.closest<HTMLElement>("[data-terminal-tab-id]");
      let targetTabId = targetElement?.dataset.terminalTabId;
      let position: TabDropPosition | null = null;
      const lastTabId = tabIds.at(-1);
      const tabListRect = tabListRef.current?.getBoundingClientRect();
      const lastTabElement = lastTabId
        ? Array.from(
            tabListRef.current?.querySelectorAll<HTMLElement>(
              "[data-terminal-tab-id]",
            ) ?? [],
          ).find((element) => element.dataset.terminalTabId === lastTabId)
        : undefined;
      const lastTabRect = lastTabElement?.getBoundingClientRect();
      if (
        lastTabId &&
        tabListRect &&
        lastTabRect &&
        clientX >= lastTabRect.right &&
        clientX <= tabListRect.right &&
        clientY >= tabListRect.top &&
        clientY <= tabListRect.bottom
      ) {
        targetElement = lastTabElement;
        targetTabId = lastTabId;
        position = "after";
      }
      if (!targetElement || !targetTabId || targetTabId === sourceTabId) {
        if (tabDropTargetRef.current) {
          tabDropTargetRef.current = null;
          setTabDropTarget(null);
        }
        return;
      }
      const rect = targetElement.getBoundingClientRect();
      const nextTarget: TabDropTarget = {
        tabId: targetTabId,
        position:
          position ??
          (clientX - rect.left < rect.width / 2 ? "before" : "after"),
      };
      if (
        tabDropTargetRef.current?.tabId === nextTarget.tabId &&
        tabDropTargetRef.current.position === nextTarget.position
      ) {
        return;
      }
      tabDropTargetRef.current = nextTarget;
      setTabDropTarget(nextTarget);
    },
    [tabIds],
  );

  const handleTabPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, tabId: string) => {
      if (
        event.button !== 0 ||
        (event.target instanceof Element &&
          event.target.closest("[data-tab-action]"))
      ) {
        return;
      }
      pointerDragRef.current = {
        tabId,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        started: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );

  const handleTabPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = pointerDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (!drag.started) {
        const moved = Math.hypot(
          event.clientX - drag.startX,
          event.clientY - drag.startY,
        );
        if (moved < 6 || !canSplitWithTab(drag.tabId)) return;
        drag.started = true;
        updatePreviewPosition(event.clientX, event.clientY);
        setDraggedTabId(drag.tabId);
      }

      updatePreviewPosition(event.clientX, event.clientY);
      updateTabDropTarget(drag.tabId, event.clientX, event.clientY);
      const nextDropZone = getPointerDropZone(event.clientX, event.clientY);
      dropZoneRef.current = nextDropZone;
      setDropZone(nextDropZone);
      event.preventDefault();
    },
    [
      canSplitWithTab,
      getPointerDropZone,
      updatePreviewPosition,
      updateTabDropTarget,
    ],
  );

  const handleTabPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = pointerDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!drag.started) {
        finishTabDrag();
        return;
      }

      suppressTabClickRef.current = true;
      const sourceTabId = drag.tabId;
      const anchorTabId = getDropAnchorTabId(sourceTabId);
      const targetDropZone = dropZoneRef.current;
      const targetTabDrop = tabDropTargetRef.current;
      const tabListRect = tabListRef.current?.getBoundingClientRect();
      const splitGroupRect = splitTabGroupRef.current?.getBoundingClientRect();
      const releasedInTabList =
        tabListRect &&
        event.clientX >= tabListRect.left &&
        event.clientX <= tabListRect.right &&
        event.clientY >= tabListRect.top &&
        event.clientY <= tabListRect.bottom;
      const releasedInSplitGroup =
        splitGroupRect &&
        event.clientX >= splitGroupRect.left &&
        event.clientX <= splitGroupRect.right &&
        event.clientY >= splitGroupRect.top &&
        event.clientY <= splitGroupRect.bottom;
      if (activeProjectId && targetTabDrop) {
        if (paneTabIds(splitView).includes(sourceTabId)) {
          clearSplitView(activeProjectId);
        }
        reorderTab(
          activeProjectId,
          sourceTabId,
          targetTabDrop.tabId,
          targetTabDrop.position,
        );
        setActiveTab(activeProjectId, sourceTabId);
      } else if (
        activeProjectId &&
        anchorTabId &&
        targetDropZone &&
        canSplitWithTab(sourceTabId)
      ) {
        const sourceFirst =
          targetDropZone === "left" || targetDropZone === "top";
        const tabPair: [string, string] = sourceFirst
          ? [sourceTabId, anchorTabId]
          : [anchorTabId, sourceTabId];
        const direction: TerminalSplitDirection =
          targetDropZone === "left" || targetDropZone === "right"
            ? "side-by-side"
            : "stacked";
        setSplitView(activeProjectId, tabPair, direction);
        setActiveTab(activeProjectId, sourceTabId);
      } else if (
        activeProjectId &&
        paneTabIds(splitView).includes(sourceTabId) &&
        releasedInTabList &&
        !releasedInSplitGroup
      ) {
        clearSplitView(activeProjectId);
        setActiveTab(activeProjectId, sourceTabId);
      }
      finishTabDrag();
    },
    [
      activeProjectId,
      canSplitWithTab,
      clearSplitView,
      finishTabDrag,
      getDropAnchorTabId,
      reorderTab,
      setActiveTab,
      setSplitView,
      splitView,
    ],
  );

  const handleTabPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = pointerDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      finishTabDrag();
    },
    [finishTabDrag],
  );

  const handleTabClick = useCallback(
    (tabId: string) => {
      if (suppressTabClickRef.current) {
        suppressTabClickRef.current = false;
        return;
      }
      onSelectTab(tabId);
    },
    [onSelectTab],
  );

  return {
    draggedTabId,
    dropZone,
    tabDropTarget,
    tabListRef,
    splitTabGroupRef,
    workspaceRef,
    previewRef,
    handleTabPointerDown,
    handleTabPointerMove,
    handleTabPointerUp,
    handleTabPointerCancel,
    handleTabClick,
  };
}
