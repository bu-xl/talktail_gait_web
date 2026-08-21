/**
 * back 디스크 여유 공간 조회. 현장에서 용량이 바닥나 영상이 안 올라가는 사고를 미리 보려고 쓴다.
 */

import { joinApiUrl } from "../config/apiUrl.js";

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

export async function getStorageUsage(apiBaseUrl: string): Promise<StorageUsage> {
  const res = await fetch(joinApiUrl(apiBaseUrl, "/api/storage"));
  if (!res.ok) throw new Error(`storage HTTP ${res.status}`);
  const json = (await res.json()) as StorageUsage;
  return { disk: json.disk, folders: Array.isArray(json.folders) ? json.folders : [] };
}
