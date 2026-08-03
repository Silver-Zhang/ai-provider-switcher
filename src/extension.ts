import * as vscode from "vscode";
import * as https from "node:https";
import { IncomingHttpHeaders } from "node:http";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { URL } from "node:url";
import {
  CODEX_MANAGED_BEGIN,
  CODEX_MANAGED_END,
  createCodexAuthConfig,
  createCodexModelCatalog,
  findUnmanagedCodexProxyEnv,
  getCodexApiBaseUrl,
  normalizeCodexProxyUrl,
  normalizeProviderRootUrl,
  parseMacOsProxySettings,
  parseWindowsProxyServer,
  parseTopLevelTomlString,
  removeManagedCodexEnv,
  removeManagedCodexProviders,
  removeUnmanagedCodexProxyEnv,
  updateManagedCodexEnv,
  updateTopLevelTomlKey
} from "./codexConfig";
import {
  ProviderManagerAction,
  ProviderManagerMessage,
  ProviderManagerPanel,
  ProviderManagerState
} from "./providerManagerPanel";
import {
  ProviderUsageConfiguration,
  ProviderUsageSnapshot,
  formatProviderUsageSummary,
  hasProviderUsage,
  normalizeUsageConfiguration,
  parseProviderUsage,
  requestProviderUsage,
  validateUsageEndpoint
} from "./providerUsage";
import {
  ClaudeModelMapping,
  ClaudePermissionStrategy,
  ClaudeConfigurationFinding,
  CLAUDE_MODEL_ENV_NAMES,
  CLAUDE_PROVIDER_ENV_NAMES,
  DEEPSEEK_CLAUDE_MODEL_ENV_NAMES,
  createClaudeModelEnvironment,
  createClaudeModelMapping,
  findClaudeProviderByEnvironment,
  getDeepSeekClaudeModelMapping,
  hasNonClaudeModelIds,
  inspectClaudeEnvironment,
  inspectClaudeSettingsJson,
  isDeepSeekAnthropicApi,
  isClaudeAutoClassifierCompatible,
  normalizeClaudeModelMapping,
  normalizeClaudePermissionStrategy,
  normalizeClaudeProviderBaseUrl,
  stripClaudeProviderSettingsJson
} from "./claudeConfig";

type EnvVar = { name: string; value: string };
type GatewayProfile = {
  id: string;
  name: string;
  baseUrl: string;
  modelMapping?: ClaudeModelMapping;
  permissionStrategy?: ClaudePermissionStrategy;
  usage?: ProviderUsageConfiguration;
};
type GatewayModels = { gatewayId: string; models: string[]; updatedAt: string };
type CodexProviderProfile = { id: string; name: string; baseUrl: string; usage?: ProviderUsageConfiguration };
type CodexModels = { providerId: string; models: string[]; updatedAt: string };

enum ProviderMode {
  Official = "Official",
  Gateway = "Gateway"
}

const SECRET_KEY_PREFIX = "aiProviderSwitcher.claude.gatewayAuthToken.";
const CLAUDE_ENV_KEY = "claudeCode.environmentVariables";
const CLAUDE_LOGIN_PROMPT_KEY = "claudeCode.disableLoginPrompt";
const CLAUDE_INITIAL_PERMISSION_MODE_KEY = "claudeCode.initialPermissionMode";
const CLAUDE_ALLOW_BYPASS_KEY = "claudeCode.allowDangerouslySkipPermissions";
const GATEWAYS_KEY = "aiProviderSwitcher.gateways";
const GATEWAY_MODELS_KEY = "gatewayModels";
const CLAUDE_ACTIVE_PROVIDER_KEY = "claudeActiveProviderId";
const CODEX_SECRET_KEY_PREFIX = "aiProviderSwitcher.codex.apiKey.";
const CODEX_PROVIDERS_KEY = "codexProviders";
const CODEX_MODELS_KEY = "codexModels";
const CODEX_ACTIVE_PROVIDER_KEY = "codexActiveProviderId";
const CODEX_ACTIVE_MODEL_KEY = "codexActiveModel";
const CODEX_CONFIG_FILE = path.join(os.homedir(), ".codex", "config.toml");
const CODEX_MODEL_CATALOG_FILE = path.join(os.homedir(), ".codex", "ai-provider-switcher-models.json");
const CODEX_ENV_FILE = path.join(os.homedir(), ".codex", ".env");
const CODEX_BACKUP_KEY = "codex.originalTopLevelConfig";
const CODEX_PROXY_URL_KEY = "codexProxyUrl";
const CODEX_PROXY_MODE_KEY = "codexProxyMode";
const PROVIDER_USAGE_SNAPSHOTS_KEY = "providerUsageSnapshots";

type CodexProxyMode = "officialOnly" | "allProviders";

const MANAGED_ENV_KEYS = new Set([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
  "CLAUDE_CODE_ATTRIBUTION_HEADER",
  ...DEEPSEEK_CLAUDE_MODEL_ENV_NAMES,
  ...CLAUDE_PROVIDER_ENV_NAMES
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
    vscode.commands.registerCommand("aiProviderSwitcher.configureClaudeModelMapping", () =>
      configureClaudeModelMapping(context)
    ),
    vscode.commands.registerCommand("aiProviderSwitcher.configureClaudePermissions", () =>
      configureClaudePermissionStrategy()
    ),
    vscode.commands.registerCommand("aiProviderSwitcher.inspectClaudeConfiguration", () =>
      inspectClaudeConfiguration()
    ),
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
    vscode.commands.registerCommand("aiProviderSwitcher.configureCodexProxy", () =>
      configureCodexProxy()
    ),
    vscode.commands.registerCommand("aiProviderSwitcher.refreshProviderUsage", () =>
      refreshProviderUsage(context)
    ),
    vscode.commands.registerCommand("aiProviderSwitcher.configureProviderUsage", () =>
      configureProviderUsage(context)
    )
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration(CLAUDE_ENV_KEY) ||
        event.affectsConfiguration(CLAUDE_LOGIN_PROMPT_KEY) ||
        event.affectsConfiguration(GATEWAYS_KEY) ||
        event.affectsConfiguration(`aiProviderSwitcher.${CLAUDE_ACTIVE_PROVIDER_KEY}`) ||
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
  const claudeProvider = getCurrentClaudeProvider();
  const selected = await vscode.window.showQuickPick(
    [
      {
        label: "$(hubot) Claude",
        description: claudeProvider?.name ?? (getCurrentMode() === ProviderMode.Official ? "官方服务" : "未识别的自定义服务"),
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
  const currentProvider = getCurrentClaudeProvider();
  const items: Array<{
    label: string;
    description: string;
    target: "official" | "custom";
    gateway?: GatewayProfile;
  }> = [
    { label: "官方服务", description: current === ProviderMode.Official ? "当前" : "", target: "official" },
    ...getGateways().map((gateway) => ({
        label: gateway.name,
        description: gateway.id === currentProvider?.id ? `当前 · ${gateway.baseUrl}` : gateway.baseUrl,
        target: "custom" as const,
        gateway
    }))
  ];
  const selected = await vscode.window.showQuickPick(items, { title: "切换 Claude 服务" });
  if (selected?.target === "official") await switchToOfficial();
  if (selected?.target === "custom") await switchToGateway(context, selected.gateway);
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
    async (message) => handleProviderManagerAction(context, message)
  );
}

function getProviderManagerState(): ProviderManagerState {
  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  const models = new Map(getCodexModels().map((entry) => [entry.providerId, entry.models.length]));
  const usage = new Map(getProviderUsageSnapshots().map((entry) => [`${entry.providerKind}:${entry.providerId}`, entry]));
  const currentClaudeProvider = getCurrentClaudeProvider();
  return {
    claudeMode: currentClaudeProvider?.name ?? (getCurrentMode() === ProviderMode.Official ? "官方服务" : "未识别的自定义服务"),
    claudeProviders: getGateways().map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      active: provider.id === currentClaudeProvider?.id,
      mapping: provider.modelMapping
        ? `${provider.modelMapping.mainModel} / 快速：${provider.modelMapping.haikuModel}${provider.modelMapping.supports1m ? " / 1M" : ""}`
        : "未配置",
      permissionStrategy: getClaudePermissionStrategyLabel(provider.permissionStrategy),
      hasUsageConfig: Boolean(provider.usage),
      usageEndpoint: provider.usage?.endpoint,
      usageMappings: formatUsageMappings(provider.usage),
      usage: formatProviderUsageSummary(usage.get(`claude:${provider.id}`))
    })),
    codexMode: getCodexModeLabel(),
    codexModel: settings.get<string>(CODEX_ACTIVE_MODEL_KEY, ""),
    codexProviders: getCodexProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      modelCount: models.get(provider.id) ?? 0,
      hasUsageConfig: Boolean(provider.usage),
      usageEndpoint: provider.usage?.endpoint,
      usageMappings: formatUsageMappings(provider.usage),
      usage: formatProviderUsageSummary(usage.get(`codex:${provider.id}`))
    }))
  };
}

function getCodexModeLabel(): string {
  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  const id = settings.get<string>(CODEX_ACTIVE_PROVIDER_KEY, "");
  return getCodexProviders().find((provider) => provider.id === id)?.name ?? "官方服务";
}

function getUsageProviderById(
  kind: "claude" | "codex",
  id: string
): UsageProviderSelection | undefined {
  const provider = kind === "claude"
    ? getGateways().find((item) => item.id === id)
    : getCodexProviders().find((item) => item.id === id);
  return provider ? { kind, provider } : undefined;
}

function formatUsageMappings(usage: ProviderUsageConfiguration | undefined): string | undefined {
  if (!usage) return undefined;
  const fields = [
    ["余额", usage.balanceRemainingPath],
    ["5小时", usage.fiveHourUsedPercentPath],
    ["周", usage.weeklyUsedPercentPath]
  ].filter(([, path]) => path).map(([label, path]) => `${label}=${path}`);
  return fields.length ? fields.join(" · ") : "自动识别字段";
}

