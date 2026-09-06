/**
 * A small, colour-independent glyph atlas for the WebGL terminal renderer.
 *
 * Glyphs are rasterized once by Canvas2D (which already has the browser's
 * shaping, combining-mark, CJK, and emoji support) and then sampled by one
 * WebGL draw for the whole visible grid. The atlas is deliberately bounded;
 * an unusual font/workload can ask the caller to fall back to Canvas2D.
 */
export interface GlyphRecord {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  padding: number;
  /** Browser-rasterized color glyphs, such as emoji, must not be tinted. */
  color: boolean;
}

const ATLAS_SIZE = 2048;

function deviceFont(font: string, dpr: number) {
  return font.replace(/(\d+(?:\.\d+)?)px/u, (_, size: string) => {
    return `${Number(size) * dpr}px`;
  });
}

/** ASCII cannot be colour-emoji; skip the per-glyph pixel scan. */
export function glyphMayBeColor(text: string) {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 127) return true;
  }
  return false;
}

export class GlyphAtlas {
  private readonly context: CanvasRenderingContext2D;
  private readonly texture: WebGLTexture;
  private readonly records = new Map<string, GlyphRecord>();
  private cursorX = 0;
  private cursorY = 0;
  private rowHeight = 0;
  private cellWidth = 8;
  private cellHeight = 17;
  private baseline = 14;
  private dpr = 1;
  private resetDuringPass = false;

  constructor(private readonly gl: WebGL2RenderingContext) {
    const canvas = document.createElement("canvas");
    canvas.width = ATLAS_SIZE;
    canvas.height = ATLAS_SIZE;
    const context = canvas.getContext("2d");
    if (!context)
      throw new Error("Glyph atlas could not create a Canvas2D context");
    const texture = gl.createTexture();
    if (!texture)
      throw new Error("Glyph atlas could not create a WebGL texture");

    this.context = context;
    this.texture = texture;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.clearTexture();
  }

  configure(
    cellWidth: number,
    cellHeight: number,
    baseline: number,
    dpr: number,
  ) {
    const nextDpr = Math.max(1, dpr);
    if (
      this.cellWidth === cellWidth &&
      this.cellHeight === cellHeight &&
      this.baseline === baseline &&
      this.dpr === nextDpr
    ) {
      return;
    }
    this.cellWidth = cellWidth;
    this.cellHeight = cellHeight;
    this.baseline = baseline;
    this.dpr = nextDpr;
    this.records.clear();
    this.cursorX = 0;
    this.cursorY = 0;
    this.rowHeight = 0;
    this.clearTexture();
  }

  get(text: string, span: number, font: string): GlyphRecord | null {
    if (!text) return null;
    const safeSpan = Math.max(1, span);
    const rasterFont = deviceFont(font, this.dpr);
    const key = `${rasterFont}\u0000${safeSpan}\u0000${text}`;
    const existing = this.records.get(key);
    if (existing) return existing;

    const padding = Math.max(2, Math.ceil(this.dpr));
    const width = Math.ceil(this.cellWidth * safeSpan * this.dpr) + padding * 2;
    const height = Math.ceil(this.cellHeight * this.dpr) + padding * 2;
    if (width > ATLAS_SIZE || height > ATLAS_SIZE) return null;
    if (this.cursorX + width > ATLAS_SIZE) {
      this.cursorX = 0;
      this.cursorY += this.rowHeight;
      this.rowHeight = 0;
    }
    if (this.cursorY + height > ATLAS_SIZE) {
      if (this.records.size === 0) return null;
      this.reset();
      this.resetDuringPass = true;
      return null;
    }

    const x = this.cursorX;
    const y = this.cursorY;
    const context = this.context;
    context.clearRect(x, y, width, height);
    context.font = rasterFont;
    context.textBaseline = "alphabetic";
    context.fillStyle = "#ffffff";
    context.globalAlpha = 1;
    context.fillText(text, x + padding, y + padding + this.baseline * this.dpr);
    const pixels = context.getImageData(x, y, width, height);
    let color = false;
    if (glyphMayBeColor(text)) {
      for (let index = 0; index < pixels.data.length; index += 4) {
        if (
          pixels.data[index] !== pixels.data[index + 1] ||
          pixels.data[index + 1] !== pixels.data[index + 2]
        ) {
          color = true;
          break;
        }
      }
    }

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      x,
      y,
      width,
      height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels.data,
    );

    const record: GlyphRecord = {
      u0: x / ATLAS_SIZE,
      v0: y / ATLAS_SIZE,
      u1: (x + width) / ATLAS_SIZE,
      v1: (y + height) / ATLAS_SIZE,
      padding,
      color,
    };
    this.records.set(key, record);
    this.cursorX += width;
    this.rowHeight = Math.max(this.rowHeight, height);
    return record;
  }

  getTexture() {
    return this.texture;
  }

  beginPass() {
    this.resetDuringPass = false;
  }

  wasResetDuringPass() {
    return this.resetDuringPass;
  }

  dispose() {
    this.gl.deleteTexture(this.texture);
    this.records.clear();
  }

  private reset() {
    this.records.clear();
    this.cursorX = 0;
    this.cursorY = 0;
    this.rowHeight = 0;
    this.clearTexture();
  }

  private clearTexture() {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      ATLAS_SIZE,
      ATLAS_SIZE,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
  }
}
