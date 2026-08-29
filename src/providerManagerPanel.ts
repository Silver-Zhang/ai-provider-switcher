import * as vscode from "vscode";
import { CLAUDE_DESKTOP_GENERIC_TIER_ALIASES } from "./claudeDesktop";

export type ProviderManagerAction =
  | "ready"
  | "switchClaude"
  | "claudeOfficial"
  | "switchClaudeDesktop"
  | "manageClaude"
  | "refreshClaude"
  | "mapClaudeModels"
  | "configureClaudePermissions"
  | "inspectClaude"
  | "addClaudeProvider"
  | "switchCodex"
  | "codexOfficial"
  | "manageCodex"
  | "refreshCodex"
  | "configureCodexModel"
  | "configureCodexProxy"
  | "codexUnify"
  | "addCodexProvider"
  | "refreshUsage"
  | "configureUsage"
  | "manageUsage"
  | "viewUsageConfig"
  | "editUsageConfig"
  | "deleteUsageConfig"
  | "openClaudeProvider"
  | "openCodexProvider"
  | "editProvider"
  | "saveProviderEdit"
  | "cancelProviderEdit"
  | "removeProvider"
  | "reorderProviders"
  | "backToOverview"
  | "editProviderModels"
  | "editClaudeCodeModels"
  | "editClaudeDesktopModels"
  | "configureCurrentClaudeCodeModels"
  | "configureCurrentClaudeDesktopModels"
  | "openServiceLibrary"
  | "cancelProviderModelEdit"
  | "saveProviderModels"
  | "saveClaudeCodeModels"
  | "saveClaudeDesktopModels"
  | "autoAssignModelRoles"
  | "fetchProviderModels"
  | "openCodex";

export type ProviderManagerDraft = { name: string; baseUrl: string; secret?: string };

/** One row of the per-provider model editor: the model ID, its mapping role, and its 1M flag. */
export type ProviderModelRow = { name: string; role: string; supports1m: boolean };

export type ProviderModelFormPayload = {
  models: ProviderModelRow[];
  effort: string;
  desktopModels: Array<{ name: string; supports1m: boolean }>;
  /** Real model IDs selected for individually-routable Desktop catalogue entries. */
  desktopRoutes: Array<{ name: string; supports1m: boolean }>;
  /** Which user-facing surface this draft belongs to; host saves only that surface. */
  surface?: "code" | "desktop";
};

export type ProviderManagerMessage = {
  action?: ProviderManagerAction;
  providerKind?: "claude" | "codex";
  providerId?: string;
  draft?: ProviderManagerDraft;
  modelForm?: ProviderModelFormPayload;
  /** Provider IDs in the order the list was dragged into. */
  order?: string[];
};

/**
 * `keepEditing` holds the form open so a rejected draft is not discarded, and `message` is shown
 * inline above the fields — a validation error belongs next to the input that caused it, not in a
 * notification toast detached from the form. `modelForm` lets the host hand back a recomputed
 * draft (roles it assigned, models it fetched) to be rendered in place of what was submitted.
 */
export type ProviderManagerActionResult = {
  keepEditing?: boolean;
  message?: string;
  modelForm?: ProviderModelFormPayload;
};

export type ProviderManagerState = {
  claudeMode: string;
  claudeOfficial: boolean;
  claudeDesktopMode: string;
  claudeDesktopOfficial: boolean;
  /**
   * Set only in a Remote-SSH / WSL / container window, where every path written
   * belongs to the remote host rather than the machine drawing this panel.
   */
  remoteNotice?: string;
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
    /** Model editor rows: cached model IDs plus the mapping role each one plays. */
    modelList: ProviderModelRow[];
    effortLevel: string;
    desktopModels: Array<{ name: string; supports1m: boolean }>;
    /** Selected models that get their own safe route in Claude Desktop. */
    desktopRoutes: Array<{ name: string; supports1m: boolean }>;
    /** Whether this provider is Claude Desktop's live service. */
    desktopActive: boolean;
    /**
     * True when none of the gateway's own model IDs are ones Claude Desktop
     * will accept, so aliases are the only way to reach it from the app.
     */
    desktopAliasRequired: boolean;
  }>;
  codexMode: string;
  codexOfficial: boolean;
  codexModel: string;
  codexUnifiedHistory: boolean;
  codexProviders: Array<{
    id: string;
    name: string;
    baseUrl: string;
    active: boolean;
    modelCount: number;
    hasUsageConfig: boolean;
    usageEndpoint?: string;
    usageMappings?: string;
    usage: string;
  }>;
};

export class ProviderManagerPanel {
  private static current: ProviderManagerPanel | undefined;

  static show(
    extensionUri: vscode.Uri,
    getState: () => ProviderManagerState,
    onAction: (message: ProviderManagerMessage) => Promise<ProviderManagerActionResult | void>,
    focus?: { kind: "claude" | "codex"; id: string; edit?: boolean; modelSurface?: "code" | "desktop" }
  ): void {
    if (ProviderManagerPanel.current) {
      ProviderManagerPanel.current.panel.reveal(vscode.ViewColumn.One);
      ProviderManagerPanel.current.focusProvider(focus);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "aiProviderSwitcher.manager",
      "AI Provider Switcher",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    ProviderManagerPanel.current = new ProviderManagerPanel(panel, extensionUri, getState, onAction);
    ProviderManagerPanel.current.focusProvider(focus);
  }

  /** Re-paints the open panel once state that had to be read from disk resolves. */
  static refresh(): void {
    ProviderManagerPanel.current?.render();
  }

  private selectedProvider: { kind: "claude" | "codex"; id: string } | undefined;
  private view: "home" | "serviceLibrary" | "provider" | "codeSetup" | "desktopSetup" = "home";
  private editing = false;
  private editingModels: "code" | "desktop" | undefined;
  /** Survives a rejected save so the form can be re-rendered with what was typed. */
  private pendingDraft: { name: string; baseUrl: string } | undefined;
  private pendingModelForm: ProviderModelFormPayload | undefined;
  private notice: string | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly getState: () => ProviderManagerState,
    private readonly onAction: (message: ProviderManagerMessage) => Promise<ProviderManagerActionResult | void>
  ) {
    this.panel.onDidDispose(() => {
      ProviderManagerPanel.current = undefined;
    });
    this.panel.webview.onDidReceiveMessage(async (message: ProviderManagerMessage) => {
      if (!message.action) return;
      // The webview asks for content once its listeners exist, so the first paint cannot be missed.
      if (message.action === "ready") {
        this.render();
        return;
      }
      if (message.action === "openServiceLibrary") {
        this.leaveEditing();
        this.view = "serviceLibrary";
        this.render();
        return;
      }
      if (message.action === "openClaudeProvider" || message.action === "openCodexProvider") {
        this.select(message);
        this.leaveEditing();
        this.view = "provider";
        this.render();
        return;
      }
      if (message.action === "backToOverview") {
        this.selectedProvider = undefined;
        this.leaveEditing();
        this.view = "home";
        this.render();
        return;
      }
      if (message.action === "editProvider" || message.action === "cancelProviderEdit") {
        // The list's inline edit button both selects the provider and opens its form.
        if (message.action === "editProvider") this.select(message);
        this.leaveEditing();
        this.view = "provider";
        this.editing = message.action === "editProvider";
        this.render();
        return;
      }
      if (
        message.action === "editProviderModels"
        || message.action === "editClaudeCodeModels"
        || message.action === "editClaudeDesktopModels"
        || message.action === "cancelProviderModelEdit"
      ) {
        if (message.action !== "cancelProviderModelEdit") this.select(message);
        this.leaveEditing();
        this.editingModels = message.action === "editClaudeDesktopModels"
          ? "desktop"
          : message.action === "cancelProviderModelEdit" ? undefined : "code";
        this.view = this.editingModels === "desktop" ? "desktopSetup" : "codeSetup";
        if (message.action === "cancelProviderModelEdit") this.view = "provider";
        this.render();
        return;
      }
      const result = await this.onAction(message);
      if (message.action === "saveProviderEdit") {
        this.editing = result?.keepEditing === true;
        this.retainDraft(this.editing ? message.draft : undefined, result?.message);
      } else if (
        message.action === "saveProviderModels"
        || message.action === "saveClaudeCodeModels"
        || message.action === "saveClaudeDesktopModels"
        || message.action === "autoAssignModelRoles"
        || message.action === "fetchProviderModels"
      ) {
        this.editingModels = result?.keepEditing === true ? this.editingModels : undefined;
        // A host-recomputed draft wins over what was submitted — that is how the
        // assigned roles and the fetched models get back onto the screen.
        this.pendingModelForm = this.editingModels
          ? result?.modelForm ?? message.modelForm
          : undefined;
        this.notice = result?.message;
      } else {
        this.notice = undefined;
      }
      this.render();
    });
    this.renderShell();
  }

