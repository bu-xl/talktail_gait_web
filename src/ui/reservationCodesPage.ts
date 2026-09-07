/**
 * 예약 코드 설정 — **마스터 전용 화면.**
 *
 * 신청 폼(`reserve.html`)은 로그인 없이 열린다. 그대로 두면 누구나 무한히 제출할
 * 수 있으므로, 현장에서 눈으로 확인해야 아는 코드를 하나 통과시킨다.
 *
 * 코드는 서너 개뿐이라 **목록을 통째로 저장**한다. 행마다 저장 버튼을 두면 어디를
 * 고쳤는지 놓치기 쉽고, 개별 API 도 세 개로 늘어난다.
 *
 * 코드를 지우지 않고 끄는 쪽이 기본이다 — 지우면 이미 그 코드로 들어온 예약의
 * 유입 경로만 남고 코드 자체는 사라진다.
 */

import {
  listReservationCodes,
  saveReservationCodes,
  type ReservationCode,
} from "../api/reservationsApi.js";
import { showToast } from "./toast.js";

/** 서버와 같은 규칙. 여기서 막는 것은 편의고, 정본은 서버다. */
const CODE_RE = /^[A-Z0-9]{4,32}$/;

export class ReservationCodesPage {
  private apiBase = "";
  private rows: ReservationCode[] = [];
  private loading = false;

  constructor(private readonly root: HTMLElement) {}

  setApiBase(apiBase: string): void {
    this.apiBase = apiBase;
  }

  show(): void {
    this.root.hidden = false;
    void this.reload();
  }

  hide(): void {
    this.root.hidden = true;
  }

  private async reload(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.render("불러오는 중…");
    try {
      this.rows = await listReservationCodes(this.apiBase);
      this.render(null);
    } catch (err) {
      this.rows = [];
      this.render(err instanceof Error ? err.message : String(err));
    } finally {
      this.loading = false;
    }
  }

  private async save(): Promise<void> {
    for (const row of this.rows) {
      if (!CODE_RE.test(row.code)) {
        showToast({
          kind: "bad",
          title: "코드 형식이 올바르지 않습니다",
          message: "영문 대문자와 숫자 4~32자로 입력하세요.",
        });
        return;
      }
    }
    try {
      this.rows = await saveReservationCodes(this.apiBase, this.rows);
      showToast({ kind: "ok", title: "코드를 저장했습니다" });
      this.render(null);
    } catch (err) {
      showToast({
        kind: "bad",
        title: "저장 실패",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── 그리기 ────────────────────────────────────────────────────────────

  private render(status: string | null): void {
    this.root.textContent = "";
    this.root.append(this.head(), this.body(status));
  }

  private head(): HTMLElement {
    const head = document.createElement("div");
    head.className = "rp-toolbar";

    const text = document.createElement("div");
    text.className = "rp-toolbar-text";
    const title = document.createElement("h1");
    title.textContent = "예약 코드";
    const sub = document.createElement("p");
    sub.textContent =
      "체험 신청 폼에서 요구하는 확인 코드입니다. 테스트 기간이 끝나면 전부 꺼서 신청을 닫습니다.";
    text.append(title, sub);

    const actions = document.createElement("div");
    actions.className = "rp-toolbar-actions";

    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "＋ 코드 추가";
    add.addEventListener("click", () => {
      this.rows = [...this.rows, { code: "", label: null, active: true }];
      this.render(null);
    });

    const save = document.createElement("button");
    save.type = "button";
    save.className = "primary";
    save.textContent = "저장";
    save.addEventListener("click", () => void this.save());

    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.textContent = "새로고침";
    refresh.disabled = this.loading;
    refresh.addEventListener("click", () => void this.reload());

    actions.append(add, refresh, save);
    head.append(text, actions);
    return head;
  }

  private body(status: string | null): HTMLElement {
    const scroll = document.createElement("div");
    scroll.className = "acc-scroll";

    if (status) {
      const p = document.createElement("p");
      p.className = "acc-empty";
      p.textContent = status;
      scroll.append(p);
      return scroll;
    }

    const link = document.createElement("p");
    link.className = "rc-link";
    // QR 로 만들 주소를 화면에서 바로 집어갈 수 있어야 한다.
    link.textContent = `신청 폼 주소: ${new URL("./reserve.html", window.location.href).href}`;
    scroll.append(link);

    if (!this.rows.length) {
      const empty = document.createElement("p");
      empty.className = "acc-empty";
      empty.textContent = "코드가 없습니다. 코드를 추가하면 신청 폼이 열립니다.";
      scroll.append(empty);
      return scroll;
    }

    const table = document.createElement("table");
    table.className = "acc-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["코드", "설명", "사용", ""]) {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.append(th);
    }
    thead.append(headRow);
    table.append(thead);

    const tbody = document.createElement("tbody");
    this.rows.forEach((row, index) => tbody.append(this.row(row, index)));
    table.append(tbody);
    scroll.append(table);
    return scroll;
  }

  private row(row: ReservationCode, index: number): HTMLElement {
    const tr = document.createElement("tr");

    const codeTd = document.createElement("td");
    const code = document.createElement("input");
    code.type = "text";
    code.className = "rc-input rc-code";
    code.value = row.code;
    code.maxLength = 32;
    code.placeholder = "GAIT01";
    // 대문자로 맞춰 둔다 — 서버도 대문자로 비교하므로 화면과 저장이 어긋나지 않는다.
    code.addEventListener("input", () => {
      code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
      row.code = code.value;
    });
    codeTd.append(code);
    tr.append(codeTd);

    const labelTd = document.createElement("td");
    const label = document.createElement("input");
    label.type = "text";
    label.className = "rc-input";
    label.value = row.label || "";
    label.maxLength = 60;
    label.placeholder = "예: A존 / 부산 행사";
    label.addEventListener("input", () => {
      row.label = label.value.trim() || null;
    });
    labelTd.append(label);
    tr.append(labelTd);

    const activeTd = document.createElement("td");
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = row.active ? "acc-tester is-on" : "acc-tester";
    toggle.textContent = row.active ? "사용" : "중지";
    toggle.addEventListener("click", () => {
      row.active = !row.active;
      toggle.className = row.active ? "acc-tester is-on" : "acc-tester";
      toggle.textContent = row.active ? "사용" : "중지";
    });
    activeTd.append(toggle);
    tr.append(activeTd);

    const actions = document.createElement("td");
    actions.className = "acc-actions";
    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = "삭제";
    del.addEventListener("click", () => {
      // 지우는 대신 "중지" 로 두는 쪽을 권한다 — 목록에서 빼면 코드 자체가 사라진다.
      if (!window.confirm(`${row.code || "빈 코드"} 를 목록에서 지울까요? 저장해야 반영됩니다.`)) {
        return;
      }
      this.rows = this.rows.filter((_, i) => i !== index);
      this.render(null);
    });
    actions.append(del);
    tr.append(actions);

    return tr;
  }
}
