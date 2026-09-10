/**
 * 태스크(회차) 목록과 회차 통삭제 — back `/api/tasks`.
 *
 * 출처는 **DB(`gait_sessions` + `dogs`)** 다. 디스크를 스캔하지도, 파일명을 파싱하지도
 * 않는다(§3-7). "파일 다운" 화면과 다른 점이 이것이다 — 그쪽은 용량 확보가 목적이라
 * 디스크를 보고, 여기는 촬영이 제대로 쌓이는지를 통계로 확인한다.
 */

import { joinApiUrl } from "../config/apiUrl.js";
import { apiFetch } from "./http.js";

export type TaskDog = {
  id: number | null;
  name: string | null;
  breed: string | null;
  weightKg: number | null;
};

export type TaskRow = {
  /** `gait_sessions.id` — ws 세션 UUID. 삭제 요청이 보내는 값. */
  id: string;
  /** `260819-144204-37`. */
  taskName: string;
  stamp: string;
  date: string;
  displayDate: string;
  displayTime: string;
  userId: string;
  dog: TaskDog;
  /** `<userId>/<dogId>/<도장>` — 촬영 폴더. */
  dir: string | null;
  hasCsv: boolean;
  videoCount: number;
  analyzed: boolean;
  discardedAt: string | null;
  createdAt: string;
};

export type TaskQuery = {
  /** `YYMMDD`. 도장 앞 6자리로 거른다. */
  from?: string | null;
  to?: string | null;
  dogId?: number | null;
};

export async function listTasks(apiBaseUrl: string, q: TaskQuery = {}): Promise<TaskRow[]> {
  const params = new URLSearchParams();
  if (q.from) params.set("from", q.from);
  if (q.to) params.set("to", q.to);
  if (q.dogId != null) params.set("dogId", String(q.dogId));
  const qs = params.toString();
  const res = await apiFetch(joinApiUrl(apiBaseUrl, `/api/tasks${qs ? `?${qs}` : ""}`));
  if (!res.ok) throw new Error(`tasks HTTP ${res.status}`);
  const json = (await res.json()) as { tasks?: TaskRow[] };
  return Array.isArray(json.tasks) ? json.tasks : [];
}

export type DeleteTasksResult = {
  deleted: number;
  removedDirs: string[];
  resultDirs: string[];
  /** ai-server 산출물 삭제가 실패한 폴더. back 쪽은 이미 지워진 상태다. */
  aiErrors: string[];
};

/**
 * 회차를 다른 개체로 옮긴다 (§3-1 정정) — 개를 잘못 골라 찍었을 때.
 *
 * 서버가 폴더와 파일명 안의 dogId 까지 함께 바꾼다. **분석이 끝난 회차는 409 로 막힌다** —
 * 산출물은 ai-server 디스크에 있어 back 이 못 옮긴다.
 */
export async function moveTaskDog(
  apiBaseUrl: string,
  id: string,
  dogId: number,
): Promise<void> {
  const res = await apiFetch(joinApiUrl(apiBaseUrl, `/api/tasks/${encodeURIComponent(id)}/dog`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dogId }),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(json?.error || `HTTP ${res.status}`);
  }
}

/**
 * 회차 통삭제 — 원본 폴더 + ai-server 산출물 + DB 행을 한 번에 지운다.
 *
 * **되돌릴 수 없다.** "파일 다운" 화면의 삭제와 달리 분석 결과까지 사라진다.
 * 부르는 쪽은 회차 수와 개 이름을 확인 문구에 반드시 넣는다.
 */
export async function deleteTasks(
  apiBaseUrl: string,
  ids: string[],
): Promise<DeleteTasksResult> {
  const res = await apiFetch(joinApiUrl(apiBaseUrl, "/api/tasks/delete"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  const json = (await res.json().catch(() => null)) as
    | (Partial<DeleteTasksResult> & { error?: string })
    | null;
  if (!res.ok || !json) {
    const detail = json && typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return {
    deleted: Number(json.deleted) || 0,
    removedDirs: Array.isArray(json.removedDirs) ? json.removedDirs : [],
    resultDirs: Array.isArray(json.resultDirs) ? json.resultDirs : [],
    aiErrors: Array.isArray(json.aiErrors) ? json.aiErrors : [],
  };
}