async function handleProviderManagerAction(
  context: vscode.ExtensionContext,
  message: ProviderManagerMessage
): Promise<void> {
  const action = message.action;
  if (!action) return;
  const targeted = message.providerKind && message.providerId
    ? getUsageProviderById(message.providerKind, message.providerId)
    : undefined;
  if (action === "refreshUsage" && targeted) {
    await refreshSelectedProviderUsage(targeted, context);
    return;
  }
  if (action === "viewUsageConfig" && targeted) {
    await showProviderUsageDetails(targeted);
    return;
  }
  if (action === "editUsageConfig" && targeted) {
    await configureProviderUsageForSelection(context, targeted);
    return;
  }
  if (action === "deleteUsageConfig" && targeted) {
    await deleteProviderUsageConfiguration(targeted);
    return;
  }
  if (action === "configureUsage" && targeted) {
    await configureProviderUsageForSelection(context, targeted);
    return;
  }
  if (action === "switchClaude") {
    const provider = message.providerKind === "claude" ? getGateways().find((item) => item.id === message.providerId) : undefined;
    await switchToGateway(context, provider);
  }
  if (action === "claudeOfficial") await switchToOfficial();
  if (action === "manageClaude") await manageGateways(context);
  if (action === "inspectClaude") await inspectClaudeConfiguration();
  if (action === "refreshClaude") await refreshGatewayModels(context, message.providerKind === "claude" ? getGateways().find((item) => item.id === message.providerId) : undefined);
  if (action === "mapClaudeModels") await configureClaudeModelMapping(context, message.providerKind === "claude" ? getGateways().find((item) => item.id === message.providerId) : undefined);
  if (action === "configureClaudePermissions") await configureClaudePermissionStrategy(message.providerKind === "claude" ? getGateways().find((item) => item.id === message.providerId) : undefined);
  if (action === "switchCodex") {
    const provider = message.providerKind === "codex" ? getCodexProviders().find((item) => item.id === message.providerId) : undefined;
    await switchToCodexGateway(context, provider);
  }
  if (action === "codexOfficial") await switchToCodexOfficial(context);
  if (action === "manageCodex") await manageCodexProviders(context);
  if (action === "refreshCodex") await refreshCodexModels(context, message.providerKind === "codex" ? getCodexProviders().find((item) => item.id === message.providerId) : undefined);
  if (action === "configureCodexProxy") await configureCodexProxy();
  if (action === "refreshUsage") await refreshProviderUsage(context);
  if (action === "configureUsage") await configureProviderUsage(context);
  if (action === "manageUsage") await manageProviderUsage(context);
  if (action === "openCodex") await vscode.commands.executeCommand("chatgpt.openSidebar");
}

function getCurrentMode(): ProviderMode {
  const envVars = getClaudeEnvVars();
  const hasGateway =
    Boolean(findEnvValue(envVars, "ANTHROPIC_BASE_URL")?.trim()) ||
    Boolean(findEnvValue(envVars, "ANTHROPIC_AUTH_TOKEN")?.trim());

  return hasGateway ? ProviderMode.Gateway : ProviderMode.Official;
}

async function switchToOfficial(): Promise<void> {
  const proceed = await confirmProviderSwitch("官方订阅");
  if (!proceed) return;

  const conflicts = await findClaudeConfigurationConflicts();
  const blockingConflicts = conflicts.filter(isBlockingClaudeConfigurationFinding);
  if (blockingConflicts.length > 0) {
    const conflictsResolved = await guideClaudeConfigurationConflicts(
      "官方订阅",
      blockingConflicts,
      conflicts
    );
    if (!conflictsResolved) return;
  }

  const updated = clearClaudeProviderEnvVars(getClaudeEnvVars());
  await updateClaudeEnvVars(updated);

  const claudeConfig = vscode.workspace.getConfiguration();
  await claudeConfig.update(CLAUDE_LOGIN_PROMPT_KEY, false, vscode.ConfigurationTarget.Global);
  await vscode.workspace
    .getConfiguration("aiProviderSwitcher")
    .update(CLAUDE_ACTIVE_PROVIDER_KEY, "", vscode.ConfigurationTarget.Global);
  try {
    await applyClaudePermissionStrategy("manual");
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知配置错误";
    vscode.window.showWarningMessage(`已切换 Claude 官方服务，但无法恢复手动命令策略：${message}`);
  }

  await refreshStatusBar();
  await offerReload("Claude 已切换到官方订阅模式。需要重新加载 VS Code 才会让 Claude Code 使用官方订阅。是否立即重载？");
}

async function switchToGateway(
  context: vscode.ExtensionContext,
  selectedGateway?: GatewayProfile
): Promise<void> {
  const gateway = selectedGateway ?? await pickGateway();
  if (!gateway) {
    return;
  }

  const proceed = await confirmProviderSwitch(gateway.name);
  if (!proceed) return;

  const conflicts = await findClaudeConfigurationConflicts(gateway);
  const blockingConflicts = conflicts.filter(isBlockingClaudeConfigurationFinding);
  if (blockingConflicts.length > 0) {
    const conflictsResolved = await guideClaudeConfigurationConflicts(
      gateway.name,
      blockingConflicts,
      conflicts
    );
    if (!conflictsResolved) return;
  }

  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  const token = await getOrRequestGatewayToken(context, gateway);
  if (!token) {
    return;
  }

  let merged = mergeManagedEnvVars(getClaudeEnvVars(), gateway.baseUrl, token, settings);
  let modelMapping = gateway.modelMapping;
  if (!modelMapping && isDeepSeekAnthropicApi(gateway.baseUrl)) {
    modelMapping = getDeepSeekClaudeModelMapping();
    await updateGatewayProfile({ ...gateway, modelMapping });
  }
  if (!modelMapping) {
    const mappingDecision = await offerModelMappingForGateway(context, gateway, token);
    if (!mappingDecision.proceed) return;
    modelMapping = mappingDecision.mapping;
  }
  const permissionStrategy = gateway.permissionStrategy ?? await chooseClaudePermissionStrategy(
    gateway,
    getGatewayModels().find((entry) => entry.gatewayId === gateway.id)?.models ?? []
  );
  if (!permissionStrategy) return;
  if (permissionStrategy !== gateway.permissionStrategy) {
    gateway.permissionStrategy = permissionStrategy;
    await updateGatewayProfile({ ...gateway, modelMapping, permissionStrategy });
  }
  if (modelMapping) {
    merged = removeClaudeModelEnvironment(merged);
    merged.push(...createClaudeModelEnvironment(modelMapping));
  }
  await updateClaudeEnvVars(merged);

  const disablePrompt = settings.get<boolean>("disableLoginPromptInGateway", true);
  const claudeConfig = vscode.workspace.getConfiguration();
  await claudeConfig.update(
    CLAUDE_LOGIN_PROMPT_KEY,
    disablePrompt,
    vscode.ConfigurationTarget.Global
  );
  await settings.update(CLAUDE_ACTIVE_PROVIDER_KEY, gateway.id, vscode.ConfigurationTarget.Global);
  try {
    await applyClaudePermissionStrategy(permissionStrategy);
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知配置错误";
    vscode.window.showErrorMessage(`Provider 已写入，但命令策略配置失败：${message}`);
    return;
  }

  await refreshStatusBar();
  if (modelMapping && !isDeepSeekAnthropicApi(gateway.baseUrl)) {
    vscode.window.showWarningMessage(
      "已应用 Provider 模型映射，Claude 的主会话、模型族、后台任务和子代理将使用映射后的模型。Auto 模式仍需 Provider 支持独立安全分类请求；若分类器不可用，请改用“编辑自动接受”或“手动”模式，不要放宽为 Bash(*)。"
    );
  } else if (isDeepSeekAnthropicApi(gateway.baseUrl)) {
    vscode.window.showInformationMessage(
      "已应用 DeepSeek 官方模型映射。Auto 模式需要额外的安全分类请求；若该请求不可用，请切换到“编辑自动接受”或“手动”模式。"
    );
  }
  await offerReload(`Claude 已切换到“${gateway.name}”。需要重新加载 VS Code 才会让 Claude Code 使用该服务。是否立即重载？`);
}

async function chooseClaudePermissionStrategy(
  gateway: GatewayProfile,
  models: string[]
): Promise<ClaudePermissionStrategy | undefined> {
  const classifierCompatible = isClaudeAutoClassifierCompatible(models);
  const selected = await vscode.window.showQuickPick([
    {
      label: classifierCompatible ? "Auto（服务声明 Sonnet 5）" : "Auto（可能阻塞）",
      description: classifierCompatible
        ? "每条未预先放行的命令由独立 Sonnet 5 分类器判断；临时容量故障仍会阻塞"
        : "该服务未发现 claude-sonnet-5；分类器可能反复提示 temporarily unavailable",
      strategy: "auto" as const
    },
    {
      label: "编辑自动接受（推荐）",
      description: "文件编辑和常见文件命令自动执行；其他命令需要手动确认，不依赖 Auto 分类器",
      strategy: "acceptEdits" as const
    },
    {
      label: "手动确认",
      description: "每个非只读操作都由用户确认，不依赖 Auto 分类器",
      strategy: "manual" as const
    },
    {
      label: "完全放行（危险）",
      description: "启用 bypassPermissions：不走分类器、不弹常规确认，可执行删除、强推等破坏性操作",
      strategy: "bypassPermissions" as const
    }
  ], {
    title: `选择“${gateway.name}”的命令执行策略`,
    placeHolder: classifierCompatible
      ? "Auto 可用仍不等于所有命令都放行；要真正全部放行只能使用 bypassPermissions"
      : "自定义中转站无法保证 Auto 的固定 Sonnet 5 分类器可用，推荐编辑自动接受"
  });
  if (!selected) return undefined;

  if (selected.strategy === "bypassPermissions") {
    const confirm = await vscode.window.showWarningMessage(
      "完全放行会跳过 Claude Code 的 Auto 分类器和常规权限确认。Claude 可直接执行 rm -rf、git reset --hard、force push、上传数据等命令。仅应在可丢弃、无敏感凭据且最好断网的容器或虚拟机中使用。",
      { modal: true },
      "我确认环境已隔离，完全放行",
      "取消"
    );
    if (confirm !== "我确认环境已隔离，完全放行") return undefined;
  }
  return selected.strategy;
}

async function applyClaudePermissionStrategy(strategy: ClaudePermissionStrategy): Promise<void> {
  const configuration = vscode.workspace.getConfiguration();
  const initialMode = strategy === "auto"
    ? undefined
    : strategy === "manual" ? "manual" : strategy;
  await updateClaudeUserDefaultPermissionMode(
    strategy === "auto" ? "auto" : strategy === "acceptEdits" ? "acceptEdits" : "manual"
  );
  await configuration.update(
    CLAUDE_INITIAL_PERMISSION_MODE_KEY,
    initialMode,
    vscode.ConfigurationTarget.Global
  );
  await configuration.update(
    CLAUDE_ALLOW_BYPASS_KEY,
    strategy === "bypassPermissions",
    vscode.ConfigurationTarget.Global
  );
  if (strategy === "auto") {
    vscode.window.showInformationMessage(
      "已保留 Auto 策略。Auto 的独立分类器固定优先使用 Claude Sonnet 5；模型族映射不能改写这次探测。若仍出现 temporarily unavailable，请改用编辑自动接受、手动或隔离环境下的完全放行。"
    );
  }
}

