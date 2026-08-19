/**
 * Pose keypoint slots, limb chains and joint-angle geometry.
 *
 * Ported verbatim from the analysis server's single definition source,
 * `ai-server/pawpose/overlay/angles.py` (`LIMBS`, `angle_at`,
 * `segment_ground_angle`). Angles, unlike coordinates, are not reproducible
 * without the definition: which slot is the vertex and which arm is fixed. If
 * the Python table changes, change it here in the same commit or the web charts
 * will quietly disagree with the server's own report.
 *
 * Slot numbers are union-46kp slots 0..21 (the AI-Hub 71878 convention). Slots
 * outside that range have no agreed name in this project and are deliberately
 * left unnamed rather than given a plausible-sounding one.
 */

export type LimbKey = "front_left" | "front_right" | "rear_left" | "rear_right";
export type JointKind = "joint" | "segment_ground";

export interface JointDef {
  /** Vertex slot: the axis the angle is measured at. */
  vertex: number;
  /** Proximal slot: the fixed arm. */
  proximal: number;
  /** Distal slot, or null for a segment-vs-ground inclination. */
  distal: number | null;
  /** Korean display name, the canonical one on the server. */
  ko: string;
  /** English alias used by the JSON output and the overlay. */
  en: string;
  kind: JointKind;
}

export interface LimbDef {
  key: LimbKey;
  ko: string;
  en: string;
  color: string;
  /** Slot chain drawn as the skeleton polyline. */
  chain: readonly number[];
  joints: readonly JointDef[];
}

const JOINT_EN: Record<string, string> = {
  어깨: "shoulder",
  팔꿈치: "elbow",
  앞발목: "carpus",
  앞발: "front_paw",
  고관절: "hip",
  무릎: "knee",
  뒷발목: "tarsus",
  뒷발: "rear_paw",
};

function joint(vertex: number, proximal: number, distal: number | null, ko: string): JointDef {
  return {
    vertex,
    proximal,
    distal,
    ko,
    en: JOINT_EN[ko] ?? ko,
    kind: distal === null ? "segment_ground" : "joint",
  };
}

export const LIMBS: readonly LimbDef[] = [
  {
    key: "front_left",
    ko: "앞-좌 FL",
    en: "FL Front Left",
    color: "#ff3c3c",
    chain: [3, 4, 5, 6, 7],
    joints: [joint(4, 3, 5, "어깨"), joint(5, 4, 6, "팔꿈치"), joint(6, 5, 7, "앞발목"), joint(7, 6, null, "앞발")],
  },
  {
    key: "front_right",
    ko: "앞-우 FR",
    en: "FR Front Right",
    color: "#2f86ff",
    chain: [8, 9, 10, 11, 12],
    joints: [joint(9, 8, 10, "어깨"), joint(10, 9, 11, "팔꿈치"), joint(11, 10, 12, "앞발목"), joint(12, 11, null, "앞발")],
  },
  {
    key: "rear_left",
    ko: "뒤-좌 RL",
    en: "RL Rear Left",
    color: "#ffa64d",
    chain: [13, 14, 15, 16, 17],
    joints: [joint(14, 13, 15, "고관절"), joint(15, 14, 16, "무릎"), joint(16, 15, 17, "뒷발목"), joint(17, 16, null, "뒷발")],
  },
  {
    key: "rear_right",
    ko: "뒤-우 RR",
    en: "RR Rear Right",
    color: "#3c46c8",
    chain: [13, 18, 19, 20, 21],
    joints: [joint(18, 13, 19, "고관절"), joint(19, 18, 20, "무릎"), joint(20, 19, 21, "뒷발목"), joint(21, 20, null, "뒷발")],
  },
];

/** Short anatomical names for the slots that have a canonical one. */
export const SLOT_NAME: Readonly<Record<number, string>> = {
  3: "scap-spine",
  4: "acromion",
  5: "hum-epicond",
  6: "ulnar-styloid",
  7: "5MC-tip",
  8: "scap-spine",
  9: "acromion",
  10: "hum-epicond",
  11: "ulnar-styloid",
  12: "5MC-tip",
  13: "iliac",
  14: "trochanter",
  15: "femorotibial",
  16: "malleolus",
  17: "5MT-tip",
  18: "trochanter",
  19: "femorotibial",
  20: "malleolus",
  21: "5MT-tip",
};

