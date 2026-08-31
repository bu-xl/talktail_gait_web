import { apiFetch } from "./http.js";
/** 빠른 입력용 반려견 프리셋 — back `/api/dog-presets`. */

export interface DogPreset {
  id: string;
  name: string;
  weightKg: number;
  heightCm: number | null;
  breed: string | null;
}

export type DogPresetDraft = Omit<DogPreset, "id">;

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export async function listDogPresets(apiBase: string): Promise<DogPreset[]> {
  const res = await apiFetch(`${apiBase}/api/dog-presets`);
  return (await json<{ presets: DogPreset[] }>(res)).presets;
}

export async function createDogPreset(apiBase: string, draft: DogPresetDraft): Promise<DogPreset> {
  const res = await apiFetch(`${apiBase}/api/dog-presets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  });
  return (await json<{ preset: DogPreset }>(res)).preset;
}

export async function deleteDogPreset(apiBase: string, id: string): Promise<void> {
  const res = await apiFetch(`${apiBase}/api/dog-presets/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  await json<{ ok: true }>(res);
}