async function updateClaudeUserDefaultPermissionMode(
  mode: "auto" | "acceptEdits" | "manual"
): Promise<void> {
  const file = path.join(os.homedir(), ".claude", "settings.json");
  let original = "{}\n";
  let existed = true;
  try {
    original = await fs.readFile(file, "utf8");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    existed = false;
  }
  const parsed = JSON.parse(original) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Claude 用户 settings.json 的根节点不是对象，无法安全设置权限模式");
  }
  const settings = parsed as Record<string, unknown>;
  const permissions = settings.permissions && typeof settings.permissions === "object" &&
    !Array.isArray(settings.permissions)
    ? settings.permissions as Record<string, unknown>
    : {};
  if (permissions.defaultMode === mode) return;
  permissions.defaultMode = mode;
  settings.permissions = permissions;
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (existed) {
    await fs.copyFile(file, `${file}.ai-provider-switcher-${formatBackupTimestamp()}.bak`);
  }
  await fs.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

async function configureClaudePermissionStrategy(selectedGateway?: GatewayProfile): Promise<void> {
  const gateway = selectedGateway ?? await pickGateway();
  if (!gateway) return;
  const models = getGatewayModels().find((entry) => entry.gatewayId === gateway.id)?.models ?? [];
  const strategy = await chooseClaudePermissionStrategy(gateway, models);
  if (!strategy) return;
  await updateGatewayProfile({ ...gateway, permissionStrategy: strategy });
  if (getCurrentClaudeProvider()?.id === gateway.id) {
    try {
      await applyClaudePermissionStrategy(strategy);
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知配置错误";
      vscode.window.showErrorMessage(`无法应用命令策略：${message}`);
      return;
    }
    await offerReload(`已将“${gateway.name}”的命令策略改为“${getClaudePermissionStrategyLabel(strategy)}”。新会话需要重新加载 VS Code 后生效。是否立即重载？`);
  } else {
    vscode.window.showInformationMessage(
      `已保存“${gateway.name}”的命令策略：${getClaudePermissionStrategyLabel(strategy)}。下次切换时自动应用。`
    );
  }
}

function getClaudePermissionStrategyLabel(strategy?: ClaudePermissionStrategy): string {
  if (strategy === "auto") return "Auto（依赖分类器）";
  if (strategy === "acceptEdits") return "编辑自动接受";
  if (strategy === "manual") return "手动确认";
  if (strategy === "bypassPermissions") return "完全放行（危险）";
  return "未配置";
}

async function guideClaudeConfigurationConflicts(
  target: string,
  blockingConflicts: ClaudeConfigurationFinding[],
  allFindings: ClaudeConfigurationFinding[]
): Promise<boolean> {
  const conflictChoice = await vscode.window.showWarningMessage(
    `检测到 ${blockingConflicts.length} 项会覆盖或干扰“${target}”的 Claude 路由、认证或模型配置。插件可以先备份配置文件，再只停用冲突字段；权限规则和其他 Claude 设置会保留。`,
    { modal: true },
    "安全处理（推荐）",
    "逐项查看",
    "保留并切换",
    "取消"
  );
  if (conflictChoice === "安全处理（推荐）") {
    const resolution = await safelyResolveClaudeConfigurationFindings(blockingConflicts);
    if (resolution.unresolved > 0) {
      const next = await vscode.window.showWarningMessage(
        `已备份并处理 ${resolution.resolved} 项文件配置，但仍有 ${resolution.unresolved} 项来自系统环境、无效 JSON 或不可修改来源。请逐项查看处理，完成后再切换。`,
        { modal: true },
        "逐项查看",
        "取消"
      );
      if (next === "逐项查看") await showClaudeConfigurationFindings(blockingConflicts);
      return false;
    }
    return true;
  }
  if (conflictChoice === "逐项查看") {
    await showClaudeConfigurationFindings(allFindings);
    return false;
  }
  return conflictChoice === "保留并切换";
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
      { label: "使用 Claude 官方订阅", action: "official" },
      { label: "添加中转站", action: "add" },
      { label: "删除中转站", action: "remove" },
      { label: "清除某个中转站 Token", action: "clear" },
      { label: "配置模型映射", action: "mapping" },
      { label: "配置命令执行策略", action: "permissions" },
      { label: "检测其他 Claude 配置", action: "inspect" },
      { label: "打开 Claude 会话历史", action: "sessions" }
    ],
    { title: "管理 Claude 中转站" }
  );

  if (!action) {
    return;
  }
  if (action.action === "switch") await switchToGateway(context);
  if (action.action === "official") await switchToOfficial();
  if (action.action === "add") await addGateway();
  if (action.action === "remove") await removeGateway(context);
  if (action.action === "clear") await clearGatewayToken(context);
  if (action.action === "mapping") await configureClaudeModelMapping(context);
  if (action.action === "permissions") await configureClaudePermissionStrategy();
  if (action.action === "inspect") await inspectClaudeConfiguration();
  if (action.action === "sessions") await vscode.commands.executeCommand("workbench.action.chat.openSessions");
}

async function inspectClaudeConfiguration(): Promise<void> {
  const findings = await findClaudeConfigurationConflicts();
  if (findings.length === 0) {
    vscode.window.showInformationMessage("未检测到插件之外的 Claude Provider、认证或模型配置。");
    return;
  }
  await showClaudeConfigurationFindings(findings);
}

async function findClaudeConfigurationConflicts(
  target?: GatewayProfile
): Promise<ClaudeConfigurationFinding[]> {
  const configured = new Set(getClaudeEnvVars().map((entry) => entry.name));
  const findings = inspectClaudeEnvironment(
    process.env,
    "VS Code 进程/操作系统环境",
    false
  ).filter((finding) => !configured.has(finding.name));

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const settingsFiles = [
    { file: path.join(os.homedir(), ".claude", "settings.json"), source: "Claude 用户设置" },
    ...(workspaceRoot ? [
      { file: path.join(workspaceRoot, ".claude", "settings.json"), source: "Claude 项目设置" },
      { file: path.join(workspaceRoot, ".claude", "settings.local.json"), source: "Claude 项目本地设置" }
    ] : [])
  ];
  for (const candidate of settingsFiles) {
    try {
      const content = await fs.readFile(candidate.file, "utf8");
      findings.push(...inspectClaudeSettingsJson(content, candidate.source, true).map((finding) => ({
        ...finding,
        sourcePath: candidate.file
      })));
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        findings.push({
          source: candidate.source,
          category: "invalid",
          name: "settings.json",
          displayValue: "无法读取配置文件",
          canOverrideExtension: true,
          sourcePath: candidate.file
        });
      }
    }
  }

  const extensionEnvironment = new Map(getClaudeEnvVars().map((entry) => [entry.name, entry.value]));
  return deduplicateClaudeFindings(findings).filter((finding) => {
    if (!target) return true;
    if (finding.name === "ANTHROPIC_BASE_URL" && finding.displayValue === target.baseUrl) return false;
    const extensionValue = extensionEnvironment.get(finding.name);
    return !extensionValue || extensionValue !== finding.displayValue;
  });
}

function deduplicateClaudeFindings(
  findings: ClaudeConfigurationFinding[]
): ClaudeConfigurationFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.source}\0${finding.category}\0${finding.name}\0${finding.displayValue}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function showClaudeConfigurationFindings(
  findings: ClaudeConfigurationFinding[]
): Promise<void> {
  const categoryLabels: Record<ClaudeConfigurationFinding["category"], string> = {
    routing: "路由",
    authentication: "认证",
    model: "模型",
    permission: "权限",
    invalid: "错误"
  };
  const selected = await vscode.window.showQuickPick(
    findings.map((finding) => ({
      label: `$(${isBlockingClaudeConfigurationFinding(finding) ? "error" : "info"}) ${isBlockingClaudeConfigurationFinding(finding) ? "需处理" : "仅提示"} · ${categoryLabels[finding.category]} · ${finding.name}`,
      description: finding.source,
      detail: `${finding.displayValue}${getClaudeFindingGuidance(finding)}`,
      finding
    })),
    {
      title: `检测到 ${findings.length} 项插件之外的 Claude 配置`,
      placeHolder: "选择一项查看处理方案；敏感认证值已隐藏"
    }
  );
  if (!selected) return;
  await showClaudeConfigurationFindingActions(selected.finding);
}

function isBlockingClaudeConfigurationFinding(finding: ClaudeConfigurationFinding): boolean {
  return finding.canOverrideExtension && finding.category !== "permission";
}

function getClaudeFindingGuidance(finding: ClaudeConfigurationFinding): string {
  if (finding.category === "permission") {
    return finding.name === "permissions.allow" && finding.displayValue.includes("宽泛")
      ? " · Auto 模式会暂停宽泛 allow 规则；这不是 Provider 冲突，不会阻止切换"
      : " · 权限设置不会阻止 Provider 切换，请按安全需求保留";
  }
  if (finding.sourcePath && finding.category !== "invalid") {
    return " · 可安全备份后仅停用 Provider 冲突字段";
  }
  if (!finding.canOverrideExtension) {
    return " · IDE 中通常会被插件覆盖，但终端 Claude Code 仍可能受影响";
  }
  return " · 可能覆盖插件配置，需要在来源中处理";
}

async function showClaudeConfigurationFindingActions(
  finding: ClaudeConfigurationFinding
): Promise<void> {
  if (finding.sourcePath) {
    const choices = finding.category === "invalid"
      ? ["打开配置文件", "返回列表"]
      : ["备份并停用此文件的冲突字段", "打开配置文件", "保留不改", "返回列表"];
    const choice = await vscode.window.showWarningMessage(
      `${finding.source} 中的 ${finding.name}：${finding.displayValue}\n\n${getClaudeFindingGuidance(finding).replace(/^ · /, "")}`,
      { modal: true },
      ...choices
    );
    if (choice === "备份并停用此文件的冲突字段") {
      const result = await safelyResolveClaudeConfigurationFindings([finding]);
      if (result.resolved > 0) {
        vscode.window.showInformationMessage(`已备份原文件并停用 ${result.resolved} 项 Provider 冲突字段；权限和其他设置均已保留。`);
      }
    }
    if (choice === "打开配置文件") {
      await vscode.window.showTextDocument(vscode.Uri.file(finding.sourcePath));
    }
    if (choice === "返回列表") await showClaudeConfigurationFindings([finding]);
    return;
  }

  const choice = await vscode.window.showWarningMessage(
    `${finding.source} 中检测到 ${finding.name}。插件不能安全修改启动 VS Code 时继承的系统/终端环境变量。请在 Windows 用户环境变量、启动终端配置或 shell profile 中删除该变量，然后完全退出并重新打开 VS Code。`,
    { modal: true },
    "复制变量名",
    "我知道了"
  );
  if (choice === "复制变量名") {
    await vscode.env.clipboard.writeText(finding.name);
    vscode.window.showInformationMessage(`已复制变量名 ${finding.name}。`);
  }
}

