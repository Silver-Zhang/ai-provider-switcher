import * as path from "path";

export const CODEX_MANAGED_BEGIN = "# BEGIN AI Provider Switcher managed Codex provider";
export const CODEX_MANAGED_END = "# END AI Provider Switcher managed Codex provider";
export const CODEX_ENV_MANAGED_BEGIN = "# BEGIN AI Provider Switcher managed Codex proxy";
export const CODEX_ENV_MANAGED_END = "# END AI Provider Switcher managed Codex proxy";
const CODEX_PROXY_ENV_KEYS = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy"
]);

export type CodexEnvEntry = { name: string; value: string; line: number };

/**
 * The line ending a file already uses. Every rewrite here is an edit of a file
 * the user owns, so it must not convert a Windows CRLF file to LF wholesale
 * just because one key changed.
 */
export function detectEol(content: string): "\r\n" | "\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/** Re-ends every line of a generated block with the target file's line ending. */
function withEol(block: string, eol: "\r\n" | "\n"): string {
  return eol === "\n" ? block : block.replace(/\r?\n/g, eol);
}

/**
 * Codex reads `~/.codex` unless `CODEX_HOME` says otherwise, so every path this
 * extension writes has to follow the same rule — writing to the default while
 * Codex reads the override is a silent no-op with no error to show the user.
 */
export function resolveCodexHomeDir(env: NodeJS.ProcessEnv, homedir: string): string {
  const configured = (env.CODEX_HOME ?? "").trim();
  if (!configured) return path.join(homedir, ".codex");
  const expanded = configured === "~" || configured.startsWith("~/") || configured.startsWith("~\\")
    ? path.join(homedir, configured.slice(1))
    : configured;
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(homedir, expanded);
}

export function createCodexAuthConfig(
  platform: NodeJS.Platform,
  helperFile: string,
  keyFile: string
): { command: string; args: string[] } {
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helperFile, keyFile]
    };
  }
  return { command: helperFile, args: [keyFile] };
}

/**
 * Codex proxies through reqwest, which speaks SOCKS as well as HTTP. Rejecting
 * socks5 forced anyone on a SOCKS-only proxy to give up on the whole feature.
 */
const CODEX_PROXY_PROTOCOLS = new Set([
  "http:",
  "https:",
  "socks:",
  "socks4:",
  "socks4a:",
  "socks5:",
  "socks5h:"
]);

export function normalizeCodexProxyUrl(proxyUrl: string): string {
  const text = proxyUrl.trim();
  if (!text) throw new Error("代理地址不能为空");
  // "127.0.0.1:7890" is what proxy apps display and what people paste, so treat a
  // missing scheme as http rather than as a parse failure. Require "://" to detect
  // the scheme — a bare colon would make "localhost:7890" look like scheme "localhost".
  const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text) ? text : `http://${text}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`无法解析代理地址“${text}”，请填写形如 http://127.0.0.1:7890 的地址`);
  }
  if (!CODEX_PROXY_PROTOCOLS.has(parsed.protocol)) {
    throw new Error("代理地址只支持 http://、https:// 或 socks5:// 等协议");
  }
  if (!parsed.hostname) throw new Error("代理地址缺少主机名");
  // Non-special schemes such as socks5 keep an empty pathname instead of "/".
  if ((parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search || parsed.hash) {
    throw new Error("代理地址不能包含路径、查询参数或片段");
  }
  return parsed.toString().replace(/\/$/, "");
}

