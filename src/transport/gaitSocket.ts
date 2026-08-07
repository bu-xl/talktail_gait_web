/**
 * 웹(매트 뷰어) ↔ back WebSocket 클라이언트.
 * 녹화 동기화 + 분석 결과만 담당 (라이브 영상 전송 없음).
 */

import { joinApiUrl } from "../config/apiUrl.js";

export type SyncPeers = { web: boolean; mobile: boolean };

export type SyncMessage =
  | { type: "joined"; role: string; roomId: string; peers: SyncPeers; serverNow: number }
  | { type: "peer_update"; roomId: string; peers: SyncPeers }
  | {
      type: "sync_start";
      roomId: string;
      sessionId: string;
      serverNow: number;
      recordAt: number;
      syncLeadMs: number;
    }
  | { type: "record_stop"; roomId: string; sessionId: string | null; from: string; serverNow: number }
  | { type: "preview_frame"; mime: string; data: string; ts: number }
  | { type: "upload_started"; jobId: string; sessionId: string | null; roomId: string }
  | {
      type: "analyze_done";
      jobId: string;
      resultUrl: string;
      resultFilename?: string | null;
      originalUrl?: string | null;
      artifacts?: Record<string, { kind?: string; filename?: string; url?: string | null; available?: boolean }> | null;
      date?: string | null;
      time?: string | null;
      stem?: string | null;
      sessionPath?: string | null;
      sessionId: string | null;
      serverNow: number;
    }
  | { type: "analyze_failed"; jobId?: string; error: string; sessionId?: string | null }
  | { type: "error"; message: string }
  | { type: "pong"; serverTs: number; clientTs: number | null }
  | { type: "replaced"; reason: string };

type Handler = (msg: SyncMessage) => void;
type ConnectionHandler = (connected: boolean) => void;

export interface GaitSyncOptions {
  wsUrl: string;
  roomId: string;
}

export class GaitSyncSocket {
  private ws: WebSocket | null = null;
  private handler: Handler = () => {};
  private connectionHandler: ConnectionHandler = () => {};
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private readonly wsUrl: string;
  private readonly roomId: string;
  peers: SyncPeers = { web: false, mobile: false };
  connected = false;

  constructor(opts: GaitSyncOptions) {
    this.wsUrl = opts.wsUrl;
    this.roomId = opts.roomId;
  }

  onMessage(handler: Handler): void {
    this.handler = handler;
  }

  onConnectionChange(handler: ConnectionHandler): void {
    this.connectionHandler = handler;
  }

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.connected = false;
    this.connectionHandler(false);
  }

  send(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  join(): void {
    this.send({ type: "join", role: "web", roomId: this.roomId });
  }

  requestRecord(): void {
    this.send({ type: "record_request" });
  }

  stopRecord(sessionId?: string | null): void {
    this.send({ type: "record_stop", sessionId: sessionId ?? null });
  }

  private open(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    console.log("[gait-sync] connecting", this.wsUrl);
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      console.log("[gait-sync] open");
      this.connectionHandler(true);
      this.join();
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as SyncMessage;
        if (msg.type === "joined" || msg.type === "peer_update") {
          this.peers = msg.peers;
        }
        this.handler(msg);
      } catch (err) {
        console.warn("[gait-sync] bad message", err);
      }
    };

    ws.onerror = () => console.warn("[gait-sync] error");
    ws.onclose = () => {
      this.connected = false;
      this.ws = null;
      console.log("[gait-sync] closed");
      this.connectionHandler(false);
      if (!this.closedByUser) {
        this.reconnectTimer = setTimeout(() => this.open(), 1500);
      }
    };
  }
}

export function waitUntilRecordAt(recordAt: number): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => {
      const remain = recordAt - Date.now();
      if (remain <= 0) {
        resolve();
        return;
      }
      setTimeout(tick, Math.min(remain, 50));
    };
    tick();
  });
}

export function absolutizeResultUrl(apiBaseUrl: string, resultUrl: string): string {
  if (resultUrl.startsWith("http://") || resultUrl.startsWith("https://")) return resultUrl;
  return joinApiUrl(apiBaseUrl, resultUrl);
}

type JobPoll = {
  id: string;
  status: "processing" | "completed" | "failed";
  resultUrl: string | null;
  originalUrl?: string | null;
  artifacts?: Record<string, { kind?: string; filename?: string; url?: string | null; available?: boolean }> | null;
  date?: string | null;
  time?: string | null;
  stem?: string | null;
  sessionPath?: string | null;
  error: string | null;
};

/** HTTP fallback when WebSocket analyze_done is missed. */
export async function pollJobUntilDone(
  apiBaseUrl: string,
  jobId: string,
  intervalMs = 1500,
  timeoutMs = 10 * 60 * 1000,
): Promise<JobPoll> {
  const started = Date.now();
  for (;;) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("job poll timeout");
    }
    const res = await fetch(joinApiUrl(apiBaseUrl, `/api/jobs/${encodeURIComponent(jobId)}`));
    if (!res.ok) throw new Error(`job poll HTTP ${res.status}`);
    const job = (await res.json()) as JobPoll;
    if (job.status === "completed" || job.status === "failed") return job;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
