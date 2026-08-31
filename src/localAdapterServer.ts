/**
 * Loopback-only bidirectional protocol adapter server.
 *
 * Bindings are resolved by the extension host, which retains all upstream
 * credentials in Secret Storage. The local client authenticates with a distinct
 * per-binding token, so another process on the same machine cannot turn this
 * extension into an unauthenticated relay for the user's paid upstream key.
 */
import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";
import {
  AdapterDirection,
  anthropicError,
  anthropicMessageToResponses,
  anthropicMessagesToResponses,
  formatSse,
  openAiError,
  responsesToAnthropicMessage,
  responsesToAnthropicMessages,
  type AdapterFailure
} from "./protocolAdapter";

export type AdapterBindingTarget = {
  direction: AdapterDirection;
  upstreamBaseUrl: string;
  upstreamToken: string;
  localToken: string;
  models: string[];
};

export type LocalAdapterServer = {
  port: number;
  stop(): void;
  bindWarning?: string;
};

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"]);

function record(value: unknown): value is Record<string, unknown> {
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
        reject(new Error("请求体超过协议转换器的 16MB 限制"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function tokenFrom(headers: http.IncomingHttpHeaders): string {
  const authorization = Array.isArray(headers.authorization) ? headers.authorization[0] : headers.authorization;
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const apiKey = Array.isArray(headers["x-api-key"]) ? headers["x-api-key"][0] : headers["x-api-key"];
  return (bearer ?? apiKey ?? "").trim();
}

function writeError(res: http.ServerResponse, direction: AdapterDirection, error: AdapterFailure): void {
  res.writeHead(error.status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(direction === "anthropicToResponses" ? anthropicError(error) : openAiError(error)));
}

function headersForUpstream(body: Buffer, token: string, direction: AdapterDirection): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "content-length": body.length
  };
  // Send one authentication scheme matching the protocol. Some relays reject
  // duplicate Bearer + x-api-key headers as ambiguous authentication.
  if (direction === "anthropicToResponses") {
    headers.authorization = `Bearer ${token}`;
  } else {
    headers["x-api-key"] = token;
    headers["anthropic-version"] = "2023-06-01";
  }
  return headers;
}

function parseSseFrame(frame: string): { event: string; data: Record<string, unknown> } | undefined {
  const lines = frame.replace(/\r/g, "").split("\n");
  const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message";
  const dataText = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
  if (!dataText || dataText === "[DONE]") return undefined;
  try {
    const data = JSON.parse(dataText) as unknown;
    return record(data) ? { event, data } : undefined;
  } catch {
    return undefined;
  }
}

function responseEvent(res: http.ServerResponse, event: string, data: Record<string, unknown>): void {
  res.write(formatSse(event, data));
}

function anthropicStreamToResponses(upstream: http.IncomingMessage, res: http.ServerResponse): void {
  let buffer = "";
  let response: Record<string, unknown> | undefined;
  let item: Record<string, unknown> | undefined;
  let text = "";
  let terminal = false;
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
  const fail = (message: string) => {
    if (terminal) return;
    terminal = true;
    responseEvent(res, "response.failed", { response: { ...(response ?? {}), status: "failed", error: { message, type: "upstream_protocol_error" } } });
    res.end();
  };
  upstream.setEncoding("utf8");
  upstream.on("data", (chunk: string) => {
    buffer += chunk;
    let divider: number;
    while ((divider = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const separator = buffer.match(/^([\s\S]*?)(\r?\n\r?\n)/);
      if (!separator) break;
      const frame = parseSseFrame(separator[1]);
      buffer = buffer.slice(separator[0].length);
      if (!frame || terminal) continue;
      const { event, data } = frame;
      if (event === "message_start") {
        const source = record(data.message) ? data.message : {};
        const id = `resp_${String(source.id ?? "bridge").replace(/[^a-zA-Z0-9_-]/g, "_")}`;
        response = { id, object: "response", created_at: Math.floor(Date.now() / 1000), status: "in_progress", model: source.model ?? "", output: [] };
        responseEvent(res, "response.created", { response });
        responseEvent(res, "response.in_progress", { response });
      } else if (event === "content_block_start") {
        const block = record(data.content_block) ? data.content_block : {};
        if (block.type !== "text") { fail("协议转换基础版不支持上游的非文本内容块。"); continue; }
        const responseId = String(response?.id ?? "resp_bridge");
        item = { id: `msg_${responseId}_0`, type: "message", role: "assistant", status: "in_progress", content: [{ type: "output_text", text: "", annotations: [] }] };
        const initialPart = { type: "output_text", text: "", annotations: [] };
        responseEvent(res, "response.output_item.added", { item, output_index: 0 });
        responseEvent(res, "response.content_part.added", { part: initialPart, item_id: item.id, output_index: 0, content_index: 0 });
      } else if (event === "content_block_delta") {
        const delta = record(data.delta) ? data.delta : {};
        if (delta.type !== "text_delta" || typeof delta.text !== "string") { fail("协议转换基础版不支持上游的非文本增量。"); continue; }
        text += delta.text;
        responseEvent(res, "response.output_text.delta", { delta: delta.text, item_id: item?.id ?? "msg_bridge_0", output_index: 0, content_index: 0 });
      } else if (event === "content_block_stop") {
        if (!item) continue;
        const part = { type: "output_text", text, annotations: [] };
        responseEvent(res, "response.output_text.done", { text, item_id: item.id, output_index: 0, content_index: 0 });
        responseEvent(res, "response.content_part.done", { part, item_id: item.id, output_index: 0, content_index: 0 });
        responseEvent(res, "response.output_item.done", { item: { ...item, status: "completed", content: [part] }, output_index: 0 });
      } else if (event === "message_delta") {
        const delta = record(data.delta) ? data.delta : {};
        if (delta.stop_reason === "tool_use" || delta.stop_reason === "pause_turn" || delta.stop_reason === "refusal") fail(`协议转换基础版不支持上游 stop_reason=${String(delta.stop_reason)}。`);
        if (response && record(data.usage)) response.usage = data.usage;
        if (delta.stop_reason === "max_tokens" && response) response.status = "incomplete";
      } else if (event === "message_stop") {
        if (terminal) continue;
        terminal = true;
        const status = response?.status === "incomplete" ? "incomplete" : "completed";
        responseEvent(res, status === "completed" ? "response.completed" : "response.incomplete", { response: { ...(response ?? {}), status, output: item ? [{ ...item, status: "completed", content: [{ type: "output_text", text, annotations: [] }] }] : [] } });
        res.end();
      } else if (event === "error") {
        fail(String(record(data.error) ? data.error.message ?? "上游返回错误" : "上游返回错误"));
      }
    }
  });
  upstream.on("end", () => { if (!terminal) fail("上游流在完成事件前断开。"); });
  upstream.on("error", () => fail("读取上游流失败。"));
}

function responsesStreamToAnthropic(upstream: http.IncomingMessage, res: http.ServerResponse, model: string): void {
  let buffer = "";
  let started = false;
  let blockStarted = false;
  let terminal = false;
  const messageId = `msg_bridge_${Date.now()}`;
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
  const emit = (event: string, data: Record<string, unknown>) => responseEvent(res, event, data);
  const start = () => {
    if (started) return;
    started = true;
    emit("message_start", { message: { id: messageId, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  };
  const block = () => {
    start();
    if (blockStarted) return;
    blockStarted = true;
    emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  };
  const finish = (reason: string) => {
    if (terminal) return;
    terminal = true;
    if (blockStarted) emit("content_block_stop", { index: 0 });
    start();
    emit("message_delta", { delta: { stop_reason: reason, stop_sequence: null }, usage: { input_tokens: 0, output_tokens: 0 } });
    emit("message_stop", {});
    res.end();
  };
  const fail = (message: string) => {
    if (terminal) return;
    terminal = true;
    emit("error", { error: { type: "api_error", message } });
    res.end();
  };
  upstream.setEncoding("utf8");
  upstream.on("data", (chunk: string) => {
    buffer += chunk;
    let divider: number;
    while ((divider = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const separator = buffer.match(/^([\s\S]*?)(\r?\n\r?\n)/);
      if (!separator) break;
      const frame = parseSseFrame(separator[1]);
      buffer = buffer.slice(separator[0].length);
      if (!frame || terminal) continue;
      const { event, data } = frame;
      if (event === "response.created" || event === "response.in_progress") start();
      else if (event === "response.content_part.added") block();
      else if (event === "response.output_text.delta") {
        if (typeof data.delta !== "string") { fail("Responses 上游返回无效文本增量。"); continue; }
        block();
        emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: data.delta } });
      } else if (event === "response.completed") finish("end_turn");
      else if (event === "response.incomplete") finish("max_tokens");
      else if (event === "response.failed" || event === "error") fail("Responses 上游请求失败。");
    }
  });
  upstream.on("end", () => { if (!terminal) fail("上游流在完成事件前断开。"); });
  upstream.on("error", () => fail("读取上游流失败。"));
}

function forward(
  target: AdapterBindingTarget,
  direction: AdapterDirection,
  translated: Record<string, unknown>,
  requestedModel: string,
  res: http.ServerResponse
): void {
  const upstream = new URL(target.upstreamBaseUrl);
  const path = `${upstream.pathname.replace(/\/$/, "")}${direction === "anthropicToResponses" ? "/v1/responses" : "/v1/messages"}`;
  const body = Buffer.from(JSON.stringify(translated), "utf8");
  const transport = upstream.protocol === "http:" ? http : https;
  const req = transport.request({ hostname: upstream.hostname, port: upstream.port || (upstream.protocol === "https:" ? 443 : 80), path, method: "POST", headers: headersForUpstream(body, target.upstreamToken, direction) }, (upstreamRes) => {
    const stream = translated.stream === true;
    if ((upstreamRes.statusCode ?? 0) < 200 || (upstreamRes.statusCode ?? 0) >= 300) {
      let errorBody = "";
      upstreamRes.setEncoding("utf8");
      upstreamRes.on("data", (chunk: string) => { errorBody += chunk; });
      upstreamRes.on("end", () => writeError(res, direction, { status: upstreamRes.statusCode ?? 502, code: "upstream_error", message: errorBody.slice(0, 500) || "上游请求失败。" }));
      return;
    }
    if (stream) {
      if (direction === "anthropicToResponses") responsesStreamToAnthropic(upstreamRes, res, requestedModel);
      else anthropicStreamToResponses(upstreamRes, res);
      return;
    }
    const chunks: Buffer[] = [];
    upstreamRes.on("data", (chunk: Buffer) => chunks.push(chunk));
    upstreamRes.on("end", () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const converted = direction === "anthropicToResponses"
          ? responsesToAnthropicMessage(value, requestedModel)
          : anthropicMessageToResponses(value);
        if (!converted.ok) return writeError(res, direction, converted.error);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(converted.value));
      } catch {
        writeError(res, direction, { status: 502, code: "upstream_protocol_error", message: "上游响应不是有效 JSON。" });
      }
    });
  });
  req.on("error", () => writeError(res, direction, { status: 502, code: "connection_error", message: "无法连接协议转换器的上游服务。" }));
  req.setTimeout(30000, () => { req.destroy(); writeError(res, direction, { status: 504, code: "timeout", message: "协议转换器连接上游服务超时。" }); });
  req.end(body);
}

