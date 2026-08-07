/**
 * Electron transport (renderer side). The SerialPort lives in the main process;
 * parsed 40x40 matrices arrive over IPC via the preload-exposed `window.matApi`.
 * Parsing still uses the SHARED SerialFrameParser (in the main process), so the
 * protocol logic is never duplicated.
 */

import { SENSOR_COUNT } from "../core/constants.js";
import type { FrameHandler, FrameSource, StatusHandler } from "./source.js";
import type { Matrix } from "../core/types.js";

export interface PortListItem {
  path: string;
  label: string;
  recommended: boolean;
  manufacturer?: string;
  friendlyName?: string;
  vendorId?: string;
  productId?: string;
}

export interface PortListResult {
  ports: PortListItem[];
  rawCount: number;
  error?: string;
}

interface MatApi {
  listPorts(): Promise<PortListResult | PortListItem[]>;
  start(portPath?: string): Promise<boolean>;
  stop(): Promise<void>;
  rescan(): Promise<PortListResult | PortListItem[]>;
  onFrame(cb: (frame: ArrayBuffer | Uint8Array) => void): void;
  onStatus(cb: (connected: boolean, detail?: string) => void): void;
}

declare global {
  interface Window {
    matApi?: MatApi;
  }
}

/** Rebuild Float64 matrix from IPC payload (ArrayBuffer or Uint8Array clone). */
function matrixFromIpc(frame: ArrayBuffer | Uint8Array): Matrix | null {
  let bytes: ArrayBuffer;
  if (frame instanceof ArrayBuffer) {
    bytes = frame;
  } else if (ArrayBuffer.isView(frame)) {
    bytes = frame.buffer.slice(
      frame.byteOffset,
      frame.byteOffset + frame.byteLength,
    ) as ArrayBuffer;
  } else {
    return null;
  }
  if (bytes.byteLength !== SENSOR_COUNT * Float64Array.BYTES_PER_ELEMENT) return null;
  return new Float64Array(bytes);
}

export class IpcSource implements FrameSource {
  private frameHandler: FrameHandler = () => {};
  private statusHandler: StatusHandler = () => {};
  private wired = false;
  private portPath: string | undefined;

  constructor(portPath?: string) {
    this.portPath = portPath;
  }

  static available(): boolean {
    return typeof window !== "undefined" && !!window.matApi;
  }

  onFrame(handler: FrameHandler): void {
    this.frameHandler = handler;
  }
  onStatus(handler: StatusHandler): void {
    this.statusHandler = handler;
  }

  async start(): Promise<void> {
    const api = window.matApi;
    if (!api) throw new Error("Electron matApi not available");
    if (!this.wired) {
      this.wired = true;
      api.onStatus((c, d) => this.statusHandler(c, d));
      api.onFrame((frame) => {
        const m = matrixFromIpc(frame);
        if (!m) return;
        this.frameHandler(m);
      });
    }
    await api.start(this.portPath);
  }

  /** Close the COM port — only call when leaving the app. */
  async stop(): Promise<void> {
    await window.matApi?.stop();
  }
}
