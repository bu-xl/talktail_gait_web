import { apiFetch } from "./http.js";
import type { Dog } from "./dogsApi.js";
/**
 * 체험 예약 현황 — back `/api/reservations`.
 *
 * 신청(`/apply`)은 공개 폼(`src/reserve/`)이 직접 부른다. 여기 있는 것은 전부
 * 테스터·마스터 계정만 닿는 조회·수정이다.
 */

export type ReservationStatus = "waiting" | "measuring" | "hold";

export interface Reservation {
  id: string;
  code: string | null;
  /**
   * 접수 확정 시 발급된 개체(`dogs.id`). **접수만으로는 null 이다**(§3-3-A).
   *
   * 예약은 방문하지 않을 수 있어 자동으로 만들지 않는다. 카드의 [측정 시작] 이
   * `POST /api/reservations/:id/dog` 를 불러 그때 발급한다.
   */
  dogId: number | null;
  dogName: string;
  dogWeightKg: number;
  dogBreed: string | null;
  /** `YYYY-MM`. 나이는 화면에서 계산한다 — 저장해 두면 1년 뒤 틀린 값이 된다. */
  dogBirthMonth: string | null;
  dogSex: "male" | "female" | null;
  dogNeutered: boolean | null;
  ownerEmail: string;
  reason: string | null;
  status: ReservationStatus;
  /** 마지막으로 카드를 눌러 입력란을 채운 계정. 잠금이 아니라 표시다. */
  claimedBy: string | null;
  claimedAt: string | null;
  createdAt: string;
}

/** 같은 개체 후보 — [측정 시작] 전에 "기존 개체로 측정" 을 제안한다(§3-3-A). */
export interface DogCandidate {
  id: number;
  name: string;
  weightKg: number | null;
  breed: string | null;
  birthMonth: string | null;
  createdAt: string;
  /** 예약서의 몸무게와 같은가. 다르면 §3-2-A 대로 **새 개체**가 맞다. */
  sameWeight: boolean;
}

export interface ReservationDate {
  date: string;
  count: number;
}

export interface ReservationCode {
  code: string;
  label: string | null;
  active: boolean;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export async function listReservationDates(apiBase: string): Promise<ReservationDate[]> {
  const res = await apiFetch(`${apiBase}/api/reservations/dates`);
  return (await json<{ dates: ReservationDate[] }>(res)).dates;
}

export async function listReservations(
  apiBase: string,
  params: { date?: string | null; status?: ReservationStatus | "all" },
): Promise<Reservation[]> {
  const query = new URLSearchParams();
  if (params.date) query.set("date", params.date);
  if (params.status && params.status !== "all") query.set("status", params.status);
  const suffix = query.toString() ? `?${query}` : "";
  const res = await apiFetch(`${apiBase}/api/reservations${suffix}`);
  return (await json<{ reservations: Reservation[] }>(res)).reservations;
}

export async function setReservationStatus(
  apiBase: string,
  id: string,
  status: ReservationStatus,
): Promise<Reservation> {
  const res = await apiFetch(`${apiBase}/api/reservations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  return (await json<{ reservation: Reservation }>(res)).reservation;
}

export async function deleteReservation(apiBase: string, id: string): Promise<void> {
  const res = await apiFetch(`${apiBase}/api/reservations/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  await json<{ ok: true }>(res);
}

// ── 코드 (마스터) ────────────────────────────────────────────────────────

export async function listReservationCodes(apiBase: string): Promise<ReservationCode[]> {
  const res = await apiFetch(`${apiBase}/api/admin/reservation-codes`);
  return (await json<{ codes: ReservationCode[] }>(res)).codes;
}

/** 서너 개뿐이라 통째로 교체한다 — 개별 CRUD 를 만들 이유가 없다. */
export async function saveReservationCodes(
  apiBase: string,
  codes: ReservationCode[],
): Promise<ReservationCode[]> {
  const res = await apiFetch(`${apiBase}/api/admin/reservation-codes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ codes }),
  });
  return (await json<{ codes: ReservationCode[] }>(res)).codes;
}

// ── 표시 헬퍼 ────────────────────────────────────────────────────────────

/** `2020-03` → `5세 6개월`. 생년월이 없으면 null. */
export function ageLabel(birthMonth: string | null): string | null {
  if (!birthMonth || !/^\d{4}-\d{2}$/.test(birthMonth)) return null;
  const [y, m] = birthMonth.split("-").map(Number);
  const now = new Date();
  const months = (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - m);
  if (months < 0) return null;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  if (years === 0) return `${rest}개월`;
  return rest === 0 ? `${years}세` : `${years}세 ${rest}개월`;
}

/** `수컷 · 중성화` 처럼. 아무것도 없으면 null. */
export function sexLabel(
  sex: "male" | "female" | null,
  neutered: boolean | null,
): string | null {
  const parts: string[] = [];
  if (sex) parts.push(sex === "male" ? "수컷" : "암컷");
  if (neutered != null) parts.push(neutered ? "중성화 O" : "중성화 X");
  return parts.length ? parts.join(" · ") : null;
}

/**
 * 이름·견종·생년월이 같은 기존 개체 후보.
 *
 * 몸무게는 **일부러 빼고** 찾는다 — 몸무게가 다르면 다른 개체지만, 사람에게는
 * "같은 개가 살이 쪘다" 로 보여야 판단할 수 있다.
 */
export async function listDogCandidates(
  apiBase: string,
  reservationId: string,
): Promise<DogCandidate[]> {
  const res = await apiFetch(
    `${apiBase}/api/reservations/${encodeURIComponent(reservationId)}/dog-candidates`,
  );
  return (await json<{ candidates: DogCandidate[] }>(res)).candidates;
}

/**
 * **[추가]** — 이 예약을 개체 등록부에 올린다(§3-3-A).
 *
 * `dogId` 를 주면 기존 개체에 연결하고, 안 주면 예약서 정보로 새로 만든다.
 * 사람이 이 버튼을 누른 순간이 곧 "실제로 왔다" 는 신호다.
 */
export async function linkReservationDog(
  apiBase: string,
  reservationId: string,
  dogId?: number | null,
): Promise<{ reservation: Reservation; dog: Dog }> {
  const res = await apiFetch(
    `${apiBase}/api/reservations/${encodeURIComponent(reservationId)}/dog`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dogId != null ? { dogId } : {}),
    },
  );
  return json<{ reservation: Reservation; dog: Dog }>(res);
}
