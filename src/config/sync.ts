/** Camera ↔ mat sync + AI results API (talktail_gait back). */

import type { SyncConfig } from "../core/types.js";

const trim = (s: string): string => s.replace(/\/$/, "");

let runtime: SyncConfig | null = null;

/** Inject sync settings from loaded config.json (called once at boot). */
export function configureSync(cfg: SyncConfig): void {
  runtime = cfg;
}

function envApiBase(): string | undefined {
  const v = import.meta.env.VITE_API_BASE_URL;
  return v ? trim(String(v)) : undefined;
}

/** HTTP base for `/api/results/*`. Empty in dev → same-origin + Vite proxy. */
export function resolveApiBase(): string {
  const fromEnv = envApiBase();
  if (fromEnv) return fromEnv;
  const fromCfg = runtime?.apiBaseUrl?.trim();
  if (fromCfg) return trim(fromCfg);
  if (import.meta.env.DEV && typeof location !== "undefined") return location.origin;
  return "http://localhost:3000";
}

/** WebSocket hub URL (`/ws` on the back server). */
export function resolveWsUrl(): string {
  const fromEnv = import.meta.env.VITE_WS_URL;
  if (fromEnv) return String(fromEnv);
  const fromCfg = runtime?.wsUrl?.trim();
  if (fromCfg) return fromCfg;
  const api = envApiBase() || runtime?.apiBaseUrl?.trim();
  if (api) return `${trim(api).replace(/^http/, "ws")}/ws`;
  if (typeof location !== "undefined") {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws`;
  }
  return "ws://localhost:3000/ws";
}

export function resolveRoomId(): string {
  return runtime?.roomId || import.meta.env.VITE_SYNC_ROOM_ID || "gait-default";
}

export function isSyncEnabled(): boolean {
  return runtime?.enabled !== false;
}

/** @deprecated use resolveRoomId() */
export const SYNC_ROOM_ID = "gait-default";
