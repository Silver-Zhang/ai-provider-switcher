const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  CODEX_MANAGED_BEGIN,
  CODEX_MANAGED_END,
  createCodexAuthConfig,
  createCodexModelCatalog,
  createCodexProviderId,
  findUnmanagedCodexProxyEnv,
  getCodexApiBaseUrl,
  normalizeCodexProxyUrl,
  normalizeProviderRootUrl,
  parseCodexModelIds,
  parseKdeProxySettings,
  parseMacOsProxyConfiguration,
  parseMacOsProxySettings,
  parseTomlTableKeyPath,
  parseWindowsProxyServer,
  resolveCodexHomeDir,
  parseTopLevelTomlString,
  removeManagedCodexEnv,
  removeManagedCodexProviders,
  removeUnmanagedCodexProxyEnv,
  replaceManagedCodexProviders,
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

test("keeps provider blocks while swapping the managed block", () => {
  const original = [
    'model_provider = "codex-pateway"',
    CODEX_MANAGED_BEGIN,
    "[model_providers.codex-pateway]",
    CODEX_MANAGED_END,
    "",
    "[features]",
    "js_repl = false"
  ].join("\n");
  const block = [CODEX_MANAGED_BEGIN, "[model_providers.codex-real]", CODEX_MANAGED_END].join("\n");
  const updated = replaceManagedCodexProviders(original, block);
  assert.doesNotMatch(updated, /model_providers\.codex-pateway/);
  assert.match(updated, /model_providers\.codex-real/);
  assert.match(updated, /\[features\]/);
  assert.equal(updated.match(new RegExp(CODEX_MANAGED_BEGIN, "g")).length, 1);
});

test("refreshing the managed block leaves every top-level routing key untouched", () => {
  // A provider edit must not disturb routing: while the official provider is active these keys
  // hold the user's own values, restored from the pre-switch backup.
  const original = [
    'model_provider = "my-own-provider"',
    'model = "gpt-5.6-sol"',
    'model_catalog_json = "/home/me/catalog.json"',
    CODEX_MANAGED_BEGIN,
    "[model_providers.codex-relay]",
    'name = "旧名字"',
    'base_url = "https://old.example.com/v1"',
    CODEX_MANAGED_END,
    "",
    "[features]",
    "js_repl = false"
  ].join("\n");
  const refreshed = replaceManagedCodexProviders(
    removeManagedCodexProviders(original),
    [
      CODEX_MANAGED_BEGIN,
      "[model_providers.codex-relay]",
      'name = "新名字"',
      'base_url = "https://new.example.com/v1"',
      CODEX_MANAGED_END
    ].join("\n")
  );
  assert.equal(parseTopLevelTomlString(refreshed, "model_provider"), "my-own-provider");
  assert.equal(parseTopLevelTomlString(refreshed, "model"), "gpt-5.6-sol");
  assert.equal(parseTopLevelTomlString(refreshed, "model_catalog_json"), "/home/me/catalog.json");
  assert.match(refreshed, /base_url = "https:\/\/new\.example\.com\/v1"/);
  assert.doesNotMatch(refreshed, /old\.example\.com/);
  assert.doesNotMatch(refreshed, /旧名字/);
  assert.match(refreshed, /\[features\]/);
});

test("drops the managed block only when no providers remain", () => {
  const original = [CODEX_MANAGED_BEGIN, "[model_providers.codex-pateway]", CODEX_MANAGED_END].join("\n");
  assert.equal(replaceManagedCodexProviders(original, ""), "");
  assert.equal(replaceManagedCodexProviders("[features]\n", "").trim(), "[features]");
});

test("derives stable Codex provider IDs that survive a re-add", () => {
  assert.equal(createCodexProviderId("Pateway"), "codex-pateway");
  assert.equal(createCodexProviderId("  Pateway  "), "codex-pateway");
  assert.equal(createCodexProviderId("Pateway", ["codex-pateway"]), "codex-pateway-2");
  assert.equal(createCodexProviderId("Pateway", ["codex-pateway", "codex-pateway-2"]), "codex-pateway-3");
  assert.equal(createCodexProviderId("中转站"), "codex-provider");
  assert.equal(createCodexProviderId("--Real Lab--"), "codex-real-lab");
});

test("parses hand-entered Codex model IDs", () => {
  assert.deepEqual(parseCodexModelIds("gpt-5.6-sol, gpt-5.6-luna"), ["gpt-5.6-sol", "gpt-5.6-luna"]);
  assert.deepEqual(parseCodexModelIds("gpt-5.6-sol，gpt-5.6-luna"), ["gpt-5.6-sol", "gpt-5.6-luna"]);
  assert.deepEqual(parseCodexModelIds(" gpt-5.6-sol  gpt-5.6-sol "), ["gpt-5.6-sol"]);
  assert.deepEqual(parseCodexModelIds("  ,, "), []);
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
  assert.throws(() => normalizeCodexProxyUrl("http://127.0.0.1:4780/path"), /不能包含路径/);
});

