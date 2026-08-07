/** Preload: expose a minimal, safe IPC bridge as window.matApi (contextIsolated). */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type FrameCb = (frame: ArrayBuffer) => void;
type StatusCb = (connected: boolean, detail?: string) => void;

export interface PortListItem {
  path: string;
  label: string;
  recommended: boolean;
  manufacturer?: string;
  friendlyName?: string;
  vendorId?: string;
  productId?: string;
}

let frameCb: FrameCb | null = null;
let statusCb: StatusCb | null = null;

/**
 * Main sends a detached ArrayBuffer (Float64 matrix bytes). Through contextBridge
 * the payload may arrive as ArrayBuffer or Uint8Array — always forward a fresh
 * ArrayBuffer so the renderer can `new Float64Array(buf)` safely.
 */
ipcRenderer.on("frame", (_e: IpcRendererEvent, frame: ArrayBuffer | Uint8Array) => {
  if (!frameCb) return;
  try {
    let buf: ArrayBuffer;
    if (frame instanceof ArrayBuffer) {
      buf = frame.slice(0);
    } else if (ArrayBuffer.isView(frame)) {
      buf = frame.buffer.slice(
        frame.byteOffset,
        frame.byteOffset + frame.byteLength,
      ) as ArrayBuffer;
    } else {
      return;
    }
    frameCb(buf);
  } catch {
    /* drop malformed frame */
  }
});
ipcRenderer.on("status", (_e: IpcRendererEvent, connected: boolean, detail?: string) => {
  statusCb?.(connected, detail);
});

contextBridge.exposeInMainWorld("matApi", {
  listPorts: (): Promise<PortListItem[]> => ipcRenderer.invoke("serial:list"),
  start: (portPath?: string) => ipcRenderer.invoke("serial:start", portPath),
  stop: () => ipcRenderer.invoke("serial:stop"),
  rescan: (): Promise<PortListItem[]> => ipcRenderer.invoke("serial:rescan"),
  onFrame: (cb: FrameCb) => {
    frameCb = cb;
  },
  onStatus: (cb: StatusCb) => {
    statusCb = cb;
  },
});
