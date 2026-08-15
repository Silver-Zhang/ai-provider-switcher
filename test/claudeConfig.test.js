const assert = require("node:assert/strict");
const test = require("node:test");
const {
  DEEPSEEK_CLAUDE_MODEL_ENV,
  clearClaudeManagedJsonEnv,
  createClaudeModelEnvironment,
  createClaudeModelMapping,
  findClaudeProviderByEnvironment,
  getDeepSeekClaudeModelMapping,
  hasNonClaudeModelIds,
  inspectClaudeEnvironment,
  inspectClaudeSettingsJson,
  isClaudeAutoClassifierCompatible,
  isDeepSeekAnthropicApi,
  mergeClaudeJsonEnv,
  mergeDeepSeekClaudeEnvironment,
  normalizeClaudeModelMapping,
  normalizeClaudePermissionStrategy,
  normalizeClaudeProviderBaseUrl,
  normalizeClaudeProviderUrl,
  stripClaudeProviderSettingsJson
} = require("../out/claudeConfig.js");

const providers = [
  { id: "one", name: "Provider One", baseUrl: "https://one.example.com" },
  { id: "two", name: "Provider Two", baseUrl: "https://two.example.com/" }
];

test("identifies the active Claude provider from ANTHROPIC_BASE_URL", () => {
  const active = findClaudeProviderByEnvironment(
    [{ name: "ANTHROPIC_BASE_URL", value: "https://two.example.com" }],
    providers
  );
  assert.equal(active?.id, "two");
});

test("normalizes trailing slashes and URL casing for Claude providers", () => {
  assert.equal(
    normalizeClaudeProviderUrl("HTTPS://API.EXAMPLE.COM/"),
    "https://api.example.com"
  );
});

test("does not mislabel an unknown custom Claude provider", () => {
  const active = findClaudeProviderByEnvironment(
    [{ name: "ANTHROPIC_BASE_URL", value: "https://unknown.example.com" }],
    providers
  );
  assert.equal(active, undefined);
});

test("recognizes only the official DeepSeek Anthropic endpoint", () => {
  assert.equal(isDeepSeekAnthropicApi("https://api.deepseek.com/anthropic/"), true);
  assert.equal(isDeepSeekAnthropicApi("https://api.deepseek.com"), false);
  assert.equal(isDeepSeekAnthropicApi("https://proxy.example.com/anthropic"), false);
});

test("applies the DeepSeek recommended Claude Code model mappings", () => {
  const merged = mergeDeepSeekClaudeEnvironment([
    { name: "ANTHROPIC_BASE_URL", value: "https://api.deepseek.com/anthropic" },
    { name: "ANTHROPIC_AUTH_TOKEN", value: "secret" },
    { name: "ANTHROPIC_MODEL", value: "stale-model" },
    { name: "CUSTOM", value: "preserved" }
  ]);
  assert.equal(
    merged.find((entry) => entry.name === "ANTHROPIC_MODEL")?.value,
    "deepseek-v4-pro[1m]"
  );
  assert.equal(
    merged.find((entry) => entry.name === "CLAUDE_CODE_SUBAGENT_MODEL")?.value,
    "deepseek-v4-flash"
  );
  assert.equal(merged.find((entry) => entry.name === "CUSTOM")?.value, "preserved");
  assert.equal(DEEPSEEK_CLAUDE_MODEL_ENV.length, 6);
});

test("does not apply DeepSeek mappings to other providers", () => {
  const original = [{ name: "ANTHROPIC_BASE_URL", value: "https://example.com" }];
  assert.deepEqual(mergeDeepSeekClaudeEnvironment(original), original);
});

test("detects external Claude provider and model environment without exposing secrets", () => {
  const findings = inspectClaudeEnvironment(
    {
      ANTHROPIC_BASE_URL: "https://gateway.example.com",
      ANTHROPIC_API_KEY: "top-secret",
      CLAUDE_CODE_USE_BEDROCK: "1",
      ANTHROPIC_MODEL: "custom-model"
    },
    "OS environment",
    false
  );
  assert.equal(findings.length, 4);
  assert.equal(findings.find((item) => item.name === "ANTHROPIC_API_KEY")?.displayValue, "已设置（值已隐藏）");
  assert.equal(findings.some((item) => item.displayValue.includes("top-secret")), false);
  assert.equal(findings.find((item) => item.name === "CLAUDE_CODE_USE_BEDROCK")?.category, "routing");
});

test("detects Claude settings env, helpers, and model overrides", () => {
  const findings = inspectClaudeSettingsJson(JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: "https://gateway.example.com",
      ANTHROPIC_AUTH_TOKEN: "secret"
    },
    apiKeyHelper: "print-secret.exe",
    model: "custom-model",
    modelOverrides: { "claude-sonnet-5": "deployment-a" }
  }), "user settings");
  assert.equal(findings.length, 5);
  assert.equal(findings.find((item) => item.name === "apiKeyHelper")?.displayValue, "已配置（命令已隐藏）");
  assert.equal(findings.some((item) => item.displayValue.includes("print-secret")), false);
});

