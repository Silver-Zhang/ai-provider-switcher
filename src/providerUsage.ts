import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";

export type ProviderUsageConfiguration = {
  endpoint: string;
  balanceRemainingPath?: string;
  balanceUsedPath?: string;
  currencyPath?: string;
  fiveHourUsedPercentPath?: string;
  fiveHourRemainingPercentPath?: string;
  fiveHourResetPath?: string;
  weeklyUsedPercentPath?: string;
  weeklyRemainingPercentPath?: string;
  weeklyResetPath?: string;
};

export type ProviderUsageWindow = {
  name: "5 小时" | "周";
  usedPercent?: number;
  remainingPercent?: number;
  resetsAt?: string;
};

export type ProviderRateLimit = {
  resource: "requests" | "tokens";
  limit?: number;
  remaining?: number;
  reset?: string;
};

export type ProviderUsageSnapshot = {
  providerId: string;
  providerKind: "claude" | "codex";
  fetchedAt: string;
  source: "usageApi" | "responseHeaders";
  balance?: { remaining?: number; used?: number; currency?: string };
  windows: ProviderUsageWindow[];
  rateLimits: ProviderRateLimit[];
};

type HeaderValues = Record<string, string | string[] | undefined>;

const AUTOMATIC_PATHS = {
  balanceRemaining: ["balance.remaining", "quota.balance.remaining", "data.balance.remaining", "remaining_balance", "balance"],
  balanceUsed: ["balance.used", "quota.balance.used", "data.balance.used", "used_balance", "total_usage"],
  currency: ["balance.currency", "quota.balance.currency", "data.balance.currency", "currency"],
  fiveHourUsed: ["quota.five_hour.used_percent", "five_hour.used_percent", "fiveHour.usedPercent", "data.five_hour.used_percent"],
  fiveHourRemaining: ["quota.five_hour.remaining_percent", "five_hour.remaining_percent", "fiveHour.remainingPercent", "data.five_hour.remaining_percent"],
  fiveHourReset: ["quota.five_hour.reset_at", "five_hour.reset_at", "fiveHour.resetAt", "data.five_hour.reset_at"],
  weeklyUsed: ["quota.weekly.used_percent", "weekly.used_percent", "week.used_percent", "data.weekly.used_percent"],
  weeklyRemaining: ["quota.weekly.remaining_percent", "weekly.remaining_percent", "week.remaining_percent", "data.weekly.remaining_percent"],
  weeklyReset: ["quota.weekly.reset_at", "weekly.reset_at", "week.reset_at", "data.weekly.reset_at"]
} as const;

export function normalizeUsageConfiguration(value: unknown): ProviderUsageConfiguration | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const endpoint = String(record.endpoint ?? "").trim();
  if (!endpoint) return undefined;
  const result: ProviderUsageConfiguration = { endpoint };
  for (const key of [
    "balanceRemainingPath", "balanceUsedPath", "currencyPath",
    "fiveHourUsedPercentPath", "fiveHourRemainingPercentPath", "fiveHourResetPath",
    "weeklyUsedPercentPath", "weeklyRemainingPercentPath", "weeklyResetPath"
  ] as const) {
    const path = String(record[key] ?? "").trim();
    if (path) result[key] = path;
  }
  return result;
}

export function validateUsageEndpoint(value: string): string {
  const endpoint = new URL(value.trim());
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new Error("额度地址必须以 http:// 或 https:// 开头");
  }
  if (endpoint.username || endpoint.password) throw new Error("额度地址不能包含用户名或密码");
  return endpoint.toString();
}

export function getJsonPathValue(value: unknown, path: string): unknown {
  const normalized = path.trim().replace(/\[(\d+)\]/g, ".$1").replace(/^\$\.?/, "");
  if (!normalized) return value;
  return normalized.split(".").filter(Boolean).reduce<unknown>((current, segment) => {
    if (segment === "__proto__" || segment === "prototype" || segment === "constructor") return undefined;
    if (Array.isArray(current) && /^\d+$/.test(segment)) return current[Number(segment)];
    if (current && typeof current === "object") return (current as Record<string, unknown>)[segment];
    return undefined;
  }, value);
}

export function parseProviderUsage(
  providerId: string,
  providerKind: "claude" | "codex",
  body: string,
  headers: HeaderValues,
  configuration?: ProviderUsageConfiguration,
  fetchedAt = new Date().toISOString()
): ProviderUsageSnapshot {
  let payload: unknown;
  if (body.trim()) {
    try {
      payload = JSON.parse(body);
    } catch {
      if (configuration) {
        const trimmed = body.trim().toLowerCase();
        if (trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html") || trimmed.includes("<html")) {
          throw new Error("额度接口返回了 HTML，而不是 JSON（可能是登录页、反向代理错误页或错误 endpoint）");
        }
        throw new Error("额度接口返回的内容不是有效 JSON");
      }
    }
  }

  const value = (configuredPath: string | undefined, automaticPaths: readonly string[]): unknown => {
    if (configuredPath) return getJsonPathValue(payload, configuredPath);
    for (const path of automaticPaths) {
      const candidate = getJsonPathValue(payload, path);
      if (candidate !== undefined && candidate !== null && candidate !== "") return candidate;
    }
    return undefined;
  };

  const balanceRemaining = toFiniteNumber(value(configuration?.balanceRemainingPath, AUTOMATIC_PATHS.balanceRemaining));
  const balanceUsed = toFiniteNumber(value(configuration?.balanceUsedPath, AUTOMATIC_PATHS.balanceUsed));
  const currencyValue = value(configuration?.currencyPath, AUTOMATIC_PATHS.currency);
  const currency = currencyValue === undefined ? undefined : String(currencyValue).trim() || undefined;
  const balance = balanceRemaining !== undefined || balanceUsed !== undefined || currency
    ? { remaining: balanceRemaining, used: balanceUsed, currency }
    : undefined;

  const windows: ProviderUsageWindow[] = [];
  addWindow(windows, "5 小时",
    toPercent(value(configuration?.fiveHourUsedPercentPath, AUTOMATIC_PATHS.fiveHourUsed)),
    toPercent(value(configuration?.fiveHourRemainingPercentPath, AUTOMATIC_PATHS.fiveHourRemaining)),
    toOptionalString(value(configuration?.fiveHourResetPath, AUTOMATIC_PATHS.fiveHourReset))
  );
  addWindow(windows, "周",
    toPercent(value(configuration?.weeklyUsedPercentPath, AUTOMATIC_PATHS.weeklyUsed)),
    toPercent(value(configuration?.weeklyRemainingPercentPath, AUTOMATIC_PATHS.weeklyRemaining)),
    toOptionalString(value(configuration?.weeklyResetPath, AUTOMATIC_PATHS.weeklyReset))
  );

  const rateLimits = parseRateLimits(headers);
  return {
    providerId,
    providerKind,
    fetchedAt,
    source: configuration ? "usageApi" : "responseHeaders",
    balance,
    windows,
    rateLimits
  };
}

