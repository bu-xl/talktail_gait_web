/**
 * Mat pressure heatmap.
 *
 * Draws a 40x40 `ImageData` and lets the GPU scale it to the panel. Painting
 * 1600 `fillRect` calls per frame instead costs more than the frame budget on
 * its own.
 *
 * Two rules carry most of the correctness here:
 *
 *  1. The mat runs at 39-45 Hz while the video runs at 30 fps, and the periods
 *     are not integer multiples. Sampling with `nearest` therefore shows the
 *     same mat frame twice or skips one, which reads as a visible flicker. The
 *     lookup uses `interp`.
 *  2. Missing data is not pressure zero. A gap is covered with a grey hatch and
 *     labelled, never interpolated across and never painted as the colormap's
 *     low end.
 */

import { MAT_ASPECT } from "../../core/constants.js";
import type { Renderer } from "../masterClock.js";
import type { SampleTrack } from "../track.js";
import { CanvasSurface, offscreen } from "./canvasSurface.js";
import { buildLut } from "./colormap.js";
import type { ColormapName } from "./colormap.js";

export interface MatHeatmapOptions {
  /** RAW ADC track, stride `rows * cols`. */
  track: SampleTrack;
  /** Per-cell unloaded reference in RAW counts. */
  baseline: Float32Array;
  /** Session peak cell load; fixes the colour scale so it cannot pulse. */
  loadMax: number;
  rows: number;
  cols: number;
  /** Caller-supplied so the renderer stays free of i18n wiring. */
  labels: { noData: string };
  colormap?: ColormapName;
  /** Smooth the upscale, or keep sensor cells crisp. */
  smooth?: boolean;
  /**
   * Per-row acquisition skew across one frame, ns.
   *
   * The mat scans row by row, so the bottom row is sampled later than the top.
   * This pipeline does not report the value, so it defaults to 0 (hint off).
   * Supply it only if the firmware actually publishes it.
   */
  scanSkewNs?: number;
}

export class MatHeatmapRenderer implements Renderer {
  readonly name = "mat";
  lastDrawnNs?: bigint;

  private readonly surface: CanvasSurface;
  private readonly grid: HTMLCanvasElement;
  private readonly gridCtx: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private lut: Uint8ClampedArray;
  private hatch: CanvasPattern | null = null;

