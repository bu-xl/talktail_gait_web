/**
 * Canvas sizing shared by the player's renderers.
 *
 * Without a devicePixelRatio-aware backing store every panel is soft on a
 * Retina display, which matters here because the panels carry fine lines
 * (skeleton, chart gridlines, playhead).
 */

export class CanvasSurface {
  readonly ctx: CanvasRenderingContext2D;
  /** CSS pixel size, which is what drawing code should use. */
  cssWidth = 0;
  cssHeight = 0;
  private dpr = 1;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly maxDpr = 2,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error(`2D context unavailable for canvas ${canvas.id || "(unnamed)"}`);
    this.ctx = ctx;
    this.resize();
  }

  /**
   * Match the backing store to the element's CSS box. Returns true when the size
   * changed, so callers can invalidate cached static layers.
   */
  resize(): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width || this.canvas.clientWidth || 1));
    const cssH = Math.max(1, Math.round(rect.height || this.canvas.clientHeight || 1));
    const dpr = Math.min(this.maxDpr, Math.max(1, globalThis.devicePixelRatio || 1));
    if (cssW === this.cssWidth && cssH === this.cssHeight && dpr === this.dpr) return false;

    this.cssWidth = cssW;
    this.cssHeight = cssH;
    this.dpr = dpr;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    return true;
  }

  /** Reset the transform to CSS pixels and clear. */
  begin(): CanvasRenderingContext2D {
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    return this.ctx;
  }

  get devicePixelRatio(): number {
    return this.dpr;
  }
}

/** Off-DOM canvas for static layers and pattern tiles. */
export function offscreen(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, width);
  c.height = Math.max(1, height);
  return c;
}
