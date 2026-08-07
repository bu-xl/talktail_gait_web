/**
 * Canvas heatmap renderer.
 *
 *   pressure matrix -> upsample + blur (NaN-aware) -> fixed colormap -> ImageData
 *   -> offscreen canvas -> drawImage onto the display canvas at the true aspect.
 *
 * Design rules honoured:
 *   - portrait 1:2.3014 aspect (73 x 168 cm, non-square cells) — never a square;
 *   - fixed colorbar_range (default [10, 80]) — no per-frame autoscale flicker;
 *   - cells below visible_min are fully transparent;
 *   - thresholding happens upstream; here we only soften the alpha edge;
 *   - optional debug grid (off by default).
 */

import { buildLut, pressureToRgba } from "./colormap.js";
import { colorizeField } from "./colorize.js";
import { buildSmoothField, SmoothFieldScratch } from "./interpolation.js";
import { GRID_COLS, GRID_ROWS } from "../core/constants.js";
import type { AppConfig, Matrix } from "../core/types.js";

export class HeatmapRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly offscreen: HTMLCanvasElement;
  private readonly offCtx: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private lut: Uint8ClampedArray;
  private readonly dstW: number;
  private readonly dstH: number;
  private readonly scratch: SmoothFieldScratch;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private config: AppConfig,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;

    this.dstW = config.render.upsample_width;
    this.dstH = config.render.upsample_height;
    this.offscreen = makeCanvas(this.dstW, this.dstH);
    const offCtx = this.offscreen.getContext("2d");
    if (!offCtx) throw new Error("offscreen context unavailable");
    this.offCtx = offCtx;
    this.image = this.offCtx.createImageData(this.dstW, this.dstH);
    this.scratch = new SmoothFieldScratch(GRID_ROWS, GRID_COLS, this.dstW, this.dstH);
    this.lut = buildLut(
      config.pressure_thresholds.visible_min_mmhg,
      config.colorbar_range,
    );
  }

  setConfig(config: AppConfig): void {
    this.config = config;
    this.lut = buildLut(config.pressure_thresholds.visible_min_mmhg, config.colorbar_range);
  }

  /** Render one smoothed, thresholded pressure matrix (rows x cols, row-major). */
  render(pressure: Matrix, rows: number, cols: number): void {
    const { visible_min_mmhg } = this.config.pressure_thresholds;
    const range = this.config.colorbar_range;
    const nearest = this.config.render.interpolation === "nearest";
    const field = buildSmoothField(pressure, rows, cols, this.dstW, this.dstH, {
      sigmaMin: this.config.render.gaussian_sigma_min,
      sigmaMax: this.config.render.gaussian_sigma_max,
      // Map pressure -> blur amount over the visible..colorbar-high band.
      normLo: visible_min_mmhg,
      normHi: this.config.colorbar_range[1],
      nearest,
      scratch: this.scratch,
    });

    colorizeField(field, this.lut, visible_min_mmhg, range, this.image.data);
    this.offCtx.putImageData(this.image, 0, 0);

    // Blit to the display canvas (kept at the true 1:2.3014 aspect by CSS / attributes).
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // Match GPU scaling to the chosen mode: nearest keeps sensor blocks crisp;
    // bilinear softens the upscale to screen.
    this.ctx.imageSmoothingEnabled = !nearest;
    this.ctx.imageSmoothingQuality = "high";
    this.ctx.drawImage(this.offscreen, 0, 0, this.canvas.width, this.canvas.height);

    if (this.config.render.show_grid) this.drawGrid(rows, cols);
  }

  private drawGrid(rows: number, cols: number): void {
    const { width, height } = this.canvas;
    this.ctx.save();
    this.ctx.strokeStyle = "rgba(255,255,255,0.15)";
    this.ctx.lineWidth = 1;
    for (let c = 0; c <= cols; c++) {
      const x = (c / cols) * width;
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, height);
      this.ctx.stroke();
    }
    for (let r = 0; r <= rows; r++) {
      const y = (r / rows) * height;
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(width, y);
      this.ctx.stroke();
    }
    this.ctx.restore();
  }
}

/** Off-DOM canvas (OffscreenCanvas when available, else a detached <canvas>). */
function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

export { pressureToRgba };