  private colormapName: ColormapName;
  private smooth: boolean;
  private showTiming = false;
  private showScanSkew = false;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly opts: MatHeatmapOptions,
  ) {
    this.surface = new CanvasSurface(canvas);
    this.colormapName = opts.colormap ?? "viridis";
    this.smooth = opts.smooth ?? true;
    this.lut = buildLut(this.colormapName);

    this.grid = offscreen(opts.cols, opts.rows);
    const gridCtx = this.grid.getContext("2d");
    if (!gridCtx) throw new Error("mat heatmap: offscreen 2D context unavailable");
    this.gridCtx = gridCtx;
    this.image = gridCtx.createImageData(opts.cols, opts.rows);
  }

  setColormap(name: ColormapName): void {
    this.colormapName = name;
    this.lut = buildLut(name);
  }

  get colormap(): ColormapName {
    return this.colormapName;
  }

  setSmooth(on: boolean): void {
    this.smooth = on;
  }

  /** Developer overlay: how far the shown sample sits from the master clock. */
  setShowTiming(on: boolean): void {
    this.showTiming = on;
  }

  /** Advanced hint that lower rows were acquired later within the frame. */
  setShowScanSkew(on: boolean): void {
    this.showScanSkew = on;
  }

  draw(tMasterNs: bigint): void {
    this.surface.resize();
    const ctx = this.surface.begin();
    const { x, y, width, height } = this.panelBox();

    const sample = this.opts.track.gapAt(tMasterNs)
      ? null
      : this.opts.track.at(tMasterNs, "interp");

    if (!sample) {
      this.drawNoData(ctx, x, y, width, height);
      this.lastDrawnNs = tMasterNs;
      return;
    }

    this.fillImage(sample);
    this.gridCtx.putImageData(this.image, 0, 0);
    ctx.imageSmoothingEnabled = this.smooth;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this.grid, x, y, width, height);

    if (this.showScanSkew && (this.opts.scanSkewNs ?? 0) > 0) {
      this.drawScanSkewHint(ctx, x, y, width, height);
    }
    if (this.showTiming) this.drawTimingOverlay(ctx, tMasterNs);

    this.lastDrawnNs = tMasterNs;
  }

  /**
   * Centred panel box at the mat's true 1:2.3014 portrait aspect.
   *
   * The grid is 40x40 but the cells are not square (1.825 x 4.2 cm), so drawing
   * it into a square box squashes every footprint horizontally. In a landscape
   * panel the mat is a narrow column, so it is centred rather than pinned to a
   * corner.
   */
  private panelBox(): { x: number; y: number; width: number; height: number } {
    const { cssWidth, cssHeight } = this.surface;
    const height = Math.min(cssHeight, cssWidth * MAT_ASPECT);
    const width = height / MAT_ASPECT;
    return { x: (cssWidth - width) / 2, y: (cssHeight - height) / 2, width, height };
  }

  /**
   * RAW -> load -> colour, vectorised over the whole grid in one pass.
   *
   * RAW falls under load, so the mapping is inverted against the per-cell
   * unloaded baseline. Normalisation is anchored to the session peak, computed
   * once at load time; recomputing per frame makes the colours pulse.
   */
  private fillImage(sample: Float32Array): void {
    const { baseline, loadMax } = this.opts;
    const data = this.image.data;
    const lut = this.lut;
    const scale = loadMax > 0 ? 255 / loadMax : 0;

    for (let k = 0; k < sample.length; k++) {
      const load = baseline[k] - sample[k];
      const idx = load > 0 ? Math.min(255, (load * scale) | 0) << 2 : 0;
      const o = k << 2;
      data[o] = lut[idx];
      data[o + 1] = lut[idx + 1];
      data[o + 2] = lut[idx + 2];
      data[o + 3] = lut[idx + 3];
    }
  }

  /**
   * Grey diagonal hatch plus a label.
   *
   * Deliberately not a colour from the scale: an unloaded mat and a mat with no
   * recorded data must never look alike, or a dropout reads as the dog lifting
   * its paw.
   */
  private drawNoData(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = "#1a1c20";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = this.hatchPattern(ctx) ?? "#3a3d43";
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = "#c8ccd2";
    ctx.font = "600 13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(this.opts.labels.noData, width / 2, height / 2);
    ctx.restore();
  }

  private hatchPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
    if (this.hatch) return this.hatch;
    const tile = offscreen(8, 8);
    const tctx = tile.getContext("2d");
    if (!tctx) return null;
    tctx.strokeStyle = "rgba(150, 156, 166, 0.55)";
    tctx.lineWidth = 2;
    tctx.beginPath();
    tctx.moveTo(-2, 10);
    tctx.lineTo(10, -2);
    tctx.stroke();
    this.hatch = ctx.createPattern(tile, "repeat");
    return this.hatch;
  }

  /** Faint top-to-bottom shade: lower rows were sampled later in the frame. */
  private drawScanSkewHint(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    const gradient = ctx.createLinearGradient(0, y, 0, y + height);
    gradient.addColorStop(0, "rgba(255, 255, 255, 0.10)");
    gradient.addColorStop(1, "rgba(0, 0, 0, 0.10)");
    ctx.save();
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, width, height);
    ctx.restore();
  }

  /**
   * Distance from the master clock to the sample actually on screen.
   * It must stay inside half a mat period (~12 ms); more than that means the
   * track lookup is wrong, not that the mat is slow.
   */
  private drawTimingOverlay(ctx: CanvasRenderingContext2D, tMasterNs: bigint): void {
    const track = this.opts.track;
    const tTrack = Number(tMasterNs - track.offsetNs);
    const idx = track.nearestIndexNs(tTrack);
    if (idx < 0) return;

    const deltaMs = (Number(track.timeAt(idx) - tMasterNs)) / 1e6;
    const halfPeriodMs = track.periodStats().p50 / 2e6;
    const over = Math.abs(deltaMs) > halfPeriodMs;

    ctx.save();
    ctx.font = "500 11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const text = `Δt ${deltaMs >= 0 ? "+" : ""}${deltaMs.toFixed(2)} ms / half-period ${halfPeriodMs.toFixed(2)} ms`;
    const w = ctx.measureText(text).width + 10;
    ctx.fillStyle = "rgba(10, 12, 16, 0.78)";
    ctx.fillRect(4, 4, w, 18);
    ctx.fillStyle = over ? "#ff7a6b" : "#9fe8c0";
    ctx.fillText(text, 9, 8);
    ctx.restore();
  }
}