  private select(message: ProviderManagerMessage): void {
    if (message.providerKind && message.providerId) {
      this.selectedProvider = { kind: message.providerKind, id: message.providerId };
    }
  }

  private leaveEditing(): void {
    this.editing = false;
    this.editingModels = undefined;
    this.pendingDraft = undefined;
    this.pendingModelForm = undefined;
    this.notice = undefined;
  }

  /**
   * Only the name and URL are kept. A typed credential is deliberately dropped rather than held in
   * the extension host and echoed back into the DOM, so the notice says it has to be re-entered.
   */
  private retainDraft(draft: ProviderManagerDraft | undefined, message: string | undefined): void {
    if (!draft) {
      this.pendingDraft = undefined;
      this.notice = undefined;
      return;
    }
    this.pendingDraft = { name: draft.name, baseUrl: draft.baseUrl };
    const secretDropped = Boolean(draft.secret?.trim());
    this.notice = [message, secretDropped ? "出于安全考虑密钥框已清空，请重新输入。" : undefined]
      .filter(Boolean)
      .join(" ") || undefined;
  }

  /** Jump straight to one provider — used by the palette commands so they land on the form. */
  private focusProvider(focus?: { kind: "claude" | "codex"; id: string; edit?: boolean; modelSurface?: "code" | "desktop" }): void {
    if (focus) {
      this.selectedProvider = { kind: focus.kind, id: focus.id };
      this.leaveEditing();
      this.editing = focus.edit === true;
      this.editingModels = focus.modelSurface;
      this.view = focus.modelSurface === "desktop" ? "desktopSetup" : focus.modelSurface === "code" ? "codeSetup" : "provider";
    }
    this.render();
  }

  /**
   * The document is written once; every later update swaps the innerHTML of the two panes over
   * postMessage. A full document rewrite would reset the scroll position and blur whatever the user
   * was on, which made the panel feel like it reloaded on every click.
   */
  private render(): void {
    const state = this.getState();
    // A provider deleted from its own detail view leaves a selection that no longer resolves.
    if (this.selectedProvider && !findProvider(state, this.selectedProvider)) {
      this.selectedProvider = undefined;
      this.leaveEditing();
    }
    const selected = this.selectedProvider ? findProvider(state, this.selectedProvider) : undefined;
    const detail = this.view === "home"
      ? overviewPane(state)
      : this.view === "serviceLibrary"
        ? serviceLibraryPane(state)
        : selected
          ? providerDetail(
              selected.kind,
              selected.provider,
              this.editing ? { draft: this.pendingDraft, notice: this.notice } : undefined,
              this.editingModels && selected.kind === "claude"
                ? { draft: this.pendingModelForm, notice: this.notice, surface: this.editingModels }
                : undefined
            )
          : serviceLibraryPane(state);
    void this.panel.webview.postMessage({
      type: "render",
      status: `${statusChip("Claude", state.claudeMode, state.claudeOfficial)}${statusChip("Claude Desktop", state.claudeDesktopMode, state.claudeDesktopOfficial)}${statusChip("Codex", state.codexMode, state.codexOfficial)}`,
      list: providerList(state, this.selectedProvider),
      detail
    });
  }

