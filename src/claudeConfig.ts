export type ClaudeEnvVar = { name: string; value: string };
export type ClaudeProviderProfile = { id: string; name: string; baseUrl: string };
export type ClaudeConfigurationCategory = "routing" | "authentication" | "model" | "permission" | "invalid";
export type ClaudeConfigurationFinding = {
  source: string;
  sourcePath?: string;
  category: ClaudeConfigurationCategory;
  name: string;
  displayValue: string;
  canOverrideExtension: boolean;
};
export type ClaudeModelMapping = {
  mainModel: string;
  fableModel?: string;
  opusModel: string;
  sonnetModel: string;
  haikuModel: string;
  subagentModel: string;
  /** Legacy switch: declared 1M support. Kept for stored data; prefer `longContextRoles`. */
  supports1m?: boolean;
  /** Which roles run as the `[1m]` variant — each role is independently switchable. */
  longContextRoles?: ClaudeModelRole[];
  effortLevel?: "low" | "medium" | "high" | "xhigh" | "max" | "auto";
};

/** The roles a mapped model can play; each one can declare 1M on its own. */
export type ClaudeModelRole = "main" | "opus" | "sonnet" | "haiku" | "fable" | "subagent";
export const CLAUDE_MODEL_ROLES: ClaudeModelRole[] = ["main", "opus", "sonnet", "haiku", "fable", "subagent"];
export type ClaudePermissionStrategy = "auto" | "acceptEdits" | "manual" | "bypassPermissions";

export const CLAUDE_ROUTING_ENV_NAMES = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"
] as const;

export const CLAUDE_AUTH_ENV_NAMES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_AWS_API_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN"
] as const;

export const CLAUDE_MODEL_ENV_NAMES = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_EFFORT_LEVEL"
] as const;

export const CLAUDE_PROVIDER_ENV_NAMES = [
  ...CLAUDE_ROUTING_ENV_NAMES,
  ...CLAUDE_AUTH_ENV_NAMES,
  ...CLAUDE_MODEL_ENV_NAMES
];

const DEEPSEEK_ANTHROPIC_API_URL = "https://api.deepseek.com/anthropic";

export const DEEPSEEK_CLAUDE_MODEL_ENV: ClaudeEnvVar[] = [
  { name: "ANTHROPIC_MODEL", value: "deepseek-v4-pro[1m]" },
  { name: "ANTHROPIC_DEFAULT_OPUS_MODEL", value: "deepseek-v4-pro[1m]" },
  { name: "ANTHROPIC_DEFAULT_SONNET_MODEL", value: "deepseek-v4-pro[1m]" },
  { name: "ANTHROPIC_DEFAULT_HAIKU_MODEL", value: "deepseek-v4-flash" },
  { name: "CLAUDE_CODE_SUBAGENT_MODEL", value: "deepseek-v4-flash" },
  { name: "CLAUDE_CODE_EFFORT_LEVEL", value: "max" }
];

export const DEEPSEEK_CLAUDE_MODEL_ENV_NAMES = DEEPSEEK_CLAUDE_MODEL_ENV.map(
  (entry) => entry.name
);

export function createClaudeModelMapping(
  mainModel: string,
  fastModel = mainModel,
  effortLevel?: ClaudeModelMapping["effortLevel"],
  supports1m = false
): ClaudeModelMapping {
  return {
    mainModel: mainModel.trim(),
    fableModel: mainModel.trim(),
    opusModel: mainModel.trim(),
    sonnetModel: mainModel.trim(),
    haikuModel: fastModel.trim(),
    subagentModel: fastModel.trim(),
    supports1m,
    longContextRoles: supports1m ? ["main", "fable", "opus", "sonnet"] : [],
    effortLevel
  };
}

