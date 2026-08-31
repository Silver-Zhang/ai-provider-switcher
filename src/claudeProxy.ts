/**
 * A local model-name rewriting forwarder for Claude Desktop.
 *
 * Claude Desktop rejects any third-party `inferenceModels` entry whose name does
 * not read as an Anthropic route, so a relay serving `gpt-5.6` is only reachable
 * through a Claude alias. This proxy sits on 127.0.0.1, receives the request
 * Claude Desktop would otherwise send straight to the relay, rewrites `model`
 * from the alias back to the real ID, and forwards it. Method, path, headers and
 * the streamed response all pass through untouched, so streaming and non-streaming
 * replies work without this module ever parsing them.
 *
 * Deliberately minimal: one hop, one rewrite, no failover, no routing, no
 * billing. It exists because the extension cannot make Claude Desktop send a
 * foreign model name directly.
 */
import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";

export type ClaudeProxyTarget = { baseUrl: string; model: string };

export type ClaudeProxy = {
  port: number;
  stop(): void;
  /** Set when the configured port was taken and an ephemeral one was used instead. */
  bindWarning?: string;
};

const MAX_BODY_BYTES = 16 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("请求体过大"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Hop-by-hop headers must not be copied across the hop.
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"
]);

function forwardedHeaders(
  headers: http.IncomingHttpHeaders,
  host: string,
  length: number
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  out.host = host;
  out["content-length"] = length;
  return out;
}

function describeUpstreamFailure(error: NodeJS.ErrnoException, url: URL): string {
  const code = error.code ?? "";
  const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  if (code === "ECONNREFUSED") return `${host} 拒绝连接：请确认中转站已启动、端口正确`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `无法解析域名 ${url.hostname}`;
  if (code === "ETIMEDOUT") return `连接 ${host} 超时`;
  return `无法连接到 ${host}${code ? `（${code}）` : ""}`;
}

/**
 * Starts the proxy. `resolve` maps a model name to the upstream it must be
 * rewritten for; returning `undefined` means there is no live desktop provider
 * to forward to. Binds 127.0.0.1 only — the proxy is never meant to leave the
 * machine, and a remote window's host cannot be reached by the local app anyway.
 */
export function startClaudeProxy(options: {
  port: number;
  resolve: (model: string) => ClaudeProxyTarget | undefined;
}): Promise<ClaudeProxy> {
  const { resolve } = options;
  const server = http.createServer((req, res) => {
    void handle(req, res, resolve);
  });

  const handle = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    resolve: (model: string) => ClaudeProxyTarget | undefined
  ): Promise<void> => {
    try {
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = raw.length === 0 ? undefined : JSON.parse(raw.toString("utf8"));
      } catch {
        parsed = undefined;
      }
      const model = isRecord(parsed) && typeof parsed.model === "string" ? parsed.model : undefined;
      if (model === undefined) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("本地改写代理仅转发包含 model 的 Anthropic Messages 请求。");
        return;
      }
      const target = resolve(model);
      if (!target) {
        res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
        res.end("当前没有生效的 Claude Desktop 中转站，无法转发。");
        return;
      }
      const upstream = new URL(target.baseUrl);
      const body = Buffer.from(
        JSON.stringify({ ...(parsed as Record<string, unknown>), model: target.model }),
        "utf8"
      );
      // The forward target mirrors what Claude Desktop does in direct mode:
      // `baseUrl` (trailing slash trimmed) + the incoming path and query.
      const basePath = upstream.pathname.replace(/\/$/, "");
      const incoming = req.url ?? "/";
      const upstreamPath = basePath + (incoming.startsWith("/") ? incoming : `/${incoming}`);
      const transport = upstream.protocol === "http:" ? http : https;
      const upstreamReq = transport.request(
        {
          hostname: upstream.hostname,
          port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
          path: upstreamPath,
          method: req.method ?? "POST",
          headers: forwardedHeaders(req.headers, upstream.host, body.length)
        },
        (upstreamRes) => {
          const headers = { ...upstreamRes.headers } as http.OutgoingHttpHeaders;
          delete headers["transfer-encoding"];
          delete headers["connection"];
          res.writeHead(upstreamRes.statusCode ?? 502, headers);
          upstreamRes.pipe(res);
        }
      );
      upstreamReq.on("error", (error) => {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end(`转发失败：${describeUpstreamFailure(error, upstream)}`);
      });
      upstreamReq.end(body);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? error.message : "请求处理失败");
    }
  };

  return new Promise((resolveStart, rejectStart) => {
    server.on("error", (error) => rejectStart(error));
    server.listen(options.port, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      resolveStart({
        port,
        stop() {
          server.close();
        }
      });
    });
  });
}
