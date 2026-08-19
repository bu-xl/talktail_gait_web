/**
 * The unified timeline: every clock in the session on one row.
 *
 * Total mat load, contact spans, missing-data bands, the sync markers, the
 * playhead and the A-B range all share one x axis, so a glance at this strip
 * tells you what the session contains and whether to trust it.
 *
 * The x axis is real time, never sample index. Plotting an irregular 39-45 Hz
 * signal on evenly spaced indices stretches and squeezes the curve, which is
 * exactly the artefact this player exists to avoid.
 *
 * Everything except the playhead and the A-B overlay is static for a given
 * session and size, so it is drawn once onto an offscreen layer.
 */

import type { ContactSpan } from "../contactEvents.js";
import type { Renderer } from "../masterClock.js";
import type { GapSpan, SampleTrack } from "../track.js";
import { CanvasSurface, offscreen } from "./canvasSurface.js";

/** A moment worth marking, e.g. the clapper flash or the calibration press. */
export interface TimelineMarker {
  tNs: bigint;
  label: string;
  color: string;
}

export interface TimelineOptions {
  /** Total mat load, stride 1, on the mat's own irregular grid. */
  totalTrack: SampleTrack | null;
  startNs: bigint;
  endNs: bigint;
  contacts?: readonly ContactSpan[];
  markers?: readonly TimelineMarker[];
  /** Expected mat rate band; outside it the sparkline turns red. */
  rateBandHz?: [number, number];
  labels: { noMatData: string; rate: string };
  onSeek?(tNs: bigint): void;
  onRangeSelect?(aNs: bigint, bNs: bigint): void;
}

const CURVE_H = 46;
const SPARK_H = 16;
const CONTACT_H = 8;
const PAD_X = 6;

export class TimelineRenderer implements Renderer {
  readonly name = "timeline";
  lastDrawnNs?: bigint;

  private readonly surface: CanvasSurface;
  private staticLayer: HTMLCanvasElement | null = null;
  private contacts: readonly ContactSpan[];
  private markers: readonly TimelineMarker[];
  private rangeA: bigint | null = null;
  private rangeB: bigint | null = null;

