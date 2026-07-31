const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CODEX_MANAGED_BEGIN,
  CODEX_MANAGED_END,
  createCodexAuthConfig,
  createCodexModelCatalog,
  findUnmanagedCodexProxyEnv,
  getCodexApiBaseUrl,
  normalizeCodexProxyUrl,
  normalizeProviderRootUrl,
  parseMacOsProxySettings,
  parseWindowsProxyServer,
  parseTopLevelTomlString,
  removeManagedCodexEnv,
  removeManagedCodexProviders,
  removeUnmanagedCodexProxyEnv,
  updateManagedCodexEnv,
  updateTopLevelTomlKey
} = require("../out/codexConfig.js");

test("creates platform-specific Codex auth commands", () => {
  assert.deepEqual(createCodexAuthConfig("win32", "C:\\Users\\me\\.codex\\auth.ps1", "C:\\Users\\me\\.codex\\key"), {
    command: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "C:\\Users\\me\\.codex\\auth.ps1", "C:\\Users\\me\\.codex\\key"]
  });
  assert.deepEqual(createCodexAuthConfig("darwin", "/Users/me/.codex/auth.sh", "/Users/me/.codex/key"), {
    command: "/Users/me/.codex/auth.sh",
    args: ["/Users/me/.codex/key"]
  });
  assert.deepEqual(createCodexAuthConfig("linux", "/home/me/.codex/auth.sh", "/home/me/.codex/key"), {
    command: "/home/me/.codex/auth.sh",
    args: ["/home/me/.codex/key"]
  });
});

test("stores provider roots and derives the Codex API base URL", () => {
  assert.equal(normalizeProviderRootUrl("https://api.example.com"), "https://api.example.com");
  assert.equal(normalizeProviderRootUrl("https://api.example.com/v1/"), "https://api.example.com");
  assert.equal(getCodexApiBaseUrl("https://api.example.com"), "https://api.example.com/v1");
  assert.equal(getCodexApiBaseUrl("https://api.example.com/v1/"), "https://api.example.com/v1");
});

test("updates only top-level model fields", () => {
  const original = [
    'notify = ["tool"]',
    "",
    "[marketplaces.example]",
    'model = "nested-value"'
  ].join("\n");
  const updated = updateTopLevelTomlKey(
    updateTopLevelTomlKey(original, "model_provider", "pateway"),
    "model",
    "gpt-5.6-sol"
  );
  assert.equal(parseTopLevelTomlString(updated, "model_provider"), "pateway");
  assert.equal(parseTopLevelTomlString(updated, "model"), "gpt-5.6-sol");
  assert.match(updated, /\[marketplaces\.example\]\nmodel = "nested-value"/);
});

test("removes only the managed provider block", () => {
  const original = [
    'model = "gpt-5.6-sol"',
    CODEX_MANAGED_BEGIN,
    "[model_providers.pateway]",
    'base_url = "https://api.pateway.ai/v1"',
    CODEX_MANAGED_END,
    "[features]",
    "js_repl = false"
  ].join("\n");
  const updated = removeManagedCodexProviders(original);
  assert.doesNotMatch(updated, /model_providers\.pateway/);
  assert.match(updated, /\[features\]/);
  assert.match(updated, /js_repl = false/);
});

test("removes a missing original top-level key during restore", () => {
  const managed = 'model_provider = "pateway"\nmodel = "gpt-5.6-sol"\n[features]\njs_repl = false';
  const restored = updateTopLevelTomlKey(
    updateTopLevelTomlKey(managed, "model_provider", undefined),
    "model",
    undefined
  );
  assert.equal(parseTopLevelTomlString(restored, "model_provider"), undefined);
  assert.equal(parseTopLevelTomlString(restored, "model"), undefined);
  assert.match(restored, /\[features\]/);
});

test("creates a Codex-native model catalog for the picker", () => {
  const catalog = createCodexModelCatalog(["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-sol"]);
  assert.equal(catalog.models.length, 2);
  assert.equal(catalog.models[0].slug, "gpt-5.6-sol");
  assert.equal(catalog.models[0].visibility, "list");
  assert.equal(catalog.models[0].supported_in_api, true);
});

test("documents trimming encrypted key files before DPAPI decryption", () => {
  const extensionSource = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "src", "extension.ts"),
    "utf8"
  );
  assert.match(extensionSource, /Get-Content -Raw -LiteralPath \$args\[0\]\)\.Trim\(\)/);
});

test("validates and normalizes Codex proxy URLs", () => {
  assert.equal(normalizeCodexProxyUrl(" http://127.0.0.1:4780 "), "http://127.0.0.1:4780");
  assert.equal(normalizeCodexProxyUrl("https://proxy.example.com:8443"), "https://proxy.example.com:8443");
  assert.throws(() => normalizeCodexProxyUrl("socks5://127.0.0.1:1080"), /http:\/\/ 或 https:\/\//);
  assert.throws(() => normalizeCodexProxyUrl("http://127.0.0.1:4780/path"), /不能包含路径/);
});

test("updates only the managed Codex proxy environment block", () => {
  const original = 'CUSTOM_SETTING="keep-me"\n';
  const configured = updateManagedCodexEnv(original, "http://127.0.0.1:4780");
  assert.match(configured, /CUSTOM_SETTING="keep-me"/);
  assert.match(configured, /HTTP_PROXY="http:\/\/127\.0\.0\.1:4780"/);
  assert.match(configured, /HTTPS_PROXY="http:\/\/127\.0\.0\.1:4780"/);
  const updated = updateManagedCodexEnv(configured, "http://127.0.0.1:7890");
  assert.doesNotMatch(updated, /4780/);
  assert.match(updated, /CUSTOM_SETTING="keep-me"/);
  assert.equal(removeManagedCodexEnv(updated), 'CUSTOM_SETTING="keep-me"');
});

test("parses Windows system proxy formats without assuming a fixed port", () => {
  assert.equal(parseWindowsProxyServer("127.0.0.1:4780"), "http://127.0.0.1:4780");
  assert.equal(
    parseWindowsProxyServer("http=127.0.0.1:7890;https=127.0.0.1:10808"),
    "http://127.0.0.1:10808"
  );
  assert.equal(parseWindowsProxyServer("socks=127.0.0.1:1080"), undefined);
});

test("parses macOS system proxy output", () => {
  const output = [
    "<dictionary> {",
    "  HTTPEnable : 1",
    "  HTTPPort : 7890",
    "  HTTPProxy : 127.0.0.1",
    "}"
  ].join("\n");
  assert.equal(parseMacOsProxySettings(output), "http://127.0.0.1:7890");
});

test("detects and removes unmanaged proxy entries without deleting other env settings", () => {
  const content = [
    'CUSTOM_SETTING="keep-me"',
    'HTTP_PROXY="http://127.0.0.1:4780"',
    "export https_proxy='http://127.0.0.1:7890'",
    'NO_PROXY="localhost"'
  ].join("\n");
  const entries = findUnmanagedCodexProxyEnv(content);
  assert.deepEqual(entries.map((entry) => entry.name), ["HTTP_PROXY", "https_proxy", "NO_PROXY"]);
  const cleaned = removeUnmanagedCodexProxyEnv(content);
  assert.equal(cleaned, 'CUSTOM_SETTING="keep-me"');
});