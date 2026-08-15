import { normalizeProviderRootUrl } from "./codexConfig";

/**
 * Where a provider might serve its model list. A Base URL that already carries a
 * path (`https://api.deepseek.com/anthropic`) has no `/v1/models` beneath it, but
 * the same host usually serves one at the root, so the origin is tried too.
 */
export function getGatewayModelEndpoints(baseUrl: string): string[] {
  const root = normalizeProviderRootUrl(baseUrl);
  const candidates = [`${root}/v1/models`, `${root}/models`];
  try {
    const origin = new URL(root).origin;
    if (origin !== root) candidates.push(`${origin}/v1/models`, `${origin}/models`);
  } catch {
    // An unparsable Base URL is reported by the request itself.
  }
  return candidates.filter((value, index) => candidates.indexOf(value) === index);
}

/** The server's own explanation, which usually names the real problem. */
export function describeGatewayModelFailure(status: number, body: string): string {
  const text = body.trim();
  if (!text) return `HTTP ${status}`;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown };
    const message = parsed.error?.message ?? parsed.message;
    if (typeof message === "string" && message.trim()) return `HTTP ${status}：${message.trim()}`;
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return `HTTP ${status}：${text.slice(0, 200)}`;
}

/** A 404 only means "not at this path", so the endpoint search may continue. */
export function isGatewayModelPathMiss(message: string): boolean {
  return /^HTTP 404/.test(message);
}

/** The `data[].id` list an OpenAI-shaped `/models` response carries. */
export function parseGatewayModelList(body: string): string[] {
  const parsed = JSON.parse(body) as { data?: Array<{ id?: unknown }> };
  const models = (parsed.data ?? []).map((item) => String(item.id ?? "").trim()).filter(Boolean);
  return [...new Set(models)].sort();
}
