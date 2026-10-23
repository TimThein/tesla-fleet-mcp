import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AUTH, SCOPES, cachePath, redirectUri, requiredEnv } from "./config.ts";

type TokenCache = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
};

type Pending = { verifier: string; state: string };

function pendingPath() {
  return `${dirname(cachePath())}/pkce-pending.json`;
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeSecret(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, path); // atomic replace
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function tokenRequest(body: Record<string, string>): Promise<TokenCache> {
  const res = await fetch(`${AUTH}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    throw new Error(`Tesla token ${res.status}: ${json.error ?? text}`.trim());
  }
  const access = String(json.access_token ?? "");
  const refresh = String(json.refresh_token ?? "");
  const expiresIn = Number(json.expires_in ?? 3600);
  if (!access) throw new Error("Tesla token response missing access_token");
  const prev = readJson<TokenCache>(cachePath());
  return {
    access_token: access,
    refresh_token: refresh || prev?.refresh_token || "",
    expires_at: Date.now() + Math.max(expiresIn - 60, 30) * 1000,
  };
}

// Single-flight: Tesla refresh tokens rotate and are single-use; concurrent
// refreshes with the same token can get the whole grant revoked (login_required).
let inflight: Promise<string> | null = null;
export function acquireToken(): Promise<string> {
  const path = cachePath();
  const cached = readJson<TokenCache>(path);
  if (cached?.access_token && cached.expires_at > Date.now()) return Promise.resolve(cached.access_token);
  if (!inflight) inflight = refreshToken().finally(() => { inflight = null; });
  return inflight;
}

async function refreshToken(): Promise<string> {
  const path = cachePath();
  const cached = readJson<TokenCache>(path);
  if (!cached?.access_token) throw new Error("Not signed in. Run: npm run login");
  if (cached.expires_at > Date.now() && cached.access_token) return cached.access_token;
  if (!cached.refresh_token) throw new Error("No refresh token. Run: npm run login");
  const next = await tokenRequest({
    grant_type: "refresh_token",
    client_id: requiredEnv("TESLA_CLIENT_ID"),
    refresh_token: cached.refresh_token,
  });
  if (!next.refresh_token) next.refresh_token = cached.refresh_token;
  writeSecret(path, next);
  return next.access_token;
}

export async function beginLogin(): Promise<string> {
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(16));
  writeSecret(pendingPath(), { verifier, state } satisfies Pending);
  const u = new URL("https://auth.tesla.com/oauth2/v3/authorize");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", requiredEnv("TESLA_CLIENT_ID"));
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("scope", SCOPES.join(" "));
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("prompt", "login");
  return u.toString();
}

export async function finishLogin(redirectOrCode: string): Promise<void> {
  const raw = redirectOrCode.trim();
  const url = raw.includes("://") ? new URL(raw) : null;
  const code = url ? url.searchParams.get("code") : raw;
  const state = url?.searchParams.get("state");
  if (!code) throw new Error("No ?code= in that URL");
  const pending = readJson<Pending>(pendingPath());
  if (!pending?.verifier) throw new Error("No pending login. Run: npm run login");
  if (state && pending.state && state !== pending.state) throw new Error("OAuth state mismatch");
  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    client_id: requiredEnv("TESLA_CLIENT_ID"),
    client_secret: requiredEnv("TESLA_CLIENT_SECRET"),
    code,
    audience: requiredEnv("TESLA_AUDIENCE"),
    redirect_uri: redirectUri(),
    code_verifier: pending.verifier,
  });
  if (!tokens.refresh_token) throw new Error("Code exchange returned no refresh_token");
  writeSecret(cachePath(), tokens);
}

export function __testables() {
  return { readJson, writeSecret, tokenRequest };
}