export function parseWindowsProxyServer(proxyServer: string): string | undefined {
  const entries = proxyServer
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const protocolEntries = new Map(
    entries
      .map((entry) => entry.match(/^([^=]+)=(.+)$/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => [match[1].toLowerCase(), match[2].trim()])
  );
  const candidate = protocolEntries.get("https") ?? protocolEntries.get("http") ??
    entries.find((entry) => !entry.includes("="));
  if (!candidate) return undefined;
  return normalizeCodexProxyUrl(
    /^https?:\/\//i.test(candidate) ? candidate : `http://${candidate}`
  );
}

export function removeManagedCodexEnv(content: string): string {
  const block = new RegExp(
    `\\r?\\n?${escapeRegExp(CODEX_ENV_MANAGED_BEGIN)}[\\s\\S]*?${escapeRegExp(CODEX_ENV_MANAGED_END)}\\r?\\n?`,
    "g"
  );
  return content.replace(block, "").trimEnd();
}

export function updateManagedCodexEnv(content: string, proxyUrl: string): string {
  const normalizedProxyUrl = normalizeCodexProxyUrl(proxyUrl);
  const eol = detectEol(content);
  const unmanaged = removeManagedCodexEnv(content);
  const managed = [
    CODEX_ENV_MANAGED_BEGIN,
    `HTTP_PROXY=${JSON.stringify(normalizedProxyUrl)}`,
    `HTTPS_PROXY=${JSON.stringify(normalizedProxyUrl)}`,
    `NO_PROXY="localhost,127.0.0.1,::1"`,
    CODEX_ENV_MANAGED_END
  ].join(eol);
  return `${unmanaged}${unmanaged ? eol + eol : ""}${managed}${eol}`;
}

/** Store and display the provider origin, not a protocol-specific API path. */
export function normalizeProviderRootUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/v1\/?$/i, "").replace(/\/$/, "");
}

/** Codex custom providers use the OpenAI Responses API under /v1. */
export function getCodexApiBaseUrl(baseUrl: string): string {
  return `${normalizeProviderRootUrl(baseUrl)}/v1`;
}

export function parseTopLevelTomlString(content: string, key: string): string | undefined {
  const firstTable = content.search(/^\s*\[/m);
  const topLevel = firstTable >= 0 ? content.slice(0, firstTable) : content;
  const match = topLevel.match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*("(?:\\\\.|[^"])*")\\s*$`, "m"));
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]) as string;
  } catch {
    return undefined;
  }
}

export function updateTopLevelTomlKey(
  content: string,
  key: string,
  value: string | undefined
): string {
  const eol = detectEol(content);
  const lines = content.split(/\r?\n/);
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const end = firstTable >= 0 ? firstTable : lines.length;
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const index = lines.slice(0, end).findIndex((line) => pattern.test(line));

  if (index >= 0) {
    if (value === undefined) {
      lines.splice(index, 1);
    } else {
      lines[index] = `${key} = ${JSON.stringify(value)}`;
    }
  } else if (value !== undefined) {
    lines.splice(end, 0, `${key} = ${JSON.stringify(value)}`);
  }
  return lines.join(eol);
}

export function removeManagedCodexProviders(content: string): string {
  const block = new RegExp(
    `\\r?\\n?${escapeRegExp(CODEX_MANAGED_BEGIN)}[\\s\\S]*?${escapeRegExp(CODEX_MANAGED_END)}\\r?\\n?`,
    "g"
  );
  return content.replace(block, "").trimEnd();
}

/**
 * Codex keys its thread list by `model_provider`, so a provider block that disappears from
 * config.toml leaves the sessions recorded under that ID unresolvable. Keep every managed
 * block in place — including while the official provider is active — and only swap the
 * top-level `model_provider` key.
 */
export function replaceManagedCodexProviders(content: string, managedBlock: string): string {
  const eol = detectEol(content);
  const unmanaged = removeManagedCodexProviders(content).trimEnd();
  if (!managedBlock.trim()) return unmanaged;
  return `${unmanaged}${unmanaged ? eol + eol : ""}${withEol(managedBlock.trimEnd(), eol)}${eol}`;
}

/**
 * Provider IDs are the partition key for Codex session history, so they must stay stable
 * across remove/re-add cycles. A timestamped ID silently strands every earlier thread.
 */
export function createCodexProviderId(name: string, existingIds: string[] = []): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const base = `codex-${slug || "provider"}`;
  if (!existingIds.includes(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!existingIds.includes(candidate)) return candidate;
  }
}

/** Accept the comma, full-width comma, or whitespace separators people actually paste. */
export function parseCodexModelIds(value: string): string[] {
  return [...new Set(value.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean))];
}

