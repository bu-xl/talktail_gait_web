import {
  FF_DEFAULT_BODY_LEN_CM,
  FF_DEFAULT_PAW_DIAM_CM,
  FF_DEFAULT_STANCE_WIDTH_CM,
  FF_FH_RESOLUTION_PITCH_CM,
  FF_K_R_LINK,
  FF_K_TOE_GROUP,
  FF_MIN_PEAK_FORCE,
  FF_NARROW_STANCE_CELLS,
} from "./constants.js";
import { COL_PITCH_CM, ROW_PITCH_CM, bboxAreaCm2, distCm, robustMedian, CELL_AREA_CM2 } from "./geometry.js";
import type { FrameBlob, ScaleEstimate } from "./types.js";

function bboxDiameterCm(blobs: readonly FrameBlob[]): number {
  const areas = blobs.map((b) => b.areaCm2).filter((a) => a > 0);
  if (areas.length === 0) return FF_DEFAULT_PAW_DIAM_CM;
  const medArea = robustMedian(areas);
  return Math.max(COL_PITCH_CM, Math.sqrt(medArea));
}

/** Bootstrap scale from blob geometry (no labels). */
export function estimateScale(blobs: readonly FrameBlob[]): ScaleEstimate {
  const pawDiamCm = Math.max(COL_PITCH_CM, bboxDiameterCm(blobs));

  const lateralByFrame = new Map<number, number[]>();
  for (const b of blobs) {
    const arr = lateralByFrame.get(b.frameIdx) ?? [];
    arr.push(b.cyCm);
    lateralByFrame.set(b.frameIdx, arr);
  }
  const pairDists: number[] = [];
  for (const ys of lateralByFrame.values()) {
    if (ys.length < 2) continue;
    ys.sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) {
      pairDists.push(Math.abs(ys[i]! - ys[i - 1]!));
    }
  }
  const stanceWidthCm =
    pairDists.length > 0
      ? Math.max(ROW_PITCH_CM, robustMedian(pairDists))
      : FF_DEFAULT_STANCE_WIDTH_CM;

  const xs = blobs.map((b) => b.cxCm);
  const bodyLenCm =
    xs.length >= 2
      ? Math.max(FF_FH_RESOLUTION_PITCH_CM, Math.max(...xs) - Math.min(...xs))
      : FF_DEFAULT_BODY_LEN_CM;

  const sepRatio = bodyLenCm / FF_FH_RESOLUTION_PITCH_CM;
  const narrowStance = stanceWidthCm < FF_NARROW_STANCE_CELLS * ROW_PITCH_CM;
  const belowFhResolution = bodyLenCm < FF_FH_RESOLUTION_PITCH_CM * 2;

  return {
    pawDiamCm,
    stanceWidthCm,
    bodyLenCm,
    rLinkCm: FF_K_R_LINK * pawDiamCm,
    toeGroupRadiusCm: FF_K_TOE_GROUP * pawDiamCm,
    minContactAreaCm2: Math.max(CELL_AREA_CM2, pawDiamCm * pawDiamCm * 0.35),
    minPeakForce: FF_MIN_PEAK_FORCE,
    sepRatio,
    narrowStance,
    belowFhResolution,
  };
}

/** Merge sub-blobs within toe_group_radius on the same frame (§8.2). */
export function mergeToeFragments(blobs: FrameBlob[], radiusCm: number): FrameBlob[] {
  if (blobs.length <= 1) return blobs;
  const used = new Uint8Array(blobs.length);
  const out: FrameBlob[] = [];

  for (let i = 0; i < blobs.length; i++) {
    if (used[i]) continue;
    const group = [blobs[i]!];
    used[i] = 1;
    let changed = true;
    while (changed) {
      changed = false;
      for (let j = 0; j < blobs.length; j++) {
        if (used[j]) continue;
        const b = blobs[j]!;
        const near = group.some(
          (g) => distCm(g.cxCm, g.cyCm, b.cxCm, b.cyCm) <= radiusCm,
        );
        if (near) {
          group.push(b);
          used[j] = 1;
          changed = true;
        }
      }
    }
    if (group.length === 1) {
      out.push(group[0]!);
      continue;
    }
    let wx = 0;
    let wy = 0;
    let wSum = 0;
    let peak = 0;
    let force = 0;
    let area = 0;
    let minR = Infinity;
    let maxR = -Infinity;
    let minC = Infinity;
    let maxC = -Infinity;
    const ids: number[] = [];
    for (const g of group) {
      const w = g.totalForce;
      wx += g.cxCm * w;
      wy += g.cyCm * w;
      wSum += w;
      peak = Math.max(peak, g.peakForce);
      force += g.totalForce;
      area += g.areaCm2;
      minR = Math.min(minR, g.bbox.minRow);
      maxR = Math.max(maxR, g.bbox.maxRow);
      minC = Math.min(minC, g.bbox.minCol);
      maxC = Math.max(maxC, g.bbox.maxCol);
      ids.push(g.blobId);
    }
    const base = group[0]!;
    out.push({
      frameIdx: base.frameIdx,
      timeSec: base.timeSec,
      cxCm: wSum > 0 ? wx / wSum : base.cxCm,
      cyCm: wSum > 0 ? wy / wSum : base.cyCm,
      peakForce: peak,
      totalForce: force,
      areaCm2: area,
      bbox: { minRow: minR, maxRow: maxR, minCol: minC, maxCol: maxC },
      edgeClip: group.some((g) => g.edgeClip),
      blobId: base.blobId,
    });
  }
  return out;
}
