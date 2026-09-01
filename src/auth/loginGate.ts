/**
 * 로그인 게이트 — **앱 본체가 뜨기 전에 계정을 확정한다.**
 *
 * 화면을 가리는 방식이 아니라 `boot()` 를 붙잡는 방식이다. 서버 미들웨어가 이미
 * 모든 API 를 막고 있으므로 화면만 가려도 데이터는 안 새지만, 로그인 전에 본체를
 * 띄우면 모든 패널이 401 을 받아 "데이터가 없다" 처럼 보인다 — 사용자는 그걸
 * 로그인 문제로 읽지 못한다.
 *
 * 세션이 도중에 끊기면(`onAuthExpired`) 같은 화면을 다시 띄운다. 그때 **새로고침을
 * 강요하지 않는다** — 측정 중 화면 상태를 날리지 않으려는 것이다.
 */

import { login, signup, checkId, type AuthUser } from "../api/authApi.js";
import { onAuthExpired } from "../api/http.js";
import { APP_VERSION } from "../version.js";

const OVERLAY_ID = "loginGate";

type Mode = "login" | "signup" | "pending";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

/** 게이트가 쓰는 스타일. 본체 CSS 를 건드리지 않으려고 여기에 둔다. */
const STYLE = `
#${OVERLAY_ID} {
  position: fixed; inset: 0; z-index: 9999;
  display: grid; place-items: center;
  background: var(--bg, #FFFBF8); color: var(--fg, #1f2329);
  font: 14px/1.5 var(--font-ui, system-ui, -apple-system, "Segoe UI", sans-serif);
}
#${OVERLAY_ID} .lg-card {
  width: min(420px, calc(100vw - 32px));
  background: var(--surface, #fff); border: 1px solid var(--border, #F3EFEC);
  border-radius: 16px; box-shadow: 0 8px 24px rgba(0,0,0,.06);
  padding: 28px; display: grid; gap: 14px;
}
#${OVERLAY_ID} .lg-brand {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  font-family: var(--font-brand, inherit); font-weight: 700; letter-spacing: -0.03em;
  font-size: 24px; line-height: 1;
}
#${OVERLAY_ID} .lg-brand .t { color: var(--primary, #f0663f); }
#${OVERLAY_ID} .lg-brand .g { color: var(--brand-text, #D14E27); font-weight: 600; }
#${OVERLAY_ID} h1 { margin:0; font-size:22px; font-weight:700; letter-spacing:-0.02em; text-align:center; }
#${OVERLAY_ID} p.lg-sub { margin:0; color: var(--muted, #7C7977); font-size:13px; }
#${OVERLAY_ID} label { display:grid; gap:4px; font-size:11px; font-weight:600; color: var(--muted, #7C7977); }
#${OVERLAY_ID} input {
  background: var(--surface, #fff); border:1px solid var(--border-strong, #E9E5E3); border-radius:10px;
  padding:10px 12px; color: var(--fg, #1f2329); font: inherit; font-size:15px;
  width:100%; box-sizing:border-box;
}
#${OVERLAY_ID} input:focus {
  outline: none; border-color: var(--primary, #f0663f);
  box-shadow: 0 0 0 3px var(--primary-light, #fdebe4);
}
#${OVERLAY_ID} button.lg-primary {
  background: var(--primary, #f0663f); color:#fff; border:0; border-radius:10px;
  padding:12px; font: inherit; font-size:15px; font-weight:700; cursor:pointer;
}
#${OVERLAY_ID} button.lg-primary:hover { background: var(--primary-hover, #f2764d); }
#${OVERLAY_ID} button.lg-primary:disabled { background: var(--border-strong, #E9E5E3); color: var(--muted, #7C7977); cursor:default; }
#${OVERLAY_ID} button.lg-link {
  background:none; border:0; color: var(--muted, #7C7977); font: inherit; font-size:12px;
  font-weight:600; cursor:pointer; padding:0; text-decoration: underline;
}
#${OVERLAY_ID} button.lg-link:hover { color: var(--primary-pressed, #d9502b); }
#${OVERLAY_ID} .lg-error { color: var(--danger, #cf222e); font-size:13px; }
#${OVERLAY_ID} .lg-ok { color: var(--success, #1a7f37); font-size:13px; }
#${OVERLAY_ID} .lg-foot { display:flex; justify-content:space-between; align-items:center; }
#${OVERLAY_ID} .lg-ver { color: var(--muted, #7C7977); opacity:.7; font-size:11px; }
#${OVERLAY_ID} .lg-agree {
  display:flex; align-items:flex-start; gap:8px; font-size:12px; color: var(--muted, #7C7977);
  cursor:pointer; user-select:none;
}
#${OVERLAY_ID} .lg-agree input { width:16px; height:16px; margin:1px 0 0; accent-color: var(--primary, #f0663f); flex:0 0 auto; }
#${OVERLAY_ID} .lg-agree a { color: var(--brand-text, #D14E27); }
#${OVERLAY_ID} .lg-legal { display:flex; gap:10px; justify-content:center; font-size:11px; }
#${OVERLAY_ID} .lg-legal a { color: var(--muted, #7C7977); text-decoration:none; }
#${OVERLAY_ID} .lg-legal a:hover { color: var(--primary-pressed, #d9502b); text-decoration:underline; }
`;

