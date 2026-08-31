/**
 * Pure, deliberately narrow conversion between Anthropic Messages and OpenAI
 * Responses. This is the text/streaming MVP: it rejects a feature it cannot
 * faithfully represent instead of silently dropping tool calls, images,
 * reasoning, structured output, or cached context.
 */

export type AdapterDirection = "anthropicToResponses" | "responsesToAnthropic";
export type AdapterFailure = { status: number; message: string; code: string };
export type AdapterResult<T> = { ok: true; value: T } | { ok: false; error: AdapterFailure };

export type SseEvent = { event: string; data: Record<string, unknown> };

const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(message: string, code = "invalid_request_error", status = 400): AdapterResult<never> {
  return { ok: false, error: { status, message, code } };
}

function textContent(value: unknown, allowed: "anthropic" | "responses"): AdapterResult<string> {
  if (typeof value === "string") return { ok: true, value };
  if (!Array.isArray(value)) return failure("仅支持纯文本内容；图片、文件、工具和推理暂不支持。");
  let text = "";
  for (const block of value) {
    if (!record(block) || typeof block.type !== "string") return failure("内容块格式无效。");
    const supported = allowed === "anthropic" ? block.type === "text" : block.type === "input_text" || block.type === "output_text";
    if (!supported || typeof block.text !== "string") {
      return failure("协议转换基础版仅支持纯文本；工具、图片、文件、推理和引用暂不支持。", "unsupported_feature");
    }
    text += block.text;
  }
  return { ok: true, value: text };
}

function hasUnsupported(recordValue: Record<string, unknown>, names: string[]): string | undefined {
  return names.find((name) => recordValue[name] !== undefined);
}

/** Converts the text-only subset of Anthropic Messages into OpenAI Responses. */
export function anthropicMessagesToResponses(value: unknown): AdapterResult<Record<string, unknown>> {
  if (!record(value)) return failure("Anthropic Messages 请求必须是 JSON 对象。");
  const unsupported = hasUnsupported(value, [
    "tools", "tool_choice", "thinking", "output_config", "context_management", "metadata", "container"
  ]);
  if (unsupported) return failure(`协议转换基础版不支持 ${unsupported}。`, "unsupported_feature");
  const model = typeof value.model === "string" ? value.model.trim() : "";
  const maxTokens = value.max_tokens;
  if (!model || !Number.isInteger(maxTokens) || Number(maxTokens) < 1) {
    return failure("Anthropic Messages 基础转换需要非空 model 和正整数 max_tokens。");
  }
  if (value.stream !== true && value.stream !== false && value.stream !== undefined) return failure("stream 必须是布尔值。");
  const system = value.system;
  const instructions = system === undefined ? undefined : textContent(system, "anthropic");
  if (instructions && !instructions.ok) return instructions;
  if (!Array.isArray(value.messages)) return failure("Anthropic Messages 请求需要 messages 数组。");
  const input: Array<Record<string, unknown>> = [];
  for (const message of value.messages) {
    if (!record(message) || (message.role !== "user" && message.role !== "assistant")) {
      return failure("基础转换仅支持 user 与 assistant 纯文本消息。", "unsupported_feature");
    }
    const text = textContent(message.content, "anthropic");
    if (!text.ok) return text;
    input.push({
      role: message.role,
      content: [{ type: message.role === "user" ? "input_text" : "output_text", text: text.value }]
    });
  }
  return {
    ok: true,
    value: {
      model,
      max_output_tokens: maxTokens,
      stream: value.stream === true,
      ...(instructions && instructions.value ? { instructions: instructions.value } : {}),
      input
    }
  };
}

