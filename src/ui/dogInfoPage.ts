/**
 * 개 정보 변경 — 삼선 메뉴의 "정보 변경" (§3-18).
 *
 * **이번 재설계의 주된 이유 중 하나다.** 예전에는 개 이름·몸무게가 파일명에 박혀 있어서,
 * 오타 하나를 고치려면 디스크의 파일을 전부 rename 해야 했다(§1-3). 지금 파일명에는
 * `<도장>-<dogId>` 만 들어가므로 **이름을 바꿔도 기존 파일이 전부 그대로 조회된다.**
 *
 * ## 몸무게만 읽기 전용이다
 *
 * 몸무게가 다르면 다른 개체로 센다(§3-2-A). 고치는 순간 그 dogID 의 정체가 바뀌고 과거
 * 회차의 개체 정의가 소급해서 달라진다. 살이 쪘으면 **새로 등록**한다.
 *
 * ## 삭제는 여기서, 촬영이 있으면 막힌다
 *
 * 촬영 기록이 있으면 서버가 409 를 준다(§3-5). 막고 끝내지 않고 **태스크 목록으로 갈
 * 버튼**을 함께 준다 — 어디서 지워야 하는지 사람이 찾아 헤매지 않게.
 */

import {
  deleteDog,
  listDogs,
  updateDog,
  type Dog,
  type DogPatch,
} from "../api/dogsApi.js";
import { ageLabel, sexLabel } from "../api/reservationsApi.js";
import { checkDogNameForFilename } from "../core/sessionNaming.js";
import { showToast } from "./toast.js";

export interface DogInfoPageOptions {
  /** 정보가 바뀌었을 때 — 측정 화면의 개체 카드·선택 표시를 다시 그린다. */
  onChanged(): void;
  /** 촬영이 있어 못 지울 때 태스크 목록으로 보낸다. */
  onGotoTasks(dogId: number): void;
}

export class DogInfoPage {
  private apiBase = "";
  private dogs: Dog[] = [];
  private editingId: number | null = null;