  private renderShell(): void {
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
    .shell { width: min(1240px, 100%); margin: 0 auto; padding: 18px clamp(16px, 3vw, 34px) 34px; }
    header { position: relative; overflow: hidden; display: flex; justify-content: space-between; gap: 20px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; padding: 14px 18px; border: 1px solid var(--vscode-widget-border); border-radius: 14px; background: linear-gradient(120deg, color-mix(in srgb, var(--vscode-textLink-foreground) 13%, var(--vscode-sideBar-background)), var(--vscode-sideBar-background) 62%); }
    header::after { content: ""; position: absolute; width: 130px; height: 130px; right: -55px; top: -65px; border-radius: 50%; background: color-mix(in srgb, var(--vscode-textLink-foreground) 14%, transparent); pointer-events: none; }
    .brand { position: relative; z-index: 1; display: flex; align-items: center; gap: 12px; min-width: 0; }
    .brand-logo { flex: 0 0 40px; width: 40px; height: 40px; border-radius: 11px; }
    h1 { margin: 0; font-size: 17px; line-height: 1.25; letter-spacing: -0.2px; }
    .subtitle { margin: 2px 0 0; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .header-status { position: relative; z-index: 1; display: flex; flex-wrap: wrap; gap: 8px; }
    .status-chip { display: flex; align-items: center; gap: 7px; max-width: 260px; padding: 5px 11px; border: 1px solid var(--vscode-widget-border); border-radius: 99px; background: var(--vscode-editor-background); color: var(--vscode-descriptionForeground); font-size: 12px; white-space: nowrap; }
    .status-chip b { overflow: hidden; text-overflow: ellipsis; color: var(--vscode-foreground); font-weight: 600; }
    .status-dot { flex: 0 0 7px; width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-testing-iconPassed); }
    .status-dot.custom { background: var(--vscode-textLink-foreground); }

    .workspace { display: grid; grid-template-columns: minmax(230px, 290px) minmax(0, 1fr); gap: 16px; align-items: start; }
    .list-pane { display: grid; gap: 16px; min-width: 0; padding: 14px; border: 1px solid var(--vscode-widget-border); border-radius: 14px; background: var(--vscode-sideBar-background); }
    .list-section { min-width: 0; }
    .list-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 9px; padding: 0 2px; }
    .list-head span { color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
    .provider-list { display: grid; gap: 5px; min-width: 0; }
    .provider { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 4px; min-width: 0; padding: 3px 5px 3px 2px; border: 1px solid transparent; border-radius: 9px; user-select: none; }
    .provider:hover { background: var(--vscode-list-hoverBackground); }
    .provider.selected { border-color: var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground)); }
    .provider.dragging { opacity: .45; }
    .provider.official { margin-bottom: 3px; }
    .drag-handle { width: 14px; color: var(--vscode-descriptionForeground); font-size: 12px; text-align: center; cursor: grab; opacity: .35; }
    .provider:hover .drag-handle { opacity: .9; }
    .drag-spacer { width: 14px; }
    .row-open { display: grid; gap: 1px; min-width: 0; padding: 6px 4px; border: none; border-radius: 7px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
    .row-open:hover { background: transparent; }
    .row-name { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 13px; font-weight: 600; }
    .row-name span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 400; }
    .row-actions { display: flex; gap: 2px; opacity: 0; transition: opacity .12s ease; }
    .provider:hover .row-actions, .provider:focus-within .row-actions { opacity: 1; }
    @media (hover: none) { .row-actions { opacity: 1; } }
    .live-pill { flex: 0 0 auto; border-radius: 99px; padding: 1px 7px; color: var(--vscode-testing-iconPassed); background: color-mix(in srgb, var(--vscode-testing-iconPassed) 16%, transparent); font-size: 10px; font-weight: 700; }
    h2 .live-pill { margin-left: 9px; font-size: 11px; vertical-align: middle; }
    .drop-hint { padding: 9px 4px; color: var(--vscode-descriptionForeground); font-size: 11px; text-align: center; }
    .empty { padding: 14px 10px; border: 1px dashed var(--vscode-widget-border); border-radius: 9px; color: var(--vscode-descriptionForeground); text-align: center; font-size: 11px; }

    .detail-pane { display: grid; gap: 16px; min-width: 0; }
    .card { min-width: 0; border: 1px solid var(--vscode-widget-border); background: var(--vscode-sideBar-background); border-radius: 14px; padding: 18px; }
    .card-head { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 14px; }
    .card-title { display: flex; gap: 10px; align-items: center; min-width: 0; }
    .provider-icon { display: grid; flex: 0 0 30px; width: 30px; height: 30px; place-items: center; border-radius: 9px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font-size: 15px; }
    h2 { margin: 0; font-size: 17px; line-height: 1.2; }
    .badge { max-width: 50%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 1px solid var(--vscode-widget-border); border-radius: 99px; padding: 4px 10px; background: var(--vscode-editor-background); color: var(--vscode-descriptionForeground); font-size: 12px; }
    .model { margin: -4px 0 14px; padding: 8px 10px; border-radius: 8px; color: var(--vscode-descriptionForeground); background: var(--vscode-textBlockQuote-background); font-size: 12px; }
    .url { min-width: 0; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; word-break: break-word; font-size: 12px; }
    .usage-pill { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-radius: 99px; padding: 3px 8px; color: var(--vscode-descriptionForeground); background: var(--vscode-badge-background); font-size: 11px; }
    .usage-pill.configured { color: var(--vscode-testing-iconPassed); }

    .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    button { border: 1px solid transparent; border-radius: 8px; padding: 7px 13px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: inherit; font-size: 12px; font-weight: 600; transition: background .15s ease, border-color .15s ease, color .15s ease; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    button.ghost { border-color: var(--vscode-widget-border); color: var(--vscode-foreground); background: transparent; font-weight: 400; }
    button.ghost:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); }
    button.icon { display: grid; place-items: center; width: 26px; height: 26px; padding: 0; border-color: transparent; color: var(--vscode-descriptionForeground); background: transparent; font-size: 13px; font-weight: 400; }
    button.icon:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
    button.danger:hover { color: var(--vscode-errorForeground, #f14c4c); }

    .overflow { position: relative; }
    .overflow > summary { display: grid; place-items: center; width: 30px; height: 30px; border: 1px solid var(--vscode-widget-border); border-radius: 8px; cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 15px; line-height: 1; list-style: none; user-select: none; }
    .overflow > summary::-webkit-details-marker { display: none; }
    .overflow > summary::marker { content: ""; }
    .overflow > summary:hover, .overflow[open] > summary { border-color: var(--vscode-focusBorder); color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
    .overflow > summary:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .overflow-menu { position: absolute; right: 0; top: calc(100% + 6px); z-index: 20; display: grid; gap: 2px; min-width: 176px; padding: 5px; border: 1px solid var(--vscode-widget-border); border-radius: 10px; background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); box-shadow: 0 10px 26px rgba(0,0,0,.3); }
    .overflow-menu button { width: 100%; border-color: transparent; border-radius: 6px; padding: 7px 10px; color: var(--vscode-menu-foreground, var(--vscode-foreground)); background: transparent; font-weight: 400; text-align: left; white-space: nowrap; }
    .overflow-menu button:hover { color: var(--vscode-menu-selectionForeground, var(--vscode-foreground)); background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); }

    .toolbar { display: flex; justify-content: space-between; gap: 16px; align-items: center; flex-wrap: wrap; margin-top: 16px; padding: 13px 16px; border: 1px solid var(--vscode-widget-border); border-radius: 12px; background: var(--vscode-sideBar-background); }
    .toolbar strong { display: block; font-size: 13px; }
    .toolbar small { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .help { margin-top: 12px; border: 1px solid var(--vscode-widget-border); border-radius: 12px; background: var(--vscode-textBlockQuote-background); }
    .help > summary { padding: 11px 16px; cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 12px; user-select: none; }
    .help > summary:hover, .help[open] > summary { color: var(--vscode-foreground); }
    .help-body { padding: 0 16px 14px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .help-body p { margin: 0 0 11px; }
    .help-body p:last-child { margin-bottom: 0; }
    .help-body strong { color: var(--vscode-foreground); }

    .detail-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px; }
    .detail-heading { display: flex; align-items: center; gap: 12px; padding-bottom: 18px; border-bottom: 1px solid var(--vscode-widget-border); }
    .detail-heading h2 { margin-bottom: 4px; }
    .detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 16px; }
    .detail-item { min-width: 0; padding: 13px; border-radius: 10px; background: var(--vscode-editor-background); }
    .detail-wide { grid-column: 1 / -1; }
    .detail-label { display: block; margin-bottom: 7px; color: var(--vscode-descriptionForeground); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
    .detail-item strong { display: block; font-size: 13px; line-height: 1.5; }
    .detail-value { display: grid; gap: 6px; min-width: 0; }
    .detail-section { display: flex; justify-content: space-between; gap: 18px; align-items: end; margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--vscode-widget-border); }
    .detail-section h3 { margin: 0 0 4px; font-size: 13px; }
    .detail-section p { margin: 0; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .usage-section { align-items: center; }
    .form-notice { display: flex; gap: 9px; margin-top: 16px; padding: 10px 13px; border: 1px solid var(--vscode-inputValidation-errorBorder, #f14c4c); border-radius: 9px; background: var(--vscode-inputValidation-errorBackground, color-mix(in srgb, #f14c4c 15%, transparent)); color: var(--vscode-foreground); font-size: 12px; }
    .edit-form input { width: 100%; padding: 8px 10px; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); border-radius: 7px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); font: inherit; font-size: 13px; }
    .edit-form input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    .edit-form input::placeholder { color: var(--vscode-input-placeholderForeground); }
    .field-hint { display: block; margin-top: 6px; color: var(--vscode-descriptionForeground); font-size: 11px; overflow-wrap: anywhere; }
    .locked { display: block; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; overflow-wrap: anywhere; }

    .model-form input[type="text"], .model-form select { width: 100%; padding: 7px 10px; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); border-radius: 7px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); font: inherit; font-size: 12px; }
    .model-form input[type="text"]:focus-visible, .model-form select:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    .model-rows, .desktop-model-rows, .desktop-route-rows { display: grid; gap: 8px; margin-top: 12px; }
    .model-row { display: grid; grid-template-columns: minmax(0, 1fr) 150px 54px 28px; gap: 8px; align-items: center; }
    .model-1m { justify-self: start; }
    .row-tools { display: flex; flex-wrap: wrap; gap: 8px; }
    .env-preview { display: grid; gap: 3px; padding: 11px 13px; border: 1px solid var(--vscode-widget-border); border-radius: 10px; background: var(--vscode-textCodeBlock-background, var(--vscode-sideBar-background)); font-family: var(--vscode-editor-font-family, monospace); font-size: 11.5px; overflow-x: auto; }
    .env-preview div { display: flex; gap: 8px; white-space: nowrap; }
    .env-preview b { flex: 0 0 auto; color: var(--vscode-descriptionForeground); font-weight: 400; }
    .env-preview i { font-style: normal; color: var(--vscode-textLink-foreground); }
    .env-preview .env-empty { color: var(--vscode-descriptionForeground); font-family: var(--vscode-font-family); }
    .desktop-route-row { display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 7px 9px; border: 1px solid var(--vscode-panel-border); border-radius: 5px; margin-top: 6px; }
    .desktop-route-name { overflow-wrap: anywhere; }
    .advanced-compat { margin-top: 16px; border: 1px solid var(--vscode-widget-border); border-radius: 9px; background: var(--vscode-editor-background); }
    .advanced-compat > summary { padding: 10px 12px; cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .advanced-compat > summary strong { color: var(--vscode-foreground); }
    .advanced-compat-body { padding: 0 12px 12px; }
    .advanced-compat-body > p { margin: 0 0 10px; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.55; }
    .compat-disabled { color: var(--vscode-inputValidation-warningForeground, var(--vscode-descriptionForeground)); }
    .desktop-model-row { display: grid; grid-template-columns: minmax(0, 1fr) 54px 28px; gap: 8px; align-items: center; }
    .model-section { align-items: start; }
    .check-row { display: flex; gap: 6px; align-items: center; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.5; }
    .check-row input { margin: 0; }
    .model-form > button { margin-top: 8px; }

    @media (max-width: 900px) { .workspace { grid-template-columns: minmax(0, 1fr); } .list-pane { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 720px) { .shell { padding: 14px 13px 26px; } .list-pane { grid-template-columns: minmax(0, 1fr); } .detail-section { display: block; } .detail-section .actions { margin-top: 13px; } .toolbar { display: block; } .toolbar .actions { margin-top: 12px; } }
    @media (max-width: 440px) { .detail-grid { grid-template-columns: minmax(0, 1fr); } .detail-wide { grid-column: auto; } .model-row { grid-template-columns: minmax(0, 1fr) 28px; } .model-row .model-role, .model-row .model-1m { grid-column: 1; } .model-row .model-remove { grid-column: 2; grid-row: 1; } .desktop-model-row { grid-template-columns: minmax(0, 1fr) 54px 28px; } }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <div class="brand"><img class="brand-logo" src="${logoUri}" alt=""><div><h1>AI Provider Switcher</h1><p class="subtitle">统一管理 Claude 与 Codex 的官方服务与中转服务</p></div></div>
      <div class="header-status" id="header-status"></div>
    </header>
    <div class="workspace">
      <aside class="list-pane" id="list-pane"></aside>
      <section class="detail-pane" id="detail-pane"></section>
    </div>
    <div class="toolbar"><div><strong>用量与额度</strong><small>读取模型接口的限流响应头，或调用只读额度 API，不会发送收费推理请求。</small></div>${actionBar(
      [{ label: "刷新额度", action: "refreshUsage", primary: true }, { label: "管理额度配置", action: "manageUsage" }],
      [{ label: "配置额度 API", action: "configureUsage" }]
    )}</div>
    <details class="help">
      <summary>帮助与说明</summary>
      <div class="help-body">
        <p><strong>排序</strong>：拖动列表左侧的 ⠿ 手柄可以调整顺序，顺序会保存到设置里，快速切换菜单和状态栏也会跟着变。官方服务固定在最上方。</p>
        <p><strong>Codex 会话历史</strong>：切换 Provider 不会删除任何会话记录，但每条会话固定绑定创建时的 Provider，无法中途换到另一个 Provider 继续，切换后请新建对话。开启“统一会话历史”后官方订阅以共享的 custom 供应商标识运行，官方与第三方会话会出现在同一历史列表中（可选择迁入现有会话，自动备份、可还原）。</p>
        <p><strong>Base URL</strong>：只填写服务根地址，例如 https://api.example.com，协议路径由插件自动补全。若 Anthropic 兼容服务提供的是非 Claude 模型，请使用“模型映射”。</p>
        <p><strong>命令策略 Auto</strong>：并非“所有命令放行”。未命中窄 allow 规则的命令仍由独立 Sonnet 5 分类器检查，服务临时不可用时会安全阻塞。要完全跳过分类器只能在隔离环境使用“命令策略 → 完全放行”。</p>
        <p><strong>凭据</strong>：Token 与 API Key 保存在 VS Code Secret Storage，不写入 settings.json，也不会在本页面回显。</p>
      </div>
    </details>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const fieldValue = (id) => { const field = document.getElementById(id); return field ? field.value : ''; };
    const readDraft = () => ({ name: fieldValue('edit-name'), baseUrl: fieldValue('edit-base-url'), secret: fieldValue('edit-secret') });
    const readModelForm = () => {
      const surface = document.querySelector('.model-form')?.dataset.surface || 'code';
      const advanced = Boolean(document.querySelector('[data-code-advanced]')?.open);
      const rows = Array.from(document.querySelectorAll('.model-row')).map((row) => ({
        name: row.querySelector('.model-name').value.trim(),
        role: row.querySelector('.model-role').value,
        supports1m: Boolean(row.querySelector('.model-1m input')?.checked)
      }));
      const quickMain = fieldValue('code-quick-main');
      const quickFast = fieldValue('code-quick-fast') || quickMain;
      const quickRows = quickMain ? [
        { name: quickMain, role: 'main', supports1m: Boolean(document.getElementById('code-quick-main-1m')?.checked) },
        ...(quickFast !== quickMain ? [{ name: quickFast, role: 'haiku', supports1m: Boolean(document.getElementById('code-quick-fast-1m')?.checked) }] : [])
      ] : [];
      return {
        models: surface === 'code' && !advanced ? quickRows : rows,
        effort: surface === 'code' && !advanced ? fieldValue('code-quick-effort') : fieldValue('model-effort'),
        desktopModels: Array.from(document.querySelectorAll('.desktop-model-row')).map((row) => ({
          name: row.querySelector('.desktop-model-name').value.trim(),
          supports1m: Boolean(row.querySelector('.desktop-model-1m')?.checked)
        })),
        desktopRoutes: Array.from(document.querySelectorAll('.desktop-route-row')).flatMap((row) => {
          if (!row.querySelector('.desktop-route-select')?.checked) return [];
          return [{ name: row.dataset.model || '', supports1m: Boolean(row.querySelector('.desktop-route-1m input')?.checked) }];
        }),
        surface
      };
    };
    const addModelRow = () => {
      const template = document.getElementById('model-row-template');
      const container = document.getElementById('model-rows');
      if (template && container) container.appendChild(template.content.cloneNode(true));
    };
    const addDesktopModelRow = (name) => {
      const template = document.getElementById('desktop-model-row-template');
      const container = document.getElementById('desktop-model-rows');
      if (!template || !container) return;
      const fragment = template.content.cloneNode(true);
      if (name) fragment.querySelector('.desktop-model-name').value = name;
      container.appendChild(fragment);
    };
    const fillStandardAliases = (names) => {
      const container = document.getElementById('desktop-model-rows');
      if (!container) return;
      const present = new Set(Array.from(container.querySelectorAll('.desktop-model-name'))
        .map((field) => field.value.trim()));
      names.filter((name) => !present.has(name)).forEach(addDesktopModelRow);
    };

    // A preview of what the host will write. The authority is
    // createClaudeModelEnvironment in claudeConfig.ts; this mirrors its two
    // rules — unassigned roles fall back to the main model, and a model with 1M
    // ticked carries the [1m] suffix — so the effect is visible before saving.
    const ENV_ROLES = [
      ['ANTHROPIC_MODEL', 'main'],
      ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'opus'],
      ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'sonnet'],
      ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'haiku'],
      ['ANTHROPIC_DEFAULT_FABLE_MODEL', 'fable'],
      ['CLAUDE_CODE_SUBAGENT_MODEL', 'subagent']
    ];
    const renderPreview = () => {
      const box = document.getElementById('env-preview');
      if (!box) return;
      const form = readModelForm();
      const rows = form.models.filter((row) => row.name);
      const of = (role) => rows.find((row) => row.role === role);
      const main = of('main');
      if (!main) {
        box.innerHTML = '<div class="env-empty">把一个模型的角色设为「主模型」后，这里会显示最终写入的模型名。</div>';
        return;
      }
      const haiku = of('haiku') || main;
      const resolve = (role) => {
        if (role === 'haiku') return haiku;
        if (role === 'subagent') return of('subagent') || haiku;
        return of(role) || main;
      };
      const lines = ENV_ROLES.map(([variable, role]) => {
        const row = resolve(role);
        const value = row.supports1m ? row.name + '[1m]' : row.name;
        return '<div><b>' + variable + '=</b><i>' + escapeText(value) + '</i></div>';
      });
      // Mirrors createClaudeModelEnvironment: any non-empty effort is written,
      // 'auto' included. Only the empty choice omits the variable.
      const effort = fieldValue('model-effort');
      if (effort) {
        lines.push('<div><b>CLAUDE_CODE_EFFORT_LEVEL=</b><i>' + escapeText(effort) + '</i></div>');
      }
      box.innerHTML = lines.join('');
    };
    const escapeText = (value) => value.replace(/[&<>]/g, (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]);
    const send = (element) => vscode.postMessage({
      action: element.dataset.action,
      providerKind: element.dataset.providerKind,
      providerId: element.dataset.providerId,
      draft: element.dataset.action === 'saveProviderEdit' ? readDraft() : undefined,
      modelForm: ['saveProviderModels', 'saveClaudeCodeModels', 'saveClaudeDesktopModels', 'autoAssignModelRoles', 'fetchProviderModels'].includes(element.dataset.action) ? readModelForm() : undefined
    });
    const asElement = (node) => node instanceof Element ? node : null;
    const closest = (event, selector) => { const node = asElement(event.target); return node ? node.closest(selector) : null; };

    // Delegated so the handlers survive every innerHTML swap; the innermost [data-action] wins, which
    // is what lets the row-level buttons sit inside a clickable row.
    document.addEventListener('click', (event) => {
      const menu = closest(event, 'details.overflow');
      document.querySelectorAll('details.overflow[open]').forEach((open) => { if (open !== menu) open.open = false; });
      if (closest(event, '[data-model-add]')) { addModelRow(); renderPreview(); return; }
      if (closest(event, '[data-desktop-routes-all]')) {
        document.querySelectorAll('.desktop-route-select').forEach((box) => { box.checked = true; });
        return;
      }
      if (closest(event, '[data-desktop-routes-clear]')) {
        document.querySelectorAll('.desktop-route-select, .desktop-route-1m').forEach((box) => { box.checked = false; });
        return;
      }
      if (closest(event, '[data-desktop-add]')) { addDesktopModelRow(); return; }
      const standard = closest(event, '[data-desktop-standard]');
      if (standard) { fillStandardAliases(JSON.parse(standard.dataset.desktopStandard)); return; }
      const remove = closest(event, '.model-remove, .desktop-model-remove');
      if (remove) {
        remove.closest('.model-row, .desktop-model-row')?.remove();
        renderPreview();
        return;
      }
      const target = closest(event, '[data-action]');
      if (target) send(target);
    });
    // The preview tracks the form as it is typed, so the effect of a role or a
    // 1M tick is visible without a round trip to the host.
    document.addEventListener('input', (event) => {
      if (closest(event, '.model-form')) renderPreview();
    });
    document.addEventListener('change', (event) => {
      if (closest(event, '.model-form')) renderPreview();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') document.querySelectorAll('details.overflow[open]').forEach((open) => { open.open = false; });
      if (event.key !== 'Enter') return;
      const input = asElement(event.target);
      if (!input || !input.closest('.edit-form, .model-form')) return;
      const save = document.querySelector('[data-action="saveProviderEdit"], [data-action="saveProviderModels"]');
      if (save) { event.preventDefault(); send(save); }
    });

    let dragging = null;
    document.addEventListener('dragstart', (event) => {
      const row = closest(event, '.provider[draggable="true"]');
      if (!row) return;
      dragging = row;
      row.classList.add('dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        // Some payload is required before a drag will start at all.
        event.dataTransfer.setData('text/plain', row.dataset.dragId || '');
      }
    });
    document.addEventListener('dragover', (event) => {
      if (!dragging) return;
      const row = closest(event, '.provider[draggable="true"]');
      if (!row || row === dragging || row.dataset.dragKind !== dragging.dataset.dragKind) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      const box = row.getBoundingClientRect();
      const below = event.clientY > box.top + box.height / 2;
      row.parentNode.insertBefore(dragging, below ? row.nextSibling : row);
    });
    document.addEventListener('drop', (event) => {
      if (!dragging) return;
      event.preventDefault();
      const list = dragging.closest('.provider-list');
      if (!list) return;
      // The DOM already shows the new order, so persist exactly what is on screen.
      vscode.postMessage({
        action: 'reorderProviders',
        providerKind: dragging.dataset.dragKind,
        order: Array.from(list.querySelectorAll('.provider[draggable="true"]')).map((row) => row.dataset.dragId)
      });
    });
    document.addEventListener('dragend', () => {
      if (!dragging) return;
      dragging.classList.remove('dragging');
      dragging = null;
    });

    window.addEventListener('message', (event) => {
      const payload = event.data;
      if (!payload || payload.type !== 'render') return;
      document.getElementById('header-status').innerHTML = payload.status;
      document.getElementById('list-pane').innerHTML = payload.list;
      document.getElementById('detail-pane').innerHTML = payload.detail;
      // The model form is server-rendered, so its preview has to be filled in
      // after every swap rather than only on input.
      renderPreview();
      const firstField = document.getElementById('edit-name');
      if (firstField) firstField.focus();
    });
    vscode.postMessage({ action: 'ready' });
  </script>
