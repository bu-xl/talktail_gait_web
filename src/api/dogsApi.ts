import { apiFetch } from "./http.js";
/**
 * 개체 등록부 — back `/api/dogs`.
 *
 * 전신은 `/api/dog-presets`(빠른 입력용 프리셋)였다. 지금은 촬영이 이 행을 참조하므로
 * (`gait_sessions.dog_id`) 여기가 "같은 개인가" 를 판정하는 유일한 근거다.
 * 측정은 **등록된 개체로만** 시작한다 — 측정 화면에서 이름을 손으로 치는 입력은 없어졌다.
 */

export interface Dog {
  /** 전역 AUTO_INCREMENT 정수. 저장 경로 `uploads/<userId>/<dogId>/<도장>/` 의 한 조각이다. */
  id: number;
  name: string;
  /**
   * **등록 후 못 바꾼다.** 몸무게가 다르면 다른 개체로 센다 — 압력매트 센서값과의 상관관계를
   * 보려는 값이지 체중 관리용이 아니기 때문이다. 살이 쪘으면 새로 등록한다.
   */
  weightKg: number;
  heightCm: number | null;
  breed: string | null;
  /** `YYYY-MM`. 나이는 화면에서 계산한다 — 저장하면 1년 뒤 틀린 값이 된다. */
  birthMonth: string | null;
  sex: "male" | "female" | null;
  neutered: boolean | null;
  createdAt?: string;
  /** 이 개체의 촬영 건수. 0 이 아니면 삭제가 409 로 막힌다. */
  sessionCount?: number | null;
}

export type DogDraft = Omit<Dog, "id" | "createdAt" | "sessionCount">;
/** 정보 변경에서 고칠 수 있는 것 — 몸무게는 빠져 있다. */
export type DogPatch = Partial<Omit<DogDraft, "weightKg">>;

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { error?: string; sessionCount?: number }
      | null;
    const err = new Error(body?.error || `${res.status} ${res.statusText}`);
    (err as Error & { status?: number; sessionCount?: number }).status = res.status;
    (err as Error & { sessionCount?: number }).sessionCount = body?.sessionCount;
    throw err;
  }
  return (await res.json()) as T;
}

export async function listDogs(apiBase: string): Promise<Dog[]> {
  const res = await apiFetch(`${apiBase}/api/dogs`);
  return (await json<{ dogs: Dog[] }>(res)).dogs;
}

/**
 * 등록. 같은 정보의 개체가 이미 있어도 **막지 않는다** — 같은 날 이름도 몸무게도 같은
 * *다른 개*가 오는 것이 이 재설계의 출발점이다. 응답의 `duplicates` 로 경고만 띄운다.
 */
export async function createDog(
  apiBase: string,
  draft: DogDraft,
): Promise<{ dog: Dog; duplicates: Dog[] }> {
  const res = await apiFetch(`${apiBase}/api/dogs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  });
  return json<{ dog: Dog; duplicates: Dog[] }>(res);
}

/** 정보 변경. `affectedSessions` 는 "과거 촬영 N건의 표시가 함께 바뀝니다" 안내에 쓴다. */
export async function updateDog(
  apiBase: string,
  id: number,
  patch: DogPatch,
): Promise<{ dog: Dog; affectedSessions: number }> {
  const res = await apiFetch(`${apiBase}/api/dogs/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return json<{ dog: Dog; affectedSessions: number }>(res);
}

/** 삭제. 촬영 기록이 있으면 409 이고 `sessionCount` 가 실려 온다. */
export async function deleteDog(apiBase: string, id: number): Promise<void> {
  const res = await apiFetch(`${apiBase}/api/dogs/${id}`, { method: "DELETE" });
  await json<{ ok: true }>(res);
}
