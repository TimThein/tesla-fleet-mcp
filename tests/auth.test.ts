import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireToken } from "../src/auth.ts";

describe("acquireToken", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shares one refresh across concurrent callers and writes the cache atomically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tesla-auth-"));
    const cache = join(dir, "token-cache.json");
    process.env.TESLA_CACHE_PATH = cache;
    process.env.TESLA_CLIENT_ID = "test-client";
    writeFileSync(cache, JSON.stringify({ access_token: "old", refresh_token: "r1", expires_at: 0 }));
    const fetchMock = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ access_token: "new", refresh_token: "r2", expires_in: 3600 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await Promise.all([acquireToken(), acquireToken(), acquireToken()]);
    expect(tokens).toEqual(["new", "new", "new"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(cache, "utf8")).refresh_token).toBe("r2");
    expect(readdirSync(dir)).toEqual(["token-cache.json"]);

    expect(await acquireToken()).toBe("new");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