test("reports invalid Claude settings JSON", () => {
  const findings = inspectClaudeSettingsJson("{ invalid", "project settings");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, "invalid");
});

test("detects Claude permission and auto-mode configuration", () => {
  const findings = inspectClaudeSettingsJson(JSON.stringify({
    permissions: {
      defaultMode: "auto",
      allow: ["Bash(*)", "Bash(npm test)"],
      ask: ["Bash(git push *)"],
      deny: ["Bash(rm *)"]
    },
    autoMode: {
      environment: ["$defaults", "Trusted internal domains: api.example.com"],
      classifyAllShell: true
    }
  }), "user settings");
  assert.equal(findings.filter((item) => item.category === "permission").length, 6);
  assert.equal(findings.some((item) => item.name === "permissions.defaultMode"), true);
  assert.equal(findings.some((item) => item.name === "autoMode.classifyAllShell"), true);
  assert.match(
    findings.find((item) => item.name === "permissions.allow")?.displayValue ?? "",
    /1 条宽泛规则会在 Auto 模式中暂停/
  );
});

test("derives the official Anthropic endpoint from the DeepSeek service root", () => {
  assert.equal(
    normalizeClaudeProviderBaseUrl("https://api.deepseek.com"),
    "https://api.deepseek.com/anthropic"
  );
  assert.equal(
    normalizeClaudeProviderBaseUrl("https://api.deepseek.com/anthropic/"),
    "https://api.deepseek.com/anthropic"
  );
  assert.equal(
    normalizeClaudeProviderBaseUrl("https://gateway.example.com/v1"),
    "https://gateway.example.com"
  );
});

test("identifies legacy DeepSeek root profiles after Anthropic endpoint normalization", () => {
  const active = findClaudeProviderByEnvironment(
    [{ name: "ANTHROPIC_BASE_URL", value: "https://api.deepseek.com/anthropic" }],
    [{ id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com" }]
  );
  assert.equal(active?.id, "deepseek");
});

test("creates a complete generic model mapping for non-Claude providers", () => {
  const mapping = createClaudeModelMapping("kimi-k2.5", "kimi-k2-fast", "high");
  const environment = createClaudeModelEnvironment(mapping);
  assert.equal(environment.find((entry) => entry.name === "ANTHROPIC_MODEL")?.value, "kimi-k2.5");
  assert.equal(environment.find((entry) => entry.name === "ANTHROPIC_DEFAULT_FABLE_MODEL")?.value, "kimi-k2.5");
  assert.equal(environment.find((entry) => entry.name === "ANTHROPIC_DEFAULT_OPUS_MODEL")?.value, "kimi-k2.5");
  assert.equal(environment.find((entry) => entry.name === "ANTHROPIC_DEFAULT_HAIKU_MODEL")?.value, "kimi-k2-fast");
  assert.equal(environment.find((entry) => entry.name === "CLAUDE_CODE_SUBAGENT_MODEL")?.value, "kimi-k2-fast");
  assert.equal(environment.find((entry) => entry.name === "ANTHROPIC_CUSTOM_MODEL_OPTION")?.value, "kimi-k2.5");
});

test("only adds the 1m suffix when the provider mapping declares support", () => {
  const ordinary = createClaudeModelEnvironment(createClaudeModelMapping("custom-model"));
  const longContext = createClaudeModelEnvironment(createClaudeModelMapping("custom-model", "fast-model", undefined, true));
  assert.equal(ordinary.find((entry) => entry.name === "ANTHROPIC_DEFAULT_OPUS_MODEL")?.value, "custom-model");
  assert.equal(longContext.find((entry) => entry.name === "ANTHROPIC_DEFAULT_OPUS_MODEL")?.value, "custom-model[1m]");
  assert.equal(longContext.find((entry) => entry.name === "ANTHROPIC_DEFAULT_HAIKU_MODEL")?.value, "fast-model");
});

test("each role can declare 1M on its own", () => {
  const mapping = normalizeClaudeModelMapping({
    mainModel: "pro",
    haikuModel: "fast",
    longContextRoles: ["haiku", "subagent"]
  });
  const environment = createClaudeModelEnvironment(mapping);
  assert.equal(environment.find((entry) => entry.name === "ANTHROPIC_MODEL")?.value, "pro");
  assert.equal(environment.find((entry) => entry.name === "ANTHROPIC_DEFAULT_HAIKU_MODEL")?.value, "fast[1m]");
  assert.equal(environment.find((entry) => entry.name === "CLAUDE_CODE_SUBAGENT_MODEL")?.value, "fast[1m]");
  assert.equal(environment.find((entry) => entry.name === "ANTHROPIC_DEFAULT_OPUS_MODEL")?.value, "pro");
});

test("stored legacy supports1m maps onto the roles the old code suffixed", () => {
  const mapping = normalizeClaudeModelMapping({ mainModel: "m", haikuModel: "h", supports1m: true });
  assert.deepEqual(mapping.longContextRoles, ["main", "fable", "opus", "sonnet"]);
});

test("normalizes stored model mappings and the DeepSeek official template", () => {
  const normalized = normalizeClaudeModelMapping({ mainModel: "ds-main", haikuModel: "ds-fast" });
  assert.equal(normalized?.opusModel, "ds-main");
  assert.equal(normalized?.subagentModel, "ds-fast");
  const deepSeek = getDeepSeekClaudeModelMapping();
  assert.equal(deepSeek.supports1m, true);
  assert.equal(deepSeek.opusModel, "deepseek-v4-pro");
});

test("detects non-Claude model catalogs", () => {
  assert.equal(hasNonClaudeModelIds(["claude-opus-5", "claude-haiku-4-5"]), false);
  assert.equal(hasNonClaudeModelIds(["deepseek-v4-pro", "claude-sonnet-5"]), true);
});

test("removes only Claude provider fields from settings and preserves permissions", () => {
  const result = stripClaudeProviderSettingsJson(JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: "https://old.example.com",
      ANTHROPIC_AUTH_TOKEN: "secret",
      KEEP_ME: "yes"
    },
    model: "old-model",
    modelOverrides: { "claude-opus-5": "old-deployment" },
    permissions: { allow: ["Bash(npm test)"] },
    theme: "dark"
  }));
  const parsed = JSON.parse(result.content);
  assert.deepEqual(parsed.env, { KEEP_ME: "yes" });
  assert.deepEqual(parsed.permissions, { allow: ["Bash(npm test)"] });
  assert.equal(parsed.theme, "dark");
  assert.equal("model" in parsed, false);
  assert.equal("modelOverrides" in parsed, false);
  assert.equal(result.removed.includes("env.ANTHROPIC_AUTH_TOKEN"), true);
});

