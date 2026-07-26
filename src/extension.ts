import * as vscode from "vscode";
import * as https from "node:https";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { URL } from "node:url";
import {
  CODEX_MANAGED_BEGIN,
  CODEX_MANAGED_END,
  getCodexApiBaseUrl,
  normalizeProviderRootUrl,
  parseTopLevelTomlString,
  removeManagedCodexProviders,
  updateTopLevelTomlKey
} from "./codexConfig";
import {
  ProviderManagerAction,
  ProviderManagerPanel,
  ProviderManagerState
} from "./providerManagerPanel";

type EnvVar = { name: string; value: string };
type GatewayProfile = { id: string; name: string; baseUrl: string };
type GatewayModels = { gatewayId: string; models: string[]; updatedAt: string };
type CodexProviderProfile = { id: string; name: string; baseUrl: string };
type CodexModels = { providerId: string; models: string[]; updatedAt: string };

enum ProviderMode {
  Official = "Official",
  Gateway = "Gateway"
}

const SECRET_KEY_PREFIX = "aiProviderSwitcher.claude.gatewayAuthToken.";
const CLAUDE_ENV_KEY = "claudeCode.environmentVariables";
const CLAUDE_LOGIN_PROMPT_KEY = "claudeCode.disableLoginPrompt";
const GATEWAYS_KEY = "aiProviderSwitcher.gateways";
const GATEWAY_MODELS_KEY = "gatewayModels";
const CODEX_SECRET_KEY_PREFIX = "aiProviderSwitcher.codex.apiKey.";
const CODEX_PROVIDERS_KEY = "codexProviders";
const CODEX_MODELS_KEY = "codexModels";
const CODEX_ACTIVE_PROVIDER_KEY = "codexActiveProviderId";
const CODEX_ACTIVE_MODEL_KEY = "codexActiveModel";
const CODEX_CONFIG_FILE = path.join(os.homedir(), ".codex", "config.toml");
const CODEX_BACKUP_KEY = "codex.originalTopLevelConfig";

const MANAGED_ENV_KEYS = new Set([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
  "CLAUDE_CODE_ATTRIBUTION_HEADER"
]);

let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext): void {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 80);
  statusBarItem.command = "aiProviderSwitcher.openManager";
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("aiProviderSwitcher.switchMode", () => quickSwitch(context)),
    vscode.commands.registerCommand("aiProviderSwitcher.openManager", () => openProviderManager(context)),
    vscode.commands.registerCommand("aiProviderSwitcher.useOfficial", () => switchToOfficial()),
    vscode.commands.registerCommand("aiProviderSwitcher.useGateway", () => switchToGateway(context)),
    vscode.commands.registerCommand("aiProviderSwitcher.manageGateways", () => manageGateways(context)),
    vscode.commands.registerCommand("aiProviderSwitcher.addGateway", () => addGateway()),
    vscode.commands.registerCommand("aiProviderSwitcher.removeGateway", () => removeGateway(context)),
    vscode.commands.registerCommand("aiProviderSwitcher.clearGatewayToken", () => clearGatewayToken(context)),
    vscode.commands.registerCommand("aiProviderSwitcher.openSessionHistory", () =>
      vscode.commands.executeCommand("workbench.action.chat.openSessions")
    ),
    vscode.commands.registerCommand("aiProviderSwitcher.refreshModels", () => refreshGatewayModels(context)),
    vscode.commands.registerCommand("aiProviderSwitcher.showModels", () => showGatewayModels()),
    vscode.commands.registerCommand("aiProviderSwitcher.switchCodexProvider", () =>
      switchToCodexGateway(context)
    ),
    vscode.commands.registerCommand("aiProviderSwitcher.useCodexOfficial", () =>
      switchToCodexOfficial(context)
    ),
    vscode.commands.registerCommand("aiProviderSwitcher.manageCodexProviders", () =>
      manageCodexProviders(context)
    ),
    vscode.commands.registerCommand("aiProviderSwitcher.addCodexProvider", () => addCodexProvider()),
    vscode.commands.registerCommand("aiProviderSwitcher.removeCodexProvider", () =>
      removeCodexProvider(context)
    ),
    vscode.commands.registerCommand("aiProviderSwitcher.clearCodexApiKey", () =>
      clearCodexApiKey(context)
    ),
    vscode.commands.registerCommand("aiProviderSwitcher.refreshCodexModels", () =>
      refreshCodexModels(context)
    ),
    vscode.commands.registerCommand("aiProviderSwitcher.showCodexModels", () => showCodexModels()),
    vscode.commands.registerCommand("aiProviderSwitcher.selectCodexModel", () =>
      selectCodexModel(context)
    )
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration(CLAUDE_ENV_KEY) ||
        event.affectsConfiguration(CLAUDE_LOGIN_PROMPT_KEY) ||
        event.affectsConfiguration(`aiProviderSwitcher.${CODEX_ACTIVE_PROVIDER_KEY}`) ||
        event.affectsConfiguration(`aiProviderSwitcher.${CODEX_ACTIVE_MODEL_KEY}`)
      ) {
        void refreshStatusBar();
      }
    })
  );

  void refreshStatusBar();
}

export function deactivate(): void {
  if (statusBarItem) {
    statusBarItem.dispose();
  }
}

