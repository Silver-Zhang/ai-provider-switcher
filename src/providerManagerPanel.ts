import * as vscode from "vscode";

export type ProviderManagerAction =
  | "switchClaude"
  | "manageClaude"
  | "refreshClaude"
  | "switchCodex"
  | "codexOfficial"
  | "manageCodex"
  | "refreshCodex"
  | "openCodex";

export type ProviderManagerState = {
  claudeMode: string;
  claudeProviders: Array<{ name: string; baseUrl: string }>;
  codexMode: string;
  codexModel: string;
  codexProviders: Array<{ name: string; baseUrl: string; modelCount: number }>;
};

export class ProviderManagerPanel {
  private static current: ProviderManagerPanel | undefined;

  static show(
    extensionUri: vscode.Uri,
    getState: () => ProviderManagerState,
    onAction: (action: ProviderManagerAction) => Promise<void>
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
    private readonly onAction: (action: ProviderManagerAction) => Promise<void>
  ) {
    void this.extensionUri;
    this.panel.onDidDispose(() => {
      ProviderManagerPanel.current = undefined;
    });
    this.panel.webview.onDidReceiveMessage(async (message: { action?: ProviderManagerAction }) => {
      if (!message.action) return;
      await this.onAction(message.action);
      this.render();
    });
    this.render();
  }

  private render(): void {
    const state = this.getState();
    const nonce = createNonce();
    this.panel.webview.html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    body { margin: 0; padding: 32px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    .shell { max-width: 1000px; margin: 0 auto; }
    header { display: flex; justify-content: space-between; gap: 24px; align-items: end; margin-bottom: 26px; }
    h1 { margin: 0 0 8px; font-size: 30px; letter-spacing: -0.5px; }
    .subtitle { margin: 0; color: var(--vscode-descriptionForeground); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(360px,1fr)); gap: 18px; }
    .card { border: 1px solid var(--vscode-widget-border); background: var(--vscode-sideBar-background); border-radius: 12px; padding: 20px; box-shadow: 0 8px 24px rgba(0,0,0,.12); }
    .card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
    h2 { margin: 0; font-size: 20px; }
    .badge { border-radius: 99px; padding: 5px 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 12px; }
    .model { margin: -4px 0 15px; color: var(--vscode-descriptionForeground); font-size: 13px; }
    .providers { display: grid; gap: 8px; margin-bottom: 18px; }
    .provider { display: flex; justify-content: space-between; gap: 12px; padding: 10px 12px; border-radius: 7px; background: var(--vscode-editor-background); }
    .url { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .count { white-space: nowrap; color: var(--vscode-descriptionForeground); }
    .actions { display: flex; flex-wrap: wrap; gap: 9px; }
    button { border: 1px solid transparent; border-radius: 6px; padding: 8px 12px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .note { margin-top: 20px; padding: 14px 16px; border-left: 3px solid var(--vscode-textLink-foreground); background: var(--vscode-textBlockQuote-background); color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <main class="shell">
    <header><div><h1>AI Provider Switcher</h1><p class="subtitle">统一管理 Claude 与 Codex 的官方服务、中转服务和模型。</p></div></header>
    <section class="grid">
      ${providerCard("Claude", state.claudeMode, "", state.claudeProviders.map((item) => ({ ...item, count: "" })), [
        ["快速切换", "switchClaude", false], ["管理服务", "manageClaude", true], ["刷新模型", "refreshClaude", true]
      ])}
      ${providerCard("Codex", state.codexMode, "模型请在 Codex 页面原生模型栏中选择", state.codexProviders.map((item) => ({ ...item, count: `${item.modelCount} 个模型` })), [
        ["切换服务", "switchCodex", false], ["打开 Codex 选择模型", "openCodex", false], ["使用官方", "codexOfficial", true], ["管理服务", "manageCodex", true], ["刷新模型", "refreshCodex", true]
      ])}
    </section>
    <div class="note">URL 只填写服务根地址，例如 https://api.example.com。Claude 与 Codex 所需的 /v1 路径由插件按协议自动补全。Codex Provider 启用后，模型会同步到 Codex 页面自身的模型栏中选择。API Key 不在此页面回显。</div>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('button[data-action]').forEach((button) => button.addEventListener('click', () => vscode.postMessage({ action: button.dataset.action })));
  </script>
</body></html>`;
  }
}

function providerCard(
  name: string,
  mode: string,
  model: string,
  providers: Array<{ name: string; baseUrl: string; count: string }>,
  actions: Array<[string, ProviderManagerAction, boolean]>
): string {
  const providerRows = providers.length
    ? providers.map((item) => `<div class="provider"><span>${escapeHtml(item.name)}</span><span class="url">${escapeHtml(item.baseUrl)}</span><span class="count">${escapeHtml(item.count)}</span></div>`).join("")
    : '<div class="provider"><span>尚未添加自定义服务</span></div>';
  const buttons = actions.map(([label, action, secondary]) => `<button class="${secondary ? "secondary" : ""}" data-action="${action}">${label}</button>`).join("");
  return `<article class="card"><div class="card-head"><h2>${name}</h2><span class="badge">${escapeHtml(mode)}</span></div>${model ? `<div class="model">${model}</div>` : ""}<div class="providers">${providerRows}</div><div class="actions">${buttons}</div></article>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 24 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}