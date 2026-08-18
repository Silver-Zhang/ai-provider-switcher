const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// The panel imports `vscode`, which only exists inside the editor host. Stub the handful of APIs it
// touches. The document is written once and every update arrives as a postMessage fragment, so the
// assertions run against those payloads rather than against `webview.html`.
const shells = [];
const posts = [];
const disposers = [];
let receive;

const vscodeStub = {
  ViewColumn: { One: 1 },
  Uri: { joinPath: (base, ...parts) => `${base}/${parts.join("/")}` },
  window: {
    createWebviewPanel: () => ({
      reveal() {},
      onDidDispose(listener) {
        disposers.push(listener);
      },
      webview: {
        cspSource: "vscode-webview://test",
        asWebviewUri: (uri) => uri,
        onDidReceiveMessage(listener) {
          receive = listener;
        },
        postMessage(payload) {
          posts.push(payload);
          return Promise.resolve(true);
        },
        set html(value) {
          shells.push(value);
        },
        get html() {
          return shells[shells.length - 1];
        }
      }
    })
  }
};

const load = Module._load;
Module._load = function (request, ...rest) {
  return request === "vscode" ? vscodeStub : load.call(this, request, ...rest);
};
const { ProviderManagerPanel } = require("../out/providerManagerPanel.js");
Module._load = load;

const STATE = {
  claudeMode: "中转 A",
  claudeOfficial: false,
  claudeDesktopMode: "官方服务",
  claudeDesktopOfficial: true,
  claudeProviders: [
    {
      id: "relay-a",
      name: 'Relay "A" & <b>',
      baseUrl: "https://api.a.com",
      active: true,
      mapping: "deepseek-chat / 快速：deepseek-chat",
      permissionStrategy: "Auto",
      hasUsageConfig: false,
      usage: "未获取",
      modelList: [
        { name: "deepseek-v4-pro", role: "main", supports1m: true },
        { name: "deepseek-v4-flash", role: "haiku", supports1m: false }
      ],
      effortLevel: "high",
      desktopModels: [{ name: "claude-sonnet-5", supports1m: false }],
      desktopAliasRequired: true
    },
    {
      id: "relay-b",
      name: "Relay B",
      baseUrl: "https://api.b.com",
      active: false,
      mapping: "未配置",
      permissionStrategy: "Auto",
      hasUsageConfig: false,
      usage: "未获取",
      modelList: [],
      // "" is what a provider the wizard never configured reports — distinct from
      // "auto", which is a value that does get written.
      effortLevel: "",
      desktopModels: [],
      desktopAliasRequired: false
    }
  ],
  codexMode: "官方服务",
  codexOfficial: true,
  codexModel: "",
  codexUnifiedHistory: false,
  codexProviders: [
    {
      id: "codex-relay",
      name: "中转 C",
      baseUrl: "https://api.c.com",
      active: false,
      modelCount: 3,
      hasUsageConfig: true,
      usageEndpoint: "https://api.c.com/quota",
      usageMappings: "余额=data.balance",
      usage: "余额 82%"
    }
  ]
};

let onAction = async () => undefined;

/** The last fragment set the panel pushed: `{ status, list, detail }`. */
function latest() {
  return posts[posts.length - 1];
}

function open(focus) {
  disposers.splice(0).forEach((dispose) => dispose());
  shells.length = 0;
  posts.length = 0;
  ProviderManagerPanel.show("ext://root", () => STATE, (message) => onAction(message), focus);
  return latest();
}

test("the shell document is written once and updates arrive as fragments", async () => {
  open();
  assert.equal(shells.length, 1);
  assert.match(shells[0], /<aside class="list-pane" id="list-pane"><\/aside>/);
  await receive({ action: "openClaudeProvider", providerKind: "claude", providerId: "relay-a" });
  await receive({ action: "backToOverview" });
  // Three renders, still one document: nothing reloaded the panel or reset its scroll position.
  assert.equal(shells.length, 1);
  assert.equal(posts.length, 3);
  assert.equal(posts[0].type, "render");
});

test("the list escapes provider names and marks the live one", () => {
  const { list } = open();
  assert.match(list, /Relay &quot;A&quot; &amp; &lt;b&gt;/);
  assert.doesNotMatch(list, /Relay "A" & <b>/);
  assert.match(list, /<span class="live-pill">使用中<\/span>/);
  assert.match(list, /data-action="openCodexProvider" data-provider-kind="codex" data-provider-id="codex-relay"/);
});

test("provider rows are draggable and scoped to their own kind", () => {
  const { list } = open();
  assert.match(list, /draggable="true" data-drag-kind="claude" data-drag-id="relay-a"/);
  assert.match(list, /draggable="true" data-drag-kind="codex" data-drag-id="codex-relay"/);
  // The official entry is not a stored provider and has no position of its own to remember.
  assert.doesNotMatch(list, /class="provider official[^"]*" draggable/);
  assert.match(shells[0], /row\.dataset\.dragKind !== dragging\.dataset\.dragKind/);
  assert.match(shells[0], /action: 'reorderProviders'/);
});

