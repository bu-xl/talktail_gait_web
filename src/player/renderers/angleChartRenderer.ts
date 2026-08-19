/**
 * Joint-angle time-series chart with a playhead.
 *
 * Drawn straight to canvas rather than through a chart library: the panel has to
 * repaint on every video frame, and a library that rebuilds a scene graph per
 * frame cannot hold 30 fps next to three other panels.
 *
 * Two layers are composited. Axes, gridlines and labels go on an offscreen
 * static layer redrawn only on resize; each frame repaints just the series and
 * the playhead.
 */

import type { Renderer } from "../masterClock.js";
import { ANGLE_CONF_OFFSET, JOINTS } from "../skeletonSchema.js";
import type { SampleTrack } from "../track.js";
import { CanvasSurface, offscreen } from "./canvasSurface.js";

export interface AngleSeries {
  label: string;
  color: string;
  /**
   * Value for one sample, in degrees. Return NaN to break the line rather than
   * bridging a joint the detector did not report.
   */
  valueAt(track: SampleTrack, index: number): number;
}

export interface AngleChartOptions {
  track: SampleTrack;
  series: readonly AngleSeries[];
  title: string;
  unit?: string;
  /** Full width of the sliding window, ns. Defaults to 6 s (tMaster +/- 3 s). */
  spanNs?: bigint;
  /** Confidence floor below which a sample is drawn faint. */
  confidenceThreshold?: number;
}

const PAD = { top: 22, right: 56, bottom: 20, left: 40 };
const DEFAULT_SPAN_NS = 6_000_000_000n;

export class AngleChartRenderer implements Renderer {
  readonly name: string;
  lastDrawnNs?: bigint;

  private readonly surface: CanvasSurface;
  private readonly spanNs: bigint;
  private readonly confidenceThreshold: number;

  private staticLayer: HTMLCanvasElement | null = null;
  private yMin = 0;
  private yMax = 180;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly opts: AngleChartOptions,
  ) {
    this.name = `chart:${opts.title}`;
    this.surface = new CanvasSurface(canvas);
    this.spanNs = opts.spanNs ?? DEFAULT_SPAN_NS;
    this.confidenceThreshold = opts.confidenceThreshold ?? 0.5;
    this.computeYRange();
  }

  draw(tMasterNs: bigint): void {
    const resized = this.surface.resize();
    if (resized) this.staticLayer = null;
    const ctx = this.surface.begin();
    const { cssWidth: w, cssHeight: h } = this.surface;
    this.lastDrawnNs = tMasterNs;
    if (w <= PAD.left + PAD.right || h <= PAD.top + PAD.bottom) return;

    ctx.drawImage(this.ensureStaticLayer(w, h), 0, 0, w, h);

    const half = this.spanNs / 2n;
    const t0 = tMasterNs - half;
    const range = this.opts.track.windowRange(tMasterNs, this.spanNs);

    if (range) {
      for (const series of this.opts.series) this.drawSeries(ctx, series, range, t0, w, h);
    }
    this.drawPlayhead(ctx, w, h);
    this.drawReadouts(ctx, tMasterNs, w);
  }

  /**
   * Fix the y range from the whole session so the chart does not rescale as the
   * dog moves, which would make a steady joint look like it is swinging.
   */
  private computeYRange(): void {
    const track = this.opts.track;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < track.count; i++) {
      for (const series of this.opts.series) {
        const v = series.valueAt(track, i);
        if (!Number.isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (min > max) {
      this.yMin = 0;
      this.yMax = 180;
      return;
    }
    const pad = Math.max(2, (max - min) * 0.08);
    this.yMin = Math.floor(min - pad);
    this.yMax = Math.ceil(max + pad);
  }

  private ensureStaticLayer(w: number, h: number): HTMLCanvasElement {
    if (this.staticLayer) return this.staticLayer;
    const dpr = this.surface.devicePixelRatio;
    const layer = offscreen(Math.round(w * dpr), Math.round(h * dpr));
    const ctx = layer.getContext("2d");
    if (!ctx) throw new Error(`${this.name}: offscreen 2D context unavailable`);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const plotH = h - PAD.top - PAD.bottom;
    ctx.font = "500 10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = "#8b929c";
    ctx.textBaseline = "middle";

    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const value = this.yMin + ((this.yMax - this.yMin) * i) / ticks;
      const y = PAD.top + plotH - (plotH * i) / ticks;
      ctx.strokeStyle = i === 0 ? "#3a3f47" : "#2a2e34";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD.left, Math.round(y) + 0.5);
      ctx.lineTo(w - PAD.right, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(String(Math.round(value)), PAD.left - 6, y);
    }

    ctx.textAlign = "left";
    ctx.fillStyle = "#c8ccd2";
    ctx.font = "600 11px system-ui, sans-serif";
    ctx.fillText(this.opts.title, PAD.left, PAD.top / 2);

    ctx.font = "500 10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = "#8b929c";
    ctx.textAlign = "center";
    const halfSec = Number(this.spanNs) / 2e9;
    ctx.fillText(`-${halfSec.toFixed(0)}s`, PAD.left, h - PAD.bottom / 2);
    ctx.fillText("0", (PAD.left + w - PAD.right) / 2, h - PAD.bottom / 2);
    ctx.fillText(`+${halfSec.toFixed(0)}s`, w - PAD.right, h - PAD.bottom / 2);

    this.staticLayer = layer;
    return layer;
  }

  private drawSeries(
    ctx: CanvasRenderingContext2D,
    series: AngleSeries,
    range: { start: number; end: number },
    t0: bigint,
    w: number,
    h: number,
  ): void {
    const track = this.opts.track;
    const plotW = w - PAD.left - PAD.right;
    const plotH = h - PAD.top - PAD.bottom;
    const span = Number(this.spanNs);
    const yScale = plotH / (this.yMax - this.yMin || 1);

    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD.left, PAD.top, plotW, plotH);
    ctx.clip();

    ctx.strokeStyle = series.color;
    ctx.lineWidth = 1.75;
    ctx.lineJoin = "round";
    ctx.beginPath();

    let started = false;
    let prevTime = 0;
    for (let i = range.start; i <= range.end; i++) {
      const value = series.valueAt(track, i);
      const timeNs = Number(track.timeAt(i));
      // Break across missing data instead of drawing a straight line over it.
      const jumped = started && timeNs - prevTime > track.gapThresholdNs;
      prevTime = timeNs;

      if (!Number.isFinite(value)) {
        started = false;
        continue;
      }
      const x = PAD.left + ((timeNs - Number(t0)) / span) * plotW;
      const y = PAD.top + plotH - (value - this.yMin) * yScale;
      if (started && !jumped) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      started = true;
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawPlayhead(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const x = Math.round((PAD.left + w - PAD.right) / 2) + 0.5;
    ctx.save();
    ctx.strokeStyle = "#f0663f";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, PAD.top);
    ctx.lineTo(x, h - PAD.bottom);
    ctx.stroke();
    ctx.restore();
  }

  /** Current value per series, pinned to the right gutter. */
  private drawReadouts(ctx: CanvasRenderingContext2D, tMasterNs: bigint, w: number): void {
    const track = this.opts.track;
    const idx = track.nearestIndexNs(Number(tMasterNs - track.offsetNs));
    const missing = idx < 0 || track.gapAt(tMasterNs);

    ctx.save();
    ctx.font = "500 10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    this.opts.series.forEach((series, i) => {
      const y = PAD.top + 8 + i * 13;
      ctx.fillStyle = series.color;
      ctx.fillRect(w - PAD.right + 4, y - 4, 8, 8);
      const value = missing ? Number.NaN : series.valueAt(track, idx);
      ctx.fillStyle = "#c8ccd2";
      ctx.fillText(Number.isFinite(value) ? value.toFixed(0) : "--", w - PAD.right + 16, y);
    });
    ctx.restore();
  }
}

