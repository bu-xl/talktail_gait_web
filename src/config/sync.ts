/** Camera ↔ mat sync + AI results API (talktail_gait back). */

import type { SyncConfig } from "../core/types.js";
import { normalizeApiBase } from "./apiUrl.js";

const trim = (s: string): string => s.replace(/\/$/, "");

let runtime: SyncConfig | null = null;

/** Inject sync settings from loaded config.json (called once at boot). */
export function configureSync(cfg: SyncConfig): void {
  runtime = cfg;
}

function envApiBase(): string | undefined {
  const v = import.meta.env.VITE_API_BASE_URL;
  if (v === undefined || v === null || String(v).trim() === "") return undefined;
  return normalizeApiBase(String(v));
}

/**
 * HTTP base for API calls.
 * May end with `/api` when the public domain only routes that prefix
 * (e.g. https://gait.o-r.kr/api).
 */
function isInsecureHttpOnHttpsPage(url: string): boolean {
  return (
    typeof location !== "undefined" &&
    location.protocol === "https:" &&
    /^http:\/\//i.test(url)
  );
}

export function resolveApiBase(): string {
  const fromEnv = envApiBase();
  if (fromEnv !== undefined && !isInsecureHttpOnHttpsPage(fromEnv)) return fromEnv;
  const fromCfg = runtime?.apiBaseUrl?.trim();
  if (fromCfg) {
    const api = normalizeApiBase(fromCfg);
    if (!isInsecureHttpOnHttpsPage(api)) return api;
  }
  // Same-origin (HTTPS tunnel / reverse proxy) when unset or mixed-content unsafe.
  if (typeof location !== "undefined") return location.origin;
  return "http://localhost:3000";
}

function sameOriginWs(): string {
  if (typeof location === "undefined") return "ws://localhost:3000/ws";
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

function isInsecureWsOnHttpsPage(wsUrl: string): boolean {
  return (
    typeof location !== "undefined" &&
    location.protocol === "https:" &&
    /^ws:\/\//i.test(wsUrl)
  );
}

/** WebSocket hub URL (`/ws` on the back server). */
export function resolveWsUrl(): string {
  const fromEnv = import.meta.env.VITE_WS_URL;
  if (fromEnv && String(fromEnv).trim()) {
    const ws = String(fromEnv).trim();
    if (!isInsecureWsOnHttpsPage(ws)) return ws;
  }
  const fromCfg = runtime?.wsUrl?.trim();
  if (fromCfg && !isInsecureWsOnHttpsPage(fromCfg)) return fromCfg;
  const api = envApiBase() || (runtime?.apiBaseUrl?.trim() ? normalizeApiBase(runtime.apiBaseUrl) : "");
  if (api) {
    // WS is usually on host `/ws`, not under `/api/ws`
    const host = trim(api).replace(/\/api$/i, "");
    const ws = `${host.replace(/^http/, "ws")}/ws`;
    if (!isInsecureWsOnHttpsPage(ws)) return ws;
  }
  return sameOriginWs();
}

export function resolveRoomId(): string {
  // @deprecated 방은 이제 **로그인한 계정**이고 서버가 세션에서 확정한다.
  // 클라이언트가 방 이름을 정하면 남의 방에 그냥 들어갈 수 있다.
  return runtime?.roomId || import.meta.env.VITE_SYNC_ROOM_ID || "";
}

export function isSyncEnabled(): boolean {
  return runtime?.enabled !== false;
}

/** @deprecated use resolveRoomId() */
export const SYNC_ROOM_ID = "gait-default";
