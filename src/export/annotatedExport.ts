/**
 * Annotated exports — burn the paw-label overlay into the heatmap GIF and the
 * peak-footprint PNG.
 *
 * Both reuse the live heatmap pipeline (smooth field → fixed colormap) so colours
 * match the screen, then draw the LF/RF/LH/RH boxes on a canvas and read the
 * pixels back. A single stable palette built from the colormap LUT **plus** the
 * overlay colours (paw colours, black, white, background) keeps GIF text/boxes
 * crisp and flicker-free across frames.
 *
 * Canvas-agnostic: the caller supplies a `makeCtx(w,h)` factory, so this runs
 * with the browser canvas (app) or a headless one (tests/CLI).
 */

import * as gifencNs from "gifenc";

import {
  PAW_COLOR_LIST,
  countLabeled,
  type PawOverlayFrame,
} from "../gait/index.js";
import { buildLut } from "../render/colormap.js";
import { colorizeField } from "../render/colorize.js";
import { buildSmoothField, SmoothFieldScratch } from "../render/interpolation.js";
import { drawPawOverlay, type Ctx2D } from "../render/pawOverlayRenderer.js";
import type { AppConfig, Matrix } from "../core/types.js";
import { compositeOver } from "./gifExport.js";

// gifenc ships CJS + ESM without an `exports` map; resolve both shapes (see gifExport).
const gifenc = (
  (gifencNs as { GIFEncoder?: unknown }).GIFEncoder
    ? gifencNs
    : (gifencNs as { default?: typeof gifencNs }).default
) as typeof gifencNs;
const { GIFEncoder, applyPalette } = gifenc;

/** A canvas-2d surface plus pixel I/O — superset of `Ctx2D` used for readback. */
export interface ExportCtx extends Ctx2D {
  createImageData(w: number, h: number): { data: Uint8ClampedArray };
  putImageData(img: { data: Uint8ClampedArray }, x: number, y: number): void;
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
}

export type MakeCtx = (w: number, h: number) => ExportCtx;

type RGB = [number, number, number];

function blurOptions(config: AppConfig, scratch: SmoothFieldScratch) {
  return {
    sigmaMin: config.render.gaussian_sigma_min,
    sigmaMax: config.render.gaussian_sigma_max,
    normLo: config.pressure_thresholds.visible_min_mmhg,
    normHi: config.colorbar_range[1],
    nearest: config.render.interpolation === "nearest",
    scratch,
  };
}

/**
 * Stable 256-colour palette: background + black + white + the 5 paw colours, then
 * the colormap gradient sampled across the remaining slots. Overlay colours are
 * exact entries, so labels/boxes never get quantised to a heatmap colour.
 */
export function buildAnnotatedPalette(lut: Uint8ClampedArray, bg: RGB): number[][] {
  const seen = new Set<string>();
  const palette: number[][] = [];
  const push = (r: number, g: number, b: number): void => {
    const key = `${r},${g},${b}`;
    if (seen.has(key)) return;
    seen.add(key);
    palette.push([r, g, b]);
  };
  push(bg[0], bg[1], bg[2]);
  push(0, 0, 0);
  push(255, 255, 255);
  for (const c of PAW_COLOR_LIST) push(c[0], c[1], c[2]);

  const remaining = 256 - palette.length;
  for (let i = 0; i < remaining; i++) {
    const idx = remaining > 1 ? Math.round((i * 255) / (remaining - 1)) : 0;
    push(lut[idx * 4]!, lut[idx * 4 + 1]!, lut[idx * 4 + 2]!);
  }
  return palette;
}

export interface AnnotatedGifInput {
  displayFields: readonly Matrix[];
  overlayFrames: readonly PawOverlayFrame[];
  rows: number;
  cols: number;
  width: number;
  height: number;
  /** Per-frame delay (ms) at full rate; multiplied by the stride internally. */
  delayMs: number;
  config: AppConfig;
  unit: string;
  /** Seconds per frame (for the header). */
  timestampsSec?: readonly number[];
  maxFrames?: number;
  makeCtx: MakeCtx;
  background?: RGB;
  /** Walk direction for the header arrow. */
  direction?: "left_to_right" | "right_to_left" | "unknown";
}

