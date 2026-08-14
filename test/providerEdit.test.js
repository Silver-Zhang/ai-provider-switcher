const test = require("node:test");
const assert = require("node:assert/strict");
const { planProviderEdit, describeProviderEditOutcome, applyProviderOrder } = require("../out/providerEdit.js");

const CLAUDE = { id: "relay-1", name: "我的中转", baseUrl: "https://api.example.com" };
const CODEX = { id: "codex-my-relay", name: "我的中转", baseUrl: "https://api.example.com" };

function plan(kind, draft, { current, siblings, isActive = false } = {}) {
  const target = current ?? (kind === "claude" ? CLAUDE : CODEX);
  return planProviderEdit(kind, target, draft, siblings ?? [target], isActive);
}

test("rejects an empty name", () => {
  const result = plan("claude", { name: "   ", baseUrl: "https://api.example.com" });
  assert.equal(result.ok, false);
  assert.match(result.message, /名称不能为空/);
});

test("rejects a name already taken by another provider, case-insensitively", () => {
  const other = { id: "relay-2", name: "Backup Relay", baseUrl: "https://b.example.com" };
  const result = plan("claude", { name: "backup relay", baseUrl: "https://api.example.com" }, {
    siblings: [CLAUDE, other]
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /已存在同名服务/);
});

test("keeping your own name is not a duplicate", () => {
  const result = plan("claude", { name: "我的中转", baseUrl: "https://api.example.com" });
  assert.equal(result.ok, true);
  assert.equal(result.effects.unchanged, true);
});

test("rejects a base url without an http scheme", () => {
  for (const baseUrl of ["api.example.com", "ftp://api.example.com", "  "]) {
    const result = plan("claude", { name: "我的中转", baseUrl });
    assert.equal(result.ok, false, `expected ${baseUrl} to be rejected`);
  }
});

test("normalizes the base url and ignores cosmetic differences", () => {
  const result = plan("codex", { name: "我的中转", baseUrl: "  https://api.example.com/v1/  " });
  assert.equal(result.ok, true);
  assert.equal(result.baseUrl, "https://api.example.com");
  // Only /v1 and a trailing slash differed, so nothing downstream should be invalidated.
  assert.equal(result.effects.baseUrlChanged, false);
  assert.equal(result.effects.clearModelCache, false);
  assert.equal(result.effects.rewriteManagedBlock, false);
  assert.equal(result.effects.unchanged, true);
});

test("applies the Claude DeepSeek root rewrite", () => {
  const result = plan("claude", { name: "DeepSeek", baseUrl: "https://api.deepseek.com" });
  assert.equal(result.ok, true);
  assert.equal(result.baseUrl, "https://api.deepseek.com/anthropic");
});

test("a rename alone touches neither the model cache nor Claude's live config", () => {
  const result = plan("claude", { name: "换个名字", baseUrl: "https://api.example.com" }, { isActive: true });
  assert.equal(result.ok, true);
  assert.deepEqual(
    { ...result.effects },
    {
      nameChanged: true,
      baseUrlChanged: false,
      secretChanged: false,
      clearModelCache: false,
      rewriteLiveConfig: false,
      rewriteManagedBlock: false,
      unchanged: false
    }
  );
});

test("a Codex rename still refreshes config.toml, which names every provider", () => {
  const result = plan("codex", { name: "换个名字", baseUrl: "https://api.example.com" });
  assert.equal(result.ok, true);
  assert.equal(result.effects.rewriteManagedBlock, true);
  assert.equal(result.effects.rewriteLiveConfig, false);
});

test("a new base url clears the model cache whether or not the provider is active", () => {
  for (const isActive of [false, true]) {
    const result = plan("claude", { name: "我的中转", baseUrl: "https://new.example.com" }, { isActive });
    assert.equal(result.ok, true);
    assert.equal(result.effects.baseUrlChanged, true);
    assert.equal(result.effects.clearModelCache, true);
    assert.equal(result.effects.rewriteLiveConfig, isActive);
  }
});

test("an empty secret field means keep the stored credential", () => {
  const result = plan("codex", { name: "我的中转", baseUrl: "https://api.example.com", secret: "   " }, {
    isActive: true
  });
  assert.equal(result.ok, true);
  assert.equal(result.secret, undefined);
  assert.equal(result.effects.secretChanged, false);
  assert.equal(result.effects.rewriteLiveConfig, false);
});

test("a new secret on the active provider forces a live config rewrite", () => {
  const result = plan("codex", { name: "我的中转", baseUrl: "https://api.example.com", secret: " sk-new " }, {
    isActive: true
  });
  assert.equal(result.ok, true);
  assert.equal(result.secret, "sk-new");
  assert.equal(result.effects.rewriteLiveConfig, true);
  // The credential changed, not the origin, so the discovered models are still valid.
  assert.equal(result.effects.clearModelCache, false);
});

test("the outcome message names the follow-up work", () => {
  const quiet = describeProviderEditOutcome("我的中转", {
    nameChanged: true,
    baseUrlChanged: false,
    secretChanged: false,
    clearModelCache: false,
    rewriteLiveConfig: false,
    rewriteManagedBlock: false,
    unchanged: false
  });
  assert.equal(quiet, "已保存“我的中转”。");

  const loud = describeProviderEditOutcome("我的中转", {
    nameChanged: false,
    baseUrlChanged: true,
    secretChanged: true,
    clearModelCache: true,
    rewriteLiveConfig: true,
    rewriteManagedBlock: false,
    unchanged: false
  });
  assert.match(loud, /模型缓存已清空/);
  assert.match(loud, /密钥已更新/);
  assert.match(loud, /已同步到当前生效的配置/);
});

const ORDERED = [{ id: "a" }, { id: "b" }, { id: "c" }];

test("applies a dragged order", () => {
  assert.deepEqual(applyProviderOrder(ORDERED, ["c", "a", "b"]).map((item) => item.id), ["c", "a", "b"]);
});

test("keeps providers the order never mentions instead of dropping them", () => {
  // A stale webview list would otherwise delete whatever it had not rendered yet.
  assert.deepEqual(applyProviderOrder(ORDERED, ["c"]).map((item) => item.id), ["c", "a", "b"]);
  assert.deepEqual(applyProviderOrder(ORDERED, []).map((item) => item.id), ["a", "b", "c"]);
});

test("ignores ids that no longer exist and never duplicates one", () => {
  assert.deepEqual(applyProviderOrder(ORDERED, ["gone", "b", "b", "a"]).map((item) => item.id), ["b", "a", "c"]);
});

test("returns a new array and leaves the original untouched", () => {
  const source = [...ORDERED];
  const result = applyProviderOrder(source, ["b", "a", "c"]);
  assert.notEqual(result, source);
  assert.deepEqual(source.map((item) => item.id), ["a", "b", "c"]);
});
