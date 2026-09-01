/**
 * 계정 관리 — **마스터 전용 화면.**
 *
 * 마스터는 촬영을 하지 않는다. 대신 이 화면에서 가입 신청을 승인·거절하고,
 * 계정을 정지·복구하고, 계정별 용량을 본다.
 *
 * ## 상태 3개로 4가지 동작을 낸다
 *
 *     요청 → 승인   승인
 *     요청 → 정지   거절
 *     승인 → 정지   정지
 *     정지 → 승인   복구
 *
 * "거절" 을 별도 상태로 두지 않았다 — 하는 일이 "쓸 수 없게 한다" 로 같아서
 * 상태만 하나 늘고 화면이 복잡해진다.
 *
 * ## 용량은 이 화면에 들어올 때만 잰다
 *
 * 폴더가 계정별로 갈려 있어(`uploads/<userId>/` 등) 폴더 크기 몇 번이면 끝난다.
 * 그래서 DB 에 크기 컬럼을 새로 두지 않았다. 대신 계정 수만큼 요청이 나가므로
 * **자동 갱신은 하지 않는다** — 새로고침 버튼으로만 다시 잰다.
 */

import {
  listUsers,
  setUserStatus,
  resetUserPassword,
  type AccountStatus,
  type AuthUser,
} from "../api/authApi.js";
import { getStorageUsage } from "../api/storageApi.js";
import { formatSize } from "./filesPage.js";
import { showToast } from "./toast.js";

const STATUS_LABEL: Record<AccountStatus, string> = {
  pending: "요청",
  active: "승인",
  blocked: "정지",
};

/** 상태별로 보여 줄 동작. 전이가 화면에 그대로 드러나게 한다. */
const ACTIONS: Record<AccountStatus, { label: string; next: AccountStatus; danger?: boolean }[]> = {
  pending: [
    { label: "승인", next: "active" },
    { label: "거절", next: "blocked", danger: true },
  ],
  active: [{ label: "정지", next: "blocked", danger: true }],
  blocked: [{ label: "복구", next: "active" }],
};

type Row = AuthUser & { bytes?: number | null };

export class AccountsPage {
  private readonly root: HTMLElement;
  private apiBase = "";
  private rows: Row[] = [];
  private loading = false;

