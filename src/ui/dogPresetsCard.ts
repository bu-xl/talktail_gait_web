/**
 * 빠른 입력 — 측정 화면에서 반려견 정보를 손으로 다시 치지 않게 한다.
 *
 * 현장에서는 1번 개 → 2번 개 → 3번 개를 돌아가며 반복 측정한다. 매번 이름·몸무게를
 * 치면 오타가 나고, 그 오타가 그대로 파일명이 되어 같은 개의 촬영이 두 이름으로
 * 갈린다. 한 번 등록해 두고 카드를 눌러 채운다.
 *
 * 이 모듈은 프리셋 카드 목록과 등록 모달만 담당한다. 채워 넣을 입력란
 * (`#dogName` 등)의 소유는 측정 화면이므로, 채우는 일은 `onPick` 으로 넘긴다.
 */

import {
  createDogPreset,
  deleteDogPreset,
  listDogPresets,
  type DogPreset,
} from "../api/dogPresetsApi.js";
import { t } from "../i18n/index.js";

export interface DogPresetsCardOptions {
  /** 카드를 눌렀을 때 — 측정 화면의 반려견 입력란을 채운다. */
  onPick(preset: DogPreset): void;
}

export class DogPresetsCard {
  private apiBase = "";
  private presets: DogPreset[] = [];

  private readonly listEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private readonly modal: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly errorEl: HTMLElement;

  constructor(private readonly opts: DogPresetsCardOptions) {
    this.listEl = document.getElementById("dogPresetList") as HTMLElement;
    this.emptyEl = document.getElementById("dogPresetEmpty") as HTMLElement;
    this.modal = document.getElementById("dogPresetModal") as HTMLElement;
    this.form = document.getElementById("dogPresetForm") as HTMLFormElement;
    this.errorEl = document.getElementById("dogPresetError") as HTMLElement;
    this.bind();
    // API 주소가 아직 없어도 빈 상태 안내는 보여 준다.
    this.render();
  }

  setApiBase(url: string): void {
    this.apiBase = url.replace(/\/$/, "");
  }

  async refresh(): Promise<void> {
    if (!this.apiBase) return;
    try {
      this.presets = await listDogPresets(this.apiBase);
    } catch {
      // 목록을 못 읽어도 측정은 막지 않는다 — 손으로 입력하면 된다.
      this.presets = [];
    }
    this.render();
  }

  /** 언어가 바뀌면 정적 문구를 다시 그린다. */
  renderLabels(): void {
    const set = (id: string, key: Parameters<typeof t>[0]): void => {
      const el = document.getElementById(id);
      if (el) el.textContent = t(key);
    };
    set("dogPresetTitle", "qi_title");
    set("dogPresetHint", "qi_hint");
    set("btnDogPresetAdd", "qi_register");
    set("dogPresetModalTitle", "qi_modal_title");
    set("dogPresetModalSub", "qi_modal_sub");
    set("dogPresetSave", "qi_save");
    set("dogPresetCancel", "qi_cancel");
    this.render();
  }

  private bind(): void {
    document
      .getElementById("btnDogPresetAdd")
      ?.addEventListener("click", () => this.openModal());
    document
      .getElementById("dogPresetCancel")
      ?.addEventListener("click", () => this.closeModal());
    this.modal.addEventListener("click", (ev) => {
      if (ev.target === this.modal) this.closeModal();
    });
    window.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && this.modal.classList.contains("open")) this.closeModal();
    });
    this.form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      void this.submit();
    });
  }

  private openModal(): void {
    this.form.reset();
    this.errorEl.textContent = "";
    this.modal.classList.add("open");
    document.body.classList.add("modal-open");
    (document.getElementById("dpName") as HTMLInputElement | null)?.focus();
  }

  private closeModal(): void {
    this.modal.classList.remove("open");
    document.body.classList.remove("modal-open");
  }

  private async submit(): Promise<void> {
    const value = (id: string): string =>
      (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? "";
    const num = (id: string): number | null => {
      const raw = value(id);
      if (!raw) return null;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : null;
    };

    const name = value("dpName");
    const weightKg = num("dpWeight");
    // 시작 게이트와 같은 규칙 — 이름과 몸무게는 파일명에 들어간다.
    if (!name || weightKg == null) {
      this.errorEl.textContent = t("qi_need_name_weight");
      return;
    }

    const saveBtn = document.getElementById("dogPresetSave") as HTMLButtonElement | null;
    if (saveBtn) saveBtn.disabled = true;
    try {
      await createDogPreset(this.apiBase, {
        name,
        weightKg,
        heightCm: num("dpHeight"),
        breed: value("dpBreed") || null,
      });
      this.closeModal();
      await this.refresh();
    } catch (err) {
      this.errorEl.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  private async remove(preset: DogPreset): Promise<void> {
    if (!window.confirm(t("qi_delete_confirm", { name: preset.name }))) return;
    try {
      await deleteDogPreset(this.apiBase, preset.id);
      await this.refresh();
    } catch {
      // 실패해도 목록은 그대로 둔다 — 다음 새로고침에서 실제 상태가 드러난다.
    }
  }

  private render(): void {
    this.listEl.textContent = "";
    this.emptyEl.textContent = t("qi_empty");
    this.emptyEl.hidden = this.presets.length > 0;

    for (const preset of this.presets) {
      const card = document.createElement("div");
      card.className = "dp-card";

      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "dp-pick";
      pick.addEventListener("click", () => this.opts.onPick(preset));

      const name = document.createElement("span");
      name.className = "dp-name";
      name.textContent = preset.name;

      const meta = document.createElement("span");
      meta.className = "dp-meta";
      // 같은 이름이 여럿일 수 있으므로 몸무게까지 보여 줘야 고를 수 있다.
      meta.textContent = [
        `${preset.weightKg}kg`,
        preset.heightCm != null ? `${preset.heightCm}cm` : null,
        preset.breed,
      ]
        .filter(Boolean)
        .join(" · ");

      pick.append(name, meta);

      const del = document.createElement("button");
      del.type = "button";
      del.className = "dp-del";
      del.title = t("qi_delete");
      del.textContent = "✕";
      del.addEventListener("click", () => void this.remove(preset));

      card.append(pick, del);
      this.listEl.appendChild(card);
    }
  }
}
