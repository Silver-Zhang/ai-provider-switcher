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

export function normalizeCodexProxyUrl(proxyUrl: string): string {
  const parsed = new URL(proxyUrl.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("代理地址必须使用 http:// 或 https://");
  }
  if (!parsed.hostname) throw new Error("代理地址缺少主机名");
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
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
  const unmanaged = removeManagedCodexEnv(content);
  const managed = [
    CODEX_ENV_MANAGED_BEGIN,
    `HTTP_PROXY=${JSON.stringify(normalizedProxyUrl)}`,
    `HTTPS_PROXY=${JSON.stringify(normalizedProxyUrl)}`,
    `NO_PROXY="localhost,127.0.0.1,::1"`,
    CODEX_ENV_MANAGED_END
  ].join("\n");
  return `${unmanaged}${unmanaged ? "\n\n" : ""}${managed}\n`;
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
  return lines.join("\n");
}

export function removeManagedCodexProviders(content: string): string {
  const block = new RegExp(
    `\\r?\\n?${escapeRegExp(CODEX_MANAGED_BEGIN)}[\\s\\S]*?${escapeRegExp(CODEX_MANAGED_END)}\\r?\\n?`,
    "g"
  );
  return content.replace(block, "").trimEnd();
}

/** Build a Codex model catalog so custom-provider models appear in Codex's own picker. */
export function createCodexModelCatalog(modelIds: string[]): { models: Array<Record<string, unknown>> } {
  return {
    models: [...new Set(modelIds.map((model) => model.trim()).filter(Boolean))].map((model, index) => ({
      slug: model,
      display_name: model,
      description: `Available from the active custom provider`,
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "low", description: "Low" },
        { effort: "medium", description: "Medium" },
        { effort: "high", description: "High" },
        { effort: "xhigh", description: "Extra high" }
      ],
      shell_type: "shell_command",
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
      supports_reasoning_summary_parameter: true,
      default_reasoning_summary: "auto",
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: null,
      web_search_tool_type: "text",
      truncation_policy: { mode: "bytes", limit: 10000 },
      supports_parallel_tool_calls: true,
      supports_image_detail_original: false,
      context_window: null,
      max_context_window: null,
      auto_compact_token_limit: null,
      comp_hash: null,
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      input_modalities: ["text", "image"],
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
  const unmanaged = removeManagedCodexEnv(content)
    .split(/\r?\n/)
    .filter((line) => {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      return !match || !CODEX_PROXY_ENV_KEYS.has(match[1]);
    })
    .join("\n")
    .trimEnd();
  if (!managedMatch) return unmanaged;
  return `${unmanaged}${unmanaged ? "\n\n" : ""}${managedMatch}\n`;
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

export function parseMacOsProxySettings(content: string): string | undefined {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$/);
    if (match) values.set(match[1], match[2]);
  }
  const protocol = values.get("HTTPSEnable") === "1" ? "HTTPS" :
    values.get("HTTPEnable") === "1" ? "HTTP" : undefined;
  if (!protocol) return undefined;
  const host = values.get(`${protocol}Proxy`);
  const port = values.get(`${protocol}Port`);
  if (!host || !port) return undefined;
  return normalizeCodexProxyUrl(`http://${host}:${port}`);
}