export function normalizeClaudeModelMapping(value: unknown): ClaudeModelMapping | undefined {
  if (!isRecord(value)) return undefined;
  const mainModel = stringValue(value.mainModel);
  const opusModel = stringValue(value.opusModel) || mainModel;
  const sonnetModel = stringValue(value.sonnetModel) || mainModel;
  const haikuModel = stringValue(value.haikuModel) || mainModel;
  const subagentModel = stringValue(value.subagentModel) || haikuModel;
  if (!mainModel || !opusModel || !sonnetModel || !haikuModel || !subagentModel) return undefined;
  const effort = stringValue(value.effortLevel);
  const effortLevel = ["low", "medium", "high", "xhigh", "max", "auto"].includes(effort)
    ? effort as ClaudeModelMapping["effortLevel"]
    : undefined;
  // `longContextRoles` is authoritative; stored legacy `supports1m` maps onto
  // the roles the old code used to suffix so nothing changes for old data.
  const rawRoles = Array.isArray(value.longContextRoles) ? value.longContextRoles : undefined;
  const longContextRoles: ClaudeModelRole[] = rawRoles
    ? CLAUDE_MODEL_ROLES.filter((role) => (rawRoles as unknown[]).includes(role))
    : value.supports1m === true ? ["main", "fable", "opus", "sonnet"] : [];
  return {
    mainModel,
    fableModel: stringValue(value.fableModel) || mainModel,
    opusModel,
    sonnetModel,
    haikuModel,
    subagentModel,
    supports1m: value.supports1m === true,
    longContextRoles,
    effortLevel
  };
}

export function createClaudeModelEnvironment(mapping: ClaudeModelMapping): ClaudeEnvVar[] {
  const normalized = normalizeClaudeModelMapping(mapping);
  if (!normalized) return [];
  const oneM = (role: ClaudeModelRole): boolean => (normalized.longContextRoles ?? []).includes(role);
  const longContext = (model: string, role: ClaudeModelRole): string =>
    oneM(role) && !model.endsWith("[1m]") ? `${model}[1m]` : model;
  const entries: ClaudeEnvVar[] = [
    { name: "ANTHROPIC_MODEL", value: longContext(normalized.mainModel, "main") },
    { name: "ANTHROPIC_DEFAULT_FABLE_MODEL", value: longContext(normalized.fableModel ?? normalized.mainModel, "fable") },
    { name: "ANTHROPIC_DEFAULT_OPUS_MODEL", value: longContext(normalized.opusModel, "opus") },
    { name: "ANTHROPIC_DEFAULT_SONNET_MODEL", value: longContext(normalized.sonnetModel, "sonnet") },
    { name: "ANTHROPIC_DEFAULT_HAIKU_MODEL", value: longContext(normalized.haikuModel, "haiku") },
    { name: "CLAUDE_CODE_SUBAGENT_MODEL", value: longContext(normalized.subagentModel, "subagent") },
    { name: "ANTHROPIC_CUSTOM_MODEL_OPTION", value: longContext(normalized.mainModel, "main") },
    { name: "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME", value: normalized.mainModel },
    { name: "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION", value: "Custom model mapped by AI Provider Switcher" },
    { name: "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME", value: normalized.fableModel ?? normalized.mainModel },
    { name: "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME", value: normalized.opusModel },
    { name: "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME", value: normalized.sonnetModel },
    { name: "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME", value: normalized.haikuModel },
    { name: "ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION", value: "Mapped Fable model" },
    { name: "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION", value: "Mapped Opus model" },
    { name: "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION", value: "Mapped Sonnet model" },
    { name: "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION", value: "Mapped Haiku model" }
  ];
  if (normalized.effortLevel) {
    entries.push({ name: "CLAUDE_CODE_EFFORT_LEVEL", value: normalized.effortLevel });
  }
  return entries;
}

export function hasNonClaudeModelIds(modelIds: string[]): boolean {
  return modelIds.some((model) => {
    const normalized = model.trim().toLowerCase();
    return normalized.length > 0 &&
      !normalized.startsWith("claude-") &&
      !["default", "best", "fable", "opus", "sonnet", "haiku", "opusplan"].includes(normalized);
  });
}

