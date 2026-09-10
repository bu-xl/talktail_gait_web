/**
 * 빠른 입력 등록 — 측정할 **개체를 고른다**.
 *
 * 예전에는 이름·몸무게 입력란을 채워 주는 편의 장치였다. 지금은 촬영이 `dogs` 행을
 * 참조하므로(§3-3) 여기서 고른 개체가 곧 그 회차의 주인이고, 측정 화면에는 손으로 치는
 * 반려견 입력란이 아예 없다.
 *
 * 이 모듈은 개체 카드 목록과 등록 모달만 담당한다. 고른 개체를 어디에 쓸지는 측정 화면이
 * 정하므로 `onPick` 으로 넘긴다.
 */

import {
  createDog,
  deleteDog,
  listDogs,
  type Dog,
} from "../api/dogsApi.js";
import { t } from "../i18n/index.js";

const COLLAPSE_KEY = "gait.quickCollapsed";

export interface DogPresetsCardOptions {
  /** 카드를 눌렀을 때 — 이 개체로 측정을 시작한다. */
  onPick(dog: Dog): void;
}

/**
 * 같은 정보의 개체가 이미 있을 때 되묻는다 (§3-2-A).
 *
 * **막지 않는다.** 같은 날 이름도 몸무게도 같은 *다른 개*가 오는 것이 이 재설계의
 * 출발점이라, 유니크를 걸면 그 개를 등록조차 못 한다. 사람에게 후보를 보여 주고
 * 그대로 등록할지만 묻는다.
 */
function askDuplicate(matches: Dog[]): Promise<boolean> {
  const modal = document.getElementById("dogDupModal");
  const list = document.getElementById("dogDupList");
  const ok = document.getElementById("dogDupConfirm") as HTMLButtonElement | null;
  const cancel = document.getElementById("dogDupCancel") as HTMLButtonElement | null;
  // 모달이 없는 화면에서는 그냥 등록한다 — 등록을 막는 것보다 낫다.
  if (!modal || !list || !ok || !cancel) return Promise.resolve(true);

  list.textContent = "";
  for (const dog of matches) {
    const li = document.createElement("li");
    const id = document.createElement("span");
    id.className = "dup-id";
    id.textContent = `#${dog.id}`;
    const label = document.createElement("span");
    label.textContent =
      `${dog.name} · ${dog.weightKg}kg` +
      (dog.breed ? ` · ${dog.breed}` : "") +
      (dog.createdAt ? ` · ${dog.createdAt.slice(0, 10)} 등록` : "") +
      (dog.sessionCount ? ` · 촬영 ${dog.sessionCount}건` : "");
    li.append(id, label);
    list.appendChild(li);
  }

  modal.classList.add("open");
  document.body.classList.add("modal-open");

  return new Promise<boolean>((resolve) => {
    const close = (answer: boolean): void => {
      modal.classList.remove("open");
      document.body.classList.remove("modal-open");
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      window.removeEventListener("keydown", onKey);
      resolve(answer);
    };
    const onOk = (): void => close(true);
    const onCancel = (): void => close(false);
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") close(false);
    };
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    window.addEventListener("keydown", onKey);
  });
}

export class DogPresetsCard {
  private apiBase = "";
  private presets: Dog[] = [];
  /** 지금 측정 대상으로 고른 개체. 목록이 길면 위의 한 줄만으로는 어느 개인지 못 찾는다. */
  private selectedId: number | null = null;

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

  /** 측정 화면이 고른 개체를 알려 준다 — 그 카드를 눌린 상태로 그린다. */
  setSelected(id: number | null): void {
    this.selectedId = id;
    this.render();
  }

