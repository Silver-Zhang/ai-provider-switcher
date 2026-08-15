const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildExtensionKindOverride,
  classifyRemoteName,
  describeRemoteConfigScope,
  describeRemoteDesktopLimit,
  describeRemoteEnvironment,
  describeRemoteProxyRisk,
  EXTENSION_ID,
  isLoopbackProxyUrl
} = require("../out/remoteEnvironment.js");

test("an absent remoteName means the extension host is local", () => {
  assert.equal(classifyRemoteName(undefined), "local");
  assert.equal(classifyRemoteName(""), "local");
  assert.equal(classifyRemoteName("   "), "local");
});

test("the documented remote authorities are classified", () => {
  assert.equal(classifyRemoteName("wsl"), "wsl");
  assert.equal(classifyRemoteName("ssh-remote"), "ssh");
  assert.equal(classifyRemoteName("dev-container"), "container");
  assert.equal(classifyRemoteName("attached-container"), "container");
  assert.equal(classifyRemoteName("codespaces"), "codespaces");
  assert.equal(classifyRemoteName("tunnel"), "tunnel");
});

test("an unknown authority is still treated as remote, never as local", () => {
  // New remote kinds keep appearing; guessing "local" would write local paths on
  // a machine that does not have them.
  assert.equal(classifyRemoteName("some-future-remote"), "other");
});

test("describeRemoteEnvironment carries the raw name and a label", () => {
  assert.deepEqual(describeRemoteEnvironment("ssh-remote"), {
    kind: "ssh",
    remoteName: "ssh-remote",
    label: "远程 SSH 主机",
    isRemote: true
  });
  assert.deepEqual(describeRemoteEnvironment(undefined), {
    kind: "local",
    remoteName: "",
    label: "本机",
    isRemote: false
  });
});

test("loopback proxy addresses are recognised in every spelling", () => {
  for (const url of [
    "http://127.0.0.1:7890",
    "http://127.1.2.3:1080",
    "http://localhost:7890",
    "https://LOCALHOST:7890",
    "http://[::1]:7890",
    "http://0.0.0.0:7890",
    "127.0.0.1:7890"
  ]) {
    assert.equal(isLoopbackProxyUrl(url), true, url);
  }
});

test("a routable proxy address is not loopback", () => {
  for (const url of [
    "http://192.168.1.10:7890",
    "http://proxy.corp.example:3128",
    "http://172.20.0.1:7890",
    "",
    "   ",
    "http://"
  ]) {
    assert.equal(isLoopbackProxyUrl(url), false, JSON.stringify(url));
  }
});

test("no proxy warning is raised on the local machine", () => {
  assert.equal(describeRemoteProxyRisk("local", "http://127.0.0.1:7890"), undefined);
});

test("no proxy warning is raised for a routable address on a remote host", () => {
  assert.equal(describeRemoteProxyRisk("ssh", "http://10.0.0.5:3128"), undefined);
});

test("a loopback proxy on a remote host is called out as the wrong machine", () => {
  const message = describeRemoteProxyRisk("ssh", "http://127.0.0.1:7890");
  assert.match(message, /127\.0\.0\.1:7890/);
  assert.match(message, /远程 SSH 主机/);
});

test("the WSL warning names mirrored networking instead of the generic advice", () => {
  const message = describeRemoteProxyRisk("wsl", "http://127.0.0.1:7890");
  assert.match(message, /mirrored/);
  assert.match(message, /resolv\.conf/);
});

test("the desktop limit is silent locally and explains the split remotely", () => {
  assert.equal(describeRemoteDesktopLimit("local"), undefined);
  const message = describeRemoteDesktopLimit("wsl");
  assert.match(message, /WSL 子系统/);
  assert.match(message, /remote\.extensionKind/);
  assert.ok(message.includes(EXTENSION_ID));
});

test("the panel notice is shown only in a remote window", () => {
  assert.equal(describeRemoteConfigScope("local"), undefined);
  const notice = describeRemoteConfigScope("container");
  assert.match(notice, /开发容器/);
  assert.match(notice, /~\/\.codex/);
});

test("the extensionKind override is keyed by the published extension id", () => {
  assert.deepEqual(buildExtensionKindOverride("ui"), { "silver-zhang.ai-provider-switcher": ["ui"] });
  assert.deepEqual(buildExtensionKindOverride("workspace"), {
    "silver-zhang.ai-provider-switcher": ["workspace"]
  });
});