export function isClaudeAutoClassifierCompatible(modelIds: string[]): boolean {
  return modelIds.some((model) => model.trim().toLowerCase() === "claude-sonnet-5");
}

export function normalizeClaudePermissionStrategy(
  value: unknown
): ClaudePermissionStrategy | undefined {
  return ["auto", "acceptEdits", "manual", "bypassPermissions"].includes(String(value))
    ? String(value) as ClaudePermissionStrategy
    : undefined;
}

export function stripClaudeProviderSettingsJson(content: string): {
  content: string;
  removed: string[];
} {
  const parsed = JSON.parse(content) as unknown;
  if (!isRecord(parsed)) return { content, removed: [] };
  const removed: string[] = [];
  if (isRecord(parsed.env)) {
    for (const name of CLAUDE_PROVIDER_ENV_NAMES) {
      if (Object.prototype.hasOwnProperty.call(parsed.env, name)) {
        delete parsed.env[name];
        removed.push(`env.${name}`);
      }
    }
    if (Object.keys(parsed.env).length === 0) delete parsed.env;
  }
  for (const name of ["apiKeyHelper", "model", "modelOverrides", "forceLoginGatewayUrl"] as const) {
    if (Object.prototype.hasOwnProperty.call(parsed, name)) {
      delete parsed[name];
      removed.push(name);
    }
  }
  return {
    content: `${JSON.stringify(parsed, null, 2)}\n`,
    removed
  };
}

export function inspectClaudeEnvironment(
  environment: Record<string, string | undefined>,
  source: string,
  canOverrideExtension: boolean
): ClaudeConfigurationFinding[] {
  return CLAUDE_PROVIDER_ENV_NAMES.flatMap((name) => {
    const value = environment[name]?.trim();
    if (!value) return [];
    const category = getClaudeEnvironmentCategory(name);
    return [{
      source,
      category,
      name,
      displayValue: category === "authentication" ? "已设置（值已隐藏）" : value,
      canOverrideExtension
    }];
  });
}

