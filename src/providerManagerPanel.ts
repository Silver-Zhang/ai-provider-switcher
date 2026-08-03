import * as vscode from "vscode";

export type ProviderManagerAction =
  | "switchClaude"
  | "claudeOfficial"
  | "manageClaude"
  | "refreshClaude"
  | "mapClaudeModels"
  | "configureClaudePermissions"
  | "inspectClaude"
  | "switchCodex"
  | "codexOfficial"
  | "manageCodex"
  | "refreshCodex"
  | "configureCodexProxy"
  | "refreshUsage"
  | "configureUsage"
  | "manageUsage"
  | "viewUsageConfig"
  | "editUsageConfig"
  | "deleteUsageConfig"
  | "openClaudeProvider"
  | "openCodexProvider"
  | "backToOverview"
  | "openCodex";

export type ProviderManagerMessage = {
  action?: ProviderManagerAction;
  providerKind?: "claude" | "codex";
  providerId?: string;
};

export type ProviderManagerState = {
  claudeMode: string;
  claudeProviders: Array<{
    id: string;
    name: string;
    baseUrl: string;
    active: boolean;
    mapping: string;
    permissionStrategy: string;
    hasUsageConfig: boolean;
    usageEndpoint?: string;
    usageMappings?: string;
    usage: string;
  }>;
  codexMode: string;
  codexModel: string;
  codexProviders: Array<{ id: string; name: string; baseUrl: string; modelCount: number; hasUsageConfig: boolean; usageEndpoint?: string; usageMappings?: string; usage: string }>;
};

export class ProviderManagerPanel {
  private static current: ProviderManagerPanel | undefined;

