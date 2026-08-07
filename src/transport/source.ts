/** Common interface for anything that produces raw 40x40 matrices. */

import type { Matrix } from "../core/types.js";

export type FrameHandler = (raw: Matrix) => void;
export type StatusHandler = (connected: boolean, detail?: string) => void;

export interface FrameSource {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  onFrame(handler: FrameHandler): void;
  onStatus(handler: StatusHandler): void;
}