  async refresh(): Promise<void> {
    if (!this.apiBase) return;
    try {
      this.presets = await listDogs(this.apiBase);
    } catch {
      // 목록을 못 읽으면 고를 개체가 없다. 측정은 등록된 개체로만 시작하므로(§3-3)
      // 비워 두는 것이 곧 "시작할 수 없음" 이고, 그 상태가 화면에 그대로 보인다.
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

  /** 접기 — 예약 현황과 같은 동작. 둘 다 펼쳐져 있으면 시작 버튼이 화면 밖으로 밀린다. */
  private setCollapsed(collapsed: boolean): void {
    const card = document.querySelector(".mc-quick");
    card?.classList.toggle("is-collapsed", collapsed);
    const toggle = document.getElementById("qiFold");
    if (toggle) {
      toggle.textContent = collapsed ? "▸" : "▾";
      toggle.setAttribute("aria-expanded", String(!collapsed));
    }
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch {
      /* 저장이 막힌 환경 — 이번 세션에서만 유지된다 */
    }
  }

  private bind(): void {
    let collapsed = false;
    try {
      collapsed = localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      /* 읽기가 막힌 환경 — 펼친 상태로 시작한다 */
    }
    this.setCollapsed(collapsed);
    document.getElementById("qiFold")?.addEventListener("click", () => {
      const card = document.querySelector(".mc-quick");
      this.setCollapsed(!card?.classList.contains("is-collapsed"));
    });
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

    const select = (id: string): string =>
      (document.getElementById(id) as HTMLSelectElement | null)?.value ?? "";
    const name = value("dpName");
    const weightKg = num("dpWeight");
    const breed = value("dpBreed");
    const neutered = select("dpNeutered");
    // 등록 필수값 — 이 셋이 없으면 개체를 만들지 않는다.
    if (!name || weightKg == null || !breed) {
      this.errorEl.textContent = t("qi_need_name_weight");
      return;
    }

    // ★ 등록 **전에** 묻는다. 만들고 나서 알리면 취소할 방법이 없다 —
    //   목록을 이미 들고 있으므로 서버에 한 번 더 물어볼 이유도 없다.
    // 견종까지 같아야 중복 후보다 — 이름·몸무게가 같아도 견종이 다르면 다른 개다.
    const matches = this.presets.filter(
      (d) => d.name === name && Number(d.weightKg) === weightKg && d.breed === breed,
    );
    if (matches.length && !(await askDuplicate(matches))) return;

    const saveBtn = document.getElementById("dogPresetSave") as HTMLButtonElement | null;
    if (saveBtn) saveBtn.disabled = true;
    try {
      await createDog(this.apiBase, {
        name,
        weightKg,
        heightCm: num("dpHeight"),
        breed,
        birthMonth: value("dpBirthMonth") || null,
        // 미입력과 "안 했음" 은 다르다 — 빈 값은 null 로 남긴다.
        sex: (select("dpSex") || null) as "male" | "female" | null,
        neutered: neutered === "" ? null : neutered === "1",
      });
      this.closeModal();
      await this.refresh();
    } catch (err) {
      this.errorEl.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  private async remove(dog: Dog): Promise<void> {
    if (!window.confirm(t("qi_delete_confirm", { name: dog.name }))) return;
    try {
      await deleteDog(this.apiBase, dog.id);
      await this.refresh();
    } catch (err) {
      // 촬영이 있으면 409 다(§3-5). 사유를 그대로 보여 준다 — 어디서 지워야 하는지가
      // 그 문장에 들어 있다("촬영 기록 12건을 먼저 삭제하세요").
      window.alert(err instanceof Error ? err.message : String(err));
    }
  }

  private render(): void {
    this.listEl.textContent = "";
    this.emptyEl.textContent = t("qi_empty");
    this.emptyEl.hidden = this.presets.length > 0;

    for (const preset of this.presets) {
      const card = document.createElement("div");
      card.className = "dp-card";
      if (preset.id === this.selectedId) card.classList.add("is-selected");

      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "dp-pick";
      pick.addEventListener("click", () => this.opts.onPick(preset));

      const name = document.createElement("span");
      name.className = "dp-name";
      name.textContent = preset.name;

      const meta = document.createElement("span");
      meta.className = "dp-meta";
      // 카드에는 **id 와 이름만**. 몸무게·견종·나이까지 한 줄에 이어 붙이면 읽을 수가
      // 없고, 카드의 일은 고르는 것뿐이다. 고른 뒤 상세는 아래 "선택한 반려견" 줄이 낸다.
      meta.textContent = `#${preset.id}`;

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
