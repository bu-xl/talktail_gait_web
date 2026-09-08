/**
 * 태스크 목록 — 삼선 메뉴의 "태스크 목록" (§3-7).
 *
 * **목적은 통계·확인이다.** 계정별로 몇 월 며칠에 몇 건을 찍었는지, CSV 가 붙었는지,
 * 영상이 몇 대분인지를 한눈에 본다. §1-2 의 "같은 개의 재측정인지 다른 개인지" 를
 * 사람이 확인하는 자리이기도 하다.
 *
 * 목록 출처는 **DB**(`gait_sessions` + `dogs`)다. 디스크를 스캔하지도, 파일명을 파싱하지도
 * 않는다 — "파일 다운/삭제" 화면(용량 확보가 목적)과 그 점이 다르다.
 *
 * ## 회차 통삭제 (§3-6)
 *
 * 여기서만 원본·산출물·DB 행을 한 번에 지운다. **되돌릴 수 없고 분석 결과까지 날아간다.**
 * 체크박스 다중 선택 화면이라 사고 위험이 커서, 확인 문구에 회차 수와 개 이름을 넣고
 * 되돌릴 수 없음을 못박는다.
 */

import { deleteTasks, listTasks, type TaskRow } from "../api/tasksApi.js";
import { showToast } from "./toast.js";

export class TaskListPage {
  private apiBase = "";
  private rows: TaskRow[] = [];
  private selected = new Set<string>();
  private dogFilter: number | null = null;
  private busy = false;

  private readonly listEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly fromEl: HTMLInputElement;
  private readonly toEl: HTMLInputElement;
  private readonly deleteBtn: HTMLButtonElement;

  constructor(private readonly root: HTMLElement) {
    this.listEl = root.querySelector("#taskListRows") as HTMLElement;
    this.statusEl = root.querySelector("#taskListStatus") as HTMLElement;
    this.fromEl = root.querySelector("#taskListFrom") as HTMLInputElement;
    this.toEl = root.querySelector("#taskListTo") as HTMLInputElement;
    this.deleteBtn = root.querySelector("#taskListDelete") as HTMLButtonElement;

    this.deleteBtn.addEventListener("click", () => void this.removeSelected());
    root.querySelector("#taskListReload")?.addEventListener("click", () => void this.reload());
    root.querySelector("#taskListClearFilter")?.addEventListener("click", () => {
      this.dogFilter = null;
      this.fromEl.value = "";
      this.toEl.value = "";
      void this.reload();
    });
    for (const el of [this.fromEl, this.toEl]) {
      el.addEventListener("change", () => void this.reload());
    }
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

  /** 개 정보 변경에서 "촬영 기록을 먼저 지우세요" 로 넘어온 경우 그 개만 보여 준다. */
  async showForDog(dogId: number): Promise<void> {
    this.dogFilter = dogId;
    this.root.hidden = false;
    await this.reload();
  }

  /** `2026-09-08` → `260908`. 도장 앞 6자리와 같은 형식으로 맞춘다. */
  private static toStampDate(value: string): string | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    return m ? `${m[1].slice(2)}${m[2]}${m[3]}` : null;
  }

  private async reload(): Promise<void> {
    if (!this.apiBase) return;
    this.statusEl.textContent = "불러오는 중…";
    this.selected.clear();
    try {
      this.rows = await listTasks(this.apiBase, {
        from: TaskListPage.toStampDate(this.fromEl.value),
        to: TaskListPage.toStampDate(this.toEl.value),
        dogId: this.dogFilter,
      });
    } catch (err) {
      this.rows = [];
      this.statusEl.textContent = err instanceof Error ? err.message : String(err);
      this.render();
      return;
    }
    this.render();
  }

  private summary(): string {
    const days = new Set(this.rows.map((r) => r.date)).size;
    const withCsv = this.rows.filter((r) => r.hasCsv).length;
    const analyzed = this.rows.filter((r) => r.analyzed).length;
    const filter = this.dogFilter != null ? ` · 반려견 #${this.dogFilter}` : "";
    return (
      `태스크 ${this.rows.length}건 · ${days}일 · CSV ${withCsv}건 · 분석 ${analyzed}건${filter}`
    );
  }

  private render(): void {
    this.statusEl.textContent = this.summary();
    this.listEl.textContent = "";
    this.deleteBtn.disabled = true;

    for (const row of this.rows) {
      const line = document.createElement("div");
      line.className = "tl-row";
      if (row.discardedAt) line.classList.add("is-discarded");

      const check = document.createElement("input");
      check.type = "checkbox";
      check.addEventListener("change", () => {
        if (check.checked) this.selected.add(row.id);
        else this.selected.delete(row.id);
        this.deleteBtn.disabled = this.selected.size === 0 || this.busy;
        this.deleteBtn.textContent = this.selected.size
          ? `선택한 ${this.selected.size}건 통삭제`
          : "통삭제";
      });

      const when = document.createElement("span");
      when.className = "tl-when";
      when.textContent = `${row.displayDate} ${row.displayTime}`;

      const dog = document.createElement("span");
      dog.className = "tl-dog";
      // 개 이름은 `dogs` 조인에서 온다 — 파일명에는 없다. id 를 함께 적어 같은 이름을 가른다.
      dog.textContent = row.dog.id != null
        ? `#${row.dog.id} ${row.dog.name ?? "(이름 없음)"}${row.dog.weightKg != null ? ` · ${row.dog.weightKg}kg` : ""}`
        : "(개체 없음)";

      const marks = document.createElement("span");
      marks.className = "tl-marks";
      marks.textContent = [
        row.hasCsv ? "CSV" : "CSV 없음",
        `영상 ${row.videoCount}`,
        row.analyzed ? "분석됨" : "미분석",
        row.discardedAt ? "버림" : null,
      ]
        .filter(Boolean)
        .join(" · ");

      const task = document.createElement("span");
      task.className = "tl-task";
      task.textContent = row.taskName;

      line.append(check, when, dog, marks, task);
      this.listEl.appendChild(line);
    }
  }

  private async removeSelected(): Promise<void> {
    if (this.busy || this.selected.size === 0) return;
    const picked = this.rows.filter((r) => this.selected.has(r.id));
    const names = [...new Set(picked.map((r) => r.dog.name ?? `#${r.dog.id}`))].join(", ");
    // ★ 확인 문구에 **회차 수와 개 이름**을 넣고 되돌릴 수 없음을 못박는다(§3-7).
    const ok = window.confirm(
      `${picked.length}건을 삭제합니다 (${names}).\n\n` +
        "원본 영상·CSV, 분석 산출물, 기록이 모두 지워집니다.\n" +
        "되돌릴 수 없습니다. 계속할까요?",
    );
    if (!ok) return;

    this.busy = true;
    this.deleteBtn.disabled = true;
    try {
      const res = await deleteTasks(this.apiBase, [...this.selected]);
      // ai-server 삭제가 실패해도 back 쪽은 이미 지워졌다. 조용히 넘기면 산출물만 남는다.
      if (res.aiErrors.length) {
        showToast({
          kind: "warn",
          title: "산출물 일부가 남았습니다",
          message: res.aiErrors.slice(0, 3).join(" / "),
          durationMs: 12000,
        });
      } else {
        showToast({ kind: "ok", title: `${res.deleted}건을 삭제했습니다`, message: "" });
      }
      await this.reload();
    } catch (err) {
      showToast({
        kind: "bad",
        title: "삭제 실패",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.busy = false;
    }
  }
}
