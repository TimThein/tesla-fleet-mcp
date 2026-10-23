import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveHttp } from "../src/http.ts";
import { hashPassphrase, redirectHostAllowed, verifyPassphrase } from "../src/oauth.ts";

const TOKEN = "static-token";
const PASS = "correct horse battery";
const REDIRECT = "https://grok.com/oauth/callback";
const dir = mkdtempSync(join(tmpdir(), "oauth-test-"));
const hashFile = join(dir, "pass.hash");
const storePath = join(dir, "tokens.json");

const b64url = (b: Buffer) => b.toString("base64url");

describe("oauth", () => {
  let base = "";
  let close: () => Promise<void> = async () => {};
  beforeAll(async () => {
    writeFileSync(hashFile, hashPassphrase(PASS, 1024), { mode: 0o600 });
    const s = await serveHttp({ host: "127.0.0.1", port: 0, token: TOKEN, oauth: { passphraseHashFile: hashFile, storePath, log: () => {} } });
    base = s.url.replace(/\/mcp$/, "");
    close = s.close;
  });
  afterAll(async () => close());

  it("hashes and verifies passphrases", () => {
    const h = hashPassphrase("x", 1024);
    expect(verifyPassphrase("x", h)).toBe(true);
    expect(verifyPassphrase("y", h)).toBe(false);
  });

  it("restricts redirect hosts", () => {
    expect(redirectHostAllowed("grok.com")).toBe(true);
    expect(redirectHostAllowed("a.grok.com")).toBe(true);
    expect(redirectHostAllowed("auth.x.ai")).toBe(true);
    expect(redirectHostAllowed("evilgrok.com")).toBe(false);
    expect(redirectHostAllowed("x.ai.evil.com")).toBe(false);
  });

  it("serves metadata and WWW-Authenticate", async () => {
    const m = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
    expect(m.token_endpoint).toBe(`${base}/oauth/token`);
    const r = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("runs authorization code + PKCE + refresh flow", async () => {
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const params = { client_id: "grok", response_type: "code", redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "st8", scope: "mcp" };

    expect((await fetch(`${base}/oauth/authorize?${new URLSearchParams({ ...params, redirect_uri: "https://evil.com/cb" })}`)).status).toBe(400);
    expect((await fetch(`${base}/oauth/authorize?${new URLSearchParams({ ...params, code_challenge_method: "plain" })}`)).status).toBe(400);
    const page = await fetch(`${base}/oauth/authorize?${new URLSearchParams(params)}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('name="passphrase"');

    const bad = await fetch(`${base}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...params, passphrase: "nope" }) });
    expect(bad.status).toBe(401);

    const ok = await fetch(`${base}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...params, passphrase: PASS }) });
    expect(ok.status).toBe(302);
    const loc = new URL(ok.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get("state")).toBe("st8");
    const code = loc.searchParams.get("code")!;

    // wrong verifier fails and burns the code
    const wrong = await fetch(`${base}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: "grok", code_verifier: b64url(randomBytes(32)) }) });
    expect(wrong.status).toBe(400);

    const ok2 = await fetch(`${base}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...params, passphrase: PASS }) });
    const code2 = new URL(ok2.headers.get("location")!).searchParams.get("code")!;
    const tok = await fetch(`${base}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", code: code2, redirect_uri: REDIRECT, client_id: "grok", code_verifier: verifier }) });
    expect(tok.status).toBe(200);
    const t = await tok.json();
    expect(t).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "mcp" });
    expect(statSync(storePath).mode & 0o777).toBe(0o600);

    // code reuse fails
    const reuse = await fetch(`${base}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", code: code2, redirect_uri: REDIRECT, client_id: "grok", code_verifier: verifier }) });
    expect(reuse.status).toBe(400);

    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${t.access_token}` } } });
    const client = new Client({ name: "oauth-test", version: "0" });
    await client.connect(transport);
    expect((await client.listTools()).tools.length).toBeGreaterThan(10);
    await client.close();

    const ref = await fetch(`${base}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: "grok" }) });
    expect(ref.status).toBe(200);
    const t2 = await ref.json();
    expect(t2.refresh_token).not.toBe(t.refresh_token);
    const again = await fetch(`${base}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token }) });
    expect(again.status).toBe(400);
  });

  it("rate limits failed passphrases", async () => {
    const params = { client_id: "grok", response_type: "code", redirect_uri: REDIRECT, code_challenge: b64url(randomBytes(32)), code_challenge_method: "S256", passphrase: "bad" };
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await fetch(`${base}/oauth/authorize`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "203.0.113.9" }, body: new URLSearchParams(params) });
      codes.push(r.status);
    }
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes[5]).toBe(429);
  });
});
