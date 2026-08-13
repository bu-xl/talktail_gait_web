/**
 * 반려견 정보 모달 — 결과 화면(측정 / 리포트 다시보기)의 "정보" 버튼이 연다.
 *
 * 레이아웃을 건드리지 않고 입력했던 이름·견종·몸무게·신장만 보여 주는 용도라
 * 패널이 아니라 모달이다. 마크업은 index.html 의 `#dogInfoModal` 하나를 공유한다.
 */

import { t } from "../i18n/index.js";
import type { ManualDogInfo } from "../api/analyzeApi.js";

export type DogInfoView = ManualDogInfo & {
  /** 모달 부제(세션 시각 등). 없으면 감춘다. */
  subtitle?: string | null;
};

let wired = false;

function el(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function closeModal(): void {
  const modal = el("dogInfoModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

function wire(): void {
  if (wired) return;
  const modal = el("dogInfoModal");
  if (!modal) return;
  wired = true;
  el("dogInfoModalClose")?.addEventListener("click", () => closeModal());
  modal.addEventListener("click", (ev) => {
    if (ev.target === modal) closeModal();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && modal.classList.contains("open")) closeModal();
  });
}

function formatNumber(value: number | null | undefined, unit: string): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  const rounded = Math.round(value * 10) / 10;
  return `${rounded}${unit}`;
}

/** 반려견 정보 모달을 연다. 값이 없는 항목은 `–` 로 남긴다. */
export function openDogInfoModal(dog: DogInfoView | null | undefined): void {
  wire();
  const modal = el("dogInfoModal");
  const body = el("dogInfoModalBody");
  if (!modal || !body) return;

  const title = el("dogInfoModalTitle");
  if (title) title.textContent = t("dog_info_title");
  const sub = el("dogInfoModalSub");
  if (sub) {
    sub.textContent = dog?.subtitle || "";
    sub.hidden = !dog?.subtitle;
  }

  const rows: Array<[string, string | null]> = [
    [t("dog_name"), dog?.name?.trim() || null],
    [t("dog_breed"), dog?.breed?.trim() || null],
    [t("dog_weight"), formatNumber(dog?.weightKg, " kg")],
    [t("dog_height"), formatNumber(dog?.heightCm, " cm")],
  ];

  body.innerHTML = "";
  if (rows.every(([, value]) => !value)) {
    const p = document.createElement("p");
    p.className = "dim-empty";
    p.textContent = t("dog_info_empty");
    body.appendChild(p);
  } else {
    for (const [label, value] of rows) {
      const row = document.createElement("div");
      row.className = "dim-row";
      const k = document.createElement("span");
      k.textContent = label;
      const v = document.createElement("b");
      v.textContent = value || "–";
      if (!value) v.classList.add("is-empty");
      row.append(k, v);
      body.appendChild(row);
    }
  }

  const close = el("dogInfoModalClose");
  if (close) close.textContent = t("dog_info_close");

  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
}
