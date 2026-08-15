const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CLAUDE_DESKTOP_1P_MODE,
  CLAUDE_DESKTOP_3P_MODE,
  CLAUDE_DESKTOP_ALIAS_MODELS,
  applyClaudeDesktopEntry,
  buildClaudeDesktopAliasEntries,
  buildClaudeDesktopGatewayConfig,
  buildClaudeDesktopModelEntries,
  inferClaudeDesktopTier,
  isClaudeDesktopCompatibleModel,
  getClaudeDesktopEntryFile,
  getClaudeDesktopRootCandidates,
  getClaudeDesktopWriteLayouts,
  parseClaudeDesktopMeta,
  readClaudeDesktopDeploymentMode,
  readClaudeDesktopGatewayBaseUrl,
  removeClaudeDesktopEntry,
  resolveClaudeDesktopLayout,
  serializeClaudeDesktopMeta,
  setClaudeDesktopDeploymentMode,
  toClaudeDesktopEntryId
} = require("../out/claudeDesktop.js");

test("Windows probes Local before Roaming", () => {
  assert.deepEqual(
    getClaudeDesktopRootCandidates("win32", {
      homedir: "C:\\Users\\me",
      localAppData: "C:\\Users\\me\\AppData\\Local",
      appData: "C:\\Users\\me\\AppData\\Roaming"
    }),
    ["C:\\Users\\me\\AppData\\Local\\Claude", "C:\\Users\\me\\AppData\\Roaming\\Claude"]
  );
});

test("Windows falls back to the home directory when the variables are unset", () => {
  // "" means "not set" — the helper must not reach into the real environment here.
  assert.deepEqual(
    getClaudeDesktopRootCandidates("win32", {
      homedir: "C:\\Users\\me",
      localAppData: "",
      appData: ""
    }),
    ["C:\\Users\\me\\AppData\\Local\\Claude", "C:\\Users\\me\\AppData\\Roaming\\Claude"]
  );
});

test("macOS and Linux candidates use POSIX separators", () => {
  assert.deepEqual(getClaudeDesktopRootCandidates("darwin", { homedir: "/Users/me" }), [
    "/Users/me/Library/Application Support/Claude"
  ]);
  assert.deepEqual(getClaudeDesktopRootCandidates("linux", { homedir: "/home/me", xdgConfigHome: "" }), [
    "/home/me/.config/Claude"
  ]);
  assert.deepEqual(
    getClaudeDesktopRootCandidates("linux", { homedir: "/home/me", xdgConfigHome: "/data/config" }),
    ["/data/config/Claude", "/home/me/.config/Claude"]
  );
});

test("the 3P profile lives in a sibling directory while the bootstrap file stays put", () => {
  const root = "C:\\Users\\me\\AppData\\Local\\Claude";
  const first = resolveClaudeDesktopLayout(root, CLAUDE_DESKTOP_1P_MODE, "win32");
  assert.equal(first.profileDir, root);
  assert.equal(first.metaFile, `${root}\\configLibrary\\_meta.json`);

  const third = resolveClaudeDesktopLayout(root, CLAUDE_DESKTOP_3P_MODE, "win32");
  assert.equal(third.profileDir, `${root}-3p`);
  assert.equal(third.bootstrapFile, `${root}\\claude_desktop_config.json`);
  assert.equal(third.profileConfigFile, `${root}-3p\\claude_desktop_config.json`);
  assert.equal(getClaudeDesktopEntryFile(third, "abc", "win32"), `${root}-3p\\configLibrary\\abc.json`);

  // An unset mode behaves like 1P instead of producing a "Claude-" directory.
  assert.equal(resolveClaudeDesktopLayout(root, "", "win32").profileDir, root);
});

test("writes target both the plain and the 3P profile directories", () => {
  const layouts = getClaudeDesktopWriteLayouts("/Users/me/Library/Application Support/Claude", "darwin");
  assert.deepEqual(
    layouts.map((layout) => layout.profileDir),
    [
      "/Users/me/Library/Application Support/Claude",
      "/Users/me/Library/Application Support/Claude-3p"
    ]
  );
});

