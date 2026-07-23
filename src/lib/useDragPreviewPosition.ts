import { useCallback, useRef } from "react";

type DragPoint = {
  x: number;
  y: number;
};

function applyPosition(node: HTMLDivElement, point: DragPoint) {
  node.style.transform = `translate3d(${point.x}px, ${point.y}px, 0) translate(-50%, -50%)`;
}

/**
 * Keeps a floating drag preview on the compositor instead of routing every
 * pointer movement through React. Re-rendering a workspace-sized component on
 * every pixel makes the preview trail behind the pointer in WebView2.
 */
export function useDragPreviewPosition() {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const pointRef = useRef<DragPoint | null>(null);

  const previewRef = useCallback((node: HTMLDivElement | null) => {
    nodeRef.current = node;
    if (node && pointRef.current) {
      applyPosition(node, pointRef.current);
    }
  }, []);

  const updatePreviewPosition = useCallback((x: number, y: number) => {
    const point = { x, y };
    pointRef.current = point;
    if (nodeRef.current) {
      applyPosition(nodeRef.current, point);
    }
  }, []);

  const resetPreviewPosition = useCallback(() => {
    pointRef.current = null;
  }, []);

  return {
    previewRef,
    updatePreviewPosition,
    resetPreviewPosition,
  };
}
