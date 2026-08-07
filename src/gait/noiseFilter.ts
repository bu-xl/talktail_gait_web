import type { PawGaitConfig, PreprocessMeta, PressureFrame } from "./types.js";

/** baseline 유효성·노이즈 floor 진단용 — frame 최소값 대비 이만큼 높으면 '실부하 셀'로 본다 */
const BASELINE_LOAD_DELTA = 50;

/**
 * Step 1 (legacy) — threshold-only filter into reusable buffer.
 * 하위 호환을 위해 유지. baseline/hot-pixel 보정이 필요하면 Preprocessor 사용.
 */
export function filterNoise(
  frame: PressureFrame,
  rows: number,
  cols: number,
  threshold: number,
  out: Float32Array,
): void {
  for (let r = 0; r < rows; r++) {
    const row = frame[r];
    if (!row) continue;
    for (let c = 0; c < cols; c++) {
      const v = row[c] ?? 0;
      out[r * cols + c] = v < threshold ? 0 : v;
    }
  }
}

export function frameToFlat(
  frame: PressureFrame,
  rows: number,
  cols: number,
  out: Float32Array,
): void {
  filterNoise(frame, rows, cols, 0, out);
}

/**
 * Phase 1 — Signal Preprocessing
 *
 * 단순 max/threshold 분석을 하지 않는다. 프레임 시퀀스 전반에 걸쳐
 * 상태를 유지하며 다음을 수행한다.
 *
 *  1. baseline 추정      — per-pixel running-min(+leak) 으로 무부하 오프셋 추정
 *  2. baseline subtraction — 추정 오프셋 차감 (음수는 0)
 *  3. threshold filtering — noiseThreshold 미만 제거
 *  4. hot pixel detection — (a) 장기 고착(stuck) 셀, (b) 고립 단일 핫셀
 *  5. hot pixel masking   — 위 두 종류를 0으로 마스킹
 *
 * 출력은 재사용 Float32Array(out, 길이 rows*cols)에 in-place 로 쓴다.
 */
export class Preprocessor {
  private readonly rows: number;
  private readonly cols: number;
  private readonly n: number;
  private readonly threshold: number;
  private readonly leak: number;
  private readonly warmupFrames: number;
  private readonly hotRatio: number;
  private readonly minNeighbors: number;

  /** per-pixel baseline 추정값 */
  private readonly baseline: Float32Array;
  /** baseline 가 초기화되었는지 */
  private readonly baselineInit: Uint8Array;
  /** 각 픽셀이 threshold 초과로 켜진 프레임 수 (hot pixel 검출용) */
  private readonly activeCount: Uint32Array;
  /** 영구 마스킹된(stuck/hot) 픽셀 */
  private readonly hotMask: Uint8Array;
  /** baseline 차감 후 임시 버퍼 (이웃 검사용) */
  private readonly work: Float32Array;
  private framesSeen = 0;

  /* ── 품질 진단 누적 (warmup 구간 기준) ── */
  /** warmup 프레임들의 raw 픽셀 합 (noise floor before 계산용) */
  private warmupRawSum = 0;
  /** warmup 프레임들의 baseline 차감 후 픽셀 합 (noise floor after 계산용) */
  private warmupWorkSum = 0;
  /** 누적된 warmup 프레임 수 */
  private warmupCounted = 0;
  /** warmup 동안 프레임별 '실부하 셀 수'의 최소값 (시작부터 지속 부하 검출용) */
  private minActiveCellsWarmup = Number.POSITIVE_INFINITY;

  constructor(cfg: PawGaitConfig) {
    this.rows = cfg.rows;
    this.cols = cfg.cols;
    this.n = cfg.rows * cfg.cols;
    this.threshold = cfg.noiseThreshold;
    this.leak = Math.max(0, cfg.baselineLeak);
    this.warmupFrames = Math.max(0, Math.floor(cfg.baselineWarmupFrames));
    this.hotRatio = Math.min(1, Math.max(0, cfg.hotPixelActiveRatio));
    this.minNeighbors = Math.max(0, Math.floor(cfg.hotPixelMinNeighbors));
    this.baseline = new Float32Array(this.n);
    this.baselineInit = new Uint8Array(this.n);
    this.activeCount = new Uint32Array(this.n);
    this.hotMask = new Uint8Array(this.n);
    this.work = new Float32Array(this.n);
  }

  reset(): void {
    this.baseline.fill(0);
    this.baselineInit.fill(0);
    this.activeCount.fill(0);
    this.hotMask.fill(0);
    this.work.fill(0);
    this.framesSeen = 0;
    this.warmupRawSum = 0;
    this.warmupWorkSum = 0;
    this.warmupCounted = 0;
    this.minActiveCellsWarmup = Number.POSITIVE_INFINITY;
  }

