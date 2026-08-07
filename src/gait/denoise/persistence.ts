import { DN_MAX_GAP_FRAMES, DN_PERSIST_CELL_RADIUS, DN_PERSIST_FRAMES } from "./constants.js";

interface WeakSlot {
  row: number;
  col: number;
  frames: number;
  lastFrame: number;
  peak: number;
}

/**
 * Stage D — temporal persistence for sub-min_cells (especially 1-cell) weak candidates.
 * Speckle: 1 frame → rejected. Small dog 1-cell real contact: persists → approved.
 */
export class WeakCandidateTracker {
  private readonly slots: WeakSlot[] = [];

  reset(): void {
    this.slots.length = 0;
  }

  /** Returns true when weak blob at (row,col) is approved for this frame. */
  observe(row: number, col: number, frameIdx: number, peak: number): boolean {
    const qr = Math.round(row);
    const qc = Math.round(col);
    let best: WeakSlot | null = null;
    let bestD = Infinity;

    for (const s of this.slots) {
      const d = Math.hypot(s.row - qr, s.col - qc);
      if (d <= DN_PERSIST_CELL_RADIUS && d < bestD) {
        bestD = d;
        best = s;
      }
    }

    if (best) {
      const gap = frameIdx - best.lastFrame;
      if (gap <= DN_MAX_GAP_FRAMES + 1) {
        best.frames++;
        best.lastFrame = frameIdx;
        best.peak = Math.max(best.peak, peak);
        best.row = qr;
        best.col = qc;
        return best.frames >= DN_PERSIST_FRAMES;
      }
    }

    this.slots.push({ row: qr, col: qc, frames: 1, lastFrame: frameIdx, peak });
    return false;
  }

  pruneBefore(frameIdx: number, maxAge: number): void {
    for (let i = this.slots.length - 1; i >= 0; i--) {
      if (frameIdx - this.slots[i]!.lastFrame > maxAge) this.slots.splice(i, 1);
    }
  }
}
