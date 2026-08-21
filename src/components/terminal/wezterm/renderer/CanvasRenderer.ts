import type {
  RenderColor,
  TerminalRenderCell,
  TerminalRenderFrame,
  TerminalImageCellFrame,
  TerminalSearchMatch,
  TerminalRenderRow,
} from "@/lib/terminalFrames";

import type {
  TerminalFontOptions,
  TerminalSelection,
  TerminalSelectionPoint,
  TerminalRenderer,
  TerminalCursorInactiveStyle,
  TerminalCursorStyle,
  TerminalRendererTheme,
} from "./TerminalRenderer";

const ANSI_THEME_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

const DEFAULT_ANSI = [
  "#000000",
  "#cc5555",
  "#55cc55",
  "#cdcd55",
  "#5455cb",
  "#cc55cc",
  "#7acaca",
  "#cccccc",
  "#555555",
  "#ff5555",
  "#55ff55",
  "#ffff55",
  "#5555ff",
  "#ff55ff",
  "#55ffff",
  "#ffffff",
] as const;
const IMAGE_CACHE_CAPACITY = 256;

function xterm256(index: number): string {
  if (index < 16) return DEFAULT_ANSI[index] ?? "#cccccc";
  if (index < 232) {
    const color = index - 16;
    const red = Math.floor(color / 36);
    const green = Math.floor((color % 36) / 6);
    const blue = color % 6;
    const ramp = [0, 95, 135, 175, 215, 255];
    return `rgb(${ramp[red]}, ${ramp[green]}, ${ramp[blue]})`;
  }
  const grey = 8 + (index - 232) * 10;
  return `rgb(${grey}, ${grey}, ${grey})`;
}

