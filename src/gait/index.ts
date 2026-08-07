export { PawGaitEngine, PAW_LABELS, flatToGrid } from "./PawGaitEngine.js";
export {
  DEFAULT_CONFIG,
  WEIGHT_REF_KG,
  SMALL_DOG_MAX_KG,
  configForWeightKg,
  pressureSumThresholdForWeightKg,
  frameToMs,
  frameToSec,
  msToFrames,
} from "./config.js";
export { Preprocessor, filterNoise, frameToFlat } from "./noiseFilter.js";
export { segmentPaws } from "./segmentation.js";
export type { SegmentationOptions } from "./segmentation.js";
export {
  MORPHOLOGY_KERNEL_SIZES,
  morphCloseBinaryMask,
  dilateBinaryMask,
  erodeBinaryMask,
  pressureToBinaryMask,
  applyMorphologyClose,
  normalizeMorphologyKernelSize,
  isMorphologyKernelSize,
} from "./morphology.js";
export type { MorphologyKernelSize, MorphologyCloseOptions } from "./morphology.js";
export {
  estimateBodyAxes,
  estimateProgressionAxes,
  resolveSessionWalkAxes,
  toWalkingDirection,
  normalize,
  dot,
  projectOnAxis,
  FIXED_MAT_WALK_DIRECTION,
  FIXED_MAT_WALK_PERPENDICULAR,
  coherenceAlongFixedWalkAxis,
  getFixedMatWalkAxes,
} from "./bodyDirection.js";
export { buildStepRecords, stepsByLabel, frameDtSec } from "./stepRecords.js";
export { detectValidTrial } from "./validTrial.js";
export { labelTracksFromFootfallSequence, labelSessionFootfalls, trackLabelAtFrame } from "./footfallLabeling.js";
export type { FootfallEvent, FootfallLabelingResult } from "./footfall/types.js";
export { extractTrialFeatures, summarizeTrials, metricStat } from "./trialFeatures.js";
export { buildScreening } from "./screening.js";
export { legacyToViewerResult, buildLegacyGaitResult } from "./legacyGaitReport.js";
export {
  PAW_COLORS,
  PAW_COLOR_LIST,
  DEFAULT_OVERLAY_QUALITY,
  buildSessionOverlayFrames,
  overlayFrameFromResult,
  buildPawSummaryOverlay,
  countLabeled,
  fieldStatsInBBox,
} from "./overlayModel.js";
export type {
  PawOverlayItem,
  PawOverlayFrame,
  SessionOverlayOptions,
  OverlayQuality,
} from "./overlayModel.js";
export { computeClinicalMetrics } from "./clinicalMetrics.js";
export type {
  ClinicalMetrics,
  ClinicalInput,
  CopStability,
  SymmetrySet,
  GaitFlag,
  FlagSeverity,
} from "./clinicalMetrics.js";
export type { BodyAxes, CoPSample } from "./bodyDirection.js";
export type {
  BBox,
  ClassifiedPaw,
  ContactEvent,
  DirectionResult,
  FrameResult,
  GaitMotionFeatures,
  GaitScreening,
  LegacyGaitFoot,
  LegacyGaitResult,
  MetricStat,
  MultiTrialSummary,
  PawBlob,
  PawGaitConfig,
  PawLabel,
  PawLabelOrUnknown,
  PawPressureFeatures,
  PawTemporalFeatures,
  PawTrialFeatures,
  PawTrialSummary,
  PawTrack,
  Point,
  PressureFrame,
  SessionContactEvent,
  SessionResult,
  StepRecord,
  SymmetryReport,
  TrialValidity,
  ValidTrialResult,
  Vector2,
  WalkingDirection,
} from "./types.js";
