/** M1 — morphology kernel sizes (configurable experiments) */
export const MORPHOLOGY_KERNEL_SIZES = [3, 5] as const;

export type MorphologyKernelSize = (typeof MORPHOLOGY_KERNEL_SIZES)[number];

export function isMorphologyKernelSize(value: number): value is MorphologyKernelSize {
  return value === 3 || value === 5;
}

export function normalizeMorphologyKernelSize(value: number): MorphologyKernelSize {
  return isMorphologyKernelSize(value) ? value : 3;
}

/**
 * Binary mask dilation (square structuring element).
 * Out-of-bounds neighbors are treated as 0.
 */
export function dilateBinaryMask(
  mask: Uint8Array,
  rows: number,
  cols: number,
  kernelSize: MorphologyKernelSize,
): Uint8Array {
  const n = rows * cols;
  const out = new Uint8Array(n);
  const half = Math.floor(kernelSize / 2);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      let on = 0;
      outer: for (let dr = -half; dr <= half; dr++) {
        for (let dc = -half; dc <= half; dc++) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
          if (mask[nr * cols + nc]! > 0) {
            on = 1;
            break outer;
          }
        }
      }
      out[idx] = on;
    }
  }
  return out;
}

/**
 * Binary mask erosion (square structuring element).
 * Out-of-bounds neighbors are treated as 0.
 */
export function erodeBinaryMask(
  mask: Uint8Array,
  rows: number,
  cols: number,
  kernelSize: MorphologyKernelSize,
): Uint8Array {
  const n = rows * cols;
  const out = new Uint8Array(n);
  const half = Math.floor(kernelSize / 2);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (mask[idx]! === 0) {
        out[idx] = 0;
        continue;
      }
      let allOn = 1;
      outer: for (let dr = -half; dr <= half; dr++) {
        for (let dc = -half; dc <= half; dc++) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols || mask[nr * cols + nc]! === 0) {
            allOn = 0;
            break outer;
          }
        }
      }
      out[idx] = allOn;
    }
  }
  return out;
}

/** MORPH_CLOSE = dilate → erode (bridges small gaps within a paw). */
export function morphCloseBinaryMask(
  mask: Uint8Array,
  rows: number,
  cols: number,
  kernelSize: MorphologyKernelSize,
): Uint8Array {
  const dilated = dilateBinaryMask(mask, rows, cols, kernelSize);
  return erodeBinaryMask(dilated, rows, cols, kernelSize);
}

/** pressure > 0 → binary mask */
export function pressureToBinaryMask(data: Float32Array, threshold = 0): Uint8Array {
  const mask = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    mask[i] = data[i]! > threshold ? 1 : 0;
  }
  return mask;
}

export interface MorphologyCloseOptions {
  readonly enabled: boolean;
  readonly kernelSize: MorphologyKernelSize;
}

/** Apply optional MORPH_CLOSE to a pressure-field binary mask. */
export function applyMorphologyClose(
  data: Float32Array,
  rows: number,
  cols: number,
  options: MorphologyCloseOptions,
  threshold = 0,
): Uint8Array {
  const binary = pressureToBinaryMask(data, threshold);
  if (!options.enabled) return binary;
  return morphCloseBinaryMask(binary, rows, cols, options.kernelSize);
}
