import type { DirectionResult, PawTrack, Vector2 } from "./types.js";
import { trackDirectionWindow } from "./tracking.js";

export interface BodyAxes {
  bodyDirection: Vector2 | null;
  bodyPerpendicular: Vector2 | null;
  /** 0..1 — 각 발 진행벡터 단위합의 크기(방향 일관성) */
  coherence: number;
}

/** 프레임별 전역 압력중심(CoP) 표본 — 진행 방향 회귀용 */
export interface CoPSample {
  readonly frame: number;
  readonly col: number;
  readonly row: number;
  readonly weight: number;
}

/**
 * 제품 고정 보행 규약: Sensor X(col) 0 → 오른쪽 = 걸어가는 방향.
 * 판 설치·촬영 각도와 무관하게 진행축은 항상 +col 이다.
 */
export const FIXED_MAT_WALK_DIRECTION: Vector2 = { x: 1, y: 0 };
export const FIXED_MAT_WALK_PERPENDICULAR: Vector2 = { x: 0, y: 1 };

export function getFixedMatWalkAxes(coherence: number): BodyAxes {
  return {
    bodyDirection: FIXED_MAT_WALK_DIRECTION,
    bodyPerpendicular: FIXED_MAT_WALK_PERPENDICULAR,
    coherence,
  };
}

/** CoP col 이 시간(frame)에 따라 +X 방향으로 증가하는지 가중 R² (역보행이면 0) */
export function coherenceAlongFixedWalkAxis(samples: readonly CoPSample[]): number {
  let sw = 0;
  let sf = 0;
  let sc = 0;
  for (const s of samples) {
    if (s.weight <= 0) continue;
    sw += s.weight;
    sf += s.weight * s.frame;
    sc += s.weight * s.col;
  }
  if (sw <= 0) return 0;
  const fBar = sf / sw;
  const cBar = sc / sw;

  let sff = 0;
  let sfc = 0;
  let scc = 0;
  for (const s of samples) {
    if (s.weight <= 0) continue;
    const df = s.frame - fBar;
    const dc = s.col - cBar;
    sff += s.weight * df * df;
    sfc += s.weight * df * dc;
    scc += s.weight * dc * dc;
  }
  if (sff < 1e-9) return 0;
  const slopeCol = sfc / sff;
  if (slopeCol < 0.01) return 0;
  return scc > 1e-9 ? Math.max(0, Math.min(1, (sfc * sfc) / (sff * scc))) : 0;
}

/** 고정 +X 진행축 + CoP·트랙 일관성으로 세션 축 확정 */
export function resolveSessionWalkAxes(prog: BodyAxes, trackAxes?: BodyAxes): BodyAxes {
  let trackBoost = 0;
  if (trackAxes?.bodyDirection && trackAxes.bodyDirection.x > 0.2) {
    trackBoost = trackAxes.coherence * Math.min(1, trackAxes.bodyDirection.x);
  }
  return getFixedMatWalkAxes(Math.max(prog.coherence, trackBoost));
}

export function normalize(v: Vector2): Vector2 | null {
  const len = Math.hypot(v.x, v.y);
  if (len < 1e-6) return null;
  return { x: v.x / len, y: v.y / len };
}

export function dot(a: Vector2, b: Vector2): number {
  return a.x * b.x + a.y * b.y;
}

/** Steps 5–6 — sliding-window average displacement (plate orientation 무관) */
export function estimateBodyAxes(
  tracks: readonly PawTrack[],
  windowFrames = 24,
): BodyAxes {
  let sx = 0;
  let sy = 0;
  let n = 0;

  for (const track of tracks) {
    if (!track.active) continue;
    const d = trackDirectionWindow(track, windowFrames);
    if (!d) continue;
    const len = Math.hypot(d.dx, d.dy);
    if (len < 0.35) continue;
    sx += d.dx / len;
    sy += d.dy / len;
    n++;
  }

  if (n === 0) {
    return { bodyDirection: null, bodyPerpendicular: null, coherence: 0 };
  }

  const mx = sx / n;
  const my = sy / n;
  const coherence = Math.min(1, Math.hypot(mx, my));
  const bodyDirection = normalize({ x: mx, y: my });
  if (!bodyDirection) {
    return { bodyDirection: null, bodyPerpendicular: null, coherence };
  }

  const bodyPerpendicular: Vector2 = {
    x: -bodyDirection.y,
    y: bodyDirection.x,
  };

  return { bodyDirection, bodyPerpendicular, coherence };
}

/**
 * 진행 방향을 footfall/몸 진행(inter-frame) 으로 추정.
 * 실제 보행에서 발은 stance 동안 땅에 고정되므로 트랙 내부 드리프트엔 진행 정보가
 * 거의 없다. 대신 매 프레임 전역 CoP 가 몸을 따라 판을 가로지르는 것을 이용해
 * CoP(col,row) 를 frame 에 가중 선형회귀하고, 적합도(R²)를 신뢰도로 삼는다.
 * 정지/지터 데이터는 R²→0 이 되어 자연히 unknown 으로 게이팅된다.
 */
export function estimateProgressionAxes(samples: readonly CoPSample[]): BodyAxes {
  return getFixedMatWalkAxes(coherenceAlongFixedWalkAxis(samples));
}

/**
 * Phase 4 출력 — 진행 방향을 이산 라벨 + confidence 로 변환.
 * 제품 고정: Sensor X 0→오른쪽 = left_to_right. coherence 가 낮으면 unknown.
 */
export function toWalkingDirection(
  axes: BodyAxes,
  minConfidence: number,
): DirectionResult {
  const vector = FIXED_MAT_WALK_DIRECTION;
  const perpendicular = FIXED_MAT_WALK_PERPENDICULAR;
  if (axes.coherence < minConfidence) {
    return {
      direction: "unknown",
      confidence: axes.coherence,
      vector,
      perpendicular,
    };
  }
  return {
    direction: "left_to_right",
    confidence: axes.coherence,
    vector,
    perpendicular,
  };
}

export function projectOnAxis(
  centerCol: number,
  centerRow: number,
  originCol: number,
  originRow: number,
  axis: Vector2,
): number {
  const dx = centerCol - originCol;
  const dy = centerRow - originRow;
  return dot({ x: dx, y: dy }, axis);
}
