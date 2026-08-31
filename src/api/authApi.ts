/**
 * 계정 API — 로그인/가입/내 정보 + 마스터의 계정 관리.
 *
 * 웹이 계정 화면의 **정본**이다. 앱에는 로그인 화면만 있고, 가입·비밀번호 변경·
 * 정보 수정은 전부 여기서 한다.
 */

import { joinApiUrl } from "../config/apiUrl.js";
import { apiFetch } from "./http.js";

export type AccountStatus = "pending" | "active" | "blocked";

export type AuthUser = {
  id: string;
  orgName: string | null;
  phone: string | null;
  status: AccountStatus;
  isMaster: boolean;
  createdAt?: string;
  lastLoginAt?: string | null;
};

/** 서버가 준 실패 사유. `pending`/`blocked` 는 **아이디·비번이 맞은** 경우다. */
export type LoginFailure = {
  message: string;
  status?: AccountStatus;
};

async function readError(res: Response): Promise<LoginFailure> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const status = body.status;
  return {
    message: String(body.message || body.error || `요청 실패 (${res.status})`),
    status:
      status === "pending" || status === "blocked" || status === "active"
        ? (status as AccountStatus)
        : undefined,
  };
}

export async function login(
  apiBase: string,
  id: string,
  password: string,
): Promise<{ ok: true; user: AuthUser } | { ok: false; error: LoginFailure }> {
  const res = await apiFetch(joinApiUrl(apiBase, "/api/auth/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // client 를 안 보내면 web 이다 — 서버가 쿠키를 내려준다.
    body: JSON.stringify({ id, password }),
  });
  if (!res.ok) return { ok: false, error: await readError(res) };
  const body = (await res.json()) as { user: AuthUser };
  return { ok: true, user: body.user };
}

export async function logout(apiBase: string): Promise<void> {
  await apiFetch(joinApiUrl(apiBase, "/api/auth/logout"), { method: "POST" }).catch(() => undefined);
}

/** 로그인 상태 확인. 401 이면 null — 호출측이 로그인 화면을 띄운다. */
export async function fetchMe(apiBase: string): Promise<AuthUser | null> {
  const res = await apiFetch(joinApiUrl(apiBase, "/api/auth/me"));
  if (!res.ok) return null;
  const body = (await res.json()) as { user: AuthUser };
  return body.user;
}

export type SignupInput = {
  id: string;
  password: string;
  passwordConfirm: string;
  orgName: string;
  phone: string;
};

export async function signup(
  apiBase: string,
  input: SignupInput,
): Promise<{ ok: true } | { ok: false; error: LoginFailure }> {
  const res = await apiFetch(joinApiUrl(apiBase, "/api/auth/signup"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) return { ok: false, error: await readError(res) };
  return { ok: true };
}

/** 아이디 중복 확인. 형식이 안 맞아도 `available:false` 다. */
export async function checkId(apiBase: string, id: string): Promise<boolean> {
  const res = await apiFetch(
    joinApiUrl(apiBase, `/api/auth/check-id?id=${encodeURIComponent(id)}`),
  );
  if (!res.ok) return false;
  const body = (await res.json()) as { available?: boolean };
  return Boolean(body.available);
}

export async function changePassword(
  apiBase: string,
  currentPassword: string,
  newPassword: string,
  newPasswordConfirm: string,
): Promise<{ ok: true } | { ok: false; error: LoginFailure }> {
  const res = await apiFetch(joinApiUrl(apiBase, "/api/auth/password"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword, newPassword, newPasswordConfirm }),
  });
  if (!res.ok) return { ok: false, error: await readError(res) };
  return { ok: true };
}

export async function updateProfile(
  apiBase: string,
  patch: { orgName?: string; phone?: string },
): Promise<AuthUser | null> {
  const res = await apiFetch(joinApiUrl(apiBase, "/api/auth/me"), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { user: AuthUser };
  return body.user;
}

// ── 마스터 전용 ────────────────────────────────────────────────────────────

export async function listUsers(apiBase: string): Promise<AuthUser[]> {
  const res = await apiFetch(joinApiUrl(apiBase, "/api/admin/users"));
  if (!res.ok) return [];
  const body = (await res.json()) as { users: AuthUser[] };
  return body.users || [];
}

/**
 * 상태 전이 — 3개 상태로 4가지 동작을 낸다.
 * 승인(`pending→active`) / 거절(`pending→blocked`) / 정지(`active→blocked`) /
 * 복구(`blocked→active`).
 */
export async function setUserStatus(
  apiBase: string,
  id: string,
  status: AccountStatus,
): Promise<{ ok: true } | { ok: false; error: LoginFailure }> {
  const res = await apiFetch(
    joinApiUrl(apiBase, `/api/admin/users/${encodeURIComponent(id)}/status`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    },
  );
  if (!res.ok) return { ok: false, error: await readError(res) };
  return { ok: true };
}

export async function resetUserPassword(
  apiBase: string,
  id: string,
  newPassword: string,
): Promise<{ ok: true } | { ok: false; error: LoginFailure }> {
  const res = await apiFetch(
    joinApiUrl(apiBase, `/api/admin/users/${encodeURIComponent(id)}/password`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword }),
    },
  );
  if (!res.ok) return { ok: false, error: await readError(res) };
  return { ok: true };
}