function cssColor(
  color: RenderColor,
  theme: TerminalRendererTheme,
  defaultColor: "foreground" | "background",
): string {
  if (color.kind === "default") return theme[defaultColor];
  if (color.kind === "rgba") {
    const [red, green, blue, alpha] = color.value;
    return `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
  }
  const themeKey = ANSI_THEME_KEYS[color.value];
  const themed = themeKey ? theme[themeKey] : undefined;
  return themed ?? xterm256(color.value);
}

type Rgb = [number, number, number];

function parseRgb(color: string): Rgb | null {
  const hex = color.match(/^#([0-9a-f]{6})$/iu);
  if (hex) {
    return [
      parseInt(hex[1].slice(0, 2), 16),
      parseInt(hex[1].slice(2, 4), 16),
      parseInt(hex[1].slice(4, 6), 16),
    ];
  }
  const rgb = color.match(
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\s*\)$/iu,
  );
  return rgb
    ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
    : null;
}

function luminance([red, green, blue]: Rgb) {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function contrastRatio(foreground: Rgb, background: Rgb) {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  return from.map((channel, index) =>
    Math.round(channel + (to[index] - channel) * amount),
  ) as Rgb;
}

function rgbCss([red, green, blue]: Rgb) {
  return `rgb(${red}, ${green}, ${blue})`;
}

/** Keep the user-facing minimum-contrast setting active for Canvas2D too. */
function ensureContrast(
  foreground: string,
  background: string,
  minimumContrast = 1,
) {
  if (minimumContrast <= 1) return foreground;
  const foregroundRgb = parseRgb(foreground);
  const backgroundRgb = parseRgb(background);
  if (!foregroundRgb || !backgroundRgb) return foreground;
  if (contrastRatio(foregroundRgb, backgroundRgb) >= minimumContrast) {
    return foreground;
  }

  const candidates: Rgb[] = [
    [0, 0, 0],
    [255, 255, 255],
  ];
  const target = candidates.reduce((best, candidate) =>
    contrastRatio(candidate, backgroundRgb) >
    contrastRatio(best, backgroundRgb)
      ? candidate
      : best,
  );
  if (contrastRatio(target, backgroundRgb) < minimumContrast) {
    return rgbCss(target);
  }

  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 12; iteration++) {
    const midpoint = (low + high) / 2;
    if (contrastRatio(mix(foregroundRgb, target, midpoint), backgroundRgb) >= minimumContrast) {
      high = midpoint;
    } else {
      low = midpoint;
    }
  }
  return rgbCss(mix(foregroundRgb, target, high));
}

function fontFor(cell: TerminalRenderCell, font: TerminalFontOptions) {
  const style = cell.italic ? "italic " : "";
  const weight = cell.intensity === "bold" ? font.weightBold : font.weight;
  return `${style}${weight} ${font.size}px ${font.family}`;
}

/**
 * Correctness-first Canvas2D renderer.
 *
 * Rows are retained by stable row id and only dirty rows (plus old/new cursor
 * rows) are repainted. React never renders cells and no PTY read schedules a
 * paint directly; the backend frame scheduler controls update cadence.
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
  private selection: TerminalSelection | null = null;
  private searchMatch: TerminalSearchMatch | null = null;
  private imageCache = new Map<string, CanvasImageSource>();
  private imageLoads = new Set<string>();
  private pendingFrame: TerminalRenderFrame | null = null;
  private frameRequest: number | null = null;

  mount(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.updateMetrics();
  }

  resize(width: number, height: number, rows: number, cols: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.rows = Math.max(1, rows);
    this.cols = Math.max(1, cols);
    this.dpr = window.devicePixelRatio || 1;
    if (this.canvas) {
      this.canvas.style.width = `${this.width}px`;
      this.canvas.style.height = `${this.height}px`;
      this.canvas.width = Math.ceil(this.width * this.dpr);
      this.canvas.height = Math.ceil(this.height * this.dpr);
    }
    this.updateMetrics();
    this.rowCache.clear();
    this.frame = null;
    this.clear();
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
    this.pendingFrame = mergePendingFrame(this.pendingFrame, frame);
    if (this.frameRequest !== null) return;
    this.frameRequest = window.requestAnimationFrame(() => {
      this.frameRequest = null;
      const next = this.pendingFrame;
      this.pendingFrame = null;
      if (next) this.paintFrame(next);
    });
  }

  private paintFrame(frame: TerminalRenderFrame) {
    const context = this.context;
    if (!context) return;

    const oldFrame = this.frame;
    const viewportChanged = oldFrame?.viewportTop !== frame.viewportTop;
    if (
      viewportChanged ||
      oldFrame?.rows !== frame.rows ||
      oldFrame?.cols !== frame.cols
    ) {
      this.rowCache.clear();
      this.clear();
    }
    for (const row of frame.dirtyRows) this.rowCache.set(row.stableRow, row);

    const rowsToPaint = new Set<number>();
    if (frame.fullSnapshot || viewportChanged) {
      for (let row = 0; row < frame.rows; row++) {
        rowsToPaint.add(frame.viewportTop + row);
      }
    } else {
      for (const row of frame.dirtyRows) rowsToPaint.add(row.stableRow);
      if (oldFrame) {
        rowsToPaint.add(oldFrame.viewportTop + oldFrame.cursor.row);
      }
      rowsToPaint.add(frame.viewportTop + frame.cursor.row);
    }

    this.viewportTop = frame.viewportTop;
    for (const stableRow of rowsToPaint) {
      const row = this.rowCache.get(stableRow);
      this.paintRow(stableRow, row);
    }
    if (oldFrame) {
      this.paintCursor(oldFrame, false);
    }
    this.paintCursor(frame, true);
    this.frame = frame;
  }

  setTheme(theme: TerminalRendererTheme) {
    this.theme = theme;
    if (this.frame) {
      const frame = this.frame;
      this.clear();
      this.render({ ...frame, fullSnapshot: true });
    }
  }

  setFont(font: TerminalFontOptions) {
    this.font = font;
    this.updateMetrics();
    if (this.frame) {
      const frame = this.frame;
      this.clear();
      this.render({ ...frame, fullSnapshot: true });
    }
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
    if (this.cursorBlinkTimer !== null) {
      window.clearInterval(this.cursorBlinkTimer);
      this.cursorBlinkTimer = null;
    }
    if (enabled) {
      this.cursorBlinkTimer = window.setInterval(() => {
        this.cursorBlinkVisible = !this.cursorBlinkVisible;
        this.redrawVisibleRows();
      }, 500);
    }
    this.redrawVisibleRows();
  }

  setFocused(focused: boolean) {
    if (this.focused === focused) return;
    this.focused = focused;
    this.cursorBlinkVisible = true;
    this.redrawVisibleRows();
  }

  setSelection(selection: TerminalSelection | null) {
    this.selection = selection;
    if (!this.frame) return;
    this.redrawVisibleRows();
  }

  setSearchMatch(match: TerminalSearchMatch | null) {
    this.searchMatch = match;
    if (!this.frame) return;
    this.redrawVisibleRows();
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
    return {
      column: Math.max(
        0,
        Math.min(this.cols - 1, Math.floor(x / this.cellWidth)),
      ),
      row: Math.max(0, Math.floor(y / this.cellHeight)),
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
        point.column < candidate.column + Math.max(1, candidate.width),
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
    this.pendingFrame = null;
    this.canvas = null;
    this.context = null;
    this.rowCache.clear();
    this.frame = null;
    this.selection = null;
    this.searchMatch = null;
    for (const image of this.imageCache.values()) {
      if ("close" in image && typeof image.close === "function") image.close();
    }
    this.imageCache.clear();
    this.imageLoads.clear();
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
    context.fillStyle = this.theme.background;
    context.fillRect(0, 0, this.width, this.height);
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
    context.fillStyle = this.theme.background;
    context.fillRect(0, y, this.width, this.cellHeight);
    if (!row) {
      context.restore();
      return;
    }

    for (const cell of row.cells) {
      this.paintCell(context, cell, cell.column * this.cellWidth, y, stableRow);
    }
    context.restore();
  }

  private paintCell(
    context: CanvasRenderingContext2D,
    cell: TerminalRenderCell,
    x: number,
    y: number,
    stableRow: number,
  ) {
    const cellWidth = this.cellWidth * Math.max(1, cell.width);
    let foreground = cssColor(cell.foreground, this.theme, "foreground");
    let background = cssColor(cell.background, this.theme, "background");
    if (cell.reverse) [foreground, background] = [background, foreground];

    if (this.cellIsSelected(stableRow, cell)) {
      background =
        this.theme.selectionBackground ?? this.theme.foreground ?? "#4a4a4a";
      foreground = this.theme.foreground;
    } else if (this.cellIsSearchMatched(stableRow, cell)) {
      background = this.theme.yellow ?? "#a68b00";
      foreground = this.theme.background;
    } else {
      foreground = ensureContrast(
        foreground,
        background,
        this.theme.minimumContrast,
      );
    }

    context.fillStyle = background;
    context.fillRect(x, y, cellWidth, this.cellHeight);
    if (cell.invisible) return;

    context.save();
    context.beginPath();
    context.rect(x, y, cellWidth, this.cellHeight);
    context.clip();
    this.paintImages(
      context,
      cell.images,
      x,
      y,
      cellWidth,
      this.cellHeight,
      -1,
    );
    context.globalAlpha = cell.intensity === "half" ? 0.5 : 1;
    context.font = fontFor(cell, this.font);
    context.fillStyle = foreground;
    context.textBaseline = "alphabetic";
    context.fillText(
      cell.text,
      x + this.font.letterSpacing / 2,
      y + this.baseline,
    );

    const underline = cell.underline !== "none";
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
    this.paintImages(context, cell.images, x, y, cellWidth, this.cellHeight, 1);
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
    if (!image.dataBase64 || this.imageLoads.has(image.cacheKey)) return null;
    this.imageLoads.add(image.cacheKey);
    void decodeImage(image)
      .then((source) => {
        if (source) {
          if (!this.imageCache.has(image.cacheKey) && this.imageCache.size >= IMAGE_CACHE_CAPACITY) {
            const oldest = this.imageCache.keys().next().value as string | undefined;
            if (oldest) {
              const evicted = this.imageCache.get(oldest);
              if (evicted && "close" in evicted && typeof evicted.close === "function") {
                evicted.close();
              }
              this.imageCache.delete(oldest);
            }
          }
          this.imageCache.set(image.cacheKey, source);
          this.redrawVisibleRows();
        }
      })
      .catch(() => {
        // A malformed or oversized image must not stop text rendering.
      })
      .finally(() => this.imageLoads.delete(image.cacheKey));
    return null;
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

  private cellIsSelected(stableRow: number, cell: TerminalRenderCell) {
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
    return cell.column < to && cell.column + Math.max(1, cell.width) > from;
  }

  private cellIsSearchMatched(stableRow: number, cell: TerminalRenderCell) {
    const match = this.searchMatch;
    if (!match || match.stableRow !== stableRow) return false;
    return (
      cell.column < match.endColumn &&
      cell.column + Math.max(1, cell.width) > match.startColumn
    );
  }

  private redrawVisibleRows() {
    const frame = this.frame;
    if (!frame) return;
    this.clear();
    for (let row = 0; row < frame.rows; row++) {
      const stableRow = frame.viewportTop + row;
      this.paintRow(stableRow, this.rowCache.get(stableRow));
    }
    this.paintCursor(frame, true);
  }
}

function mergePendingFrame(
  pending: TerminalRenderFrame | null,
  next: TerminalRenderFrame,
): TerminalRenderFrame {
  if (!pending) return next;
  if (
    next.fullSnapshot ||
    pending.rows !== next.rows ||
    pending.cols !== next.cols ||
    pending.viewportTop !== next.viewportTop
  ) {
    return next;
  }

  const rows = new Map<number, TerminalRenderRow>();
  for (const row of pending.dirtyRows) rows.set(row.stableRow, row);
  for (const row of next.dirtyRows) rows.set(row.stableRow, row);
  return {
    ...next,
    dirtyRows: [...rows.values()],
    fullSnapshot: pending.fullSnapshot,
  };
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
    const cellStart = cell.column;
    const cellEnd = cell.column + Math.max(1, cell.width);
    if (cellEnd <= from) continue;
    if (cellStart >= to) break;
    const value = cell.text || " ";
    text += value;
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
    while (terminalColumn < cell.column) {
      text += " ";
      columns.push(terminalColumn);
      terminalColumn += 1;
    }
    const value = cell.text || " ";
    for (const character of value) {
      text += character;
      for (let offset = 0; offset < character.length; offset += 1) {
        columns.push(cell.column);
      }
    }
    const width = Math.max(1, cell.width);
    for (let offset = 1; offset < width; offset += 1) {
      // Wide cells occupy one extra terminal column after their grapheme.
      text += " ";
      columns.push(cell.column + offset);
    }
    terminalColumn = cell.column + width;
  }
  return { text, columns };
}
