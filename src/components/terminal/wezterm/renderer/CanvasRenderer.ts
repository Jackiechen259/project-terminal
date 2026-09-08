import type {
  RenderColor,
  TerminalRenderCell,
  TerminalRenderFrame,
  TerminalImageCellFrame,
  TerminalSearchMatch,
  TerminalRenderRow,
} from "@/lib/terminalFrames";
import {
  ansi256ToRgb,
  ANSI_THEME_KEYS,
  ensureContrastRgb,
  parseCssColor,
  type Rgb,
} from "@/lib/terminalColorMath";

import type {
  TerminalFontOptions,
  TerminalSelection,
  TerminalSelectionPoint,
  TerminalRenderer,
  TerminalCursorInactiveStyle,
  TerminalCursorStyle,
  TerminalRendererTheme,
} from "./TerminalRenderer";
import { applyFrameToRowCache, forEachCellCluster } from "./renderFrameMerge";

const IMAGE_CACHE_CAPACITY = 256;
const SLOW_BLINK_MS = 500;
const RAPID_BLINK_MS = 200;
const BLINK_TICK_MS = 100;

export function cellBlinkHidden(
  blink: TerminalRenderCell["blink"] | undefined,
  now = performance.now(),
) {
  if (blink === "slow") return Math.floor(now / SLOW_BLINK_MS) % 2 === 1;
  if (blink === "rapid") return Math.floor(now / RAPID_BLINK_MS) % 2 === 1;
  return false;
}

export function rowsHaveBlink(
  frame: TerminalRenderFrame | null,
  cache: Map<number, TerminalRenderRow>,
) {
  if (!frame) return false;
  for (let row = 0; row < frame.rows; row += 1) {
    const cells = cache.get(frame.viewportTop + row)?.cells;
    if (!cells) continue;
    for (const cell of cells) {
      if (cell.blink === "slow" || cell.blink === "rapid") return true;
    }
  }
  return false;
}

function rgbCss([red, green, blue]: Rgb) {
  return `rgb(${red}, ${green}, ${blue})`;
}

