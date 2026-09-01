/**
 * 반려견 신원 게이트 — 이름·몸무게·견종이 없으면 분석을 시작할 수 없다.
 *
 * 두 값은 나중에 붙이는 메타데이터가 아니라 **파일명(태스크명)에 들어간다.**
 * back 의 `dogPrefix()` 가 빠진 값을 조용히 버리므로 결과가 이렇게 갈린다.
 *
 *     대박이-5.2kg-260819-144204   이름 + 몸무게
 *     대박이-260819-144204         이름만 (몸무게가 버려진다)
 *     260819-144204                둘 다 없음 → 누구의 보행인지 되찾을 수 없다
 *
 * 측정과 직접 분석은 **같은 파이프라인**을 타므로 판정도 한 곳에 둔다. 각자
 * 인라인으로 두면 나중에 한쪽만 바뀌어 규칙이 갈라진다.
 *
 * 문구는 돌려주지 않고 키만 준다 — 여기서 i18n 을 끌어오지 않기 위해서다.
 * 부르는 쪽에서 `t(gate.reasonKey)` 한다.
 */

export type DogIdentityReasonKey = "session_need_dog";

export interface DogIdentity {
  name?: string | null;
  weightKg?: number | null;
  breed?: string | null;
}

export interface DogIdentityGate {
  ok: boolean;
  /** 통과하면 null. */
  reasonKey: DogIdentityReasonKey | null;
}

export function checkDogIdentity(dog: DogIdentity | null | undefined): DogIdentityGate {
  const hasName = Boolean(dog?.name && dog.name.trim());
  const weight = dog?.weightKg;
  const hasWeight = weight != null && Number.isFinite(weight) && weight > 0;
  const hasBreed = Boolean(dog?.breed && dog.breed.trim());
  if (hasName && hasWeight && hasBreed) return { ok: true, reasonKey: null };
  return { ok: false, reasonKey: "session_need_dog" };
}
