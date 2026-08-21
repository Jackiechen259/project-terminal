(function (global) {
  "use strict";

  const ANSI = [
    "#111827",
    "#ff6b76",
    "#55d99d",
    "#f5c96a",
    "#68a3ff",
    "#b996f4",
    "#56c7d9",
    "#dce6f3",
    "#66758a",
    "#ff9ba2",
    "#72e5b7",
    "#ffdb85",
    "#8ab8ff",
    "#d0adff",
    "#78dbea",
    "#ffffff",
  ];
  const FONT_FAMILY =
    '"Cascadia Mono", "SFMono-Regular", Consolas, ui-monospace, monospace';
  const THEME = {
    background: "#05070b",
    foreground: "#dce6f3",
    cursor: "#75aaff",
    selection: "#244b80",
  };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function rgba(value, fallback) {
    if (!Array.isArray(value) || value.length < 3) return fallback;
    const alpha = value.length > 3 ? value[3] / 255 : 1;
    return (
      "rgba(" +
      value[0] +
      ", " +
      value[1] +
      ", " +
      value[2] +
      ", " +
      alpha +
      ")"
    );
  }

  function xtermPalette(index) {
    if (index < 16) return ANSI[index] || ANSI[0];
    if (index >= 232) {
      const level = 8 + (index - 232) * 10;
      return "rgb(" + level + ", " + level + ", " + level + ")";
    }
    const cube = index - 16;
    const blue = cube % 6;
    const green = Math.floor(cube / 6) % 6;
    const red = Math.floor(cube / 36);
    const channel = (part) => (part === 0 ? 0 : 55 + part * 40);
    return (
      "rgb(" +
      channel(red) +
      ", " +
      channel(green) +
      ", " +
      channel(blue) +
      ")"
    );
  }

  function color(value, fallback, palette) {
    if (!value || value.kind === "default") return fallback;
    if (value.kind === "rgba") return rgba(value.value, fallback);
    if (value.kind === "palette") {
      const index = Number(value.value);
      return palette?.[index] || xtermPalette(index);
    }
    return fallback;
  }

  function buttonName(button) {
    if (button === 0) return "left";
    if (button === 1) return "middle";
    if (button === 2) return "right";
    return "none";
  }

  class RemoteTerminalRenderer {
    constructor() {
      this.container = null;
      this.canvas = null;
      this.context = null;
      this.input = null;
      this.rows = 24;
      this.cols = 80;
      this.cellWidth = 8;
      this.cellHeight = 17;
      this.baseline = 14;
      this.fontSize = 13;
      this.dpr = 1;
      this.frame = null;
      this.rowCache = new Map();
      this.pendingFrame = null;
      this.renderHandle = 0;
      this.resizeObserver = null;
      this.inputEnabled = false;
      this.composing = false;
      this.lastGrid = "";
      this.bellTimer = null;
      this.imageCache = new Map();
      this.imageLoads = new Map();
      this.handlers = {
        text: null,
        key: null,
        paste: null,
        mouse: null,
        viewport: null,
        resize: null,
      };
    }

    open(container) {
      this.container = container;
      container.replaceChildren();
      container.classList.add("remote-terminal-container");

      this.canvas = document.createElement("canvas");
      this.canvas.className = "remote-terminal-canvas";
      this.canvas.setAttribute("role", "application");
      this.canvas.setAttribute("aria-label", "Remote terminal");
      container.append(this.canvas);

      this.input = document.createElement("textarea");
      this.input.className = "remote-terminal-input";
      this.input.setAttribute("aria-label", "Terminal input");
      this.input.autocapitalize = "off";
      this.input.autocomplete = "off";
      this.input.autocorrect = "off";
      this.input.spellcheck = false;
      container.append(this.input);

      this.context = this.canvas.getContext("2d", {
        alpha: false,
        desynchronized: true,
      });
      if (!this.context) throw new Error("Canvas2D is unavailable");
      this.installInputHandlers();
      this.resizeObserver = new ResizeObserver(() => this.fit());
      this.resizeObserver.observe(container);
      this.fit();
      this.render();
    }

    onText(callback) {
      this.handlers.text = callback;
    }

    onKey(callback) {
      this.handlers.key = callback;
    }

    onPaste(callback) {
      this.handlers.paste = callback;
    }

    onMouse(callback) {
      this.handlers.mouse = callback;
    }

    onViewport(callback) {
      this.handlers.viewport = callback;
    }

    onResize(callback) {
      this.handlers.resize = callback;
    }

    setInputEnabled(enabled) {
      this.inputEnabled = Boolean(enabled);
      if (this.input) this.input.disabled = !this.inputEnabled;
    }

    focus() {
      if (!this.input) return;
      try {
        this.input.focus({ preventScroll: true });
      } catch {
        this.input.focus();
      }
    }

    fit(force = false) {
      if (!this.container || !this.context) return;
      const width = Math.max(1, this.container.clientWidth);
      const height = Math.max(1, this.container.clientHeight);
      const fontSize = window.innerWidth < 540 ? 12 : 13;
      this.fontSize = fontSize;
      this.context.font = fontSize + "px " + FONT_FAMILY;
      const measured = this.context.measureText("M");
      const cellWidth = Math.max(1, measured.width);
      const cellHeight = Math.max(fontSize + 4, Math.ceil(fontSize * 1.22));
      const cols = Math.max(1, Math.floor((width - 8) / cellWidth));
      const rows = Math.max(1, Math.floor((height - 6) / cellHeight));
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      const grid =
        width + ":" + height + ":" + cols + ":" + rows + ":" + dpr;
      this.cellWidth = cellWidth;
      this.cellHeight = cellHeight;
      this.baseline = Math.ceil(fontSize * 0.92);
      if (grid === this.lastGrid && !force) return;
      this.lastGrid = grid;
      this.dpr = dpr;
      this.cols = cols;
      this.rows = rows;
      this.canvas.width = Math.ceil(width * dpr);
      this.canvas.height = Math.ceil(height * dpr);
      this.canvas.style.width = width + "px";
      this.canvas.style.height = height + "px";
      this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.rowCache.clear();
      this.render();
      this.handlers.resize?.({ cols, rows });
    }

    reset() {
      this.frame = null;
      this.pendingFrame = null;
      this.rowCache.clear();
      if (this.context && this.container) {
        this.context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        this.context.fillStyle = THEME.background;
        this.context.fillRect(
          0,
          0,
          this.container.clientWidth,
          this.container.clientHeight,
        );
      }
    }

    renderFrame(frame) {
      if (!frame) return;
      this.pendingFrame = frame;
      if (this.renderHandle) return;
      this.renderHandle = requestAnimationFrame(() => {
        this.renderHandle = 0;
        const next = this.pendingFrame;
        this.pendingFrame = null;
        if (next) this.applyFrame(next);
      });
    }

    pulseBell() {
      if (!this.container) return;
      this.container.classList.add("remote-terminal-bell");
      clearTimeout(this.bellTimer);
      this.bellTimer = setTimeout(
        () => this.container?.classList.remove("remote-terminal-bell"),
        180,
      );
    }

    dispose() {
      cancelAnimationFrame(this.renderHandle);
      this.renderHandle = 0;
      this.resizeObserver?.disconnect();
      this.resizeObserver = null;
      this.imageCache.clear();
      this.imageLoads.clear();
      this.container?.replaceChildren();
      this.container = null;
      this.canvas = null;
      this.context = null;
      this.input = null;
    }

    applyFrame(frame) {
      const dimensionsChanged =
        this.frame &&
        (this.frame.rows !== frame.rows || this.frame.cols !== frame.cols);
      const viewportChanged =
        this.frame && this.frame.viewportTop !== frame.viewportTop;
      if (frame.fullSnapshot || dimensionsChanged || viewportChanged) {
        this.rowCache.clear();
      }
      for (const row of frame.dirtyRows || []) {
        this.rowCache.set(String(row.stableRow), row);
      }
      this.frame = frame;
      this.render();
    }

    render() {
      if (!this.context || !this.container) return;
      const width = this.container.clientWidth;
      const height = this.container.clientHeight;
      this.context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.context.globalAlpha = 1;
      this.context.font = this.fontSize + "px " + FONT_FAMILY;
      this.context.textBaseline = "alphabetic";
      this.context.fillStyle = THEME.background;
      this.context.fillRect(0, 0, width, height);
      if (!this.frame) return;

      const palette = this.frame.palette || {};
      const top = Number(this.frame.viewportTop || 0);
      const rows = Number(this.frame.rows || this.rows);
      const cols = Number(this.frame.cols || this.cols);
      for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
        const stableRow = top + rowIndex;
        this.paintRow(
          this.rowCache.get(String(stableRow)),
          rowIndex,
          cols,
          palette,
        );
      }
      this.paintImages();
      this.paintCursor();
    }

    paintRow(row, rowIndex, cols, palette) {
      const y = 3 + rowIndex * this.cellHeight;
      if (!row) return;
      let cursor = 0;
      for (const cell of row.cells || []) {
        const column = Number(cell.column || cursor);
        const width = Math.max(1, Number(cell.width || 1));
        cursor = column + width;
        if (column >= cols) continue;
        const x = column * this.cellWidth + 4;
        const pixelWidth = width * this.cellWidth;
        const background = color(cell.background, THEME.background, palette);
        if (cell.reverse) {
          this.context.fillStyle = color(
            cell.foreground,
            THEME.foreground,
            palette,
          );
        } else {
          this.context.fillStyle = background;
        }
        this.context.fillRect(x, y, pixelWidth + 0.5, this.cellHeight);

        if (cell.invisible || !cell.text) continue;
        let foreground = color(cell.foreground, THEME.foreground, palette);
        if (cell.reverse) foreground = background;
        const weight = cell.intensity === "bold" ? "700" : "400";
        const italic = cell.italic ? "italic " : "";
        this.context.font =
          italic + weight + " " + this.fontSize + "px " + FONT_FAMILY;
        this.context.globalAlpha = cell.intensity === "half" ? 0.58 : 1;
        this.context.fillStyle = foreground;
        this.context.fillText(cell.text, x, y + this.baseline);
        this.context.globalAlpha = 1;
        this.paintDecorations(cell, x, y, pixelWidth, foreground);
      }
    }

    paintDecorations(cell, x, y, width, foreground) {
      this.context.strokeStyle = color(
        cell.underlineColor,
        foreground,
        this.frame?.palette,
      );
      this.context.lineWidth = 1;
      if (cell.underline && cell.underline !== "none") {
        const underlineY =
          cell.underline === "double"
            ? y + this.cellHeight - 4
            : y + this.cellHeight - 2;
        this.context.beginPath();
        this.context.moveTo(x, underlineY);
        this.context.lineTo(x + width, underlineY);
        if (cell.underline === "double") {
          this.context.moveTo(x, underlineY - 2);
          this.context.lineTo(x + width, underlineY - 2);
        }
        this.context.stroke();
      }
      if (cell.strikethrough) {
        const strikeY = y + Math.floor(this.cellHeight * 0.56);
        this.context.beginPath();
        this.context.moveTo(x, strikeY);
        this.context.lineTo(x + width, strikeY);
        this.context.stroke();
      }
    }

    paintCursor() {
      const cursor = this.frame?.cursor;
      if (!cursor || cursor.visibility !== "visible") return;
      if (this.frame.viewportTop !== this.frame.viewportBottom) return;
      const row = Number(cursor.row);
      const column = Number(cursor.column);
      if (row < 0 || row >= this.frame.rows) return;
      const x = 4 + column * this.cellWidth;
      const y = 3 + row * this.cellHeight;
      this.context.fillStyle = THEME.cursor;
      if (
        cursor.shape === "blinking-underline" ||
        cursor.shape === "steady-underline"
      ) {
        this.context.fillRect(x, y + this.cellHeight - 2, this.cellWidth, 2);
      } else if (
        cursor.shape === "blinking-bar" ||
        cursor.shape === "steady-bar"
      ) {
        this.context.fillRect(x, y, 2, this.cellHeight);
      } else {
        this.context.globalAlpha = 0.82;
        this.context.fillRect(x, y, this.cellWidth, this.cellHeight);
        this.context.globalAlpha = 1;
      }
    }

    paintImages() {
      for (const row of this.rowCache.values()) {
        for (const cell of row.cells || []) {
          for (const image of cell.images || []) {
            const imageObject = this.getImage(image);
            if (!imageObject) continue;
            const x = image.topLeft[0] * this.cellWidth + 4;
            const y = image.topLeft[1] * this.cellHeight + 3;
            const width =
              (image.bottomRight[0] - image.topLeft[0]) * this.cellWidth;
            const height =
              (image.bottomRight[1] - image.topLeft[1]) * this.cellHeight;
            if (width > 0 && height > 0)
              this.context.drawImage(imageObject, x, y, width, height);
          }
        }
      }
    }

    getImage(image) {
      if (this.imageCache.has(image.cacheKey))
        return this.imageCache.get(image.cacheKey);
      if (!image.dataBase64 || this.imageLoads.has(image.cacheKey)) return null;
      const load = this.decodeImage(image);
      this.imageLoads.set(image.cacheKey, load);
      load.then((value) => {
        this.imageLoads.delete(image.cacheKey);
        if (value) {
          this.imageCache.set(image.cacheKey, value);
          this.render();
        }
      });
      return null;
    }

    async decodeImage(image) {
      try {
        const bytes = Uint8Array.from(atob(image.dataBase64), (char) =>
          char.charCodeAt(0),
        );
        if (image.format === "rgba8" && image.width && image.height) {
          const bitmap = new ImageData(
            new Uint8ClampedArray(bytes),
            image.width,
            image.height,
          );
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          canvas.getContext("2d").putImageData(bitmap, 0, 0);
          return canvas;
        }
        const blob = new Blob([bytes], {
          type: image.mimeType || "application/octet-stream",
        });
        return await createImageBitmap(blob);
      } catch {
        return null;
      }
    }

    installInputHandlers() {
      const keyEvent = (event) => ({
        key: event.key,
        code: event.code || null,
        location: event.location || 0,
        numLock: event.getModifierState?.("NumLock") || false,
        shift: event.shiftKey,
        alt: event.altKey,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
      });

      this.input.addEventListener("keydown", (event) => {
        if (!this.inputEnabled || this.composing) return;
        if (event.key === "Dead" || event.key === "Process") return;
        if (
          event.key.length === 1 &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.metaKey
        )
          return;
        event.preventDefault();
        this.handlers.key?.(keyEvent(event));
      });
      this.input.addEventListener("beforeinput", (event) => {
        if (!this.inputEnabled || this.composing) return;
        if (event.inputType === "insertText" && event.data) {
          event.preventDefault();
          this.handlers.text?.(event.data);
        }
      });
      this.input.addEventListener("input", () => {
        if (!this.inputEnabled || this.composing || !this.input.value) return;
        const text = this.input.value;
        this.input.value = "";
        this.handlers.text?.(text);
      });
      this.input.addEventListener("compositionstart", () => {
        this.composing = true;
      });
      this.input.addEventListener("compositionend", (event) => {
        this.composing = false;
        if (this.inputEnabled && event.data) this.handlers.text?.(event.data);
        this.input.value = "";
      });
      this.input.addEventListener("paste", (event) => {
        if (!this.inputEnabled) return;
        event.preventDefault();
        const text = event.clipboardData?.getData("text/plain") || "";
        if (text) this.handlers.paste?.(text);
      });

      this.canvas.addEventListener("pointerdown", (event) => {
        this.focus();
        if (!this.frame?.mouseReporting) return;
        event.preventDefault();
        this.handlers.mouse?.(
          this.mouseEvent(event, "press", buttonName(event.button)),
        );
      });
      this.canvas.addEventListener("pointermove", (event) => {
        if (!this.frame?.mouseReporting || !(event.buttons || event.pressure))
          return;
        event.preventDefault();
        this.handlers.mouse?.(this.mouseEvent(event, "move", "none"));
      });
      this.canvas.addEventListener("pointerup", (event) => {
        if (!this.frame?.mouseReporting) return;
        event.preventDefault();
        this.handlers.mouse?.(
          this.mouseEvent(event, "release", buttonName(event.button)),
        );
      });
      this.canvas.addEventListener("wheel", (event) => {
        event.preventDefault();
        if (this.frame?.mouseReporting) {
          const button = event.deltaY < 0 ? "wheel-up" : "wheel-down";
          this.handlers.mouse?.(this.mouseEvent(event, "press", button));
          return;
        }
        if (!this.frame || this.frame.alternateScreen) return;
        const direction = event.deltaY < 0 ? -1 : 1;
        const next = clamp(
          Number(this.frame.viewportTop || 0) +
            direction * Math.max(1, Math.round(Math.abs(event.deltaY) / 30)),
          Number(this.frame.viewportBottom || 0) -
            Number(this.frame.scrollbackLength || 0),
          Number(this.frame.viewportBottom || 0),
        );
        this.handlers.viewport?.(next);
      });
    }

    mouseEvent(event, kind, button) {
      const rect = this.canvas.getBoundingClientRect();
      const offsetX = clamp(event.clientX - rect.left - 4, 0, rect.width);
      const offsetY = clamp(event.clientY - rect.top - 3, 0, rect.height);
      return {
        kind,
        button,
        x: Math.floor(offsetX / this.cellWidth),
        y: Math.floor(offsetY / this.cellHeight),
        xPixelOffset: Math.round(offsetX % this.cellWidth),
        yPixelOffset: Math.round(offsetY % this.cellHeight),
        shift: event.shiftKey,
        alt: event.altKey,
        ctrl: event.ctrlKey,
      };
    }
  }

  global.ProjectTerminalRemoteRenderer = RemoteTerminalRenderer;
})(window);
