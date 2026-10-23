import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { serveHttp } from "../src/http.ts";

const TOKEN = "test-tesla-mcp-token";
const VIN = "UNITTESTVIN000001";

type Captured = { method: string; url: string; body: string };

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
  origin: string;
  close: () => Promise<void>;
}> {
  const httpServer = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = httpServer.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function jsonOk(_req: IncomingMessage, res: ServerResponse, extra?: unknown) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(extra ?? { response: { result: true, reason: "" } }));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("command proxy routing", () => {
  const restore: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (restore.length) await restore.pop()?.();
  });

  function stashEnv(name: string, value: string | undefined) {
    const prev = process.env[name];
    restore.push(() => {
      if (prev === undefined) delete process.env[name];
      else process.env[name] = prev;
    });
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  function fakeCache() {
    const dir = mkdtempSync(join(tmpdir(), "tesla-mcp-"));
    restore.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "token-cache.json");
    writeFileSync(
      path,
      JSON.stringify({
        access_token: "test-access",
        refresh_token: "test-refresh",
        expires_at: Date.now() + 60 * 60 * 1000,
      }),
    );
    stashEnv("TESLA_CACHE_PATH", path);
    stashEnv("TESLA_VIN", VIN);
    return path;
  }

  async function withMcp(fn: (client: Client) => Promise<void>) {
    const mcp = await serveHttp({ host: "127.0.0.1", port: 0, token: TOKEN });
    const transport = new StreamableHTTPClientTransport(new URL(mcp.url), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    const client = new Client({ name: "tesla-command-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      await fn(client);
    } finally {
      await client.close();
      await mcp.close();
    }
  }

  it("errors when a proxy-required tool has no TESLA_COMMAND_BASE", async () => {
    fakeCache();
    stashEnv("TESLA_COMMAND_BASE", undefined);
    await withMcp(async (client) => {
      const result = await client.callTool({ name: "honk_horn", arguments: {} });
      expect(result).toMatchObject({ isError: true });
      const text = (result.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
      expect(text).toMatch(/TESLA_COMMAND_BASE/);
    });
  });

  it("posts signed commands at TESLA_COMMAND_BASE", async () => {
    fakeCache();
    const captured: Captured[] = [];
    const proxy = await listen(async (req, res) => {
      captured.push({ method: req.method ?? "", url: req.url ?? "", body: await readBody(req) });
      jsonOk(req, res);
    });
    restore.push(() => proxy.close());
    stashEnv("TESLA_COMMAND_BASE", proxy.origin);

    await withMcp(async (client) => {
      const honk = await client.callTool({ name: "honk_horn", arguments: {} });
      expect(honk.isError).toBeUndefined();
      expect(captured.at(-1)).toMatchObject({
        method: "POST",
        url: `/api/1/vehicles/${VIN}/command/honk_horn`,
      });
      expect(captured.at(-1)?.body).toBe("{}");

      const amps = await client.callTool({
        name: "set_charging_amps",
        arguments: { charging_amps: 16 },
      });
      expect(amps.isError).toBeUndefined();
      expect(captured.at(-1)).toMatchObject({
        method: "POST",
        url: `/api/1/vehicles/${VIN}/command/set_charging_amps`,
      });
      expect(JSON.parse(captured.at(-1)?.body ?? "")).toEqual({ charging_amps: 16 });

      const trunk = await client.callTool({
        name: "actuate_trunk",
        arguments: { which_trunk: "front" },
      });
      expect(trunk.isError).toBeUndefined();
      expect(JSON.parse(captured.at(-1)?.body ?? "")).toEqual({ which_trunk: "front" });
    });
  });

  it("sends reads to TESLA_FLEET_BASE, not the command proxy", async () => {
    fakeCache();
    const fleetHits: Captured[] = [];
    const proxyHits: Captured[] = [];
    const fleet = await listen(async (req, res) => {
      fleetHits.push({ method: req.method ?? "", url: req.url ?? "", body: await readBody(req) });
      jsonOk(req, res, { response: [{ display_name: "unit" }] });
    });
    const proxy = await listen(async (req, res) => {
      proxyHits.push({ method: req.method ?? "", url: req.url ?? "", body: await readBody(req) });
      jsonOk(req, res);
    });
    restore.push(() => fleet.close());
    restore.push(() => proxy.close());
    stashEnv("TESLA_FLEET_BASE", fleet.origin);
    stashEnv("TESLA_COMMAND_BASE", proxy.origin);

    await withMcp(async (client) => {
      const listed = await client.callTool({ name: "vehicles_list", arguments: {} });
      expect(listed.isError).toBeUndefined();
      expect(fleetHits).toEqual([{ method: "GET", url: "/api/1/vehicles", body: "" }]);
      expect(proxyHits).toEqual([]);

      const enabled = await client.callTool({ name: "mobile_enabled", arguments: {} });
      expect(enabled.isError).toBeUndefined();
      expect(fleetHits.at(-1)).toMatchObject({
        method: "GET",
        url: `/api/1/vehicles/${VIN}/mobile_enabled`,
      });
    });
  });

  it("builds energy history queries against TESLA_FLEET_BASE", async () => {
    fakeCache();
    const captured: Captured[] = [];
    const fleetApi = await listen(async (req, res) => {
      captured.push({ method: req.method ?? "", url: req.url ?? "", body: await readBody(req) });
      jsonOk(req, res, { response: {} });
    });
    restore.push(() => fleetApi.close());
    stashEnv("TESLA_FLEET_BASE", fleetApi.origin);

    await withMcp(async (client) => {
      const cal = await client.callTool({
        name: "get_energy_calendar_history",
        arguments: { energy_site_id: 123, kind: "soe", period: "day", start_date: "2026-01-01T00:00:00Z" },
      });
      expect(cal.isError).toBeUndefined();
      expect(captured.at(-1)).toMatchObject({
        method: "GET",
        url: "/api/1/energy_sites/123/calendar_history?kind=soe&start_date=2026-01-01T00%3A00%3A00Z&period=day",
      });

      const tel = await client.callTool({ name: "get_energy_telemetry_history", arguments: { energy_site_id: "123" } });
      expect(tel.isError).toBeUndefined();
      expect(captured.at(-1)?.url).toBe("/api/1/energy_sites/123/telemetry_history?kind=charge");
    });
  });
});
