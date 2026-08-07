import type { PawGaitConfig, PawLabel, PawLabelOrUnknown, PawTrack, Vector2 } from "./types.js";
import { dot, projectOnAxis } from "./bodyDirection.js";

interface TrackProjection {
  track: PawTrack;
  forward: number;
  lateral: number;
  pressure: number;
}

function centroidOfTracks(tracks: readonly PawTrack[]): { col: number; row: number } {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const t of tracks) {
    const b = t.lastBlob;
    if (!b) continue;
    sx += b.centerX;
    sy += b.centerY;
    n++;
  }
  if (n === 0) return { col: 0, row: 0 };
  return { col: sx / n, row: sy / n };
}

/** Steps 7–8 — front/hind then left/right using body axes (never plate up/down) */
export function classifyTracks(
  tracks: readonly PawTrack[],
  bodyDirection: Vector2,
  bodyPerpendicular: Vector2,
  cfg: PawGaitConfig,
): Map<number, PawLabelOrUnknown> {
  const active = tracks.filter((t) => t.active && t.lastBlob);
  if (active.length < 2) {
    return new Map();
  }

  const origin = centroidOfTracks(active);
  const projections: TrackProjection[] = active.map((track) => {
    const b = track.lastBlob!;
    return {
      track,
      forward: projectOnAxis(b.centerX, b.centerY, origin.col, origin.row, bodyDirection),
      lateral: projectOnAxis(b.centerX, b.centerY, origin.col, origin.row, bodyPerpendicular),
      pressure: b.pressureSum,
    };
  });

  const sortedFwd = [...projections].sort((a, b) => b.forward - a.forward);
  const half = Math.max(1, Math.ceil(sortedFwd.length / 2));
  let frontCandidates = sortedFwd.slice(0, half);
  let hindCandidates = sortedFwd.slice(half);

  const frontPressure = frontCandidates.reduce((s, p) => s + p.pressure, 0);
  const hindPressure = hindCandidates.reduce((s, p) => s + p.pressure, 0);
  const totalP = frontPressure + hindPressure;

  if (totalP > 0) {
    const frontRatio = frontPressure / totalP;
    if (frontRatio < cfg.frontLoadRatioMin && hindPressure > frontPressure * 1.15) {
      const byPressure = [...projections].sort((a, b) => b.pressure - a.pressure);
      frontCandidates = byPressure.slice(0, half);
      hindCandidates = byPressure.slice(half);
    }
  }

  const result = new Map<number, PawLabelOrUnknown>();

  const assignPair = (pair: TrackProjection[], isFront: boolean): void => {
    if (pair.length === 0) return;
    if (pair.length === 1) {
      const p = pair[0]!;
      const side: PawLabel =
        p.lateral >= 0
          ? isFront
            ? "LF"
            : "LH"
          : isFront
            ? "RF"
            : "RH";
      result.set(p.track.trackId, side);
      return;
    }
    const byLat = [...pair].sort((a, b) => b.lateral - a.lateral);
    const left = byLat[0]!;
    const right = byLat[byLat.length - 1]!;
    result.set(left.track.trackId, isFront ? "LF" : "LH");
    result.set(right.track.trackId, isFront ? "RF" : "RH");
    for (let i = 1; i < byLat.length - 1; i++) {
      const mid = byLat[i]!;
      result.set(mid.track.trackId, mid.lateral >= 0 ? (isFront ? "LF" : "LH") : isFront ? "RF" : "RH");
    }
  };

  assignPair(frontCandidates, true);
  assignPair(hindCandidates, false);

  return result;
}

export function directionConsistencyScore(
  track: PawTrack,
  bodyDirection: Vector2,
): number {
  const d = track.centroidHistory;
  if (d.length < 3) return 0;
  const first = d[0]!;
  const last = d[d.length - 1]!;
  const vx = last.col - first.col;
  const vy = last.row - first.row;
  const len = Math.hypot(vx, vy);
  if (len < 0.5) return 0.3;
  const cos = dot({ x: vx / len, y: vy / len }, bodyDirection);
  return Math.max(0, Math.min(1, (cos + 1) / 2));
}

export function pressureDistributionScore(
  tracks: readonly PawTrack[],
  cfg: PawGaitConfig,
): number {
  let front = 0;
  let total = 0;
  for (const t of tracks) {
    if (!t.lastBlob) continue;
    total += t.lastBlob.pressureSum;
    if (t.label === "LF" || t.label === "RF") front += t.lastBlob.pressureSum;
  }
  if (total <= 0) return 0;
  const ratio = front / total;
  if (ratio >= cfg.frontLoadRatioMin && ratio <= cfg.frontLoadRatioMax) return 1;
  const mid = (cfg.frontLoadRatioMin + cfg.frontLoadRatioMax) / 2;
  const span = cfg.frontLoadRatioMax - cfg.frontLoadRatioMin + 0.15;
  return Math.max(0, 1 - Math.abs(ratio - mid) / span);
}

export function gaitPatternScore(tracks: readonly PawTrack[]): number {
  let events = 0;
  let stagger = 0;
  for (const t of tracks) {
    events += t.contactEvents.length;
  }
  if (events < 2) return 0.2;
  const ics = tracks
    .flatMap((t) => t.contactEvents.map((e) => e.startFrame))
    .sort((a, b) => a - b);
  for (let i = 1; i < ics.length; i++) {
    const gap = ics[i]! - ics[i - 1]!;
    if (gap > 0 && gap < 40) stagger++;
  }
  const staggerRatio = ics.length > 1 ? stagger / (ics.length - 1) : 0;
  return Math.min(1, 0.3 + events * 0.08 + staggerRatio * 0.5);
}

export function computeConfidence(
  track: PawTrack,
  bodyDirection: Vector2,
  tracks: readonly PawTrack[],
  cfg: PawGaitConfig,
): number {
  const directionScore = directionConsistencyScore(track, bodyDirection);
  const pressureScore = pressureDistributionScore(tracks, cfg);
  const gaitScore = gaitPatternScore(tracks);
  return directionScore * 0.5 + pressureScore * 0.2 + gaitScore * 0.3;
}

export function applyConfidenceGate(
  labels: Map<number, PawLabelOrUnknown>,
  tracks: readonly PawTrack[],
  bodyDirection: Vector2,
  cfg: PawGaitConfig,
): void {
  for (const track of tracks) {
    const label = labels.get(track.trackId);
    if (label) track.label = label;
  }

  for (const track of tracks) {
    const label = labels.get(track.trackId);
    if (!label) {
      track.label = "Unknown";
      track.labelConfidence = 0;
      continue;
    }
    const conf = computeConfidence(track, bodyDirection, tracks, cfg);
    track.labelConfidence = conf;
    track.label = conf >= cfg.minConfidence ? label : "Unknown";
  }
}