/** Paw code -> limb, matching the `schema.paw_tips` convention in the JSON. */
export const PAW_LIMB: Readonly<Record<string, LimbKey>> = {
  FL: "front_left",
  FR: "front_right",
  RL: "rear_left",
  RR: "rear_right",
};

/** Distal tip slot per limb: the keypoint that touches the ground. */
export const PAW_TIP_SLOT: Readonly<Record<LimbKey, number>> = {
  front_left: 7,
  front_right: 12,
  rear_left: 17,
  rear_right: 21,
};

export interface FlatJoint extends JointDef {
  limb: LimbKey;
  limbColor: string;
  /** Channel index into an angle track sample. */
  channel: number;
}

/**
 * The 16 joints in a fixed order. This order IS the angle track's channel
 * layout, so it must stay stable: reordering it silently relabels every chart.
 */
export const JOINTS: readonly FlatJoint[] = LIMBS.flatMap((limb) =>
  limb.joints.map((j) => ({ ...j, limb: limb.key, limbColor: limb.color, channel: 0 })),
).map((j, channel) => ({ ...j, channel }));

/** Values per angle-track sample: 16 degrees followed by 16 minimum confidences. */
export const ANGLE_CHANNELS = JOINTS.length;
export const ANGLE_STRIDE = ANGLE_CHANNELS * 2;
export const ANGLE_CONF_OFFSET = ANGLE_CHANNELS;

/** Highest slot index any definition refers to. */
export const MAX_SLOT = LIMBS.reduce(
  (max, limb) => Math.max(max, ...limb.chain, ...limb.joints.map((j) => j.vertex)),
  0,
);

/**
 * Angle at `v` between arms `a` and `b`, in degrees over 0..180.
 *
 * Image coordinates have y growing downward, but the angle between two vectors
 * is invariant under that flip, so no correction is needed. Returns NaN when
 * either arm has no length.
 */
export function angleAt(
  vx: number, vy: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const ux = ax - vx;
  const uy = ay - vy;
  const wx = bx - vx;
  const wy = by - vy;
  const nu = Math.hypot(ux, uy);
  const nw = Math.hypot(wx, wy);
  if (nu < 1e-9 || nw < 1e-9) return Number.NaN;
  const cos = (ux * wx + uy * wy) / (nu * nw);
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}

/**
 * Inclination of the segment `prox -> tip` against horizontal, folded to the
 * acute angle 0..90 (90 = vertical, 0 = horizontal). Returns NaN for a
 * zero-length segment.
 */
export function segmentGroundAngle(px: number, py: number, tx: number, ty: number): number {
  const dx = tx - px;
  const dy = ty - py;
  if (Math.hypot(dx, dy) < 1e-9) return Number.NaN;
  return (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI;
}

/**
 * Fill one angle-track sample from a pose frame.
 *
 * `kps` is `[x, y, conf]` per slot, flattened. Missing or degenerate joints
 * become NaN rather than a plausible number, so the chart draws a break instead
 * of a line through data the detector never produced.
 */
export function computeAngleSample(kps: Float32Array, out: Float32Array): Float32Array {
  const slots = kps.length / 3;
  for (const j of JOINTS) {
    let deg = Number.NaN;
    let confMin = Number.NaN;

    const needed = j.distal === null ? [j.vertex, j.proximal] : [j.vertex, j.proximal, j.distal];
    if (needed.every((s) => s < slots)) {
      const vx = kps[j.vertex * 3];
      const vy = kps[j.vertex * 3 + 1];
      const px = kps[j.proximal * 3];
      const py = kps[j.proximal * 3 + 1];
      deg =
        j.distal === null
          ? segmentGroundAngle(px, py, vx, vy)
          : angleAt(vx, vy, px, py, kps[j.distal * 3], kps[j.distal * 3 + 1]);
      confMin = Math.min(...needed.map((s) => kps[s * 3 + 2]));
    }

    out[j.channel] = deg;
    out[ANGLE_CONF_OFFSET + j.channel] = confMin;
  }
  return out;
}