function channel(en: string, limb: string): number {
  const joint = JOINTS.find((j) => j.en === en && j.limb === limb);
  if (!joint) throw new Error(`no joint ${limb}.${en} in the definition table`);
  return joint.channel;
}

function reader(en: string, limb: string, threshold: number): AngleSeries["valueAt"] {
  const ch = channel(en, limb);
  return (track, index) => {
    const conf = track.valueAt(index, ANGLE_CONF_OFFSET + ch);
    // A low-confidence angle is a guess about where the joint was; do not plot it.
    if (!(conf >= threshold)) return Number.NaN;
    return track.valueAt(index, ch);
  };
}

/**
 * Chart 1: the range-of-motion joints the server itself reports on
 * (`ROM_JOINT`: elbow on the forelimbs, stifle on the hindlimbs).
 */
export function romSeries(threshold = 0.5): AngleSeries[] {
  return [
    { label: "FL elbow", color: "#ff3c3c", valueAt: reader("elbow", "front_left", threshold) },
    { label: "FR elbow", color: "#2878ff", valueAt: reader("elbow", "front_right", threshold) },
    { label: "RL stifle", color: "#ffa050", valueAt: reader("knee", "rear_left", threshold) },
    { label: "RR stifle", color: "#3c3cc8", valueAt: reader("knee", "rear_right", threshold) },
  ];
}

/**
 * Chart 2: left-right difference for the same joints.
 *
 * The per-clip report's cross metrics compare left against right; this is the
 * per-frame view of the same idea. A healthy gait keeps these near a flat line;
 * a persistent offset is the thing a clinician is looking for.
 */
export function symmetrySeries(threshold = 0.5): AngleSeries[] {
  const pair = (en: string, left: string, right: string): AngleSeries["valueAt"] => {
    const l = reader(en, left, threshold);
    const r = reader(en, right, threshold);
    return (track, index) => Math.abs(l(track, index) - r(track, index));
  };
  return [
    { label: "elbow L-R", color: "#e8c547", valueAt: pair("elbow", "front_left", "front_right") },
    { label: "stifle L-R", color: "#5ad1a0", valueAt: pair("knee", "rear_left", "rear_right") },
  ];
}