test("each row carries its own switch and edit action", () => {
  const { list } = open();
  assert.match(list, /data-action="switchClaude" data-provider-kind="claude" data-provider-id="relay-b"/);
  assert.match(list, /data-action="editProvider" data-provider-kind="claude" data-provider-id="relay-b"/);
  assert.match(list, /data-action="addClaudeProvider"/);
  assert.match(list, /data-action="addCodexProvider"/);
});

test("the header reports the real active providers instead of a fixed label", () => {
  const { status } = open();
  assert.doesNotMatch(status, /本地配置已就绪/);
  assert.match(status, /Claude <b>中转 A<\/b>/);
  assert.match(status, /Codex <b>官方服务<\/b>/);
  // A relay gets the accent dot; only the official service keeps the plain one.
  assert.match(status, /class="status-dot custom"><\/span>Claude/);
  assert.match(status, /class="status-dot "><\/span>Codex/);
});

test("each action group has exactly one filled button and an overflow menu", () => {
  const { detail } = open();
  for (const group of detail.split('<div class="actions">').slice(1)) {
    assert.equal((group.match(/<button class=""/g) ?? []).length, 1);
  }
  assert.equal((detail.match(/<details class="overflow">/g) ?? []).length, 2);
  assert.match(detail, /data-action="inspectClaude"/);
  assert.match(detail, /data-action="configureCodexProxy"/);
});

test("the long explanations are collapsed instead of always on screen", () => {
  open();
  const help = shells[0].slice(shells[0].indexOf('<details class="help">'));
  assert.match(help, /<summary>帮助与说明<\/summary>/);
  assert.match(help, /每条会话固定绑定创建时的 Provider/);
  assert.match(help, /命令策略 Auto/);
  assert.match(help, /拖动列表左侧的 ⠿ 手柄/);
});