  private dragStart: bigint | null = null;
  private dragCurrent: bigint | null = null;
  private readonly detachers: Array<() => void> = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly opts: TimelineOptions,
  ) {
    this.surface = new CanvasSurface(canvas);
    this.contacts = opts.contacts ?? [];
    this.markers = opts.markers ?? [];
    this.bindPointer();
  }

  destroy(): void {
    for (const off of this.detachers) off();
    this.detachers.length = 0;
  }

  setContacts(spans: readonly ContactSpan[]): void {
    this.contacts = spans;
    this.staticLayer = null;
  }

  setMarkers(markers: readonly TimelineMarker[]): void {
    this.markers = markers;
    this.staticLayer = null;
  }

  setRange(aNs: bigint | null, bNs: bigint | null): void {
    this.rangeA = aNs;
    this.rangeB = bNs;
  }

  draw(tMasterNs: bigint): void {
    if (this.surface.resize()) this.staticLayer = null;
    const ctx = this.surface.begin();
    const { cssWidth: w, cssHeight: h } = this.surface;
    this.lastDrawnNs = tMasterNs;
    if (w <= PAD_X * 2 || h <= 0) return;

    ctx.drawImage(this.ensureStaticLayer(w, h), 0, 0, w, h);
    this.drawSelection(ctx, w, h);
    this.drawPlayhead(ctx, tMasterNs, w, h);
  }

  /** Master time -> x, in CSS pixels. */
  private xOf(tNs: bigint, width: number): number {
    const span = Number(this.opts.endNs - this.opts.startNs);
    if (span <= 0) return PAD_X;
    const frac = Number(tNs - this.opts.startNs) / span;
    return PAD_X + Math.min(1, Math.max(0, frac)) * (width - PAD_X * 2);
  }

  /** x -> master time, for clicks and drags. */
  private timeAtX(x: number, width: number): bigint {
    const usable = width - PAD_X * 2;
    if (usable <= 0) return this.opts.startNs;
    const frac = Math.min(1, Math.max(0, (x - PAD_X) / usable));
    const span = Number(this.opts.endNs - this.opts.startNs);
    return this.opts.startNs + BigInt(Math.round(frac * span));
  }

  private ensureStaticLayer(w: number, h: number): HTMLCanvasElement {
    if (this.staticLayer) return this.staticLayer;
    const dpr = this.surface.devicePixelRatio;
    const layer = offscreen(Math.round(w * dpr), Math.round(h * dpr));
    const ctx = layer.getContext("2d");
    if (!ctx) throw new Error("timeline: offscreen 2D context unavailable");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = "#111317";
    ctx.fillRect(0, 0, w, h);

    const track = this.opts.totalTrack;
    if (!track || track.count < 2) {
      ctx.fillStyle = "#7c828b";
      ctx.font = "500 11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(this.opts.labels.noMatData, w / 2, h / 2);
      this.staticLayer = layer;
      return layer;
    }

    this.drawGapBands(ctx, track.gaps(), w, h);
    this.drawLoadCurve(ctx, track, w);
    this.drawContacts(ctx, w);
    this.drawRateSparkline(ctx, track, w);
    this.drawMarkers(ctx, w, h);

    this.staticLayer = layer;
    return layer;
  }

  /**
   * Grey bands where the mat reported nothing.
   *
   * Drawn under everything else and labelled by colour alone on purpose: any
   * metric computed across one of these spans is not trustworthy, and the band
   * is the warning.
   */
  private drawGapBands(
    ctx: CanvasRenderingContext2D,
    gaps: readonly GapSpan[],
    w: number,
    h: number,
  ): void {
    ctx.fillStyle = "rgba(140, 146, 156, 0.30)";
    for (const gap of gaps) {
      const x0 = this.xOf(gap.startNs, w);
      const x1 = this.xOf(gap.endNs, w);
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
    }
  }

  /**
   * Total load, decimated to one min/max pair per pixel column.
   *
   * A ten-minute session holds ~25k samples over ~1200 px. Drawing every point
   * costs more than a frame and hides the peaks under overdraw; a per-column
   * min/max envelope keeps every spike visible at a fraction of the cost.
   */
  private drawLoadCurve(ctx: CanvasRenderingContext2D, track: SampleTrack, w: number): void {
    const plotW = Math.max(1, Math.round(w - PAD_X * 2));
    const top = 2;
    const { max } = track.valueRange();
    const scale = max > 0 ? (CURVE_H - 4) / max : 0;

    const mins = new Float32Array(plotW).fill(Number.POSITIVE_INFINITY);
    const maxs = new Float32Array(plotW).fill(Number.NEGATIVE_INFINITY);

    for (let i = 0; i < track.count; i++) {
      const col = Math.min(plotW - 1, Math.max(0, Math.round(this.xOf(track.timeAt(i), w) - PAD_X)));
      const v = track.valueAt(i, 0);
      if (!Number.isFinite(v)) continue;
      if (v < mins[col]) mins[col] = v;
      if (v > maxs[col]) maxs[col] = v;
    }

    ctx.strokeStyle = "#5ad1a0";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let col = 0; col < plotW; col++) {
      if (maxs[col] === Number.NEGATIVE_INFINITY) continue;
      const x = PAD_X + col + 0.5;
      ctx.moveTo(x, top + CURVE_H - 2 - mins[col] * scale);
      ctx.lineTo(x, top + CURVE_H - 2 - maxs[col] * scale);
    }
    ctx.stroke();
  }

  /** Stance spans, so gait cycles are visible without playing the session. */
  private drawContacts(ctx: CanvasRenderingContext2D, w: number): void {
    const y = CURVE_H + 4;
    ctx.fillStyle = "#f0663f";
    for (const span of this.contacts) {
      const x0 = this.xOf(span.startNs, w);
      const x1 = this.xOf(span.endNs, w);
      ctx.globalAlpha = span.openEnded ? 0.45 : 0.85;
      ctx.fillRect(x0, y, Math.max(1, x1 - x0), CONTACT_H);
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Instantaneous mat rate, with the expected band shaded.
   *
   * This is how a reader decides how far to trust a stretch of mat data: inside
   * the band the sampling held, outside it the recording was struggling.
   */
  private drawRateSparkline(ctx: CanvasRenderingContext2D, track: SampleTrack, w: number): void {
    const [loHz, hiHz] = this.opts.rateBandHz ?? [39, 45];
    const top = CURVE_H + 4 + CONTACT_H + 3;
    // Show a little beyond the band so an excursion is visibly outside it.
    const axisLo = loHz - 8;
    const axisHi = hiHz + 8;
    const toY = (hz: number): number =>
      top + SPARK_H - ((Math.min(axisHi, Math.max(axisLo, hz)) - axisLo) / (axisHi - axisLo)) * SPARK_H;

    ctx.fillStyle = "rgba(90, 209, 160, 0.16)";
    ctx.fillRect(PAD_X, toY(hiHz), w - PAD_X * 2, toY(loHz) - toY(hiHz));

    const rates = track.rateHz();
    ctx.lineWidth = 1;
    for (let i = 1; i < track.count; i++) {
      const hz = rates[i];
      if (!Number.isFinite(hz) || hz <= 0) continue;
      const x = this.xOf(track.timeAt(i), w);
      ctx.strokeStyle = hz < loHz || hz > hiHz ? "#ff5c48" : "#7f8792";
      ctx.beginPath();
      ctx.moveTo(x, top + SPARK_H);
      ctx.lineTo(x, toY(hz));
      ctx.stroke();
    }

    ctx.fillStyle = "#6d747d";
    ctx.font = "500 9px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(`${this.opts.labels.rate} ${loHz}-${hiHz}Hz`, PAD_X + 2, top + 1);
  }

  /**
   * Sync markers.
   *
   * When the clapper flash and the mat's calibration press land on the same
   * tick, the two clocks agree; that visual coincidence is the point of drawing
   * them on one axis.
   */
  private drawMarkers(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    for (const marker of this.markers) {
      const x = Math.round(this.xOf(marker.tNs, w)) + 0.5;
      ctx.strokeStyle = marker.color;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  private drawSelection(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const a = this.dragStart ?? this.rangeA;
    const b = this.dragCurrent ?? this.rangeB;
    if (a === null || b === null) return;
    const x0 = this.xOf(a < b ? a : b, w);
    const x1 = this.xOf(a < b ? b : a, w);
    ctx.fillStyle = "rgba(240, 102, 63, 0.18)";
    ctx.fillRect(x0, 0, x1 - x0, h);
    ctx.strokeStyle = "rgba(240, 102, 63, 0.75)";
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x0) + 0.5, 0.5, Math.round(x1 - x0), h - 1);
  }

  private drawPlayhead(
    ctx: CanvasRenderingContext2D,
    tMasterNs: bigint,
    w: number,
    h: number,
  ): void {
    const x = Math.round(this.xOf(tMasterNs, w)) + 0.5;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  /** Click to jump, drag to mark a range. */
  private bindPointer(): void {
    const canvas = this.canvas;
    let dragging = false;

    const localX = (event: PointerEvent): number => {
      const rect = canvas.getBoundingClientRect();
      return event.clientX - rect.left;
    };

    const onDown = (event: PointerEvent): void => {
      dragging = true;
      this.dragStart = this.timeAtX(localX(event), this.surface.cssWidth);
      this.dragCurrent = this.dragStart;
      canvas.setPointerCapture?.(event.pointerId);
    };
    const onMove = (event: PointerEvent): void => {
      if (!dragging) return;
      this.dragCurrent = this.timeAtX(localX(event), this.surface.cssWidth);
    };
    const onUp = (event: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      const start = this.dragStart;
      const end = this.timeAtX(localX(event), this.surface.cssWidth);
      this.dragStart = null;
      this.dragCurrent = null;
      canvas.releasePointerCapture?.(event.pointerId);
      if (start === null) return;

      // A drag shorter than a few pixels is a click, not a range selection.
      const pixels = Math.abs(
        this.xOf(end, this.surface.cssWidth) - this.xOf(start, this.surface.cssWidth),
      );
      if (pixels < 4) this.opts.onSeek?.(end);
      else this.opts.onRangeSelect?.(start < end ? start : end, start < end ? end : start);
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    this.detachers.push(
      () => canvas.removeEventListener("pointerdown", onDown),
      () => canvas.removeEventListener("pointermove", onMove),
      () => canvas.removeEventListener("pointerup", onUp),
      () => canvas.removeEventListener("pointercancel", onUp),
    );
  }
}

/** Height the timeline needs, so the layout can reserve it. */
export const TIMELINE_HEIGHT = CURVE_H + 4 + CONTACT_H + 3 + SPARK_H + 4;