/** Build a Codex model catalog so custom-provider models appear in Codex's own picker. */
export function createCodexModelCatalog(modelIds: string[], textOnly = false): { models: Array<Record<string, unknown>> } {
  return {
    models: [...new Set(modelIds.map((model) => model.trim()).filter(Boolean))].map((model, index) => ({
      slug: model,
      display_name: model,
      description: textOnly
        ? "Experimental local protocol conversion: text and streaming only; tools, images, files and reasoning are unsupported."
        : "Available from the active custom provider",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "low", description: "Low" },
        { effort: "medium", description: "Medium" },
        { effort: "high", description: "High" },
        { effort: "xhigh", description: "Extra high" }
      ],
      shell_type: textOnly ? null : "shell_command",
      visibility: "list",
      supported_in_api: true,
      priority: modelPriority(model, index),
      additional_speed_tiers: [],
      service_tiers: [],
      default_service_tier: null,
      availability_nux: null,
      upgrade: null,
      base_instructions: "You are Codex, a coding agent. Collaborate with the user in their workspace.",
      model_messages: null,
      include_skills_usage_instructions: false,
      supports_reasoning_summary_parameter: !textOnly,
      default_reasoning_summary: textOnly ? null : "auto",
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: null,
      web_search_tool_type: "text",
      truncation_policy: { mode: "bytes", limit: 10000 },
      supports_parallel_tool_calls: !textOnly,
      supports_image_detail_original: false,
      context_window: null,
      max_context_window: null,
      auto_compact_token_limit: null,
      comp_hash: null,
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      input_modalities: textOnly ? ["text"] : ["text", "image"],
      supports_search_tool: false,
      use_responses_lite: false,
      auto_review_model_override: null,
      tool_mode: null,
      multi_agent_version: null
    }))
  };
}

function modelPriority(model: string, index: number): number {
  const preferredOrder = ["sol", "luna", "terra"];
  const preferredIndex = preferredOrder.findIndex((name) => model.toLowerCase().includes(name));
  return preferredIndex >= 0 ? 1000 - preferredIndex : 500 - index;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findUnmanagedCodexProxyEnv(content: string): CodexEnvEntry[] {
  const unmanaged = removeManagedCodexEnv(content);
  const entries: CodexEnvEntry[] = [];
  unmanaged.split(/\r?\n/).forEach((line, index) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || !CODEX_PROXY_ENV_KEYS.has(match[1])) return;
    entries.push({
      name: match[1],
      value: unquoteEnvValue(match[2]),
      line: index + 1
    });
  });
  return entries;
}

export function removeUnmanagedCodexProxyEnv(content: string): string {
  const managedMatch = content.match(
    new RegExp(`${escapeRegExp(CODEX_ENV_MANAGED_BEGIN)}[\\s\\S]*?${escapeRegExp(CODEX_ENV_MANAGED_END)}`)
  )?.[0];
  const eol = detectEol(content);
  const unmanaged = removeManagedCodexEnv(content)
    .split(/\r?\n/)
    .filter((line) => {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      return !match || !CODEX_PROXY_ENV_KEYS.has(match[1]);
    })
    .join(eol)
    .trimEnd();
  if (!managedMatch) return unmanaged;
  return `${unmanaged}${unmanaged ? eol + eol : ""}${withEol(managedMatch, eol)}${eol}`;
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export type MacOsProxyConfiguration = {
  /** A concrete host:port proxy Codex can be pointed at. */
  manualUrl?: string;
  /** A PAC script URL. Codex cannot evaluate PAC, so this only explains the failure. */
  autoConfigUrl?: string;
  /** WPAD auto-discovery, which likewise yields no address to write. */
  autoDiscover: boolean;
};

/**
 * `scutil --proxy` reports manual, PAC, and WPAD configurations side by side. Reading only
 * the manual keys made a PAC-configured Mac look like it had no proxy at all, and the user
 * was told to "确认系统代理已启用" for a proxy that was already on.
 */
export function parseMacOsProxyConfiguration(content: string): MacOsProxyConfiguration {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$/);
    if (match) values.set(match[1], match[2]);
  }

  let manualUrl: string | undefined;
  const protocol = values.get("HTTPSEnable") === "1" ? "HTTPS" :
    values.get("HTTPEnable") === "1" ? "HTTP" : undefined;
  if (protocol) {
    const host = values.get(`${protocol}Proxy`);
    const port = values.get(`${protocol}Port`);
    if (host && port) manualUrl = normalizeCodexProxyUrl(`http://${host}:${port}`);
  }

  const autoConfigUrl = values.get("ProxyAutoConfigEnable") === "1"
    ? values.get("ProxyAutoConfigURLString")?.trim() || undefined
    : undefined;

  return {
    manualUrl,
    autoConfigUrl,
    autoDiscover: values.get("ProxyAutoDiscoveryEnable") === "1"
  };
}

