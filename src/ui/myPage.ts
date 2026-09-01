/**
 * 마이페이지 — 내 정보 조회 + 비밀번호 변경 + 언어 설정.
 *
 * 화면(section#myPage)은 index.html 에 정적으로 있다. 언어 select 가
 * `data-i18n` 과 `#langSelect` 로 이미 배선돼 있어 JS 로 다시 그리면 그 배선이
 * 끊긴다 — 여기서는 값만 채우고 폼만 연결한다.
 */

import { changePassword, type AuthUser } from "../api/authApi.js";

function fmtDate(v?: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

const STATUS_LABEL: Record<string, string> = {
  pending: "승인 대기",
  active: "승인됨",
  blocked: "정지됨",
};

export function wireMyPage(apiBase: string, user: AuthUser): void {
  const root = document.getElementById("myPage");
  if (!root) return;

  const set = (id: string, text: string): void => {
    const el = root.querySelector<HTMLElement>(`#${id}`);
    if (el) el.textContent = text;
  };
  set("myId", user.id);
  set("myOrg", user.orgName || "—");
  set("myPhone", user.phone || "—");
  set("myStatus", user.isMaster ? "마스터" : (STATUS_LABEL[user.status] ?? user.status));
  set("myCreatedAt", fmtDate(user.createdAt));
  set("myLastLoginAt", fmtDate(user.lastLoginAt));

  const form = root.querySelector<HTMLFormElement>("#myPwForm");
  const msg = root.querySelector<HTMLElement>("#myPwMsg");
  if (!form || !msg) return;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const cur = String(data.get("current") || "");
    const next = String(data.get("next") || "");
    const confirm = String(data.get("confirm") || "");
    if (next !== confirm) {
      msg.textContent = "새 비밀번호가 서로 다릅니다.";
      msg.className = "mp-msg bad";
      return;
    }
    const btn = form.querySelector<HTMLButtonElement>("button[type=submit]");
    if (btn) btn.disabled = true;
    msg.textContent = "변경 중…";
    msg.className = "mp-msg";
    void changePassword(apiBase, cur, next, confirm).then((r) => {
      if (btn) btn.disabled = false;
      if (r.ok) {
        form.reset();
        msg.textContent = "비밀번호를 변경했습니다.";
        msg.className = "mp-msg ok";
      } else {
        msg.textContent = r.error.message;
        msg.className = "mp-msg bad";
      }
    });
  });
}