test("detects whether a provider catalog can serve the fixed Auto classifier model", () => {
  assert.equal(isClaudeAutoClassifierCompatible(["claude-sonnet-4-6", "claude-opus-5"]), false);
  assert.equal(isClaudeAutoClassifierCompatible(["CLAUDE-SONNET-5", "claude-opus-5"]), true);
});

test("normalizes only supported Claude permission strategies", () => {
  assert.equal(normalizeClaudePermissionStrategy("acceptEdits"), "acceptEdits");
  assert.equal(normalizeClaudePermissionStrategy("bypassPermissions"), "bypassPermissions");
  assert.equal(normalizeClaudePermissionStrategy("dangerouslySkip"), undefined);
});

test("merges managed env into a Claude JSON document preserving unrelated keys", () => {
  const original = JSON.stringify({
    permissions: { defaultMode: "acceptEdits" },
    env: {
      ANTHROPIC_BASE_URL: "https://old.example.com",
      CUSTOM_USER_VAR: "keep-me"
    },
    mcpServers: { echo: { command: "echo" } }
  }, null, 2);
  const result = mergeClaudeJsonEnv(
    original,
    new Set(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]),
    [{ name: "ANTHROPIC_BASE_URL", value: "https://new.example.com" }]
  );
  assert.equal(result.changed, true);
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.env.ANTHROPIC_BASE_URL, "https://new.example.com");
  assert.equal(parsed.env.CUSTOM_USER_VAR, "keep-me");
  assert.equal(parsed.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(parsed.permissions.defaultMode, "acceptEdits");
  assert.equal(parsed.mcpServers.echo.command, "echo");
});

test("clear removes only managed keys and drops an emptied env object", () => {
  const original = JSON.stringify({
    env: { ANTHROPIC_BASE_URL: "https://x", ANTHROPIC_AUTH_TOKEN: "t", USER_KEY: "v" }
  }, null, 2);
  const result = clearClaudeManagedJsonEnv(
    original,
    new Set(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"])
  );
  assert.equal(result.changed, true);
  const parsed = JSON.parse(result.content);
  assert.deepEqual(parsed.env, { USER_KEY: "v" });

  const emptied = clearClaudeManagedJsonEnv(
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://x" } }, null, 2),
    new Set(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"])
  );
  assert.equal(JSON.parse(emptied.content).env, undefined);

  const untouched = clearClaudeManagedJsonEnv(
    JSON.stringify({ env: { USER_KEY: "v" } }, null, 2),
    new Set(["ANTHROPIC_BASE_URL"])
  );
  assert.equal(untouched.changed, false);
});

test("merge keeps env absent when nothing is wanted and rejects broken documents", () => {
  const absent = mergeClaudeJsonEnv(
    JSON.stringify({ permissions: { defaultMode: "manual" } }, null, 2),
    new Set(["ANTHROPIC_BASE_URL"]),
    []
  );
  assert.equal(absent.changed, false);
  assert.equal(JSON.parse(absent.content).env, undefined);

  assert.throws(
    () => mergeClaudeJsonEnv("not json", new Set(["ANTHROPIC_BASE_URL"]), []),
    /JSON/
  );
  assert.throws(
    () => mergeClaudeJsonEnv("[1,2,3]", new Set(["ANTHROPIC_BASE_URL"]), []),
    /根节点/
  );
});