</body></html>`;
  }
}

type ActionItem = { label: string; action: ProviderManagerAction; primary?: boolean };
type ActionTarget = { kind: "claude" | "codex"; id: string };

function statusChip(label: string, value: string, official: boolean): string {
  const title = `${label}：${official ? "官方服务" : "中转服务"} · ${value}`;
  return `<span class="status-chip" title="${escapeHtml(title)}"><span class="status-dot ${official ? "" : "custom"}"></span>${label} <b>${escapeHtml(value)}</b></span>`;
}

function actionButton(item: ActionItem, target?: ActionTarget, inMenu = false): string {
  const dataset = target ? ` data-provider-kind="${target.kind}" data-provider-id="${escapeHtml(target.id)}"` : "";
  return `<button class="${inMenu || !item.primary ? "ghost" : ""}" data-action="${item.action}"${dataset}>${item.label}</button>`;
}

/**
 * Exactly one filled button per group so the eye has somewhere to land; everything else is a ghost
 * button, and the rarely used actions collapse into a `⋯` menu instead of widening the row.
 */
function actionBar(inline: ActionItem[], overflow: ActionItem[] = [], target?: ActionTarget): string {
  const buttons = inline.map((item) => actionButton(item, target)).join("");
  if (!overflow.length) return `<div class="actions">${buttons}</div>`;
  const menu = overflow.map((item) => actionButton(item, target, true)).join("");
  return `<div class="actions">${buttons}<details class="overflow"><summary title="更多操作" aria-label="更多操作">⋯</summary><div class="overflow-menu">${menu}</div></details></div>`;
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

/**
 * The persistent list. Rows carry the drag metadata; the official entry is not draggable because it
 * is not a stored provider and has no position of its own to remember.
 */
function providerList(
  state: ProviderManagerState,
  selection: { kind: "claude" | "codex"; id: string } | undefined
): string {
  return [
    listSection("claude", "Claude", "addClaudeProvider", "claudeOfficial", state.claudeOfficial, state.claudeProviders.map((provider) => ({
      id: provider.id,
      name: provider.name,
      sub: provider.baseUrl,
      active: provider.active,
      switchAction: "switchClaude" as ProviderManagerAction
    })), selection),
    listSection("codex", "Codex", "addCodexProvider", "codexOfficial", state.codexOfficial, state.codexProviders.map((provider) => ({
      id: provider.id,
      name: provider.name,
      sub: `${provider.baseUrl} · ${provider.modelCount} 个模型`,
      active: provider.active,
      switchAction: "switchCodex" as ProviderManagerAction
    })), selection)
  ].join("");
}

function listSection(
  kind: "claude" | "codex",
  title: string,
  addAction: ProviderManagerAction,
  officialAction: ProviderManagerAction,
  officialActive: boolean,
  providers: Array<{ id: string; name: string; sub: string; active: boolean; switchAction: ProviderManagerAction }>,
  selection: { kind: "claude" | "codex"; id: string } | undefined
): string {
  const officialRow = `<div class="provider official${officialActive ? " selected" : ""}"><span class="drag-spacer"></span><button class="row-open" data-action="${officialAction}" title="切换到官方服务"><span class="row-name"><span>官方服务</span>${officialActive ? '<span class="live-pill">使用中</span>' : ""}</span><span class="row-sub">${kind === "claude" ? "Claude 官方订阅" : "OpenAI 官方 Provider"}</span></button></div>`;
  const rows = providers.length
    ? providers.map((provider) => `<div class="provider${selection?.kind === kind && selection.id === provider.id ? " selected" : ""}" draggable="true" data-drag-kind="${kind}" data-drag-id="${escapeHtml(provider.id)}"><span class="drag-handle" title="拖拽调整顺序">⠿</span><button class="row-open" data-action="open${kind === "claude" ? "Claude" : "Codex"}Provider" data-provider-kind="${kind}" data-provider-id="${escapeHtml(provider.id)}"><span class="row-name"><span>${escapeHtml(provider.name)}</span>${provider.active ? '<span class="live-pill">使用中</span>' : ""}</span><span class="row-sub">${escapeHtml(provider.sub)}</span></button><div class="row-actions"><button class="icon" title="切换到此服务" aria-label="切换到此服务" data-action="${provider.switchAction}" data-provider-kind="${kind}" data-provider-id="${escapeHtml(provider.id)}">⇄</button><button class="icon" title="编辑配置" aria-label="编辑配置" data-action="editProvider" data-provider-kind="${kind}" data-provider-id="${escapeHtml(provider.id)}">✎</button></div></div>`).join("")
    : '<div class="empty">尚未添加中转服务</div>';
  return `<div class="list-section"><div class="list-head"><span>${title}</span><button class="icon" title="添加${title}中转服务" aria-label="添加${title}中转服务" data-action="${addAction}">＋</button></div><div class="provider-list" data-kind="${kind}">${officialRow}${rows}</div>${providers.length > 1 ? '<div class="drop-hint">拖动 ⠿ 调整顺序</div>' : ""}</div>`;
}

function serviceLibraryPane(state: ProviderManagerState): string {
  const claudeCount = state.claudeProviders.length;
  const codexCount = state.codexProviders.length;
  return `<article class="card"><div class="detail-top"><button class="ghost" data-action="backToOverview">← 返回配置首页</button><span class="badge">服务库</span></div><div class="detail-heading"><span class="provider-icon">▤</span><div><h2>服务库</h2><small class="url">添加、编辑、排序或删除中转服务。先从左侧选择服务；这里的连接信息可供 Claude Code 和 Claude Desktop 共用。</small></div></div><div class="detail-grid"><div class="detail-item"><span class="detail-label">Claude 服务</span><strong>${claudeCount} 个已保存服务</strong><small class="field-hint">点左侧 Claude 服务查看共享连接信息、Code 与 Desktop 的独立设置。</small></div><div class="detail-item"><span class="detail-label">Codex 服务</span><strong>${codexCount} 个已保存服务</strong><small class="field-hint">点左侧 Codex 服务配置模型、代理和额度。</small></div></div><div class="detail-section"><div><h3>添加服务</h3><p>服务是连接地址与 Token 的保存记录；它本身不会切换任何产品。</p></div>${actionBar([{ label: "添加 Claude 服务", action: "addClaudeProvider", primary: true }, { label: "添加 Codex 服务", action: "addCodexProvider" }])}</div></article>`;
}

/** Shown when no provider is selected: product-first task entrypoints. */
function overviewPane(state: ProviderManagerState): string {
  // A remote window writes to the remote host's home directory — right for the
  // CLIs, impossible for the local desktop app. Say so before anything else.
  const remote = state.remoteNotice
    ? `<div class="form-notice" role="note"><span>⧉</span><span>${escapeHtml(state.remoteNotice)}</span></div>`
    : "";
  const claudeCodeCard = `<article class="card"><div class="card-head"><div class="card-title"><span class="provider-icon">✦</span><h2>Claude Code（VS Code / 终端）</h2></div><span class="badge">${escapeHtml(state.claudeMode)}</span></div><div class="model">当前模型与命令策略作用于 VS Code 内 Claude Code 和终端 <code>claude</code>。<strong>不会切换 Claude Desktop。</strong></div>${actionBar(
    [
      { label: "切换 Claude Code 服务", action: "switchClaude", primary: true },
      { label: "使用 Claude 官方订阅", action: "claudeOfficial" },
      { label: "配置 Claude Code 模型", action: "configureCurrentClaudeCodeModels" }
    ],
    [
      { label: "命令策略", action: "configureClaudePermissions" },
      { label: "刷新模型", action: "refreshClaude" },
      { label: "检测外部配置", action: "inspectClaude" },
      { label: "管理服务（命令菜单）", action: "manageClaude" }
    ]
  )}</article>`;
  const desktopCard = `<article class="card"><div class="card-head"><div class="card-title"><span class="provider-icon">▣</span><h2>Claude Desktop（独立应用）</h2></div><span class="badge">${escapeHtml(state.claudeDesktopMode)}</span></div><div class="model">Desktop 有自己的服务与模型目录，独立于 VS Code 和终端。切换或保存后需要<strong>完全退出并重新打开 Claude Desktop</strong>。</div>${actionBar(
    [
      { label: "切换 Claude Desktop 服务", action: "switchClaudeDesktop", primary: true }
    ],
    [{ label: "管理 Desktop 模型", action: "configureCurrentClaudeDesktopModels" }]
  )}</article>`;
  const libraryCard = `<article class="card"><div class="card-head"><div class="card-title"><span class="provider-icon">▤</span><h2>服务库</h2></div><span class="badge">${state.claudeProviders.length + state.codexProviders.length} 个服务</span></div><div class="model">添加或编辑中转站的地址、Token、排序和额度。服务资料可被 Claude Code 与 Claude Desktop 共用，但不会因为查看服务库而切换任何产品。</div>${actionBar([{ label: "管理服务库", action: "openServiceLibrary", primary: true }])}</article>`;
  const claude = `${claudeCodeCard}${desktopCard}${libraryCard}`;
  const codexModel = state.codexModel
    ? `默认模型：${state.codexModel}（可随时在 Codex 原生模型栏临时改用其它模型）`
    : "未固定默认模型，由 Codex 页面原生模型栏决定";
  const codex = `<article class="card"><div class="card-head"><div class="card-title"><span class="provider-icon">⌁</span><h2>Codex</h2></div><span class="badge">${escapeHtml(state.codexMode)}</span></div><div class="model">${escapeHtml(codexModel)}${state.codexUnifiedHistory ? " · 统一会话历史：已开启" : ""}</div>${actionBar(
    [
      { label: "切换服务", action: "switchCodex", primary: true },
      { label: "使用官方", action: "codexOfficial" },
      { label: "选择默认模型", action: "configureCodexModel" },
      { label: "打开 Codex", action: "openCodex" }
    ],
    [
      { label: "统一会话历史", action: "codexUnify" },
      { label: "配置连接代理", action: "configureCodexProxy" },
      { label: "刷新模型", action: "refreshCodex" },
      { label: "管理服务（命令菜单）", action: "manageCodex" }
    ]
  )}</article>`;
  return `${remote}${claude}${codex}`;
}

function detailTop(isClaude: boolean): string {
  return `<div class="detail-top"><button class="ghost" data-action="backToOverview">← 返回总览</button><span class="badge">${isClaude ? "Claude" : "Codex"}</span></div>`;
}

/**
 * The ID is shown but never editable: it keys the saved credential, the model cache, and — for
 * Codex — the provider every recorded session is permanently bound to.
 */
function providerEditForm(
  kind: "claude" | "codex",
  provider: ProviderView,
  edit: { draft?: { name: string; baseUrl: string }; notice?: string }
): string {
  const isClaude = kind === "claude";
  const secretLabel = isClaude ? "网关 Token" : "API Key";
  const urlHint = isClaude
    ? "只填服务根地址，例如 https://api.example.com；结尾的 /v1 会被自动去掉。"
    : "只填服务根地址，例如 https://api.example.com；Codex 协议路径由插件自动补全。";
  // A rejected draft wins over the stored values so nothing typed is lost on a validation error.
  const nameValue = edit.draft?.name ?? provider.name;
  const urlValue = edit.draft?.baseUrl ?? provider.baseUrl;
  const notice = edit.notice ? `<div class="form-notice" role="alert"><span>⚠</span><span>${escapeHtml(edit.notice)}</span></div>` : "";
  return `<article class="card edit-form">${detailTop(isClaude)}<div class="detail-heading"><span class="provider-icon">${isClaude ? "✦" : "⌁"}</span><div><h2>编辑 ${escapeHtml(provider.name)}</h2><small class="url">修改后无需删除重建，已保存的会话与凭据都会保留。</small></div></div>${notice}<div class="detail-grid"><div class="detail-item"><span class="detail-label">名称</span><input id="edit-name" type="text" value="${escapeHtml(nameValue)}" spellcheck="false" autocomplete="off"></div><div class="detail-item"><span class="detail-label">Base URL</span><input id="edit-base-url" type="text" value="${escapeHtml(urlValue)}" spellcheck="false" autocomplete="off"><small class="field-hint">${urlHint}</small></div><div class="detail-item detail-wide"><span class="detail-label">${secretLabel}</span><input id="edit-secret" type="password" placeholder="留空表示不修改已保存的密钥" autocomplete="off"><small class="field-hint">密钥保存在 VS Code Secret Storage，不会写入 settings.json，也不会在此页面回显。</small></div><div class="detail-item detail-wide"><span class="detail-label">Provider ID（不可修改）</span><span class="locked">${escapeHtml(provider.id)}</span><small class="field-hint">${isClaude
    ? "该 ID 绑定着已保存的 Token 与模型缓存，改名不会影响它们。"
    : "Codex 把每条会话永久绑定到该 ID。改名不会动它，所以历史会话不会丢失。"}</small></div></div><div class="detail-section"><div><h3>保存修改</h3><p>${isClaude
    ? "若该 Provider 正在使用，保存后会同步重写 Claude 的实际配置并提示重载。"
    : "保存后会同步刷新 config.toml 中的托管 Provider 块；若正在使用，还会提示重载。"}</p></div>${actionBar(
    [{ label: "保存", action: "saveProviderEdit", primary: true }, { label: "取消", action: "cancelProviderEdit" }],
    [],
    { kind, id: provider.id }
  )}</div></article>`;
}

function providerDetail(
  kind: "claude" | "codex",
  provider: ProviderView,
  edit?: { draft?: { name: string; baseUrl: string }; notice?: string },
  modelEdit?: { draft?: ProviderModelFormPayload; notice?: string; surface: "code" | "desktop" }
): string {
  const isClaude = kind === "claude";
  if (edit) return providerEditForm(kind, provider, edit);
  if (modelEdit && isClaude) return providerModelForm(
    provider as ProviderManagerState["claudeProviders"][number],
    modelEdit
  );
  const claudeProvider = isClaude ? provider as ProviderManagerState["claudeProviders"][number] : undefined;
  const codexProvider = !isClaude ? provider as ProviderManagerState["codexProviders"][number] : undefined;
  const target: ActionTarget = { kind, id: provider.id };
  const usageInline: ActionItem[] = [
    { label: "刷新额度", action: "refreshUsage", primary: true },
    provider.hasUsageConfig
      ? { label: "编辑额度配置", action: "editUsageConfig" }
      : { label: "配置额度", action: "configureUsage" }
  ];
  const usageOverflow: ActionItem[] = [
    { label: "查看额度配置", action: "viewUsageConfig" },
    { label: "删除额度配置", action: "deleteUsageConfig" }
  ];
  const usageDetail = provider.hasUsageConfig
    ? `<div class="detail-value"><span class="usage-pill configured">已配置额度 API</span><small class="url">${escapeHtml(provider.usageEndpoint ?? "")}</small>${provider.usageMappings ? `<small class="url">字段：${escapeHtml(provider.usageMappings)}</small>` : ""}</div>`
    : `<div class="detail-value"><span class="usage-pill">未配置额度 API</span><small class="url">可从此页面直接添加和管理</small></div>`;
  if (!isClaude) {
    const inline: ActionItem[] = [
      { label: provider.active ? "重新应用此服务" : "切换到此服务", action: "switchCodex", primary: true },
      { label: "编辑配置", action: "editProvider" },
      { label: "选择默认模型", action: "configureCodexModel" }
    ];
    const overflow: ActionItem[] = [
      { label: "刷新模型", action: "refreshCodex" }, { label: "配置连接代理", action: "configureCodexProxy" }, { label: "打开 Codex", action: "openCodex" }, { label: "删除此服务", action: "removeProvider" }
    ];
    return `<article class="card">${detailTop(false)}<div class="detail-heading"><span class="provider-icon">⌁</span><div><h2>${escapeHtml(provider.name)}${provider.active ? '<span class="live-pill">使用中</span>' : ""}</h2><small class="url">${escapeHtml(provider.baseUrl)}</small></div></div><div class="detail-grid"><div class="detail-item"><span class="detail-label">连接状态</span><strong>${provider.active ? "当前服务" : "可用服务"}</strong></div><div class="detail-item"><span class="detail-label">模型缓存</span><strong>${escapeHtml(String(codexProvider?.modelCount ?? 0))} 个已缓存模型</strong></div><div class="detail-item detail-wide"><span class="detail-label">额度配置</span>${usageDetail}</div></div><div class="detail-section"><div><h3>服务操作</h3><p>所有操作都针对当前选中的服务，不需要再从菜单二次选择。</p></div>${actionBar(inline, overflow, target)}</div><div class="detail-section usage-section"><div><h3>用量与额度</h3><p>${escapeHtml(provider.usage)}</p></div>${actionBar(usageInline, usageOverflow, target)}</div></article>`;
  }
  const desktopStatus = claudeProvider?.desktopActive
    ? `Desktop 当前正在使用此服务${claudeProvider.desktopRoutes.length ? `，已配置 ${claudeProvider.desktopRoutes.length} 个模型` : ""}。`
    : claudeProvider?.desktopRoutes.length
      ? `已预先配置 ${claudeProvider.desktopRoutes.length} 个 Desktop 模型；下次切换 Desktop 到此服务时带入。`
      : "尚未配置 Desktop 模型；可先配置，切换 Desktop 服务时会带入。";
  const shared = `<div class="detail-section"><div><h3>共享连接信息</h3><p>名称、Base URL 与 Token 是同一个中转站的资料。若 Claude Code 或 Claude Desktop 正在使用此服务，保存后会同步正在使用的一端。</p></div>${actionBar([{ label: "编辑连接信息", action: "editProvider", primary: true }], [{ label: "删除此服务", action: "removeProvider" }], target)}</div>`;
  const code = `<div class="detail-section"><div><h3>Claude Code（VS Code / 终端）</h3><p>当前：${escapeHtml(claudeProvider?.mapping ?? "未配置")} · 命令策略：${escapeHtml(claudeProvider?.permissionStrategy ?? "未配置")}。模型角色、1M 与 effort 只写入 VS Code 内 Claude Code 和终端 CLI，不会配置 Desktop。</p></div>${actionBar([{ label: "配置 Claude Code 模型", action: "editClaudeCodeModels", primary: true }, { label: provider.active ? "重新应用 Claude Code" : "切换 Claude Code 服务", action: "switchClaude" }], [{ label: "命令策略", action: "configureClaudePermissions" }, { label: "刷新模型", action: "refreshClaude" }, { label: "检测外部配置", action: "inspectClaude" }], target)}</div>`;
  const desktop = `<div class="detail-section"><div><h3>Claude Desktop（独立应用）</h3><p>${escapeHtml(desktopStatus)} Desktop 模型目录和本地代理只影响独立桌面应用，不改变 Claude Code 或终端。</p></div>${actionBar([{ label: "配置 Desktop 模型", action: "editClaudeDesktopModels", primary: true }, { label: "切换 Desktop 服务", action: "switchClaudeDesktop" }], [], target)}</div>`;
  return `<article class="card">${detailTop(true)}<div class="detail-heading"><span class="provider-icon">✦</span><div><h2>${escapeHtml(provider.name)}${provider.active ? '<span class="live-pill">Claude Code 使用中</span>' : ""}</h2><small class="url">${escapeHtml(provider.baseUrl)}</small></div></div>${shared}${code}${desktop}<div class="detail-section usage-section"><div><h3>用量与额度</h3><p>${escapeHtml(provider.usage)}</p></div>${actionBar(usageInline, usageOverflow, target)}</div></article>`;
}

const MODEL_ROLE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "不映射" },
  { value: "main", label: "主模型" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku（快速）" },
  { value: "fable", label: "Fable" },
  { value: "subagent", label: "子代理" }
];

/**
 * The first option is the empty one on purpose. `auto` is a value Claude Code
 * accepts and this extension does write, so it cannot double as "leave it
 * alone" — without a distinct empty choice, merely opening this editor on a
 * provider the wizard left unset and pressing 保存 silently added
 * `CLAUDE_CODE_EFFORT_LEVEL=auto` to all three configs.
 */
const MODEL_EFFORT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "不设置（不写入该变量）" },
  { value: "auto", label: "auto" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
  { value: "max", label: "max" }
];

/**
 * The per-provider model editor: the cached model list, editable row by row,
 * each with the mapping role it plays and its own 1M switch. The switch is per
 * model, not per role — a model routinely fills several roles, so a declaration
 * attached to a role would apply to only some of the places it is sent. Every
 * Claude Desktop alias has its own switch too, since aliases resolve to
 * different models with different context windows. A rejected draft wins over
 * the stored values so nothing typed is lost on a validation error.
 */
function providerModelForm(
  provider: ProviderManagerState["claudeProviders"][number],
  edit: { draft?: ProviderModelFormPayload; notice?: string; surface: "code" | "desktop" }
): string {
  const surface = edit.surface;
  const target: ActionTarget = { kind: "claude", id: provider.id };
  const form = edit.draft ?? {
    models: provider.modelList,
    effort: provider.effortLevel,
    desktopModels: provider.desktopModels,
    desktopRoutes: provider.desktopRoutes
  };
  const notice = edit.notice
    ? `<div class="form-notice" role="alert"><span>⚠</span><span>${escapeHtml(edit.notice)}</span></div>`
    : "";
  const effortOptions = (selected: string): string => MODEL_EFFORT_OPTIONS.map((option) =>
    `<option value="${option.value}"${option.value === selected ? " selected" : ""}>${escapeHtml(option.label)}</option>`
  ).join("");
  const rows = form.models.length
    ? form.models.map((row) => modelRow(row.name, row.role, row.supports1m)).join("")
    : "";
  const desktopRows = form.desktopModels.length
    ? form.desktopModels.map((entry) => desktopModelRow(entry.name, entry.supports1m)).join("")
    : "";
  const desktopRouteRows = form.models.length
    ? form.models.map((row) => desktopRouteRow(
      row.name,
      (form.desktopRoutes ?? []).some((entry) => entry.name === row.name && entry.supports1m),
      (form.desktopRoutes ?? []).some((entry) => entry.name === row.name)
    )).join("")
    : '<div class="env-empty">先填写或从服务获取模型列表，才能添加 Desktop 全模型目录。</div>';
  const routeCount = (form.desktopRoutes ?? []).length;
  const compatOpen = routeCount === 0 && form.desktopModels.length > 0;
  const compatState = routeCount > 0
    ? `<span class="compat-disabled">全模型目录已启用（${routeCount} 个模型），以下设置当前不参与路由。</span>`
    : form.desktopModels.length > 0
      ? "检测到旧版别名配置，当前正在使用兼容模式。"
      : "通常不需要；只有服务商明确要求发送兼容别名时才配置。";
  const compatSection = `<details class="advanced-compat"${compatOpen ? " open" : ""}><summary><strong>高级：旧版兼容别名</strong> · ${compatState}</summary><div class="advanced-compat-body"><p>这是服务商自己翻译名称的旧模式，不是 Claude 官方模型列表。通用档位名只表示 Desktop 的分类：opus＝最高能力、sonnet＝通用、haiku＝快速/低成本、fable＝增强推理；它们不等同于任何具体 Claude 版本。只有服务商文档明确说支持时才使用。若不确定，请留空并使用上方全模型目录。</p>${desktopAliasHint(provider)}<div class="desktop-model-rows" id="desktop-model-rows">${desktopRows}</div><div class="row-tools"><button class="ghost" type="button" data-desktop-add>＋ 添加服务商兼容别名</button><button class="ghost" type="button" data-desktop-standard='${escapeHtml(JSON.stringify(CLAUDE_DESKTOP_GENERIC_TIER_ALIASES))}'>⚡ 填入通用档位名（需服务商支持）</button></div><template id="desktop-model-row-template">${desktopModelRow("", false)}</template></div></details>`;
  const quickOptions = (selected: string, allowEmpty = false): string => [
    ...(allowEmpty ? [{ name: "", label: "与主模型相同（推荐）" }] : [{ name: "", label: "请选择主模型" }]),
    ...form.models.filter((row) => row.name.trim()).map((row) => ({ name: row.name.trim(), label: row.name.trim() }))
  ].map((option) => `<option value="${escapeHtml(option.name)}"${option.name === selected ? " selected" : ""}>${escapeHtml(option.label)}</option>`).join("");
  const quickMain = form.models.find((row) => row.role === "main")?.name.trim() ?? "";
  const quickFast = form.models.find((row) => row.role === "haiku")?.name.trim() ?? "";
  const quickMain1m = form.models.some((row) => row.name.trim() === quickMain && row.supports1m);
  const quickFast1m = form.models.some((row) => row.name.trim() === quickFast && row.supports1m);
  const codeBody = `<div class="detail-section model-section"><div><h3>推荐配置</h3><p>大多数人只需要选一个主模型；需要更快或更便宜的后台任务时，再选一个快速模型。这里的选择只写入 Claude Code 和终端 CLI，不影响 Claude Desktop。</p></div></div>
