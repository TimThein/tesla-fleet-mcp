import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

export const OAUTH_CLIENT_ID = "grok";
export const OAUTH_SCOPE = "mcp";
const CODE_TTL_MS = 60_000;
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 90 * 24 * 3600;
const FAIL_LIMIT = 5;
const FAIL_WINDOW_MS = 15 * 60_000;

export type OAuthOptions = {
  passphraseHashFile: string;
  storePath: string;
  /** Extra redirect hosts allowed exactly (testing only). */
  extraRedirectHosts?: string[];
  log?: (msg: string) => void;
};

/** Format: scrypt$N$r$p$saltB64$hashB64 */
export function hashPassphrase(pass: string, N = 16384, r = 8, p = 1): string {
  const salt = randomBytes(16);
  const h = scryptSync(pass, salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${h.toString("base64")}`;
}

export function verifyPassphrase(pass: string, stored: string): boolean {
  const parts = stored.trim().split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], "base64");
  const want = Buffer.from(parts[5], "base64");
  const got = scryptSync(pass, salt, want.length, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return got.length === want.length && timingSafeEqual(got, want);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const b64url = (b: Buffer) => b.toString("base64url");

export function redirectHostAllowed(host: string, extra: string[] = []): boolean {
  const h = host.toLowerCase();
  if (extra.map((x) => x.toLowerCase()).includes(h)) return true;
  if (h === "grok.com" || h.endsWith(".grok.com")) return true;
  if (h === "x.ai" || h.endsWith(".x.ai")) return true;
  return false;
}

type TokenRec = { exp: number; client_id: string; scope: string };
type Store = { access: Record<string, TokenRec>; refresh: Record<string, TokenRec> };
type CodeRec = { exp: number; client_id: string; redirect_uri: string; challenge: string; scope: string };

function htmlEscape(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

async function readBody(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
    size += b.length;
    if (size > 64 * 1024) throw new Error("body too large");
    chunks.push(b);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const ct = String(req.headers["content-type"] ?? "");
  if (ct.includes("application/json")) {
    const o = raw.trim() ? JSON.parse(raw) : {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o ?? {})) if (typeof v === "string") out[k] = v;
    return out;
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

export class OAuthProvider {
  private codes = new Map<string, CodeRec>();
  private fails = new Map<string, number[]>();
  private store: Store = { access: {}, refresh: {} };

  constructor(private opts: OAuthOptions) {
    if (existsSync(opts.storePath)) {
      try {
        const s = JSON.parse(readFileSync(opts.storePath, "utf8"));
        this.store = { access: s.access ?? {}, refresh: s.refresh ?? {} };
      } catch {
        this.store = { access: {}, refresh: {} };
      }
    }
    this.prune();
  }

  private log(m: string) {
    (this.opts.log ?? ((x: string) => console.error(x)))(`[oauth] ${m}`);
  }

  get enabled(): boolean {
    return existsSync(this.opts.passphraseHashFile);
  }

  private prune() {
    const now = Math.floor(Date.now() / 1000);
    for (const kind of ["access", "refresh"] as const)
      for (const [k, v] of Object.entries(this.store[kind])) if (v.exp <= now) delete this.store[kind][k];
    for (const [k, v] of this.codes) if (v.exp <= Date.now()) this.codes.delete(k);
  }

  private save() {
    this.prune();
    const tmp = `${this.opts.storePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.store), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.opts.storePath);
  }

  /** Returns true if the bearer value is a valid, unexpired OAuth access token. */
  validateAccessToken(token: string): boolean {
    const rec = this.store.access[sha256(token)];
    return !!rec && rec.exp > Math.floor(Date.now() / 1000);
  }

  static issuer(req: IncomingMessage): string {
    const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() || "http";
    const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost").split(",")[0].trim();
    return `${proto}://${host}`;
  }

  static clientIp(req: IncomingMessage): string {
    const remote = req.socket.remoteAddress ?? "";
    const local = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const xff = req.headers["x-forwarded-for"];
    if (local && xff) {
      const list = String(xff).split(",").map((s) => s.trim()).filter(Boolean);
      if (list.length) return list[list.length - 1];
    }
    return remote;
  }

  private limited(ip: string): boolean {
    const now = Date.now();
    const arr = (this.fails.get(ip) ?? []).filter((t) => now - t < FAIL_WINDOW_MS);
    this.fails.set(ip, arr);
    return arr.length >= FAIL_LIMIT;
  }

  private send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", Pragma: "no-cache", ...headers });
    res.end(JSON.stringify(body));
  }

  private html(res: ServerResponse, status: number, body: string) {
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://grok.com https://*.grok.com https://x.ai https://*.x.ai",
    });
    res.end(body);
  }

  /** Validate authorize params; returns error string or parsed values. */
  private checkAuthorize(p: Record<string, string>): string | { redirect: URL } {
    if (p.client_id !== OAUTH_CLIENT_ID) return "invalid client_id";
    if (p.response_type !== "code") return "response_type must be code";
    let u: URL;
    try {
      u = new URL(p.redirect_uri ?? "");
    } catch {
      return "invalid redirect_uri";
    }
    this.log(`authorize redirect_uri host=${u.host} path=${u.pathname}`);
    if (u.protocol !== "https:") return "redirect_uri must be https";
    if (!redirectHostAllowed(u.hostname, this.opts.extraRedirectHosts)) return `redirect_uri host not allowed: ${u.hostname}`;
    if (p.code_challenge_method !== "S256") return "code_challenge_method must be S256";
    if (!p.code_challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(p.code_challenge)) return "invalid code_challenge";
    if (p.scope && !p.scope.split(" ").every((s) => s === OAUTH_SCOPE)) return "invalid scope";
    return { redirect: u };
  }

  private form(p: Record<string, string>, err = ""): string {
    const hidden = ["client_id", "response_type", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope"]
      .filter((k) => p[k] !== undefined)
      .map((k) => `<input type="hidden" name="${k}" value="${htmlEscape(p[k])}">`)
      .join("");
    return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Tesla MCP</title>
<style>body{font-family:system-ui;max-width:420px;margin:60px auto;padding:0 16px}input[type=password]{width:100%;padding:8px;margin:8px 0}button{padding:8px 16px}</style></head>
<body><h2>Authorize Grok to access Tesla MCP</h2><p>Redirect: ${htmlEscape(new URL(p.redirect_uri).host)}</p>
${err ? `<p style="color:#b00">${htmlEscape(err)}</p>` : ""}
<form method="post" action="/oauth/authorize">${hidden}<label>Passphrase<input type="password" name="passphrase" autofocus autocomplete="current-password"></label><button type="submit">Authorize</button></form></body></html>`;
  }

  /** Handles OAuth routes. Returns true if handled. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    const iss = OAuthProvider.issuer(req);

    if (req.method === "GET" && (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration")) {
      this.send(res, 200, {
        issuer: iss,
        authorization_endpoint: `${iss}/oauth/authorize`,
        token_endpoint: `${iss}/oauth/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: [OAUTH_SCOPE],
      });
      return true;
    }
    if (req.method === "GET" && path.startsWith("/.well-known/oauth-protected-resource")) {
      this.send(res, 200, {
        resource: `${iss}/mcp`,
        authorization_servers: [iss],
        scopes_supported: [OAUTH_SCOPE],
        bearer_methods_supported: ["header"],
      });
      return true;
    }

    if (path === "/oauth/authorize") {
      if (!this.enabled) {
        this.send(res, 503, { error: "temporarily_unavailable", error_description: "OAuth not configured" });
        return true;
      }
      if (req.method === "GET") {
        const p = Object.fromEntries(url.searchParams);
        const chk = this.checkAuthorize(p);
        if (typeof chk === "string") {
          this.log(`authorize rejected: ${chk}`);
          this.html(res, 400, `<!doctype html><p>Invalid request: ${htmlEscape(chk)}</p>`);
          return true;
        }
        this.html(res, 200, this.form(p));
        return true;
      }
      if (req.method === "POST") {
        let p: Record<string, string>;
        try {
          p = await readBody(req);
        } catch {
          this.html(res, 400, "<!doctype html><p>Bad request</p>");
          return true;
        }
        const chk = this.checkAuthorize(p);
        if (typeof chk === "string") {
          this.html(res, 400, `<!doctype html><p>Invalid request: ${htmlEscape(chk)}</p>`);
          return true;
        }
        const ip = OAuthProvider.clientIp(req);
        if (this.limited(ip)) {
          this.log(`authorize rate-limited ip=${ip}`);
          this.html(res, 429, "<!doctype html><p>Too many failed attempts. Try again later.</p>");
          return true;
        }
        let ok = false;
        try {
          ok = verifyPassphrase(p.passphrase ?? "", readFileSync(this.opts.passphraseHashFile, "utf8"));
        } catch {
          ok = false;
        }
        if (!ok) {
          this.fails.get(ip)!.push(Date.now());
          this.log(`authorize bad passphrase ip=${ip}`);
          this.html(res, 401, this.form(p, "Wrong passphrase."));
          return true;
        }
        this.fails.delete(ip);
        const code = b64url(randomBytes(32));
        this.codes.set(sha256(code), {
          exp: Date.now() + CODE_TTL_MS,
          client_id: p.client_id,
          redirect_uri: p.redirect_uri,
          challenge: p.code_challenge,
          scope: OAUTH_SCOPE,
        });
        const loc = chk.redirect;
        loc.searchParams.set("code", code);
        if (p.state !== undefined) loc.searchParams.set("state", p.state);
        this.log(`authorize ok ip=${ip} -> ${loc.host}`);
        res.writeHead(302, { Location: loc.toString(), "Cache-Control": "no-store" });
        res.end();
        return true;
      }
      this.send(res, 405, { error: "invalid_request" });
      return true;
    }

    if (path === "/oauth/token") {
      if (req.method !== "POST") {
        this.send(res, 405, { error: "invalid_request" });
        return true;
      }
      let p: Record<string, string>;
      try {
        p = await readBody(req);
      } catch {
        this.send(res, 400, { error: "invalid_request" });
        return true;
      }
      // Public client; also tolerate client_id via HTTP Basic.
      const basic = String(req.headers.authorization ?? "");
      if (!p.client_id && basic.startsWith("Basic ")) {
        p.client_id = decodeURIComponent(Buffer.from(basic.slice(6), "base64").toString("utf8").split(":")[0]);
      }
      if (p.client_id && p.client_id !== OAUTH_CLIENT_ID) {
        this.send(res, 401, { error: "invalid_client" });
        return true;
      }
      if (p.grant_type === "authorization_code") {
        const key = sha256(p.code ?? "");
        const rec = this.codes.get(key);
        this.codes.delete(key); // one-time
        if (!rec || rec.exp <= Date.now()) return this.fail(res, "invalid_grant", "code invalid or expired");
        if ((p.client_id ?? OAUTH_CLIENT_ID) !== rec.client_id) return this.fail(res, "invalid_grant", "client mismatch");
        if (p.redirect_uri !== rec.redirect_uri) return this.fail(res, "invalid_grant", "redirect_uri mismatch");
        const verifier = p.code_verifier ?? "";
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return this.fail(res, "invalid_grant", "bad code_verifier");
        if (b64url(createHash("sha256").update(verifier).digest()) !== rec.challenge)
          return this.fail(res, "invalid_grant", "PKCE verification failed");
        this.log("token issued (authorization_code)");
        this.issue(res, rec.client_id);
        return true;
      }
      if (p.grant_type === "refresh_token") {
        const key = sha256(p.refresh_token ?? "");
        const rec = this.store.refresh[key];
        if (!rec || rec.exp <= Math.floor(Date.now() / 1000)) return this.fail(res, "invalid_grant", "refresh_token invalid");
        delete this.store.refresh[key]; // rotate
        this.log("token issued (refresh_token)");
        this.issue(res, rec.client_id);
        return true;
      }
      this.send(res, 400, { error: "unsupported_grant_type" });
      return true;
    }
    return false;
  }

  private fail(res: ServerResponse, error: string, desc: string): true {
    this.log(`token rejected: ${desc}`);
    this.send(res, 400, { error, error_description: desc });
    return true;
  }

  private issue(res: ServerResponse, client_id: string) {
    const now = Math.floor(Date.now() / 1000);
    const access = b64url(randomBytes(32));
    const refresh = b64url(randomBytes(32));
    this.store.access[sha256(access)] = { exp: now + ACCESS_TTL_S, client_id, scope: OAUTH_SCOPE };
    this.store.refresh[sha256(refresh)] = { exp: now + REFRESH_TTL_S, client_id, scope: OAUTH_SCOPE };
    this.save();
    this.send(res, 200, {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
      scope: OAUTH_SCOPE,
    });
  }
}