  constructor(root: HTMLElement) {
    this.root = root;
  }

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
      const users = await listUsers(this.apiBase);
      // 용량은 계정마다 한 번씩 — 계정 수가 수십 규모라 직렬로도 충분하다.
      const rows: Row[] = [];
      for (const u of users) {
        let bytes: number | null = null;
        try {
          const usage = await getStorageUsage(this.apiBase, u.id);
          bytes = (usage.folders || []).reduce((sum, f) => sum + (f.bytes || 0), 0);
        } catch {
          bytes = null; // 용량을 못 재도 계정 목록은 보여 준다
        }
        rows.push({ ...u, bytes });
      }
      this.rows = rows;
      this.render(null);
    } finally {
      this.loading = false;
    }
  }

  private async apply(id: string, next: AccountStatus): Promise<void> {
    const res = await setUserStatus(this.apiBase, id, next);
    if (!res.ok) {
      showToast({ kind: "bad", title: "변경 실패", message: res.error.message });
      return;
    }
    showToast({ kind: "ok", title: `${id} → ${STATUS_LABEL[next]}` });
    await this.reload();
  }

  private async resetPw(id: string): Promise<void> {
    // 사용자가 비번을 잊었을 때의 유일한 경로다. 확인 절차를 굳이 두 번 두지 않는다 —
    // 되돌릴 수 없는 삭제와 달리 다시 바꾸면 그만이다.
    const pw = window.prompt(`${id} 의 새 비밀번호를 입력하세요.`);
    if (!pw) return;
    const res = await resetUserPassword(this.apiBase, id, pw);
    if (res.ok) {
      showToast({ kind: "ok", title: "비밀번호를 변경했습니다", message: `${id} 의 기존 로그인은 모두 해제됩니다.` });
    } else {
      showToast({ kind: "bad", title: "변경 실패", message: res.error.message });
    }
  }

  private render(status: string | null): void {
    this.root.textContent = "";
    this.root.append(this.head(), this.body(status));
  }

  /** 다른 화면과 같은 헤더 껍데기 — 제목·설명·새로고침. */
  private head(): HTMLElement {
    const head = document.createElement("div");
    head.className = "rp-toolbar";

    const text = document.createElement("div");
    text.className = "rp-toolbar-text";
    const title = document.createElement("h1");
    title.textContent = "계정 관리";
    const sub = document.createElement("p");
    sub.textContent = "가입 신청을 승인·거절하고, 계정을 정지·복구하고, 계정별 사용 용량을 봅니다.";
    text.append(title, sub);

    const actions = document.createElement("div");
    actions.className = "rp-toolbar-actions";
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.textContent = "새로고침";
    refresh.disabled = this.loading;
    refresh.addEventListener("click", () => void this.reload());
    actions.append(refresh);

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

    scroll.append(this.cards(), this.table());
    return scroll;
  }

  /** 상태별 계정 수 + 총 용량. 화면에 들어오자마자 "할 일이 있나" 를 답한다. */
  private cards(): HTMLElement {
    const count = (s: AccountStatus): number => this.rows.filter((r) => r.status === s).length;
    const totalBytes = this.rows.reduce((sum, r) => sum + (r.bytes || 0), 0);
    const pending = count("pending");

    const wrap = document.createElement("div");
    wrap.className = "acc-cards";
    const cards: [string, string, string][] = [
      ["승인 대기", String(pending), "acc-card-pending" + (pending ? " is-on" : "")],
      ["사용 중", String(count("active")), ""],
      ["정지", String(count("blocked")), ""],
      ["전체 계정", String(this.rows.length), ""],
      ["총 사용 용량", formatSize(totalBytes), ""],
    ];
    for (const [label, value, cls] of cards) {
      const card = document.createElement("div");
      card.className = `acc-card ${cls}`.trim();
      const l = document.createElement("div");
      l.className = "acc-card-label";
      l.textContent = label;
      const v = document.createElement("div");
      v.className = "acc-card-value";
      v.textContent = value;
      card.append(l, v);
      wrap.append(card);
    }
    return wrap;
  }

  private table(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "acc-table-wrap";

    if (!this.rows.length) {
      const empty = document.createElement("p");
      empty.className = "acc-empty";
      empty.textContent = "계정이 없습니다.";
      wrap.append(empty);
      return wrap;
    }

    const table = document.createElement("table");
    table.className = "acc-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["아이디", "기관명", "전화번호", "상태", "용량", "마지막 로그인", ""]) {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.append(th);
    }
    thead.append(headRow);
    table.append(thead);

    const tbody = document.createElement("tbody");
    // 승인 대기가 맨 위 — 이 화면에 들어오는 이유가 대개 그것이다.
    const order: Record<AccountStatus, number> = { pending: 0, active: 1, blocked: 2 };
    const rows = [...this.rows].sort(
      (a, b) => order[a.status] - order[b.status] || a.id.localeCompare(b.id),
    );
    for (const row of rows) tbody.append(this.row(row));
    table.append(tbody);
    wrap.append(table);
    return wrap;
  }

  private row(row: Row): HTMLElement {
    const tr = document.createElement("tr");
    if (row.status === "pending") tr.className = "is-pending";

    const idTd = document.createElement("td");
    const idSpan = document.createElement("span");
    idSpan.className = "acc-id";
    idSpan.textContent = row.id;
    idTd.append(idSpan);
    if (row.isMaster) {
      const tag = document.createElement("span");
      tag.className = "acc-master-tag";
      tag.textContent = "마스터";
      idTd.append(tag);
    }
    tr.append(idTd);

    const text = (value: string | null | undefined, cls = ""): HTMLElement => {
      const td = document.createElement("td");
      td.className = value ? cls : `${cls} acc-dim`.trim();
      td.textContent = value || "—";
      return td;
    };
    tr.append(text(row.orgName), text(row.phone, "acc-num"));

    const statusTd = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = `acc-pill is-${row.status}`;
    pill.textContent = STATUS_LABEL[row.status];
    statusTd.append(pill);
    tr.append(statusTd);

    tr.append(
      text(row.bytes == null ? null : formatSize(row.bytes), "acc-num"),
      text(row.lastLoginAt ? new Date(row.lastLoginAt).toLocaleString() : null, "acc-num"),
    );

    const actions = document.createElement("td");
    actions.className = "acc-actions";
    // 마스터 자신은 상태를 바꿀 수 없다 — 정지시키면 승인할 사람이 사라진다.
    if (!row.isMaster) {
      for (const action of ACTIONS[row.status]) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = action.label;
        if (action.danger) btn.className = "danger";
        else if (row.status === "pending") btn.className = "primary";
        btn.addEventListener("click", () => {
          // 정지·거절은 그 계정을 즉시 쫓아낸다. 되돌릴 수는 있어도 한 번은 묻는다.
          if (action.danger && !window.confirm(`${row.id} 계정을 ${action.label}할까요?`)) return;
          void this.apply(row.id, action.next);
        });
        actions.append(btn);
      }
    }
    const pwBtn = document.createElement("button");
    pwBtn.type = "button";
    pwBtn.textContent = "비번 초기화";
    pwBtn.addEventListener("click", () => void this.resetPw(row.id));
    actions.append(pwBtn);
    tr.append(actions);
    return tr;
  }
}