<div class="detail-grid quick-code"><div class="detail-item"><span class="detail-label">主模型</span><select id="code-quick-main" class="form-select">${quickOptions(quickMain)}</select><label class="check-row"><input id="code-quick-main-1m" type="checkbox"${quickMain1m ? " checked" : ""}><span>这个模型支持 1M 上下文</span></label></div><div class="detail-item"><span class="detail-label">快速模型（可选）</span><select id="code-quick-fast" class="form-select">${quickOptions(quickFast, true)}</select><label class="check-row"><input id="code-quick-fast-1m" type="checkbox"${quickFast1m ? " checked" : ""}><span>这个模型支持 1M 上下文</span></label></div><div class="detail-item detail-wide"><span class="detail-label">推理强度（可选）</span><select id="code-quick-effort" class="form-select">${effortOptions(form.effort)}</select><small class="field-hint">不确定时选「不设置」。只在服务商说明支持时调整 effort。</small></div></div>
<div class="row-tools"><button class="ghost" type="button" data-action="fetchProviderModels" data-provider-kind="claude" data-provider-id="${escapeHtml(provider.id)}">⟳ 从服务获取模型列表</button></div>
<details class="advanced-compat" data-code-advanced><summary><strong>高级：按角色分别配置模型</strong> · 通常不需要</summary><div class="advanced-compat-body"><p>只有希望为 Opus、Sonnet、Haiku、Fable 和子代理分别指定模型时才使用。展开后保存会使用此处的角色配置，而不是上方推荐配置。</p><div class="model-rows" id="model-rows">${rows}</div><div class="row-tools"><button class="ghost" type="button" data-model-add>＋ 添加模型</button><button class="ghost" type="button" data-action="autoAssignModelRoles" data-provider-kind="claude" data-provider-id="${escapeHtml(provider.id)}">✨ 自动分配角色</button></div><template id="model-row-template">${modelRow("", "", false)}</template><div class="detail-section model-section"><div><h3>Claude Code 实际写入预览</h3><p>以下是保存后写入 Claude Code / 终端的 <code>ANTHROPIC_*</code> 与 <code>CLAUDE_CODE_*</code> 环境变量。Desktop 不读取这里的配置。</p></div></div><div class="env-preview" id="env-preview"></div><div class="detail-grid"><div class="detail-item detail-wide"><span class="detail-label">推理强度（effort）</span><select id="model-effort" class="form-select">${effortOptions(form.effort)}</select></div></div></div></details>`;
  const desktopBody = `<div class="detail-section model-section"><div><h3>三步配置 Desktop</h3><p><strong>1. 服务：</strong>${escapeHtml(provider.name)}（已选择）　<strong>2. 选择模型：</strong>在下方勾选　<strong>3. 保存并重启：</strong>保存后按提示完全退出 Claude Desktop。</p></div></div>