/** Converts the text-only subset of OpenAI Responses into Anthropic Messages. */
export function responsesToAnthropicMessages(value: unknown): AdapterResult<Record<string, unknown>> {
  if (!record(value)) return failure("OpenAI Responses 请求必须是 JSON 对象。");
  const unsupported = hasUnsupported(value, [
    "tools", "tool_choice", "previous_response_id", "background", "reasoning", "text", "truncation", "include"
  ]);
  if (unsupported) return failure(`协议转换基础版不支持 ${unsupported}。`, "unsupported_feature");
  const model = typeof value.model === "string" ? value.model.trim() : "";
  if (!model) return failure("OpenAI Responses 请求需要非空 model。");
  const maxTokens = value.max_output_tokens === undefined ? DEFAULT_MAX_OUTPUT_TOKENS : value.max_output_tokens;
  if (!Number.isInteger(maxTokens) || Number(maxTokens) < 1) return failure("max_output_tokens 必须是正整数。");
  if (value.stream !== true && value.stream !== false && value.stream !== undefined) return failure("stream 必须是布尔值。");
  const instructions = value.instructions;
  if (instructions !== undefined && typeof instructions !== "string") return failure("基础转换只支持文本 instructions。");
  const rawInput = value.input;
  const items = typeof rawInput === "string"
    ? [{ role: "user", content: [{ type: "input_text", text: rawInput }] }]
    : rawInput;
  if (!Array.isArray(items)) return failure("基础转换需要文本 input 数组或字符串。");
  const messages: Array<Record<string, unknown>> = [];
  for (const item of items) {
    if (!record(item) || (item.role !== "user" && item.role !== "assistant")) {
      return failure("基础转换仅支持 user 与 assistant 纯文本 input。", "unsupported_feature");
    }
    const text = textContent(item.content, "responses");
    if (!text.ok) return text;
    messages.push({ role: item.role, content: text.value });
  }
  return {
    ok: true,
    value: {
      model,
      max_tokens: maxTokens,
      stream: value.stream === true,
      ...(typeof instructions === "string" && instructions ? { system: instructions } : {}),
      messages
    }
  };
}

function responseId(upstreamId: string): string {
  return upstreamId.startsWith("resp_") ? upstreamId : `resp_${upstreamId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

/** Translates a non-streaming plain Anthropic message into a Responses object. */
export function anthropicMessageToResponses(value: unknown): AdapterResult<Record<string, unknown>> {
  if (!record(value) || !Array.isArray(value.content)) return failure("Anthropic 上游响应不是有效 message。", "upstream_protocol_error", 502);
  const text = textContent(value.content, "anthropic");
  if (!text.ok) return text;
  const id = responseId(typeof value.id === "string" ? value.id : "bridge");
  const usage = record(value.usage) ? value.usage : {};
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const stop = value.stop_reason === "max_tokens" ? "incomplete" : "completed";
  return {
    ok: true,
    value: {
      id,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: stop,
      model: typeof value.model === "string" ? value.model : "",
      output: [{
        id: `msg_${id}_0`, type: "message", role: "assistant", status: stop,
        content: [{ type: "output_text", text: text.value, annotations: [] }]
      }],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens }
    }
  };
}

/** Translates a non-streaming plain Responses object into an Anthropic message. */
export function responsesToAnthropicMessage(value: unknown, requestedModel: string): AdapterResult<Record<string, unknown>> {
  if (!record(value) || !Array.isArray(value.output)) return failure("Responses 上游响应不是有效 response。", "upstream_protocol_error", 502);
  let text = "";
  for (const item of value.output) {
    if (!record(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    const content = textContent(item.content, "responses");
    if (!content.ok) return content;
    text += content.value;
  }
  if (!text && value.status === "failed") return failure("Responses 上游请求失败。", "upstream_error", 502);
  const usage = record(value.usage) ? value.usage : {};
  return {
    ok: true,
    value: {
      id: `msg_${typeof value.id === "string" ? value.id.replace(/[^a-zA-Z0-9_-]/g, "_") : "bridge"}`,
      type: "message",
      role: "assistant",
      model: requestedModel,
      content: [{ type: "text", text }],
      stop_reason: value.status === "incomplete" ? "max_tokens" : "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
        output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0
      }
    }
  };
}

export function openAiError(error: AdapterFailure): Record<string, unknown> {
  return { error: { message: error.message, type: error.code } };
}

export function anthropicError(error: AdapterFailure): Record<string, unknown> {
  return { type: "error", error: { type: error.code, message: error.message } };
}

export function formatSse(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
}