function ensureStyle(): void {
  if (document.getElementById(`${OVERLAY_ID}-style`)) return;
  const style = el("style", { id: `${OVERLAY_ID}-style` });
  style.textContent = STYLE;
  document.head.append(style);
}

/** 헤더와 같은 워드마크 — 로그인 화면도 같은 브랜드로 시작한다. */
function brand(): HTMLElement {
  const box = el("div", { class: "lg-brand" });
  box.append(
    el("span", { class: "t" }, "Talktail"),
    el("span", { class: "g" }, "Gait"),
  );
  return box;
}

/** 약관·방침 링크 — 스토어 심사와 가입 동의에 모두 쓰인다. */
function legalLinks(): HTMLElement {
  const box = el("div", { class: "lg-legal" });
  box.append(
    el("a", { href: "/legal/terms.html", target: "_blank", rel: "noopener" }, "이용약관"),
    el("span", {}, "·"),
    el("a", { href: "/legal/privacy.html", target: "_blank", rel: "noopener" }, "개인정보처리방침"),
  );
  return box;
}

export type GateResult = { user: AuthUser };

/**
 * 로그인될 때까지 기다린다. 이미 로그인돼 있으면 `current` 를 그대로 돌려준다.
 *
 * @param apiBase  API 베이스 URL
 * @param current  `/api/auth/me` 결과 (null 이면 미로그인)
 */
export function requireLogin(apiBase: string, current: AuthUser | null): Promise<GateResult> {
  if (current) return Promise.resolve({ user: current });
  return showGate(apiBase);
}

/**
 * 세션이 도중에 끊겼을 때를 대비해 구독해 둔다.
 * 끊기면 같은 게이트를 다시 띄우고, 로그인하면 **새로고침한다** —
 * 화면 곳곳의 캐시가 401 로 비어 있을 수 있어 되살리는 것보다 다시 그리는 게 확실하다.
 */
export function watchSessionExpiry(apiBase: string): void {
  onAuthExpired(() => {
    if (document.getElementById(OVERLAY_ID)) return; // 이미 떠 있다
    void showGate(apiBase, "세션이 만료되었습니다. 다시 로그인해 주세요.").then(() => {
      window.location.reload();
    });
  });
}

