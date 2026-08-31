const assert = require("node:assert/strict");
const test = require("node:test");
const {
  DEFAULT_CLAUDE_PROXY_PORT,
  DEFAULT_PROTOCOL_ADAPTER_PORT,
  isValidLocalPort,
  resolveLocalPort
} = require("../out/localPort.js");

test("keeps historical fixed defaults on Windows and macOS", () => {
  for (const platform of ["win32", "darwin"]) {
    assert.deepEqual(resolveLocalPort({ kind: "claudeProxy", platform }), { port: DEFAULT_CLAUDE_PROXY_PORT, source: "default" });
    assert.deepEqual(resolveLocalPort({ kind: "protocolAdapter", platform }), { port: DEFAULT_PROTOCOL_ADAPTER_PORT, source: "default" });
  }
});

test("derives a stable separate pair for each Linux UID", () => {
  const a = [
    resolveLocalPort({ kind: "claudeProxy", platform: "linux", uid: 1000 }),
    resolveLocalPort({ kind: "protocolAdapter", platform: "linux", uid: 1000 })
  ];
  const b = [
    resolveLocalPort({ kind: "claudeProxy", platform: "linux", uid: 1001 }),
    resolveLocalPort({ kind: "protocolAdapter", platform: "linux", uid: 1001 })
  ];
  assert.deepEqual(a, [
    { port: 26000, source: "linux-user" },
    { port: 26001, source: "linux-user" }
  ]);
  assert.equal(a[0].port + 1, a[1].port);
  assert.notDeepEqual(a, b);
  assert.equal(resolveLocalPort({ kind: "claudeProxy", platform: "linux", uid: 1000 }).port, a[0].port);
});

test("Linux user port calculation stays in the non-privileged reserved band", () => {
  for (const uid of [0, 1, 999, 1000, 65534, 2 ** 31 - 1]) {
    for (const kind of ["claudeProxy", "protocolAdapter"]) {
      const choice = resolveLocalPort({ kind, platform: "linux", uid });
      assert.equal(choice.source, "linux-user");
      assert.ok(choice.port >= 24000 && choice.port <= 32000, `${uid}/${kind}: ${choice.port}`);
    }
  }
});

test("manual explicit port wins and invalid explicit values fall back safely", () => {
  assert.deepEqual(
    resolveLocalPort({ kind: "protocolAdapter", platform: "linux", uid: 1000, configured: 4181, configuredExplicitly: true }),
    { port: 4181, source: "manual" }
  );
  assert.deepEqual(
    resolveLocalPort({ kind: "protocolAdapter", platform: "linux", uid: 1000, configured: 80, configuredExplicitly: true }),
    { port: 26001, source: "linux-user" }
  );
  assert.deepEqual(
    resolveLocalPort({ kind: "claudeProxy", platform: "linux" }),
    { port: DEFAULT_CLAUDE_PROXY_PORT, source: "default" }
  );
  assert.equal(isValidLocalPort(1024), true);
  assert.equal(isValidLocalPort(65535), true);
  assert.equal(isValidLocalPort(1023), false);
  assert.equal(isValidLocalPort(65536), false);
});


test("local servers do not silently switch to an ephemeral port", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  for (const file of ["claudeProxy.ts", "localAdapterServer.ts"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", file), "utf8");
    assert.doesNotMatch(source, /listen\(0,\s*["']127\.0\.0\.1/);
    assert.match(source, /server\.on\("error"/);
  }
  const extension = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  assert.match(extension, /config\.inspect<number>\(key\)/);
  assert.match(extension, /resolveLocalPort\(/);
});