async function quickSwitch(context: vscode.ExtensionContext): Promise<void> {
  const selected = await vscode.window.showQuickPick(
    [
      {
        label: "$(hubot) Claude",
        description: getCurrentMode() === ProviderMode.Official ? "官方服务" : "自定义服务",
        target: "claude"
      },
      {
        label: "$(sparkle) Codex",
        description: getCodexModeLabel(),
        target: "codex"
      },
      {
        label: "$(settings-gear) 打开可视化管理界面",
        description: "集中管理所有服务与模型",
        target: "manager"
      }
    ],
    {
      title: "AI Provider Switcher"
    }
  );

  if (!selected) {
    return;
  }

  if (selected.target === "claude") await quickSwitchClaude(context);
  if (selected.target === "codex") await quickSwitchCodex(context);
  if (selected.target === "manager") openProviderManager(context);
}

async function quickSwitchClaude(context: vscode.ExtensionContext): Promise<void> {
  const current = getCurrentMode();
  const selected = await vscode.window.showQuickPick(
    [
      { label: "官方服务", description: current === ProviderMode.Official ? "当前" : "", target: "official" },
      { label: "自定义服务", description: current === ProviderMode.Gateway ? "当前" : "", target: "custom" }
    ],
    { title: "切换 Claude 服务" }
  );
  if (selected?.target === "official") await switchToOfficial();
  if (selected?.target === "custom") await switchToGateway(context);
}

async function quickSwitchCodex(context: vscode.ExtensionContext): Promise<void> {
  const selected = await vscode.window.showQuickPick(
    [
      { label: "官方服务", description: getCodexModeLabel() === "官方服务" ? "当前" : "", target: "official" },
      { label: "自定义服务", description: getCodexModeLabel() !== "官方服务" ? "当前" : "", target: "custom" }
    ],
    { title: "切换 Codex 服务" }
  );
  if (selected?.target === "official") await switchToCodexOfficial(context);
  if (selected?.target === "custom") await switchToCodexGateway(context);
}

function openProviderManager(context: vscode.ExtensionContext): void {
  ProviderManagerPanel.show(
    context.extensionUri,
    () => getProviderManagerState(),
    async (action) => handleProviderManagerAction(context, action)
  );
}

function getProviderManagerState(): ProviderManagerState {
  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  const models = new Map(getCodexModels().map((entry) => [entry.providerId, entry.models.length]));
  return {
    claudeMode: getCurrentMode() === ProviderMode.Official ? "官方服务" : "自定义服务",
    claudeProviders: getGateways().map((provider) => ({ name: provider.name, baseUrl: provider.baseUrl })),
    codexMode: getCodexModeLabel(),
    codexModel: settings.get<string>(CODEX_ACTIVE_MODEL_KEY, ""),
    codexProviders: getCodexProviders().map((provider) => ({
      name: provider.name,
      baseUrl: provider.baseUrl,
      modelCount: models.get(provider.id) ?? 0
    }))
  };
}

function getCodexModeLabel(): string {
  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  const id = settings.get<string>(CODEX_ACTIVE_PROVIDER_KEY, "");
  return getCodexProviders().find((provider) => provider.id === id)?.name ?? "官方服务";
}

async function handleProviderManagerAction(
  context: vscode.ExtensionContext,
  action: ProviderManagerAction
): Promise<void> {
  if (action === "switchClaude") await quickSwitchClaude(context);
  if (action === "manageClaude") await manageGateways(context);
  if (action === "refreshClaude") await refreshGatewayModels(context);
  if (action === "switchCodex") await switchToCodexGateway(context);
  if (action === "codexOfficial") await switchToCodexOfficial(context);
  if (action === "manageCodex") await manageCodexProviders(context);
  if (action === "refreshCodex") await refreshCodexModels(context);
  if (action === "selectCodexModel") await selectCodexModel(context);
}

function getCurrentMode(): ProviderMode {
  const envVars = getClaudeEnvVars();
  const hasGateway =
    findEnvValue(envVars, "ANTHROPIC_BASE_URL") !== undefined ||
    findEnvValue(envVars, "ANTHROPIC_AUTH_TOKEN") !== undefined;

  return hasGateway ? ProviderMode.Gateway : ProviderMode.Official;
}

async function switchToOfficial(): Promise<void> {
  const proceed = await confirmProviderSwitch("官方订阅");
  if (!proceed) return;

  const updated = getClaudeEnvVars().filter((entry) => !MANAGED_ENV_KEYS.has(entry.name));
  await updateClaudeEnvVars(updated);

  const claudeConfig = vscode.workspace.getConfiguration();
  await claudeConfig.update(CLAUDE_LOGIN_PROMPT_KEY, false, vscode.ConfigurationTarget.Global);

  await refreshStatusBar();
  await offerReload("Claude 已切换到官方订阅模式。需要重新加载 VS Code 才会让 Claude Code 使用官方订阅。是否立即重载？");
}

