/**
 * 체험 신청 폼 — 현장 QR 로 들어오는 **공개 페이지**의 전부.
 *
 * 앱 본체와 아무것도 공유하지 않는다. `api/http.ts` 의 `apiFetch` 조차 쓰지 않는데,
 * 그것은 401 을 잡아 로그인 화면을 띄우는 물건이고 이 페이지에는 로그인 화면이 없다.
 * 서버가 같은 출처로 이 파일을 서빙하므로(back 이 dist 를 정적 서빙, dev 는 vite 프록시)
 * 상대 경로 `/api/...` 로 충분하다.
 *
 * ## 검사 순서가 화면 순서와 같다
 *
 * 코드 → 반려견 → 이메일 → 동의. 오류는 **그 입력 옆에** 붙이고 첫 번째 오류로
 * 스크롤·포커스한다. 버튼 아래 한 줄로 몰면 폰에서 무엇이 잘못됐는지 안 보인다.
 *
 * 코드는 서버에 먼저 물어본다. 이메일 확인 모달까지 갔다가 코드 때문에 되돌아오면
 * 그 모달을 지나온 것 자체가 헛걸음이다.
 *
 * ## 이메일은 인증하지 않는다
 *
 * 대신 제출 직전에 입력한 주소를 크게 되보여 준다 — 오타를 잡는 유일한 지점이라
 * 건너뛸 수 없게 모달로 막는다.
 */

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const form = $<HTMLFormElement>("reserveForm");
const submitBtn = $<HTMLButtonElement>("rSubmit");
const confirmModal = $("confirmModal");
const alertModal = $("alertModal");

interface Payload {
  code: string;
  dogName: string;
  dogWeightKg: number;
  dogBreed: string;
  dogBirthMonth: string;
  dogSex: string;
  dogNeutered: boolean;
  ownerEmail: string;
  reason: string | null;
  agreedPrivacy: boolean;
  agreedEmail: boolean;
  agreedVideo: boolean;
}

const value = (id: string): string => $<HTMLInputElement>(id).value.trim();
const checked = (id: string): boolean => $<HTMLInputElement>(id).checked;

/** 라디오는 아무것도 안 고를 수 있다 — 그때는 빈 문자열이다. */
function radio(name: string): string {
  const el = form.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`);
  return el ? el.value : "";
}

// ── 오류 표시 ─────────────────────────────────────────────────────────────

/** 오류 문구 자리는 `data-for` 로 필드와 묶여 있다(reserve.html). */
function errorSlot(field: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.ferr[data-for="${field}"]`);
}

function clearErrors(): void {
  for (const el of document.querySelectorAll<HTMLElement>(".ferr.on")) {
    el.textContent = "";
    el.classList.remove("on");
  }
  for (const el of document.querySelectorAll<HTMLElement>(".is-error")) {
    el.classList.remove("is-error");
  }
}

/**
 * 오류를 그 입력에 붙이고 그리로 데려간다.
 * 포커스는 스크롤이 끝난 뒤에 준다 — 먼저 주면 브라우저가 제 위치로 튕겨 버린다.
 */
function showError(field: string, message: string): void {
  const slot = errorSlot(field);
  if (!slot) return;
  slot.textContent = message;
  slot.classList.add("on");

  const wrap = slot.closest(".field") || slot.parentElement;
  wrap?.classList.add("is-error");
  wrap?.scrollIntoView({ behavior: "smooth", block: "center" });

  const target =
    document.getElementById(field) ||
    form.querySelector<HTMLElement>(`input[name="${field}"]`);
  window.setTimeout(() => target?.focus({ preventScroll: true }), 350);
}

function showAlert(message: string): void {
  $("alertText").textContent = message;
  alertModal.classList.add("open");
}

// ── 검사 ──────────────────────────────────────────────────────────────────