export function hasProviderUsage(snapshot: ProviderUsageSnapshot): boolean {
  return Boolean(snapshot.balance || snapshot.windows.length || snapshot.rateLimits.length);
}

export function formatProviderUsageSummary(snapshot: ProviderUsageSnapshot | undefined): string {
  if (!snapshot) return "额度：尚未刷新";
  const parts: string[] = [];
  for (const window of snapshot.windows) {
    if (window.remainingPercent !== undefined) parts.push(`${window.name}剩余 ${formatNumber(window.remainingPercent)}%`);
    else if (window.usedPercent !== undefined) parts.push(`${window.name}已用 ${formatNumber(window.usedPercent)}%`);
  }
  if (snapshot.balance?.remaining !== undefined) {
    parts.push(`余额 ${snapshot.balance.currency ?? ""}${formatNumber(snapshot.balance.remaining)}`.replace(/\s+/g, " "));
  } else if (snapshot.balance?.used !== undefined) {
    parts.push(`已用 ${snapshot.balance.currency ?? ""}${formatNumber(snapshot.balance.used)}`.replace(/\s+/g, " "));
  }
  for (const limit of snapshot.rateLimits) {
    if (limit.remaining !== undefined) parts.push(`${limit.resource === "requests" ? "请求" : "Token"}剩余 ${formatNumber(limit.remaining)}`);
  }
  return parts.length ? parts.join(" · ") : "额度：未识别到兼容数据";
}

export function requestProviderUsage(
  endpointValue: string,
  token: string,
  providerId: string,
  providerKind: "claude" | "codex",
  configuration?: ProviderUsageConfiguration
): Promise<ProviderUsageSnapshot> {
  const endpoint = new URL(endpointValue);
  const transport = endpoint.protocol === "http:" ? http : https;
  return new Promise((resolve, reject) => {
    const request = transport.request(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(providerKind === "claude" ? { "x-api-key": token, "anthropic-version": "2023-06-01" } : {})
      }
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
        if (Buffer.byteLength(body, "utf8") > 1024 * 1024) {
          request.destroy(new Error("额度接口响应超过 1 MiB 限制"));
        }
      });
      response.on("end", () => {
        if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
          reject(new Error(`额度请求返回 HTTP ${response.statusCode ?? "unknown"}`));
          return;
        }
        try {
          resolve(parseProviderUsage(providerId, providerKind, body, response.headers, configuration));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", () => reject(new Error("无法连接到额度接口")));
    request.setTimeout(15000, () => {
      request.destroy();
      reject(new Error("额度请求超时"));
    });
    request.end();
  });
}

function parseRateLimits(headers: HeaderValues): ProviderRateLimit[] {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value[0] : value]));
  const result: ProviderRateLimit[] = [];
  for (const resource of ["requests", "tokens"] as const) {
    const limit = toFiniteNumber(normalized.get(`x-ratelimit-limit-${resource}`));
    const remaining = toFiniteNumber(normalized.get(`x-ratelimit-remaining-${resource}`));
    const reset = toOptionalString(normalized.get(`x-ratelimit-reset-${resource}`));
    if (limit !== undefined || remaining !== undefined || reset) result.push({ resource, limit, remaining, reset });
  }
  if (!result.length) {
    const retryAfter = toOptionalString(normalized.get("retry-after"));
    if (retryAfter) result.push({ resource: "requests", reset: retryAfter });
  }
  return result;
}

function addWindow(
  windows: ProviderUsageWindow[],
  name: ProviderUsageWindow["name"],
  usedPercent: number | undefined,
  remainingPercent: number | undefined,
  resetsAt: string | undefined
): void {
  if (usedPercent === undefined && remainingPercent === undefined && !resetsAt) return;
  windows.push({
    name,
    usedPercent: usedPercent ?? (remainingPercent === undefined ? undefined : 100 - remainingPercent),
    remainingPercent: remainingPercent ?? (usedPercent === undefined ? undefined : 100 - usedPercent),
    resetsAt
  });
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/[$€£¥,%\s]/g, "");
  if (!normalized) return undefined;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : undefined;
}

function toPercent(value: unknown): number | undefined {
  const number = toFiniteNumber(value);
  if (number === undefined) return undefined;
  return Math.min(100, Math.max(0, number));
}

function toOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return String(value).trim() || undefined;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
