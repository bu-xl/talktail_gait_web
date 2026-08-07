/**
 * Turn processed pressure fields into heatmap RGBA buffers at an arbitrary
 * resolution, using the SAME smoothing + colormap as the live view. Pure (no
 * DOM), so it powers both the GIF encoder and unit tests; the PNG path reuses
 * `colorizeOne` and hands the RGBA to a canvas.
 */

import { buildLut } from "../render/colormap.js";
import { colorizeField } from "../render/colorize.js";
import { buildSmoothField, SmoothFieldScratch } from "../render/interpolation.js";
import type { AppConfig, Matrix } from "../core/types.js";

export interface HeatmapImage {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}

function makeBlurOptions(config: AppConfig, scratch: SmoothFieldScratch) {
  return {
    sigmaMin: config.render.gaussian_sigma_min,
    sigmaMax: config.render.gaussian_sigma_max,
    normLo: config.pressure_thresholds.visible_min_mmhg,
    normHi: config.colorbar_range[1],
    nearest: config.render.interpolation === "nearest",
    scratch,
  };
}

/** Colorize a single pressure matrix to an RGBA heatmap image at width x height. */
export function colorizeOne(
  pressure: Matrix,
  rows: number,
  cols: number,
  width: number,
  height: number,
  config: AppConfig,
): HeatmapImage {
  const lut = buildLut(config.pressure_thresholds.visible_min_mmhg, config.colorbar_range);
  const scratch = new SmoothFieldScratch(rows, cols, width, height);
  const field = buildSmoothField(pressure, rows, cols, width, height, makeBlurOptions(config, scratch));
  const rgba = colorizeField(
    field,
    lut,
    config.pressure_thresholds.visible_min_mmhg,
    config.colorbar_range,
  );
  return { rgba, width, height };
}

/**
 * Colorize many pressure frames (reusing one LUT + scratch for speed). Returns an
 * RGBA buffer per frame — feed straight into the GIF encoder.
 */
export function colorizeFrames(
  pressures: readonly Matrix[],
  rows: number,
  cols: number,
  width: number,
  height: number,
  config: AppConfig,
): Uint8ClampedArray[] {
  const lut = buildLut(config.pressure_thresholds.visible_min_mmhg, config.colorbar_range);
  const scratch = new SmoothFieldScratch(rows, cols, width, height);
  const opts = makeBlurOptions(config, scratch);
  const visibleMin = config.pressure_thresholds.visible_min_mmhg;
  return pressures.map((p) => {
    const field = buildSmoothField(p, rows, cols, width, height, opts);
    // Fresh RGBA per frame (the GIF encoder needs them all).
    return colorizeField(field, lut, visibleMin, config.colorbar_range);
  });
}

export { buildLut };