/** 서버와 같은 규칙. 여기서 막는 것은 편의고, 정본은 서버다. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 화면 순서대로 본다 — 첫 번째로 걸리는 것이 사용자가 먼저 만나는 것이어야 한다. */
function collect(): Payload | { field: string; message: string } {
  const code = value("rCode").toUpperCase();
  if (!code) return { field: "rCode", message: "현장에서 안내받은 코드를 입력해 주세요." };

  const dogName = value("rDogName");
  if (!dogName) return { field: "rDogName", message: "반려견 이름을 입력해 주세요." };

  const weight = Number(value("rWeight"));
  if (!value("rWeight")) return { field: "rWeight", message: "몸무게를 입력해 주세요." };
  if (!Number.isFinite(weight) || weight <= 0) {
    return { field: "rWeight", message: "몸무게를 숫자로 입력해 주세요." };
  }

  const dogBreed = value("rBreed");
  if (!dogBreed) return { field: "rBreed", message: "견종을 입력해 주세요. 모르시면 '믹스'로 적어 주세요." };

  const dogBirthMonth = value("rBirth");
  if (!dogBirthMonth) return { field: "rBirth", message: "생년월을 골라 주세요." };
  // 미래 생년월은 오타다. 서버도 같은 규칙으로 다시 본다.
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  if (dogBirthMonth > thisMonth) {
    return { field: "rBirth", message: "생년월이 미래로 되어 있습니다." };
  }

  const dogSex = radio("dogSex");
  if (!dogSex) return { field: "dogSex", message: "성별을 선택해 주세요." };

  const neutered = radio("dogNeutered");
  if (!neutered) return { field: "dogNeutered", message: "중성화 여부를 선택해 주세요." };

  const ownerEmail = value("rEmail");
  if (!ownerEmail) return { field: "rEmail", message: "이메일 주소를 입력해 주세요." };
  if (!EMAIL_RE.test(ownerEmail)) {
    return { field: "rEmail", message: "이메일 주소 형식을 다시 확인해 주세요." };
  }

  if (!checked("rAgreePrivacy") || !checked("rAgreeEmail") || !checked("rAgreeVideo")) {
    return { field: "rAgreeAll", message: "동의 항목에 모두 동의해야 신청할 수 있습니다." };
  }

  return {
    code,
    dogName,
    dogWeightKg: weight,
    dogBreed,
    dogBirthMonth,
    dogSex,
    dogNeutered: neutered === "1",
    ownerEmail,
    reason: value("rReason") || null,
    agreedPrivacy: true,
    agreedEmail: true,
    agreedVideo: true,
  };
}

/** 서버가 준 오류 문구. 없으면 상태 코드로 대신한다. */
async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error || `요청에 실패했습니다. (${res.status})`;
}

// ── 서버 호출 ─────────────────────────────────────────────────────────────

/** 이메일 확인 모달 앞에서 코드부터 거른다. */
async function codeAccepted(code: string): Promise<boolean> {
  try {
    const res = await fetch("/api/reservations/check-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (res.ok) return true;
    showError("rCode", await errorOf(res));
    return false;
  } catch {
    showAlert("서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    return false;
  }
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
      const message = await errorOf(res);
      // 코드가 그사이 꺼졌을 수 있다 — 그것만 필드에 붙이고 나머지는 모달로.
      if (res.status === 403) showError("rCode", message);
      else showAlert(message);
      return;
    }
    // 폼을 통째로 감춘다 — 남겨 두면 같은 사람이 두 번 낸다.
    form.style.display = "none";
    $("doneEmail").textContent = payload.ownerEmail;
    $("done").classList.add("open");
    window.scrollTo({ top: 0 });
  } catch {
    showAlert("서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  } finally {
    syncSubmitGate();
  }
}

// ── 동의 전체 선택 ────────────────────────────────────────────────────────

const AGREE_IDS = ["rAgreePrivacy", "rAgreeEmail", "rAgreeVideo"];

/**
 * 동의 전에는 신청 버튼을 잠근다. 셋 다 필수라 눌러 봐야 거절될 뿐이고,
 * 잠긴 이유는 버튼 아래에 적어 둔다 — 이유 없이 잠긴 버튼은 고장으로 읽힌다.
 */
function syncSubmitGate(): void {
  const ready = AGREE_IDS.every(checked);
  $<HTMLInputElement>("rAgreeAll").checked = ready;
  submitBtn.disabled = !ready;
  $("rSubmitNote").hidden = ready;
}

$("rAgreeAll").addEventListener("change", (ev) => {
  const on = (ev.target as HTMLInputElement).checked;
  for (const id of AGREE_IDS) $<HTMLInputElement>(id).checked = on;
  syncSubmitGate();
});
for (const id of AGREE_IDS) $(id).addEventListener("change", syncSubmitGate);
// 새로고침해도 브라우저가 체크를 복원할 수 있다 — 화면 상태와 버튼을 맞춰 둔다.
syncSubmitGate();

// ── 제출 ──────────────────────────────────────────────────────────────────

let pending: Payload | null = null;

form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  clearErrors();
  const result = collect();
  if ("field" in result) {
    showError(result.field, result.message);
    return;
  }
  submitBtn.disabled = true;
  void codeAccepted(result.code)
    .then((ok) => {
      if (!ok) return;
      pending = result;
      $("confirmEmail").textContent = result.ownerEmail;
      confirmModal.classList.add("open");
    })
    .finally(() => {
      syncSubmitGate();
    });
});

$("confirmBack").addEventListener("click", () => {
  confirmModal.classList.remove("open");
  pending = null;
  $<HTMLInputElement>("rEmail").focus();
});

$("confirmGo").addEventListener("click", () => {
  if (!pending) return;
  confirmModal.classList.remove("open");
  void send(pending);
  pending = null;
});

$("alertClose").addEventListener("click", () => alertModal.classList.remove("open"));
