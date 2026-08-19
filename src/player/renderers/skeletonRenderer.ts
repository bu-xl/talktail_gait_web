/**
 * Skeleton overlay drawn on a transparent canvas above the video.
 *
 * Pose is looked up with `nearest`, never interpolated: each pose sample was
 * produced from one video frame, so blending two of them puts joints where the
 * detector never reported them. A frame with no detection draws nothing rather
 * than reusing the previous pose.
 *
 * Chains and groups follow the server's drawing definition
 * (`ai-server/pawpose/overlay/draw.py`: `LIMBS`, `SPINE`). There is no separate
 * head group there, so this offers front / rear / spine and nothing invented.
 */

import type { Renderer } from "../masterClock.js";
import { PAW_TIP_SLOT } from "../skeletonSchema.js";
import type { SampleTrack } from "../track.js";
import { CanvasSurface } from "./canvasSurface.js";

export type KeypointGroup = "front" | "rear" | "spine";

interface ChainDef {
  group: KeypointGroup;
  slots: readonly number[];
  color: string;
  tip: number | null;
}

/** Colours match `overlay/draw.py` (converted from its BGR tuples). */
const CHAINS: readonly ChainDef[] = [
  { group: "front", slots: [3, 4, 5, 6, 7], color: "#ff3c3c", tip: PAW_TIP_SLOT.front_left },
  { group: "front", slots: [8, 9, 10, 11, 12], color: "#2878ff", tip: PAW_TIP_SLOT.front_right },
  { group: "rear", slots: [14, 15, 16, 17], color: "#ffa050", tip: PAW_TIP_SLOT.rear_left },
  { group: "rear", slots: [18, 19, 20, 21], color: "#3c3cc8", tip: PAW_TIP_SLOT.rear_right },
  { group: "spine", slots: [0, 1, 2, 13], color: "#9fb0c4", tip: null },
];

/** How the video element is presented, so the overlay lands on the same pixels. */
export interface DisplayTransform {
  rotateDeg?: 0 | 90 | 180 | 270;
  flipX?: boolean;
  flipY?: boolean;
  zoom?: number;
}

export interface SkeletonOptions {
  track: SampleTrack;
  /** Values per sample: `slots * 3`. */
  slots: number;
  /** Resolution the keypoint pixels are expressed in. */
  sourceWidth: number;
  sourceHeight: number;
  transform?: DisplayTransform;
  /** Keypoints below this confidence are drawn faint. */
  confidenceThreshold?: number;
  /** Frames of fading trail behind each paw tip. 0 disables. */
  trailFrames?: number;
}

export class SkeletonRenderer implements Renderer {
  readonly name = "skeleton";
  lastDrawnNs?: bigint;

