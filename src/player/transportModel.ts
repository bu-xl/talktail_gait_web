/**
 * Transport logic with no DOM.
 *
 * The A-B loop, seek clamping, frame stepping, key mapping and the clock
 * readout are the parts that can be wrong in ways a user notices, so they live
 * here where they can be tested directly. `PlaybackController` is the thin shell
 * that wires them to buttons.
 */

export type TransportAction =
  | { kind: "toggle-play" }
  | { kind: "step-frames"; frames: number }
  | { kind: "step-seconds"; seconds: number }
  | { kind: "mark-a" }
  | { kind: "mark-b" }
  | { kind: "toggle-loop" }
  | { kind: "seek-fraction"; fraction: number };

export interface KeyEventLike {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

/**
 * Map a keystroke to a transport action, or null to let it through.
 *
 * Modified keystrokes are never claimed: Cmd+R must still reload, and Ctrl+A
 * must still select.
 */
export function keyToAction(event: KeyEventLike): TransportAction | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;

  switch (event.key) {
    case " ":
      return { kind: "toggle-play" };
    case "ArrowLeft":
      return event.shiftKey ? { kind: "step-seconds", seconds: -1 } : { kind: "step-frames", frames: -1 };
    case "ArrowRight":
      return event.shiftKey ? { kind: "step-seconds", seconds: 1 } : { kind: "step-frames", frames: 1 };
    case "[":
      return { kind: "mark-a" };
    case "]":
      return { kind: "mark-b" };
    case "l":
    case "L":
      return { kind: "toggle-loop" };
    default:
      break;
  }
  if (event.key >= "0" && event.key <= "9") {
    return { kind: "seek-fraction", fraction: Number(event.key) / 10 };
  }
  return null;
}

/** True for elements where a keystroke belongs to the user, not the transport. */
export function isTextEntryTag(tagName: string | undefined, contentEditable = false): boolean {
  if (contentEditable) return true;
  return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
}

export function clampToSession(tMasterNs: bigint, t0Ns: bigint, durationNs: number): bigint {
  if (tMasterNs < t0Ns) return t0Ns;
  if (durationNs > 0) {
    const end = t0Ns + BigInt(Math.round(durationNs));
    if (tMasterNs > end) return end;
  }
  return tMasterNs;
}

export function fractionOf(tMasterNs: bigint, t0Ns: bigint, durationNs: number): number {
  if (durationNs <= 0) return 0;
  return Math.min(1, Math.max(0, Number(tMasterNs - t0Ns) / durationNs));
}

export function masterAtFraction(fraction: number, t0Ns: bigint, durationNs: number): bigint {
  const clamped = Math.min(1, Math.max(0, fraction));
  return t0Ns + BigInt(Math.round(clamped * durationNs));
}

/**
 * `mm:ss.mmm` relative to the session start.
 *
 * Developer mode appends the raw master timestamp, which is what you compare
 * against a track's `t_frame_ns` when a panel looks out of step.
 */
export function formatMasterTime(
  tMasterNs: bigint,
  t0Ns: bigint,
  developerMode = false,
): string {
  const ms = Number(tMasterNs - t0Ns) / 1e6;
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const minutes = Math.floor(safe / 60000);
  const seconds = Math.floor((safe % 60000) / 1000);
  const millis = Math.floor(safe % 1000);
  const base = `${minutes}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
  return developerMode ? `${base}  ${tMasterNs.toString()} ns` : base;
}

/**
 * The A-B repeat range.
 *
 * Vets spend most of their time replaying one gait cycle, so this is the control
 * that gets the most use. Marking either end out of order clears the other
 * rather than silently producing a backwards range that never loops.
 */
export class RepeatRange {
  private a: bigint | null = null;
  private b: bigint | null = null;
  private loop = false;

  get aNs(): bigint | null {
    return this.a;
  }

  get bNs(): bigint | null {
    return this.b;
  }

  get enabled(): boolean {
    return this.loop;
  }

  get isComplete(): boolean {
    return this.a !== null && this.b !== null;
  }

  markA(tNs: bigint): void {
    this.a = tNs;
    if (this.b !== null && this.b <= tNs) this.b = null;
    if (!this.isComplete) this.loop = false;
  }

  markB(tNs: bigint): void {
    this.b = tNs;
    if (this.a !== null && this.a >= tNs) this.a = null;
    if (!this.isComplete) this.loop = false;
  }

  clear(): void {
    this.a = null;
    this.b = null;
    this.loop = false;
  }

  /** No-op unless both ends are set; a loop over half a range is a bug, not a feature. */
  toggleLoop(): void {
    if (!this.isComplete) return;
    this.loop = !this.loop;
  }

  /**
   * Where playback must jump to, or null to continue.
   *
   * Only wraps while playing: a paused user scrubbing outside the range should
   * not be yanked back to A.
   */
  wrapTarget(tMasterNs: bigint, playing: boolean): bigint | null {
    if (!this.loop || !playing || this.a === null || this.b === null) return null;
    if (tMasterNs >= this.b || tMasterNs < this.a) return this.a;
    return null;
  }
}