test("accepts the SOCKS proxies Codex can actually use", () => {
  // reqwest speaks SOCKS, so rejecting it locked out every SOCKS-only user.
  assert.equal(normalizeCodexProxyUrl("socks5://127.0.0.1:1080"), "socks5://127.0.0.1:1080");
  assert.equal(normalizeCodexProxyUrl("socks5h://127.0.0.1:1080"), "socks5h://127.0.0.1:1080");
  assert.throws(() => normalizeCodexProxyUrl("ftp://127.0.0.1:1080"), /只支持/);
  assert.throws(() => normalizeCodexProxyUrl("socks5://127.0.0.1:1080/path"), /不能包含路径/);
});

test("a proxy address pasted without a scheme is read as http, not rejected", () => {
  // "127.0.0.1:7890" is what Clash and v2rayN display, so it is what gets pasted.
  assert.equal(normalizeCodexProxyUrl("127.0.0.1:7890"), "http://127.0.0.1:7890");
  // A bare colon must not be mistaken for a scheme separator.
  assert.equal(normalizeCodexProxyUrl("localhost:7890"), "http://localhost:7890");
  assert.equal(normalizeCodexProxyUrl(" proxy.example.com:8080 "), "http://proxy.example.com:8080");
});

test("an unparseable proxy address is reported in Chinese, not as a raw URL error", () => {
  assert.throws(() => normalizeCodexProxyUrl("http://"), /无法解析代理地址/);
  assert.throws(() => normalizeCodexProxyUrl("   "), /不能为空/);
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
test("a PAC-configured Mac is reported as PAC instead of as no proxy at all", () => {
  const output = [
    "<dictionary> {",
    "  HTTPEnable : 0",
    "  ProxyAutoConfigEnable : 1",
    "  ProxyAutoConfigURLString : http://wpad.corp.example.com/proxy.pac",
    "}"
  ].join("\n");
  const settings = parseMacOsProxyConfiguration(output);
  assert.equal(settings.manualUrl, undefined);
  assert.equal(settings.autoConfigUrl, "http://wpad.corp.example.com/proxy.pac");
  assert.equal(settings.autoDiscover, false);
});

test("WPAD auto-discovery is distinguished from an unconfigured Mac", () => {
  const wpad = parseMacOsProxyConfiguration("  ProxyAutoDiscoveryEnable : 1");
  assert.equal(wpad.autoDiscover, true);
  assert.equal(wpad.autoConfigUrl, undefined);

  const none = parseMacOsProxyConfiguration("<dictionary> {\n  HTTPEnable : 0\n}");
  assert.equal(none.manualUrl, undefined);
  assert.equal(none.autoConfigUrl, undefined);
  assert.equal(none.autoDiscover, false);
});

test("reads a manual KDE proxy out of kioslaverc", () => {
  const content = [
    "[General]",
    "httpProxy=http://should-be-ignored 1",
    "",
    "[Proxy Settings]",
    "ProxyType=1",
    // KDE writes the port after a space rather than a colon.
    "httpProxy=http://127.0.0.1 8080",
    "httpsProxy=http://127.0.0.1 7890"
  ].join("\n");
  assert.equal(parseKdeProxySettings(content), "http://127.0.0.1:7890");
});

test("a KDE config without a manual proxy yields nothing", () => {
  // ProxyType 2 is PAC and 0 is none; neither carries a usable address.
  assert.equal(parseKdeProxySettings("[Proxy Settings]\nProxyType=2\nProxyConfigScript=http://x/y.pac"), undefined);
  assert.equal(parseKdeProxySettings("[Proxy Settings]\nProxyType=0"), undefined);
  assert.equal(parseKdeProxySettings(""), undefined);
});

test("CODEX_HOME redirects every Codex path the extension writes", () => {
  assert.equal(resolveCodexHomeDir({}, "/home/u"), path.join("/home/u", ".codex"));
  assert.equal(resolveCodexHomeDir({ CODEX_HOME: "  " }, "/home/u"), path.join("/home/u", ".codex"));
  assert.equal(resolveCodexHomeDir({ CODEX_HOME: "/opt/codex" }, "/home/u"), path.normalize("/opt/codex"));
  assert.equal(resolveCodexHomeDir({ CODEX_HOME: "~/alt-codex" }, "/home/u"), path.join("/home/u", "alt-codex"));
  // A relative CODEX_HOME must not depend on where VS Code happened to be launched.
  assert.equal(resolveCodexHomeDir({ CODEX_HOME: "alt" }, "/home/u"), path.resolve("/home/u", "alt"));
});

test("quoted and spaced TOML table headers resolve to the same key path", () => {
  assert.deepEqual(parseTomlTableKeyPath("[model_providers.custom]"), ["model_providers", "custom"]);
  assert.deepEqual(parseTomlTableKeyPath('[model_providers."custom"]'), ["model_providers", "custom"]);
  assert.deepEqual(parseTomlTableKeyPath("[model_providers.'custom']"), ["model_providers", "custom"]);
  assert.deepEqual(parseTomlTableKeyPath("[ model_providers . custom ]"), ["model_providers", "custom"]);
  assert.deepEqual(
    parseTomlTableKeyPath('[model_providers."codex-provider".auth]'),
    ["model_providers", "codex-provider", "auth"]
  );
  assert.equal(parseTomlTableKeyPath("name = \"x\""), undefined);
  assert.equal(parseTomlTableKeyPath("[[array.of.tables]]"), undefined);
});

test("rewriting a CRLF config.toml keeps it CRLF", () => {
  // Codex config files created on Windows are CRLF; converting the whole file to LF
  // showed up as a wholesale rewrite in the user's diff and in any VCS they used.
  const crlf = 'model = "gpt-5"\r\nmodel_provider = "openai"\r\n\r\n[tools]\r\nweb_search = true\r\n';
  const updated = updateTopLevelTomlKey(crlf, "model_provider", "custom");
  assert.match(updated, /model_provider = "custom"/);
  assert.equal(updated.includes("\r\n"), true);
  assert.equal(/[^\r]\n/.test(updated), false, "no bare LF may remain in a CRLF file");

  const lf = 'model = "gpt-5"\nmodel_provider = "openai"\n';
  assert.equal(updateTopLevelTomlKey(lf, "model_provider", "custom").includes("\r"), false);
});

test("rewriting a CRLF .env keeps it CRLF", () => {
  const crlf = 'CUSTOM_SETTING="keep-me"\r\n';
  const configured = updateManagedCodexEnv(crlf, "http://127.0.0.1:7890");
  assert.equal(/[^\r]\n/.test(configured), false, "managed .env block must not mix line endings");
  assert.match(configured, /HTTP_PROXY="http:\/\/127\.0\.0\.1:7890"/);

  const cleaned = removeUnmanagedCodexProxyEnv('CUSTOM_SETTING="keep-me"\r\nHTTP_PROXY="http://127.0.0.1:1"\r\n');
  assert.equal(/[^\r]\n/.test(cleaned), false);
});

test("rewriting a CRLF config.toml keeps managed provider blocks CRLF", () => {
  const crlf = 'model = "gpt-5"\r\n';
  const block = [CODEX_MANAGED_BEGIN, "[model_providers.x]", 'name = "X"', CODEX_MANAGED_END].join("\n");
  const updated = replaceManagedCodexProviders(crlf, block);
  assert.equal(/[^\r]\n/.test(updated), false, "managed provider block must not mix line endings");
  assert.match(updated, /\[model_providers\.x\]/);
});

function readExtensionSource() {
  return require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "src", "extension.ts"),
    "utf8"
  );
}