<div class="detail-section model-section"><div><h3>Desktop 全模型目录</h3><p>这是独立 Claude Desktop 应用的模型选择器，不影响 VS Code 内 Claude Code 或终端。每一行就是实际发给中转站的模型 ID，勾选后由本机代理精确转发。</p></div></div>
<div class="detail-section model-section"><div><h3>步骤 2：选择模型</h3><p>${routeCount > 0 ? `已启用 ${routeCount} 个模型。高级兼容别名不会参与 Claude Desktop 路由。` : "还未选择模型：先获取模型列表，然后勾选需要的模型。Desktop 与 VS Code 必须在同一台机器，Remote-SSH / WSL 不可用。"}</p></div></div>
<div class="row-tools"><button class="ghost" type="button" data-action="fetchProviderModels" data-provider-kind="claude" data-provider-id="${escapeHtml(provider.id)}">⟳ 获取模型列表</button><button class="ghost" type="button" data-desktop-routes-all>＋ 添加已缓存的全部模型</button><button class="ghost" type="button" data-desktop-routes-clear>清空全模型目录</button></div>
<div class="desktop-route-rows" id="desktop-route-rows">${desktopRouteRows}</div>
${compatSection}`;
  const isDesktop = surface === "desktop";
  const heading = isDesktop ? "配置 Claude Desktop 模型" : "配置 Claude Code 模型与参数";
  const subtitle = isDesktop
    ? "只影响独立 Claude Desktop 应用。保存后若 Desktop 正在使用此服务，会提示完全退出并重新启动应用。"
    : "只影响 VS Code 内 Claude Code 与终端 Claude CLI。保存后若 Claude Code 正在使用此服务，会提示重新加载 VS Code。";
  const action = isDesktop ? "saveClaudeDesktopModels" : "saveClaudeCodeModels";
  const saveLabel = isDesktop ? "保存 Claude Desktop 模型" : "保存 Claude Code 配置";
  const saveNote = isDesktop
    ? (provider.desktopActive ? "Desktop 正在使用此服务，保存后会更新 Desktop 配置；需完全退出并重新启动 Claude Desktop。" : "保存后将在下次切换 Claude Desktop 到此服务时生效。")
    : (provider.active ? "Claude Code 正在使用此服务，保存后会写入 VS Code 与终端 CLI，并提示重新加载。" : "保存后将在下次切换 Claude Code 到此服务时生效。");
  const otherAction = isDesktop ? "editClaudeCodeModels" : "editClaudeDesktopModels";
  const otherLabel = isDesktop ? "去配置 Claude Code 模型" : "去配置 Desktop 模型";
  return `<article class="card model-form" data-surface="${surface}">${detailTop(true)}<div class="detail-heading"><span class="provider-icon">✦</span><div><h2>${heading} — ${escapeHtml(provider.name)}</h2><small class="url">${subtitle}</small></div></div>${notice}${isDesktop ? desktopBody : codeBody}<div class="detail-section"><div><h3>保存</h3><p>${saveNote}</p></div>${actionBar([{ label: saveLabel, action, primary: true }, { label: otherLabel, action: otherAction }, { label: "取消", action: "cancelProviderModelEdit" }], [], target)}</div></article>`;
}

/**
 * Explains at configuration time — rather than after a failed desktop switch —
 * that this gateway can only be reached through Anthropic-style aliases.
 */
function desktopAliasHint(
  provider: ProviderManagerState["claudeProviders"][number]
): string {
  if (!provider.desktopAliasRequired) return "";
  return `<div class="form-notice" role="note"><span>ℹ</span><span>该服务的真实模型名不符合 Claude Desktop 的命名校验。推荐在上方全模型目录勾选模型，由本机代理精确转发。只有服务商文档明确说明它接受某个兼容别名时，才在高级区填写该名称；不要猜测 Claude 的版本号。</span></div>`;
}

function desktopRouteRow(name: string, supports1m: boolean, selected: boolean): string {
  return `<label class="desktop-route-row" data-model="${escapeHtml(name)}"><input class="desktop-route-select" type="checkbox"${selected ? " checked" : ""}><span class="desktop-route-name">${escapeHtml(name)}</span><span class="check-row desktop-route-1m" title="该模型在 Desktop 里提供 1M 变体"><input type="checkbox"${supports1m ? " checked" : ""}><span>1M</span></span></label>`;
}

/** One editable model row: name input, role select, 1M switch, remove button. */
function modelRow(name: string, role: string, supports1m: boolean): string {
  return `<div class="model-row"><input class="model-name" type="text" value="${escapeHtml(name)}" placeholder="模型 ID，如 deepseek-v4-pro" spellcheck="false" autocomplete="off"><select class="model-role form-select">${MODEL_ROLE_OPTIONS.map((option) =>
    `<option value="${option.value}"${option.value === role ? " selected" : ""}>${option.label}</option>`
  ).join("")}</select><label class="check-row model-1m" title="该模型将以 [1m] 变体使用"><input type="checkbox"${supports1m ? " checked" : ""}><span>1M</span></label><button class="icon danger model-remove" type="button" title="删除此模型" aria-label="删除此模型">✕</button></div>`;
}

/** One editable Claude Desktop alias row: name input, 1M switch, remove button. */
function desktopModelRow(name: string, supports1m: boolean): string {
  return `<div class="desktop-model-row"><input class="desktop-model-name" type="text" value="${escapeHtml(name)}" placeholder="服务商明确支持的兼容别名" spellcheck="false" autocomplete="off"><label class="check-row" title="勾选后桌面选择器才会为它提供 1M 上下文变体"><input class="desktop-model-1m" type="checkbox"${supports1m ? " checked" : ""}><span>1M</span></label><button class="icon danger desktop-model-remove" type="button" title="删除此兼容别名" aria-label="删除此兼容别名">✕</button></div>`;
}