export function inspectClaudeSettingsJson(
  content: string,
  source: string,
  canOverrideExtension = true
): ClaudeConfigurationFinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [{
      source,
      category: "invalid",
      name: "settings.json",
      displayValue: "JSON 无效，Claude Code 可能忽略整个配置文件",
      canOverrideExtension
    }];
  }
  if (!isRecord(parsed)) return [];

  const findings: ClaudeConfigurationFinding[] = [];
  if (isRecord(parsed.env)) {
    const environment = Object.fromEntries(
      Object.entries(parsed.env).map(([name, value]) => [name, typeof value === "string" ? value : undefined])
    );
    findings.push(...inspectClaudeEnvironment(environment, source, canOverrideExtension));
  }
  if (typeof parsed.apiKeyHelper === "string" && parsed.apiKeyHelper.trim()) {
    findings.push({
      source,
      category: "authentication",
      name: "apiKeyHelper",
      displayValue: "已配置（命令已隐藏）",
      canOverrideExtension
    });
  }
  if (typeof parsed.model === "string" && parsed.model.trim()) {
    findings.push({
      source,
      category: "model",
      name: "model",
      displayValue: parsed.model.trim(),
      canOverrideExtension
    });
  }
  if (isRecord(parsed.modelOverrides) && Object.keys(parsed.modelOverrides).length > 0) {
    findings.push({
      source,
      category: "model",
      name: "modelOverrides",
      displayValue: `已配置 ${Object.keys(parsed.modelOverrides).length} 项模型映射`,
      canOverrideExtension
    });
  }
  if (typeof parsed.forceLoginGatewayUrl === "string" && parsed.forceLoginGatewayUrl.trim()) {
    findings.push({
      source,
      category: "routing",
      name: "forceLoginGatewayUrl",
      displayValue: parsed.forceLoginGatewayUrl.trim(),
      canOverrideExtension
    });
  }
  if (isRecord(parsed.permissions)) {
    const permissionFindings: Array<[string, unknown, string]> = [
      ["permissions.defaultMode", parsed.permissions.defaultMode, "默认权限模式"],
      ["permissions.disableAutoMode", parsed.permissions.disableAutoMode, "Auto 模式开关"],
      ["permissions.disableBypassPermissionsMode", parsed.permissions.disableBypassPermissionsMode, "Bypass 模式开关"]
    ];
    for (const [name, value, label] of permissionFindings) {
      if (typeof value === "string" && value.trim()) {
        findings.push({
          source,
          category: "permission",
          name,
          displayValue: `${label}: ${value.trim()}`,
          canOverrideExtension
        });
      }
    }
    for (const ruleType of ["ask", "deny"] as const) {
      const rules = parsed.permissions[ruleType];
      if (Array.isArray(rules) && rules.length > 0) {
        findings.push({
          source,
          category: "permission",
          name: `permissions.${ruleType}`,
          displayValue: `已配置 ${rules.length} 条${ruleType === "ask" ? "强制询问" : "拒绝"}规则`,
          canOverrideExtension
        });
      }
    }
    const allowRules = parsed.permissions.allow;
    if (Array.isArray(allowRules) && allowRules.length > 0) {
      const broadRules = allowRules.filter(
        (rule): rule is string => typeof rule === "string" && isBroadAutoSuspendedAllowRule(rule)
      );
      findings.push({
        source,
        category: "permission",
        name: "permissions.allow",
        displayValue: broadRules.length > 0
          ? `已配置 ${allowRules.length} 条允许规则，其中 ${broadRules.length} 条宽泛规则会在 Auto 模式中暂停`
          : `已配置 ${allowRules.length} 条允许规则`,
        canOverrideExtension
      });
    }
  }
  if (isRecord(parsed.autoMode)) {
    const environment = parsed.autoMode.environment;
    if (Array.isArray(environment) && environment.length > 0) {
      findings.push({
        source,
        category: "permission",
        name: "autoMode.environment",
        displayValue: `已配置 ${environment.length} 项 Auto 模式信任环境`,
        canOverrideExtension
      });
    }
    if (parsed.autoMode.classifyAllShell === true) {
      findings.push({
        source,
        category: "permission",
        name: "autoMode.classifyAllShell",
        displayValue: "所有 Shell 命令均交由 Auto 分类器判断",
        canOverrideExtension
      });
    }
  }
  return findings;
}

export function normalizeClaudeProviderUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/$/, "").toLowerCase();
}

export function normalizeClaudeProviderBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/v1\/?$/i, "").replace(/\/$/, "");
  try {
    const url = new URL(normalized);
    if (url.hostname.toLowerCase() === "api.deepseek.com" && (url.pathname === "/" || url.pathname === "")) {
      return `${url.origin}/anthropic`;
    }
  } catch {
    return normalized;
  }
  return normalized;
}

export function isDeepSeekAnthropicApi(baseUrl: string): boolean {
  return normalizeClaudeProviderUrl(baseUrl) === DEEPSEEK_ANTHROPIC_API_URL;
}

export function mergeDeepSeekClaudeEnvironment(envVars: ClaudeEnvVar[]): ClaudeEnvVar[] {
  if (!isDeepSeekAnthropicApi(
    envVars.find((entry) => entry.name === "ANTHROPIC_BASE_URL")?.value ?? ""
  )) {
    return envVars;
  }
  const managedNames = new Set(DEEPSEEK_CLAUDE_MODEL_ENV.map((entry) => entry.name));
  return [
    ...envVars.filter((entry) => !managedNames.has(entry.name)),
    ...DEEPSEEK_CLAUDE_MODEL_ENV
  ];
}