async function switchToGateway(context: vscode.ExtensionContext): Promise<void> {
  const gateway = await pickGateway();
  if (!gateway) {
    return;
  }

  const proceed = await confirmProviderSwitch(gateway.name);
  if (!proceed) return;

  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  const token = await getOrRequestGatewayToken(context, gateway);
  if (!token) {
    return;
  }

  const merged = mergeManagedEnvVars(getClaudeEnvVars(), gateway.baseUrl, token, settings);
  await updateClaudeEnvVars(merged);

  const disablePrompt = settings.get<boolean>("disableLoginPromptInGateway", true);
  const claudeConfig = vscode.workspace.getConfiguration();
  await claudeConfig.update(
    CLAUDE_LOGIN_PROMPT_KEY,
    disablePrompt,
    vscode.ConfigurationTarget.Global
  );

  await refreshStatusBar();
  await offerReload("Claude 已切换到网关模式。需要重新加载 VS Code 才会让 Claude Code 使用网关。是否立即重载？");
}

async function offerReload(message: string): Promise<void> {
  const choice = await vscode.window.showInformationMessage(message, "立即重载", "稍后");
  if (choice === "立即重载") {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

async function confirmProviderSwitch(target: string): Promise<boolean> {
  const choice = await vscode.window.showInformationMessage(
    `准备切换到“${target}”。本地 Claude 会话历史不会被删除，但当前对话不会自动跨服务商迁移上下文。建议切换后新建会话；是否继续？`,
    { modal: true },
    "继续切换",
    "打开会话历史",
    "取消"
  );

  if (choice === "打开会话历史") {
    await vscode.commands.executeCommand("workbench.action.chat.openSessions");
    return false;
  }
  return choice === "继续切换";
}

async function getOrRequestGatewayToken(
  context: vscode.ExtensionContext,
  gateway: GatewayProfile
): Promise<string | undefined> {
  const secretKey = `${SECRET_KEY_PREFIX}${gateway.id}`;
  const existing = await context.secrets.get(secretKey);
  if (existing) {
    return existing;
  }

  const entered = await vscode.window.showInputBox({
    title: "Input Gateway Token",
    prompt: "请输入网关 Bearer Token（不会写入 settings.json，保存在 VS Code Secret Storage）",
    password: true,
    ignoreFocusOut: true
  });

  if (!entered?.trim()) {
    vscode.window.showWarningMessage("未输入网关 Token，切换已取消。");
    return undefined;
  }

  const token = entered.trim();
  await context.secrets.store(secretKey, token);
  return token;
}

async function pickGateway(): Promise<GatewayProfile | undefined> {
  const gateways = getGateways();
  if (gateways.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      "还没有配置中转站。是否现在添加？",
      "添加中转站"
    );
    if (choice === "添加中转站") {
      return addGateway();
    }
    return undefined;
  }

  const selected = await vscode.window.showQuickPick(
    gateways.map((gateway) => ({
      label: gateway.name,
      description: gateway.baseUrl,
      gateway
    })),
    { title: "选择 Claude 中转站" }
  );
  return selected?.gateway;
}

async function manageGateways(context: vscode.ExtensionContext): Promise<void> {
  const action = await vscode.window.showQuickPick(
    [
      { label: "切换中转站", action: "switch" },
      { label: "添加中转站", action: "add" },
      { label: "删除中转站", action: "remove" },
      { label: "清除某个中转站 Token", action: "clear" },
      { label: "打开 Claude 会话历史", action: "sessions" }
    ],
    { title: "管理 Claude 中转站" }
  );

  if (!action) {
    return;
  }
  if (action.action === "switch") await switchToGateway(context);
  if (action.action === "add") await addGateway();
  if (action.action === "remove") await removeGateway(context);
  if (action.action === "clear") await clearGatewayToken(context);
  if (action.action === "sessions") await vscode.commands.executeCommand("workbench.action.chat.openSessions");
}

async function addGateway(): Promise<GatewayProfile | undefined> {
  const name = await vscode.window.showInputBox({ title: "添加中转站", prompt: "中转站名称" });
  if (!name?.trim()) return undefined;

  const baseUrl = await vscode.window.showInputBox({
    title: "添加中转站",
    prompt: "API Base URL，例如 https://example.com",
    value: "https://"
  });
  if (!baseUrl?.trim()) return undefined;

  if (!/^https?:\/\//i.test(baseUrl.trim())) {
    vscode.window.showErrorMessage("Base URL 必须以 http:// 或 https:// 开头。");
    return undefined;
  }

  const id = `${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`;
  const gateway: GatewayProfile = { id, name: name.trim(), baseUrl: normalizeProviderRootUrl(baseUrl) };
  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  await settings.update(GATEWAYS_KEY.split(".").slice(1).join("."), [...getGateways(), gateway], vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`已添加中转站：${gateway.name}`);
  return gateway;
}

async function removeGateway(context: vscode.ExtensionContext): Promise<void> {
  const gateways = getGateways();
  const selected = await vscode.window.showQuickPick(
    gateways.map((gateway) => ({ label: gateway.name, description: gateway.baseUrl, gateway })),
    { title: "删除 Claude 中转站" }
  );
  if (!selected) return;

  const confirm = await vscode.window.showWarningMessage(
    `确定删除“${selected.gateway.name}”？`,
    { modal: true },
    "删除"
  );
  if (confirm !== "删除") return;

  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  await settings.update(
    GATEWAYS_KEY.split(".").slice(1).join("."),
    gateways.filter((gateway) => gateway.id !== selected.gateway.id),
    vscode.ConfigurationTarget.Global
  );
  await context.secrets.delete(`${SECRET_KEY_PREFIX}${selected.gateway.id}`);
  vscode.window.showInformationMessage(`已删除中转站：${selected.gateway.name}`);
}

async function clearGatewayToken(context: vscode.ExtensionContext): Promise<void> {
  const gateways = getGateways();
  const selected = await vscode.window.showQuickPick(
    gateways.map((gateway) => ({ label: gateway.name, gateway })),
    { title: "清除中转站 Token" }
  );
  if (!selected) return;
  await context.secrets.delete(`${SECRET_KEY_PREFIX}${selected.gateway.id}`);
  vscode.window.showInformationMessage(`已清除“${selected.gateway.name}”的已保存 Token。`);
}

async function refreshGatewayModels(context: vscode.ExtensionContext): Promise<void> {
  const gateway = await pickGateway();
  if (!gateway) return;

  const token = await getStoredGatewayToken(context, gateway);
  if (!token) {
    vscode.window.showWarningMessage(`“${gateway.name}”尚未保存 Token，请先切换到该中转站一次。`);
    return;
  }

  try {
    const models = await requestGatewayModels(gateway.baseUrl, token);
    await saveGatewayModels(gateway.id, models);
    const choice = await vscode.window.showInformationMessage(
      `已从“${gateway.name}”刷新 ${models.length} 个模型。Claude Code 需要重载后自行更新模型发现。`,
      "立即重载",
      "查看模型"
    );
    if (choice === "立即重载") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    } else if (choice === "查看模型") {
      await showGatewayModels();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知网络错误";
    vscode.window.showErrorMessage(`刷新“${gateway.name}”的模型失败：${message}`);
  }
}

async function showGatewayModels(): Promise<void> {
  const entries = getGatewayModels();
  if (entries.length === 0) {
    vscode.window.showInformationMessage("还没有模型缓存。请先执行 AI Provider Switcher: Refresh Claude Gateway Models。");
    return;
  }

  const gateways = new Map(getGateways().map((gateway) => [gateway.id, gateway]));
  const items = entries.flatMap((entry) => {
    const gatewayName = gateways.get(entry.gatewayId)?.name ?? entry.gatewayId;
    return entry.models.map((model) => ({
      label: model,
      description: `${gatewayName} · ${entry.updatedAt}`
    }));
  });

  await vscode.window.showQuickPick(items, { title: "已缓存的 Claude 网关模型" });
}

async function getStoredGatewayToken(
  context: vscode.ExtensionContext,
  gateway: GatewayProfile
): Promise<string | undefined> {
  return context.secrets.get(`${SECRET_KEY_PREFIX}${gateway.id}`);
}

function requestGatewayModels(baseUrl: string, token: string): Promise<string[]> {
  const endpoint = new URL(`${normalizeProviderRootUrl(baseUrl)}/v1/models`);
  return new Promise((resolve, reject) => {
    const request = https.request(
      endpoint,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "anthropic-version": "2023-06-01"
        }
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new Error(`HTTP ${response.statusCode ?? "unknown"}`));
            return;
          }

          try {
            const parsed = JSON.parse(body) as { data?: Array<{ id?: unknown }> };
            const models = (parsed.data ?? [])
              .map((item) => String(item.id ?? "").trim())
              .filter(Boolean);
            resolve([...new Set(models)].sort());
          } catch {
            reject(new Error("网关返回的模型列表不是有效 JSON"));
          }
        });
      }
    );
    request.on("error", () => reject(new Error("无法连接到网关")));
    request.setTimeout(15000, () => {
      request.destroy();
      reject(new Error("请求超时"));
    });
    request.end();
  });
}