test("entry ids are stable, unique and filename-safe", () => {
  const id = toClaudeDesktopEntryId("relay-a");
  assert.equal(id, toClaudeDesktopEntryId("relay-a"));
  assert.notEqual(id, toClaudeDesktopEntryId("relay-b"));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("setting the deployment mode preserves everything else in the document", () => {
  const original = JSON.stringify({ mcpServers: { fs: { command: "node" } }, deploymentMode: "1p" });
  const { content, changed } = setClaudeDesktopDeploymentMode(original, CLAUDE_DESKTOP_3P_MODE);
  assert.equal(changed, true);
  const parsed = JSON.parse(content);
  assert.equal(parsed.deploymentMode, "3p");
  assert.deepEqual(parsed.mcpServers, { fs: { command: "node" } });
  // A no-op write must be detectable so the caller can skip the backup.
  assert.equal(setClaudeDesktopDeploymentMode(content, CLAUDE_DESKTOP_3P_MODE).changed, false);
});

test("a missing document is empty but a malformed one refuses to be overwritten", () => {
  assert.equal(readClaudeDesktopDeploymentMode(undefined), "");
  assert.equal(readClaudeDesktopDeploymentMode("   "), "");
  assert.equal(JSON.parse(setClaudeDesktopDeploymentMode(undefined, "3p").content).deploymentMode, "3p");
  assert.throws(() => setClaudeDesktopDeploymentMode("{ not json", "3p"), /不是有效的 JSON/);
  assert.throws(() => setClaudeDesktopDeploymentMode("[1,2]", "3p"), /根节点不是对象/);
});

test("the entry library upserts, applies and unlinks", () => {
  let meta = parseClaudeDesktopMeta(undefined);
  assert.deepEqual(meta, { appliedId: "", entries: [] });

  meta = applyClaudeDesktopEntry(meta, { id: "a", name: "Relay A" });
  meta = applyClaudeDesktopEntry(meta, { id: "b", name: "Relay B" });
  assert.equal(meta.appliedId, "b");

  // Re-applying renames in place instead of duplicating the entry.
  meta = applyClaudeDesktopEntry(meta, { id: "a", name: "Relay A2" });
  assert.equal(meta.appliedId, "a");
  assert.deepEqual(meta.entries, [
    { id: "b", name: "Relay B" },
    { id: "a", name: "Relay A2" }
  ]);

  // Removing the live entry must clear the pointer, or the app applies a missing file.
  meta = removeClaudeDesktopEntry(meta, "a");
  assert.deepEqual(meta, { appliedId: "", entries: [{ id: "b", name: "Relay B" }] });
  // Removing an inactive entry leaves the pointer alone.
  meta = removeClaudeDesktopEntry(applyClaudeDesktopEntry(meta, { id: "c", name: "C" }), "b");
  assert.equal(meta.appliedId, "c");

  assert.deepEqual(parseClaudeDesktopMeta(serializeClaudeDesktopMeta(meta)), meta);
});

test("junk entries written by other tools are ignored, not propagated", () => {
  const meta = parseClaudeDesktopMeta(
    JSON.stringify({ appliedId: " a ", entries: [{ id: "a" }, { name: "no id" }, "nope", null] })
  );
  assert.equal(meta.appliedId, "a");
  assert.deepEqual(meta.entries, [{ id: "a", name: "" }]);
});

test("a gateway entry keeps unknown keys and inherits the egress allowlist", () => {
  const existing = JSON.stringify({
    inferenceProvider: "gateway",
    inferenceGatewayBaseUrl: "https://old.example.com",
    inferenceModels: ["old-model"],
    coworkEgressAllowedHosts: ["keep.example.com"],
    someFutureFlag: true
  });
  const updated = JSON.parse(
    buildClaudeDesktopGatewayConfig(existing, { baseUrl: "https://new.example.com", apiKey: "sk-1" })
  );
  assert.equal(updated.inferenceGatewayBaseUrl, "https://new.example.com");
  assert.equal(updated.inferenceGatewayApiKey, "sk-1");
  assert.equal(updated.inferenceGatewayAuthScheme, "bearer");
  assert.equal(updated.disableDeploymentModeChooser, true);
  assert.equal(updated.someFutureFlag, true);
  assert.deepEqual(updated.coworkEgressAllowedHosts, ["keep.example.com"]);
  // No model list means "let the app decide", not "keep the previous provider's models".
  assert.equal("inferenceModels" in updated, false);

  const fresh = JSON.parse(
    buildClaudeDesktopGatewayConfig(
      undefined,
      { baseUrl: "https://new.example.com", apiKey: "sk-2", models: ["m1", "m2"] },
      existing
    )
  );
  assert.deepEqual(fresh.inferenceModels, ["m1", "m2"]);
  assert.deepEqual(fresh.coworkEgressAllowedHosts, ["keep.example.com"]);
  // Only the network policy is inherited — not the donor's provider settings.
  assert.equal(fresh.someFutureFlag, undefined);
  assert.equal(fresh.inferenceGatewayApiKey, "sk-2");
});

test("only Anthropic-shaped model IDs are considered usable", () => {
  // The app resolves bare tier aliases itself.
  for (const name of ["sonnet", "opus-4.5", "haiku", "fable", "mythos"]) {
    assert.equal(isClaudeDesktopCompatibleModel(name), true, name);
  }
  for (const name of ["claude-opus-4-8", "anthropic/claude-sonnet-4-5", "CLAUDE-HAIKU-4-5"]) {
    assert.equal(isClaudeDesktopCompatibleModel(name), true, name);
  }
  // The app refuses these outright and reports the whole config as invalid.
  for (const name of ["deepseek-chat", "deepseek-v4-pro", "gpt-5", "qwen-max", "glm-4", "kimi-k2", ""]) {
    assert.equal(isClaudeDesktopCompatibleModel(name), false, name);
  }
});

test("the model list drops what the desktop app would reject and reports it", () => {
  const { entries, rejected } = buildClaudeDesktopModelEntries([
    "claude-opus-4-8",
    "deepseek-v4-pro",
    "claude-haiku-4-5"
  ]);
  assert.deepEqual(entries, [{ name: "claude-opus-4-8" }, { name: "claude-haiku-4-5" }]);
  assert.deepEqual(rejected, ["deepseek-v4-pro"]);

  // A provider serving only its own model names yields nothing usable, and the
  // caller has to say so rather than write a config the app will refuse.
  const none = buildClaudeDesktopModelEntries(["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.deepEqual(none.entries, []);
  assert.deepEqual(none.rejected, ["deepseek-v4-flash", "deepseek-v4-pro"]);
});

test("the mapping becomes tier hints and the main model leads the list", () => {
  const { entries } = buildClaudeDesktopModelEntries(
    ["claude-haiku-4-5", "claude-opus-4-8", "claude-sonnet-4-5"],
    {
      defaultModel: "claude-opus-4-8",
      opus: "claude-opus-4-8",
      sonnet: "claude-sonnet-4-5",
      haiku: "claude-haiku-4-5",
      supports1m: true
    }
  );
  // The first entry is the app's default model, so the mapped main model leads.
  assert.deepEqual(entries[0], {
    name: "claude-opus-4-8",
    anthropicFamilyTier: "opus",
    isFamilyDefault: true,
    supports1m: true
  });
  assert.deepEqual(entries.map((entry) => entry.name), [
    "claude-opus-4-8",
    "claude-haiku-4-5",
    "claude-sonnet-4-5"
  ]);
  assert.equal(entries.find((entry) => entry.name === "claude-sonnet-4-5").anthropicFamilyTier, "sonnet");
  // No duplicate entry for the model that was both the default and in the list.
  assert.equal(entries.length, 3);
});

test("only one entry per tier is marked as the family default", () => {
  const { entries } = buildClaudeDesktopModelEntries(["claude-opus-4-8", "claude-opus-4-7"], {
    opus: "claude-opus-4-8"
  });
  assert.equal(entries.filter((entry) => entry.isFamilyDefault).length, 1);
  assert.equal(entries[1].anthropicFamilyTier, undefined);
});

test("the model list is written into the config entry, and cleared when empty", () => {
  const withModels = JSON.parse(
    buildClaudeDesktopGatewayConfig(undefined, {
      baseUrl: "https://a.com",
      apiKey: "k",
      models: [{ name: "claude-opus-4-8", anthropicFamilyTier: "opus" }]
    })
  );
  assert.deepEqual(withModels.inferenceModels, [
    { name: "claude-opus-4-8", anthropicFamilyTier: "opus" }
  ]);
  const cleared = JSON.parse(
    buildClaudeDesktopGatewayConfig(JSON.stringify(withModels), { baseUrl: "https://a.com", apiKey: "k" })
  );
  assert.equal("inferenceModels" in cleared, false);
});

test("only a gateway entry reports a base URL", () => {
  assert.equal(
    readClaudeDesktopGatewayBaseUrl(
      JSON.stringify({ inferenceProvider: "gateway", inferenceGatewayBaseUrl: " https://a.com " })
    ),
    "https://a.com"
  );
  assert.equal(
    readClaudeDesktopGatewayBaseUrl(JSON.stringify({ inferenceProvider: "anthropic" })),
    ""
  );
  assert.equal(readClaudeDesktopGatewayBaseUrl(undefined), "");
});

test("the standard alias set is one entry per tier and all names pass the app's check", () => {
  assert.deepEqual([...CLAUDE_DESKTOP_ALIAS_MODELS], [
    "claude-sonnet-4-5",
    "claude-opus-4-5",
    "claude-haiku-4-5"
  ]);
  for (const name of CLAUDE_DESKTOP_ALIAS_MODELS) {
    assert.equal(isClaudeDesktopCompatibleModel(name), true, name);
  }
});

test("a tier is read out of an Anthropic-style model ID", () => {
  assert.equal(inferClaudeDesktopTier("claude-opus-4-5"), "opus");
  assert.equal(inferClaudeDesktopTier("claude-3-5-haiku-20241022"), "haiku");
  assert.equal(inferClaudeDesktopTier("claude-sonnet-4-20250514"), "sonnet");
  assert.equal(inferClaudeDesktopTier("claude-instant"), undefined);
});

test("a tier name embedded in a longer word is not matched", () => {
  // "opusculum" is not the opus tier; a substring test would claim it is.
  assert.equal(inferClaudeDesktopTier("claude-opusculum"), undefined);
});

test("aliases carry their own tier, a family default, and the gateway label", () => {
  const { entries, rejected } = buildClaudeDesktopAliasEntries([...CLAUDE_DESKTOP_ALIAS_MODELS], "deepseek");
  assert.deepEqual(rejected, []);
  assert.deepEqual(entries, [
    { name: "claude-sonnet-4-5", anthropicFamilyTier: "sonnet", isFamilyDefault: true, labelOverride: "Sonnet · deepseek" },
    { name: "claude-opus-4-5", anthropicFamilyTier: "opus", isFamilyDefault: true, labelOverride: "Opus · deepseek" },
    { name: "claude-haiku-4-5", anthropicFamilyTier: "haiku", isFamilyDefault: true, labelOverride: "Haiku · deepseek" }
  ]);
});

test("the first alias claiming a tier is the only family default", () => {
  const { entries } = buildClaudeDesktopAliasEntries(["claude-opus-4-5", "claude-opus-4-1"], "relay");
  assert.equal(entries[0].isFamilyDefault, true);
  assert.equal(entries[1].isFamilyDefault, undefined);
  assert.equal(entries[1].anthropicFamilyTier, "opus");
});

test("aliases the app would refuse are reported instead of written", () => {
  const { entries, rejected } = buildClaudeDesktopAliasEntries(
    ["claude-opus-4-5", "deepseek-v4-pro", "gpt-4o"],
    "deepseek"
  );
  assert.deepEqual(entries.map((entry) => entry.name), ["claude-opus-4-5"]);
  assert.deepEqual(rejected, ["deepseek-v4-pro", "gpt-4o"]);
});

test("blank and duplicate aliases are dropped without disturbing the order", () => {
  const { entries } = buildClaudeDesktopAliasEntries(
    ["  claude-opus-4-5 ", "", "claude-opus-4-5", "claude-haiku-4-5"],
    "relay"
  );
  assert.deepEqual(entries.map((entry) => entry.name), ["claude-opus-4-5", "claude-haiku-4-5"]);
});

test("no label is written when the gateway name is blank", () => {
  const { entries } = buildClaudeDesktopAliasEntries(["claude-opus-4-5"], "   ");
  assert.deepEqual(entries, [
    { name: "claude-opus-4-5", anthropicFamilyTier: "opus", isFamilyDefault: true }
  ]);
});

test("an alias with no recognizable tier still gets a label from its own name", () => {
  const { entries } = buildClaudeDesktopAliasEntries(["claude-instant"], "relay");
  assert.equal(entries[0].anthropicFamilyTier, undefined);
  assert.equal(entries[0].labelOverride, "claude-instant · relay");
});

test("alias entries survive a round trip through the desktop config", () => {
  const { entries } = buildClaudeDesktopAliasEntries([...CLAUDE_DESKTOP_ALIAS_MODELS], "deepseek");
  const config = JSON.parse(
    buildClaudeDesktopGatewayConfig(undefined, {
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKey: "sk-test",
      models: entries
    })
  );
  assert.deepEqual(config.inferenceModels, entries);
  assert.equal(config.inferenceModels[0].name, "claude-sonnet-4-5");
});
