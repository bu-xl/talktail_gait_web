import type { BBox, PawLabel } from "../types.js";

/** Per-frame blob in physical (cm) coordinates. */
export interface FrameBlob {
  readonly frameIdx: number;
  readonly timeSec: number;
  readonly cxCm: number;
  readonly cyCm: number;
  readonly peakForce: number;
  readonly totalForce: number;
  readonly areaCm2: number;
  readonly bbox: BBox;
  readonly edgeClip: boolean;
  /** Globally unique id within the session extract pass. */
  readonly blobId: number;
}

export interface FootfallFlags {
  edgeClip: boolean;
  merged: boolean;
  correctedByGlobal: boolean;
  nonTraverse: boolean;
  belowFhResolution: boolean;
  narrowStance: boolean;
  /** Measured progression opposes ENTRY_EDGE=TOP assumption. */
  directionConflict: boolean;
  /** Label from cold-start seed; cleared after global confirm. */
  provisional: boolean;
  weak: boolean;
}

/** One stance: touchdown → liftoff at a fixed mat location. Labels are frozen here. */
export interface FootfallEvent {
  readonly id: number;
  limb: PawLabel;
  frameTd: number;
  frameLo: number;
  tTouchdown: number;
  tLiftoff: number;
  /** Pressure-weighted mean position (cm): x = lateral (col), y = longitudinal (row). */
  posCm: { readonly x: number; readonly y: number };
  rLong: number;
  rLat: number;
  peakForce: number;
  meanForce: number;
  pti: number;
  contactAreaCm2: number;
  nFrames: number;
  confidence: number;
  flags: FootfallFlags;
  readonly memberBlobIds: readonly number[];
}

export interface ScaleEstimate {
  pawDiamCm: number;
  stanceWidthCm: number;
  bodyLenCm: number;
  rLinkCm: number;
  toeGroupRadiusCm: number;
  minContactAreaCm2: number;
  minPeakForce: number;
  sepRatio: number;
  narrowStance: boolean;
  belowFhResolution: boolean;
}

export interface TravelModel {
  /** Unit vector along walk axis: {0, +1} = top→bottom (row cm). */
  axisUnit: { x: number; y: number };
  sign: 1 | -1;
  vCmPerSec: number;
  /** L_body(t) = intercept + slope * t  (longitudinal row-cm vs seconds). */
  intercept: number;
  slope: number;
  progressionR2: number;
  lateralCenter: number;
  directionConflict: boolean;
}

export interface PassQuality {
  isTraverse: boolean;
  progressionR2: number;
  directionConflict: boolean;
}

export interface FootfallLabelingResult {
  footfalls: FootfallEvent[];
  /** `${trackId}:${eventIdx}` → frozen limb */
  perContactLabels: Map<string, PawLabel>;
  scale: ScaleEstimate;
  travel: TravelModel;
  passQuality: PassQuality;
}
