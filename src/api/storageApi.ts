/**
 * back 디스크 여유 공간 조회. 현장에서 용량이 바닥나 영상이 안 올라가는 사고를 미리 보려고 쓴다.
 */

import { joinApiUrl } from "../config/apiUrl.js";
import { apiFetch } from "./http.js";

export type FolderUsage = {
  name: string;
  bytes: number;
  files: number;
};

export type StorageUsage = {
  disk: {
    total: number;
    used: number;
    available: number;
    /** `df` 의 Use% 와 같은 정의. */
    percent: number;
  };
  folders: FolderUsage[];
};

/**
 * @param userId 마스터가 남의 계정을 볼 때만 준다. 일반 계정은 무엇을 보내든
 *   서버가 자기 것으로 되돌린다 — 화면이 아니라 서버가 경계를 지킨다.
 */
export async function getStorageUsage(apiBaseUrl: string, userId?: string): Promise<StorageUsage> {
  const path = userId ? `/api/storage?userId=${encodeURIComponent(userId)}` : "/api/storage";
  const res = await apiFetch(joinApiUrl(apiBaseUrl, path));
  if (!res.ok) throw new Error(`storage HTTP ${res.status}`);
  const json = (await res.json()) as StorageUsage;
  return { disk: json.disk, folders: Array.isArray(json.folders) ? json.folders : [] };
}
