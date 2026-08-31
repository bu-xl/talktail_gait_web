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
  background: #0b0f14; color: #f5f8fc;
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
#${OVERLAY_ID} .lg-card {
  width: min(420px, calc(100vw - 32px));
  background: #141b24; border: 1px solid #2a3644; border-radius: 16px;
  padding: 28px; display: grid; gap: 14px;
}
#${OVERLAY_ID} .lg-kicker { color:#3b82f6; font-size:11px; font-weight:700; letter-spacing:1.5px; }
#${OVERLAY_ID} h1 { margin:0; font-size:24px; font-weight:700; }
#${OVERLAY_ID} p.lg-sub { margin:0; color:#9fadbd; font-size:13px; }
#${OVERLAY_ID} label { display:grid; gap:4px; font-size:11px; color:#9fadbd; }
#${OVERLAY_ID} input {
  background:#1c2632; border:1px solid #2a3644; border-radius:10px;
  padding:10px 12px; color:#f5f8fc; font-size:15px; width:100%; box-sizing:border-box;
}
#${OVERLAY_ID} button.lg-primary {
  background:#3b82f6; color:#fff; border:0; border-radius:10px;
  padding:12px; font-size:15px; font-weight:700; cursor:pointer;
}
#${OVERLAY_ID} button.lg-primary:disabled { background:#1d3a63; cursor:default; }
#${OVERLAY_ID} button.lg-link {
  background:none; border:0; color:#9fadbd; font-size:12px; cursor:pointer; padding:0;
  text-decoration: underline;
}
#${OVERLAY_ID} .lg-error { color:#ff453a; font-size:13px; }
#${OVERLAY_ID} .lg-ok { color:#30d158; font-size:13px; }
#${OVERLAY_ID} .lg-foot { display:flex; justify-content:space-between; align-items:center; }
#${OVERLAY_ID} .lg-ver { color:#6b7887; font-size:11px; }
`;

function ensureStyle(): void {
  if (document.getElementById(`${OVERLAY_ID}-style`)) return;
  const style = el("style", { id: `${OVERLAY_ID}-style` });
  style.textContent = STYLE;
  document.head.append(style);
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
        el("div", { class: "lg-kicker" }, "TALKTAIL GAIT"),
        el("h1", {}, "로그인"),
        el(
          "p",
          { class: "lg-sub" },
          "촬영에 쓰는 폰도 같은 계정으로 로그인해야 시작·종료 버튼이 전달됩니다.",
        ),
        el("label", {}, "아이디", idInput),
        el("label", {}, "비밀번호", pwInput),
        err,
        btn,
        foot(toSignup),
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
      const phone = el("input", { type: "tel", placeholder: "전화번호" });
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
          idNote.style.color = available ? "#30d158" : "#ff453a";
        });
      });

      const form = el("form");
      form.style.display = "grid";
      form.style.gap = "14px";
      form.append(
        el("div", { class: "lg-kicker" }, "TALKTAIL GAIT"),
        el("h1", {}, "회원가입"),
        el(
          "p",
          { class: "lg-sub" },
          "가입 후 관리자 승인을 받아야 이용할 수 있습니다.",
        ),
        el("label", {}, "기관명", org),
        el("label", {}, "전화번호", phone),
        el("label", {}, "아이디", idInput),
        idNote,
        el("label", {}, "비밀번호", pw),
        el("label", {}, "비밀번호 확인", pw2),
        err,
        btn,
        foot(toLogin),
      );
      card.append(form);

      form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        err.textContent = "";
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
          phone: phone.value.trim(),
        }).then((res) => {
          btn.disabled = false;
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
        el("div", { class: "lg-kicker" }, "TALKTAIL GAIT"),
        el("h1", {}, "승인 대기"),
        el("p", { class: "lg-sub" }, notice || "관리자 승인 후 이용할 수 있습니다."),
        foot(back),
      );
    }

    render();
  });
}