  static show(
    extensionUri: vscode.Uri,
    getState: () => ProviderManagerState,
    onAction: (message: ProviderManagerMessage) => Promise<void>
  ): void {
    if (ProviderManagerPanel.current) {
      ProviderManagerPanel.current.panel.reveal(vscode.ViewColumn.One);
      ProviderManagerPanel.current.render();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "aiProviderSwitcher.manager",
      "AI Provider Switcher",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    ProviderManagerPanel.current = new ProviderManagerPanel(panel, extensionUri, getState, onAction);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly getState: () => ProviderManagerState,
    private readonly onAction: (message: ProviderManagerMessage) => Promise<void>
  ) {
    let selectedProvider: { kind: "claude" | "codex"; id: string } | undefined;
    void this.extensionUri;
    this.panel.onDidDispose(() => {
      ProviderManagerPanel.current = undefined;
    });
    this.panel.webview.onDidReceiveMessage(async (message: ProviderManagerMessage) => {
      if (!message.action) return;
      if (message.action === "openClaudeProvider" || message.action === "openCodexProvider") {
        if (message.providerKind && message.providerId) selectedProvider = { kind: message.providerKind, id: message.providerId };
        this.render(selectedProvider);
        return;
      }
      if (message.action === "backToOverview") {
        selectedProvider = undefined;
        this.render();
        return;
      }
      await this.onAction(message);
      this.render(selectedProvider);
    });
    this.render();
  }

  private render(selectedProvider?: { kind: "claude" | "codex"; id: string }): void {
    const state = this.getState();
    const selected = selectedProvider ? findProvider(state, selectedProvider) : undefined;
    const nonce = createNonce();
    const logoUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "images", "logo.svg"));
    this.panel.webview.html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${this.panel.webview.cspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); line-height: 1.45; }
    .shell { width: min(1180px, 100%); margin: 0 auto; padding: 28px clamp(18px, 4vw, 46px) 42px; }
    header { position: relative; overflow: hidden; display: flex; justify-content: space-between; gap: 24px; align-items: end; margin-bottom: 24px; padding: clamp(22px, 4vw, 36px); border: 1px solid var(--vscode-widget-border); border-radius: 20px; background: linear-gradient(135deg, color-mix(in srgb, var(--vscode-textLink-foreground) 16%, var(--vscode-sideBar-background)), var(--vscode-sideBar-background) 64%); box-shadow: 0 14px 34px rgba(0,0,0,.12); }
    header::after { content: ""; position: absolute; width: 190px; height: 190px; right: -70px; top: -85px; border-radius: 50%; background: color-mix(in srgb, var(--vscode-textLink-foreground) 16%, transparent); pointer-events: none; }
    .eyebrow { margin: 0 0 8px; color: var(--vscode-textLink-foreground); font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    .brand { position: relative; z-index: 1; display: flex; align-items: center; gap: 18px; }
    .brand-logo { flex: 0 0 76px; width: 76px; height: 76px; border-radius: 20px; filter: drop-shadow(0 0 18px color-mix(in srgb, #55efff 40%, transparent)); }
    h1 { margin: 0 0 8px; font-size: clamp(25px, 4vw, 34px); line-height: 1.15; letter-spacing: -0.6px; }
    .subtitle { max-width: 620px; margin: 0; color: var(--vscode-descriptionForeground); }
    .header-status { position: relative; z-index: 1; display: flex; align-items: center; gap: 8px; align-self: start; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-testing-iconPassed); box-shadow: 0 0 0 4px color-mix(in srgb, var(--vscode-testing-iconPassed) 18%, transparent); }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; align-items: start; }
    .card { min-width: 0; border: 1px solid var(--vscode-widget-border); background: var(--vscode-sideBar-background); border-radius: 16px; padding: 20px; box-shadow: 0 8px 24px rgba(0,0,0,.09); }
    .card-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; margin-bottom: 16px; }
    .card-title { display: flex; gap: 10px; align-items: center; min-width: 0; }
    .provider-icon { display: grid; flex: 0 0 34px; width: 34px; height: 34px; place-items: center; border-radius: 10px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font-size: 17px; }
    h2 { margin: 0; font-size: 20px; line-height: 1.2; }
    .badge { max-width: 48%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 1px solid var(--vscode-widget-border); border-radius: 99px; padding: 5px 10px; background: var(--vscode-editor-background); color: var(--vscode-descriptionForeground); font-size: 12px; }
    .model { margin: -7px 0 16px; padding: 8px 10px; border-radius: 8px; color: var(--vscode-descriptionForeground); background: var(--vscode-textBlockQuote-background); font-size: 12px; }
    .providers { display: grid; gap: 10px; min-width: 0; margin-bottom: 18px; }
    .provider { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; min-width: 0; padding: 13px 14px; border: 1px solid transparent; border-radius: 11px; background: var(--vscode-editor-background); transition: border-color .15s ease, transform .15s ease; }
    .provider:hover { border-color: var(--vscode-focusBorder); transform: translateY(-1px); }
    .provider-link { cursor: pointer; }
    .provider-link:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .provider-main { min-width: 0; }
    .provider-name { display: flex; align-items: center; gap: 7px; min-width: 0; }
    .provider-name strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .active-dot { width: 7px; height: 7px; flex: 0 0 7px; border-radius: 50%; background: var(--vscode-testing-iconPassed); }
    .provider-info { display: flex; flex-wrap: wrap; gap: 5px 10px; margin-top: 6px; }
    .url { min-width: 0; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; word-break: break-word; font-size: 12px; }
    .provider-side { display: flex; flex-direction: column; align-items: flex-end; gap: 7px; min-width: 72px; text-align: right; }
    .count { color: var(--vscode-descriptionForeground); font-size: 12px; white-space: nowrap; }
    .usage-pill { max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-radius: 99px; padding: 3px 8px; color: var(--vscode-descriptionForeground); background: var(--vscode-badge-background); font-size: 11px; }
    .usage-pill.configured { color: var(--vscode-testing-iconPassed); }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    button { border: 1px solid transparent; border-radius: 8px; padding: 8px 12px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: inherit; font-size: 12px; transition: background .15s ease, border-color .15s ease; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    button.secondary { border-color: var(--vscode-widget-border); color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .note { margin-top: 18px; padding: 16px 18px; border: 1px solid var(--vscode-widget-border); border-left: 3px solid var(--vscode-textLink-foreground); border-radius: 11px; background: var(--vscode-textBlockQuote-background); color: var(--vscode-descriptionForeground); font-size: 12px; }
    .note strong { color: var(--vscode-foreground); }
    .note .actions { margin-top: 13px !important; }
    .empty { padding: 20px 14px; border: 1px dashed var(--vscode-widget-border); border-radius: 11px; color: var(--vscode-descriptionForeground); text-align: center; font-size: 12px; }
    .detail-card { grid-column: 1 / -1; }
    .detail-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 22px; }
    .back-button { padding: 6px 10px; }
    .detail-heading { display: flex; align-items: center; gap: 13px; padding-bottom: 20px; border-bottom: 1px solid var(--vscode-widget-border); }
    .detail-heading h2 { margin-bottom: 5px; }
    .detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 18px; }
    .detail-item { min-width: 0; padding: 14px; border-radius: 10px; background: var(--vscode-editor-background); }
    .detail-wide { grid-column: 1 / -1; }
    .detail-label { display: block; margin-bottom: 8px; color: var(--vscode-descriptionForeground); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
    .detail-item strong { display: block; font-size: 13px; line-height: 1.5; }
    .detail-value { display: grid; gap: 7px; min-width: 0; }
    .detail-section { display: flex; justify-content: space-between; gap: 18px; align-items: end; margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--vscode-widget-border); }
    .detail-section h3 { margin: 0 0 4px; font-size: 14px; }
    .detail-section p { margin: 0; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .usage-section { align-items: center; }
    @media (max-width: 720px) { .shell { padding: 16px 14px 28px; } header { display: block; border-radius: 14px; } .brand-logo { width: 62px; height: 62px; flex-basis: 62px; } .header-status { margin-top: 18px; } .grid { grid-template-columns: minmax(0, 1fr); } .detail-section { display: block; } .detail-section .actions { margin-top: 13px; } }
    @media (max-width: 440px) { .detail-grid { grid-template-columns: minmax(0, 1fr); } .detail-wide { grid-column: auto; } }
    @media (max-width: 440px) { .provider { grid-template-columns: minmax(0, 1fr); } .provider-side { flex-direction: row; justify-content: space-between; align-items: center; text-align: left; } .usage-pill { max-width: 100%; } button { flex: 1 1 auto; } }
  </style>
</head>
<body>
  <main class="shell">
    <header><div class="brand"><img class="brand-logo" src="${logoUri}" alt="AI Provider Switcher"><div><p class="eyebrow">AI PROVIDER SWITCHER</p><h1>统一管理你的 AI 服务</h1><p class="subtitle">在一个清晰的控制面板中切换 Claude、Codex、官方服务和中转服务。</p></div></div><div class="header-status"><span class="status-dot"></span>本地配置已就绪</div></header>
    <section class="grid">
      ${selected ? providerDetail(selected.kind, selected.provider) : providerOverview(state)}
    </section>
    <div class="note"><strong>用量与额度</strong><br>读取模型接口返回的限流响应头，或调用自定义 Provider 的只读额度 API。不会自动发送收费推理请求。<div class="actions"><button data-action="refreshUsage">刷新额度</button><button class="secondary" data-action="manageUsage">管理额度配置</button><button class="secondary" data-action="configureUsage">配置额度 API</button></div></div>
    <div class="note">URL 只填写服务根地址，例如 https://api.example.com。若 Anthropic 兼容服务提供非 Claude 模型，请使用“模型映射”。Auto 并非“所有命令放行”：未命中窄 allow 规则的命令仍由独立 Sonnet 5 分类器检查，服务临时不可用时会安全阻塞。要完全不经过分类器只能在隔离环境使用“命令策略 → 完全放行”。API Key 不在此页面回显。</div>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('[data-action]').forEach((element) => element.addEventListener('click', () => vscode.postMessage({ action: element.dataset.action, providerKind: element.dataset.providerKind, providerId: element.dataset.providerId })));
  </script>
</body></html>`;
  }
}

function providerCard(
  name: string,
  mode: string,
  model: string,
  providers: Array<{ id: string; name: string; baseUrl: string; count: string; active?: boolean; mapping?: string; hasUsageConfig: boolean; usage: string }>,
  actions: Array<[string, ProviderManagerAction, boolean]>
): string {
  const kind = name === "Claude" ? "claude" : "codex";
  const providerRows = providers.length
    ? providers.map((item) => `<div class="provider provider-link" role="button" tabindex="0" data-action="open${kind === "claude" ? "Claude" : "Codex"}Provider" data-provider-kind="${kind}" data-provider-id="${escapeHtml(item.id)}"><div class="provider-main"><div class="provider-name">${item.active ? '<span class="active-dot" title="当前使用"></span>' : ""}<strong>${escapeHtml(item.name)}</strong></div><div class="provider-info"><small class="url">${escapeHtml(item.baseUrl)}</small>${item.mapping ? `<small class="url">映射：${escapeHtml(item.mapping)}</small>` : ""}</div></div><div class="provider-side"><span class="usage-pill ${item.hasUsageConfig ? "configured" : ""}">${item.hasUsageConfig ? "已配置额度" : "未配置额度"}</span><span class="count">${escapeHtml(item.count)}</span></div></div>`).join("")
    : '<div class="empty">尚未添加自定义服务</div>';
  const buttons = actions.map(([label, action, secondary], index) => `<button class="${secondary || index > 0 ? "secondary" : ""}" data-action="${action}">${label}</button>`).join("");
  const icon = name === "Claude" ? "✦" : "⌁";
  return `<article class="card"><div class="card-head"><div class="card-title"><span class="provider-icon">${icon}</span><h2>${name}</h2></div><span class="badge">${escapeHtml(mode)}</span></div>${model ? `<div class="model">${escapeHtml(model)}</div>` : ""}<div class="providers">${providerRows}</div><div class="actions">${buttons}</div></article>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 24 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

type ProviderView =
  | ProviderManagerState["claudeProviders"][number]
  | ProviderManagerState["codexProviders"][number];

function findProvider(
  state: ProviderManagerState,
  selection: { kind: "claude" | "codex"; id: string }
): { kind: "claude" | "codex"; provider: ProviderView } | undefined {
  const providers = selection.kind === "claude" ? state.claudeProviders : state.codexProviders;
  const provider = providers.find((item) => item.id === selection.id);
  return provider ? { kind: selection.kind, provider } : undefined;
}

function providerOverview(state: ProviderManagerState): string {
  return `${providerCard("Claude", state.claudeMode, "", state.claudeProviders.map((item) => ({
    ...item,
    count: item.active ? "当前" : "",
    mapping: `${item.mapping} · 命令：${item.permissionStrategy}`
  })), [
    ["快速切换", "switchClaude", false], ["模型映射", "mapClaudeModels", false], ["命令策略", "configureClaudePermissions", false], ["使用官方", "claudeOfficial", true], ["管理服务", "manageClaude", true], ["检测外部配置", "inspectClaude", true], ["刷新模型", "refreshClaude", true]
  ])}${providerCard("Codex", state.codexMode, "模型请在 Codex 页面原生模型栏中选择", state.codexProviders.map((item) => ({
    ...item,
    count: `${item.modelCount} 个模型`
  })), [
    ["切换服务", "switchCodex", false], ["打开 Codex 选择模型", "openCodex", false], ["配置连接代理", "configureCodexProxy", true], ["使用官方", "codexOfficial", true], ["管理服务", "manageCodex", true], ["刷新模型", "refreshCodex", true]
  ])}`;
}

function providerDetail(kind: "claude" | "codex", provider: ProviderView): string {
  const isClaude = kind === "claude";
  const claudeProvider = isClaude ? provider as ProviderManagerState["claudeProviders"][number] : undefined;
  const codexProvider = !isClaude ? provider as ProviderManagerState["codexProviders"][number] : undefined;
  const detailActions: Array<[string, ProviderManagerAction, boolean]> = isClaude
    ? [["切换到此 Provider", "switchClaude", false], ["刷新模型", "refreshClaude", true], ["模型映射", "mapClaudeModels", true], ["命令策略", "configureClaudePermissions", true], ["检测外部配置", "inspectClaude", true]]
    : [["切换到此 Provider", "switchCodex", false], ["刷新模型", "refreshCodex", true], ["配置连接代理", "configureCodexProxy", true], ["打开 Codex", "openCodex", true]];
  const actions = detailActions.map(([label, action, secondary]) => `<button class="${secondary ? "secondary" : ""}" data-action="${action}" data-provider-kind="${kind}" data-provider-id="${escapeHtml(provider.id)}">${label}</button>`).join("");
  const usageActions = [
    `<button data-action="refreshUsage" data-provider-kind="${kind}" data-provider-id="${escapeHtml(provider.id)}">刷新额度</button>`,
    ...(!provider.hasUsageConfig ? [`<button class="secondary" data-action="configureUsage" data-provider-kind="${kind}" data-provider-id="${escapeHtml(provider.id)}">配置额度</button>`] : []),
    `<button class="secondary" data-action="viewUsageConfig" data-provider-kind="${kind}" data-provider-id="${escapeHtml(provider.id)}">查看配置</button>`,
    `<button class="secondary" data-action="editUsageConfig" data-provider-kind="${kind}" data-provider-id="${escapeHtml(provider.id)}">编辑配置</button>`,
    `<button class="secondary" data-action="deleteUsageConfig" data-provider-kind="${kind}" data-provider-id="${escapeHtml(provider.id)}">删除配置</button>`
  ].join("");
  const mapping = isClaude ? `模型映射：${escapeHtml(claudeProvider?.mapping ?? "未配置")}<br>命令策略：${escapeHtml(claudeProvider?.permissionStrategy ?? "未配置")}` : `${escapeHtml(String(codexProvider?.modelCount ?? 0))} 个已缓存模型`;
  const usageDetail = provider.hasUsageConfig
    ? `<div class="detail-value"><span class="usage-pill configured">已配置额度 API</span><small class="url">${escapeHtml(provider.usageEndpoint ?? "")}</small>${provider.usageMappings ? `<small class="url">字段：${escapeHtml(provider.usageMappings)}</small>` : ""}</div>`
    : `<div class="detail-value"><span class="usage-pill">未配置额度 API</span><small class="url">可从此页面直接添加和管理</small></div>`;
  return `<article class="card detail-card"><div class="detail-top"><button class="back-button secondary" data-action="backToOverview">← 返回总览</button><span class="badge">${isClaude ? "Claude" : "Codex"}</span></div><div class="detail-heading"><span class="provider-icon">${isClaude ? "✦" : "⌁"}</span><div><h2>${escapeHtml(provider.name)}</h2><small class="url">${escapeHtml(provider.baseUrl)}</small></div></div><div class="detail-grid"><div class="detail-item"><span class="detail-label">连接状态</span><strong>${claudeProvider?.active ? "当前 Provider" : "可用 Provider"}</strong></div><div class="detail-item"><span class="detail-label">${isClaude ? "模型与策略" : "模型缓存"}</span><strong>${mapping}</strong></div><div class="detail-item detail-wide"><span class="detail-label">额度配置</span>${usageDetail}</div></div><div class="detail-section"><div><h3>Provider 操作</h3><p>所有操作都针对当前 Provider，不需要再从总控制台二次选择。</p></div><div class="actions">${actions}</div></div><div class="detail-section usage-section"><div><h3>用量与额度</h3><p>${escapeHtml(provider.usage)}</p></div><div class="actions">${usageActions}</div></div></article>`;
}