function cssColor(
  color: RenderColor | undefined,
  theme: TerminalRendererTheme,
  defaultColor: "foreground" | "background",
): string {
  // An absent color means the backend omitted a `{"kind":"default"}` value -
  // see the `TerminalRenderCell` doc comment in @/lib/terminalFrames.
  if (!color || color.kind === "default") return theme[defaultColor];
  if (color.kind === "rgba") {
    const [red, green, blue, alpha] = color.value;
    return `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
  }
  const themeKey = ANSI_THEME_KEYS[color.value];
  const themed = themeKey ? theme[themeKey] : undefined;
  return themed ?? rgbCss(ansi256ToRgb(color.value));
}

/** Keep the user-facing minimum-contrast setting active for Canvas2D too. */
function ensureContrast(
  foreground: string,
  background: string,
  minimumContrast = 1,
) {
  if (minimumContrast <= 1) return foreground;
  const foregroundRgb = parseCssColor(foreground);
  const backgroundRgb = parseCssColor(background);
  if (!foregroundRgb || !backgroundRgb) return foreground;
  const foregroundColor: Rgb = [
    foregroundRgb[0],
    foregroundRgb[1],
    foregroundRgb[2],
  ];
  const backgroundColor: Rgb = [
    backgroundRgb[0],
    backgroundRgb[1],
    backgroundRgb[2],
  ];
  const adjusted = ensureContrastRgb(
    foregroundColor,
    backgroundColor,
    minimumContrast,
  );
  // `ensureContrastRgb` returns the same array reference when it made no
  // change, so falling back to the original string here also preserves any
  // alpha the CSS string carried (an rgba() foreground) instead of forcing
  // it opaque through a reconstructed rgb() string.
  return adjusted === foregroundColor ? foreground : rgbCss(adjusted);
}

function fontFor(cell: TerminalRenderCell, font: TerminalFontOptions) {
  const style = cell.italic ? "italic " : "";
  const weight = cell.intensity === "bold" ? font.weightBold : font.weight;
  return `${style}${weight} ${font.size}px ${font.family}`;
}

/**
 * Correctness-first Canvas2D renderer.
 *
 * Rows are retained by stable row id. Ordinary deltas repaint only dirty rows
 * (plus old/new cursor rows); a viewport move repaints the new visible rows
 * from that retained cache. React never renders cells and no PTY read schedules
 * a paint directly; the backend frame scheduler controls update cadence.
 */
export class CanvasRenderer implements TerminalRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private theme: TerminalRendererTheme = {
    background: "#000000",
    foreground: "#ffffff",
  };
  private font: TerminalFontOptions = {
    family: "monospace",
    size: 14,
    weight: 400,
    weightBold: 700,
    lineHeight: 1.2,
    letterSpacing: 0,
  };
  private cursorStyle: TerminalCursorStyle = "block";
  private inactiveCursorStyle: TerminalCursorInactiveStyle = "outline";
  private cursorBlink = false;
  private cursorBlinkVisible = true;
  private cursorBlinkTimer: number | null = null;
  private focused = true;
  private dpr = 1;
  private width = 0;
  private height = 0;
  private rows = 24;
  private cols = 80;
  private cellWidth = 8;
  private cellHeight = 17;
  private baseline = 14;
  private viewportTop = 0;
  private rowCache = new Map<number, TerminalRenderRow>();
  private frame: TerminalRenderFrame | null = null;
  private paintedFrame: TerminalRenderFrame | null = null;
  private selection: TerminalSelection | null = null;
  private searchMatch: TerminalSearchMatch | null = null;
  private imageCache = new Map<string, CanvasImageSource>();
  private imageLoads = new Set<string>();
  private imageAnimations = new Map<
    string,
    {
      frames: CanvasImageSource[];
      durations: number[];
      index: number;
      timer: number | null;
    }
  >();
  private cellBlinkTimer: number | null = null;
  private pendingDirtyRows = new Set<number>();
  private pendingFullRedraw = false;
  private frameRequest: number | null = null;
  private transparentBackground = false;
  private textVisible = true;
  private cellBackgroundVisible = true;
  private visible = true;

  mount(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.updateMetrics();
  }

  /**
   * WebGLRenderer uses Canvas2D as a correctness overlay. In that mode the
   * GPU owns the terminal background while this renderer contributes glyphs,
   * cell-specific backgrounds, decorations, selections, and images.
   */
  setBackgroundVisible(visible: boolean) {
    this.transparentBackground = !visible;
    if (this.frame) this.redrawVisibleRows();
  }

  /** Used by WebGLRenderer while the GPU owns glyphs and cell backgrounds. */
  setTextVisible(visible: boolean) {
    if (this.textVisible === visible) return;
    this.textVisible = visible;
    this.refreshCellBlinkTimer();
    if (this.frame) this.redrawVisibleRows();
  }

  /** Used by WebGLRenderer while the GPU owns cell background quads. */
  setCellBackgroundVisible(visible: boolean) {
    if (this.cellBackgroundVisible === visible) return;
    this.cellBackgroundVisible = visible;
    if (this.frame) this.redrawVisibleRows();
  }

  resize(width: number, height: number, rows: number, cols: number) {
    const nextRows = Math.max(1, rows);
    const nextCols = Math.max(1, cols);
    const gridChanged = this.rows !== nextRows || this.cols !== nextCols;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.rows = nextRows;
    this.cols = nextCols;
    this.dpr = window.devicePixelRatio || 1;
    if (this.canvas) {
      this.canvas.style.width = `${this.width}px`;
      this.canvas.style.height = `${this.height}px`;
      const backingWidth = Math.ceil(this.width * this.dpr);
      const backingHeight = Math.ceil(this.height * this.dpr);
      if (this.canvas.width !== backingWidth) this.canvas.width = backingWidth;
      if (this.canvas.height !== backingHeight)
        this.canvas.height = backingHeight;
    }
    this.updateMetrics();
    if (gridChanged) {
      if (this.frameRequest !== null) {
        window.cancelAnimationFrame(this.frameRequest);
        this.frameRequest = null;
      }
      this.pendingDirtyRows.clear();
      this.pendingFullRedraw = true;
      // Keep the last coherent frame visible while the backend produces the
      // authoritative snapshot for the new grid. The next full snapshot is
      // responsible for replacing this retained cache atomically.
    }
    if (!this.visible) {
      this.pendingFullRedraw = true;
    } else if (this.frame) {
      this.redrawVisibleRows();
    } else {
      this.clear();
    }
  }

  measureGrid(width: number, height: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.updateMetrics();
    return {
      rows: Math.max(1, Math.floor(this.height / this.cellHeight)),
      cols: Math.max(1, Math.floor(this.width / this.cellWidth)),
    };
  }

  render(frame: TerminalRenderFrame) {
    const cacheUpdate = this.acceptFrame(frame);
    if (!cacheUpdate?.accepted) return;
    if (!this.visible) {
      this.cancelScheduledPaint();
      this.pendingDirtyRows.clear();
      this.pendingFullRedraw = true;
      return;
    }
    this.schedulePaint();
  }

  renderImmediate(frame: TerminalRenderFrame) {
    this.cancelScheduledPaint();
    const cacheUpdate = this.acceptFrame(frame);
    if (!cacheUpdate?.accepted) return;
    if (!this.visible) {
      this.pendingDirtyRows.clear();
      this.pendingFullRedraw = true;
      return;
    }
    this.paintPending();
  }

  /**
   * Accept a frame into the row cache and dirty-row queue without scheduling
   * a paint. Used by WebGLRenderer, which drives this renderer's overlay
   * paint from its own rAF (via `paintOverlayPending`) instead of letting it
   * schedule an independent one - otherwise every GL frame would end up
   * scheduling two rAF callbacks that both try to paint the same overlay.
   */
  ingestFrame(frame: TerminalRenderFrame) {
    this.acceptFrame(frame);
  }

  /**
   * Paint whatever `ingestFrame` (or `render`) queued, without scheduling.
   * WebGLRenderer calls this once per GL frame instead of `redraw()` so the
   * overlay repaints only its dirty rows in the common case, rather than
   * every cell on every frame.
   */
  paintOverlayPending() {
    this.paintPending();
  }

  private acceptFrame(frame: TerminalRenderFrame) {
    const previousFrame = this.frame;
    const cacheUpdate = applyFrameToRowCache(
      this.rowCache,
      previousFrame,
      frame,
      {
        rows: this.rows,
        cols: this.cols,
      },
    );
    if (!cacheUpdate.accepted) return cacheUpdate;

    this.frame = frame;
    this.refreshCellBlinkTimer();
    if (
      cacheUpdate.cacheCleared ||
      cacheUpdate.viewportChanged ||
      previousFrame === null
    ) {
      this.pendingDirtyRows.clear();
      this.pendingFullRedraw = true;
    } else {
      for (const dirtyRow of frame.dirtyRows) {
        this.pendingDirtyRows.add(dirtyRow.stableRow);
      }
      this.pendingDirtyRows.add(
        previousFrame.viewportTop + previousFrame.cursor.row,
      );
      this.pendingDirtyRows.add(frame.viewportTop + frame.cursor.row);
    }
    return cacheUpdate;
  }

  private schedulePaint() {
    if (this.frameRequest !== null) return;
    this.frameRequest = window.requestAnimationFrame(() => {
      this.frameRequest = null;
      this.paintPending();
    });
  }

  private cancelScheduledPaint() {
    if (this.frameRequest === null) return;
    window.cancelAnimationFrame(this.frameRequest);
    this.frameRequest = null;
  }

  private paintPending() {
    if (!this.visible) return;
    const frame = this.frame;
    if (!frame) return;

    const paintedFrame = this.paintedFrame;
    const requiresFullRedraw =
      this.pendingFullRedraw ||
      paintedFrame === null ||
      paintedFrame.rows !== frame.rows ||
      paintedFrame.cols !== frame.cols ||
      paintedFrame.viewportTop !== frame.viewportTop;
    if (requiresFullRedraw) {
      this.redrawVisibleRows();
      return;
    }

    this.viewportTop = frame.viewportTop;
    for (const stableRow of this.pendingDirtyRows) {
      this.paintRow(stableRow, this.rowCache.get(stableRow));
    }
    this.paintCursor(frame, true);
    this.paintedFrame = frame;
    this.pendingDirtyRows.clear();
    this.pendingFullRedraw = false;
  }

  setTheme(theme: TerminalRendererTheme) {
    this.theme = theme;
    this.redrawVisibleRows();
  }

  setFont(font: TerminalFontOptions) {
    this.font = font;
    this.updateMetrics();
    this.redrawVisibleRows();
  }

  setCursorStyle(
    style: TerminalCursorStyle,
    inactiveStyle: TerminalCursorInactiveStyle,
  ) {
    this.cursorStyle = style;
    this.inactiveCursorStyle = inactiveStyle;
    this.redrawVisibleRows();
  }

  setCursorBlink(enabled: boolean) {
    if (this.cursorBlink === enabled) return;
    this.cursorBlink = enabled;
    this.cursorBlinkVisible = true;
    this.stopCursorBlink();
    this.startCursorBlink();
    this.redrawVisibleRows();
  }

  setFocused(focused: boolean) {
    if (this.focused === focused) return;
    this.focused = focused;
    this.cursorBlinkVisible = true;
    this.redrawVisibleRows();
  }

  setVisible(visible: boolean) {
    if (this.visible === visible) return;
    this.visible = visible;
    if (visible) {
      this.cursorBlinkVisible = true;
      this.pendingFullRedraw = true;
      this.startCursorBlink();
      this.refreshCellBlinkTimer();
    } else {
      this.cancelScheduledPaint();
      this.pendingDirtyRows.clear();
      this.pendingFullRedraw = true;
      this.stopCursorBlink();
      this.stopCellBlink();
    }
  }

  private startCursorBlink() {
    if (!this.visible || !this.cursorBlink || this.cursorBlinkTimer !== null)
      return;
    this.cursorBlinkTimer = window.setInterval(() => {
      this.cursorBlinkVisible = !this.cursorBlinkVisible;
      this.redrawVisibleRows();
    }, 500);
  }

  private stopCursorBlink() {
    if (this.cursorBlinkTimer === null) return;
    window.clearInterval(this.cursorBlinkTimer);
    this.cursorBlinkTimer = null;
  }

  setSelection(selection: TerminalSelection | null) {
    this.selection = selection;
    if (!this.frame) return;
    // Selection tracks pointermove, which can fire many times per animation
    // frame; coalesce to one full repaint per frame instead of one per
    // event. A full redraw (rather than diffing the old/new selected range)
    // is still just one pass over the visible grid, and it is the same cost
    // `redrawVisibleRows` already pays.
    this.pendingFullRedraw = true;
    this.schedulePaint();
  }

  setSearchMatch(match: TerminalSearchMatch | null) {
    this.searchMatch = match;
    if (!this.frame) return;
    this.pendingFullRedraw = true;
    this.schedulePaint();
  }

  selectionText(anchor: TerminalSelectionPoint, focus: TerminalSelectionPoint) {
    const [start, end] = normalizeSelection(anchor, focus);
    const lines: string[] = [];
    for (
      let stableRow = start.stableRow;
      stableRow <= end.stableRow;
      stableRow++
    ) {
      const row = this.rowCache.get(stableRow);
      if (!row) {
        lines.push("");
        continue;
      }
      const from = stableRow === start.stableRow ? start.column : 0;
      const to =
        stableRow === end.stableRow ? end.column : Number.MAX_SAFE_INTEGER;
      lines.push(textForColumns(row, from, to).replace(/\s+$/u, ""));
    }
    return lines.join("\n").replace(/\n+$/u, "");
  }

  rowAtPoint(clientX: number, clientY: number) {
    if (!this.canvas) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return null;
    const column = Math.max(
      0,
      Math.min(this.cols - 1, Math.floor(x / this.cellWidth)),
    );
    const row = Math.max(0, Math.floor(y / this.cellHeight));
    return {
      column,
      row,
      xPixelOffset: Math.max(0, Math.round(x - column * this.cellWidth)),
      yPixelOffset: Math.max(0, Math.round(y - row * this.cellHeight)),
    };
  }

  cursorRect() {
    if (!this.frame) return null;
    return {
      x: this.frame.cursor.column * this.cellWidth,
      y: this.frame.cursor.row * this.cellHeight,
      width: this.cellWidth,
      height: this.cellHeight,
    };
  }

  linkAtPoint(clientX: number, clientY: number) {
    const point = this.rowAtPoint(clientX, clientY);
    if (!point) return null;
    const stableRow = this.viewportTop + point.row;
    const row = this.rowCache.get(stableRow);
    const cell = row?.cells.find(
      (candidate) =>
        point.column >= candidate.column &&
        point.column < candidate.column + Math.max(1, candidate.width ?? 1),
    );
    if (cell?.hyperlink) return cell.hyperlink;
    return row ? plainUrlAtColumn(row, point.column) : null;
  }

  rowText(row: TerminalRenderRow) {
    return rowTextWithColumns(row).text;
  }

  dispose() {
    if (this.frameRequest !== null) {
      window.cancelAnimationFrame(this.frameRequest);
      this.frameRequest = null;
    }
    if (this.cursorBlinkTimer !== null) {
      window.clearInterval(this.cursorBlinkTimer);
      this.cursorBlinkTimer = null;
    }
    this.stopCellBlink();
    this.stopImageAnimations();
    this.pendingDirtyRows.clear();
    this.pendingFullRedraw = false;
    this.canvas = null;
    this.context = null;
    this.rowCache.clear();
    this.frame = null;
    this.paintedFrame = null;
    this.selection = null;
    this.searchMatch = null;
    for (const image of this.imageCache.values()) {
      if ("close" in image && typeof image.close === "function") image.close();
    }
    this.imageCache.clear();
    this.imageLoads.clear();
    this.imageAnimations.clear();
  }

  private refreshCellBlinkTimer() {
    const needed = this.textVisible && rowsHaveBlink(this.frame, this.rowCache);
    if (needed) this.startCellBlink();
    else this.stopCellBlink();
  }

  private startCellBlink() {
    if (!this.visible || this.cellBlinkTimer !== null) return;
    this.cellBlinkTimer = window.setInterval(() => {
      if (this.textVisible) this.redrawVisibleRows();
    }, BLINK_TICK_MS);
  }

  private stopCellBlink() {
    if (this.cellBlinkTimer === null) return;
    window.clearInterval(this.cellBlinkTimer);
    this.cellBlinkTimer = null;
  }

  private stopImageAnimations() {
    for (const animation of this.imageAnimations.values()) {
      if (animation.timer !== null) window.clearTimeout(animation.timer);
    }
    this.imageAnimations.clear();
  }

  private updateMetrics() {
    const context = this.context;
    if (!context) return;
    context.font = `${this.font.size}px ${this.font.family}`;
    const metrics = context.measureText("Mg");
    this.cellWidth = Math.max(1, metrics.width / 2 + this.font.letterSpacing);
    this.cellHeight = Math.max(1, this.font.size * this.font.lineHeight);
    this.baseline = Math.max(
      1,
      (this.cellHeight -
        metrics.actualBoundingBoxAscent -
        metrics.actualBoundingBoxDescent) /
        2 +
        metrics.actualBoundingBoxAscent,
    );
  }

  private clear() {
    const context = this.context;
    if (!context) return;
    context.save();
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.transparentBackground) {
      context.clearRect(0, 0, this.width, this.height);
    } else {
      context.fillStyle = this.theme.background;
      context.fillRect(0, 0, this.width, this.height);
    }
    context.restore();
  }

  private paintRow(stableRow: number, row: TerminalRenderRow | undefined) {
    const context = this.context;
    if (!context) return;
    const visibleRow = stableRow - this.viewportTop;
    if (visibleRow < 0 || visibleRow >= this.rows) return;
    const y = visibleRow * this.cellHeight;
    context.save();
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.transparentBackground) {
      context.clearRect(0, y, this.width, this.cellHeight);
    } else {
      context.fillStyle = this.theme.background;
      context.fillRect(0, y, this.width, this.cellHeight);
    }
    if (!row) {
      context.restore();
      return;
    }

    for (const cell of row.cells) {
      this.paintCell(context, cell, y, stableRow);
    }
    context.restore();
  }

  private paintCell(
    context: CanvasRenderingContext2D,
    cell: TerminalRenderCell,
    y: number,
    stableRow: number,
  ) {
    const selected = this.rangeIsSelected(
      stableRow,
      cell.column,
      Math.max(1, cell.width ?? 1),
    );
    const searched =
      !selected &&
      this.rangeIsSearchMatched(
        stableRow,
        cell.column,
        Math.max(1, cell.width ?? 1),
      );
    // As a WebGLRenderer overlay (`!textVisible && !cellBackgroundVisible`),
    // this method contributes only images, underline/strikethrough, and the
    // cursor - the GPU already owns glyphs and cell backgrounds, including
    // the selection/search-match highlight. Most cells reaching here in that
    // mode have nothing left to draw at all; skip before paying for color
    // parsing, a contrast solve, and a save/clip/restore for nothing.
    if (
      !this.textVisible &&
      !this.cellBackgroundVisible &&
      !cell.images?.length &&
      (!cell.underline || cell.underline === "none") &&
      !cell.strikethrough &&
      !selected &&
      !searched
    ) {
      return;
    }

    if ((selected || searched) && Array.from(cell.text).length > 1) {
      forEachCellCluster(cell, (column, text, width) => {
        this.paintCluster(context, cell, column, text, width, y, stableRow);
      });
      return;
    }
    this.paintCluster(
      context,
      cell,
      cell.column,
      cell.text,
      Math.max(1, cell.width ?? 1),
      y,
      stableRow,
    );
  }

  private paintCluster(
    context: CanvasRenderingContext2D,
    cell: TerminalRenderCell,
    column: number,
    text: string,
    width: number,
    y: number,
    stableRow: number,
  ) {
    const selected = this.rangeIsSelected(stableRow, column, width);
    const searched =
      !selected && this.rangeIsSearchMatched(stableRow, column, width);
    const x = column * this.cellWidth;
    const cellWidth = this.cellWidth * width;
    let foreground = cssColor(cell.foreground, this.theme, "foreground");
    let background = cssColor(cell.background, this.theme, "background");
    if (cell.reverse) [foreground, background] = [background, foreground];

    if (selected) {
      background =
        this.theme.selectionBackground ?? this.theme.foreground ?? "#4a4a4a";
      foreground = this.theme.foreground;
    } else if (searched) {
      background = this.theme.yellow ?? "#a68b00";
      foreground = this.theme.background;
    } else {
      foreground = ensureContrast(
        foreground,
        background,
        this.theme.minimumContrast,
      );
    }

    const paintsDefaultBackground =
      !this.transparentBackground ||
      (cell.background?.kind ?? "default") !== "default" ||
      cell.reverse ||
      selected ||
      searched;
    const overlayHighlight =
      (selected || searched) && !this.cellBackgroundVisible;
    if (
      (paintsDefaultBackground && this.cellBackgroundVisible) ||
      overlayHighlight
    ) {
      context.fillStyle = background;
      context.fillRect(x, y, cellWidth, this.cellHeight);
    }
    if (cell.invisible) return;

    context.save();
    context.beginPath();
    context.rect(x, y, cellWidth, this.cellHeight);
    context.clip();
    this.paintImages(
      context,
      cell.images ?? [],
      x,
      y,
      cellWidth,
      this.cellHeight,
      -1,
    );
    if (
      (this.textVisible || overlayHighlight) &&
      !cellBlinkHidden(cell.blink)
    ) {
      context.globalAlpha = cell.intensity === "half" ? 0.5 : 1;
      context.font = fontFor(cell, this.font);
      context.fillStyle = foreground;
      context.textBaseline = "alphabetic";
      context.fillText(
        text,
        x + this.font.letterSpacing / 2,
        y + this.baseline,
      );
    }

    // An absent `underline` means the backend omitted the default "none" -
    // `undefined !== "none"` would otherwise treat every ordinary cell as
    // underlined.
    const underline = !!cell.underline && cell.underline !== "none";
    if (underline || cell.strikethrough) {
      context.strokeStyle = cssColor(
        cell.underlineColor,
        this.theme,
        "foreground",
      );
      context.lineWidth = cell.underline === "double" ? 1 : 1;
      if (underline) {
        const underlineY = y + this.baseline + 2;
        context.beginPath();
        context.moveTo(x, underlineY);
        context.lineTo(x + cellWidth, underlineY);
        context.stroke();
        if (cell.underline === "double") {
          context.beginPath();
          context.moveTo(x, underlineY + 2);
          context.lineTo(x + cellWidth, underlineY + 2);
          context.stroke();
        }
      }
      if (cell.strikethrough) {
        const strikeY = y + this.cellHeight / 2;
        context.beginPath();
        context.moveTo(x, strikeY);
        context.lineTo(x + cellWidth, strikeY);
        context.stroke();
      }
    }
    context.globalAlpha = 1;
    this.paintImages(
      context,
      cell.images ?? [],
      x,
      y,
      cellWidth,
      this.cellHeight,
      1,
    );
    context.restore();
  }

  private paintImages(
    context: CanvasRenderingContext2D,
    images: TerminalImageCellFrame[],
    x: number,
    y: number,
    width: number,
    height: number,
    zDirection: -1 | 1,
  ) {
    for (const image of images) {
      if ((image.zIndex < 0 ? -1 : 1) !== zDirection) continue;
      const source =
        this.imageCache.get(image.cacheKey) ?? this.loadImage(image);
      if (!source) continue;
      const sourceWidth = imageSourceWidth(source);
      const sourceHeight = imageSourceHeight(source);
      if (!sourceWidth || !sourceHeight) continue;
      const [left, top, right, bottom] = image.padding;
      const destX = x + left;
      const destY = y + top;
      const destWidth = Math.max(1, width - left - right);
      const destHeight = Math.max(1, height - top - bottom);
      const sourceX = image.topLeft[0] * sourceWidth;
      const sourceY = image.topLeft[1] * sourceHeight;
      const sourceWidthSlice =
        (image.bottomRight[0] - image.topLeft[0]) * sourceWidth;
      const sourceHeightSlice =
        (image.bottomRight[1] - image.topLeft[1]) * sourceHeight;
      if (sourceWidthSlice <= 0 || sourceHeightSlice <= 0) continue;
      context.drawImage(
        source,
        sourceX,
        sourceY,
        sourceWidthSlice,
        sourceHeightSlice,
        destX,
        destY,
        destWidth,
        destHeight,
      );
    }
  }

  private loadImage(image: TerminalImageCellFrame): CanvasImageSource | null {
    if (this.imageLoads.has(image.cacheKey)) return null;
    const animated = image.animationFrames?.length
      ? image.animationFrames
      : null;
    if (!image.dataBase64 && !animated) return null;
    this.imageLoads.add(image.cacheKey);
    void this.decodeAndCacheImage(image, animated)
      .catch(() => {
        // A malformed or oversized image must not stop text rendering.
      })
      .finally(() => this.imageLoads.delete(image.cacheKey));
    return null;
  }

  private async decodeAndCacheImage(
    image: TerminalImageCellFrame,
    animated: NonNullable<TerminalImageCellFrame["animationFrames"]> | null,
  ) {
    const frames = animated
      ? (
          await Promise.all(
            animated.map((frame) =>
              decodeImage({
                ...image,
                dataBase64: frame.dataBase64,
              }),
            ),
          )
        ).filter((frame): frame is CanvasImageSource => frame !== null)
      : [];
    const source = frames[0] ?? (await decodeImage(image));
    if (!source) return;
    if (
      !this.imageCache.has(image.cacheKey) &&
      this.imageCache.size >= IMAGE_CACHE_CAPACITY
    ) {
      const oldest = this.imageCache.keys().next().value as string | undefined;
      if (oldest) {
        const evicted = this.imageCache.get(oldest);
        if (
          evicted &&
          "close" in evicted &&
          typeof evicted.close === "function"
        ) {
          evicted.close();
        }
        this.imageCache.delete(oldest);
        const stopped = this.imageAnimations.get(oldest);
        if (stopped?.timer !== null && stopped) {
          window.clearTimeout(stopped.timer);
        }
        this.imageAnimations.delete(oldest);
      }
    }
    this.imageCache.set(image.cacheKey, source);
    if (frames.length > 1 && animated) {
      this.startImageAnimation(
        image.cacheKey,
        frames,
        animated.map((frame) => frame.durationMs),
      );
    }
    this.redrawVisibleRows();
  }

  private startImageAnimation(
    cacheKey: string,
    frames: CanvasImageSource[],
    durations: number[],
  ) {
    const existing = this.imageAnimations.get(cacheKey);
    if (existing?.timer !== null && existing) {
      window.clearTimeout(existing.timer);
    }
    const animation = {
      frames,
      durations,
      index: 0,
      timer: null as number | null,
    };
    const tick = () => {
      const current = this.imageAnimations.get(cacheKey);
      if (!current) return;
      let next = (current.index + 1) % current.frames.length;
      let guard = current.frames.length;
      while (guard > 0 && (current.durations[next] ?? 0) === 0) {
        next = (next + 1) % current.frames.length;
        guard -= 1;
      }
      current.index = next;
      this.imageCache.set(cacheKey, current.frames[next]);
      const delay = Math.max(16, current.durations[next] ?? 100);
      current.timer = window.setTimeout(tick, delay);
      this.redrawVisibleRows();
    };
    const delay = Math.max(16, durations[0] ?? 100);
    animation.timer = window.setTimeout(tick, delay);
    this.imageAnimations.set(cacheKey, animation);
  }

  private paintCursor(frame: TerminalRenderFrame, visible: boolean) {
    const context = this.context;
    if (
      !context ||
      frame.cursor.visibility === "hidden" ||
      (this.cursorBlink && !this.cursorBlinkVisible)
    ) {
      return;
    }
    const style = this.focused ? this.cursorStyle : this.inactiveCursorStyle;
    if (style === "none") return;
    const x = frame.cursor.column * this.cellWidth;
    const y = frame.cursor.row * this.cellHeight;
    const width = this.cellWidth;
    const height = this.cellHeight;
    context.save();
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.strokeStyle = this.theme.cursor ?? this.theme.foreground;
    context.fillStyle = this.theme.cursor ?? this.theme.foreground;
    context.globalAlpha = visible ? 0.9 : 0;
    switch (style) {
      case "underline":
        context.fillRect(x, y + height - 2, width, 2);
        break;
      case "bar":
        context.fillRect(x, y, 2, height);
        break;
      case "block":
        context.globalAlpha = visible ? 0.35 : 0;
        context.fillRect(x, y, width, height);
        break;
      case "outline":
        context.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
        break;
    }
    context.restore();
  }

  private rangeIsSelected(stableRow: number, column: number, width: number) {
    if (!this.selection) return false;
    const [start, end] = normalizeSelection(
      this.selection.anchor,
      this.selection.focus,
    );
    if (start.stableRow === end.stableRow && start.column === end.column) {
      return false;
    }
    if (stableRow < start.stableRow || stableRow > end.stableRow) {
      return false;
    }
    const from = stableRow === start.stableRow ? start.column : 0;
    const to =
      stableRow === end.stableRow ? end.column : Number.MAX_SAFE_INTEGER;
    return column < to && column + width > from;
  }

  private rangeIsSearchMatched(
    stableRow: number,
    column: number,
    width: number,
  ) {
    const match = this.searchMatch;
    if (!match || match.stableRow !== stableRow) return false;
    return column < match.endColumn && column + width > match.startColumn;
  }

  private redrawVisibleRows() {
    if (!this.visible) return;
    const frame = this.frame;
    if (!frame) return;
    this.cancelScheduledPaint();
    this.viewportTop = frame.viewportTop;
    this.clear();
    for (let row = 0; row < frame.rows; row++) {
      const stableRow = frame.viewportTop + row;
      this.paintRow(stableRow, this.rowCache.get(stableRow));
    }
    this.paintCursor(frame, true);
    this.paintedFrame = frame;
    this.pendingDirtyRows.clear();
    this.pendingFullRedraw = false;
  }

  /** Redraw the retained model without pretending the last delta is a snapshot. */
  redraw() {
    this.redrawVisibleRows();
  }
}

function imageSourceWidth(source: CanvasImageSource) {
  const candidate = source as {
    naturalWidth?: unknown;
    videoWidth?: unknown;
    width?: unknown;
  };
  if (typeof candidate.naturalWidth === "number") return candidate.naturalWidth;
  if (typeof candidate.videoWidth === "number") return candidate.videoWidth;
  return typeof candidate.width === "number" ? candidate.width : 0;
}

function imageSourceHeight(source: CanvasImageSource) {
  const candidate = source as {
    naturalHeight?: unknown;
    videoHeight?: unknown;
    height?: unknown;
  };
  if (typeof candidate.naturalHeight === "number")
    return candidate.naturalHeight;
  if (typeof candidate.videoHeight === "number") return candidate.videoHeight;
  return typeof candidate.height === "number" ? candidate.height : 0;
}

async function decodeImage(
  image: TerminalImageCellFrame,
): Promise<CanvasImageSource | null> {
  if (!image.dataBase64) return null;
  const binary = globalThis.atob(image.dataBase64);
  if (binary.length > 32 * 1024 * 1024) return null;
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));

  if (image.format === "rgba8") {
    if (
      !image.width ||
      !image.height ||
      bytes.length !== image.width * image.height * 4
    ) {
      return null;
    }
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.putImageData(
      new ImageData(new Uint8ClampedArray(bytes), image.width, image.height),
      0,
      0,
    );
    return canvas;
  }

  const blob = new Blob([bytes], { type: image.mimeType });
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(blob);
  }
  const url = URL.createObjectURL(blob);
  try {
    const element = new Image();
    element.src = url;
    await element.decode();
    return element;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function normalizeSelection(
  anchor: TerminalSelectionPoint,
  focus: TerminalSelectionPoint,
): [TerminalSelectionPoint, TerminalSelectionPoint] {
  const anchorBeforeFocus =
    anchor.stableRow < focus.stableRow ||
    (anchor.stableRow === focus.stableRow && anchor.column <= focus.column);
  return anchorBeforeFocus ? [anchor, focus] : [focus, anchor];
}

function textForColumns(
  row: TerminalRenderRow,
  from: number,
  to: number,
): string {
  let text = "";
  for (const cell of row.cells) {
    forEachCellCluster(cell, (column, value, width) => {
      const cellEnd = column + width;
      if (cellEnd <= from || column >= to) return;
      text += value || " ";
    });
  }
  return text;
}

const PLAIN_URL = /https?:\/\/[^\s<>'"`]+/giu;
const TRAILING_URL_PUNCTUATION = /[.,!?;:)\]}]+$/u;