async function saveGatewayModels(gatewayId: string, models: string[]): Promise<void> {
  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  const existing = getGatewayModels().filter((entry) => entry.gatewayId !== gatewayId);
  existing.push({ gatewayId, models, updatedAt: new Date().toLocaleString() });
  await settings.update(GATEWAY_MODELS_KEY, existing, vscode.ConfigurationTarget.Global);
}

function getGatewayModels(): GatewayModels[] {
  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  const raw = settings.get<unknown>(GATEWAY_MODELS_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      gatewayId: String(item.gatewayId ?? "").trim(),
      models: Array.isArray(item.models) ? item.models.map(String).filter(Boolean) : [],
      updatedAt: String(item.updatedAt ?? "")
    }))
    .filter((entry) => entry.gatewayId && entry.models.length > 0);
}

async function switchToCodexGateway(context: vscode.ExtensionContext): Promise<void> {
  const provider = await pickCodexProvider();
  if (!provider) return;

  const proceed = await confirmCodexProviderSwitch(provider.name);
  if (!proceed) return;

  const apiKey = await getOrRequestCodexApiKey(context, provider);
  if (!apiKey) return;

  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");

  try {
    let models = getCodexModels().find((entry) => entry.providerId === provider.id)?.models ?? [];
    if (models.length === 0) {
      models = await requestCodexModels(provider.baseUrl, apiKey);
      await saveCodexModels(provider.id, models);
    }
    if (models.length === 0) {
      throw new Error("该 Provider 没有返回可用模型");
    }
    const currentModel = settings.get<string>(CODEX_ACTIVE_MODEL_KEY, "");
    const configuredDefault = settings.get<string>("codexDefaultModel", "");
    const model = models.includes(currentModel)
      ? currentModel
      : models.includes(configuredDefault)
        ? configuredDefault
        : models[0];

    await writeCodexConfiguration(context, provider, model);
    await settings.update(CODEX_ACTIVE_PROVIDER_KEY, provider.id, vscode.ConfigurationTarget.Global);
    await settings.update(CODEX_ACTIVE_MODEL_KEY, model, vscode.ConfigurationTarget.Global);
    await refreshStatusBar();
    await offerReload(
      `Codex 已切换到“${provider.name}”。已发现 ${models.length} 个模型，当前默认使用 ${model}；可稍后在管理界面更换。是否立即重载？`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    vscode.window.showErrorMessage(`切换 Codex Provider 失败：${message}`);
  }
}

async function switchToCodexOfficial(context: vscode.ExtensionContext): Promise<void> {
  const proceed = await confirmCodexProviderSwitch("OpenAI 官方 Provider");
  if (!proceed) return;

  try {
    const content = await readCodexConfiguration();
    const backup = context.globalState.get<CodexSelectionBackup>(CODEX_BACKUP_KEY);
    const withoutManagedProviders = removeManagedCodexProviders(content);
    const restored = updateTopLevelTomlKey(
      updateTopLevelTomlKey(
        withoutManagedProviders,
        "model_provider",
        backup?.hadModelProvider ? backup.modelProvider : undefined
      ),
      "model",
      backup?.hadModel ? backup.model : undefined
    );
    await writeCodexConfigurationFile(restored);

    const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
    await settings.update(CODEX_ACTIVE_PROVIDER_KEY, "", vscode.ConfigurationTarget.Global);
    await refreshStatusBar();
    await offerReload("Codex 已恢复为官方 OpenAI Provider。是否立即重载 VS Code？");
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    vscode.window.showErrorMessage(`恢复 Codex 官方 Provider 失败：${message}`);
  }
}

async function manageCodexProviders(context: vscode.ExtensionContext): Promise<void> {
  const action = await vscode.window.showQuickPick(
    [
      { label: "切换 Codex 中转站", action: "switch" },
      { label: "使用 Codex 官方 OpenAI Provider", action: "official" },
      { label: "添加 Codex 中转站", action: "add" },
      { label: "删除 Codex 中转站", action: "remove" },
      { label: "清除某个 Codex API Key", action: "clear" },
      { label: "刷新 Codex 模型", action: "refresh" },
      { label: "选择 Codex 模型", action: "model" },
      { label: "查看 Codex 模型", action: "show" }
    ],
    { title: "管理 Codex Provider" }
  );
  if (!action) return;

  if (action.action === "switch") await switchToCodexGateway(context);
  if (action.action === "official") await switchToCodexOfficial(context);
  if (action.action === "add") await addCodexProvider();
  if (action.action === "remove") await removeCodexProvider(context);
  if (action.action === "clear") await clearCodexApiKey(context);
  if (action.action === "refresh") await refreshCodexModels(context);
  if (action.action === "model") await selectCodexModel(context);
  if (action.action === "show") await showCodexModels();
}

async function addCodexProvider(): Promise<CodexProviderProfile | undefined> {
  const name = await vscode.window.showInputBox({ title: "添加 Codex Provider", prompt: "中转站名称" });
  if (!name?.trim()) return undefined;

  const baseUrl = await vscode.window.showInputBox({
    title: "添加 Codex Provider",
    prompt: "输入服务根地址，例如 https://api.example.com；不要填写 /v1，插件会按 Codex 协议自动补全",
    value: "https://"
  });
  if (!baseUrl?.trim() || !/^https?:\/\//i.test(baseUrl.trim())) {
    if (baseUrl?.trim()) vscode.window.showErrorMessage("Base URL 必须以 http:// 或 https:// 开头。");
    return undefined;
  }

  const id = `codex-${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`;
  const provider: CodexProviderProfile = {
    id,
    name: name.trim(),
    baseUrl: normalizeProviderRootUrl(baseUrl.trim())
  };
  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  await settings.update(
    CODEX_PROVIDERS_KEY,
    [...getCodexProviders(), provider],
    vscode.ConfigurationTarget.Global
  );
  vscode.window.showInformationMessage(`已添加 Codex Provider：${provider.name}`);
  return provider;
}

async function removeCodexProvider(context: vscode.ExtensionContext): Promise<void> {
  const providers = getCodexProviders();
  const selected = await vscode.window.showQuickPick(
    providers.map((provider) => ({ label: provider.name, description: provider.baseUrl, provider })),
    { title: "删除 Codex Provider" }
  );
  if (!selected) return;

  const activeId = vscode.workspace
    .getConfiguration("aiProviderSwitcher")
    .get<string>(CODEX_ACTIVE_PROVIDER_KEY, "");
  if (activeId === selected.provider.id) {
    vscode.window.showWarningMessage("当前 Codex Provider 正在使用，请先切换到官方 Provider 后再删除。");
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `确定删除“${selected.provider.name}”？`,
    { modal: true },
    "删除"
  );
  if (confirm !== "删除") return;

  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  await settings.update(
    CODEX_PROVIDERS_KEY,
    providers.filter((provider) => provider.id !== selected.provider.id),
    vscode.ConfigurationTarget.Global
  );
  await context.secrets.delete(`${CODEX_SECRET_KEY_PREFIX}${selected.provider.id}`);
  await deleteCodexApiKeyFile(selected.provider);
  vscode.window.showInformationMessage(`已删除 Codex Provider：${selected.provider.name}`);
}

async function clearCodexApiKey(context: vscode.ExtensionContext): Promise<void> {
  const selected = await pickCodexProvider();
  if (!selected) return;
  await context.secrets.delete(`${CODEX_SECRET_KEY_PREFIX}${selected.id}`);
  await deleteCodexApiKeyFile(selected);
  vscode.window.showInformationMessage(`已清除“${selected.name}”的 Codex API Key。`);
}

async function pickCodexProvider(): Promise<CodexProviderProfile | undefined> {
  const providers = getCodexProviders();
  if (providers.length === 0) {
    const choice = await vscode.window.showInformationMessage("还没有配置 Codex Provider。是否现在添加？", "添加");
    return choice === "添加" ? addCodexProvider() : undefined;
  }

  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  const activeId = settings.get<string>(CODEX_ACTIVE_PROVIDER_KEY, "");
  const selected = await vscode.window.showQuickPick(
    providers.map((provider) => ({
      label: provider.name,
      description: `${provider.baseUrl}${provider.id === activeId ? " · 当前" : ""}`,
      provider
    })),
    { title: "选择 Codex Provider" }
  );
  return selected?.provider;
}

async function confirmCodexProviderSwitch(target: string): Promise<boolean> {
  const choice = await vscode.window.showInformationMessage(
    `准备切换到“${target}”。Codex 本地会话历史不会被删除，但当前对话不会自动迁移到新的 Provider 或模型。是否继续？`,
    { modal: true },
    "继续切换",
    "取消"
  );
  return choice === "继续切换";
}

async function getOrRequestCodexApiKey(
  context: vscode.ExtensionContext,
  provider: CodexProviderProfile
): Promise<string | undefined> {
  const secretKey = `${CODEX_SECRET_KEY_PREFIX}${provider.id}`;
  const existing = await context.secrets.get(secretKey);
  if (existing) {
    await writeCodexApiKeyFile(provider, existing);
    return existing;
  }

  const entered = await vscode.window.showInputBox({
    title: `输入 ${provider.name} 的 Codex API Key`,
    prompt: "只保存在 VS Code Secret Storage 和 Windows DPAPI 加密文件中，不会写入 settings.json",
    password: true,
    ignoreFocusOut: true
  });
  if (!entered?.trim()) {
    vscode.window.showWarningMessage("未输入 Codex API Key，切换已取消。");
    return undefined;
  }

  const apiKey = entered.trim();
  await context.secrets.store(secretKey, apiKey);
  await writeCodexApiKeyFile(provider, apiKey);
  return apiKey;
}

async function refreshCodexModels(context: vscode.ExtensionContext): Promise<void> {
  const provider = await pickCodexProvider();
  if (!provider) return;

  const apiKey = await getStoredCodexApiKey(context, provider);
  if (!apiKey) {
    vscode.window.showWarningMessage(`“${provider.name}”尚未保存 API Key，请先切换到该 Provider。`);
    return;
  }

  try {
    const models = await requestCodexModels(provider.baseUrl, apiKey);
    await saveCodexModels(provider.id, models);
    const choice = await vscode.window.showInformationMessage(
      `已从“${provider.name}”刷新 ${models.length} 个 Codex 模型。`,
      "查看模型",
      "关闭"
    );
    if (choice === "查看模型") await showCodexModels(provider.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知网络错误";
    vscode.window.showErrorMessage(`刷新“${provider.name}”的 Codex 模型失败：${message}`);
  }
}

async function selectCodexModel(context: vscode.ExtensionContext): Promise<void> {
  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  const activeId = settings.get<string>(CODEX_ACTIVE_PROVIDER_KEY, "");
  if (!activeId) {
    vscode.window.showInformationMessage("当前是 Codex 官方 Provider。请先切换到 Codex 中转站。 ");
    return;
  }

  const provider = getCodexProviders().find((item) => item.id === activeId);
  const models = getCodexModels().find((entry) => entry.providerId === activeId)?.models ?? [];
  if (!provider || models.length === 0) {
    vscode.window.showInformationMessage("还没有缓存模型，请先执行 AI Provider Switcher: Refresh Codex Models。");
    return;
  }

  const selected = await vscode.window.showQuickPick(
    models.map((model) => ({ label: model, model })),
    { title: `选择 ${provider.name} 的 Codex 模型` }
  );
  if (!selected) return;

  try {
    await writeCodexConfiguration(context, provider, selected.model);
    await settings.update(CODEX_ACTIVE_MODEL_KEY, selected.model, vscode.ConfigurationTarget.Global);
    await offerReload(`Codex 模型已切换为 ${selected.model}。是否立即重载 VS Code？`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    vscode.window.showErrorMessage(`切换 Codex 模型失败：${message}`);
  }
}

async function showCodexModels(providerId?: string): Promise<void> {
  const entries = getCodexModels().filter((entry) => !providerId || entry.providerId === providerId);
  if (entries.length === 0) {
    vscode.window.showInformationMessage("还没有 Codex 模型缓存，请先刷新模型。 ");
    return;
  }
  const providers = new Map(getCodexProviders().map((provider) => [provider.id, provider]));
  const items = entries.flatMap((entry) => {
    const providerName = providers.get(entry.providerId)?.name ?? entry.providerId;
    return entry.models.map((model) => ({ label: model, description: `${providerName} · ${entry.updatedAt}` }));
  });
  await vscode.window.showQuickPick(items, { title: "已缓存的 Codex 模型", canPickMany: false });
}

async function getStoredCodexApiKey(
  context: vscode.ExtensionContext,
  provider: CodexProviderProfile
): Promise<string | undefined> {
  return context.secrets.get(`${CODEX_SECRET_KEY_PREFIX}${provider.id}`);
}

function requestCodexModels(baseUrl: string, token: string): Promise<string[]> {
  const endpoint = new URL(`${getCodexApiBaseUrl(baseUrl)}/models`);
  return new Promise((resolve, reject) => {
    const request = https.request(
      endpoint,
      {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` }
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
            reject(new Error(`HTTP ${response.statusCode ?? "unknown"}`));
            return;
          }
          try {
            const parsed = JSON.parse(body) as { data?: Array<{ id?: unknown }> };
            const models = (parsed.data ?? [])
              .map((item) => String(item.id ?? "").trim())
              .filter(Boolean);
            resolve([...new Set(models)].sort());
          } catch {
            reject(new Error("网关返回的 Codex 模型列表不是有效 JSON"));
          }
        });
      }
    );
    request.on("error", () => reject(new Error("无法连接到 Codex 网关")));
    request.setTimeout(15000, () => {
      request.destroy();
      reject(new Error("请求超时"));
    });
    request.end();
  });
}

async function saveCodexModels(providerId: string, models: string[]): Promise<void> {
  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  const existing = getCodexModels().filter((entry) => entry.providerId !== providerId);
  existing.push({ providerId, models, updatedAt: new Date().toLocaleString() });
  await settings.update(CODEX_MODELS_KEY, existing, vscode.ConfigurationTarget.Global);
}

function getCodexModels(): CodexModels[] {
  const raw = vscode.workspace
    .getConfiguration("aiProviderSwitcher")
    .get<unknown>(CODEX_MODELS_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      providerId: String(item.providerId ?? "").trim(),
      models: Array.isArray(item.models) ? item.models.map(String).filter(Boolean) : [],
      updatedAt: String(item.updatedAt ?? "")
    }))
    .filter((entry) => entry.providerId && entry.models.length > 0);
}

function getCodexProviders(): CodexProviderProfile[] {
  const raw = vscode.workspace
    .getConfiguration("aiProviderSwitcher")
    .get<unknown>(CODEX_PROVIDERS_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      id: String(item.id ?? "").trim(),
      name: String(item.name ?? "").trim(),
      baseUrl: normalizeProviderRootUrl(String(item.baseUrl ?? "").trim())
    }))
    .filter((provider) => provider.id && provider.name && provider.baseUrl);
}

type CodexSelectionBackup = {
  hadModel: boolean;
  model?: string;
  hadModelProvider: boolean;
  modelProvider?: string;
};

async function writeCodexConfiguration(
  context: vscode.ExtensionContext,
  provider: CodexProviderProfile,
  model: string
): Promise<void> {
  const content = await readCodexConfiguration();
  if (!context.globalState.get<CodexSelectionBackup>(CODEX_BACKUP_KEY)) {
    await context.globalState.update(CODEX_BACKUP_KEY, {
      hadModel: parseTopLevelTomlString(content, "model") !== undefined,
      model: parseTopLevelTomlString(content, "model"),
      hadModelProvider: parseTopLevelTomlString(content, "model_provider") !== undefined,
      modelProvider: parseTopLevelTomlString(content, "model_provider")
    } satisfies CodexSelectionBackup);
  }

  await ensureCodexAuthHelper();
  const providers = getCodexProviders();
  let updated = removeManagedCodexProviders(content);
  updated = updateTopLevelTomlKey(updated, "model_provider", provider.id);
  updated = updateTopLevelTomlKey(updated, "model", model);
  updated = `${updated.trimEnd()}\n\n${serializeManagedCodexProviders(providers)}\n`;
  await writeCodexConfigurationFile(updated);
}

async function readCodexConfiguration(): Promise<string> {
  try {
    return await fs.readFile(CODEX_CONFIG_FILE, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "";
    throw error;
  }
}

async function writeCodexConfigurationFile(content: string): Promise<void> {
  await fs.mkdir(path.dirname(CODEX_CONFIG_FILE), { recursive: true });
  await fs.writeFile(CODEX_CONFIG_FILE, content, "utf8");
}

function serializeManagedCodexProviders(providers: CodexProviderProfile[]): string {
  const providerBlocks = providers.map((provider) => {
    const keyFile = getCodexApiKeyFile(provider);
    return [
      `[model_providers.${JSON.stringify(provider.id)}]`,
      `name = ${JSON.stringify(provider.name)}`,
      `base_url = ${JSON.stringify(getCodexApiBaseUrl(provider.baseUrl))}`,
      `wire_api = "responses"`,
      ``,
      `[model_providers.${JSON.stringify(provider.id)}.auth]`,
      `command = "powershell.exe"`,
      `args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ${JSON.stringify(
        CODEX_AUTH_HELPER_FILE
      )}, ${JSON.stringify(keyFile)}]`
    ].join("\n");
  });
  return [CODEX_MANAGED_BEGIN, ...providerBlocks, CODEX_MANAGED_END].join("\n");
}

const CODEX_AUTH_HELPER_FILE = path.join(os.homedir(), ".codex", "ai-provider-switcher-codex-auth.ps1");

async function ensureCodexAuthHelper(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("当前 Codex 密钥安全桥接实现只支持 Windows。");
  }
  await fs.mkdir(path.dirname(CODEX_AUTH_HELPER_FILE), { recursive: true });
  const helper = [
    "$ErrorActionPreference = 'Stop'",
    "$encrypted = Get-Content -Raw -LiteralPath $args[0]",
    "$secure = ConvertTo-SecureString -String $encrypted",
    "$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)",
    "try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }",
    "finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }"
  ].join("\r\n");
  await fs.writeFile(CODEX_AUTH_HELPER_FILE, helper, "utf8");
}

async function writeCodexApiKeyFile(provider: CodexProviderProfile, apiKey: string): Promise<void> {
  await ensureCodexAuthHelper();
  const keyFile = getCodexApiKeyFile(provider);
  await fs.mkdir(path.dirname(keyFile), { recursive: true });
  const escapedPath = keyFile.replace(/'/g, "''");
  const command =
    `$token = [Console]::In.ReadToEnd(); ` +
    `$token | ConvertTo-SecureString -AsPlainText -Force | ` +
    `ConvertFrom-SecureString | Set-Content -LiteralPath '${escapedPath}' -Encoding ASCII`;
  await runPowerShell(command, apiKey);
}

async function deleteCodexApiKeyFile(provider: CodexProviderProfile): Promise<void> {
  try {
    await fs.unlink(getCodexApiKeyFile(provider));
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}

function getCodexApiKeyFile(provider: CodexProviderProfile): string {
  const safeId = provider.id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(os.homedir(), ".codex", `ai-provider-switcher-codex-${safeId}.key`);
}

function runPowerShell(command: string, input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      command
    ]);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", () => reject(new Error("无法启动 PowerShell 安全存储过程")));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || "无法写入 Codex API Key 安全文件"));
    });
    child.stdin.end(input, "utf8");
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function getGateways(): GatewayProfile[] {
  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  const raw = settings.get<unknown>("gateways", []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      id: String(item.id ?? "").trim(),
      name: String(item.name ?? "").trim(),
      baseUrl: String(item.baseUrl ?? "").trim().replace(/\/$/, "")
    }))
    .filter((gateway) => gateway.id && gateway.name && gateway.baseUrl);
}

function mergeManagedEnvVars(
  existing: EnvVar[],
  baseUrl: string,
  token: string,
  settings: vscode.WorkspaceConfiguration
): EnvVar[] {
  const keep = existing.filter((entry) => !MANAGED_ENV_KEYS.has(entry.name));

  keep.push({ name: "ANTHROPIC_BASE_URL", value: baseUrl });
  keep.push({ name: "ANTHROPIC_AUTH_TOKEN", value: token });

  if (settings.get<boolean>("enableGatewayDiscovery", true)) {
    keep.push({ name: "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", value: "1" });
  }

  if (settings.get<boolean>("setAttributionHeaderZero", true)) {
    keep.push({ name: "CLAUDE_CODE_ATTRIBUTION_HEADER", value: "0" });
  }

  return keep;
}

function getClaudeEnvVars(): EnvVar[] {
  const claudeConfig = vscode.workspace.getConfiguration();
  const raw = claudeConfig.get<unknown>(CLAUDE_ENV_KEY, []);
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((item): item is { name?: unknown; value?: unknown } => typeof item === "object" && item !== null)
    .map((item) => ({
      name: String(item.name ?? "").trim(),
      value: String(item.value ?? "")
    }))
    .filter((item) => item.name.length > 0);
}

async function updateClaudeEnvVars(envVars: EnvVar[]): Promise<void> {
  const claudeConfig = vscode.workspace.getConfiguration();
  await claudeConfig.update(CLAUDE_ENV_KEY, envVars, vscode.ConfigurationTarget.Global);
}

function findEnvValue(envVars: EnvVar[], key: string): string | undefined {
  return envVars.find((entry) => entry.name === key)?.value;
}

async function refreshStatusBar(): Promise<void> {
  const mode = getCurrentMode();
  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  const codexProviderId = settings.get<string>(CODEX_ACTIVE_PROVIDER_KEY, "");
  const codexProvider = getCodexProviders().find((provider) => provider.id === codexProviderId);
  const codexModel = settings.get<string>(CODEX_ACTIVE_MODEL_KEY, "");
  const claudeLabel = mode === ProviderMode.Gateway ? "Claude: Gateway" : "Claude: Official";
  const codexLabel = codexProvider
    ? `Codex: ${codexProvider.name}${codexModel ? `/${codexModel}` : ""}`
    : "Codex: Official";
  statusBarItem.text = `${claudeLabel} · ${codexLabel}`;
  statusBarItem.tooltip = "打开 AI Provider Switcher 可视化管理界面";
  statusBarItem.show();
}
