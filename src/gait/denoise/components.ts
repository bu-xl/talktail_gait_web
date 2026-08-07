const NEIGH8: readonly [number, number][] = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

export interface LabeledComponent {
  readonly indices: number[];
  readonly size: number;
  readonly centroidRow: number;
  readonly centroidCol: number;
  readonly peak: number;
}

/** 8-connected components on a binary candidate mask (Stage C). */
export function findComponents(
  mask: Uint8Array,
  pressure: Float32Array,
  rows: number,
  cols: number,
): LabeledComponent[] {
  const n = rows * cols;
  const labels = new Int32Array(n);
  labels.fill(-1);
  const stack: number[] = [];
  const out: LabeledComponent[] = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (!mask[idx] || labels[idx]! >= 0) continue;

      labels[idx] = out.length;
      stack.length = 0;
      stack.push(idx);
      const indices: number[] = [];
      let rowSum = 0;
      let colSum = 0;
      let peak = 0;

      while (stack.length > 0) {
        const cur = stack.pop()!;
        indices.push(cur);
        const cr = (cur / cols) | 0;
        const cc = cur % cols;
        rowSum += cr;
        colSum += cc;
        const v = pressure[cur]!;
        if (v > peak) peak = v;

        for (const [dr, dc] of NEIGH8) {
          const nr = cr + dr;
          const nc = cc + dc;
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
          const ni = nr * cols + nc;
          if (!mask[ni] || labels[ni]! >= 0) continue;
          labels[ni] = out.length;
          stack.push(ni);
        }
      }

      const size = indices.length;
      out.push({
        indices,
        size,
        centroidRow: rowSum / size,
        centroidCol: colSum / size,
        peak,
      });
    }
  }
  return out;
}
