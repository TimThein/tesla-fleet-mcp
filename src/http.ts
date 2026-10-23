import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { env } from "./config.ts";
import { createTeslaServer } from "./server.ts";
import { OAuthProvider, type OAuthOptions } from "./oauth.ts";

export type HttpListen = {
  host: string;
  port: number;
  token: string;
  oauth?: OAuthOptions;
};

function cors(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Accept, mcp-session-id, Last-Event-ID, MCP-Protocol-Version",
  );
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
}

function json(res: ServerResponse, status: number, body: unknown) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function bearerOk(header: string | undefined, expected: string): boolean {
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) return false;
  const got = Buffer.from(header.slice(prefix.length));
  const want = Buffer.from(expected);
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return undefined;
  return JSON.parse(raw);
}

export function httpOptionsFromEnv(): HttpListen {
  const token = env("TESLA_MCP_TOKEN");
  if (!token) throw new Error("Missing TESLA_MCP_TOKEN (required for HTTP MCP)");
  const port = Number(env("TESLA_MCP_PORT", "8787"));
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("TESLA_MCP_PORT must be an integer 0–65535");
  }
  return {
    host: env("TESLA_MCP_HOST", "0.0.0.0"),
    port,
    token,
    oauth: {
      passphraseHashFile: env("TESLA_OAUTH_PASSPHRASE_HASH_FILE", new URL("../oauth-passphrase.hash", import.meta.url).pathname),
      storePath: env("TESLA_OAUTH_STORE", new URL("../oauth-tokens.json", import.meta.url).pathname),
      extraRedirectHosts: (env("TESLA_OAUTH_EXTRA_REDIRECT_HOSTS", "") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    },
  };
}

export function createHttpServer(opts: HttpListen) {
  const oauth = opts.oauth ? new OAuthProvider(opts.oauth) : undefined;
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    cors(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { ok: true, transport: "streamable-http", path: "/mcp" });
      return;
    }

    if (oauth && (url.pathname.startsWith("/oauth/") || url.pathname.startsWith("/.well-known/"))) {
      if (await oauth.handle(req, res, url)) return;
    }

    if (url.pathname !== "/health") { const h = req.headers.authorization; console.log(`[req] ${req.method} ${url.pathname} ua=${(req.headers["user-agent"]||"").slice(0,40)} auth=${h ? h.split(" ")[0] + "(" + (h.length) + ")" : "none"}`); }
    if (url.pathname !== "/mcp") {
      json(res, 404, { jsonrpc: "2.0", error: { code: -32004, message: "Not found" }, id: null });
      return;
    }

    const auth = req.headers.authorization;
    const oauthOk = !!oauth && !!auth?.startsWith("Bearer ") && oauth.validateAccessToken(auth.slice(7));
    if (!bearerOk(auth, opts.token) && !oauthOk) {
      res.setHeader(
        "WWW-Authenticate",
        oauth
          ? `Bearer resource_metadata="${OAuthProvider.issuer(req)}/.well-known/oauth-protected-resource"`
          : "Bearer",
      );
      console.log(`[req] 401 on /mcp oauthOk=${oauthOk}`);
      json(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      json(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
      return;
    }

    if (req.method !== "POST") {
      json(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
      return;
    }

    const server = createTeslaServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      const body = await readJson(req);
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) {
        json(res, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: e instanceof Error ? e.message : "Internal server error" },
          id: null,
        });
      }
    } finally {
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
    }
  });
}

export async function serveHttp(opts: HttpListen = httpOptionsFromEnv()): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const httpServer = createHttpServer(opts);
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, opts.host, () => resolve());
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : opts.port;
  const displayHost = opts.host === "0.0.0.0" || opts.host === "::" ? "127.0.0.1" : opts.host;
  const url = `http://${displayHost}:${port}/mcp`;
  console.error(`tesla MCP Streamable HTTP on ${url}`);
  return {
    url,
    close: () =>
      new Promise((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
