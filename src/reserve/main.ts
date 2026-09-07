/**
 * 체험 신청 폼 — 현장 QR 로 들어오는 **공개 페이지**의 전부.
 *
 * 앱 본체와 아무것도 공유하지 않는다. `api/http.ts` 의 `apiFetch` 조차 쓰지 않는데,
 * 그것은 401 을 잡아 로그인 화면을 띄우는 물건이고 이 페이지에는 로그인 화면이 없다.
 * 서버가 같은 출처로 이 파일을 서빙하므로(back 이 dist 를 정적 서빙, dev 는 vite 프록시)
 * 상대 경로 `/api/...` 로 충분하다.
 *
 * 이메일은 인증하지 않기로 했다. 대신 제출 직전에 **입력한 주소를 크게 되보여 준다** —
 * 오타를 잡는 유일한 지점이라 건너뛸 수 없게 모달로 막는다.
 */

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const form = $<HTMLFormElement>("reserveForm");
const errorEl = $("rError");
const submitBtn = $<HTMLButtonElement>("rSubmit");
const modal = $("confirmModal");

interface Payload {
  code: string;
  dogName: string;
  dogWeightKg: number;
  dogBreed: string | null;
  dogBirthMonth: string | null;
  dogSex: string | null;
  dogNeutered: boolean | null;
  ownerEmail: string;
  reason: string | null;
  agreedPrivacy: boolean;
  agreedEmail: boolean;
  agreedVideo: boolean;
}

const value = (id: string): string => $<HTMLInputElement>(id).value.trim();
const checked = (id: string): boolean => $<HTMLInputElement>(id).checked;

/** 라디오는 아무것도 안 고를 수 있다 — 그때는 null 이다(미입력 ≠ 거짓). */
function radio(name: string): string | null {
  const el = form.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`);
  return el ? el.value : null;
}

function setError(message: string): void {
  errorEl.textContent = message;
  if (message) errorEl.scrollIntoView({ behavior: "smooth", block: "center" });
}

/** 서버와 같은 규칙. 여기서 막는 것은 편의고, 정본은 서버다. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 화면 입력 → 전송 형태. 통과하지 못하면 오류 문구를 돌려준다. */
function collect(): Payload | string {
  const code = value("rCode").toUpperCase();
  if (!code) return "현장에서 안내받은 코드를 입력해 주세요.";

  const dogName = value("rDogName");
  if (!dogName) return "반려견 이름을 입력해 주세요.";

  const weight = Number(value("rWeight"));
  if (!Number.isFinite(weight) || weight <= 0) return "몸무게를 숫자로 입력해 주세요.";

  const ownerEmail = value("rEmail");
  if (!EMAIL_RE.test(ownerEmail)) return "이메일 주소를 다시 확인해 주세요.";

  if (!checked("rAgreePrivacy") || !checked("rAgreeEmail") || !checked("rAgreeVideo")) {
    return "동의 항목에 모두 동의해야 신청할 수 있습니다.";
  }

  const neutered = radio("dogNeutered");
  return {
    code,
    dogName,
    dogWeightKg: weight,
    dogBreed: value("rBreed") || null,
    dogBirthMonth: value("rBirth") || null,
    dogSex: radio("dogSex"),
    dogNeutered: neutered == null ? null : neutered === "1",
    ownerEmail,
    reason: value("rReason") || null,
    agreedPrivacy: true,
    agreedEmail: true,
    agreedVideo: true,
  };
}

async function send(payload: Payload): Promise<void> {
  submitBtn.disabled = true;
  try {
    const res = await fetch("/api/reservations/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error || `신청에 실패했습니다. (${res.status})`);
      return;
    }
    // 폼을 통째로 감춘다 — 남겨 두면 같은 사람이 두 번 낸다.
    form.style.display = "none";
    $("doneEmail").textContent = payload.ownerEmail;
    $("done").classList.add("open");
    window.scrollTo({ top: 0 });
  } catch {
    setError("서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  } finally {
    submitBtn.disabled = false;
  }
}

// ── 동의 전체 선택 ────────────────────────────────────────────────────────

const AGREE_IDS = ["rAgreePrivacy", "rAgreeEmail", "rAgreeVideo"];

function syncAgreeAll(): void {
  $<HTMLInputElement>("rAgreeAll").checked = AGREE_IDS.every(checked);
}

$("rAgreeAll").addEventListener("change", (ev) => {
  const on = (ev.target as HTMLInputElement).checked;
  for (const id of AGREE_IDS) $<HTMLInputElement>(id).checked = on;
});
for (const id of AGREE_IDS) $(id).addEventListener("change", syncAgreeAll);

// ── 제출 ──────────────────────────────────────────────────────────────────

let pending: Payload | null = null;

form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  setError("");
  const result = collect();
  if (typeof result === "string") {
    setError(result);
    return;
  }
  pending = result;
  $("confirmEmail").textContent = result.ownerEmail;
  modal.classList.add("open");
});

$("confirmBack").addEventListener("click", () => {
  modal.classList.remove("open");
  pending = null;
  $<HTMLInputElement>("rEmail").focus();
});

$("confirmGo").addEventListener("click", () => {
  if (!pending) return;
  modal.classList.remove("open");
  void send(pending);
  pending = null;
});