/** Encode an annotated, looping heatmap GIF (paw boxes + labels + header). */
export function encodeAnnotatedGif(input: AnnotatedGifInput): Uint8Array {
  const { displayFields, overlayFrames, rows, cols, width, height, config } = input;
  const N = displayFields.length;
  if (N === 0) throw new Error("encodeAnnotatedGif: no frames");

  const bg: RGB = input.background ?? [5, 7, 10];
  const visibleMin = config.pressure_thresholds.visible_min_mmhg;
  const range = config.colorbar_range;
  const lut = buildLut(visibleMin, range);
  const palette = buildAnnotatedPalette(lut, bg);

  const scratch = new SmoothFieldScratch(rows, cols, width, height);
  const opts = blurOptions(config, scratch);
  const opaque = new Uint8ClampedArray(width * height * 4);

  const ctx = input.makeCtx(width, height);
  const gif = GIFEncoder();
  const stride = Math.max(1, Math.ceil(N / (input.maxFrames ?? N)));
  const delay = Math.max(1, Math.round(input.delayMs * stride));

  for (let i = 0; i < N; i += stride) {
    const field = displayFields[i]!;
    const smooth = buildSmoothField(field, rows, cols, width, height, opts);
    const rgba = colorizeField(smooth, lut, visibleMin, range);
    compositeOver(rgba, bg, opaque);

    const img = ctx.createImageData(width, height);
    img.data.set(opaque);
    ctx.putImageData(img, 0, 0);

    const overlay = overlayFrames[i] ?? { frameIndex: i, items: [] };
    const tSec = input.timestampsSec?.[i] ?? 0;
    const arrow =
      input.direction === "left_to_right" ? " →" : input.direction === "right_to_left" ? " ←" : "";
    const header = `t=${tSec.toFixed(2)}s  f${i + 1}/${N}  paws:${countLabeled(overlay)}${arrow}`;
    drawPawOverlay(ctx, overlay, {
      canvasW: width,
      canvasH: height,
      gridRows: rows,
      gridCols: cols,
      field,
      unit: input.unit,
      header,
    });

    const out = ctx.getImageData(0, 0, width, height).data;
    const index = applyPalette(out, palette, "rgb565");
    gif.writeFrame(index, width, height, { palette, delay, repeat: 0 });
  }

  gif.finish();
  return gif.bytes();
}

export interface AnnotatedHeatmapInput {
  peakField: Matrix;
  summaryFrame: PawOverlayFrame;
  rows: number;
  cols: number;
  width: number;
  height: number;
  config: AppConfig;
  unit: string;
  makeCtx: MakeCtx;
  background?: RGB;
  header?: string;
}

/** Render the peak-footprint heatmap with per-paw labels → opaque RGBA. */
export function renderAnnotatedHeatmap(input: AnnotatedHeatmapInput): {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
} {
  const { peakField, summaryFrame, rows, cols, width, height, config } = input;
  const bg: RGB = input.background ?? [5, 7, 10];
  const visibleMin = config.pressure_thresholds.visible_min_mmhg;
  const range = config.colorbar_range;
  const lut = buildLut(visibleMin, range);

  const scratch = new SmoothFieldScratch(rows, cols, width, height);
  const smooth = buildSmoothField(peakField, rows, cols, width, height, blurOptions(config, scratch));
  const rgba = colorizeField(smooth, lut, visibleMin, range);
  const opaque = new Uint8ClampedArray(width * height * 4);
  compositeOver(rgba, bg, opaque);

  const ctx = input.makeCtx(width, height);
  const img = ctx.createImageData(width, height);
  img.data.set(opaque);
  ctx.putImageData(img, 0, 0);

  drawPawOverlay(ctx, summaryFrame, {
    canvasW: width,
    canvasH: height,
    gridRows: rows,
    gridCols: cols,
    field: peakField,
    unit: input.unit,
    header: input.header,
    showCross: true,
  });

  const out = ctx.getImageData(0, 0, width, height).data;
  return { rgba: out, width, height };
}
