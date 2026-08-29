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
  mapClaudeDesktopModelName,
  normalizeClaudeModelMapping,
  normalizeClaudePermissionStrategy,
  normalizeClaudeProviderBaseUrl,
  normalizeClaudeProviderUrl,
  parseClaudeJsonObject,
  stripClaudeProviderSettingsJson,
  suggestClaudeModelRoles
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

test("role suggestion splits a provider's models into the strong and the fast one", () => {
  const roleOf = (rows, name) => rows.find((row) => row.name === name)?.role;
  const deepSeek = suggestClaudeModelRoles(["deepseek-v4-pro", "deepseek-v4-flash"]);
  assert.equal(roleOf(deepSeek, "deepseek-v4-pro"), "main");
  assert.equal(roleOf(deepSeek, "deepseek-v4-flash"), "haiku");
  // Order of the input must not decide the outcome.
  const reversed = suggestClaudeModelRoles(["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.equal(roleOf(reversed, "deepseek-v4-pro"), "main");
  assert.equal(roleOf(reversed, "deepseek-v4-flash"), "haiku");
  // The middle model stays unassigned and falls back to the main model.
  const three = suggestClaudeModelRoles(["glm-4-plus", "glm-4-air", "glm-4"]);
  assert.equal(roleOf(three, "glm-4-plus"), "main");
  assert.equal(roleOf(three, "glm-4-air"), "haiku");
  assert.equal(roleOf(three, "glm-4"), "");
});

test("role suggestion reads `chat` as the ordinary model, not the strong one", () => {
  const roleOf = (rows, name) => rows.find((row) => row.name === name)?.role;
  // DeepSeek's own pair on the Anthropic-compatible endpoint. Treating `chat` as a
  // strength marker put the cheap model in the main role and the reasoner in haiku.
  const deepSeek = suggestClaudeModelRoles(["deepseek-chat", "deepseek-reasoner"]);
  assert.equal(roleOf(deepSeek, "deepseek-reasoner"), "main");
  assert.equal(roleOf(deepSeek, "deepseek-chat"), "haiku");
  const reversed = suggestClaudeModelRoles(["deepseek-reasoner", "deepseek-chat"]);
  assert.equal(roleOf(reversed, "deepseek-reasoner"), "main");
  assert.equal(roleOf(reversed, "deepseek-chat"), "haiku");
});

test("desktop alias maps back to the real model by tier", () => {
  const mapping = {
    mainModel: "gpt-5.6",
    opusModel: "gpt-5.6-opus",
    sonnetModel: "gpt-5.6-sonnet",
    haikuModel: "gpt-5.6-mini",
    fableModel: "gpt-5.6-fable",
    subagentModel: "gpt-5.6-mini"
  };
  assert.equal(mapClaudeDesktopModelName("claude-opus-5", mapping), "gpt-5.6-opus");
  assert.equal(mapClaudeDesktopModelName("claude-sonnet-5", mapping), "gpt-5.6-sonnet");
  assert.equal(mapClaudeDesktopModelName("claude-haiku-5", mapping), "gpt-5.6-mini");
  assert.equal(mapClaudeDesktopModelName("claude-fable-5", mapping), "gpt-5.6-fable");
  // Bare tier names and the desktop app's `anthropic/` prefix both resolve.
  assert.equal(mapClaudeDesktopModelName("opus", mapping), "gpt-5.6-opus");
  assert.equal(mapClaudeDesktopModelName("anthropic/claude-opus-5", mapping), "gpt-5.6-opus");
  // The `[1m]` capability marker is shed before forwarding, case-insensitively.
  assert.equal(mapClaudeDesktopModelName("claude-opus-5[1m]", mapping), "gpt-5.6-opus");
  assert.equal(mapClaudeDesktopModelName("claude-opus-5[1M]", mapping), "gpt-5.6-opus");
  // `mythos` and unknown names have no mapping role, so they fall to the main model.
  assert.equal(mapClaudeDesktopModelName("claude-mythos-5", mapping), "gpt-5.6");
  assert.equal(mapClaudeDesktopModelName("some-unknown", mapping), "gpt-5.6");
  // No mapping means nothing to rewrite.
  assert.equal(mapClaudeDesktopModelName("claude-opus-5", undefined), "claude-opus-5");
});

test("desktop alias falls back to the main model when a tier is unset", () => {
  // fableModel omitted: normalization backfills it from mainModel, but the rewrite
  // must not return undefined for the fable route.
  const mapping = { mainModel: "gpt-5.6", opusModel: "gpt-5.6-opus" };
  assert.equal(mapClaudeDesktopModelName("claude-fable-5", mapping), "gpt-5.6");
  assert.equal(mapClaudeDesktopModelName("claude-sonnet-5", mapping), "gpt-5.6");
});

test("role suggestion still names a main model when nothing looks fast or strong", () => {
  const single = suggestClaudeModelRoles(["some-model"]);
  assert.deepEqual(single, [{ name: "some-model", role: "main" }]);
  // With no hints at all the provider's own order decides, first is flagship.
  const flat = suggestClaudeModelRoles(["model-a", "model-b"]);
  assert.equal(flat[0].role, "main");
  assert.equal(flat[1].role, "haiku");
  assert.deepEqual(suggestClaudeModelRoles([]), []);
  assert.deepEqual(suggestClaudeModelRoles(["  ", ""]), []);
});

test("a suggested mapping resolves every role once normalized", () => {
  const rows = suggestClaudeModelRoles(["qwen3-max", "qwen3-turbo"]);
  const pick = (role) => rows.find((row) => row.role === role)?.name;
  const mapping = normalizeClaudeModelMapping({
    mainModel: pick("main"),
    haikuModel: pick("haiku")
  });
  assert.equal(mapping.mainModel, "qwen3-max");
  assert.equal(mapping.opusModel, "qwen3-max");
  assert.equal(mapping.sonnetModel, "qwen3-max");
  assert.equal(mapping.haikuModel, "qwen3-turbo");
  assert.equal(mapping.subagentModel, "qwen3-turbo");
});

test("a model declared 1M is suffixed in every role it fills, including the fallbacks", () => {
  // Only `main` and `haiku` are assigned; opus/sonnet/fable fall back to the
  // main model, and the declaration has to follow the model into them.
  const mapping = normalizeClaudeModelMapping({
    mainModel: "pro",
    haikuModel: "fast",
    longContextModels: ["pro"]
  });
  const environment = createClaudeModelEnvironment(mapping);
  const valueOf = (name) => environment.find((entry) => entry.name === name)?.value;
  assert.equal(valueOf("ANTHROPIC_MODEL"), "pro[1m]");
  assert.equal(valueOf("ANTHROPIC_DEFAULT_OPUS_MODEL"), "pro[1m]");
  assert.equal(valueOf("ANTHROPIC_DEFAULT_SONNET_MODEL"), "pro[1m]");
  assert.equal(valueOf("ANTHROPIC_DEFAULT_FABLE_MODEL"), "pro[1m]");
  assert.equal(valueOf("ANTHROPIC_CUSTOM_MODEL_OPTION"), "pro[1m]");
  // The fast model was not declared, so it keeps its own window.
  assert.equal(valueOf("ANTHROPIC_DEFAULT_HAIKU_MODEL"), "fast");
  assert.equal(valueOf("CLAUDE_CODE_SUBAGENT_MODEL"), "fast");
});

test("a 1M declaration on a model that fills no role survives a round trip", () => {
  const mapping = normalizeClaudeModelMapping({
    mainModel: "pro",
    haikuModel: "fast",
    longContextModels: ["pro", "spare"]
  });
  assert.deepEqual(mapping.longContextModels, ["pro", "spare"]);
  // Re-normalizing its own output is stable — the editor reads back what it wrote.
  assert.deepEqual(normalizeClaudeModelMapping(mapping).longContextModels, ["pro", "spare"]);
  // An unmapped model names no role, so the derived legacy field skips it.
  assert.equal(mapping.longContextRoles.includes("main"), true);
  assert.equal(mapping.longContextRoles.length, 4);
});

test("a stored per-role declaration is read as the models those roles point at", () => {
  const mapping = normalizeClaudeModelMapping({
    mainModel: "pro",
    haikuModel: "fast",
    longContextRoles: ["haiku", "subagent"]
  });
  assert.deepEqual(mapping.longContextModels, ["fast"]);
  assert.equal(mapping.supports1m, false);
});

test("longContextModels wins over a stale stored longContextRoles", () => {
  const mapping = normalizeClaudeModelMapping({
    mainModel: "pro",
    haikuModel: "fast",
    longContextRoles: ["haiku"],
    longContextModels: ["pro"]
  });
  assert.deepEqual(mapping.longContextModels, ["pro"]);
  assert.equal(mapping.longContextRoles.includes("haiku"), false);
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
  // The roles are derived from the declared models and only read with
  // `includes`, so the set is the guarantee — not the order it comes out in.
  assert.deepEqual([...mapping.longContextRoles].sort(), ["fable", "main", "opus", "sonnet"]);
  assert.deepEqual(mapping.longContextModels, ["m"]);
  assert.equal(mapping.supports1m, true);
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

test("a BOM or an empty body reads as a document, not as corruption", () => {
  // Notepad and PowerShell's `Set-Content`/`>` both prefix a BOM, and a crashed or
  // interrupted writer leaves an empty file — neither is a reason to refuse the
  // write that would repair the file.
  assert.deepEqual(parseClaudeJsonObject("﻿{\"a\":1}", "x"), { a: 1 });
  assert.deepEqual(parseClaudeJsonObject("", "x"), {});
  assert.deepEqual(parseClaudeJsonObject("   \n", "x"), {});
  assert.throws(() => parseClaudeJsonObject("﻿not json", "x"), /JSON/);
  assert.throws(() => parseClaudeJsonObject("﻿[1]", "x"), /根节点/);

  const merged = mergeClaudeJsonEnv(
    "﻿{\n  \"env\": { \"KEEP\": \"yes\" }\n}\n",
    new Set(["ANTHROPIC_BASE_URL"]),
    [{ name: "ANTHROPIC_BASE_URL", value: "https://new.example.com" }]
  );
  assert.equal(merged.changed, true);
  // The rewritten document no longer carries the BOM, so the next reader is safe too.
  assert.equal(merged.content.startsWith("{"), true);
  assert.equal(JSON.parse(merged.content).env.KEEP, "yes");

  const fromEmpty = mergeClaudeJsonEnv(
    "",
    new Set(["ANTHROPIC_BASE_URL"]),
    [{ name: "ANTHROPIC_BASE_URL", value: "https://new.example.com" }]
  );
  assert.equal(JSON.parse(fromEmpty.content).env.ANTHROPIC_BASE_URL, "https://new.example.com");

  const stripped = stripClaudeProviderSettingsJson(
    "﻿" + JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://old", KEEP: "1" } })
  );
  assert.deepEqual(JSON.parse(stripped.content).env, { KEEP: "1" });
  // An empty file has nothing to strip and must not be reported as broken.
  assert.deepEqual(stripClaudeProviderSettingsJson(""), { content: "", removed: [] });
});