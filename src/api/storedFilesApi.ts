/**
 * 서버 디스크의 원본 CSV·영상 목록. DB 가 아니라 back 폴더를 읽는다.
 */

import { joinApiUrl } from "../config/apiUrl.js";

export type StoredCsvFile = {
  name: string;
  size: number;
  mtime: string;
  url: string;
};

export type StoredVideoFile = StoredCsvFile & {
  role: "main" | "sub" | string;
};

export type StoredFilesList = {
  source: string;
  csv: StoredCsvFile[];
  videos: StoredVideoFile[];
};

export async function listStoredFiles(apiBaseUrl: string): Promise<StoredFilesList> {
  const res = await fetch(joinApiUrl(apiBaseUrl, "/api/files"));
  if (!res.ok) throw new Error(`files HTTP ${res.status}`);
  const json = (await res.json()) as StoredFilesList;
  return {
    source: json.source || "fs",
    csv: Array.isArray(json.csv) ? json.csv : [],
    videos: Array.isArray(json.videos) ? json.videos : [],
  };
}

/** 목록의 상대 경로를 절대 URL 로. `download=1` 이면 첨부 저장. */
export function storedFileUrl(apiBaseUrl: string, rel: string, download = true): string {
  const url = joinApiUrl(apiBaseUrl, rel);
  if (!download) return url;
  return `${url}${url.includes("?") ? "&" : "?"}download=1`;
}

export type ZipKind = "csv" | "video";

export type ZipTicket = {
  token: string;
  kind: ZipKind;
  /** 실제로 zip 에 담기는 파일 수 (사라진 파일은 빠진다). */
  count: number;
  totalSize: number;
  filename: string;
  /** `/api/files/zip/<token>` — `zipDownloadUrl()` 로 절대 URL 을 만든다. */
  url: string;
  /** 서버에서 찾지 못한 항목 수. */
  missingCount: number;
};

/**
 * 여러 파일을 한 번에 받기 위한 다운로드 토큰을 발급받는다.
 *
 * 파일명을 URL 에 싣지 않으려고 POST 로 목록을 보내고, 실제 내려받기는
 * `zipDownloadUrl()` 을 브라우저에 맡긴다 — 수 GB 를 Blob 으로 들고 있지 않기 위해서다.
 *
 * @param files csv 는 파일명(`a.csv`), 영상은 `role/파일명`(`main/x.mp4`).
 */
export async function createZipTicket(
  apiBaseUrl: string,
  kind: ZipKind,
  files: string[],
): Promise<ZipTicket> {
  const res = await fetch(joinApiUrl(apiBaseUrl, "/api/files/zip-ticket"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, files }),
  });
  const json = (await res.json().catch(() => null)) as (Partial<ZipTicket> & { error?: string }) | null;
  if (!res.ok || !json || typeof json.url !== "string") {
    const detail = json && typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return {
    token: String(json.token || ""),
    kind: json.kind === "video" ? "video" : "csv",
    count: Number(json.count) || 0,
    totalSize: Number(json.totalSize) || 0,
    filename: String(json.filename || "files.zip"),
    url: json.url,
    missingCount: Number(json.missingCount) || 0,
  };
}

/** 발급받은 티켓의 zip 다운로드 절대 URL. */
export function zipDownloadUrl(apiBaseUrl: string, ticketUrl: string): string {
  return joinApiUrl(apiBaseUrl, ticketUrl);
}