  private readonly listEl: HTMLElement;
  private readonly statusEl: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly opts: DogInfoPageOptions,
  ) {
    this.listEl = root.querySelector("#dogInfoList") as HTMLElement;
    this.statusEl = root.querySelector("#dogInfoStatus") as HTMLElement;
  }

  setApiBase(base: string): void {
    this.apiBase = base.replace(/\/$/, "");
  }

  show(): void {
    this.root.hidden = false;
    void this.reload();
  }

  hide(): void {
    this.root.hidden = true;
  }

  private async reload(): Promise<void> {
    if (!this.apiBase) return;
    this.statusEl.textContent = "불러오는 중…";
    try {
      this.dogs = await listDogs(this.apiBase);
      this.statusEl.textContent = `등록된 반려견 ${this.dogs.length}마리`;
    } catch (err) {
      this.dogs = [];
      this.statusEl.textContent = err instanceof Error ? err.message : String(err);
    }
    this.render();
  }

  private render(): void {
    this.listEl.textContent = "";
    for (const dog of this.dogs) {
      this.listEl.appendChild(
        this.editingId === dog.id ? this.renderForm(dog) : this.renderRow(dog),
      );
    }
  }

  private renderRow(dog: Dog): HTMLElement {
    const row = document.createElement("div");
    row.className = "di-row";

    const head = document.createElement("div");
    head.className = "di-head";
    // id 를 먼저 보여 준다 — 이름·몸무게가 같아도 갈리는 것은 결국 id 다.
    head.textContent = `#${dog.id}  ${dog.name}`;

    const meta = document.createElement("div");
    meta.className = "di-meta";
    meta.textContent = [
      `${dog.weightKg}kg`,
      dog.heightCm != null ? `${dog.heightCm}cm` : null,
      dog.breed,
      ageLabel(dog.birthMonth),
      sexLabel(dog.sex, dog.neutered),
      dog.sessionCount ? `촬영 ${dog.sessionCount}건` : "촬영 없음",
    ]
      .filter(Boolean)
      .join(" · ");

    // 파일명에 못 쓰는 이름은 **여기서 막지 않고 표시만** 한다(§3-9-A) — 다운로드할 때
    // 모달이 다시 알린다. 고객 신청서에 뭐가 적힐지 통제할 수 없으므로 입력을 막지 않는다.
    const nameCheck = checkDogNameForFilename(dog.name);
    if (!nameCheck.ok) {
      const warn = document.createElement("div");
      warn.className = "di-warn";
      warn.textContent = "⚠ 이 이름은 파일명으로 쓸 수 없습니다 — 내려받을 때 경고가 뜹니다";
      row.appendChild(warn);
    }

    const actions = document.createElement("div");
    actions.className = "di-actions";

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "btn";
    edit.textContent = "수정";
    edit.addEventListener("click", () => {
      this.editingId = dog.id;
      this.render();
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn danger";
    del.textContent = "삭제";
    del.addEventListener("click", () => void this.remove(dog));

    actions.append(edit, del);
    row.prepend(head, meta);
    row.appendChild(actions);
    return row;
  }

  private renderForm(dog: Dog): HTMLElement {
    const form = document.createElement("form");
    form.className = "di-form";

    const field = (label: string, el: HTMLElement): HTMLElement => {
      const wrap = document.createElement("label");
      wrap.className = "di-field";
      const span = document.createElement("span");
      span.textContent = label;
      wrap.append(span, el);
      return wrap;
    };

    const name = document.createElement("input");
    name.type = "text";
    name.value = dog.name;
    name.required = true;

    const breed = document.createElement("input");
    breed.type = "text";
    breed.value = dog.breed ?? "";

    const birth = document.createElement("input");
    birth.type = "month";
    birth.value = dog.birthMonth ?? "";

    const height = document.createElement("input");
    height.type = "number";
    height.step = "0.1";
    height.min = "0";
    height.value = dog.heightCm == null ? "" : String(dog.heightCm);

    const sex = document.createElement("select");
    for (const [v, label] of [["", "미입력"], ["male", "수컷"], ["female", "암컷"]]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = label;
      sex.appendChild(o);
    }
    sex.value = dog.sex ?? "";

    const neutered = document.createElement("select");
    for (const [v, label] of [["", "미입력"], ["1", "했음"], ["0", "안 함"]]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = label;
      neutered.appendChild(o);
    }
    neutered.value = dog.neutered == null ? "" : dog.neutered ? "1" : "0";

    // ★ 몸무게는 **읽기 전용**이다. 고치면 개체의 정체가 바뀐다(§3-2-A).
    const weight = document.createElement("input");
    weight.type = "text";
    weight.value = `${dog.weightKg}kg`;
    weight.readOnly = true;
    weight.className = "is-readonly";

    const weightHint = document.createElement("div");
    weightHint.className = "di-hint";
    weightHint.textContent =
      "몸무게는 바꿀 수 없습니다 — 몸무게가 다르면 다른 개체입니다. 살이 쪘으면 새로 등록하세요.";

    const actions = document.createElement("div");
    actions.className = "di-actions";
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "btn primary";
    save.textContent = "저장";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn";
    cancel.textContent = "취소";
    cancel.addEventListener("click", () => {
      this.editingId = null;
      this.render();
    });
    actions.append(save, cancel);

    form.append(
      field("이름", name),
      field("몸무게", weight),
      weightHint,
      field("견종", breed),
      field("생년월", birth),
      field("신장(cm)", height),
      field("성별", sex),
      field("중성화", neutered),
      actions,
    );

    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const patch: DogPatch = {
        name: name.value.trim(),
        breed: breed.value.trim() || null,
        birthMonth: birth.value || null,
        heightCm: height.value ? Number(height.value) : null,
        sex: (sex.value || null) as "male" | "female" | null,
        neutered: neutered.value === "" ? null : neutered.value === "1",
      };
      void this.save(dog, patch);
    });
    return form;
  }

  private async save(dog: Dog, patch: DogPatch): Promise<void> {
    if (!patch.name) {
      showToast({ kind: "bad", title: "이름이 필요합니다", message: "" });
      return;
    }
    // ★ 이름을 바꾸면 **과거 촬영의 표시가 함께 바뀐다.** 오타 수정과 개체 교체가 같은
    //   버튼이라 막지는 않되, 몇 건이 영향을 받는지는 반드시 알린다(§3-18).
    if (patch.name !== dog.name && (dog.sessionCount ?? 0) > 0) {
      const ok = window.confirm(
        `이 반려견의 과거 촬영 ${dog.sessionCount}건의 표시가 함께 바뀝니다.\n계속할까요?`,
      );
      if (!ok) return;
    }
    try {
      await updateDog(this.apiBase, dog.id, patch);
      this.editingId = null;
      await this.reload();
      this.opts.onChanged();
      showToast({ kind: "ok", title: "저장했습니다", message: "" });
    } catch (err) {
      showToast({
        kind: "bad",
        title: "저장 실패",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async remove(dog: Dog): Promise<void> {
    if (!window.confirm(`#${dog.id} ${dog.name} 을(를) 삭제할까요?`)) return;
    try {
      await deleteDog(this.apiBase, dog.id);
      await this.reload();
      this.opts.onChanged();
    } catch (err) {
      const status = (err as Error & { status?: number }).status;
      const message = err instanceof Error ? err.message : String(err);
      if (status === 409) {
        // 막고 끝내지 않는다 — 지워야 할 곳으로 보낸다(§3-5).
        if (window.confirm(`${message}\n\n태스크 목록으로 이동할까요?`)) {
          this.opts.onGotoTasks(dog.id);
        }
        return;
      }
      showToast({ kind: "bad", title: "삭제 실패", message });
    }
  }
}
