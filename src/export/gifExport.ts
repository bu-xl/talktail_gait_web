/**
 * Encode a sequence of heatmap RGBA frames into an animated GIF.
 *
 * Pure / dependency-light (only `gifenc`) so it runs in both the browser and Node
 * (unit tests). Frames arrive as RGBA with alpha; sub-threshold pixels (alpha 0)
 * are composited over a solid background so the animation is clean and opaque.
 * The palette is derived from the fixed colormap LUT, so colours stay stable
 * across frames (no per-frame flicker).
 */

import * as gifencNs from "gifenc";

// gifenc ships a CJS main + an ESM `module` build but no `exports` map. Vite
// picks the ESM build (named exports); Node loads the CJS build, where the named
// exports are exposed under the default. Resolve both shapes to one object.
const gifenc = (
  (gifencNs as { GIFEncoder?: unknown }).GIFEncoder
    ? gifencNs
    : (gifencNs as { default?: typeof gifencNs }).default
) as typeof gifencNs;
const { GIFEncoder, applyPalette, quantize } = gifenc;

export interface GifFramesInput {
  /** RGBA byte buffers, each width*height*4. */
  frames: ReadonlyArray<Uint8ClampedArray | Uint8Array>;
  width: number;
  height: number;
  /** Per-frame delay in milliseconds. */
  delayMs: number;
  /** 256-entry RGBA colormap LUT (for a stable global palette). */
  lut: Uint8ClampedArray;
  /** Opaque background the heatmap is composited over. */
  background?: [number, number, number];
}

/** Build a stable palette spanning the whole colormap plus the background. */
function buildPalette(lut: Uint8ClampedArray, bg: [number, number, number]): number[][] {
  const swatch = new Uint8ClampedArray((256 + 1) * 4);
  for (let i = 0; i < 256; i++) {
    swatch[i * 4] = lut[i * 4];
    swatch[i * 4 + 1] = lut[i * 4 + 1];
    swatch[i * 4 + 2] = lut[i * 4 + 2];
    swatch[i * 4 + 3] = 255;
  }
  swatch[256 * 4] = bg[0];
  swatch[256 * 4 + 1] = bg[1];
  swatch[256 * 4 + 2] = bg[2];
  swatch[256 * 4 + 3] = 255;
  return quantize(swatch, 256);
}

/** Composite an RGBA frame over `bg` into a fresh opaque RGBA buffer. */
export function compositeOver(
  rgba: Uint8ClampedArray | Uint8Array,
  bg: [number, number, number],
  out: Uint8ClampedArray,
): Uint8ClampedArray {
  for (let i = 0; i < out.length; i += 4) {
    const a = rgba[i + 3] / 255;
    out[i] = Math.round(rgba[i] * a + bg[0] * (1 - a));
    out[i + 1] = Math.round(rgba[i + 1] * a + bg[1] * (1 - a));
    out[i + 2] = Math.round(rgba[i + 2] * a + bg[2] * (1 - a));
    out[i + 3] = 255;
  }
  return out;
}

/** Encode frames into GIF89a bytes (animated, looping). */
export function encodeHeatmapGif(input: GifFramesInput): Uint8Array {
  const { frames, width, height, delayMs, lut } = input;
  const bg = input.background ?? [5, 7, 10];
  const palette = buildPalette(lut, bg);
  const gif = GIFEncoder();
  const opaque = new Uint8ClampedArray(width * height * 4);
  const delay = Math.max(1, Math.round(delayMs));

  for (const frame of frames) {
    compositeOver(frame, bg, opaque);
    const index = applyPalette(opaque, palette, "rgb565");
    gif.writeFrame(index, width, height, { palette, delay, repeat: 0 });
  }
  gif.finish();
  return gif.bytes();
}
