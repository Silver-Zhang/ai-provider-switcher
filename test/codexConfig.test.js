const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CODEX_MANAGED_BEGIN,
  CODEX_MANAGED_END,
  createCodexModelCatalog,
  getCodexApiBaseUrl,
  normalizeProviderRootUrl,
  parseTopLevelTomlString,
  removeManagedCodexProviders,
  updateTopLevelTomlKey
} = require("../out/codexConfig.js");

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