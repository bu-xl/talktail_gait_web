import type { PawBlob, PawTrack, Point } from "./types.js";

function dist(a: Point, b: Point): number {
  const dx = a.col - b.col;
  const dy = a.row - b.row;
  return Math.hypot(dx, dy);
}

/**
 * Hungarian 최소비용 할당. cost[trackIdx][blobIdx] (Infinity=불가능).
 * 반환: result[trackIdx] = blobIdx (또는 -1). O(n^3), 정사각 패딩.
 */
function solveAssignment(cost: number[][], maxDistance: number): number[] {
  const nT = cost.length;
  const nB = nT > 0 ? cost[0]!.length : 0;
  const n = Math.max(nT, nB);
  if (n === 0) return [];
  const BIG = maxDistance * 1000 + 1e6;
  const a: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j < n; j++) {
      const v = i < nT && j < nB ? cost[i]![j]! : BIG;
      row.push(Number.isFinite(v) ? v : BIG);
    }
    a.push(row);
  }
  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0);
  const way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(Infinity);
    const usedC = new Array(n + 1).fill(false);
    do {
      usedC[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = -1;
      for (let j = 1; j <= n; j++) {
        if (!usedC[j]) {
          const cur = a[i0 - 1]![j - 1]! - u[i0] - v[j];
          if (cur < minv[j]) {
            minv[j] = cur;
            way[j] = j0;
          }
          if (minv[j] < delta) {
            delta = minv[j];
            j1 = j;
          }
        }
      }
      for (let j = 0; j <= n; j++) {
        if (usedC[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const result = new Array(nT).fill(-1);
  for (let j = 1; j <= n; j++) {
    const i = p[j];
    if (i >= 1 && i <= nT && j <= nB) result[i - 1] = j - 1;
  }
  return result;
}

function blobCenter(blob: PawBlob): Point {
  return { row: blob.centerY, col: blob.centerX };
}

function trimHistory<T>(arr: T[], maxLen: number): T[] {
  if (arr.length <= maxLen) return arr;
  return arr.slice(arr.length - maxLen);
}

function pushHistory<T>(prev: readonly T[], value: T, maxLen: number): T[] {
  const next = prev.slice();
  next.push(value);
  return trimHistory(next, maxLen);
}

/** Step 3 — velocity-aware nearest-neighbor association */
export class PawTracker {
  private tracks: PawTrack[] = [];
  private nextTrackId = 1;

  update(
    blobs: readonly PawBlob[],
    frameIndex: number,
    maxDistance: number,
    timeoutFrames: number,
    maxHistory: number,
  ): PawTrack[] {
    const used = new Set<number>();

    // 전역 최적 매칭(Hungarian) — per-track greedy의 순서 의존/오매칭(발 교차 시) 제거.
    const activeTracks = this.tracks.filter((t) => t.active && t.lastBlob);
    const nT = activeTracks.length;
    const nB = blobs.length;
    if (nT > 0 && nB > 0) {
      const INF = Number.POSITIVE_INFINITY;
      const cost: number[][] = [];
      for (let i = 0; i < nT; i++) {
        const track = activeTracks[i]!;
        const lastPt = blobCenter(track.lastBlob!);
        const predict: Point = {
          col: lastPt.col + track.velocityCol,
          row: lastPt.row + track.velocityRow,
        };
        const row: number[] = [];
        for (let j = 0; j < nB; j++) {
          const pt = blobCenter(blobs[j]!);
          const d = Math.min(dist(predict, pt), dist(lastPt, pt));
          row.push(d < maxDistance ? d : INF);
        }
        cost.push(row);
      }
      const assign = solveAssignment(cost, maxDistance);
      for (let i = 0; i < nT; i++) {
        const track = activeTracks[i]!;
        const j = assign[i]!;
        if (j >= 0 && j < nB && cost[i]![j]! < maxDistance) {
          const blob = blobs[j]!;
          used.add(j);
          const pt = blobCenter(blob);
          const prevPt =
            track.centroidHistory.length > 0
              ? track.centroidHistory[track.centroidHistory.length - 1]!
              : pt;
          track.velocityCol = pt.col - prevPt.col;
          track.velocityRow = pt.row - prevPt.row;
          track.history = pushHistory(track.history, blob, maxHistory);
          track.centroidHistory = pushHistory(track.centroidHistory, pt, maxHistory);
          track.pressureHistory = pushHistory(track.pressureHistory, blob.pressureSum, maxHistory);
          track.frameIndices = pushHistory(track.frameIndices, frameIndex, maxHistory);
          track.lastBlob = blob;
          track.missFrames = 0;
          track.lastFrameIndex = frameIndex;
        } else {
          track.missFrames++;
          if (track.missFrames > timeoutFrames) track.active = false;
        }
      }
    } else {
      for (const track of activeTracks) {
        track.missFrames++;
        if (track.missFrames > timeoutFrames) track.active = false;
      }
    }

    for (let i = 0; i < blobs.length; i++) {
      if (used.has(i)) continue;
      const blob = blobs[i]!;
      const pt = blobCenter(blob);
      this.tracks.push({
        trackId: this.nextTrackId++,
        history: [blob],
        centroidHistory: [pt],
        pressureHistory: [blob.pressureSum],
        frameIndices: [frameIndex],
        active: true,
        lastBlob: blob,
        missFrames: 0,
        lastFrameIndex: frameIndex,
        contact: false,
        contactEvents: [],
        pendingContactStart: null,
        label: "Unknown",
        labelConfidence: 0,
        lockedLabel: null,
        contactEventLabels: [],
        flagsProvisional: false,
        velocityCol: 0,
        velocityRow: 0,
      });
    }

    return this.tracks.filter((t) => t.active);
  }

  getTracks(): readonly PawTrack[] {
    return this.tracks;
  }

  reset(): void {
    this.tracks = [];
    this.nextTrackId = 1;
  }
}

export function trackDirectionWindow(
  track: PawTrack,
  windowFrames: number,
): { dx: number; dy: number } | null {
  const h = track.centroidHistory;
  if (h.length < 2) return null;
  const startIdx = Math.max(0, h.length - windowFrames);
  const first = h[startIdx]!;
  const last = h[h.length - 1]!;
  return { dx: last.col - first.col, dy: last.row - first.row };
}