test("clicks are delegated so the handlers survive a fragment swap", () => {
  open();
  assert.match(shells[0], /document\.addEventListener\('click'/);
  assert.match(shells[0], /closest\(event, '\[data-action\]'\)/);
  // The initial paint would be lost without the handshake, since the shell loads after it is sent.
  assert.match(shells[0], /vscode\.postMessage\(\{ action: 'ready' \}\)/);
});

test("the detail view targets the selected provider and the row stays highlighted", () => {
  const { list, detail } = open({ kind: "codex", id: "codex-relay" });
  assert.match(list, /class="provider selected" draggable="true" data-drag-kind="codex"/);
  assert.match(detail, /data-action="switchCodex" data-provider-kind="codex" data-provider-id="codex-relay"/);
  assert.match(detail, /data-action="removeProvider" data-provider-kind="codex" data-provider-id="codex-relay"/);
  assert.doesNotMatch(detail, /id="edit-name"/);
  assert.match(detail, /切换到此服务/);
});

test("the edit form opens with the stored values and a locked id", () => {
  const { detail } = open({ kind: "claude", id: "relay-a", edit: true });
  assert.match(detail, /id="edit-name" type="text" value="Relay &quot;A&quot; &amp; &lt;b&gt;"/);
  assert.match(detail, /id="edit-base-url" type="text" value="https:\/\/api\.a\.com"/);
  assert.match(detail, /id="edit-secret" type="password"/);
  assert.match(detail, /<span class="locked">relay-a<\/span>/);
  assert.doesNotMatch(detail, /class="form-notice"/);
});

test("the row edit button both selects the provider and opens its form", async () => {
  open();
  await receive({ action: "editProvider", providerKind: "claude", providerId: "relay-b" });
  assert.match(latest().detail, /id="edit-name" type="text" value="Relay B"/);
  assert.match(latest().list, /class="provider selected" draggable="true" data-drag-kind="claude" data-drag-id="relay-b"/);
});

test("a rejected save keeps what was typed and shows the reason in the form", async () => {
  onAction = async () => ({ keepEditing: true, message: "已存在同名服务“Backup”，请换一个名称。" });
  open({ kind: "claude", id: "relay-a", edit: true });
  await receive({
    action: "saveProviderEdit",
    providerKind: "claude",
    providerId: "relay-a",
    draft: { name: "Backup", baseUrl: "https://typed.example.com", secret: "" }
  });
  const { detail } = latest();
  assert.match(detail, /id="edit-name" type="text" value="Backup"/);
  assert.match(detail, /id="edit-base-url" type="text" value="https:\/\/typed\.example\.com"/);
  assert.match(detail, /class="form-notice" role="alert"/);
  assert.match(detail, /已存在同名服务“Backup”/);
});

test("a typed credential is dropped from the retained draft and the notice says so", async () => {
  onAction = async () => ({ keepEditing: true, message: "Base URL 不能为空。" });
  open({ kind: "claude", id: "relay-a", edit: true });
  await receive({
    action: "saveProviderEdit",
    providerKind: "claude",
    providerId: "relay-a",
    draft: { name: "Relay", baseUrl: "", secret: "sk-should-not-be-echoed" }
  });
  const { detail } = latest();
  assert.doesNotMatch(detail, /sk-should-not-be-echoed/);
  assert.match(detail, /密钥框已清空/);
  assert.match(detail, /id="edit-base-url" type="text" value=""/);
});

test("a successful save closes the form and clears the retained draft", async () => {
  onAction = async () => undefined;
  open({ kind: "claude", id: "relay-a", edit: true });
  await receive({
    action: "saveProviderEdit",
    providerKind: "claude",
    providerId: "relay-a",
    draft: { name: "Renamed", baseUrl: "https://api.a.com" }
  });
  const { detail } = latest();
  assert.doesNotMatch(detail, /id="edit-name"/);
  assert.doesNotMatch(detail, /Renamed/);
});

test("cancelling drops the draft so reopening shows the stored values", async () => {
  onAction = async () => ({ keepEditing: true, message: "名称不能为空。" });
  open({ kind: "claude", id: "relay-a", edit: true });
  await receive({
    action: "saveProviderEdit",
    providerKind: "claude",
    providerId: "relay-a",
    draft: { name: "", baseUrl: "https://typed.example.com" }
  });
  await receive({ action: "cancelProviderEdit" });
  await receive({ action: "editProvider", providerKind: "claude", providerId: "relay-a" });
  const { detail } = latest();
  assert.match(detail, /id="edit-base-url" type="text" value="https:\/\/api\.a\.com"/);
  assert.doesNotMatch(detail, /class="form-notice"/);
});

test("a selection that no longer resolves falls back to the overview", async () => {
  onAction = async () => undefined;
  open({ kind: "claude", id: "deleted-provider" });
  // The state has no such provider, so the detail pane must not be left blank or stale.
  assert.match(latest().detail, /<h2>Claude<\/h2>/);
  assert.doesNotMatch(latest().list, /class="provider selected" draggable/);
});

test("no undefined leaks into the rendered markup", () => {
  const { status, list, detail } = open({ kind: "codex", id: "codex-relay" });
  for (const fragment of [status, list, detail]) assert.doesNotMatch(fragment, /undefined/);
});

test("the model editor renders each model with its role and 1M state", async () => {
  onAction = async () => undefined;
  open();
  await receive({ action: "editProviderModels", providerKind: "claude", providerId: "relay-a" });
  const { detail } = latest();
  assert.match(detail, /value="deepseek-v4-pro"/);
  // The main model's 1M box is ticked and its role is selected.
  assert.match(detail, /<option value="main" selected>/);
  assert.match(detail, /<input type="checkbox" checked><span>1M<\/span>/);
  // The editor offers both the fetch and the auto-assign actions in place.
  assert.match(detail, /data-action="fetchProviderModels"/);
  assert.match(detail, /data-action="autoAssignModelRoles"/);
  assert.match(detail, /data-desktop-standard=/);
  // A gateway whose own names Desktop refuses says so at configuration time.
  assert.match(detail, /Claude Desktop 会拒绝整份配置/);
  assert.match(detail, /id="env-preview"/);
});

test("a host-recomputed draft replaces what the form submitted", async () => {
  const assigned = {
    models: [
      { name: "deepseek-v4-pro", role: "main", supports1m: true },
      { name: "deepseek-v4-flash", role: "haiku", supports1m: false }
    ],
    effort: "high",
    desktopModels: []
  };
  onAction = async () => ({ keepEditing: true, modelForm: assigned, message: "已按模型名分配" });
  open();
  // The button only exists inside the open form, so the provider is already selected.
  await receive({ action: "editProviderModels", providerKind: "claude", providerId: "relay-a" });
  await receive({
    action: "autoAssignModelRoles",
    providerKind: "claude",
    providerId: "relay-a",
    // What the webview submitted had no roles at all.
    modelForm: {
      models: [
        { name: "deepseek-v4-pro", role: "", supports1m: true },
        { name: "deepseek-v4-flash", role: "", supports1m: false }
      ],
      effort: "high",
      desktopModels: []
    }
  });
  const { detail } = latest();
  assert.match(detail, /<option value="main" selected>/);
  assert.match(detail, /<option value="haiku" selected>/);
  assert.match(detail, /已按模型名分配/);
});

test("an unset effort stays unset instead of defaulting to auto", async () => {
  onAction = async () => undefined;
  open();
  await receive({ action: "editProviderModels", providerKind: "claude", providerId: "relay-b" });
  const { detail } = latest();
  // The empty choice is what keeps CLAUDE_CODE_EFFORT_LEVEL out of the three
  // configs; selecting `auto` by default used to write it on the first save.
  assert.match(detail, /<option value="" selected>不设置（不写入该变量）<\/option>/);
  assert.doesNotMatch(detail, /<option value="auto" selected>/);
});

test("a configured effort keeps its stored value selected", async () => {
  onAction = async () => undefined;
  open();
  await receive({ action: "editProviderModels", providerKind: "claude", providerId: "relay-a" });
  assert.match(latest().detail, /<option value="high" selected>high<\/option>/);
});

test("the alias hint stays out of a gateway whose own model names are usable", async () => {
  onAction = async () => undefined;
  open();
  await receive({ action: "editProviderModels", providerKind: "claude", providerId: "relay-b" });
  assert.doesNotMatch(latest().detail, /Claude Desktop 会拒绝整份配置/);
});
