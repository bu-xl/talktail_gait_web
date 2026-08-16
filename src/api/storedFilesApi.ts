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