  /** 영구 마스킹된 hot pixel 인덱스 목록 (진단용) */
  hotPixels(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.n; i++) {
      if (this.hotMask[i]) out.push(i);
    }
    return out;
  }

  /**
   * 전처리 품질 메타 — 리포트 상단 배지·JSON export 가 소비.
   *  · baselineInvalid: warmup 내내 grid 의 ~1% 이상 셀이 부하 → 무부하 baseline 수집 실패
   *  · hotPixelCount/hotPixels: 영구 마스킹된 stuck/flicker 셀
   *  · noiseFloorBefore/After: warmup 평균 픽셀값(차감 전/후), drop% 는 baseline 효과
   */
  getMeta(): PreprocessMeta {
    const hot = this.hotPixels();
    const cells = this.warmupCounted * this.n;
    const before = cells > 0 ? this.warmupRawSum / cells : 0;
    const after = cells > 0 ? this.warmupWorkSum / cells : 0;
    const dropPct = before > 1e-9 ? Math.max(0, ((before - after) / before) * 100) : 0;
    const minCells = Math.max(40, Math.round(this.n * 0.01));
    const baselineInvalid =
      this.warmupCounted > 0 &&
      Number.isFinite(this.minActiveCellsWarmup) &&
      this.minActiveCellsWarmup >= minCells;
    return {
      baselineInvalid,
      hotPixelCount: hot.length,
      hotPixels: hot,
      noiseFloorBefore: +before.toFixed(3),
      noiseFloorAfter: +after.toFixed(3),
      noiseFloorDropPct: +dropPct.toFixed(1),
    };
  }

  process(frame: PressureFrame, out: Float32Array): void {
    const { rows, cols, n, threshold, leak } = this;
    const baseline = this.baseline;
    const init = this.baselineInit;
    const work = this.work;

    const warmupNow = this.framesSeen < this.warmupFrames;
    let rawSum = 0;
    let rawMin = Number.POSITIVE_INFINITY;
    let workSum = 0;

    // 1+2. baseline 추정 & subtraction → work
    for (let r = 0; r < rows; r++) {
      const row = frame[r];
      const base = r * cols;
      for (let c = 0; c < cols; c++) {
        const idx = base + c;
        const v = row ? row[c] ?? 0 : 0;
        if (!init[idx]) {
          baseline[idx] = v;
          init[idx] = 1;
        } else {
          const b = baseline[idx]!;
          // running minimum + leak: 하부 포락선(무부하 오프셋) 추적, 느린 drift 허용
          baseline[idx] = v < b ? v : b + leak;
        }
        const sub = v - baseline[idx]!;
        work[idx] = sub > 0 ? sub : 0;
        if (warmupNow) {
          rawSum += v;
          if (v < rawMin) rawMin = v;
          workSum += work[idx]!;
        }
      }
    }

    this.framesSeen++;

    // 품질 진단(warmup 구간): noise floor(before/after)와 '실부하 셀 수' 최소값 누적.
    // raw(차감 전) 기준으로 활성 셀을 세야 running-min 에 흡수되는 '지속 정적 부하'를
    // 검출할 수 있다(work 기준은 흡수되어 0이 되므로 부적합).
    if (warmupNow) {
      const floor = rawMin === Number.POSITIVE_INFINITY ? 0 : rawMin;
      let activeCells = 0;
      for (let r = 0; r < rows; r++) {
        const row = frame[r];
        for (let c = 0; c < cols; c++) {
          const v = row ? row[c] ?? 0 : 0;
          if (v - floor > BASELINE_LOAD_DELTA) activeCells++;
        }
      }
      this.warmupRawSum += rawSum;
      this.warmupWorkSum += workSum;
      this.warmupCounted++;
      if (activeCells < this.minActiveCellsWarmup) this.minActiveCellsWarmup = activeCells;
    }

    // 3+4+5. threshold + hot-pixel detection/masking → out
    const warm = this.framesSeen > this.warmupFrames;
    for (let r = 0; r < rows; r++) {
      const base = r * cols;
      for (let c = 0; c < cols; c++) {
        const idx = base + c;

        // 영구 마스킹된 stuck/hot 픽셀
        if (this.hotMask[idx]) {
          out[idx] = 0;
          continue;
        }

        const v = work[idx] ?? 0;
        if (v < threshold) {
          out[idx] = 0;
          continue;
        }

        // 고립 단일 핫셀 검출 — 활성 이웃(8-근방)이 minNeighbors 미만이면 제거
        if (this.activeNeighborCount(r, c, threshold) < this.minNeighbors) {
          out[idx] = 0;
          continue;
        }

        out[idx] = v;
        const active = (this.activeCount[idx] ?? 0) + 1;
        this.activeCount[idx] = active;

        // 장기 고착(stuck) 픽셀 영구 마스킹 — warmup 이후, 거의 매 프레임 켜짐
        if (warm && active >= this.hotRatio * this.framesSeen) {
          this.hotMask[idx] = 1;
          out[idx] = 0;
        }
      }
    }
  }

  /** work 버퍼 기준 threshold 초과 8-이웃 개수 */
  private activeNeighborCount(r: number, c: number, threshold: number): number {
    const { rows, cols, work } = this;
    let count = 0;
    for (let dr = -1; dr <= 1; dr++) {
      const nr = r + dr;
      if (nr < 0 || nr >= rows) continue;
      const base = nr * cols;
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nc = c + dc;
        if (nc < 0 || nc >= cols) continue;
        if (work[base + nc]! >= threshold) count++;
      }
    }
    return count;
  }
}