test("every child process the Codex feature spawns hides its console window", () => {
  // windowsHide defaults to false, so each probe flashed a console window on Windows —
  // several times per proxy-menu open, and once per API key save.
  const source = readExtensionSource();
  const spawns = source.match(/spawn\((?:[^()]|\([^()]*\))*\)/g) ?? [];
  assert.ok(spawns.length >= 2, "expected the Codex feature to spawn child processes");
  for (const call of spawns) {
    assert.match(call, /windowsHide: true/, `spawn call missing windowsHide: ${call}`);
  }
});

test("the Windows auth helper writes the key without PowerShell's trailing CRLF", () => {
  const source = readExtensionSource();
  // Emitting onto the pipeline appends CRLF, so Codex received "sk-xxx\r\n" on Windows
  // where the POSIX helper hands it the bare key.
  assert.match(source, /\[Console\]::Out\.Write\(\[Runtime\.InteropServices\.Marshal\]::PtrToStringBSTR/);
  // The POSIX side must match: `cat` emits the file verbatim.
  assert.doesNotMatch(source, /writeFile\(keyFile, `\$\{apiKey\}\\n`/);
});

test("Codex paths honour CODEX_HOME instead of hardcoding ~/.codex", () => {
  const source = readExtensionSource();
  assert.match(source, /const CODEX_HOME_DIR = resolveCodexHomeDir\(process\.env, os\.homedir\(\)\)/);
  // Writing to ~/.codex while Codex reads CODEX_HOME is a silent no-op.
  assert.doesNotMatch(source, /os\.homedir\(\),\s*"\.codex"/);
});

test("the proxy probe drains stderr and cannot hang the menu", () => {
  const source = readExtensionSource();
  // reg.exe is chatty about inaccessible keys; an unread pipe deadlocks the child at ~64KB.
  assert.match(source, /child\.stderr\?\.resume\(\)/);
  assert.match(source, /PROXY_PROBE_TIMEOUT_MS/);
});
