import type { Terminal } from "@xterm/xterm";

/**
 * The grid's size in pixels, for `TIOCGWINSZ`.
 *
 * Image tools read it to decide how large a picture to draw; a pty that
 * reports zero makes them fall back to a fixed guess or refuse. Measured from
 * the xterm screen element rather than the container so it excludes padding
 * and the scrollbar, and returns zeroes rather than a guess when the terminal
 * has not been laid out yet - zero already means "unknown" over there.
 *
 * Measured from `.xterm-screen`, not `.xterm-rows`: the rows element belongs
 * to the DOM renderer only, and every terminal here starts on DOM and then
 * upgrades to WebGL asynchronously, whose renderer disposes the DOM row
 * container. `.xterm-screen` is created by the core and both renderers keep
 * it sized, so it stays measurable no matter which renderer is drawing.
 */
export function measureGridPixels(container: HTMLElement, term: Terminal) {
  const screen = container.querySelector<HTMLElement>(".xterm-screen");
  if (!screen || !screen.clientWidth || !screen.clientHeight) {
    return { width: 0, height: 0 };
  }
  const cellWidth = screen.clientWidth / Math.max(1, term.cols);
  const cellHeight = screen.clientHeight / Math.max(1, term.rows);
  return {
    width: Math.round(cellWidth * term.cols),
    height: Math.round(cellHeight * term.rows),
  };
}
