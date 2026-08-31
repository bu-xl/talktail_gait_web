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
      window.alert(res.error.message);
      return;
    }
    await this.reload();
  }

  private async resetPw(id: string): Promise<void> {
    // 사용자가 비번을 잊었을 때의 유일한 경로다. 확인 절차를 굳이 두 번 두지 않는다 —
    // 되돌릴 수 없는 삭제와 달리 다시 바꾸면 그만이다.
    const pw = window.prompt(`${id} 의 새 비밀번호를 입력하세요.`);
    if (!pw) return;
    const res = await resetUserPassword(this.apiBase, id, pw);
    window.alert(res.ok ? "변경했습니다. 이 계정의 기존 로그인은 모두 해제됩니다." : res.error.message);
  }

  private render(status: string | null): void {
    this.root.textContent = "";

    const head = document.createElement("div");
    head.className = "acc-head";
    const title = document.createElement("h2");
    title.textContent = "계정 관리";
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "acc-refresh";
    refresh.textContent = "새로고침";
    refresh.addEventListener("click", () => void this.reload());
    head.append(title, refresh);
    this.root.append(head);

    if (status) {
      const p = document.createElement("p");
      p.className = "acc-status";
      p.textContent = status;
      this.root.append(p);
      return;
    }

    const pending = this.rows.filter((r) => r.status === "pending");
    if (pending.length) {
      const note = document.createElement("p");
      note.className = "acc-note";
      note.textContent = `승인 대기 ${pending.length}건`;
      this.root.append(note);
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
    for (const row of this.rows) {
      const tr = document.createElement("tr");
      const cells = [
        row.isMaster ? `${row.id} (마스터)` : row.id,
        row.orgName || "—",
        row.phone || "—",
        STATUS_LABEL[row.status],
        row.bytes == null ? "—" : formatSize(row.bytes),
        row.lastLoginAt ? new Date(row.lastLoginAt).toLocaleString() : "—",
      ];
      for (const text of cells) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.append(td);
      }

      const actions = document.createElement("td");
      actions.className = "acc-actions";
      // 마스터 자신은 상태를 바꿀 수 없다 — 정지시키면 승인할 사람이 사라진다.
      if (!row.isMaster) {
        for (const action of ACTIONS[row.status]) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.textContent = action.label;
          if (action.danger) btn.className = "danger";
          btn.addEventListener("click", () => void this.apply(row.id, action.next));
          actions.append(btn);
        }
      }
      const pwBtn = document.createElement("button");
      pwBtn.type = "button";
      pwBtn.textContent = "비번 초기화";
      pwBtn.addEventListener("click", () => void this.resetPw(row.id));
      actions.append(pwBtn);
      tr.append(actions);
      tbody.append(tr);
    }
    table.append(tbody);
    this.root.append(table);
  }
}