export function parseMacOsProxySettings(content: string): string | undefined {
  return parseMacOsProxyConfiguration(content).manualUrl;
}

/**
 * KDE keeps proxy settings in `~/.config/kioslaverc`, not in gsettings, so a Plasma desktop
 * looked exactly like a machine with no proxy configured.
 */
export function parseKdeProxySettings(content: string): string | undefined {
  const values = new Map<string, string>();
  let inProxySection = false;
  for (const line of content.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      inProxySection = section[1].trim().toLowerCase() === "proxy settings";
      continue;
    }
    if (!inProxySection) continue;
    const match = line.match(/^\s*([^=\s]+)\s*=\s*(.*?)\s*$/);
    if (match) values.set(match[1], match[2]);
  }
  // ProxyType 1 is the manual configuration; 0 none, 2 PAC, 3 WPAD, 4 environment.
  if (values.get("ProxyType") !== "1") return undefined;
  const candidate = values.get("httpsProxy")?.trim() || values.get("httpProxy")?.trim();
  if (!candidate) return undefined;
  // KDE writes "http://127.0.0.1 7890" — a space where a colon belongs.
  const normalized = candidate.replace(/\s+(\d+)$/, ":$1");
  try {
    return normalizeCodexProxyUrl(normalized);
  } catch {
    return undefined;
  }
}

/**
 * Split a TOML table header into its key path. `[model_providers."custom"]`,
 * `[model_providers.'custom']`, and `[ model_providers.custom ]` all name the same
 * table, and treating them as different ones let a duplicate table be appended —
 * which is a hard parse error that stops Codex from starting at all.
 */
export function parseTomlTableKeyPath(line: string): string[] | undefined {
  const match = line.match(/^\s*\[\s*([^\[\]]*?)\s*\]\s*$/);
  if (!match) return undefined;
  const body = match[1];
  const parts: string[] = [];
  let index = 0;
  while (index < body.length) {
    while (index < body.length && /\s/.test(body[index])) index += 1;
    if (index >= body.length) return undefined;
    const quote = body[index];
    let part: string;
    if (quote === '"' || quote === "'") {
      index += 1;
      let raw = "";
      while (index < body.length && body[index] !== quote) {
        // Basic strings escape with backslash; literal strings ('…') do not.
        if (quote === '"' && body[index] === "\\" && index + 1 < body.length) {
          raw += body[index] + body[index + 1];
          index += 2;
          continue;
        }
        raw += body[index];
        index += 1;
      }
      if (index >= body.length) return undefined;
      index += 1;
      if (quote === '"') {
        try {
          part = JSON.parse(`"${raw}"`) as string;
        } catch {
          return undefined;
        }
      } else {
        part = raw;
      }
    } else {
      let raw = "";
      while (index < body.length && !/[.\s]/.test(body[index])) {
        raw += body[index];
        index += 1;
      }
      if (!/^[A-Za-z0-9_-]+$/.test(raw)) return undefined;
      part = raw;
    }
    parts.push(part);
    while (index < body.length && /\s/.test(body[index])) index += 1;
    if (index >= body.length) break;
    if (body[index] !== ".") return undefined;
    index += 1;
  }
  return parts.length > 0 ? parts : undefined;
}