export function startLocalAdapterServer(options: {
  port: number;
  resolve: (bindingId: string, target: "claude" | "codex") => AdapterBindingTarget | undefined;
}): Promise<LocalAdapterServer> {
  const server = http.createServer((req, res) => {
    void (async () => {
      const match = (req.url ?? "").match(/^\/(claude|codex)\/([A-Za-z0-9_-]+)\/v1\/(messages|responses|models)$/);
      if (!match) { res.writeHead(404).end(); return; }
      const [, targetClient, bindingId, endpoint] = match;
      const target = options.resolve(bindingId, targetClient as "claude" | "codex");
      if (!target) return writeError(res, targetClient === "claude" ? "anthropicToResponses" : "responsesToAnthropic", { status: 503, code: "configuration_error", message: "本地协议绑定不存在或其上游服务不可用。" });
      const direction = target.direction;
      if (tokenFrom(req.headers) !== target.localToken) return writeError(res, direction, { status: 401, code: "authentication_error", message: "本地协议转换凭据无效。" });
      if (endpoint === "models" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ object: "list", data: target.models.map((id) => ({ id, object: "model" })) }));
        return;
      }
      if (req.method !== "POST" || (targetClient === "claude" ? endpoint !== "messages" : endpoint !== "responses")) { res.writeHead(404).end(); return; }
      let body: unknown;
      try { body = JSON.parse((await readBody(req)).toString("utf8")); } catch { return writeError(res, direction, { status: 400, code: "invalid_request_error", message: "请求不是有效 JSON。" }); }
      const converted = direction === "anthropicToResponses" ? anthropicMessagesToResponses(body) : responsesToAnthropicMessages(body);
      if (!converted.ok) return writeError(res, direction, converted.error);
      const model = record(body) && typeof body.model === "string" ? body.model : "";
      forward(target, direction, converted.value, model, res);
    })().catch((error) => writeError(res, "anthropicToResponses", { status: 500, code: "internal_error", message: error instanceof Error ? error.message : "协议转换器内部错误。" }));
  });
  return new Promise((resolve, reject) => {
    server.on("error", (error: NodeJS.ErrnoException) => reject(error));
    server.listen(options.port, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      resolve({ port, stop: () => server.close() });
    });
  });
}
