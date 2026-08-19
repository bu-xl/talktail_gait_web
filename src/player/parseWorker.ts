/**
 * Artifact parsing off the main thread.
 *
 * A 60 s session is roughly 2500 mat frames x 1600 cells: parsing that inline
 * blocks paint long enough to stall video playback. The worker fetches and
 * parses, then transfers the buffers so nothing is copied back.
 */

/// <reference lib="webworker" />

import { parseKeypointsJson, parsePressureCsv } from "./parse.js";
import type { KeypointDoc } from "./parse.js";

export type ParseRequest =
  | { id: number; kind: "pressure"; url: string }
  | { id: number; kind: "pose"; url: string };

export interface PressurePayload {
  kind: "pressure";
  timestampsNs: BigInt64Array;
  raw: Float32Array;
  baseline: Float32Array;
  totals: Float32Array;
  loadMax: number;
  rows: number;
  cols: number;
  frames: number;
}

export interface PosePayload {
  kind: "pose";
  timestampsNs: BigInt64Array;
  keypoints: Float32Array;
  angles: Float32Array;
  slots: number;
  frames: number;
  periodNs: number;
  width: number;
  height: number;
  totalFrames: number;
  detectedFrames: number;
  limbChains: Record<string, number[]> | null;
}

export type ParseResponse =
  | { id: number; ok: true; payload: PressurePayload | PosePayload }
  | { id: number; ok: false; error: string };

async function fetchOrExplain(url: string, what: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (cause) {
    throw new Error(
      `${what} could not be downloaded from ${url}. Check that the analysis server is reachable. (${String(cause)})`,
    );
  }
  if (!res.ok) {
    throw new Error(`${what} returned HTTP ${res.status} from ${url}.`);
  }
  return res;
}

export async function runRequest(req: ParseRequest): Promise<PressurePayload | PosePayload> {
  if (req.kind === "pressure") {
    const res = await fetchOrExplain(req.url, "The mat pressure CSV");
    const parsed = parsePressureCsv(await res.text());
    return { kind: "pressure", ...parsed };
  }
  const res = await fetchOrExplain(req.url, "The pose keypoints JSON");
  const parsed = parseKeypointsJson((await res.json()) as KeypointDoc);
  return { kind: "pose", ...parsed };
}

/** Buffers to hand over rather than copy. */
export function transferablesOf(payload: PressurePayload | PosePayload): Transferable[] {
  return payload.kind === "pressure"
    ? [payload.timestampsNs.buffer, payload.raw.buffer, payload.baseline.buffer, payload.totals.buffer]
    : [payload.timestampsNs.buffer, payload.keypoints.buffer, payload.angles.buffer];
}

// Guarded so this module can also be imported directly on the main thread as a
// fallback when Worker construction is unavailable.
if (typeof self !== "undefined" && typeof (self as unknown as Worker).postMessage === "function") {
  self.addEventListener("message", (event: MessageEvent<ParseRequest>) => {
    const req = event.data;
    void runRequest(req)
      .then((payload) => {
        const message: ParseResponse = { id: req.id, ok: true, payload };
        (self as unknown as Worker).postMessage(message, transferablesOf(payload));
      })
      .catch((cause: unknown) => {
        const message: ParseResponse = {
          id: req.id,
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause),
        };
        (self as unknown as Worker).postMessage(message);
      });
  });
}