function plainUrlAtColumn(row: TerminalRenderRow, column: number) {
  const { text, columns } = rowTextWithColumns(row);
  for (const match of text.matchAll(PLAIN_URL)) {
    const raw = match[0];
    const url = raw.replace(TRAILING_URL_PUNCTUATION, "");
    const start = match.index ?? 0;
    const startColumn = columns[start];
    const lastUrlColumn = columns[start + url.length - 1];
    const endColumn = lastUrlColumn === undefined ? 0 : lastUrlColumn + 1;
    if (
      url &&
      startColumn !== undefined &&
      column >= startColumn &&
      column < endColumn
    ) {
      return url;
    }
  }
  return null;
}

function rowTextWithColumns(row: TerminalRenderRow) {
  let text = "";
  let terminalColumn = 0;
  const columns: number[] = [];
  for (const cell of row.cells) {
    forEachCellCluster(cell, (column, value, width) => {
      while (terminalColumn < column) {
        text += " ";
        columns.push(terminalColumn);
        terminalColumn += 1;
      }
      const clusterText = value || " ";
      for (const character of clusterText) {
        text += character;
        for (let offset = 0; offset < character.length; offset += 1) {
          columns.push(column);
        }
      }
      for (let offset = 1; offset < width; offset += 1) {
        // Wide cells occupy one extra terminal column after their grapheme.
        text += " ";
        columns.push(column + offset);
      }
      terminalColumn = column + width;
    });
  }
  return { text, columns };
}