  private readonly surface: CanvasSurface;
  private readonly visible = new Set<KeypointGroup>(["front", "rear", "spine"]);
  private threshold: number;
  private trailFrames: number;
  private transform: DisplayTransform;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly opts: SkeletonOptions,
  ) {
    this.surface = new CanvasSurface(canvas);
    this.threshold = opts.confidenceThreshold ?? 0.5;
    this.trailFrames = opts.trailFrames ?? 0;
    this.transform = opts.transform ?? {};
  }

  setConfidenceThreshold(value: number): void {
    this.threshold = Math.min(1, Math.max(0, value));
  }

  get confidenceThreshold(): number {
    return this.threshold;
  }

  setGroupVisible(group: KeypointGroup, visible: boolean): void {
    if (visible) this.visible.add(group);
    else this.visible.delete(group);
  }

  isGroupVisible(group: KeypointGroup): boolean {
    return this.visible.has(group);
  }

  setTrailFrames(frames: number): void {
    this.trailFrames = Math.max(0, Math.round(frames));
  }

  setTransform(transform: DisplayTransform): void {
    this.transform = transform;
  }

  draw(tMasterNs: bigint): void {
    this.surface.resize();
    const ctx = this.surface.begin();
    this.lastDrawnNs = tMasterNs;

    // No detection on this frame: draw nothing. A stale pose is worse than none.
    if (this.opts.track.gapAt(tMasterNs)) return;
    const sample = this.opts.track.at(tMasterNs, "nearest");
    if (!sample) return;

    const fit = this.applyTransform(ctx);
    if (fit <= 0) return;
    const px = 1 / fit;

    if (this.trailFrames > 0) this.drawTrails(ctx, tMasterNs, px);

    for (const chain of CHAINS) {
      if (!this.visible.has(chain.group)) continue;
      this.drawChain(ctx, sample, chain, px);
    }
    ctx.restore();
  }

  /**
   * Map source pixels onto the panel, matching however the video is presented.
   * Returns the combined scale so callers can keep stroke widths constant on
   * screen. Leaves the context saved; the caller restores.
   */
  private applyTransform(ctx: CanvasRenderingContext2D): number {
    const { sourceWidth: sw, sourceHeight: sh } = this.opts;
    if (sw <= 0 || sh <= 0) return 0;

    const { cssWidth, cssHeight } = this.surface;
    const rotate = this.transform.rotateDeg ?? 0;
    const zoom = this.transform.zoom ?? 1;
    const swapped = rotate === 90 || rotate === 270;
    const boxW = swapped ? sh : sw;
    const boxH = swapped ? sw : sh;
    const fit = Math.min(cssWidth / boxW, cssHeight / boxH);

    ctx.save();
    ctx.translate(cssWidth / 2, cssHeight / 2);
    ctx.scale(zoom, zoom);
    if (rotate) ctx.rotate((rotate * Math.PI) / 180);
    ctx.scale(this.transform.flipX ? -1 : 1, this.transform.flipY ? -1 : 1);
    ctx.scale(fit, fit);
    ctx.translate(-sw / 2, -sh / 2);
    return fit * zoom;
  }

  private drawChain(
    ctx: CanvasRenderingContext2D,
    sample: Float32Array,
    chain: ChainDef,
    px: number,
  ): void {
    const slots = this.opts.slots;

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 0; i < chain.slots.length - 1; i++) {
      const a = chain.slots[i];
      const b = chain.slots[i + 1];
      if (a >= slots || b >= slots) continue;
      const ax = sample[a * 3];
      const ay = sample[a * 3 + 1];
      const bx = sample[b * 3];
      const by = sample[b * 3 + 1];
      if (!Number.isFinite(ax) || !Number.isFinite(bx)) continue;

      // A segment is only as trustworthy as its weaker end.
      const conf = Math.min(sample[a * 3 + 2], sample[b * 3 + 2]);
      ctx.globalAlpha = conf >= this.threshold ? 0.95 : 0.28;
      ctx.strokeStyle = chain.color;
      ctx.lineWidth = 3 * px;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }

    for (const slot of chain.slots) {
      if (slot >= slots) continue;
      const x = sample[slot * 3];
      const y = sample[slot * 3 + 1];
      if (!Number.isFinite(x)) continue;
      const conf = sample[slot * 3 + 2];
      ctx.globalAlpha = conf >= this.threshold ? 1 : 0.3;
      ctx.fillStyle = chain.color;
      ctx.beginPath();
      ctx.arc(x, y, (slot === chain.tip ? 5 : 3) * px, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Faded path of each paw tip over the preceding frames.
   *
   * This is the payoff of rendering from data instead of burning an overlay into
   * an mp4: the trail, the confidence threshold and the group toggles all come
   * for free from the same samples.
   */
  private drawTrails(ctx: CanvasRenderingContext2D, tMasterNs: bigint, px: number): void {
    const track = this.opts.track;
    const slots = this.opts.slots;
    const spanNs = BigInt(Math.round(track.periodStats().p50 * this.trailFrames * 2));
    const range = track.windowRange(tMasterNs - spanNs / 2n, spanNs);
    if (!range) return;

    for (const chain of CHAINS) {
      if (chain.tip === null || !this.visible.has(chain.group)) continue;
      if (chain.tip >= slots) continue;

      ctx.strokeStyle = chain.color;
      ctx.lineWidth = 2 * px;
      ctx.beginPath();
      let started = false;
      for (let i = range.start; i <= range.end; i++) {
        if (Number(track.timeAt(i)) > Number(tMasterNs)) break;
        const x = track.valueAt(i, chain.tip * 3);
        const y = track.valueAt(i, chain.tip * 3 + 1);
        if (!Number.isFinite(x)) {
          started = false;
          continue;
        }
        if (started) ctx.lineTo(x, y);
        else {
          ctx.moveTo(x, y);
          started = true;
        }
      }
      ctx.globalAlpha = 0.35;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
}