function showGate(apiBase: string, notice?: string): Promise<GateResult> {
  ensureStyle();
  return new Promise<GateResult>((resolve) => {
    let mode: Mode = "login";
    const overlay = el("div", { id: OVERLAY_ID });
    const card = el("div", { class: "lg-card" });
    overlay.append(card);
    document.body.append(overlay);

    const render = (): void => {
      card.textContent = "";
      if (mode === "login") renderLogin();
      else if (mode === "signup") renderSignup();
      else renderPending();
    };

    const foot = (right: HTMLElement | null): HTMLElement => {
      const box = el("div", { class: "lg-foot" });
      box.append(el("span", { class: "lg-ver" }, APP_VERSION));
      if (right) box.append(right);
      return box;
    };

    function renderLogin(): void {
      const idInput = el("input", { type: "text", autocomplete: "username", placeholder: "아이디" });
      const pwInput = el("input", {
        type: "password",
        autocomplete: "current-password",
        placeholder: "비밀번호",
      });
      const err = el("div", { class: "lg-error" });
      if (notice) err.textContent = notice;
      const btn = el("button", { class: "lg-primary", type: "submit" }, "로그인");
      const toSignup = el("button", { class: "lg-link", type: "button" }, "회원가입");
      toSignup.addEventListener("click", () => {
        mode = "signup";
        render();
      });

      const form = el("form");
      form.append(
        brand(),
        el("h1", {}, "로그인"),
        el("label", {}, "아이디", idInput),
        el("label", {}, "비밀번호", pwInput),
        err,
        btn,
        foot(toSignup),
        legalLinks(),
      );
      // form 자체를 grid 로 — card 의 gap 을 그대로 쓰기 위해.
      form.style.display = "grid";
      form.style.gap = "14px";
      card.append(form);

      form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        const id = idInput.value.trim();
        const pw = pwInput.value;
        if (!id || !pw) {
          err.textContent = "아이디와 비밀번호를 입력하세요.";
          return;
        }
        btn.disabled = true;
        err.textContent = "";
        void login(apiBase, id, pw).then((res) => {
          btn.disabled = false;
          if (res.ok) {
            overlay.remove();
            resolve({ user: res.user });
            return;
          }
          // 승인 대기·정지는 아이디·비번이 맞은 경우다 — 안내가 달라야 한다.
          if (res.error.status === "pending" || res.error.status === "blocked") {
            mode = "pending";
            notice = res.error.message;
            render();
            return;
          }
          err.textContent = res.error.message;
        });
      });
      idInput.focus();
    }

    function renderSignup(): void {
      const org = el("input", { type: "text", placeholder: "기관명" });
      // 전화번호는 당분간 받지 않는다 — 서버는 없어도 가입을 받는다(phone 은 nullable).
      // const phone = el("input", { type: "tel", placeholder: "전화번호" });
      const idInput = el("input", { type: "text", autocomplete: "username", placeholder: "아이디" });
      const pw = el("input", { type: "password", autocomplete: "new-password", placeholder: "비밀번호" });
      const pw2 = el("input", {
        type: "password",
        autocomplete: "new-password",
        placeholder: "비밀번호 확인",
      });
      const err = el("div", { class: "lg-error" });
      const idNote = el("div", { class: "lg-sub" });
      const btn = el("button", { class: "lg-primary", type: "submit" }, "가입 신청");
      btn.disabled = true; // 동의 전에는 신청할 수 없다.
      const agreeBox = el("input", { type: "checkbox" }) as HTMLInputElement;
      const agree = el("label", { class: "lg-agree" });
      agree.append(
        agreeBox,
        el("span", {}, "["),
        el("a", { href: "/legal/terms.html", target: "_blank", rel: "noopener" }, "이용약관"),
        el("span", {}, "] 및 ["),
        el("a", { href: "/legal/privacy.html", target: "_blank", rel: "noopener" }, "개인정보처리방침"),
        el("span", {}, "]에 동의합니다. (필수)"),
      );
      // label 안의 링크 클릭이 체크박스를 토글하지 않게 막는다.
      agree.querySelectorAll("a").forEach((a) => a.addEventListener("click", (ev) => ev.stopPropagation()));
      agreeBox.addEventListener("change", () => {
        btn.disabled = !agreeBox.checked;
      });
      const toLogin = el("button", { class: "lg-link", type: "button" }, "로그인으로");
      toLogin.addEventListener("click", () => {
        mode = "login";
        notice = undefined;
        render();
      });

      // 아이디 중복은 제출 전에 알려 준다 — 다 채우고 나서 되돌려보내지 않으려는 것이다.
      idInput.addEventListener("blur", () => {
        const id = idInput.value.trim();
        if (!id) {
          idNote.textContent = "";
          return;
        }
        void checkId(apiBase, id).then((available) => {
          idNote.textContent = available ? "사용할 수 있는 아이디입니다." : "이미 사용 중이거나 쓸 수 없는 아이디입니다.";
          idNote.style.color = available ? "var(--success, #1a7f37)" : "var(--danger, #cf222e)";
        });
      });

      const form = el("form");
      form.style.display = "grid";
      form.style.gap = "14px";
      form.append(
        brand(),
        el("h1", {}, "회원가입"),
        el(
          "p",
          { class: "lg-sub" },
          "가입 후 관리자 승인을 받아야 이용할 수 있습니다.",
        ),
        el("label", {}, "기관명", org),
        // el("label", {}, "전화번호", phone),
        el("label", {}, "아이디", idInput),
        idNote,
        el("label", {}, "비밀번호", pw),
        el("label", {}, "비밀번호 확인", pw2),
        agree,
        err,
        btn,
        foot(toLogin),
      );
      card.append(form);

      form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        err.textContent = "";
        if (!agreeBox.checked) {
          err.textContent = "이용약관과 개인정보처리방침에 동의해 주세요.";
          return;
        }
        if (pw.value !== pw2.value) {
          err.textContent = "비밀번호가 일치하지 않습니다.";
          return;
        }
        btn.disabled = true;
        void signup(apiBase, {
          id: idInput.value.trim(),
          password: pw.value,
          passwordConfirm: pw2.value,
          orgName: org.value.trim(),
          phone: "",
        }).then((res) => {
          btn.disabled = !agreeBox.checked;
          if (!res.ok) {
            err.textContent = res.error.message;
            return;
          }
          mode = "pending";
          notice = "가입 신청이 접수되었습니다. 관리자 승인 후 이용할 수 있습니다.";
          render();
        });
      });
      org.focus();
    }

    function renderPending(): void {
      const back = el("button", { class: "lg-link", type: "button" }, "로그인으로");
      back.addEventListener("click", () => {
        mode = "login";
        notice = undefined;
        render();
      });
      card.append(
        brand(),
        el("h1", {}, "승인 대기"),
        el("p", { class: "lg-sub" }, notice || "관리자 승인 후 이용할 수 있습니다."),
        foot(back),
      );
    }

    render();
  });
}
