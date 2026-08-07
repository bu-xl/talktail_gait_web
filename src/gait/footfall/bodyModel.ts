import {
  FF_DIRECTION_CONFLICT_SLOPE,
  FF_TRAVERSE_R2_MIN,
  TRAVEL_SIGN_FIXED,
} from "./constants.js";
import { robustMedian } from "./geometry.js";
import type { FootfallEvent, PassQuality, TravelModel } from "./types.js";

/** Theil-Sen robust slope: median of pairwise slopes. */
function theilSenSlope(xs: number[], ys: number[]): number {
  const slopes: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) {
      const dx = xs[j]! - xs[i]!;
      if (Math.abs(dx) < 1e-9) continue;
      slopes.push((ys[j]! - ys[i]!) / dx);
    }
  }
  return slopes.length > 0 ? robustMedian(slopes) : 0;
}

function r2Linear(xs: number[], ys: number[], slope: number, intercept: number): number {
  const yBar = ys.reduce((a, b) => a + b, 0) / Math.max(ys.length, 1);
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < xs.length; i++) {
    const pred = intercept + slope * xs[i]!;
    ssRes += (ys[i]! - pred) ** 2;
    ssTot += (ys[i]! - yBar) ** 2;
  }
  return ssTot > 1e-9 ? Math.max(0, 1 - ssRes / ssTot) : 0;
}

/**
 * Step 3 — body progression from footfall touchdown positions (not per-frame COP).
 *
 * Equipment convention (§1, §9.1):
 *   - ENTRY_EDGE = TOP: dog enters row 0, walks toward larger row (down).
 *   - Longitudinal axis = row cm (y). Lateral = col cm (x).
 *   - Travel sign is FIXED (+1); regression validates only (flag_direction_conflict).
 */
export function fitTravelModel(footfalls: readonly FootfallEvent[]): {
  travel: TravelModel;
  passQuality: PassQuality;
} {
  const lateralCenter =
    footfalls.length > 0 ? robustMedian(footfalls.map((f) => f.posCm.x)) : 0;

  if (footfalls.length === 0) {
    return {
      travel: {
        axisUnit: { x: 0, y: TRAVEL_SIGN_FIXED },
        sign: TRAVEL_SIGN_FIXED,
        vCmPerSec: 0,
        intercept: 0,
        slope: 0,
        progressionR2: 0,
        lateralCenter,
        directionConflict: false,
      },
      passQuality: { isTraverse: false, progressionR2: 0, directionConflict: false },
    };
  }

  const ts = footfalls.map((f) => f.tTouchdown);
  const longs = footfalls.map((f) => f.posCm.y);

  const regSlope = footfalls.length >= 2 ? theilSenSlope(ts, longs) : TRAVEL_SIGN_FIXED * 0.1;
  const intercept = robustMedian(longs.map((y, i) => y - regSlope * ts[i]!));
  const r2 = footfalls.length >= 2 ? r2Linear(ts, longs, regSlope, intercept) : 0;

  const directionConflict = footfalls.length >= 3 && regSlope < FF_DIRECTION_CONFLICT_SLOPE;

  const travel: TravelModel = {
    axisUnit: { x: 0, y: TRAVEL_SIGN_FIXED },
    sign: TRAVEL_SIGN_FIXED,
    vCmPerSec: Math.abs(regSlope),
    intercept,
    slope: regSlope,
    progressionR2: r2,
    lateralCenter,
    directionConflict,
  };

  return {
    travel,
    passQuality: {
      isTraverse: footfalls.length >= 3 && r2 >= FF_TRAVERSE_R2_MIN && regSlope > FF_DIRECTION_CONFLICT_SLOPE,
      progressionR2: r2,
      directionConflict,
    },
  };
}

/**
 * Body-frame at touchdown — moving body reference, not plate-absolute.
 * r_long: cranial (+) = further down the mat (larger row) relative to L_body(t).
 * r_lat:  lateral offset from session center line.
 */
export function bodyFrameCoords(
  footfall: FootfallEvent,
  travel: TravelModel,
): { rLong: number; rLat: number } {
  const lBody = travel.intercept + travel.slope * footfall.tTouchdown;
  return {
    rLong: (footfall.posCm.y - lBody) * travel.sign,
    rLat: footfall.posCm.x - travel.lateralCenter,
  };
}

export function applyBodyFrame(footfalls: FootfallEvent[], travel: TravelModel): void {
  for (const f of footfalls) {
    const { rLong, rLat } = bodyFrameCoords(f, travel);
    f.rLong = rLong;
    f.rLat = rLat;
    if (travel.directionConflict) f.flags.directionConflict = true;
  }
}