async function safelyResolveClaudeConfigurationFindings(
  findings: ClaudeConfigurationFinding[]
): Promise<{ resolved: number; unresolved: number }> {
  const editableFiles = new Set(
    findings
      .filter((finding) => finding.sourcePath && finding.category !== "permission" && finding.category !== "invalid")
      .map((finding) => finding.sourcePath as string)
  );
  let resolved = 0;
  const failedFiles = new Set<string>();
  for (const file of editableFiles) {
    try {
      const original = await fs.readFile(file, "utf8");
      const stripped = stripClaudeProviderSettingsJson(original);
      if (stripped.removed.length === 0) continue;
      const backup = `${file}.ai-provider-switcher-${formatBackupTimestamp()}.bak`;
      await fs.copyFile(file, backup);
      await fs.writeFile(file, stripped.content, "utf8");
      resolved += stripped.removed.length;
    } catch {
      // Unreadable, invalid, or concurrently modified files remain unresolved.
      failedFiles.add(file);
    }
  }
  const unresolved = findings.filter((finding) => {
    if (finding.category === "permission") return false;
    return !finding.sourcePath ||
      finding.category === "invalid" ||
      !editableFiles.has(finding.sourcePath) ||
      failedFiles.has(finding.sourcePath);
  }).length;
  return { resolved, unresolved };
}

function formatBackupTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
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
  const gateway: GatewayProfile = { id, name: name.trim(), baseUrl: normalizeClaudeProviderBaseUrl(baseUrl) };
  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  await settings.update(GATEWAYS_KEY.split(".").slice(1).join("."), [...getGateways(), gateway], vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`已添加中转站：${gateway.name}。如需启用，请点击“切换服务”并选择它。`);
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