export function getDeepSeekClaudeModelMapping(): ClaudeModelMapping {
  return {
    mainModel: "deepseek-v4-pro",
    fableModel: "deepseek-v4-pro",
    opusModel: "deepseek-v4-pro",
    sonnetModel: "deepseek-v4-pro",
    haikuModel: "deepseek-v4-flash",
    subagentModel: "deepseek-v4-flash",
    supports1m: true,
    // DeepSeek V4 serves a 1M window on both the pro and the flash model.
    longContextRoles: ["main", "opus", "sonnet", "haiku", "fable", "subagent"],
    effortLevel: "max"
  };
}

export function findClaudeProviderByEnvironment(
  envVars: ClaudeEnvVar[],
  providers: ClaudeProviderProfile[]
): ClaudeProviderProfile | undefined {
  const baseUrl = envVars.find((entry) => entry.name === "ANTHROPIC_BASE_URL")?.value;
  if (!baseUrl) return undefined;
  const normalized = normalizeClaudeProviderUrl(normalizeClaudeProviderBaseUrl(baseUrl));
  return providers.find((provider) =>
    normalizeClaudeProviderUrl(normalizeClaudeProviderBaseUrl(provider.baseUrl)) === normalized
  );
}

function getClaudeEnvironmentCategory(name: string): ClaudeConfigurationCategory {
  if ((CLAUDE_ROUTING_ENV_NAMES as readonly string[]).includes(name)) return "routing";
  if ((CLAUDE_AUTH_ENV_NAMES as readonly string[]).includes(name)) return "authentication";
  return "model";
}

function isBroadAutoSuspendedAllowRule(rule: string): boolean {
  const normalized = rule.trim();
  return /^(?:Bash|PowerShell)(?:\(\*\))?$/.test(normalized) ||
    /^(?:Bash|PowerShell)\((?:python|python3|node|ruby|perl)\*\)$/.test(normalized) ||
    /^Agent(?:\([^)]*\))?$/.test(normalized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export type ClaudeJsonEnvUpdate = { content: string; changed: boolean };

function parseClaudeJsonDocument(content: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`${label} 不是有效的 JSON，无法安全写入。`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${label} 的根节点不是对象，无法安全写入。`);
  }
  return parsed;
}

/**
 * Merges the plugin-managed env keys into a Claude JSON config document
 * (user settings.json or claude_desktop_config.json). Unrelated `env` entries
 * and every other top-level key are preserved; managed keys that are absent
 * from `envVars` are removed, and an emptied `env` object is dropped entirely.
 */
export function mergeClaudeJsonEnv(
  content: string,
  managedKeys: ReadonlySet<string>,
  envVars: ClaudeEnvVar[],
  label = "Claude 配置文件"
): ClaudeJsonEnvUpdate {
  const settings = parseClaudeJsonDocument(content, label);
  const hadEnv = isRecord(settings.env);
  const env: Record<string, unknown> = hadEnv ? { ...(settings.env as Record<string, unknown>) } : {};
  let changed = false;

  const wanted = new Map<string, string>();
  for (const entry of envVars) {
    const name = entry.name.trim();
    if (!name) continue;
    wanted.set(name, entry.value);
  }
  for (const [name, value] of wanted) {
    if (env[name] !== value) {
      env[name] = value;
      changed = true;
    }
  }
  for (const key of Object.keys(env)) {
    if (managedKeys.has(key) && !wanted.has(key)) {
      delete env[key];
      changed = true;
    }
  }

  if (Object.keys(env).length === 0) {
    if (hadEnv) {
      delete settings.env;
      changed = true;
    }
  } else {
    settings.env = env;
  }
  return { content: `${JSON.stringify(settings, null, 2)}\n`, changed };
}

/** Removes only the plugin-managed env keys from a Claude JSON config document. */
export function clearClaudeManagedJsonEnv(
  content: string,
  managedKeys: ReadonlySet<string>,
  label = "Claude 配置文件"
): ClaudeJsonEnvUpdate {
  return mergeClaudeJsonEnv(content, managedKeys, [], label);
}