async function refreshGatewayModels(context: vscode.ExtensionContext, selectedGateway?: GatewayProfile): Promise<void> {
  const gateway = selectedGateway ?? await pickGateway();
  if (!gateway) return;

  const token = await getStoredGatewayToken(context, gateway);
  if (!token) {
    vscode.window.showWarningMessage(`“${gateway.name}”尚未保存 Token，请先切换到该中转站一次。`);
    return;
  }

  try {
    const response = await requestGatewayModels(gateway.baseUrl, token);
    const models = response.models;
    await saveGatewayModels(gateway.id, models);
    await saveUsageFromResponseHeaders("claude", gateway.id, response.headers);
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

async function configureClaudeModelMapping(
  context: vscode.ExtensionContext,
  selectedGateway?: GatewayProfile,
  knownToken?: string,
  applyImmediately = true
): Promise<ClaudeModelMapping | undefined> {
  const gateway = selectedGateway ?? await pickGateway();
  if (!gateway) return undefined;

  const existing = gateway.modelMapping;
  const action = await vscode.window.showQuickPick([
    {
      label: "$(wand) 推荐映射",
      description: "选择主模型和快速模型，自动覆盖 Claude 的所有模型族与子代理",
      action: "recommended"
    },
    {
      label: "$(settings-gear) 高级映射",
      description: "分别设置主模型、Fable、Opus、Sonnet、Haiku 和子代理",
      action: "advanced"
    },
    ...(existing ? [{
      label: "$(trash) 清除映射",
      description: "恢复由 Claude Code 或服务端自行解析模型名称",
      action: "clear"
    }] : [])
  ], {
    title: `配置“${gateway.name}”的 Claude 模型映射`,
    placeHolder: existing
      ? `当前主模型：${existing.mainModel}`
      : "非 Claude 模型的服务推荐配置映射，否则 Auto、后台任务或子代理可能请求不存在的 Claude 模型"
  });
  if (!action) return undefined;

  if (action.action === "clear") {
    await updateGatewayProfile({ ...gateway, modelMapping: undefined });
    if (applyImmediately && getCurrentClaudeProvider()?.id === gateway.id) {
      await updateClaudeEnvVars(removeClaudeModelEnvironment(getClaudeEnvVars()));
      await offerReload(`已清除“${gateway.name}”的模型映射。需要重新加载 VS Code 才会生效。是否立即重载？`);
    } else {
      vscode.window.showInformationMessage(`已清除“${gateway.name}”的模型映射。`);
    }
    return undefined;
  }

  let models = getGatewayModels().find((entry) => entry.gatewayId === gateway.id)?.models ?? [];
  const token = knownToken ?? await getStoredGatewayToken(context, gateway);
  if (models.length === 0 && token) {
    try {
      models = (await requestGatewayModels(gateway.baseUrl, token)).models;
      if (models.length > 0) await saveGatewayModels(gateway.id, models);
    } catch {
      // Manual entry remains available when the provider does not expose /v1/models.
    }
  }

  const mainModel = await pickClaudeMappedModel(
    "选择主会话模型",
    models,
    existing?.mainModel
  );
  if (!mainModel) return undefined;

  let mapping: ClaudeModelMapping;
  if (action.action === "recommended") {
    const fastModel = await pickClaudeMappedModel(
      "选择快速/低成本模型（Haiku、后台任务和子代理）",
      models,
      existing?.haikuModel ?? mainModel
    );
    if (!fastModel) return undefined;
    mapping = createClaudeModelMapping(mainModel, fastModel);
  } else {
    const fableModel = await pickClaudeMappedModel("映射 Fable", models, existing?.fableModel ?? mainModel);
    if (!fableModel) return undefined;
    const opusModel = await pickClaudeMappedModel("映射 Opus（含 Auto 模式的 Opus 回退）", models, existing?.opusModel ?? mainModel);
    if (!opusModel) return undefined;
    const sonnetModel = await pickClaudeMappedModel("映射 Sonnet（Auto 分类器通常使用该族）", models, existing?.sonnetModel ?? mainModel);
    if (!sonnetModel) return undefined;
    const haikuModel = await pickClaudeMappedModel("映射 Haiku/后台任务", models, existing?.haikuModel ?? mainModel);
    if (!haikuModel) return undefined;
    const subagentModel = await pickClaudeMappedModel("映射子代理", models, existing?.subagentModel ?? haikuModel);
    if (!subagentModel) return undefined;
    mapping = { mainModel, fableModel, opusModel, sonnetModel, haikuModel, subagentModel };
  }

  const supports1m = await vscode.window.showQuickPick([
    {
      label: "不启用 1M（推荐）",
      description: "不添加 [1m]；适合能力未知的中转站",
      value: false
    },
    {
      label: "确认服务支持 1M",
      description: "对主模型、Fable、Opus 和 Sonnet 添加 [1m]，Claude Code 发送请求前会移除后缀",
      value: true
    }
  ], {
    title: "该 Provider 是否支持 1M 上下文？",
    placeHolder: "只有服务商明确声明支持时才启用"
  });
  if (!supports1m) return undefined;
  mapping.supports1m = supports1m.value;

  const effort = await vscode.window.showQuickPick([
    { label: "不强制（推荐）", description: "由 Claude Code 和模型自行决定", value: undefined },
    ...["auto", "low", "medium", "high", "xhigh", "max"].map((value) => ({
      label: value,
      description: value === "max" ? "仅在服务商确认兼容 effort 参数时使用" : "",
      value: value as ClaudeModelMapping["effortLevel"]
    }))
  ], { title: "选择 effort 级别" });
  if (!effort) return undefined;
  mapping.effortLevel = effort.value;

  await updateGatewayProfile({ ...gateway, modelMapping: mapping });
  if (applyImmediately && getCurrentClaudeProvider()?.id === gateway.id) {
    const current = removeClaudeModelEnvironment(getClaudeEnvVars());
    await updateClaudeEnvVars([...current, ...createClaudeModelEnvironment(mapping)]);
    await offerReload(`已保存并应用“${gateway.name}”的模型映射。需要重新加载 VS Code 才会生效。是否立即重载？`);
  } else {
    vscode.window.showInformationMessage(`已保存“${gateway.name}”的模型映射，下次切换到该服务时自动应用。`);
  }
  return mapping;
}

async function pickClaudeMappedModel(
  title: string,
  models: string[],
  current?: string
): Promise<string | undefined> {
  const normalizedCurrent = current?.replace(/\[1m\]$/i, "");
  if (models.length > 0) {
    const selected = await vscode.window.showQuickPick([
      ...models.map((model) => ({
        label: model,
        description: model === normalizedCurrent ? "当前映射" : "Provider 返回的模型",
        model
      })),
      { label: "$(edit) 手动输入模型 ID", description: "模型列表不完整时使用", model: "" }
    ], { title, placeHolder: "映射使用 Provider 接受的真实模型 ID" });
    if (!selected) return undefined;
    if (selected.model) return selected.model;
  }
  const entered = await vscode.window.showInputBox({
    title,
    prompt: "输入 Provider 接受的真实模型 ID；不要自行添加 [1m]",
    value: normalizedCurrent ?? "",
    ignoreFocusOut: true
  });
  return entered?.trim() || undefined;
}

async function offerModelMappingForGateway(
  context: vscode.ExtensionContext,
  gateway: GatewayProfile,
  token: string
): Promise<{ proceed: boolean; mapping?: ClaudeModelMapping }> {
  let models = getGatewayModels().find((entry) => entry.gatewayId === gateway.id)?.models ?? [];
  if (models.length === 0) {
    try {
      models = (await requestGatewayModels(gateway.baseUrl, token)).models;
      if (models.length > 0) await saveGatewayModels(gateway.id, models);
    } catch {
      const choice = await vscode.window.showWarningMessage(
        `“${gateway.name}”没有返回可识别的模型列表。若它使用 DeepSeek、Kimi、GLM 等非 Claude 模型，必须配置模型映射，避免主会话、Auto 分类器或子代理请求不存在的 Claude 模型。`,
        { modal: true },
        "配置模型映射（推荐）",
        "服务端会映射 Claude 名称",
        "取消切换"
      );
      if (choice === "配置模型映射（推荐）") {
        const mapping = await configureClaudeModelMapping(context, gateway, token, false);
        return { proceed: Boolean(mapping), mapping };
      }
      return { proceed: choice === "服务端会映射 Claude 名称" };
    }
  }

  if (!hasNonClaudeModelIds(models)) return { proceed: true };
  const choice = await vscode.window.showWarningMessage(
    `检测到“${gateway.name}”提供非 Claude 模型。仅修改 ANTHROPIC_BASE_URL 不会改变 Claude Code 的模型选择；建议把 Claude 的各模型族、后台任务和子代理映射到该服务的真实模型。`,
    { modal: true },
    "配置模型映射（推荐）",
    "服务端会映射 Claude 名称",
    "取消切换"
  );
  if (choice === "配置模型映射（推荐）") {
    const mapping = await configureClaudeModelMapping(context, gateway, token, false);
    return { proceed: Boolean(mapping), mapping };
  }
  return { proceed: choice === "服务端会映射 Claude 名称" };
}

function removeClaudeModelEnvironment(envVars: EnvVar[]): EnvVar[] {
  const names = new Set<string>([
    ...CLAUDE_MODEL_ENV_NAMES,
    ...DEEPSEEK_CLAUDE_MODEL_ENV_NAMES,
    ...getClaudeModelCompanionEnvironmentNames()
  ]);
  return envVars.filter((entry) => !names.has(entry.name));
}

function getClaudeModelCompanionEnvironmentNames(): string[] {
  const suffixes = ["NAME", "DESCRIPTION", "SUPPORTED_CAPABILITIES"];
  return ["FABLE", "OPUS", "SONNET", "HAIKU"].flatMap((family) =>
    suffixes.map((suffix) => `ANTHROPIC_DEFAULT_${family}_MODEL_${suffix}`)
  );
}

async function updateGatewayProfile(profile: GatewayProfile): Promise<void> {
  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  const gateways = getGateways().map((gateway) => gateway.id === profile.id ? profile : gateway);
  await settings.update("gateways", gateways, vscode.ConfigurationTarget.Global);
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

function requestGatewayModels(baseUrl: string, token: string): Promise<{ models: string[]; headers: IncomingHttpHeaders }> {
  const endpoint = new URL(`${normalizeProviderRootUrl(baseUrl)}/v1/models`);
  return new Promise((resolve, reject) => {
    const request = https.request(
      endpoint,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "x-api-key": token,
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
            resolve({ models: [...new Set(models)].sort(), headers: response.headers });
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

async function switchToCodexGateway(context: vscode.ExtensionContext, selectedProvider?: CodexProviderProfile): Promise<void> {
  const provider = selectedProvider ?? await pickCodexProvider();
  if (!provider) return;

  const proceed = await confirmCodexProviderSwitch(provider.name);
  if (!proceed) return;

  const apiKey = await getOrRequestCodexApiKey(context, provider);
  if (!apiKey) return;

  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");

  try {
    let models = getCodexModels().find((entry) => entry.providerId === provider.id)?.models ?? [];
    if (models.length === 0) {
      const response = await requestCodexModels(provider.baseUrl, apiKey);
      models = response.models;
      await saveCodexModels(provider.id, models);
      await saveUsageFromResponseHeaders("codex", provider.id, response.headers);
    }
    if (models.length === 0) {
      throw new Error("该 Provider 没有返回可用模型");
    }
    await writeCodexConfiguration(context, provider, models);
    await settings.update(CODEX_ACTIVE_PROVIDER_KEY, provider.id, vscode.ConfigurationTarget.Global);
    await settings.update(CODEX_ACTIVE_MODEL_KEY, "", vscode.ConfigurationTarget.Global);
    await synchronizeCodexProxyForProvider(settings);
    await refreshStatusBar();
    await offerReload(
      `Codex 已切换到“${provider.name}”。已同步 ${models.length} 个模型；重载后请直接在 Codex 页面原生模型栏中选择。是否立即重载？`
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
    const restoredCatalog = updateTopLevelTomlKey(
      restored,
      "model_catalog_json",
      backup?.hadModelCatalog ? backup.modelCatalog : undefined
    );
    await writeCodexConfigurationFile(restoredCatalog);

    const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
    await settings.update(CODEX_ACTIVE_PROVIDER_KEY, "", vscode.ConfigurationTarget.Global);
    await synchronizeCodexProxyForProvider(settings);
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
      { label: "刷新并同步 Codex 模型", action: "refresh" },
      { label: "配置 Codex WebSocket 代理", action: "proxy" },
      { label: "打开 Codex 页面选择模型", action: "open" },
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
  if (action.action === "proxy") await configureCodexProxy();
  if (action.action === "open") await vscode.commands.executeCommand("chatgpt.openSidebar");
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

async function refreshCodexModels(context: vscode.ExtensionContext, selectedProvider?: CodexProviderProfile): Promise<void> {
  const provider = selectedProvider ?? await pickCodexProvider();
  if (!provider) return;

  const apiKey = await getStoredCodexApiKey(context, provider);
  if (!apiKey) {
    vscode.window.showWarningMessage(`“${provider.name}”尚未保存 API Key，请先切换到该 Provider。`);
    return;
  }

  try {
    const response = await requestCodexModels(provider.baseUrl, apiKey);
    const models = response.models;
    await saveCodexModels(provider.id, models);
    await saveUsageFromResponseHeaders("codex", provider.id, response.headers);
    const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
    const activeProviderId = settings.get<string>(CODEX_ACTIVE_PROVIDER_KEY, "");
    if (activeProviderId === provider.id) {
      await writeCodexConfiguration(context, provider, models);
      await settings.update(CODEX_ACTIVE_MODEL_KEY, "", vscode.ConfigurationTarget.Global);
    }
    const choice = await vscode.window.showInformationMessage(
      `已从“${provider.name}”刷新 ${models.length} 个 Codex 模型${activeProviderId === provider.id ? "，并同步到 Codex 原生模型栏；重载后生效" : ""}。`,
      "打开 Codex",
      "关闭"
    );
    if (choice === "打开 Codex") await vscode.commands.executeCommand("chatgpt.openSidebar");
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知网络错误";
    vscode.window.showErrorMessage(`刷新“${provider.name}”的 Codex 模型失败：${message}`);
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

function requestCodexModels(baseUrl: string, token: string): Promise<{ models: string[]; headers: IncomingHttpHeaders }> {
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
            resolve({ models: [...new Set(models)].sort(), headers: response.headers });
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

type UsageProviderSelection = {
  kind: "claude" | "codex";
  provider: GatewayProfile | CodexProviderProfile;
};

async function pickUsageProvider(title: string): Promise<UsageProviderSelection | undefined> {
  const items = [
    ...getGateways().map((provider) => ({
      label: `Claude · ${provider.name}`,
      description: provider.usage?.endpoint ?? provider.baseUrl,
      selection: { kind: "claude" as const, provider }
    })),
    ...getCodexProviders().map((provider) => ({
      label: `Codex · ${provider.name}`,
      description: provider.usage?.endpoint ?? provider.baseUrl,
      selection: { kind: "codex" as const, provider }
    }))
  ];
  if (!items.length) {
    vscode.window.showInformationMessage("请先添加至少一个 Claude 或 Codex 自定义 Provider。");
    return undefined;
  }
  return (await vscode.window.showQuickPick(items, { title }))?.selection;
}

async function configureProviderUsage(context: vscode.ExtensionContext, selectedProvider?: UsageProviderSelection): Promise<void> {
  const selected = selectedProvider ?? await pickUsageProvider("配置 Provider 用量与额度 API");
  if (!selected) return;
  const current = selected.provider.usage;
  const action = await vscode.window.showQuickPick([
    {
      label: "自动识别常见额度格式",
      description: "配置只读 GET 接口，自动寻找 balance、five_hour 和 weekly 字段",
      action: "automatic"
    },
    {
      label: "配置 JSON 字段路径",
      description: "适配返回字段名称不同的 Provider",
      action: "custom"
    },
    ...(current ? [{ label: "清除额度 API 配置", description: "保留已缓存快照", action: "clear" }] : [])
  ], { title: `${selected.provider.name} · 用量与额度` });
  if (!action) return;
  if (action.action === "clear") {
    await updateProviderUsageConfiguration(selected, undefined);
    vscode.window.showInformationMessage(`已清除“${selected.provider.name}”的额度 API 配置。`);
    return;
  }

  const endpointInput = await vscode.window.showInputBox({
    title: `${selected.provider.name} · 额度 API 地址`,
    prompt: "只支持返回 JSON 的 GET 接口。优先使用 HTTPS 和只读凭据；请求会复用该 Provider 已保存的 Key。",
    value: current?.endpoint ?? `${selected.provider.baseUrl.replace(/\/$/, "")}/usage`,
    ignoreFocusOut: true
  });
  if (!endpointInput?.trim()) return;
  let endpoint: string;
  try {
    endpoint = validateUsageEndpoint(endpointInput);
  } catch (error) {
    vscode.window.showErrorMessage(error instanceof Error ? error.message : "额度 API 地址无效");
    return;
  }
  if (endpoint.startsWith("http://")) {
    const confirm = await vscode.window.showWarningMessage(
      "该额度 API 使用 HTTP，Provider Key 和账户用量数据缺少 TLS 保护。是否仍然保存？",
      { modal: true },
      "仍然保存"
    );
    if (confirm !== "仍然保存") return;
  }
  if (new URL(endpoint).origin !== new URL(selected.provider.baseUrl).origin) {
    const confirm = await vscode.window.showWarningMessage(
      `额度 API 位于 ${new URL(endpoint).origin}，与 Provider ${new URL(selected.provider.baseUrl).origin} 不同。刷新时会把该 Provider 的已保存凭据发送到额度 API。请只在确认该域名属于服务商时继续。`,
      { modal: true },
      "确认域名并保存"
    );
    if (confirm !== "确认域名并保存") return;
  }

  let configuration: ProviderUsageConfiguration = { endpoint };
  if (action.action === "custom") {
    const mappingInput = await vscode.window.showInputBox({
      title: "配置额度 JSON 路径",
      prompt: "输入 JSON 对象。只填写 Provider 实际提供的路径；支持 a.b.c 和 items[0].value。",
      value: JSON.stringify({
        fiveHourUsedPercentPath: current?.fiveHourUsedPercentPath ?? "quota.five_hour.used_percent",
        fiveHourResetPath: current?.fiveHourResetPath ?? "quota.five_hour.reset_at",
        weeklyUsedPercentPath: current?.weeklyUsedPercentPath ?? "quota.weekly.used_percent",
        weeklyResetPath: current?.weeklyResetPath ?? "quota.weekly.reset_at",
        balanceRemainingPath: current?.balanceRemainingPath ?? "balance.remaining",
        currencyPath: current?.currencyPath ?? "balance.currency"
      }),
      ignoreFocusOut: true
    });
    if (!mappingInput?.trim()) return;
    try {
      configuration = normalizeUsageConfiguration({ endpoint, ...JSON.parse(mappingInput) }) ?? { endpoint };
    } catch {
      vscode.window.showErrorMessage("额度字段路径必须是有效的 JSON 对象。");
      return;
    }
  }
  await updateProviderUsageConfiguration(selected, configuration);
  const refresh = await vscode.window.showInformationMessage(
    `已保存“${selected.provider.name}”的额度 API。是否立即测试？`,
    "立即测试"
  );
  if (refresh === "立即测试") await refreshSelectedProviderUsage(selected, context);
}

async function manageProviderUsage(context: vscode.ExtensionContext): Promise<void> {
  type ConfiguredProvider = UsageProviderSelection;
  type UsageManagementItem = {
    label: string;
    description: string;
    detail: string;
    item?: ConfiguredProvider;
  };
  while (true) {
    const configured: ConfiguredProvider[] = [
      ...getGateways()
        .filter((provider) => provider.usage)
        .map((provider) => ({ kind: "claude" as const, provider })),
      ...getCodexProviders()
        .filter((provider) => provider.usage)
        .map((provider) => ({ kind: "codex" as const, provider }))
    ];
    const items: UsageManagementItem[] = configured.map((item) => ({
      label: `${item.kind === "claude" ? "Claude" : "Codex"} · ${item.provider.name}`,
      description: formatUsageConfigurationDescription(item.provider.usage),
      detail: "选择后可查看、修改、测试或删除额度 API 配置",
      item
    }));
    items.push({
      label: "$(add) 配置新的 Provider 额度 API",
      description: "为尚未配置额度 API 的自定义 Provider 添加配置",
      detail: "",
      item: undefined
    });
    const selected = await vscode.window.showQuickPick(items, {
      title: "管理 Provider 用量与额度配置",
      placeHolder: configured.length ? "选择已有配置查看或管理" : "当前还没有额度 API 配置"
    });
    if (!selected) return;
    if (!selected.item) {
      await configureProviderUsage(context);
      continue;
    }

    const provider = selected.item.provider;
    const usage = provider.usage;
    if (!usage) continue;
    const action = await vscode.window.showQuickPick([
      {
        label: "查看配置详情",
        description: formatUsageConfigurationDescription(usage),
        action: "view"
      },
      {
        label: "修改额度配置",
        description: "更新接口地址或 JSON 字段路径",
        action: "edit"
      },
      {
        label: "测试并刷新额度",
        description: "使用该 Provider 已保存的凭据调用额度 API",
        action: "test"
      },
      {
        label: "删除额度 API 配置",
        description: "删除配置并保留已有额度快照",
        action: "delete"
      }
    ], { title: `${provider.name} · 额度配置管理` });
    if (!action) continue;
    if (action.action === "view") {
      await showProviderUsageDetails(selected.item);
    } else if (action.action === "edit") {
      await configureProviderUsageForSelection(context, selected.item);
    } else if (action.action === "test") {
      await refreshSelectedProviderUsage(selected.item, context);
    } else if (action.action === "delete") {
      const confirm = await vscode.window.showWarningMessage(
        `确定删除“${provider.name}”的额度 API 配置？已有额度快照不会删除。`,
        { modal: true },
        "删除配置"
      );
      if (confirm === "删除配置") {
        await updateProviderUsageConfiguration(selected.item, undefined);
        vscode.window.showInformationMessage(`已删除“${provider.name}”的额度 API 配置。`);
      }
    }
  }
}

function formatUsageConfigurationDescription(usage: ProviderUsageConfiguration | undefined): string {
  if (!usage) return "未配置";
  const pathCount = [
    usage.balanceRemainingPath, usage.balanceUsedPath, usage.currencyPath,
    usage.fiveHourUsedPercentPath, usage.fiveHourRemainingPercentPath, usage.fiveHourResetPath,
    usage.weeklyUsedPercentPath, usage.weeklyRemainingPercentPath, usage.weeklyResetPath
  ].filter(Boolean).length;
  return `${usage.endpoint} · ${pathCount} 个字段映射`;
}

async function showProviderUsageDetails(
  selected: UsageProviderSelection
): Promise<void> {
  const usage = selected.provider.usage;
  if (!usage) return;
  const snapshot = getProviderUsageSnapshots().find((entry) =>
    entry.providerId === selected.provider.id && entry.providerKind === selected.kind
  );
  const fields = [
    ["额度 API", usage.endpoint],
    ["余额剩余路径", usage.balanceRemainingPath],
    ["余额已用路径", usage.balanceUsedPath],
    ["货币路径", usage.currencyPath],
    ["5 小时已用比例路径", usage.fiveHourUsedPercentPath],
    ["5 小时剩余比例路径", usage.fiveHourRemainingPercentPath],
    ["5 小时重置路径", usage.fiveHourResetPath],
    ["周已用比例路径", usage.weeklyUsedPercentPath],
    ["周剩余比例路径", usage.weeklyRemainingPercentPath],
    ["周重置路径", usage.weeklyResetPath]
  ];
  const detail = fields
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}：${value}`)
    .join("\n");
  const snapshotText = snapshot
    ? `\n\n最近快照：${formatProviderUsageSummary(snapshot)}\n更新时间：${snapshot.fetchedAt}\n来源：${snapshot.source === "usageApi" ? "额度 API" : "模型接口响应头"}`
    : "\n\n最近快照：尚未刷新";
  await vscode.window.showInformationMessage(`${selected.provider.name} 的额度配置\n\n${detail}${snapshotText}`, { modal: true }, "关闭");
}

async function configureProviderUsageForSelection(
  context: vscode.ExtensionContext,
  selected: UsageProviderSelection
): Promise<void> {
  const current = selected.provider.usage;
  if (!current) {
    await configureProviderUsage(context, selected);
    return;
  }
  const endpointInput = await vscode.window.showInputBox({
    title: `${selected.provider.name} · 修改额度 API 地址`,
    prompt: "修改后将替换当前配置。优先使用 HTTPS 和只读凭据。",
    value: current.endpoint,
    ignoreFocusOut: true
  });
  if (!endpointInput?.trim()) return;
  let endpoint: string;
  try {
    endpoint = validateUsageEndpoint(endpointInput);
  } catch (error) {
    vscode.window.showErrorMessage(error instanceof Error ? error.message : "额度 API 地址无效");
    return;
  }
  if (endpoint.startsWith("http://")) {
    const confirm = await vscode.window.showWarningMessage(
      "修改后的额度 API 使用 HTTP，Provider Key 和账户用量数据缺少 TLS 保护。是否仍然保存？",
      { modal: true },
      "仍然保存"
    );
    if (confirm !== "仍然保存") return;
  }
  const mappingInput = await vscode.window.showInputBox({
    title: `${selected.provider.name} · 修改 JSON 字段路径`,
    prompt: "输入 JSON 对象；输入 {} 可清除字段映射并恢复自动识别。",
    value: JSON.stringify({
      balanceRemainingPath: current.balanceRemainingPath,
      balanceUsedPath: current.balanceUsedPath,
      currencyPath: current.currencyPath,
      fiveHourUsedPercentPath: current.fiveHourUsedPercentPath,
      fiveHourRemainingPercentPath: current.fiveHourRemainingPercentPath,
      fiveHourResetPath: current.fiveHourResetPath,
      weeklyUsedPercentPath: current.weeklyUsedPercentPath,
      weeklyRemainingPercentPath: current.weeklyRemainingPercentPath,
      weeklyResetPath: current.weeklyResetPath
    }, null, 2),
    ignoreFocusOut: true
  });
  if (!mappingInput?.trim()) return;
  let mapping: Record<string, unknown>;
  try {
    mapping = JSON.parse(mappingInput) as Record<string, unknown>;
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) throw new Error();
  } catch {
    vscode.window.showErrorMessage("额度字段路径必须是有效的 JSON 对象。");
    return;
  }
  const updated = normalizeUsageConfiguration({ endpoint, ...mapping });
  if (!updated) {
    vscode.window.showErrorMessage("无法保存额度配置，请检查额度 API 地址。");
    return;
  }
  await updateProviderUsageConfiguration(selected, updated);
  vscode.window.showInformationMessage(`已更新“${selected.provider.name}”的额度 API 配置。`);
  const test = await vscode.window.showInformationMessage("是否立即测试更新后的额度配置？", "立即测试");
  if (test === "立即测试") await refreshSelectedProviderUsage(selected, context);
}

async function updateProviderUsageConfiguration(
  selected: UsageProviderSelection,
  usage: ProviderUsageConfiguration | undefined
): Promise<void> {
  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  if (selected.kind === "claude") {
    await settings.update("gateways", getGateways().map((provider) =>
      provider.id === selected.provider.id ? { ...provider, usage } : provider
    ), vscode.ConfigurationTarget.Global);
  } else {
    await settings.update(CODEX_PROVIDERS_KEY, getCodexProviders().map((provider) =>
      provider.id === selected.provider.id ? { ...provider, usage } : provider
    ), vscode.ConfigurationTarget.Global);
  }
}

async function deleteProviderUsageConfiguration(selected: UsageProviderSelection): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    `确定删除“${selected.provider.name}”的额度 API 配置？已有额度快照会保留。`,
    { modal: true },
    "删除配置"
  );
  if (confirm !== "删除配置") return;
  await updateProviderUsageConfiguration(selected, undefined);
  vscode.window.showInformationMessage(`已删除“${selected.provider.name}”的额度 API 配置。`);
}

async function refreshProviderUsage(context: vscode.ExtensionContext): Promise<void> {
  const selected = await pickUsageProvider("刷新 Provider 用量与额度");
  if (!selected) return;
  await refreshSelectedProviderUsage(selected, context);
}

async function refreshSelectedProviderUsage(
  selected: UsageProviderSelection,
  context?: vscode.ExtensionContext
): Promise<void> {
  if (!context) {
    vscode.window.showWarningMessage("请通过命令面板的“Refresh Provider Usage”执行首次测试。");
    return;
  }
  const token = selected.kind === "claude"
    ? await getStoredGatewayToken(context, selected.provider as GatewayProfile)
    : await getStoredCodexApiKey(context, selected.provider as CodexProviderProfile);
  if (!token) {
    vscode.window.showWarningMessage(`“${selected.provider.name}”尚未保存凭据，请先切换到该 Provider 一次。`);
    return;
  }
  try {
    let snapshot: ProviderUsageSnapshot;
    if (selected.provider.usage) {
      snapshot = await requestProviderUsage(
        selected.provider.usage.endpoint,
        token,
        selected.provider.id,
        selected.kind,
        selected.provider.usage
      );
    } else if (selected.kind === "claude") {
      const response = await requestGatewayModels(selected.provider.baseUrl, token);
      await saveGatewayModels(selected.provider.id, response.models);
      snapshot = parseProviderUsage(selected.provider.id, "claude", "", response.headers);
    } else {
      const response = await requestCodexModels(selected.provider.baseUrl, token);
      await saveCodexModels(selected.provider.id, response.models);
      snapshot = parseProviderUsage(selected.provider.id, "codex", "", response.headers);
    }
    await saveProviderUsageSnapshot(snapshot);
    if (!hasProviderUsage(snapshot)) {
      const configure = await vscode.window.showWarningMessage(
        `“${selected.provider.name}”的模型接口没有返回可识别的限流头。可配置服务商提供的只读额度 API。`,
        "配置额度 API"
      );
      if (configure === "配置额度 API") await configureProviderUsage(context);
      return;
    }
    vscode.window.showInformationMessage(
      `${selected.provider.name}：${formatProviderUsageSummary(snapshot)}。数据来源：${snapshot.source === "usageApi" ? "额度 API" : "模型接口响应头"}。`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    const diagnostic = classifyUsageError(message);
    vscode.window.showErrorMessage(`刷新“${selected.provider.name}”额度失败：${diagnostic}`);
  }
}

function classifyUsageError(message: string): string {
  if (/不是有效 JSON|HTML|DOCTYPE/i.test(message)) {
    return `${message}。该地址可能返回了登录页、反向代理错误页，或不是实际的额度接口；请在“管理额度配置”中检查 endpoint。`;
  }
  if (/401|403|unauthorized|forbidden/i.test(message)) {
    return `${message}。额度接口拒绝了当前 Provider Key；如果是 Sub2API 的 /user/platform-quotas，需要单独的用户 JWT，不能直接使用模型 API Key。`;
  }
  return message;
}

async function saveUsageFromResponseHeaders(
  providerKind: "claude" | "codex",
  providerId: string,
  headers: IncomingHttpHeaders
): Promise<void> {
  const snapshot = parseProviderUsage(providerId, providerKind, "", headers);
  if (hasProviderUsage(snapshot)) await saveProviderUsageSnapshot(snapshot);
}

async function saveProviderUsageSnapshot(snapshot: ProviderUsageSnapshot): Promise<void> {
  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  const existing = getProviderUsageSnapshots().filter((entry) =>
    entry.providerId !== snapshot.providerId || entry.providerKind !== snapshot.providerKind
  );
  existing.push(snapshot);
  await settings.update(PROVIDER_USAGE_SNAPSHOTS_KEY, existing, vscode.ConfigurationTarget.Global);
}

function getProviderUsageSnapshots(): ProviderUsageSnapshot[] {
  const raw = vscode.workspace.getConfiguration("aiProviderSwitcher").get<unknown>(PROVIDER_USAGE_SNAPSHOTS_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is ProviderUsageSnapshot => {
    if (!item || typeof item !== "object") return false;
    const snapshot = item as Partial<ProviderUsageSnapshot>;
    return Boolean(snapshot.providerId && (snapshot.providerKind === "claude" || snapshot.providerKind === "codex"));
  });
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
      baseUrl: normalizeProviderRootUrl(String(item.baseUrl ?? "").trim()),
      usage: normalizeUsageConfiguration(item.usage)
    }))
    .filter((provider) => provider.id && provider.name && provider.baseUrl);
}

type CodexSelectionBackup = {
  hadModel: boolean;
  model?: string;
  hadModelProvider: boolean;
  modelProvider?: string;
  hadModelCatalog: boolean;
  modelCatalog?: string;
};

async function writeCodexConfiguration(
  context: vscode.ExtensionContext,
  provider: CodexProviderProfile,
  models: string[],
  selectedModel?: string
): Promise<void> {
  const content = await readCodexConfiguration();
  if (!context.globalState.get<CodexSelectionBackup>(CODEX_BACKUP_KEY)) {
    await context.globalState.update(CODEX_BACKUP_KEY, {
      hadModel: parseTopLevelTomlString(content, "model") !== undefined,
      model: parseTopLevelTomlString(content, "model"),
      hadModelProvider: parseTopLevelTomlString(content, "model_provider") !== undefined,
      modelProvider: parseTopLevelTomlString(content, "model_provider"),
      hadModelCatalog: parseTopLevelTomlString(content, "model_catalog_json") !== undefined,
      modelCatalog: parseTopLevelTomlString(content, "model_catalog_json")
    } satisfies CodexSelectionBackup);
  }

  await ensureCodexAuthHelper();
  await writeCodexModelCatalog(models);
  const providers = getCodexProviders();
  let updated = removeManagedCodexProviders(content);
  updated = updateTopLevelTomlKey(updated, "model_provider", provider.id);
  updated = updateTopLevelTomlKey(updated, "model_catalog_json", CODEX_MODEL_CATALOG_FILE);
  updated = updateTopLevelTomlKey(updated, "model", selectedModel);
  updated = `${updated.trimEnd()}\n\n${serializeManagedCodexProviders(providers)}\n`;
  await writeCodexConfigurationFile(updated);
}

async function writeCodexModelCatalog(models: string[]): Promise<void> {
  await fs.mkdir(path.dirname(CODEX_MODEL_CATALOG_FILE), { recursive: true });
  await fs.writeFile(
    CODEX_MODEL_CATALOG_FILE,
    `${JSON.stringify(createCodexModelCatalog(models), null, 2)}\n`,
    "utf8"
  );
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

async function writeCodexEnvFile(proxyUrl: string): Promise<void> {
  const content = await readCodexEnvFile();
  await fs.mkdir(path.dirname(CODEX_ENV_FILE), { recursive: true });
  await fs.writeFile(CODEX_ENV_FILE, updateManagedCodexEnv(content, proxyUrl), "utf8");
}

async function readCodexEnvFile(): Promise<string> {
  try {
    return await fs.readFile(CODEX_ENV_FILE, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "";
    throw error;
  }
}

async function removeCodexProxyEnvironment(): Promise<void> {
  const content = await readCodexEnvFile();
  if (!content) return;
  const updated = removeManagedCodexEnv(content);
  if (updated) {
    await fs.writeFile(CODEX_ENV_FILE, `${updated}\n`, "utf8");
    return;
  }
  await fs.unlink(CODEX_ENV_FILE);
}

async function configureCodexProxy(): Promise<void> {
  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  const configuredProxy = settings.get<string>(CODEX_PROXY_URL_KEY, "");
  const proxyMode = settings.get<CodexProxyMode>(CODEX_PROXY_MODE_KEY, "officialOnly");
  const detectedProxy = await detectCodexProxyUrl();
  const envContent = await readCodexEnvFile();
  const unmanagedEntries = findUnmanagedCodexProxyEnv(envContent);
  const scopeLabel = proxyMode === "officialOnly" ? "仅官方服务" : "官方及所有中转站";
  const action = await vscode.window.showQuickPick(
    [
      {
        label: "$(search) 自动检测并应用当前设备代理",
        description: detectedProxy ?? "未检测到 HTTP(S) 系统代理，可改用手动输入",
        action: "detect"
      },
      {
        label: "$(edit) 设置或更新代理",
        description: configuredProxy || "手动输入当前设备实际地址和端口",
        action: "set"
      },
      {
        label: "$(settings) 设置代理作用范围",
        description: `当前：${scopeLabel}`,
        action: "scope"
      },
      {
        label: "$(warning) 检查 .env 代理冲突",
        description: unmanagedEntries.length > 0
          ? `发现 ${unmanagedEntries.length} 个非本插件管理的代理变量`
          : "未发现非本插件管理的代理变量",
        action: "inspect"
      },
      {
        label: "$(trash) 停用插件管理的代理",
        description: "只移除插件写入的配置，保留 .env 中其他内容",
        action: "disable"
      }
    ],
    {
      title: "配置 Codex WebSocket 代理",
      placeHolder: "同时适用于 Codex 官方服务和自定义 Provider"
    }
  );
  if (!action) return;

  try {
    if (action.action === "inspect") {
      await inspectCodexEnvProxyConflicts(envContent, unmanagedEntries);
      return;
    }
    if (action.action === "scope") {
      const selected = await vscode.window.showQuickPick(
        [
          {
            label: "仅官方 OpenAI 服务（推荐）",
            description: "切换到中转站时暂停插件管理的代理，避免改变中转站网络路径",
            mode: "officialOnly" as const
          },
          {
            label: "官方服务及所有中转站",
            description: "中转站自身也必须通过本机代理访问时使用",
            mode: "allProviders" as const
          }
        ],
        { title: "选择 Codex 代理作用范围" }
      );
      if (!selected) return;
      await settings.update(CODEX_PROXY_MODE_KEY, selected.mode, vscode.ConfigurationTarget.Global);
      await synchronizeCodexProxyForProvider(settings);
      await offerReload(`Codex 代理作用范围已设为“${selected.label}”。是否立即重载 VS Code？`);
      return;
    }
    if (action.action === "detect") {
      if (!detectedProxy) {
        vscode.window.showWarningMessage(
          "未检测到当前设备的 HTTP(S) 代理。请确认系统代理已启用，或选择“设置或更新代理”手动填写。"
        );
        return;
      }
      if (!await confirmCodexEnvProxyConflicts(envContent, unmanagedEntries)) return;
      await applyCodexProxy(settings, detectedProxy, proxyMode);
      return;
    }
    if (action.action === "set") {
      const entered = await vscode.window.showInputBox({
        title: "配置 Codex 代理地址",
        prompt: "输入代理地址，例如 http://127.0.0.1:7890（Clash）或 http://127.0.0.1:10808（v2rayN）",
        placeHolder: "http://127.0.0.1:<当前设备端口>",
        value: configuredProxy || detectedProxy || "http://127.0.0.1:",
        ignoreFocusOut: true
      });
      if (!entered?.trim()) return;
      const proxyUrl = normalizeCodexProxyUrl(entered);
      if (!await confirmCodexEnvProxyConflicts(envContent, unmanagedEntries)) return;
      await applyCodexProxy(settings, proxyUrl, proxyMode);
      return;
    }
    await removeCodexProxyEnvironment();
    await settings.update(CODEX_PROXY_URL_KEY, "", vscode.ConfigurationTarget.Global);
    await offerReload("插件管理的 Codex 代理已停用。需要重新加载 VS Code 以重启 Codex 后台进程，是否立即重载？");
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    vscode.window.showErrorMessage(`配置 Codex 代理失败：${message}`);
  }
}

async function applyCodexProxy(
  settings: vscode.WorkspaceConfiguration,
  proxyUrl: string,
  proxyMode: CodexProxyMode
): Promise<void> {
  await settings.update(CODEX_PROXY_URL_KEY, proxyUrl, vscode.ConfigurationTarget.Global);
  await synchronizeCodexProxyForProvider(settings, proxyUrl, proxyMode);
  const activeProvider = settings.get<string>(CODEX_ACTIVE_PROVIDER_KEY, "");
  const paused = proxyMode === "officialOnly" && Boolean(activeProvider);
  await offerReload(
    paused
      ? `Codex 代理已保存为 ${proxyUrl}，当前使用中转站，按“仅官方服务”范围暂不写入。是否立即重载 VS Code？`
      : `Codex WebSocket 代理已配置为 ${proxyUrl}。需要重新加载 VS Code 以重启 Codex 后台进程，是否立即重载？`
  );
}

async function synchronizeCodexProxyForProvider(
  settings: vscode.WorkspaceConfiguration,
  proxyUrl = settings.get<string>(CODEX_PROXY_URL_KEY, ""),
  proxyMode = settings.get<CodexProxyMode>(CODEX_PROXY_MODE_KEY, "officialOnly")
): Promise<void> {
  const activeProvider = settings.get<string>(CODEX_ACTIVE_PROVIDER_KEY, "");
  if (!proxyUrl || (proxyMode === "officialOnly" && activeProvider)) {
    await removeCodexProxyEnvironment();
    return;
  }
  await writeCodexEnvFile(proxyUrl);
}

async function confirmCodexEnvProxyConflicts(
  content: string,
  entries: ReturnType<typeof findUnmanagedCodexProxyEnv>
): Promise<boolean> {
  if (entries.length === 0) return true;
  const choice = await vscode.window.showWarningMessage(
    `检测到 ~/.codex/.env 已有 ${entries.length} 个非本插件管理的代理变量。重复变量的生效顺序可能因 Codex 的 dotenv 解析方式而异，建议先处理冲突。`,
    { modal: true },
    "查看并处理",
    "保留并继续",
    "取消"
  );
  if (choice === "查看并处理") {
    await inspectCodexEnvProxyConflicts(content, entries);
    return false;
  }
  return choice === "保留并继续";
}

async function inspectCodexEnvProxyConflicts(
  content: string,
  entries = findUnmanagedCodexProxyEnv(content)
): Promise<void> {
  if (entries.length === 0) {
    vscode.window.showInformationMessage("~/.codex/.env 中未发现非本插件管理的代理变量。");
    return;
  }
  const detail = entries.map((entry) => `${entry.name}（第 ${entry.line} 行）=${entry.value}`).join("；");
  const choice = await vscode.window.showWarningMessage(
    `发现已有代理变量：${detail}`,
    { modal: true },
    "移除这些变量并由插件管理",
    "保留",
    "取消"
  );
  if (choice !== "移除这些变量并由插件管理") return;
  const updated = removeUnmanagedCodexProxyEnv(content);
  if (updated) {
    await fs.writeFile(CODEX_ENV_FILE, updated.endsWith("\n") ? updated : `${updated}\n`, "utf8");
  } else {
    await fs.unlink(CODEX_ENV_FILE);
  }
  vscode.window.showInformationMessage("已移除 ~/.codex/.env 中原有的代理变量，其他内容已保留。");
}

async function detectCodexProxyUrl(): Promise<string | undefined> {
  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
    const value = process.env[name]?.trim();
    if (!value) continue;
    try {
      return normalizeCodexProxyUrl(value);
    } catch {
      // Continue to the operating-system proxy configuration.
    }
  }
  const vscodeProxy = vscode.workspace.getConfiguration("http").get<string>("proxy", "").trim();
  if (vscodeProxy) {
    try {
      return normalizeCodexProxyUrl(vscodeProxy);
    } catch {
      // Continue to the operating-system proxy configuration.
    }
  }
  if (process.platform === "win32") return queryWindowsInternetProxy();
  if (process.platform === "darwin") return queryMacOsInternetProxy();
  if (process.platform === "linux") return queryGnomeInternetProxy();
  return undefined;
}

async function queryMacOsInternetProxy(): Promise<string | undefined> {
  const output = await collectProcessOutput("scutil", ["--proxy"]);
  if (!output) return undefined;
  try {
    return parseMacOsProxySettings(output);
  } catch {
    return undefined;
  }
}

async function queryGnomeInternetProxy(): Promise<string | undefined> {
  const mode = (await collectProcessOutput("gsettings", [
    "get", "org.gnome.system.proxy", "mode"
  ]))?.replace(/[\s']/g, "");
  if (mode !== "manual") return undefined;
  for (const protocol of ["https", "http"]) {
    const host = (await collectProcessOutput("gsettings", [
      "get", `org.gnome.system.proxy.${protocol}`, "host"
    ]))?.trim().replace(/^['"]|['"]$/g, "");
    const port = (await collectProcessOutput("gsettings", [
      "get", `org.gnome.system.proxy.${protocol}`, "port"
    ]))?.trim();
    if (host && port && /^\d+$/.test(port)) {
      try {
        return normalizeCodexProxyUrl(`http://${host}:${port}`);
      } catch {
        // Try the next protocol.
      }
    }
  }
  return undefined;
}

function collectProcessOutput(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(command, args);
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => resolve(code === 0 ? output : undefined));
  });
}

function queryWindowsInternetProxy(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn("reg.exe", [
      "query",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"
    ]);
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => {
      if (code !== 0 || !/^\s*ProxyEnable\s+REG_DWORD\s+0x1\s*$/im.test(output)) {
        resolve(undefined);
        return;
      }
      const proxyServer = output.match(/^\s*ProxyServer\s+REG_SZ\s+(.+?)\s*$/im)?.[1];
      if (!proxyServer) {
        resolve(undefined);
        return;
      }
      try {
        resolve(parseWindowsProxyServer(proxyServer));
      } catch {
        resolve(undefined);
      }
    });
  });
}

function serializeManagedCodexProviders(providers: CodexProviderProfile[]): string {
  const providerBlocks = providers.map((provider) => {
    const keyFile = getCodexApiKeyFile(provider);
    const auth = createCodexAuthConfig(process.platform, CODEX_AUTH_HELPER_FILE, keyFile);
    return [
      `[model_providers.${JSON.stringify(provider.id)}]`,
      `name = ${JSON.stringify(provider.name)}`,
      `base_url = ${JSON.stringify(getCodexApiBaseUrl(provider.baseUrl))}`,
      `wire_api = "responses"`,
      ``,
      `[model_providers.${JSON.stringify(provider.id)}.auth]`,
      `command = ${JSON.stringify(auth.command)}`,
      `args = [${auth.args.map((argument) => JSON.stringify(argument)).join(", ")}]`
    ].join("\n");
  });
  return [CODEX_MANAGED_BEGIN, ...providerBlocks, CODEX_MANAGED_END].join("\n");
}

const CODEX_AUTH_HELPER_FILE = path.join(
  os.homedir(),
  ".codex",
  process.platform === "win32"
    ? "ai-provider-switcher-codex-auth.ps1"
    : "ai-provider-switcher-codex-auth.sh"
);

async function ensureCodexAuthHelper(): Promise<void> {
  await fs.mkdir(path.dirname(CODEX_AUTH_HELPER_FILE), { recursive: true });
  if (process.platform !== "win32") {
    const helper = [
      "#!/bin/sh",
      "set -eu",
      "if [ \"$#\" -ne 1 ]; then exit 2; fi",
      "exec /bin/cat -- \"$1\""
    ].join("\n") + "\n";
    await fs.writeFile(CODEX_AUTH_HELPER_FILE, helper, { encoding: "utf8", mode: 0o700 });
    await fs.chmod(CODEX_AUTH_HELPER_FILE, 0o700);
    return;
  }
  const helper = [
    "$ErrorActionPreference = 'Stop'",
    "$encrypted = (Get-Content -Raw -LiteralPath $args[0]).Trim()",
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
  if (process.platform !== "win32") {
    await fs.mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 });
    await fs.writeFile(keyFile, `${apiKey}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(keyFile, 0o600);
    return;
  }
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
    .map((item) => {
      const baseUrl = normalizeClaudeProviderBaseUrl(String(item.baseUrl ?? ""));
      return {
        id: String(item.id ?? "").trim(),
        name: String(item.name ?? "").trim(),
        baseUrl,
        modelMapping: normalizeClaudeModelMapping(item.modelMapping) ??
          (isDeepSeekAnthropicApi(baseUrl) ? getDeepSeekClaudeModelMapping() : undefined),
        permissionStrategy: normalizeClaudePermissionStrategy(item.permissionStrategy),
        usage: normalizeUsageConfiguration(item.usage)
      };
    })
    .filter((gateway) => gateway.id && gateway.name && gateway.baseUrl);
}

function getCurrentClaudeProvider(): GatewayProfile | undefined {
  const providers = getGateways();
  const envVars = getClaudeEnvVars();
  const byEnvironment = findClaudeProviderByEnvironment(envVars, providers);
  if (byEnvironment) return byEnvironment;
  if (findEnvValue(envVars, "ANTHROPIC_BASE_URL")?.trim()) return undefined;
  const activeId = vscode.workspace
    .getConfiguration("aiProviderSwitcher")
    .get<string>(CLAUDE_ACTIVE_PROVIDER_KEY, "");
  return providers.find((provider) => provider.id === activeId);
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

  return clearInheritedClaudeProviderEnvVars(keep);
}

function clearClaudeProviderEnvVars(existing: EnvVar[]): EnvVar[] {
  const keep = existing.filter((entry) => !MANAGED_ENV_KEYS.has(entry.name));
  return clearInheritedClaudeProviderEnvVars(keep);
}

function clearInheritedClaudeProviderEnvVars(envVars: EnvVar[]): EnvVar[] {
  const present = new Set(envVars.map((entry) => entry.name));
  for (const name of MANAGED_ENV_KEYS) {
    if (!present.has(name) && process.env[name]) {
      envVars.push({ name, value: "" });
    }
  }
  return envVars;
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
  const claudeProvider = getCurrentClaudeProvider();
  const claudeLabel = mode === ProviderMode.Gateway
    ? `Claude: ${claudeProvider?.name ?? "Custom"}`
    : "Claude: Official";
  const codexLabel = codexProvider
    ? `Codex: ${codexProvider.name}${codexModel ? `/${codexModel}` : ""}`
    : "Codex: Official";
  statusBarItem.text = `${claudeLabel} · ${codexLabel}`;
  statusBarItem.tooltip = "打开 AI Provider Switcher 可视化管理界面";
  statusBarItem.show();
}
