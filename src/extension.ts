import * as vscode from "vscode";
import * as https from "node:https";
import * as http from "node:http";
import { IncomingHttpHeaders } from "node:http";
import { randomUUID } from "node:crypto";
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
  createCodexProviderId,
  findUnmanagedCodexProxyEnv,
  getCodexApiBaseUrl,
  normalizeCodexProxyUrl,
  normalizeProviderRootUrl,
  parseCodexModelIds,
  parseKdeProxySettings,
  parseMacOsProxyConfiguration,
  parseWindowsProxyServer,
  parseTopLevelTomlString,
  resolveCodexHomeDir,
  removeManagedCodexEnv,
  removeManagedCodexProviders,
  removeUnmanagedCodexProxyEnv,
  replaceManagedCodexProviders,
  updateManagedCodexEnv,
  updateTopLevelTomlKey
} from "./codexConfig";
import {
  CODEX_UNIFIED_PROVIDER_ID,
  CODEX_UNIFY_BACKUP_NAME,
  CODEX_UNIFY_RESTORE_BACKUP_NAME,
  CodexUnifyMigrationOutcome,
  CodexUnifyRestoreOutcome,
  canonicalCodexDirKey,
  hasCodexCustomProviderSection,
  hasCodexUnifyBackup,
  migrateCodexHistoryToUnifiedBucket,
  restoreCodexHistoryFromBackups,
  serializeCodexUnifiedOfficialBlock,
  serializeCodexUnifiedProviderBlock,
  summarizeCodexUnifyFailures
} from "./codexHistory";
import {
  ProviderManagerAction,
  ProviderManagerActionResult,
  ProviderManagerDraft,
  ProviderManagerMessage,
  ProviderManagerPanel,
  ProviderManagerState,
  ProviderModelFormPayload,
  ProviderModelRow
} from "./providerManagerPanel";
import {
  ProviderEditDraft,
  applyProviderOrder,
  describeProviderEditOutcome,
  planProviderEdit
} from "./providerEdit";
import {
  describeGatewayModelFailure,
  getGatewayModelEndpoints,
  isGatewayModelPathMiss,
  parseGatewayModelList
} from "./gatewayModels";
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
  clearClaudeManagedJsonEnv,
  createClaudeModelEnvironment,
  createClaudeModelMapping,
  findClaudeProviderByEnvironment,
  getDeepSeekClaudeModelMapping,
  hasNonClaudeModelIds,
  inspectClaudeEnvironment,
  inspectClaudeSettingsJson,
  isDeepSeekAnthropicApi,
  isClaudeAutoClassifierCompatible,
  mapClaudeDesktopModelName,
  mergeClaudeJsonEnv,
  normalizeClaudeModelMapping,
  parseClaudeJsonObject,
  suggestClaudeModelRoles,
  normalizeClaudePermissionStrategy,
  normalizeClaudeProviderBaseUrl,
  stripClaudeProviderSettingsJson
} from "./claudeConfig";
import { startClaudeProxy, type ClaudeProxy } from "./claudeProxy";
import { startLocalAdapterServer, type LocalAdapterServer, type AdapterBindingTarget } from "./localAdapterServer";
import { resolveLocalPort, type LocalPortChoice } from "./localPort";
import {
  applyClaudeDesktopEntry,
  buildClaudeDesktopGatewayConfig,
  CLAUDE_DESKTOP_GENERIC_TIER_ALIASES,
  buildClaudeDesktopAliasEntries,
  buildClaudeDesktopModelEntries,
  isClaudeDesktopCompatibleModel,
  resolveDesktopAlias1m,
  CLAUDE_DESKTOP_1P_MODE,
  CLAUDE_DESKTOP_3P_MODE,
  findClaudeDesktopInstall,
  getClaudeDesktopEntryFile,
  getClaudeDesktopRootCandidates,
  getClaudeDesktopWriteLayouts,
  parseClaudeDesktopMeta,
  readClaudeDesktopGateway,
  readOptionalFile,
  removeClaudeDesktopEntry,
  serializeClaudeDesktopMeta,
  setClaudeDesktopDeploymentMode,
  toClaudeDesktopEntryId,
  toClaudeDesktopRouteId,
  buildClaudeDesktopRouteEntries,
  buildClaudeDesktopRoutes,
  stripClaudeDesktopRouteSuffix,
  type ClaudeDesktopInstall,
  type ClaudeDesktopLayout,
  type ClaudeDesktopModelEntry,
  type ClaudeDesktopRoute
} from "./claudeDesktop";
import {
  describeRemoteConfigScope,
  describeRemoteDesktopLimit,
  describeRemoteEnvironment,
  describeRemoteProxyRisk,
  type RemoteEnvironment
} from "./remoteEnvironment";

type ProtocolAdapterBinding = {
  id: string;
  direction: "anthropicToResponses" | "responsesToAnthropic";
  upstreamKind: "claudeGateway" | "codexProvider";
  upstreamId: string;
  textOnly: true;
};

type EnvVar = { name: string; value: string };
type GatewayProfile = {
  id: string;
  name: string;
  baseUrl: string;
  modelMapping?: ClaudeModelMapping;
  permissionStrategy?: ClaudePermissionStrategy;
  usage?: ProviderUsageConfiguration;
  /**
   * Anthropic-style IDs to offer Claude Desktop instead of the gateway's own
   * model names, for gateways whose real names the desktop app refuses.
   */
  desktopModels?: string[];
  /** Aliases whose desktop entries advertise the 1M-context variant. */
  desktopModel1m?: string[];
  /**
   * Explicit per-model Desktop routes. The real IDs are kept here while the
   * desktop app gets opaque Claude-safe route IDs and the local proxy maps back.
   */
  desktopRoutes?: ClaudeDesktopRoute[];
  /** Explicit opt-in local Responses → Messages protocol conversion binding. */
  adapter?: ProtocolAdapterBinding;
};
type GatewayModels = { gatewayId: string; models: string[]; updatedAt: string };
type CodexProviderProfile = {
  id: string;
  name: string;
  baseUrl: string;
  usage?: ProviderUsageConfiguration;
  /** Explicit opt-in local Messages → Responses protocol conversion binding. */
  adapter?: ProtocolAdapterBinding;
};
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
const CLAUDE_DESKTOP_ROOT_KEY = "claudeDesktopConfigRoot";
const CLAUDE_PROXY_PORT_KEY = "claudeProxyPort";
const PROTOCOL_ADAPTER_PORT_KEY = "protocolAdapterPort";
const PROTOCOL_ADAPTER_SECRET_KEY_PREFIX = "aiProviderSwitcher.protocolAdapter.localToken.";

function configuredLocalPort(kind: "claudeProxy" | "protocolAdapter"): LocalPortChoice {
  const key = kind === "claudeProxy" ? CLAUDE_PROXY_PORT_KEY : PROTOCOL_ADAPTER_PORT_KEY;
  const config = vscode.workspace.getConfiguration("aiProviderSwitcher");
  const inspected = config.inspect<number>(key);
  const explicitlySet = inspected?.globalValue !== undefined || inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined;
  return resolveLocalPort({
    kind,
    configured: config.get<number>(key),
    configuredExplicitly: explicitlySet,
    platform: process.platform,
    uid: process.getuid?.()
  });
}

function portDescription(choice: LocalPortChoice, key: string): string {
  if (choice.source === "linux-user") return `Linux 多用户自动端口 ${choice.port}（按当前 UID 稳定生成）。`;
  if (choice.source === "manual") return `使用手动设置的端口 ${choice.port}（${key}）。`;
  return `使用默认端口 ${choice.port}。`;
}

function protocolAdapterPort(): number {
  return configuredLocalPort("protocolAdapter").port;
}

function protocolAdapterBaseUrl(binding: ProtocolAdapterBinding): string {
  const target = binding.direction === "responsesToAnthropic" ? "codex" : "claude";
  return `http://127.0.0.1:${protocolAdapterPort()}/${target}/${binding.id}`;
}
const CLAUDE_USER_SETTINGS_FILE = path.join(os.homedir(), ".claude", "settings.json");
const CODEX_SECRET_KEY_PREFIX = "aiProviderSwitcher.codex.apiKey.";
const CODEX_PROVIDERS_KEY = "codexProviders";
const CODEX_MODELS_KEY = "codexModels";
const CODEX_ACTIVE_PROVIDER_KEY = "codexActiveProviderId";
const CODEX_ACTIVE_MODEL_KEY = "codexActiveModel";
/**
 * Every Codex path must go through here. Codex honours CODEX_HOME, so hardcoding
 * ~/.codex wrote provider blocks and API keys into a directory Codex never reads —
 * with no error to show for it, the switch simply appeared to do nothing.
 */
const CODEX_HOME_DIR = resolveCodexHomeDir(process.env, os.homedir());
const CODEX_CONFIG_FILE = path.join(CODEX_HOME_DIR, "config.toml");
const CODEX_MODEL_CATALOG_FILE = path.join(CODEX_HOME_DIR, "ai-provider-switcher-models.json");
const CODEX_ENV_FILE = path.join(CODEX_HOME_DIR, ".env");
const CODEX_BACKUP_KEY = "codex.originalTopLevelConfig";
const CODEX_PROXY_URL_KEY = "codexProxyUrl";
const CODEX_PROXY_MODE_KEY = "codexProxyMode";
const CODEX_UNIFY_HISTORY_KEY = "unifyCodexSessionHistory";
const CODEX_UNIFY_MIGRATE_KEY = "unifyCodexMigrateExisting";
const CODEX_UNIFY_MIGRATION_MARKER_KEY = "codex.unifyMigrationMarker";
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
    vscode.commands.registerCommand("aiProviderSwitcher.switchClaudeDesktop", () =>
      switchClaudeDesktop(context)
    ),
    vscode.commands.registerCommand("aiProviderSwitcher.manageGateways", () => manageGateways(context)),
    vscode.commands.registerCommand("aiProviderSwitcher.addGateway", () => addGateway()),
    vscode.commands.registerCommand("aiProviderSwitcher.editGateway", () => editGateway(context)),
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
    vscode.commands.registerCommand("aiProviderSwitcher.configureClaudeDesktopModels", () =>
      configureClaudeDesktopModels()
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
    vscode.commands.registerCommand("aiProviderSwitcher.editCodexProvider", () =>
      editCodexProvider(context)
    ),
    vscode.commands.registerCommand("aiProviderSwitcher.removeCodexProvider", () =>
      removeCodexProvider(context)
    ),
    vscode.commands.registerCommand("aiProviderSwitcher.clearCodexApiKey", () =>
      clearCodexApiKey(context)
    ),
    vscode.commands.registerCommand("aiProviderSwitcher.refreshCodexModels", () =>
      refreshCodexModels(context)
    ),
    vscode.commands.registerCommand("aiProviderSwitcher.configureCodexModel", () =>
      configureCodexModel(context)
    ),
    vscode.commands.registerCommand("aiProviderSwitcher.showCodexModels", () => showCodexModels()),
    vscode.commands.registerCommand("aiProviderSwitcher.configureCodexProxy", () =>
      configureCodexProxy()
    ),
    vscode.commands.registerCommand("aiProviderSwitcher.unifyCodexHistory", () =>
      toggleCodexUnifiedHistory(context)
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

  // The proxy resolver reads the desktop snapshot. Refresh it first so a Desktop
  // already configured to use 127.0.0.1 cannot send its first request during
  // activation before the entry id has identified its provider.
  void (async () => {
    await refreshStatusBar();
    await startClaudeProxyForExtension(context);
    await startProtocolAdapterForExtension(context);
  })();

  // Retry a deferred unified-history migration (e.g. it was skipped because the
  // live config was not yet routed to the shared bucket). Best effort only.
  void (async () => {
    try {
      await retryCodexUnifiedMigration(context);
    } catch {
      // Startup retry must never surface an error.
    }
  })();
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

function openProviderManager(
  context: vscode.ExtensionContext,
  focus?: { kind: "claude" | "codex"; id: string; edit?: boolean; modelSurface?: "code" | "desktop" }
): void {
  // The desktop state lives on disk, so the first paint uses the last snapshot
  // and a fresh read re-paints the panel as soon as it resolves.
  void refreshClaudeDesktopSnapshot().then(() => ProviderManagerPanel.refresh());
  ProviderManagerPanel.show(
    context.extensionUri,
    () => getProviderManagerState(),
    async (message) => handleProviderManagerAction(context, message),
    focus
  );
}

/**
 * Which machine this extension host is running on. In a Remote-SSH / WSL /
 * container window every path the extension touches is the remote host's, so
 * most user-facing messages need to say so.
 */
function getRemoteEnvironment(): RemoteEnvironment {
  return describeRemoteEnvironment(vscode.env.remoteName);
}

function getProviderManagerState(): ProviderManagerState {
  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  const models = new Map(getCodexModels().map((entry) => [entry.providerId, entry.models.length]));
  const usage = new Map(getProviderUsageSnapshots().map((entry) => [`${entry.providerKind}:${entry.providerId}`, entry]));
  const currentClaudeProvider = getCurrentClaudeProvider();
  const activeCodexId = settings.get<string>(CODEX_ACTIVE_PROVIDER_KEY, "");
  return {
    claudeMode: currentClaudeProvider?.name ?? (getCurrentMode() === ProviderMode.Official ? "官方服务" : "未识别的自定义服务"),
    claudeOfficial: getCurrentMode() === ProviderMode.Official,
    claudeDesktopMode: claudeDesktopSnapshot.label,
    claudeDesktopOfficial: claudeDesktopSnapshot.official,
    remoteNotice: describeRemoteConfigScope(getRemoteEnvironment().kind),
    claudeProviders: getGateways().map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      active: provider.id === currentClaudeProvider?.id,
      mapping: provider.modelMapping
        ? `${provider.modelMapping.mainModel} / 快速：${provider.modelMapping.haikuModel}${isMainModelLongContext(provider.modelMapping) ? " / 1M" : ""}`
        : "未配置",
      permissionStrategy: getClaudePermissionStrategyLabel(provider.permissionStrategy),
      hasUsageConfig: Boolean(provider.usage),
      usageEndpoint: provider.usage?.endpoint,
      usageMappings: formatUsageMappings(provider.usage),
      usage: formatProviderUsageSummary(usage.get(`claude:${provider.id}`)),
      modelList: claudeModelRows(provider),
      // "" is "never configured", which is a different thing from "auto" — auto is
      // a value that gets written. Defaulting to auto here made simply opening the
      // editor and saving add CLAUDE_CODE_EFFORT_LEVEL to a provider that had none.
      effortLevel: provider.modelMapping?.effortLevel ?? "",
      desktopModels: desktopAliasRows(provider),
      desktopRoutes: desktopRouteRows(provider),
      desktopActive: claudeDesktopSnapshot.providerId === provider.id,
      desktopAliasRequired: desktopAliasRequired(provider),
      adapterDescription: provider.adapter
        ? `实验性本地协议转换 · 仅文本 / 流式 · 上游：${provider.adapter.upstreamId}`
        : undefined
    })),
    codexMode: getCodexModeLabel(),
    codexOfficial: !getCodexProviders().some((provider) => provider.id === activeCodexId),
    codexModel: settings.get<string>(CODEX_ACTIVE_MODEL_KEY, ""),
    codexUnifiedHistory: settings.get<boolean>(CODEX_UNIFY_HISTORY_KEY, false),
    codexProviders: getCodexProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      active: provider.id === activeCodexId,
      modelCount: models.get(provider.id) ?? 0,
      hasUsageConfig: Boolean(provider.usage),
      usageEndpoint: provider.usage?.endpoint,
      usageMappings: formatUsageMappings(provider.usage),
      usage: formatProviderUsageSummary(usage.get(`codex:${provider.id}`)),
      adapterDescription: provider.adapter
        ? `实验性本地协议转换 · 仅文本 / 流式 · 上游：${provider.adapter.upstreamId}`
        : undefined
    }))
  };
}

function getCodexModeLabel(): string {
  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  const id = settings.get<string>(CODEX_ACTIVE_PROVIDER_KEY, "");
  return getCodexProviders().find((provider) => provider.id === id)?.name ?? "官方服务";
}

/** The model editor rows for one gateway: cached IDs plus the mapping role each one plays. */
function claudeModelRows(gateway: GatewayProfile): ProviderModelRow[] {
  const mapping = gateway.modelMapping;
  const roleOf = (name: string): string => {
    if (!mapping) return "";
    if (name === mapping.mainModel) return "main";
    if (name === mapping.opusModel) return "opus";
    if (name === mapping.sonnetModel) return "sonnet";
    if (name === mapping.haikuModel) return "haiku";
    if (name === mapping.fableModel) return "fable";
    if (name === mapping.subagentModel) return "subagent";
    return "";
  };
  // The 1M switch is keyed by model, not by role, so a model the user left
  // unmapped keeps its declaration instead of losing it on every save.
  const oneM = new Set(mapping?.longContextModels ?? []);
  return (getGatewayModels().find((entry) => entry.gatewayId === gateway.id)?.models ?? []).map(
    (name) => ({ name, role: roleOf(name), supports1m: oneM.has(name) })
  );
}

/** Desktop alias rows: each stored alias with its own 1M switch state. */
function desktopAliasRows(gateway: GatewayProfile): Array<{ name: string; supports1m: boolean }> {
  const aliases = gateway.desktopModels ?? [];
  const oneM = desktopAlias1mFor(gateway);
  return aliases.map((name) => ({ name, supports1m: oneM(name) }));
}

/** Explicit proxy catalogue rows, normalized back to the cached model list. */
function desktopRouteRows(gateway: GatewayProfile): Array<{ name: string; supports1m: boolean }> {
  const cached = getGatewayModels().find((entry) => entry.gatewayId === gateway.id)?.models ?? [];
  const cachedSet = new Set(cached);
  return (gateway.desktopRoutes ?? [])
    .filter((route) => cachedSet.has(route.model))
    .map((route) => ({ name: route.model, supports1m: route.supports1m === true }));
}

/** The gateway's alias 1M rule, shared by the editor rows and the written config. */
function desktopAlias1mFor(gateway: GatewayProfile): (name: string) => boolean {
  return resolveDesktopAlias1m(
    gateway.desktopModels ?? [],
    gateway.desktopModel1m,
    isMainModelLongContext(gateway.modelMapping)
  );
}

/**
 * Whether this gateway can only reach Claude Desktop through aliases: the app
 * refuses every model ID that does not read as an Anthropic route, so a gateway
 * serving its own names has nothing usable to offer without them.
 */
function desktopAliasRequired(gateway: GatewayProfile): boolean {
  const models = getGatewayModels().find((entry) => entry.gatewayId === gateway.id)?.models ?? [];
  return models.length > 0 && !models.some((name) => isClaudeDesktopCompatibleModel(name));
}

/** Whether the gateway's main model is declared 1M, reading stored legacy data too. */
function isMainModelLongContext(mapping: ClaudeModelMapping | undefined): boolean {
  const normalized = normalizeClaudeModelMapping(mapping);
  return normalized ? (normalized.longContextModels ?? []).includes(normalized.mainModel) : false;
}

/**
 * Persists the per-provider model editor: the model list becomes the gateway's
 * model cache, the role assignments become its model mapping (plus effort and
 * the 1M declaration), and the desktop aliases are stored alongside. A form the
 * user left unassignable is rejected and kept open rather than silently
 * dropping the mapping.
 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

/**
 * Fills the six mapping roles from the model names alone, so the common case
 * costs one click instead of an understanding of what `fable` or `subagent`
 * select. Only the roles are rewritten: the 1M switches and the model list the
 * user typed are carried through untouched.
 */
function autoAssignProviderModelRoles(
  form: ProviderModelFormPayload
): ProviderManagerActionResult {
  const suggested = new Map(
    suggestClaudeModelRoles(form.models.map((row) => row.name)).map((row) => [row.name, row.role])
  );
  const models = form.models.map((row) => ({
    ...row,
    role: suggested.get(row.name.trim()) ?? ""
  }));
  if (!models.some((row) => row.role === "main")) {
    return { keepEditing: true, modelForm: { ...form, models }, message: "请先填写至少一个模型 ID。" };
  }
  const main = models.find((row) => row.role === "main")?.name;
  const fast = models.find((row) => row.role === "haiku")?.name;
  return {
    keepEditing: true,
    modelForm: { ...form, models },
    message: fast && fast !== main
      ? `已按模型名分配：主模型 ${main}，快速模型 ${fast}。未指派的角色会回落到它们，可手动调整。`
      : `已把 ${main} 设为主模型，其余角色都会回落到它。`
  };
}

/**
 * Pulls the provider's model list from `/v1/models` without leaving the form.
 * Rows already on screen keep their role and 1M switch — a refresh is meant to
 * add what the provider now serves, not to discard a configuration in progress.
 */
async function fetchProviderModelsIntoForm(
  context: vscode.ExtensionContext,
  gatewayId: string,
  form: ProviderModelFormPayload
): Promise<ProviderManagerActionResult> {
  const gateway = getGateways().find((item) => item.id === gatewayId);
  if (!gateway) return { keepEditing: true, message: "找不到该服务。" };
  const token = await getStoredGatewayToken(context, gateway);
  if (!token) {
    return { keepEditing: true, modelForm: form, message: "还没有保存该服务的凭据，请先编辑服务填写 Token。" };
  }
  let fetched: string[];
  try {
    fetched = (await requestGatewayModels(gateway.baseUrl, token)).models;
  } catch (error) {
    return { keepEditing: true, modelForm: form, message: `获取模型列表失败：${errorText(error)}` };
  }
  if (fetched.length === 0) {
    return { keepEditing: true, modelForm: form, message: "该服务没有返回任何模型，请手动填写模型 ID。" };
  }
  const known = new Set(form.models.map((row) => row.name.trim()).filter((name) => name !== ""));
  const added = fetched.filter((name) => !known.has(name));
  const models = [
    ...form.models,
    ...added.map((name) => ({ name, role: "", supports1m: false }))
  ];
  await saveGatewayModels(gateway.id, models.map((row) => row.name.trim()).filter((name) => name !== ""));
  return {
    keepEditing: true,
    modelForm: { ...form, models },
    message: added.length > 0
      ? `获取到 ${fetched.length} 个模型，新增 ${added.length} 个。可点击“自动分配角色”。`
      : `获取到 ${fetched.length} 个模型，均已在列表中。`
  };
}

async function saveClaudeCodeModels(
  context: vscode.ExtensionContext,
  gatewayId: string,
  form: ProviderModelFormPayload
): Promise<ProviderManagerActionResult | void> {
  const gateway = getGateways().find((item) => item.id === gatewayId);
  if (!gateway) return undefined;
  const seen = new Set<string>();
  const names: string[] = [];
  const duplicates: string[] = [];
  for (const row of form.models) {
    const name = row.name.trim();
    if (!name) continue;
    if (seen.has(name)) { duplicates.push(name); continue; }
    seen.add(name);
    names.push(name);
  }
  if (names.length === 0) {
    return { keepEditing: true, modelForm: { ...form, surface: "code" }, message: "请至少填写一个模型 ID。" };
  }
  const pick = (role: string): string | undefined =>
    form.models.find((item) => item.role === role && item.name.trim())?.name.trim();
  const longContextModels = names.filter((name) =>
    form.models.some((item) => item.name.trim() === name && item.supports1m)
  );
  const mapping = normalizeClaudeModelMapping({
    mainModel: pick("main"), opusModel: pick("opus"), sonnetModel: pick("sonnet"),
    haikuModel: pick("haiku"), fableModel: pick("fable"), subagentModel: pick("subagent"),
    effortLevel: form.effort, longContextModels
  });
  if (!mapping) {
    return {
      keepEditing: true,
      modelForm: { ...form, surface: "code" },
      message: "请先把其中一个模型设为“主模型”，其余角色可留空（会回落到主模型）。"
    };
  }
  await saveGatewayModels(gateway.id, names);
  // This editor owns only the Claude Code mapping. Desktop routes and aliases
  // are deliberately copied from the stored provider so a Code save cannot
  // silently replace a Desktop catalogue the user configured separately.
  const updated: GatewayProfile = { ...gateway, modelMapping: mapping };
  await updateGatewayProfile(updated);
  const notes = await applyClaudeCodeModelChange(context, updated, mapping);
  if (duplicates.length > 0) notes.unshift(`已跳过重复模型：${duplicates.join("、")}`);
  vscode.window.showInformationMessage([`已保存“${gateway.name}”的 Claude Code 模型与参数。`, ...notes].join(" "));
  return undefined;
}

async function saveClaudeDesktopModels(
  context: vscode.ExtensionContext,
  gatewayId: string,
  form: ProviderModelFormPayload
): Promise<ProviderManagerActionResult | void> {
  const gateway = getGateways().find((item) => item.id === gatewayId);
  if (!gateway) return undefined;
  const cached = new Set(getGatewayModels().find((entry) => entry.gatewayId === gateway.id)?.models ?? []);
  const desktopRoutes = buildClaudeDesktopRoutes(
    gateway.id,
    (form.desktopRoutes ?? []).filter((row) => cached.has(row.name.trim()))
  );
  const desktopNames: string[] = [];
  const desktop1m: string[] = [];
  const rejected: string[] = [];
  for (const row of form.desktopModels ?? []) {
    const name = row.name.trim();
    if (!name || desktopNames.includes(name)) continue;
    if (!isClaudeDesktopCompatibleModel(name)) { rejected.push(name); continue; }
    desktopNames.push(name);
    if (row.supports1m) desktop1m.push(name);
  }
  if (desktopRoutes.length === 0 && desktopNames.length === 0) {
    return {
      keepEditing: true,
      modelForm: { ...form, surface: "desktop" },
      message: "请至少在全模型目录勾选一个模型，或在高级兼容别名中填写服务商明确支持的名称。"
    };
  }
  // Desktop configuration is independent: never save the role mapping, effort,
  // or CLI 1M declarations from the form submitted by this page.
  const updated: GatewayProfile = {
    ...gateway,
    desktopRoutes: desktopRoutes.length > 0 ? desktopRoutes : undefined,
    desktopModels: desktopNames.length > 0 ? desktopNames : undefined,
    desktopModel1m: desktopNames.length > 0 ? desktop1m : undefined
  };
  await updateGatewayProfile(updated);
  const notes: string[] = [];
  if (rejected.length > 0) notes.push(`已跳过 Desktop 不接受的兼容别名：${rejected.join("、")}`);
  if (claudeDesktopSnapshot.providerId === gateway.id) {
    notes.push(await applyClaudeDesktopModelChange(context, updated));
  } else {
    notes.push("该服务尚未被 Claude Desktop 使用；下次切换 Desktop 服务时会带入此目录。");
  }
  vscode.window.showInformationMessage([`已保存“${gateway.name}”的 Claude Desktop 模型。`, ...notes].join(" "));
  return undefined;
}

/** Backward-compatible handler for an older webview: save both old surfaces. */
async function saveClaudeProviderModels(
  context: vscode.ExtensionContext,
  gatewayId: string,
  form: ProviderModelFormPayload
): Promise<ProviderManagerActionResult | void> {
  // Old panels used one Save button. Preserve the previous broad behavior only
  // there; the current UI calls one of the two surface-specific functions.
  const code = await saveClaudeCodeModels(context, gatewayId, { ...form, surface: "code" });
  if (code?.keepEditing) return code;
  return saveClaudeDesktopModels(context, gatewayId, { ...form, surface: "desktop" });
}

/**
 * Pushes a just-saved model configuration to wherever that provider is already
 * live. Saving used to only tell the user to go re-apply the provider by hand,
 * which left the VS Code environment, the terminal CLI and the desktop app all
 * running the previous models while the panel reported success. Returns the
 * notes to append to the save message; a failure degrades to a note rather than
 * failing the save, since the configuration itself is already stored.
 */
async function applyClaudeCodeModelChange(
  context: vscode.ExtensionContext,
  gateway: GatewayProfile,
  mapping: ClaudeModelMapping
): Promise<string[]> {
  const notes: string[] = [];
  if (getCurrentClaudeProvider()?.id === gateway.id) {
    try {
      const applied = [
        ...removeClaudeModelEnvironment(getClaudeEnvVars()),
        ...createClaudeModelEnvironment(mapping)
      ];
      await updateClaudeEnvVars(applied);
      await syncClaudeUserSettingsEnv(applied);
      notes.push("已应用到 VS Code 与终端 CLI。");
    } catch (error) {
      notes.push(`应用到 VS Code / CLI 失败：${errorText(error)}`);
    }
  }
  if (notes.some((note) => note.startsWith("已应用到 VS Code"))) {
    await offerReload(`已保存并应用“${gateway.name}”的 Claude Code 模型配置。需要重新加载 VS Code 才会生效，是否立即重载？`);
  }
  return notes;
}

/**
 * Legacy combined apply helper. New UI calls the Code or Desktop path explicitly
 * so an edit in one product cannot silently rewrite the other product's config.
 */
async function applyClaudeProviderModelChange(
  context: vscode.ExtensionContext,
  gateway: GatewayProfile,
  mapping: ClaudeModelMapping
): Promise<string[]> {
  const notes: string[] = [];
  if (getCurrentClaudeProvider()?.id === gateway.id) {
    try {
      const applied = [
        ...removeClaudeModelEnvironment(getClaudeEnvVars()),
        ...createClaudeModelEnvironment(mapping)
      ];
      await updateClaudeEnvVars(applied);
      await syncClaudeUserSettingsEnv(applied);
      notes.push("已应用到 VS Code 与终端 CLI。");
    } catch (error) {
      notes.push(`应用到 VS Code / CLI 失败：${errorText(error)}`);
    }
  }
  if (claudeDesktopSnapshot.providerId === gateway.id) {
    notes.push(await applyClaudeDesktopModelChange(context, gateway));
  }
  if (notes.some((note) => note.startsWith("已应用到 VS Code"))) {
    await offerReload(`已保存并应用“${gateway.name}”的模型配置。需要重新加载 VS Code 才会生效，是否立即重载？`);
  }
  return notes;
}

/**
 * Rewrites the desktop config for a provider that is already the live desktop
 * one, so a model change reaches the app without a second trip through the
 * desktop switch. Deliberately silent about credentials: a missing stored token
 * is reported rather than prompted for, because this runs as a side effect of
 * saving a form, not as a switch the user just asked for.
 */
async function applyClaudeDesktopModelChange(
  context: vscode.ExtensionContext,
  gateway: GatewayProfile
): Promise<string> {
  try {
    const install = await locateClaudeDesktopInstall();
    if (!install) return "未找到 Claude Desktop 数据目录，桌面配置未更新。";
    const token = await getStoredGatewayToken(context, gateway);
    if (!token) return "未找到已保存的凭据，桌面配置未更新，请重新执行“切换 Claude Desktop 服务”。";
    const { entries } = getClaudeDesktopModelEntries(gateway);
    // Writing an empty list is what leaves the desktop picker blank and every
    // message failing, so it is refused here the same way the switch refuses it.
    if (entries.length === 0) {
      return "没有 Claude Desktop 能接受的模型名，桌面配置未更新——请填写“Claude Desktop 模型名”。";
    }
    await applyClaudeDesktopGateway(install, gateway, token, entries);
    await refreshStatusBar();
    return `桌面配置已更新。${describeClaudeDesktopRestart()}`;
  } catch (error) {
    return `更新 Claude Desktop 配置失败：${errorText(error)}`;
  }
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
): Promise<ProviderManagerActionResult | void> {
  const action = message.action;
  if (!action) return;
  const targeted = message.providerKind && message.providerId
    ? getUsageProviderById(message.providerKind, message.providerId)
    : undefined;
  if (action === "configureCurrentClaudeCodeModels") {
    const current = getCurrentClaudeProvider();
    if (!current) {
      vscode.window.showInformationMessage("Claude Code 当前使用官方订阅。请先切换到一个中转站，再配置它的 Claude Code 模型。");
      return;
    }
    openProviderManager(context, { kind: "claude", id: current.id, modelSurface: "code" });
    return;
  }
  if (action === "configureCurrentClaudeDesktopModels") {
    const current = claudeDesktopSnapshot.providerId
      ? getGateways().find((gateway) => gateway.id === claudeDesktopSnapshot.providerId)
      : undefined;
    if (!current) {
      vscode.window.showInformationMessage("Claude Desktop 当前使用官方或未识别的服务。请先切换 Claude Desktop 服务，再配置它的模型目录。");
      return;
    }
    openProviderManager(context, { kind: "claude", id: current.id, modelSurface: "desktop" });
    return;
  }
  if (action === "createAdapterForCodex" || action === "createAdapterForClaude") {
    const upstreams = action === "createAdapterForCodex" ? getGateways() : getCodexProviders();
    if (upstreams.length === 0) {
      vscode.window.showInformationMessage(action === "createAdapterForCodex"
        ? "还没有 Anthropic 服务。请先在服务库添加 Claude 服务，再创建 Codex 文本协议转换。"
        : "还没有 OpenAI Responses 服务。请先在服务库添加 Codex 服务，再创建 Claude 文本协议转换。");
      return;
    }
    const selected = await vscode.window.showQuickPick(
      upstreams.map((provider) => ({ label: provider.name, description: provider.baseUrl, provider })),
      { title: action === "createAdapterForCodex" ? "选择要接入 Codex 的 Anthropic 上游服务" : "选择要接入 Claude 的 OpenAI Responses 上游服务", placeHolder: "只用于实验性文本/流式协议转换；不会修改原有直连服务" }
    );
    if (!selected) return;
    const name = await vscode.window.showInputBox({
      title: "命名实验性本地转换服务",
      prompt: "该名称只显示在目标客户端的服务列表中；上游服务不会被修改。",
      value: `${selected.provider.name}（协议转换）`,
      validateInput: (value) => value.trim() ? undefined : "请输入名称"
    });
    if (!name?.trim()) return;
    const proceed = await vscode.window.showWarningMessage(
      `将创建“${name.trim()}”。它只支持普通文本与流式输出；工具调用、图片、文件、推理和完整 Agent 编码会被明确拒绝。原有服务不会被修改。是否继续？`,
      { modal: true }, "创建实验性绑定", "取消"
    );
    if (proceed !== "创建实验性绑定") return;
    await createProtocolAdapterBinding(
      context,
      action === "createAdapterForCodex" ? "responsesToAnthropic" : "anthropicToResponses",
      action === "createAdapterForCodex" ? "claudeGateway" : "codexProvider",
      selected.provider.id,
      name.trim()
    );
    return;
  }
  if (action === "saveProviderEdit") {
    if (!message.providerKind || !message.providerId || !message.draft) {
      return { keepEditing: true, message: "表单数据不完整，请重试。" };
    }
    return message.providerKind === "claude"
      ? saveClaudeProviderEdit(context, message.providerId, message.draft)
      : saveCodexProviderEdit(context, message.providerId, message.draft);
  }
  if (action === "saveProviderModels" && message.providerId && message.modelForm) {
    // Compatibility for a stale webview from an older extension build.
    return saveClaudeProviderModels(context, message.providerId, message.modelForm);
  }
  if (action === "saveClaudeCodeModels" && message.providerId && message.modelForm) {
    return saveClaudeCodeModels(context, message.providerId, message.modelForm);
  }
  if (action === "saveClaudeDesktopModels" && message.providerId && message.modelForm) {
    return saveClaudeDesktopModels(context, message.providerId, message.modelForm);
  }
  if (action === "autoAssignModelRoles" && message.providerId && message.modelForm) {
    return autoAssignProviderModelRoles(message.modelForm);
  }
  if (action === "fetchProviderModels" && message.providerId && message.modelForm) {
    return fetchProviderModelsIntoForm(context, message.providerId, message.modelForm);
  }
  if (action === "reorderProviders" && message.providerKind && message.order) {
    await reorderProviders(message.providerKind, message.order);
    return;
  }
  if (action === "removeProvider" && message.providerKind && message.providerId) {
    if (message.providerKind === "claude") {
      await removeGateway(context, getGateways().find((item) => item.id === message.providerId));
    } else {
      await removeCodexProvider(context, getCodexProviders().find((item) => item.id === message.providerId));
    }
    return;
  }
  if (action === "addClaudeProvider") {
    await addGateway();
    return;
  }
  if (action === "addCodexProvider") {
    await addCodexProvider();
    return;
  }
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
  if (action === "switchClaudeDesktop") await switchClaudeDesktop(context);
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
  if (action === "codexUnify") await toggleCodexUnifiedHistory(context);
  if (action === "refreshCodex") await refreshCodexModels(context, message.providerKind === "codex" ? getCodexProviders().find((item) => item.id === message.providerId) : undefined);
  if (action === "configureCodexModel") await configureCodexModel(context, message.providerKind === "codex" ? getCodexProviders().find((item) => item.id === message.providerId) : undefined);
  if (action === "configureCodexProxy") await configureCodexProxy();
  if (action === "refreshUsage") await refreshProviderUsage(context);
  if (action === "configureUsage") await configureProviderUsage(context);
  if (action === "manageUsage") await manageProviderUsage(context);
  if (action === "openCodex") await vscode.commands.executeCommand("chatgpt.openSidebar");
}

/**
 * Persists a drag-and-drop reorder. The stored array order is what the quick-switch list, the
 * management menus, and the manager all read, so it is the only thing that has to change — the
 * active provider is tracked by ID everywhere, never by position.
 */
async function reorderProviders(kind: "claude" | "codex", order: string[]): Promise<void> {
  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  if (kind === "claude") {
    await settings.update(
      GATEWAYS_KEY.split(".").slice(1).join("."),
      applyProviderOrder(getGateways(), order),
      vscode.ConfigurationTarget.Global
    );
    return;
  }
  await settings.update(
    CODEX_PROVIDERS_KEY,
    applyProviderOrder(getCodexProviders(), order),
    vscode.ConfigurationTarget.Global
  );
}

async function saveClaudeProviderEdit(
  context: vscode.ExtensionContext,
  id: string,
  draft: ProviderEditDraft
): Promise<ProviderManagerActionResult | void> {
  const gateways = getGateways();
  const gateway = gateways.find((item) => item.id === id);
  if (!gateway) {
    vscode.window.showErrorMessage("该 Claude 中转站已不存在，可能已在别处被删除。");
    return;
  }

  const isActive = getCurrentClaudeProvider()?.id === gateway.id;
  const plan = planProviderEdit("claude", gateway, draft, gateways, isActive);
  // Reported inside the form rather than as a notification, so the message sits next to the fields.
  if (!plan.ok) return { keepEditing: true, message: plan.message };
  if (plan.effects.unchanged) {
    vscode.window.showInformationMessage("没有需要保存的修改。");
    return;
  }

  const updated: GatewayProfile = { ...gateway, name: plan.name, baseUrl: plan.baseUrl };
  await updateGatewayProfile(updated);
  if (plan.secret) {
    await context.secrets.store(`${SECRET_KEY_PREFIX}${gateway.id}`, plan.secret);
    await refreshProtocolAdapterSecrets(context);
  }
  if (plan.effects.clearModelCache) await clearGatewayModels(gateway.id);

  if (plan.effects.rewriteLiveConfig) {
    const token = await context.secrets.get(`${SECRET_KEY_PREFIX}${gateway.id}`);
    if (!token) {
      vscode.window.showWarningMessage(
        `已保存“${updated.name}”，但没有已保存的 Token，实际生效的配置未更新。请切换到该 Provider 并输入 Token。`
      );
      return;
    }
    const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
    let merged = mergeManagedEnvVars(getClaudeEnvVars(), updated.baseUrl, token, settings);
    if (updated.modelMapping) {
      merged = removeClaudeModelEnvironment(merged);
      merged.push(...createClaudeModelEnvironment(updated.modelMapping));
    }
    await updateClaudeEnvVars(merged);
    await syncClaudeUserSettingsEnv(merged);
  }

  // The desktop app stores the endpoint and the key in its own config, so an edit
  // that changed either one leaves it pointing at the old relay with the old
  // plaintext key until this runs. `rewriteLiveConfig` is about VS Code only —
  // a provider can be live on the desktop without being the active one here.
  const desktopNotes: string[] = [];
  if (
    claudeDesktopSnapshot.providerId === gateway.id &&
    (plan.effects.baseUrlChanged || plan.effects.secretChanged)
  ) {
    desktopNotes.push(await applyClaudeDesktopModelChange(context, updated));
  }

  await refreshStatusBar();
  vscode.window.showInformationMessage(
    [describeProviderEditOutcome(updated.name, plan.effects), ...desktopNotes].join(" ")
  );
  if (plan.effects.rewriteLiveConfig) {
    await offerReload(`“${updated.name}”的配置已写入 Claude。需要重新加载 VS Code 才会生效，是否立即重载？`);
  }
}

async function saveCodexProviderEdit(
  context: vscode.ExtensionContext,
  id: string,
  draft: ProviderEditDraft
): Promise<ProviderManagerActionResult | void> {
  const providers = getCodexProviders();
  const provider = providers.find((item) => item.id === id);
  if (!provider) {
    vscode.window.showErrorMessage("该 Codex Provider 已不存在，可能已在别处被删除。");
    return;
  }

  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  const isActive = settings.get<string>(CODEX_ACTIVE_PROVIDER_KEY, "") === provider.id;
  const plan = planProviderEdit("codex", provider, draft, providers, isActive);
  // Reported inside the form rather than as a notification, so the message sits next to the fields.
  if (!plan.ok) return { keepEditing: true, message: plan.message };
  if (plan.effects.unchanged) {
    vscode.window.showInformationMessage("没有需要保存的修改。");
    return;
  }

  const updated: CodexProviderProfile = { ...provider, name: plan.name, baseUrl: plan.baseUrl };
  await settings.update(
    CODEX_PROVIDERS_KEY,
    providers.map((item) => (item.id === provider.id ? updated : item)),
    vscode.ConfigurationTarget.Global
  );
  if (plan.secret) {
    // The key file path is derived from the unchanged provider ID, so the helper keeps working.
    await context.secrets.store(`${CODEX_SECRET_KEY_PREFIX}${provider.id}`, plan.secret);
    await refreshProtocolAdapterSecrets(context);
    await writeCodexApiKeyFile(updated, plan.secret);
  }
  if (plan.effects.clearModelCache) await clearCodexModels(provider.id);

  let managedBlockRefreshed = false;
  if (plan.effects.rewriteManagedBlock) {
    try {
      managedBlockRefreshed = await refreshCodexManagedProviderBlocks();
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      vscode.window.showWarningMessage(
        `已保存“${updated.name}”，但刷新 ${CODEX_CONFIG_FILE} 失败：${message}`
      );
      return;
    }
  }

  await refreshStatusBar();
  vscode.window.showInformationMessage(describeProviderEditOutcome(updated.name, plan.effects));
  if (isActive && (plan.effects.rewriteLiveConfig || managedBlockRefreshed)) {
    await offerReload(
      `“${updated.name}”的配置已写入 ${CODEX_CONFIG_FILE}。${
        plan.effects.clearModelCache ? "模型缓存已清空，请重载后执行“刷新模型”重新同步模型目录。" : ""
      }是否立即重载 VS Code？`
    );
  }
}

/**
 * Rewrites only the managed `[model_providers.*]` blocks, which carry every provider's name and
 * base_url whether or not it is active. The top-level `model_provider` / `model` /
 * `model_catalog_json` keys are deliberately left alone: they are owned by the switch flows, and
 * while the official provider is active they hold the user's own values restored from backup.
 * Returns false when the installation has no managed block yet, so an edit never creates one.
 */
async function refreshCodexManagedProviderBlocks(): Promise<boolean> {
  const content = await readCodexConfiguration();
  if (!content.includes(CODEX_MANAGED_BEGIN)) return false;

  const providers = getCodexProviders();
  const activeId = vscode.workspace
    .getConfiguration("aiProviderSwitcher")
    .get<string>(CODEX_ACTIVE_PROVIDER_KEY, "");
  const active = providers.find((provider) => provider.id === activeId);
  const unifyOn = isCodexUnifiedHistoryEnabled();
  if (providers.length > 0) await ensureCodexAuthHelper();

  const unmanaged = removeManagedCodexProviders(content);
  if (unifyOn && hasCodexCustomProviderSection(unmanaged)) {
    throw new Error(
      "config.toml 已存在手动定义的 [model_providers.custom] 段；为避免把流量路由到未知后端，请先删除该段，或关闭“统一 Codex 会话历史”。"
    );
  }
  await writeCodexConfigurationFile(
    replaceManagedCodexProviders(
      unmanaged,
      serializeManagedCodexProviders(providers, unifyOn ? active ?? "official" : undefined)
    )
  );
  return true;
}

async function clearGatewayModels(gatewayId: string): Promise<void> {
  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  await settings.update(
    GATEWAY_MODELS_KEY,
    getGatewayModels().filter((entry) => entry.gatewayId !== gatewayId),
    vscode.ConfigurationTarget.Global
  );
}

async function clearCodexModels(providerId: string): Promise<void> {
  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  await settings.update(
    CODEX_MODELS_KEY,
    getCodexModels().filter((entry) => entry.providerId !== providerId),
    vscode.ConfigurationTarget.Global
  );
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
  // Only now that the switch is committed: an earlier strip would have left the
  // terminal CLI unconfigured whenever the user backed out above.
  try {
    await clearClaudeUserSettingsManagedEnv();
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    vscode.window.showWarningMessage(
      `已切换到官方订阅，但清理终端 CLI 配置（${CLAUDE_USER_SETTINGS_FILE}）失败：${message}`
    );
  }

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
  await offerReload("Claude 已切换到官方订阅模式。需要重新加载 VS Code 才会让 Claude Code 使用官方订阅（终端 CLI 在下次启动时同步生效）。是否立即重载？");
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
  await syncClaudeUserSettingsEnv(merged);

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
  await offerReload(`Claude 已切换到“${gateway.name}”。需要重新加载 VS Code 才会让 Claude Code 使用该服务（终端 CLI 在下次启动时同步生效）。是否立即重载？`);
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

/**
 * Where an inherited environment variable has to be deleted, per platform. The
 * instruction used to name the Windows dialog on every OS, which on macOS and
 * Linux pointed at a place that does not exist.
 */
function describeInheritedEnvRemoval(): string {
  if (process.platform === "win32") {
    return "请在「设置 → 系统 → 系统信息 → 高级系统设置 → 环境变量」中删除它（用户变量和系统变量都要看），或删除写入它的 PowerShell profile 行。";
  }
  if (process.platform === "darwin") {
    return "请在 ~/.zshrc、~/.zprofile 或 ~/.bash_profile 中删除对应的 export 行；若是用 launchctl setenv 设置的，还需执行 launchctl unsetenv 变量名。";
  }
  return "请在 ~/.bashrc、~/.zshrc、~/.profile 或 ~/.config/environment.d/ 中删除对应的 export 行。";
}

/**
 * What actually protects a stored Codex API key on this platform. Codex reads the
 * key through an auth helper, so a file has to exist next to its config; only
 * Windows can encrypt it at rest, and claiming otherwise elsewhere would hide a
 * real trade-off from the user.
 */
function describeCodexKeyStorage(): string {
  return process.platform === "win32"
    ? `保存在 VS Code Secret Storage，并以 Windows DPAPI 加密写入 ${CODEX_HOME_DIR}（仅当前用户可解密），不会写入 settings.json`
    : `保存在 VS Code Secret Storage，并以仅本人可读（600 权限）的明文文件写入 ${CODEX_HOME_DIR} 供 Codex 读取，不会写入 settings.json`;
}

async function updateClaudeUserDefaultPermissionMode(
  mode: "auto" | "acceptEdits" | "manual"
): Promise<void> {
  const file = CLAUDE_USER_SETTINGS_FILE;
  let original = "{}\n";
  let existed = true;
  try {
    original = await fs.readFile(file, "utf8");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    existed = false;
  }
  // Shared with every other writer: a BOM (Notepad, PowerShell redirection) and an
  // empty file are readable documents, not corruption, and refusing them here used
  // to block the very write that repairs the file.
  const settings = parseClaudeJsonObject(original, "Claude 用户 settings.json");
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
  await writeJsonFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * Replaces a JSON config in one step, so a crash cannot leave a half-written
 * settings file behind.
 *
 * The retry is for Windows: `rename` onto a file another process holds open
 * fails there with EPERM/EBUSY — a running Claude Desktop, an editor with the
 * file open, or an antivirus scanner mid-scan is enough — where POSIX simply
 * replaces the entry. Those failures are usually over in milliseconds, and the
 * one that is not gets an explanation naming the file instead of a bare English
 * error code the user cannot act on.
 */
async function writeJsonFileAtomic(filePath: string, content: string): Promise<void> {
  const temp = `${filePath}.ai-provider-switcher-${process.pid}-${Date.now()}.tmp`;
  await fs.writeFile(temp, content, "utf8");
  const retryable = new Set(["EPERM", "EBUSY", "EACCES"]);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(temp, filePath);
      return;
    } catch (error) {
      const code = isNodeError(error) ? error.code ?? "" : "";
      if (retryable.has(code) && attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
        continue;
      }
      await fs.unlink(temp).catch(() => undefined);
      if (retryable.has(code)) {
        throw new Error(
          `无法写入 ${filePath}（${code}）：该文件正被其他程序占用或为只读。请关闭 Claude Desktop、正在编辑该文件的编辑器，或暂时停用杀毒软件的实时扫描后重试。`
        );
      }
      throw error;
    }
  }
}

/**
 * Narrows an env list down to what may be written into a Claude JSON config.
 *
 * Only managed keys are written: the VS Code list also holds whatever else the
 * user put there (proxies, CA bundles, feature flags), and copying those into
 * ~/.claude/settings.json would leave residue no later switch can clean up,
 * because only managed keys are ever removed again.
 *
 * Empty values are neutralizers for the VS Code configuration, but a JSON config
 * with an empty ANTHROPIC_BASE_URL would be read as a broken endpoint, so blank
 * entries are dropped rather than written.
 */
function filterWritableClaudeEnv(envVars: EnvVar[]): EnvVar[] {
  return envVars.filter(
    (entry) => MANAGED_ENV_KEYS.has(entry.name.trim()) && entry.value.trim().length > 0
  );
}

/**
 * Syncs the managed env keys into ~/.claude/settings.json so the standalone
 * `claude` CLI shares the same gateway as the VS Code integration. Unrelated
 * env entries and every other settings key are preserved.
 */
async function applyClaudeUserSettingsEnv(envVars: EnvVar[]): Promise<void> {
  const file = CLAUDE_USER_SETTINGS_FILE;
  let original = "{}\n";
  let existed = true;
  try {
    original = await fs.readFile(file, "utf8");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    existed = false;
  }
  const { content, changed } = mergeClaudeJsonEnv(
    original,
    MANAGED_ENV_KEYS,
    filterWritableClaudeEnv(envVars),
    "Claude 用户 settings.json"
  );
  if (!changed) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (existed) {
    await fs.copyFile(file, `${file}.ai-provider-switcher-${formatBackupTimestamp()}.bak`);
  }
  await writeJsonFileAtomic(file, content);
}

/**
 * Keeps the terminal CLI in step with whatever was just written to VS Code. Every
 * path that rewrites the live configuration has to call this, otherwise `claude`
 * in a terminal keeps talking to the previous endpoint or model set while the
 * editor reports success. A failure here is a warning, not an abort: the VS Code
 * side is already committed by the time it runs.
 */
async function syncClaudeUserSettingsEnv(envVars: EnvVar[]): Promise<void> {
  try {
    await applyClaudeUserSettingsEnv(envVars);
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    vscode.window.showWarningMessage(
      `已在 VS Code 中生效，但同步终端 CLI 配置（${CLAUDE_USER_SETTINGS_FILE}）失败：${message}`
    );
  }
}

/** Removes the plugin's own managed env from ~/.claude/settings.json. */
async function clearClaudeUserSettingsManagedEnv(): Promise<void> {
  const file = CLAUDE_USER_SETTINGS_FILE;
  let original: string;
  try {
    original = await fs.readFile(file, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  const { content, changed } = clearClaudeManagedJsonEnv(
    original,
    MANAGED_ENV_KEYS,
    "Claude 用户 settings.json"
  );
  if (!changed) return;
  await fs.copyFile(file, `${file}.ai-provider-switcher-${formatBackupTimestamp()}.bak`);
  await writeJsonFileAtomic(file, content);
}

/**
 * Where Claude Desktop lives on this machine. The configured root wins so an
 * unusual install (portable build, redirected AppData, another drive) can be
 * pointed at by hand; otherwise every platform default is probed.
 */
async function locateClaudeDesktopInstall(): Promise<ClaudeDesktopInstall | undefined> {
  const configured = vscode.workspace
    .getConfiguration("aiProviderSwitcher")
    .get<string>(CLAUDE_DESKTOP_ROOT_KEY, "")
    .trim();
  const candidates = [
    ...(configured ? [configured] : []),
    ...getClaudeDesktopRootCandidates(process.platform)
  ];
  return findClaudeDesktopInstall(candidates, process.platform);
}

/**
 * Asks for the directory holding claude_desktop_config.json and remembers it.
 * Auto-detection covers the documented locations, but the app is shipped in
 * enough variants that a manual answer has to stay available.
 */
async function pickClaudeDesktopRoot(): Promise<ClaudeDesktopInstall | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    title: "选择 Claude Desktop 数据目录（包含 claude_desktop_config.json 的那一层）",
    openLabel: "使用此目录"
  });
  const root = picked?.[0]?.fsPath;
  if (!root) return undefined;
  const install = await findClaudeDesktopInstall([root], process.platform);
  if (!install) {
    vscode.window.showErrorMessage(
      `“${root}”下没有找到 Claude Desktop 数据目录。请选择直接包含 claude_desktop_config.json 的那一层目录。本机的默认位置是：${getClaudeDesktopRootCandidates(process.platform).join("、")}。`
    );
    return undefined;
  }
  await vscode.workspace
    .getConfiguration("aiProviderSwitcher")
    .update(CLAUDE_DESKTOP_ROOT_KEY, root, vscode.ConfigurationTarget.Global);
  return install;
}

/** Resolves the install, offering the manual picker when nothing was detected. */
async function requireClaudeDesktopInstall(): Promise<ClaudeDesktopInstall | undefined> {
  const detected = await locateClaudeDesktopInstall();
  if (detected) return detected;
  const probed = getClaudeDesktopRootCandidates(process.platform);
  // In a remote window the probe searched the remote host, where a local GUI app
  // was never going to be. Explain that instead of blaming the install.
  const remoteLimit = describeRemoteDesktopLimit(getRemoteEnvironment().kind);
  if (remoteLimit) {
    const remoteChoice = await vscode.window.showWarningMessage(
      `未检测到 Claude Desktop 的数据目录。${remoteLimit}已尝试：${probed.join("、")}。`,
      "打开 remote.extensionKind 设置",
      "仍要手动指定目录",
      "取消"
    );
    if (remoteChoice === "打开 remote.extensionKind 设置") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "remote.extensionKind");
      return undefined;
    }
    if (remoteChoice !== "仍要手动指定目录") return undefined;
    return pickClaudeDesktopRoot();
  }
  const choice = await vscode.window.showWarningMessage(
    `未检测到 Claude Desktop 的数据目录。已尝试：${probed.join("、")}。如果应用装在别处，可以手动指定。`,
    "手动指定目录",
    "取消"
  );
  if (choice !== "手动指定目录") return undefined;
  return pickClaudeDesktopRoot();
}

/**
 * `getProviderManagerState` and the status bar are synchronous, but the desktop
 * state only exists on disk, so it is snapshotted here and refreshed alongside
 * every other status update.
 */
let claudeDesktopSnapshot: { label: string; official: boolean; providerId?: string } = {
  label: "未检测到",
  official: true
};

/**
 * The local rewriting proxy for Claude Desktop. Started in `activate` and stopped
 * in `deactivate`; it lives inside the extension host, so a reload restarts it.
 * Only the desktop app routes through it — Claude Code and VS Code already send
 * the real model name straight to the relay, so they have nothing to rewrite.
 */
let claudeProxy: ClaudeProxy | undefined;
/** Opt-in experimental server; direct providers never depend on it. */
let protocolAdapterServer: LocalAdapterServer | undefined;

/** Where the desktop app should point when it needs the rewrite proxy. */
function claudeProxyUrl(): string | undefined {
  return claudeProxy ? `http://127.0.0.1:${claudeProxy.port}` : undefined;
}

/**
 * A provider needs the rewrite proxy exactly when its real models are not
 * Anthropic names — the situation that forces the Claude aliases. A native
 * Anthropic relay keeps the direct path, so existing setups behave unchanged.
 */
function claudeDesktopNeedsModelRewrite(gateway: GatewayProfile): boolean {
  // A catalogue route is always an opaque desktop-only alias, even when the
  // upstream model happens to be Claude-shaped, so it always needs the proxy.
  if (gateway.desktopRoutes?.length) return true;
  const mapping = normalizeClaudeModelMapping(gateway.modelMapping);
  if (!mapping) return false;
  return !isClaudeDesktopCompatibleModel(mapping.mainModel);
}

/** Resolves the model the proxy must rewrite, for the live desktop provider. */
function resolveClaudeDesktopProxyTarget(model: string): { baseUrl: string; model: string } | undefined {
  const providerId = claudeDesktopSnapshot.providerId;
  if (!providerId) return undefined;
  const provider = getGateways().find((item) => item.id === providerId);
  if (!provider) return undefined;
  const routeId = stripClaudeDesktopRouteSuffix(model);
  const route = provider.desktopRoutes?.find((item) => item.routeId === routeId);
  if (route) return { baseUrl: provider.baseUrl, model: route.model };
  // Legacy / simple-proxy route: standard Claude aliases map through the
  // provider's role mapping. Once an explicit catalogue is configured, unknown
  // routes are rejected rather than being silently sent to the wrong model.
  if (provider.desktopRoutes?.length) return undefined;
  const mapping = normalizeClaudeModelMapping(provider.modelMapping);
  if (!mapping) return undefined;
  return { baseUrl: provider.baseUrl, model: mapClaudeDesktopModelName(model, mapping) };
}

/**
 * Starts the rewriting proxy on the configured port and stops it when the
 * extension unloads. Failure degrades to a warning: the proxy is only required
 * for non-Anthropic relays, and the switch path reports its absence when it
 * matters.
 */
async function startClaudeProxyForExtension(context: vscode.ExtensionContext): Promise<void> {
  try {
    const choice = configuredLocalPort("claudeProxy");
    const port = choice.port;
    const proxy = await startClaudeProxy({ port, resolve: resolveClaudeDesktopProxyTarget });
    claudeProxy = proxy;
    if (proxy.bindWarning) {
      vscode.window.showWarningMessage(
        `Claude Desktop 本地改写代理：${proxy.bindWarning}若已切换过桌面端，请重新执行“切换 Claude Desktop 服务”。`
      );
    }
    context.subscriptions.push({
      dispose() {
        proxy.stop();
        if (claudeProxy === proxy) claudeProxy = undefined;
      }
    });
  } catch (error) {
    claudeProxy = undefined;
    vscode.window.showWarningMessage(
      `Claude Desktop 本地改写代理无法监听 127.0.0.1:${configuredLocalPort("claudeProxy").port}：${errorText(error)}。${portDescription(configuredLocalPort("claudeProxy"), `aiProviderSwitcher.${CLAUDE_PROXY_PORT_KEY}`)} 请修改该设置、重新加载 VS Code，并重新切换 Claude Desktop 服务。直接服务不受影响。`
    );
  }
}

async function startProtocolAdapterForExtension(context: vscode.ExtensionContext): Promise<void> {
  if (protocolAdapterServer) return;
  const hasBindings = getGateways().some((gateway) => gateway.adapter) || getCodexProviders().some((provider) => provider.adapter);
  if (!hasBindings) return;
  try {
    await preloadProtocolAdapterSecrets(context);
    const choice = configuredLocalPort("protocolAdapter");
    const port = choice.port;
    const server = await startLocalAdapterServer({
      port,
      resolve: (bindingId, target) => resolveProtocolAdapterTarget(context, bindingId, target)
    });
    protocolAdapterServer = server;
    if (server.bindWarning) {
      vscode.window.showWarningMessage(`实验性协议转换器：${server.bindWarning}请重新应用相应的绑定服务。`);
    }
    context.subscriptions.push({
      dispose() {
        server.stop();
        if (protocolAdapterServer === server) protocolAdapterServer = undefined;
      }
    });
  } catch (error) {
    protocolAdapterServer = undefined;
    const choice = configuredLocalPort("protocolAdapter");
    vscode.window.showWarningMessage(`实验性协议转换器无法监听 127.0.0.1:${choice.port}：${errorText(error)}。${portDescription(choice, `aiProviderSwitcher.${PROTOCOL_ADAPTER_PORT_KEY}`)} 请修改该设置、重新加载 VS Code，并重新创建或重新应用实验性绑定。直接服务不受影响。`);
  }
}

/** Resolve an explicit binding only. Never fall back to a direct/official service. */
function resolveProtocolAdapterTarget(
  context: vscode.ExtensionContext,
  bindingId: string,
  target: "claude" | "codex"
): AdapterBindingTarget | undefined {
  const profiles = target === "claude" ? getGateways() : getCodexProviders();
  const profile = profiles.find((item) => item.adapter?.id === bindingId);
  const binding = profile?.adapter;
  if (!profile || !binding) return undefined;
  if (target === "claude" && binding.direction !== "anthropicToResponses") return undefined;
  if (target === "codex" && binding.direction !== "responsesToAnthropic") return undefined;
  const upstream = binding.upstreamKind === "claudeGateway"
    ? getGateways().find((gateway) => gateway.id === binding.upstreamId)
    : getCodexProviders().find((provider) => provider.id === binding.upstreamId);
  if (!upstream) return undefined;
  const cachedToken = protocolAdapterTokens.get(binding.id);
  if (!cachedToken) return undefined;
  const upstreamToken = binding.upstreamKind === "claudeGateway"
    ? gatewayTokens.get(upstream.id)
    : codexTokens.get(upstream.id);
  if (!upstreamToken) return undefined;
  const models = binding.upstreamKind === "claudeGateway"
    ? getGatewayModels().find((entry) => entry.gatewayId === upstream.id)?.models ?? []
    : getCodexModels().find((entry) => entry.providerId === upstream.id)?.models ?? [];
  return {
    direction: binding.direction,
    upstreamBaseUrl: upstream.baseUrl,
    upstreamToken,
    localToken: cachedToken,
    models
  };
}

const protocolAdapterTokens = new Map<string, string>();
const gatewayTokens = new Map<string, string>();
const codexTokens = new Map<string, string>();

/** Preload only explicitly referenced secrets before the loopback server starts. */
async function preloadProtocolAdapterSecrets(context: vscode.ExtensionContext): Promise<void> {
  protocolAdapterTokens.clear();
  gatewayTokens.clear();
  codexTokens.clear();
  const bindings = [
    ...getGateways().flatMap((profile) => profile.adapter ? [profile.adapter] : []),
    ...getCodexProviders().flatMap((profile) => profile.adapter ? [profile.adapter] : [])
  ];
  for (const binding of bindings) {
    const local = await context.secrets.get(`${PROTOCOL_ADAPTER_SECRET_KEY_PREFIX}${binding.id}`);
    if (local) protocolAdapterTokens.set(binding.id, local);
    if (binding.upstreamKind === "claudeGateway") {
      const token = await context.secrets.get(`${SECRET_KEY_PREFIX}${binding.upstreamId}`);
      if (token) gatewayTokens.set(binding.upstreamId, token);
    } else {
      const token = await context.secrets.get(`${CODEX_SECRET_KEY_PREFIX}${binding.upstreamId}`);
      if (token) codexTokens.set(binding.upstreamId, token);
    }
  }
}

async function refreshProtocolAdapterSecrets(context: vscode.ExtensionContext): Promise<void> {
  if (!protocolAdapterServer) return;
  await preloadProtocolAdapterSecrets(context);
}

/**
 * How to actually quit Claude Desktop, in the terms of the platform the user is
 * on. "Fully quit" is not the same gesture everywhere — closing the window keeps
 * the app alive in the Windows tray and in the macOS dock — and the config is
 * only re-read on a cold start, so a vague instruction leaves the user
 * concluding the switch silently failed.
 */
function describeClaudeDesktopRestart(): string {
  if (process.platform === "win32") {
    return "需要完全退出并重新打开 Claude Desktop 才会生效：关闭窗口不等于退出，请在右下角任务栏托盘图标上右键选择「Quit / 退出」，再重新启动应用。";
  }
  if (process.platform === "darwin") {
    return "需要完全退出并重新打开 Claude Desktop 才会生效：点左上角红色圆点只是关闭窗口，请按 ⌘Q 或在菜单栏选择 Claude → Quit，再重新启动应用。";
  }
  return "需要完全退出并重新打开 Claude Desktop 才会生效：关闭窗口可能只是最小化到托盘，请确认应用进程已结束（可在系统监视器中查看 claude 相关进程），再重新启动应用。";
}

/**
 * Which stored provider the desktop app's applied entry belongs to.
 *
 * The entry id is derived from the provider id (`toClaudeDesktopEntryId`), so
 * for an entry this extension wrote that is an exact identity. Base URL matching
 * is only the fallback for an entry created by hand, and it cannot tell two
 * providers that share one relay apart — which is exactly the case where the
 * wrong provider used to be reported as the live desktop one.
 */
function findClaudeDesktopProvider(
  gateway: { baseUrl: string; entryId: string }
): GatewayProfile | undefined {
  const providers = getGateways();
  const byEntry = providers.find(
    (provider) => toClaudeDesktopEntryId(provider.id) === gateway.entryId
  );
  if (byEntry) return byEntry;
  const byUrl = findClaudeProviderByEnvironment(
    [{ name: "ANTHROPIC_BASE_URL", value: gateway.baseUrl }],
    providers
  );
  return byUrl ? providers.find((provider) => provider.id === byUrl.id) : undefined;
}

async function refreshClaudeDesktopSnapshot(): Promise<void> {
  try {
    const install = await locateClaudeDesktopInstall();
    if (!install) {
      claudeDesktopSnapshot = { label: "未检测到", official: true };
      return;
    }
    const gateway = await readClaudeDesktopGateway(install, process.platform);
    if (!gateway) {
      claudeDesktopSnapshot = { label: "官方服务", official: true };
      return;
    }
    const provider = findClaudeDesktopProvider(gateway);
    claudeDesktopSnapshot = {
      label: provider?.name || gateway.entryName || "未识别的自定义服务",
      official: false,
      // Lets a model change know it has to be pushed to the desktop app too.
      providerId: provider?.id
    };
  } catch {
    // A malformed desktop config must not break the panel or the status bar.
    claudeDesktopSnapshot = { label: "读取失败", official: true };
  }
}

/**
 * Writes one JSON file into every profile directory, since builds disagree on
 * which one they read. Existing files are backed up before being replaced.
 */
async function writeClaudeDesktopFile(
  file: string,
  content: string
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const existing = await readOptionalFile(file);
  if (existing === content) return;
  if (existing !== undefined) {
    await fs.copyFile(file, `${file}.ai-provider-switcher-${formatBackupTimestamp()}.bak`);
  }
  await writeJsonFileAtomic(file, content);
}

/**
 * Mirrors `deploymentMode` into the bootstrap document — the app's documented
 * entry point, created when absent — and into any profile document that already
 * exists. A profile document is never fabricated: its other keys are the app's.
 */
async function setClaudeDesktopMode(install: ClaudeDesktopInstall, mode: string): Promise<void> {
  const layouts = getClaudeDesktopWriteLayouts(install.root, process.platform);
  const bootstrap = layouts[0].bootstrapFile;
  const files = [bootstrap, ...layouts.map((layout) => layout.profileConfigFile)];
  for (const file of new Set(files)) {
    const original = await readOptionalFile(file);
    if (original === undefined && file !== bootstrap) continue;
    const { content } = setClaudeDesktopDeploymentMode(original, mode);
    await writeClaudeDesktopFile(file, content);
  }
}

/**
 * Profile directories whose config library has to stay in sync. The `-3p`
 * directory is authoritative; the plain one is only touched when a build already
 * created a library there, so the gateway key is not copied around needlessly.
 */
async function getClaudeDesktopLibraryLayouts(
  install: ClaudeDesktopInstall
): Promise<ClaudeDesktopLayout[]> {
  const [plain, threeP] = getClaudeDesktopWriteLayouts(install.root, process.platform);
  const layouts = [threeP];
  if ((await readOptionalFile(plain.metaFile)) !== undefined) layouts.push(plain);
  return layouts;
}

/**
 * The model list Claude Desktop should offer for a gateway, with the tier hints
 * taken from the provider's model mapping so `sonnet`-style aliases resolve the
 * same way they do in VS Code. A gateway carrying explicit desktop aliases uses
 * those instead of its discovered names, which is the only way to reach a
 * provider whose real model IDs the desktop app refuses.
 */
function getClaudeDesktopModelEntries(gateway: GatewayProfile): {
  entries: ClaudeDesktopModelEntry[];
  rejected: string[];
} {
  const mapping = normalizeClaudeModelMapping(gateway.modelMapping);
  if (gateway.desktopRoutes?.length) {
    return { entries: buildClaudeDesktopRouteEntries(gateway.desktopRoutes, gateway.name), rejected: [] };
  }
  if (gateway.desktopModels?.length) {
    // The alias path also carries the 1M claims, otherwise a gateway reached
    // through aliases (DeepSeek) never gets the context option even when its
    // mapping declares 1M support. Each alias has its own switch — aliases
    // resolve to different models with different context windows — and the
    // main model's 1M declaration lights up the default (first) alias.
    return buildClaudeDesktopAliasEntries(gateway.desktopModels, gateway.name, {
      supports1m: desktopAlias1mFor(gateway),
      // Only lands when the default alias actually advertises 1M.
      prefer1m: true
    });
  }
  // The discovery path carries the same per-model declaration the editor stores,
  // so every model the user marked 1M is offered with the option — not only the
  // main one, and not gated on the legacy gateway-wide flag.
  const oneM = new Set(mapping?.longContextModels ?? []);
  const models = getGatewayModels().find((entry) => entry.gatewayId === gateway.id)?.models ?? [];
  return buildClaudeDesktopModelEntries(models, {
    defaultModel: mapping?.mainModel,
    opus: mapping?.opusModel,
    sonnet: mapping?.sonnetModel,
    haiku: mapping?.haikuModel,
    fable: mapping?.fableModel,
    supports1m: (name) => oneM.has(name),
    prefer1m: mapping ? oneM.has(mapping.mainModel) : false
  });
}

/** Applies a gateway as Claude Desktop's live third-party inference config. */
async function applyClaudeDesktopGateway(
  install: ClaudeDesktopInstall,
  gateway: GatewayProfile,
  token: string,
  models: ClaudeDesktopModelEntry[]
): Promise<void> {
  // A relay whose real models are not Anthropic names has to be reached through
  // the local rewriting proxy; pointing the config at a proxy that is not running
  // would leave the desktop app talking to a dead port, so that is an error.
  let baseUrl = gateway.baseUrl;
  if (claudeDesktopNeedsModelRewrite(gateway)) {
    const proxyUrl = claudeProxyUrl();
    if (!proxyUrl) {
      throw new Error("需要本地改写代理才能使用该中转站的模型，但代理未启动。请重新加载 VS Code 后重试。");
    }
    baseUrl = proxyUrl;
  }
  const entryId = toClaudeDesktopEntryId(gateway.id);
  const entry = { id: entryId, name: gateway.name };
  for (const layout of await getClaudeDesktopLibraryLayouts(install)) {
    const meta = parseClaudeDesktopMeta(await readOptionalFile(layout.metaFile));
    const entryFile = getClaudeDesktopEntryFile(layout, entryId, process.platform);
    const inherited = meta.appliedId && meta.appliedId !== entryId
      ? await readOptionalFile(getClaudeDesktopEntryFile(layout, meta.appliedId, process.platform))
      : undefined;
    await writeClaudeDesktopFile(
      entryFile,
      buildClaudeDesktopGatewayConfig(
        await readOptionalFile(entryFile),
        { baseUrl, apiKey: token, models },
        inherited
      )
    );
    await writeClaudeDesktopFile(
      layout.metaFile,
      serializeClaudeDesktopMeta(applyClaudeDesktopEntry(meta, entry))
    );
  }
  await setClaudeDesktopMode(install, CLAUDE_DESKTOP_3P_MODE);
}

/**
 * Deletes a provider's stored desktop config. Called both when switching back to
 * the official subscription and when the provider is removed, so its base URL and
 * plaintext key do not linger in the desktop config library.
 */
async function forgetClaudeDesktopProvider(
  install: ClaudeDesktopInstall,
  providerId: string
): Promise<boolean> {
  const entryId = toClaudeDesktopEntryId(providerId);
  let removed = false;
  for (const layout of await getClaudeDesktopLibraryLayouts(install)) {
    const original = await readOptionalFile(layout.metaFile);
    const entryFile = getClaudeDesktopEntryFile(layout, entryId, process.platform);
    if (await readOptionalFile(entryFile) !== undefined) {
      await fs.unlink(entryFile).catch(() => undefined);
      removed = true;
    }
    if (original === undefined) continue;
    const meta = parseClaudeDesktopMeta(original);
    if (!meta.entries.some((item) => item.id === entryId) && meta.appliedId !== entryId) continue;
    await writeClaudeDesktopFile(
      layout.metaFile,
      serializeClaudeDesktopMeta(removeClaudeDesktopEntry(meta, entryId))
    );
    removed = true;
  }
  return removed;
}

/** Best-effort cleanup when a Claude provider is deleted from the extension. */
async function detachRemovedProviderFromClaudeDesktop(providerId: string): Promise<void> {
  try {
    const install = await locateClaudeDesktopInstall();
    if (!install) return;
    const live = await readClaudeDesktopGateway(install, process.platform);
    const wasLive = live?.entryId === toClaudeDesktopEntryId(providerId);
    const removed = await forgetClaudeDesktopProvider(install, providerId);
    if (wasLive) await setClaudeDesktopMode(install, CLAUDE_DESKTOP_1P_MODE);
    if (removed) {
      vscode.window.showInformationMessage(
        wasLive
          ? `该服务是 Claude Desktop 当前使用的配置，已同时移除并恢复官方订阅。${describeClaudeDesktopRestart()}`
          : "已同时清理该服务在 Claude Desktop 中的配置。"
      );
    }
  } catch {
    // Deleting a provider must succeed even when the desktop config cannot be touched.
  }
}

/**
 * The Claude Desktop app is managed independently of VS Code and the CLI: it
 * routes through its own third-party inference config library, so switching it
 * rewrites `configLibrary` and flips `deploymentMode` rather than touching any
 * environment variable.
 */
async function switchClaudeDesktop(context: vscode.ExtensionContext): Promise<void> {
  const install = await requireClaudeDesktopInstall();
  if (!install) return;

  const live = await readClaudeDesktopGateway(install, process.platform).catch(() => undefined);
  const liveProvider = live ? findClaudeDesktopProvider(live) : undefined;
  const gateways = getGateways();
  const selected = await vscode.window.showQuickPick(
    [
      {
        label: "官方订阅",
        description: live ? "" : "当前",
        target: "official" as const,
        gateway: undefined
      },
      ...gateways.map((gateway) => ({
        label: gateway.name,
        description: `${gateway.baseUrl}${gateway.id === liveProvider?.id ? " · 当前" : ""}`,
        target: "gateway" as const,
        gateway
      })),
      ...(gateways.length === 0
        ? [{ label: "$(add) 添加中转站…", description: "还没有可用的中转站", target: "add" as const, gateway: undefined }]
        : []),
      {
        label: "$(folder-opened) 更改 Claude Desktop 数据目录…",
        description: install.root,
        target: "relocate" as const,
        gateway: undefined
      }
    ],
    {
      title: "切换 Claude Desktop 服务（独立于 VS Code 与 CLI）",
      placeHolder: live
        ? `当前：${liveProvider?.name || live.entryName || live.baseUrl}`
        : "当前：官方订阅"
    }
  );
  if (!selected) return;
  if (selected.target === "add") {
    const added = await addGateway();
    if (added) await switchClaudeDesktop(context);
    return;
  }
  if (selected.target === "relocate") {
    if (await pickClaudeDesktopRoot()) {
      await refreshStatusBar();
      await switchClaudeDesktop(context);
    }
    return;
  }

  if (selected.target === "official") {
    const proceed = await confirmClaudeDesktopSwitch("官方订阅");
    if (!proceed) return;
    try {
      if (liveProvider) await forgetClaudeDesktopProvider(install, liveProvider.id);
      await setClaudeDesktopMode(install, CLAUDE_DESKTOP_1P_MODE);
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      vscode.window.showErrorMessage(`切换 Claude Desktop 失败：${message}`);
      return;
    }
    await refreshStatusBar();
    vscode.window.showInformationMessage(
      `Claude Desktop 已恢复官方订阅。${describeClaudeDesktopRestart()}`
    );
    return;
  }

  const gateway = selected.gateway;
  if (!gateway) return;
  const proceed = await confirmClaudeDesktopSwitch(gateway.name);
  if (!proceed) return;
  let { entries, rejected } = getClaudeDesktopModelEntries(gateway);
  if (!(await confirmClaudeDesktopModels(context, gateway, entries, rejected))) return;
  // The confirmation may have just attached desktop aliases to the gateway;
  // rebuild the list so the stored entry matches what was confirmed instead of
  // the (possibly empty) list computed before the prompt.
  ({ entries } = getClaudeDesktopModelEntries(gateway));
  const token = await getOrRequestGatewayToken(context, gateway);
  if (!token) return;
  try {
    await applyClaudeDesktopGateway(install, gateway, token, entries);
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    vscode.window.showErrorMessage(`切换 Claude Desktop 失败：${message}`);
    return;
  }
  await refreshStatusBar();
  vscode.window.showInformationMessage(
    `Claude Desktop 已切换到“${gateway.name}”。${describeClaudeDesktopRestart()}`
  );
}

/**
 * Claude Desktop only offers models it was given: it discovers them from the
 * gateway's `/v1/models`, and most relays do not serve that endpoint, which is
 * what leaves the picker empty and the app reporting that the model list has not
 * loaded. Writing an explicit list skips discovery — but the app also refuses any
 * model ID that does not read as an Anthropic route, so a provider serving its
 * own model names (DeepSeek, Qwen, GLM…) cannot be offered at all. Both cases are
 * explained here rather than after a restart.
 */
async function confirmClaudeDesktopModels(
  context: vscode.ExtensionContext,
  gateway: GatewayProfile,
  entries: ClaudeDesktopModelEntry[],
  rejected: string[]
): Promise<boolean> {
  if (entries.length > 0) {
    if (rejected.length > 0) {
      vscode.window.showWarningMessage(
        `Claude Desktop 不接受这些模型 ID：${rejected.join("、")}。它们已被跳过，桌面应用只会提供 ${entries.length} 个 Claude 系模型。`
      );
    }
    return true;
  }

  const detail = rejected.length > 0
    ? `“${gateway.name}”的模型（${rejected.join("、")}）不是 Anthropic 系名称，Claude Desktop 会拒绝整份配置。`
    : `还没有缓存“${gateway.name}”的模型列表，而该网关多半不提供 /v1/models，桌面应用将无法列出任何模型。`;
  const choice = await vscode.window.showWarningMessage(
    `${detail}\n\n推荐先刷新模型列表，然后在“模型与参数 → Claude Desktop 模型 → 全模型目录”勾选实际模型；这是无需猜测别名、可精确转发的方式。若服务商文档明确要求某个兼容别名，才选择手动填写。`,
    { modal: true },
    "刷新模型列表",
    "手动填写服务商兼容别名"
  );
  if (choice === "手动填写服务商兼容别名") {
    const names = await promptClaudeDesktopAliases(gateway);
    return names ? applyClaudeDesktopAliases(gateway, names) : false;
  }
  if (choice === "刷新模型列表") {
    await refreshGatewayModels(context, gateway);
    return false;
  }
  return false;
}

/** Stores the aliases on the gateway so later switches reuse them silently. */
async function applyClaudeDesktopAliases(
  gateway: GatewayProfile,
  names: string[]
): Promise<boolean> {
  const { entries, rejected } = buildClaudeDesktopAliasEntries(names, gateway.name);
  if (entries.length === 0) {
    vscode.window.showErrorMessage(
      `这些名称 Claude Desktop 都不接受：${rejected.join("、")}。名称中需要含 claude/opus/sonnet/haiku/anthropic。`
    );
    return false;
  }
  const names1m = entries.map((entry) => entry.name);
  await saveGatewayDesktopModels(gateway.id, names1m);
  gateway.desktopModels = names1m;
  // `saveGatewayDesktopModels` drops 1M claims for aliases that no longer exist.
  // Without mirroring that here, this in-memory copy — which is what the desktop
  // config written later in the same run reads — keeps declaring a dropped alias.
  const kept1m = (gateway.desktopModel1m ?? []).filter((name) => names1m.includes(name));
  gateway.desktopModel1m = kept1m.length > 0 ? kept1m : undefined;
  if (rejected.length > 0) {
    vscode.window.showWarningMessage(`已跳过 Claude Desktop 不接受的名称：${rejected.join("、")}。`);
  }
  return true;
}

async function saveGatewayDesktopModels(gatewayId: string, names: string[]): Promise<void> {
  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  const raw = settings.get<unknown>("gateways", []);
  if (!Array.isArray(raw)) return;
  const next = raw.map((item) => {
    if (typeof item !== "object" || item === null) return item;
    const record = item as Record<string, unknown>;
    if (String(record.id ?? "").trim() !== gatewayId) return item;
    if (names.length === 0) {
      const { desktopModels: _dropped, desktopModel1m: _dropped1m, ...rest } = record;
      return rest;
    }
    // Aliases that no longer exist must not keep a stale 1M claim.
    const kept1m = Array.isArray(record.desktopModel1m)
      ? record.desktopModel1m.filter((name) => typeof name === "string" && names.includes(name))
      : [];
    return {
      ...record,
      desktopModels: names,
      desktopModel1m: kept1m.length > 0 ? kept1m : undefined
    };
  });
  await settings.update("gateways", next, vscode.ConfigurationTarget.Global);
}

async function promptClaudeDesktopAliases(gateway: GatewayProfile): Promise<string[] | undefined> {
  const value = await vscode.window.showInputBox({
    title: `Claude Desktop 服务商兼容别名 — ${gateway.name}`,
    prompt: "用逗号分隔。这些名称会原样发给网关；仅填写服务商文档明确支持的名称，不要猜测 Claude 模型版本。",
    value: (gateway.desktopModels ?? CLAUDE_DESKTOP_GENERIC_TIER_ALIASES).join(", "),
    validateInput: (input) => {
      const names = input.split(/[,，]/).map((name) => name.trim()).filter(Boolean);
      if (names.length === 0) return "请至少填写一个模型名";
      const bad = names.filter((name) => !isClaudeDesktopCompatibleModel(name));
      return bad.length > 0 ? `Claude Desktop 不接受：${bad.join("、")}` : undefined;
    }
  });
  if (value === undefined) return undefined;
  return value.split(/[,，]/).map((name) => name.trim()).filter(Boolean);
}

/** Lets a gateway's desktop model names be set without switching to it. */
async function configureClaudeDesktopModels(gateway?: GatewayProfile): Promise<void> {
  const target = gateway ?? (await pickGateway());
  if (!target) return;
  const current = target.desktopModels?.length
    ? `当前高级兼容别名：${target.desktopModels.join("、")}`
    : "当前：未配置兼容别名（推荐使用全模型目录）";
  const choice = await vscode.window.showQuickPick(
    [
      { label: "填写服务商兼容别名", description: "仅填写服务商文档明确支持、会原样发给网关的名称" },
      { label: "填入通用档位名（需服务商支持）", description: CLAUDE_DESKTOP_GENERIC_TIER_ALIASES.join("、") },
      { label: "恢复自动发现", description: "删除兼容别名；优先改用全模型目录" }
    ],
    { title: `Claude Desktop 高级兼容别名 — ${target.name}`, placeHolder: current }
  );
  if (!choice) return;
  if (choice.label === "恢复自动发现") {
    await saveGatewayDesktopModels(target.id, []);
    vscode.window.showInformationMessage(
      `“${target.name}”已恢复自动发现模型。重新切换 Claude Desktop 后生效。`
    );
    return;
  }
  const names = choice.label === "填入通用档位名（需服务商支持）"
    ? [...CLAUDE_DESKTOP_GENERIC_TIER_ALIASES]
    : await promptClaudeDesktopAliases(target);
  if (!names) return;
  if (!(await applyClaudeDesktopAliases(target, names))) return;
  vscode.window.showInformationMessage(
    `“${target.name}”的 Claude Desktop 模型名已设为 ${names.join("、")}。重新切换 Claude Desktop 后生效。`
  );
}

/**
 * The desktop app keeps its own conversation store, so the Claude Code session
 * warning does not apply — only the restart requirement does.
 */
async function confirmClaudeDesktopSwitch(target: string): Promise<boolean> {
  const choice = await vscode.window.showInformationMessage(
    `准备把 Claude Desktop 切换到“${target}”。这只影响桌面应用，VS Code 与终端 CLI 不变。${describeClaudeDesktopRestart()}是否继续？`,
    { modal: true },
    "继续切换",
    "取消"
  );
  return choice === "继续切换";
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
    prompt: "请输入网关 Bearer Token（保存在 VS Code Secret Storage；启用终端 CLI 或 Claude Desktop 同步时，会明文写入对应的本地配置文件）",
    password: true,
    ignoreFocusOut: true
  });

  if (!entered?.trim()) {
    vscode.window.showWarningMessage("未输入网关 Token，切换已取消。");
    return undefined;
  }

  const token = entered.trim();
  await context.secrets.store(secretKey, token);
  await refreshProtocolAdapterSecrets(context);
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
      { label: "切换 Claude Desktop 服务（独立）", action: "desktop" },
      { label: "添加中转站", action: "add" },
      { label: "编辑中转站（名称 / Base URL / Token）", action: "edit" },
      { label: "删除中转站", action: "remove" },
      { label: "清除某个中转站 Token", action: "clear" },
      { label: "配置模型映射", action: "mapping" },
      { label: "配置 Claude Desktop 模型名", action: "desktopModels" },
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
  if (action.action === "desktop") await switchClaudeDesktop(context);
  if (action.action === "add") await addGateway();
  if (action.action === "edit") await editGateway(context);
  if (action.action === "remove") await removeGateway(context);
  if (action.action === "clear") await clearGatewayToken(context);
  if (action.action === "mapping") await configureClaudeModelMapping(context);
  if (action.action === "desktopModels") await configureClaudeDesktopModels();
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
    // The user file's managed env keys are written by this extension, so they are
    // filtered out in memory instead of being deleted from disk first — an
    // abandoned switch used to leave the CLI unconfigured that way.
    { file: CLAUDE_USER_SETTINGS_FILE, source: "Claude 用户设置", managed: true },
    ...(workspaceRoot ? [
      { file: path.join(workspaceRoot, ".claude", "settings.json"), source: "Claude 项目设置", managed: false },
      { file: path.join(workspaceRoot, ".claude", "settings.local.json"), source: "Claude 项目本地设置", managed: false }
    ] : [])
  ];
  for (const candidate of settingsFiles) {
    try {
      const raw = await fs.readFile(candidate.file, "utf8");
      let content = raw;
      if (candidate.managed) {
        try {
          content = clearClaudeManagedJsonEnv(raw, MANAGED_ENV_KEYS, candidate.source).content;
        } catch {
          // Malformed JSON is reported by the inspector below with a clearer message.
        }
      }
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
    `${finding.source} 中检测到 ${finding.name}。它是 VS Code 启动时从系统继承来的，插件无法安全改写。${describeInheritedEnvRemoval()}删除后请完全退出并重新打开 VS Code（重载窗口不够，继承的变量只在进程启动时读取一次）。`,
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
      // Atomic like every other settings write: a crash mid-write here would
      // truncate a settings.json the user did not ask us to touch.
      await writeJsonFileAtomic(file, stripped.content);
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

async function createProtocolAdapterBinding(
  context: vscode.ExtensionContext,
  direction: ProtocolAdapterBinding["direction"],
  upstreamKind: ProtocolAdapterBinding["upstreamKind"],
  upstreamId: string,
  targetName: string
): Promise<void> {
  const upstream = upstreamKind === "claudeGateway"
    ? getGateways().find((item) => item.id === upstreamId)
    : getCodexProviders().find((item) => item.id === upstreamId);
  if (!upstream) {
    vscode.window.showErrorMessage("选择的上游服务已不存在，未创建协议转换绑定。");
    return;
  }
  const binding: ProtocolAdapterBinding = {
    id: randomUUID(), direction, upstreamKind, upstreamId, textOnly: true
  };
  const localToken = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  await context.secrets.store(`${PROTOCOL_ADAPTER_SECRET_KEY_PREFIX}${binding.id}`, localToken);
  if (direction === "responsesToAnthropic") {
    const provider: CodexProviderProfile = {
      id: createCodexProviderId(targetName, getCodexProviders().map((item) => item.id)),
      name: targetName,
      baseUrl: protocolAdapterBaseUrl(binding),
      adapter: binding
    };
    await vscode.workspace.getConfiguration("aiProviderSwitcher").update(CODEX_PROVIDERS_KEY, [...getCodexProviders(), provider], vscode.ConfigurationTarget.Global);
    await saveCodexModels(provider.id, getGatewayModels().find((entry) => entry.gatewayId === upstreamId)?.models ?? []);
    await writeCodexApiKeyFile(provider, localToken);
  } else {
    const provider: GatewayProfile = {
      id: `adapter-${binding.id}`,
      name: targetName,
      baseUrl: protocolAdapterBaseUrl(binding),
      adapter: binding
    };
    await vscode.workspace.getConfiguration("aiProviderSwitcher").update(GATEWAYS_KEY.split(".").slice(1).join("."), [...getGateways(), provider], vscode.ConfigurationTarget.Global);
    await saveGatewayModels(provider.id, getCodexModels().find((entry) => entry.providerId === upstreamId)?.models ?? []);
    await context.secrets.store(`${SECRET_KEY_PREFIX}${provider.id}`, localToken);
  }
  await startProtocolAdapterForExtension(context);
  vscode.window.showInformationMessage(`已创建实验性文本协议转换服务“${targetName}”。它只支持文本和流式输出；工具调用、图片、文件和完整 Agent 编码暂不支持。`);
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
    vscode.window.showErrorMessage("Base URL 必须以 http:// 或 https:// 开头（公网中转站一般是 https://，本机自建的中转站通常是 http://127.0.0.1:端口）。");
    return undefined;
  }

  const id = `${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`;
  const gateway: GatewayProfile = { id, name: name.trim(), baseUrl: normalizeClaudeProviderBaseUrl(baseUrl) };
  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  await settings.update(GATEWAYS_KEY.split(".").slice(1).join("."), [...getGateways(), gateway], vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`已添加中转站：${gateway.name}。如需启用，请点击“切换服务”并选择它。`);
  return gateway;
}

/** Editing happens in the manager's form, so the palette command just lands the user on it. */
async function editGateway(
  context: vscode.ExtensionContext,
  selectedGateway?: GatewayProfile
): Promise<void> {
  const gateway = selectedGateway ?? await pickGateway();
  if (!gateway) return;
  openProviderManager(context, { kind: "claude", id: gateway.id, edit: true });
}

/** `selectedGateway` comes from the manager, where the target was already chosen by clicking it. */
async function removeGateway(
  context: vscode.ExtensionContext,
  selectedGateway?: GatewayProfile
): Promise<void> {
  const gateways = getGateways();
  const gateway = selectedGateway ?? (await vscode.window.showQuickPick(
    gateways.map((item) => ({ label: item.name, description: item.baseUrl, gateway: item })),
    { title: "删除 Claude 中转站" }
  ))?.gateway;
  if (!gateway) return;

  const dependents = getCodexProviders().filter((provider) =>
    provider.adapter?.upstreamKind === "claudeGateway" && provider.adapter.upstreamId === gateway.id
  );
  if (dependents.length > 0) {
    vscode.window.showWarningMessage(`无法删除“${gateway.name}”：实验性协议转换服务 ${dependents.map((item) => `“${item.name}”`).join("、")} 正依赖它。请先删除这些转换服务。`);
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `确定删除“${gateway.name}”？`,
    { modal: true },
    "删除"
  );
  if (confirm !== "删除") return;

  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  await settings.update(
    GATEWAYS_KEY.split(".").slice(1).join("."),
    gateways.filter((item) => item.id !== gateway.id),
    vscode.ConfigurationTarget.Global
  );
  await context.secrets.delete(`${SECRET_KEY_PREFIX}${gateway.id}`);
  if (gateway.adapter) await context.secrets.delete(`${PROTOCOL_ADAPTER_SECRET_KEY_PREFIX}${gateway.adapter.id}`);
  // Its base URL and plaintext key would otherwise stay in the desktop config
  // library, still routing Claude Desktop to a provider the user just deleted.
  await detachRemovedProviderFromClaudeDesktop(gateway.id);
  await refreshStatusBar();
  vscode.window.showInformationMessage(`已删除中转站：${gateway.name}`);
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
      const cleared = removeClaudeModelEnvironment(getClaudeEnvVars());
      await updateClaudeEnvVars(cleared);
      await syncClaudeUserSettingsEnv(cleared);
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
      description: "为主模型、Fable、Opus、Sonnet 所用的模型添加 [1m]，Claude Code 发送请求前会移除后缀",
      value: true
    }
  ], {
    title: "该 Provider 是否支持 1M 上下文？",
    placeHolder: "只有服务商明确声明支持时才启用"
  });
  if (!supports1m) return undefined;
  // The wizard covers the models behind the four roles the legacy switch did.
  // A model the panel's editor declared for anything else (the fast model, an
  // unmapped one) keeps its declaration, since the wizard never asked about it.
  const wizardModels = [
    mapping.mainModel,
    mapping.fableModel ?? mapping.mainModel,
    mapping.opusModel,
    mapping.sonnetModel
  ];
  const untouched = (normalizeClaudeModelMapping(existing)?.longContextModels ?? [])
    .filter((name) => !wizardModels.includes(name));
  mapping.longContextModels = supports1m.value
    ? [...new Set([...wizardModels, ...untouched])]
    : untouched;

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

  // Normalized before storing so the derived legacy fields stay in step with
  // the declaration the wizard just made.
  await updateGatewayProfile({ ...gateway, modelMapping: normalizeClaudeModelMapping(mapping) ?? mapping });
  if (applyImmediately && getCurrentClaudeProvider()?.id === gateway.id) {
    const current = removeClaudeModelEnvironment(getClaudeEnvVars());
    const applied = [...current, ...createClaudeModelEnvironment(mapping)];
    await updateClaudeEnvVars(applied);
    await syncClaudeUserSettingsEnv(applied);
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

/**
 * Turns a connection failure into the one sentence that tells the user what to
 * change. A refused port, an unresolvable host and a rejected certificate all
 * arrive as the same opaque "cannot connect" otherwise, and each has a different
 * fix. TLS interception is called out by name because it is common on managed
 * Windows machines and no amount of retrying resolves it.
 */
function describeConnectionFailure(error: unknown, url: URL): string {
  const code = isNodeError(error) ? String(error.code ?? "") : "";
  const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `无法解析域名 ${url.hostname}：请检查 Base URL 是否拼写正确，以及本机 DNS 或代理是否可用`;
  }
  if (code === "ECONNREFUSED") {
    return url.protocol === "https:"
      ? `${host} 拒绝连接：请确认服务已启动、端口正确；若这是本机自建的中转站，多数只监听 http://，请把 Base URL 的 https 改成 http`
      : `${host} 拒绝连接：请确认服务已在该端口启动`;
  }
  if (code === "EPROTO" || code === "ERR_SSL_WRONG_VERSION_NUMBER") {
    return `${host} 不接受 HTTPS 握手：该地址很可能是明文 HTTP 服务，请把 Base URL 改成 http://`;
  }
  if (code === "CERT_HAS_EXPIRED") return `${host} 的 HTTPS 证书已过期，请联系该服务的提供方`;
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID") return `${host} 的 HTTPS 证书与域名不匹配，请核对 Base URL`;
  if (code.includes("SELF_SIGNED") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
    return `${host} 的 HTTPS 证书无法验证：常见于公司网络的流量审查或自签证书，请让网络管理员把根证书装进系统信任库（Node 也可通过 NODE_EXTRA_CA_CERTS 指定）`;
  }
  if (code === "ETIMEDOUT" || code === "ECONNRESET") {
    return `连接 ${host} 被中断或超时：请检查网络、VPN 或代理设置`;
  }
  return code ? `无法连接到 ${host}（${code}）` : `无法连接到 ${host}`;
}

type GatewayModelsResponse = { models: string[]; headers: IncomingHttpHeaders };

function requestGatewayModelsFrom(endpoint: string, token: string): Promise<GatewayModelsResponse> {
  const url = new URL(endpoint);
  // Both validators accept http://, because self-hosted relays (one-api, new-api,
  // LiteLLM) usually run plain HTTP on localhost. Hardcoding the https module made
  // every one of those report "无法连接到网关" no matter what it served.
  const transport = url.protocol === "http:" ? http : https;
  return new Promise((resolve, reject) => {
    const request = transport.request(
      url,
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
          const status = response.statusCode ?? 0;
          if (status !== 200) {
            reject(new Error(describeGatewayModelFailure(status, body)));
            return;
          }

          try {
            resolve({ models: parseGatewayModelList(body), headers: response.headers });
          } catch {
            reject(new Error("网关返回的模型列表不是有效 JSON"));
          }
        });
      }
    );
    request.on("error", (error) => reject(new Error(describeConnectionFailure(error, url))));
    request.setTimeout(15000, () => {
      request.destroy();
      reject(new Error(`连接 ${url.hostname} 超时（15 秒）：请检查网络、VPN 或代理设置`));
    });
    request.end();
  });
}

/**
 * Tries each candidate endpoint. A 404 only means "not here", so the search
 * continues; anything else (401, quota, network) is the answer and is reported
 * as-is, since the server's message names the real problem.
 */
async function requestGatewayModels(baseUrl: string, token: string): Promise<GatewayModelsResponse> {
  let lastError: Error = new Error("网关没有提供模型列表接口");
  for (const endpoint of getGatewayModelEndpoints(baseUrl)) {
    try {
      return await requestGatewayModelsFrom(endpoint, token);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("未知网络错误");
      if (!isGatewayModelPathMiss(lastError.message)) throw lastError;
    }
  }
  throw lastError;
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
    const models = await resolveCodexModels(provider, apiKey);
    if (!models) return;
    await writeCodexConfiguration(context, provider, models);
    await settings.update(CODEX_ACTIVE_PROVIDER_KEY, provider.id, vscode.ConfigurationTarget.Global);
    await settings.update(CODEX_ACTIVE_MODEL_KEY, "", vscode.ConfigurationTarget.Global);
    await synchronizeCodexProxyForProvider(settings);
    await refreshStatusBar();
    await offerReload(
      `Codex 已切换到“${provider.name}”。已同步 ${models.length} 个模型；重载后请直接在 Codex 页面原生模型栏中选择。${
        isCodexUnifiedHistoryEnabled()
          ? "统一会话历史已开启：官方与第三方会话共用同一历史列表。"
          : ""
      }是否立即重载？`
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
    const unifyOn = isCodexUnifiedHistoryEnabled();
    const providers = getCodexProviders();
    if (providers.length > 0) await ensureCodexAuthHelper();
    let updated = updateTopLevelTomlKey(
      content,
      "model_provider",
      unifyOn ? CODEX_UNIFIED_PROVIDER_ID : backup?.hadModelProvider ? backup.modelProvider : undefined
    );
    updated = updateTopLevelTomlKey(updated, "model", backup?.hadModel ? backup.model : undefined);
    updated = updateTopLevelTomlKey(
      updated,
      "model_catalog_json",
      backup?.hadModelCatalog ? backup.modelCatalog : undefined
    );
    updated = removeManagedCodexProviders(updated);
    if (unifyOn && hasCodexCustomProviderSection(updated)) {
      throw new Error(
        "config.toml 已存在手动定义的 [model_providers.custom] 段；为避免把流量路由到未知后端，请先删除该段，或关闭“统一 Codex 会话历史”。"
      );
    }
    // Keep the custom provider blocks so threads recorded under those IDs stay resolvable.
    await writeCodexConfigurationFile(
      replaceManagedCodexProviders(
        updated,
        serializeManagedCodexProviders(providers, unifyOn ? "official" : undefined)
      )
    );

    const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
    await settings.update(CODEX_ACTIVE_PROVIDER_KEY, "", vscode.ConfigurationTarget.Global);
    await settings.update(CODEX_ACTIVE_MODEL_KEY, "", vscode.ConfigurationTarget.Global);
    await synchronizeCodexProxyForProvider(settings);
    await refreshStatusBar();
    await offerReload(
      unifyOn
        ? "Codex 已恢复为官方 OpenAI Provider。官方订阅将以共享的 custom 供应商标识运行，官方与第三方会话进入同一历史列表。是否立即重载 VS Code？"
        : "Codex 已恢复为官方 OpenAI Provider。是否立即重载 VS Code？"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    vscode.window.showErrorMessage(`恢复 Codex 官方 Provider 失败：${message}`);
  }
}

function isCodexUnifiedHistoryEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("aiProviderSwitcher")
    .get<boolean>(CODEX_UNIFY_HISTORY_KEY, false);
}

function getCodexUnifiedMigrationRequested(): boolean {
  return vscode.workspace
    .getConfiguration("aiProviderSwitcher")
    .get<boolean>(CODEX_UNIFY_MIGRATE_KEY, false);
}

function getCodexDir(): string {
  return path.dirname(CODEX_CONFIG_FILE);
}

function getCodexThirdPartyTagIds(): string[] {
  return getCodexProviders().map((provider) => provider.id);
}

function getCodexUnifyBackupParent(): string {
  return path.join(getCodexDir(), "ai-provider-switcher-backups", CODEX_UNIFY_BACKUP_NAME);
}

function getCodexUnifyRestoreParent(): string {
  return path.join(getCodexDir(), "ai-provider-switcher-backups", CODEX_UNIFY_RESTORE_BACKUP_NAME);
}

/** How many silent startup retries a partially failed migration gets. */
const CODEX_UNIFY_MAX_RETRY_ATTEMPTS = 3;

type CodexUnifyMigrationMarker = {
  codexDirKey: string;
  completedAt: string;
  migratedJsonlFiles: number;
  migratedStateRows: number;
  /** Items that could not be migrated on the last attempt. */
  pendingFailures?: number;
  /** Attempts made so far, so a permanently locked file cannot retry forever. */
  attempts?: number;
};

/**
 * Retries a deferred or partially failed migration once per startup. A run that
 * left failures behind is retried (locks are usually transient) but only up to
 * CODEX_UNIFY_MAX_RETRY_ATTEMPTS times, after which the user is told once
 * instead of the extension silently rescanning on every launch.
 */
async function retryCodexUnifiedMigration(context: vscode.ExtensionContext): Promise<void> {
  if (!isCodexUnifiedHistoryEnabled() || !getCodexUnifiedMigrationRequested()) return;
  const codexDirKey = canonicalCodexDirKey(getCodexDir());
  const marker = context.globalState.get<CodexUnifyMigrationMarker>(CODEX_UNIFY_MIGRATION_MARKER_KEY);
  if (marker?.codexDirKey === codexDirKey) {
    const pending = marker.pendingFailures ?? 0;
    if (pending === 0) return;
    if ((marker.attempts ?? 1) >= CODEX_UNIFY_MAX_RETRY_ATTEMPTS) return;
  }
  const outcome = await runCodexUnifiedMigration(context, false);
  if (outcome.failures.length === 0) return;
  const attempts = (marker?.codexDirKey === codexDirKey ? marker.attempts ?? 1 : 0) + 1;
  if (attempts < CODEX_UNIFY_MAX_RETRY_ATTEMPTS) return;
  // Out of silent retries: surface it rather than leaving history half-migrated.
  vscode.window.showWarningMessage(
    `部分 Codex 会话未能迁入共享历史列表（${outcome.failures.length} 项），已停止自动重试。关闭 Codex 面板与所有 codex 终端后运行“统一 Codex 会话历史”可再次尝试。原因：${summarizeCodexUnifyFailures(outcome.failures)}`
  );
}

async function runCodexUnifiedMigration(
  context: vscode.ExtensionContext,
  interactive: boolean
): Promise<CodexUnifyMigrationOutcome> {
  const codexDir = getCodexDir();
  const codexDirKey = canonicalCodexDirKey(codexDir);
  const previous = context.globalState.get<CodexUnifyMigrationMarker>(CODEX_UNIFY_MIGRATION_MARKER_KEY);
  const content = await readCodexConfiguration().catch(() => "");
  const outcome = await migrateCodexHistoryToUnifiedBucket({
    codexDir,
    configText: content,
    thirdPartyTagIds: getCodexThirdPartyTagIds(),
    backupParent: getCodexUnifyBackupParent()
  });
  // Mark done for every outcome except "live_not_unified": that one defers the
  // migration while keeping the user's intent for a later retry. Per-item
  // failures no longer throw, so they are recorded on the marker instead.
  if (outcome.skippedReason !== "live_not_unified") {
    await context.globalState.update(CODEX_UNIFY_MIGRATION_MARKER_KEY, {
      codexDirKey,
      completedAt: new Date().toISOString(),
      migratedJsonlFiles: outcome.migratedJsonlFiles,
      migratedStateRows: outcome.migratedStateRows,
      pendingFailures: outcome.failures.length,
      attempts: (previous?.codexDirKey === codexDirKey ? previous.attempts ?? 1 : 0) + 1
    } satisfies CodexUnifyMigrationMarker);
  }
  if (interactive) reportCodexUnifyMigrationOutcome(outcome);
  return outcome;
}

function reportCodexUnifyMigrationOutcome(outcome: CodexUnifyMigrationOutcome): void {
  if (outcome.skippedReason === "live_not_unified") {
    vscode.window.showWarningMessage(
      "尚未执行迁移：Codex 当前配置还没有路由到共享 custom 桶。重载 VS Code 或切换一次 Codex 服务后会自动重试。"
    );
    return;
  }
  if (outcome.skippedReason === "nothing_to_migrate") {
    vscode.window.showInformationMessage(
      "没有需要迁移的旧会话；开启后新建的官方与第三方会话将共用同一历史列表。"
    );
    return;
  }
  const summary = `已把 ${outcome.migratedJsonlFiles} 个会话文件、${outcome.migratedStateRows} 条索引记录迁入共享历史列表（原文件已自动备份）。`;
  if (outcome.failures.length > 0) {
    vscode.window.showWarningMessage(
      `${summary}另有 ${outcome.failures.length} 项未能迁移，通常是 Codex 正在占用相应文件；关闭 Codex 后再次运行本命令即可重试。原因：${summarizeCodexUnifyFailures(outcome.failures)}`
    );
    return;
  }
  vscode.window.showInformationMessage(summary);
}

function reportCodexUnifyRestoreOutcome(outcome: CodexUnifyRestoreOutcome): void {
  if (outcome.skippedReason === "no_backup_ledger") {
    vscode.window.showInformationMessage(
      "没有可还原的迁移备份（可能从未迁入过会话）；此前的官方会话一直在官方列表中。"
    );
    return;
  }
  if (outcome.skippedReason === "nothing_to_restore") {
    vscode.window.showInformationMessage("没有需要还原的内容（备份账本中的会话此前已还原过）。");
    return;
  }
  const summary = `已按备份还原迁入的会话（${outcome.restoredJsonlFiles} 个会话文件、${outcome.restoredStateRows} 条索引记录）。`;
  if (outcome.failures.length > 0) {
    vscode.window.showWarningMessage(
      `${summary}另有 ${outcome.failures.length} 项未能还原；备份仍完好，关闭 Codex 后重新开启再关闭统一历史即可重试。原因：${summarizeCodexUnifyFailures(outcome.failures)}`
    );
    return;
  }
  vscode.window.showInformationMessage(summary);
}

/**
 * Re-routes the live config.toml to match the unified-history toggle without a
 * full provider switch: with the toggle on the active provider (or the official
 * subscription) runs under the shared `custom` id; with it off the previous
 * per-provider ids are restored.
 */
async function applyCodexUnifiedLiveConfig(): Promise<void> {
  const content = await readCodexConfiguration();
  const providers = getCodexProviders();
  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  const activeId = settings.get<string>(CODEX_ACTIVE_PROVIDER_KEY, "");
  const active = providers.find((provider) => provider.id === activeId);
  const unifyOn = isCodexUnifiedHistoryEnabled();
  if (providers.length > 0) await ensureCodexAuthHelper();
  let updated = removeManagedCodexProviders(content);
  if (unifyOn && hasCodexCustomProviderSection(updated)) {
    throw new Error(
      "config.toml 已存在手动定义的 [model_providers.custom] 段；为避免把流量路由到未知后端，请先删除该段，或关闭“统一 Codex 会话历史”。"
    );
  }
  updated = updateTopLevelTomlKey(
    updated,
    "model_provider",
    unifyOn ? CODEX_UNIFIED_PROVIDER_ID : active ? active.id : undefined
  );
  await writeCodexConfigurationFile(
    replaceManagedCodexProviders(
      updated,
      serializeManagedCodexProviders(providers, unifyOn ? active ?? "official" : undefined)
    )
  );
}

async function toggleCodexUnifiedHistory(context: vscode.ExtensionContext): Promise<void> {
  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  const enabled = settings.get<boolean>(CODEX_UNIFY_HISTORY_KEY, false);

  if (enabled) {
    const marker = context.globalState.get<CodexUnifyMigrationMarker>(CODEX_UNIFY_MIGRATION_MARKER_KEY);
    const migrationPending =
      getCodexUnifiedMigrationRequested() &&
      marker?.codexDirKey !== canonicalCodexDirKey(getCodexDir());
    if (migrationPending) {
      const choice = await vscode.window.showWarningMessage(
        "统一会话历史已开启，但会话迁移尚未完成。是否立即重试迁移？",
        { modal: true },
        "重试迁移",
        "关闭统一历史"
      );
      if (choice === "重试迁移") {
        try {
          await runCodexUnifiedMigration(context, true);
        } catch (error) {
          const message = error instanceof Error ? error.message : "未知错误";
          vscode.window.showErrorMessage(`迁移会话历史失败：${message}`);
        }
        return;
      }
      if (choice !== "关闭统一历史") return;
      // User chose to disable: fall through to the disable flow below.
    }
  }

  if (!enabled) {
    const choice = await vscode.window.showWarningMessage(
      "开启后，官方订阅将以共享的 custom 供应商标识运行，官方与第三方会话出现在同一历史列表中。注意：跨供应商继续旧会话时，对方后端可能无法解密会话中的 encrypted_content 推理内容，导致继续失败。",
      { modal: true },
      "开启并迁入现有官方会话",
      "仅开启（不迁入）"
    );
    if (!choice) return;
    const migrate = choice === "开启并迁入现有官方会话";
    try {
      await settings.update(CODEX_UNIFY_HISTORY_KEY, true, vscode.ConfigurationTarget.Global);
      await settings.update(CODEX_UNIFY_MIGRATE_KEY, migrate, vscode.ConfigurationTarget.Global);
      await applyCodexUnifiedLiveConfig();
    } catch (error) {
      await settings.update(CODEX_UNIFY_HISTORY_KEY, false, vscode.ConfigurationTarget.Global);
      await settings.update(CODEX_UNIFY_MIGRATE_KEY, false, vscode.ConfigurationTarget.Global);
      const message = error instanceof Error ? error.message : "未知错误";
      vscode.window.showErrorMessage(`开启统一 Codex 会话历史失败：${message}`);
      return;
    }
    if (migrate) {
      try {
        await runCodexUnifiedMigration(context, true);
      } catch (error) {
        const message = error instanceof Error ? error.message : "未知错误";
        vscode.window.showErrorMessage(
          `迁移会话历史失败（开关已开启，重载或再次运行本命令会自动重试）：${message}`
        );
      }
    } else {
      vscode.window.showInformationMessage(
        "已开启统一 Codex 会话历史。开启后新建的会话进入共享历史列表；此前的官方会话仍留在官方列表，需要时再次运行本命令并选择“开启并迁入现有官方会话”。"
      );
    }
    await offerReload("统一 Codex 会话历史已开启。是否立即重载 VS Code？");
    return;
  }

  const backupAvailable = hasCodexUnifyBackup(getCodexUnifyBackupParent(), getCodexDir());
  const restoreChoice = await vscode.window.showWarningMessage(
    "关闭后，官方订阅与第三方将恢复各自独立的历史列表。统一期间新建的会话无法归属供应商，将留在共享列表（重新开启后可见）。",
    { modal: true },
    ...(backupAvailable
      ? ["关闭并按备份还原已迁入会话" as const, "仅关闭（不还原）" as const]
      : ["仅关闭（不还原）" as const])
  );
  if (!restoreChoice) return;
  const restore = restoreChoice === "关闭并按备份还原已迁入会话";
  try {
    await settings.update(CODEX_UNIFY_HISTORY_KEY, false, vscode.ConfigurationTarget.Global);
    await settings.update(CODEX_UNIFY_MIGRATE_KEY, false, vscode.ConfigurationTarget.Global);
    await context.globalState.update(CODEX_UNIFY_MIGRATION_MARKER_KEY, undefined);
    await applyCodexUnifiedLiveConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    vscode.window.showErrorMessage(`关闭统一 Codex 会话历史失败：${message}`);
    return;
  }
  if (restore) {
    try {
      const outcome = await restoreCodexHistoryFromBackups({
        codexDir: getCodexDir(),
        backupParent: getCodexUnifyBackupParent(),
        restoreBackupParent: getCodexUnifyRestoreParent()
      });
      reportCodexUnifyRestoreOutcome(outcome);
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      vscode.window.showErrorMessage(`还原会话历史失败，请重试（数据未损坏）：${message}`);
    }
  }
  await offerReload("统一 Codex 会话历史已关闭。是否立即重载 VS Code？");
}

async function manageCodexProviders(context: vscode.ExtensionContext): Promise<void> {
  const action = await vscode.window.showQuickPick(
    [
      { label: "切换 Codex 中转站", action: "switch" },
      { label: "使用 Codex 官方 OpenAI Provider", action: "official" },
      { label: "添加 Codex 中转站", action: "add" },
      { label: "编辑 Codex 中转站（名称 / Base URL / API Key）", action: "edit" },
      { label: "删除 Codex 中转站", action: "remove" },
      { label: "清除某个 Codex API Key", action: "clear" },
      { label: "选择 Codex 默认模型", action: "model" },
      { label: "刷新并同步 Codex 模型", action: "refresh" },
      { label: "配置 Codex WebSocket 代理", action: "proxy" },
      {
        label: isCodexUnifiedHistoryEnabled()
          ? "$(history) 关闭统一 Codex 会话历史"
          : "$(history) 统一 Codex 会话历史",
        action: "unify"
      },
      { label: "打开 Codex 页面选择模型", action: "open" },
      { label: "查看 Codex 模型", action: "show" }
    ],
    { title: "管理 Codex Provider" }
  );
  if (!action) return;

  if (action.action === "switch") await switchToCodexGateway(context);
  if (action.action === "official") await switchToCodexOfficial(context);
  if (action.action === "add") await addCodexProvider();
  if (action.action === "edit") await editCodexProvider(context);
  if (action.action === "remove") await removeCodexProvider(context);
  if (action.action === "clear") await clearCodexApiKey(context);
  if (action.action === "model") await configureCodexModel(context);
  if (action.action === "refresh") await refreshCodexModels(context);
  if (action.action === "proxy") await configureCodexProxy();
  if (action.action === "unify") await toggleCodexUnifiedHistory(context);
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
    if (baseUrl?.trim()) vscode.window.showErrorMessage("Base URL 必须以 http:// 或 https:// 开头（公网中转站一般是 https://，本机自建的中转站通常是 http://127.0.0.1:端口）。");
    return undefined;
  }

  // Reusing a stable ID keeps Codex's per-provider session history reachable after a re-add.
  const provider: CodexProviderProfile = {
    id: createCodexProviderId(name, getCodexProviders().map((item) => item.id)),
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

async function editCodexProvider(
  context: vscode.ExtensionContext,
  selectedProvider?: CodexProviderProfile
): Promise<void> {
  const provider = selectedProvider ?? await pickCodexProvider();
  if (!provider) return;
  openProviderManager(context, { kind: "codex", id: provider.id, edit: true });
}

/** `selectedProvider` comes from the manager, where the target was already chosen by clicking it. */
async function removeCodexProvider(
  context: vscode.ExtensionContext,
  selectedProvider?: CodexProviderProfile
): Promise<void> {
  const providers = getCodexProviders();
  const provider = selectedProvider ?? (await vscode.window.showQuickPick(
    providers.map((item) => ({ label: item.name, description: item.baseUrl, provider: item })),
    { title: "删除 Codex Provider" }
  ))?.provider;
  if (!provider) return;

  const dependents = getGateways().filter((gateway) =>
    gateway.adapter?.upstreamKind === "codexProvider" && gateway.adapter.upstreamId === provider.id
  );
  if (dependents.length > 0) {
    vscode.window.showWarningMessage(`无法删除“${provider.name}”：实验性协议转换服务 ${dependents.map((item) => `“${item.name}”`).join("、")} 正依赖它。请先删除这些转换服务。`);
    return;
  }

  const activeId = vscode.workspace
    .getConfiguration("aiProviderSwitcher")
    .get<string>(CODEX_ACTIVE_PROVIDER_KEY, "");
  if (activeId === provider.id) {
    vscode.window.showWarningMessage("当前 Codex Provider 正在使用，请先切换到官方 Provider 后再删除。");
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `确定删除“${provider.name}”？Codex 已经记录的会话不会被删除。每条会话都固定记着创建时所用的 Provider ID，用同样的名称重新添加会沿用同一个 ID。`,
    { modal: true },
    "删除"
  );
  if (confirm !== "删除") return;

  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  await settings.update(
    CODEX_PROVIDERS_KEY,
    providers.filter((item) => item.id !== provider.id),
    vscode.ConfigurationTarget.Global
  );
  await context.secrets.delete(`${CODEX_SECRET_KEY_PREFIX}${provider.id}`);
  if (provider.adapter) await context.secrets.delete(`${PROTOCOL_ADAPTER_SECRET_KEY_PREFIX}${provider.adapter.id}`);
  await deleteCodexApiKeyFile(provider);
  vscode.window.showInformationMessage(`已删除 Codex Provider：${provider.name}`);
}

async function clearCodexApiKey(context: vscode.ExtensionContext): Promise<void> {
  const selected = await pickCodexProvider();
  if (!selected) return;
  await context.secrets.delete(`${CODEX_SECRET_KEY_PREFIX}${selected.id}`);
  await deleteCodexApiKeyFile(selected);

  // config.toml keeps the provider's [.auth] block pointing at the key file we just
  // deleted. That is correct for an inactive provider — the block must survive so its
  // session history stays resolvable — but if this provider is the active one, the
  // next Codex request fails at the auth helper with no hint about why.
  const activeId = vscode.workspace
    .getConfiguration("aiProviderSwitcher")
    .get<string>(CODEX_ACTIVE_PROVIDER_KEY, "");
  if (activeId === selected.id) {
    vscode.window.showWarningMessage(
      `已清除“${selected.name}”的 Codex API Key，但它仍是当前生效的 Codex Provider。` +
        `在重新设置 Key 之前 Codex 将无法完成鉴权，请重新设置 Key 或切换到其他 Provider。`
    );
    return;
  }
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

/**
 * Not every Responses API gateway exposes /v1/models, so fall back to hand-entered IDs
 * instead of blocking the switch. Returns undefined only when the user backs out.
 */
async function resolveCodexModels(
  provider: CodexProviderProfile,
  apiKey: string
): Promise<string[] | undefined> {
  const cached = getCodexModels().find((entry) => entry.providerId === provider.id)?.models ?? [];
  if (cached.length > 0) return cached;
  if (provider.adapter) {
    vscode.window.showWarningMessage(`“${provider.name}”是实验性文本协议转换服务，模型来自上游服务的缓存。请先刷新或手动填写上游服务的模型列表。`);
    return undefined;
  }

  let discoveryError = "";
  try {
    const response = await requestCodexModels(provider.baseUrl, apiKey);
    await saveUsageFromResponseHeaders("codex", provider.id, response.headers);
    if (response.models.length > 0) {
      await saveCodexModels(provider.id, response.models);
      return response.models;
    }
  } catch (error) {
    discoveryError = error instanceof Error ? error.message : "未知网络错误";
  }

  const manual = await promptCodexModelIds(
    provider,
    discoveryError
      ? `“${provider.name}”的模型列表获取失败（${discoveryError}）。`
      : `“${provider.name}”没有返回任何模型。`
  );
  if (!manual) return undefined;
  await saveCodexModels(provider.id, manual);
  return manual;
}

async function promptCodexModelIds(
  provider: CodexProviderProfile,
  reason: string,
  value = ""
): Promise<string[] | undefined> {
  const entered = await vscode.window.showInputBox({
    title: `手动填写 ${provider.name} 的模型`,
    prompt: `${reason}请输入该服务接受的模型 ID，多个用逗号分隔；它们会被同步到 Codex 原生模型栏。`,
    value,
    ignoreFocusOut: true,
    validateInput: (input) =>
      parseCodexModelIds(input).length > 0 ? undefined : "至少填写一个模型 ID"
  });
  if (entered === undefined) return undefined;
  const models = parseCodexModelIds(entered);
  return models.length > 0 ? models : undefined;
}

/** Pins the top-level `model` key in ~/.codex/config.toml for the active custom provider. */
async function configureCodexModel(
  context: vscode.ExtensionContext,
  selectedProvider?: CodexProviderProfile
): Promise<void> {
  const activeId = vscode.workspace
    .getConfiguration("aiProviderSwitcher")
    .get<string>(CODEX_ACTIVE_PROVIDER_KEY, "");
  const provider = selectedProvider ?? getCodexProviders().find((item) => item.id === activeId);

  if (!provider) {
    const choice = await vscode.window.showInformationMessage(
      "Codex 正在使用官方服务，模型由 Codex 自己的模型栏决定。切换到自定义服务后即可在这里固定默认模型。",
      "切换 Codex 服务"
    );
    if (choice === "切换 Codex 服务") await switchToCodexGateway(context);
    return;
  }
  if (provider.id !== activeId) {
    const choice = await vscode.window.showWarningMessage(
      `“${provider.name}”不是当前 Codex Provider，默认模型只能为当前 Provider 固定。`,
      "先切换到该 Provider",
      "取消"
    );
    if (choice === "先切换到该 Provider") await switchToCodexGateway(context, provider);
    return;
  }

  const apiKey = await getStoredCodexApiKey(context, provider);
  if (!apiKey) {
    vscode.window.showWarningMessage(`“${provider.name}”尚未保存 API Key，请先切换到该 Provider。`);
    return;
  }

  const models = await resolveCodexModels(provider, apiKey);
  if (!models) return;

  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  const current = settings.get<string>(CODEX_ACTIVE_MODEL_KEY, "");
  const picked = await pickCodexModel(provider, models, current);
  if (picked === undefined) return;

  const nextModels = picked && !models.includes(picked) ? [...models, picked] : models;
  if (nextModels.length !== models.length) await saveCodexModels(provider.id, nextModels);
  await writeCodexConfiguration(context, provider, nextModels, picked || undefined);
  await settings.update(CODEX_ACTIVE_MODEL_KEY, picked, vscode.ConfigurationTarget.Global);
  await refreshStatusBar();
  await offerReload(
    picked
      ? `Codex 默认模型已固定为“${picked}”。是否立即重载 VS Code？`
      : "Codex 默认模型已交回原生模型栏决定。是否立即重载 VS Code？"
  );
}

/** Returns "" to unpin, undefined when cancelled. */
async function pickCodexModel(
  provider: CodexProviderProfile,
  models: string[],
  current: string
): Promise<string | undefined> {
  const selected = await vscode.window.showQuickPick(
    [
      ...models.map((model) => ({
        label: model,
        description: model === current ? "当前默认模型" : "已同步到 Codex 模型栏",
        choice: "model" as const,
        model
      })),
      {
        label: "$(edit) 手动输入模型 ID",
        description: "模型列表不完整时使用",
        choice: "manual" as const,
        model: ""
      },
      {
        label: "$(circle-slash) 交回 Codex 原生模型栏",
        description: current ? "移除已固定的默认模型" : "当前行为",
        choice: "native" as const,
        model: ""
      }
    ],
    {
      title: `选择 ${provider.name} 的默认模型`,
      placeHolder: `写入 ${CODEX_CONFIG_FILE} 的顶层 model 键`
    }
  );
  if (!selected) return undefined;
  if (selected.choice !== "manual") return selected.model;
  const entered = await vscode.window.showInputBox({
    title: `输入 ${provider.name} 的默认模型 ID`,
    prompt: "该模型会写入 config.toml 的顶层 model 键，并同步到 Codex 原生模型栏",
    value: current,
    ignoreFocusOut: true,
    validateInput: (input) => (input.trim() ? undefined : "模型 ID 不能为空")
  });
  return entered?.trim() || undefined;
}

async function confirmCodexProviderSwitch(target: string): Promise<boolean> {
  const choice = await vscode.window.showInformationMessage(
    `准备切换到“${target}”。已有会话记录不会被删除，但当前对话不会自动迁移到新的 Provider 或模型——每条会话固定绑定创建时的 Provider，切换后请新建对话。是否继续？`,
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
    prompt: describeCodexKeyStorage(),
    password: true,
    ignoreFocusOut: true
  });
  if (!entered?.trim()) {
    vscode.window.showWarningMessage("未输入 Codex API Key，切换已取消。");
    return undefined;
  }

  const apiKey = entered.trim();
  await context.secrets.store(secretKey, apiKey);
  await refreshProtocolAdapterSecrets(context);
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
  if (provider.adapter) {
    const upstream = provider.adapter.upstreamKind === "claudeGateway"
      ? getGateways().find((item) => item.id === provider.adapter?.upstreamId)
      : undefined;
    const models = upstream ? (getGatewayModels().find((entry) => entry.gatewayId === upstream.id)?.models ?? []) : [];
    if (models.length === 0) {
      vscode.window.showWarningMessage(`“${provider.name}”的模型来自上游 Anthropic 服务缓存。请先刷新“${upstream?.name ?? "已删除的上游服务"}”的模型列表。`);
      return;
    }
    await saveCodexModels(provider.id, models);
    if (vscode.workspace.getConfiguration("aiProviderSwitcher").get<string>(CODEX_ACTIVE_PROVIDER_KEY, "") === provider.id) {
      await writeCodexConfiguration(context, provider, models);
    }
    vscode.window.showInformationMessage(`已从上游“${upstream?.name}”同步 ${models.length} 个实验性文本转换模型。工具调用与 Agent 功能暂不支持。`);
    return;
  }

  try {
    const response = await requestCodexModels(provider.baseUrl, apiKey);
    const models = response.models;
    await saveUsageFromResponseHeaders("codex", provider.id, response.headers);
    if (models.length === 0) {
      // Never let an empty response wipe a hand-entered catalog.
      const cached = getCodexModels().find((entry) => entry.providerId === provider.id)?.models ?? [];
      vscode.window.showWarningMessage(
        cached.length > 0
          ? `“${provider.name}”没有返回任何模型，已保留原有的 ${cached.length} 个模型。`
          : `“${provider.name}”没有返回任何模型，请在切换或配置模型时手动填写模型 ID。`
      );
      return;
    }
    await saveCodexModels(provider.id, models);
    const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
    const activeProviderId = settings.get<string>(CODEX_ACTIVE_PROVIDER_KEY, "");
    if (activeProviderId === provider.id) {
      const pinned = settings.get<string>(CODEX_ACTIVE_MODEL_KEY, "");
      const keptModel = pinned && models.includes(pinned) ? pinned : "";
      await writeCodexConfiguration(context, provider, models, keptModel || undefined);
      await settings.update(CODEX_ACTIVE_MODEL_KEY, keptModel, vscode.ConfigurationTarget.Global);
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
  // Same reason as the Claude side: a self-hosted relay on http:// is a supported
  // Base URL, so the transport has to follow the scheme instead of assuming TLS.
  const transport = endpoint.protocol === "http:" ? http : https;
  return new Promise((resolve, reject) => {
    const request = transport.request(
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
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(describeGatewayModelFailure(status, body)));
            return;
          }
          try {
            resolve({ models: parseGatewayModelList(body), headers: response.headers });
          } catch {
            reject(new Error("网关返回的 Codex 模型列表不是有效 JSON"));
          }
        });
      }
    );
    request.on("error", (error) => reject(new Error(describeConnectionFailure(error, endpoint))));
    request.setTimeout(15000, () => {
      request.destroy();
      reject(new Error(`连接 ${endpoint.hostname} 超时（15 秒）：请检查网络、VPN 或代理设置`));
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

function normalizeProtocolAdapterBinding(value: unknown): ProtocolAdapterBinding | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const id = String(record.id ?? "").trim();
  const direction = record.direction;
  const upstreamKind = record.upstreamKind;
  const upstreamId = String(record.upstreamId ?? "").trim();
  if (!id || !upstreamId || record.textOnly !== true) return undefined;
  if (direction !== "anthropicToResponses" && direction !== "responsesToAnthropic") return undefined;
  if (upstreamKind !== "claudeGateway" && upstreamKind !== "codexProvider") return undefined;
  return { id, direction, upstreamKind, upstreamId, textOnly: true };
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
      usage: normalizeUsageConfiguration(item.usage),
      adapter: normalizeProtocolAdapterBinding(item.adapter)
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
  await writeCodexModelCatalog(models, provider.adapter?.textOnly === true);
  const providers = getCodexProviders();
  const unifyOn = isCodexUnifiedHistoryEnabled();
  let updated = removeManagedCodexProviders(content);
  if (unifyOn && hasCodexCustomProviderSection(updated)) {
    throw new Error(
      "config.toml 已存在手动定义的 [model_providers.custom] 段；为避免把流量路由到未知后端，请先删除该段，或关闭“统一 Codex 会话历史”。"
    );
  }
  updated = updateTopLevelTomlKey(
    updated,
    "model_provider",
    unifyOn ? CODEX_UNIFIED_PROVIDER_ID : provider.id
  );
  updated = updateTopLevelTomlKey(updated, "model_catalog_json", CODEX_MODEL_CATALOG_FILE);
  updated = updateTopLevelTomlKey(updated, "model", selectedModel);
  await writeCodexConfigurationFile(
    replaceManagedCodexProviders(updated, serializeManagedCodexProviders(providers, unifyOn ? provider : undefined))
  );
}

async function writeCodexModelCatalog(models: string[], textOnly = false): Promise<void> {
  await fs.mkdir(path.dirname(CODEX_MODEL_CATALOG_FILE), { recursive: true });
  await fs.writeFile(
    CODEX_MODEL_CATALOG_FILE,
    `${JSON.stringify(createCodexModelCatalog(models, textOnly), null, 2)}\n`,
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

/**
 * Guards the one address that means different machines on the two sides of a
 * remote connection. Both the detected value (`http.proxy` travels with Settings
 * Sync) and a hand-typed one can be a local address about to be written into the
 * remote host's `~/.codex/.env`, where it resolves to nothing.
 */
async function confirmRemoteCodexProxy(proxyUrl: string): Promise<boolean> {
  const risk = describeRemoteProxyRisk(getRemoteEnvironment().kind, proxyUrl);
  if (!risk) return true;
  const choice = await vscode.window.showWarningMessage(
    risk,
    { modal: true },
    "仍然写入",
    "取消"
  );
  return choice === "仍然写入";
}

async function configureCodexProxy(): Promise<void> {
  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  const remote = getRemoteEnvironment();
  const configuredProxy = settings.get<string>(CODEX_PROXY_URL_KEY, "");
  const proxyMode = settings.get<CodexProxyMode>(CODEX_PROXY_MODE_KEY, "officialOnly");
  const detection = await detectCodexProxyUrl();
  const detectedProxy = detection.url;
  const envContent = await readCodexEnvFile();
  const unmanagedEntries = findUnmanagedCodexProxyEnv(envContent);
  const scopeLabel = proxyMode === "officialOnly" ? "仅官方服务" : "官方及所有中转站";
  const action = await vscode.window.showQuickPick(
    [
      {
        label: `$(search) 自动检测并应用${remote.label}的代理`,
        description: detectedProxy ?? (detection.hint
          ? "系统代理无固定地址，需手动输入"
          : `未在${remote.label}检测到 HTTP(S) 系统代理，可改用手动输入`),
        action: "detect"
      },
      {
        label: "$(edit) 设置或更新代理",
        description: configuredProxy || `手动输入${remote.label}能访问到的地址和端口`,
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
      placeHolder: remote.isRemote
        ? `代理写入${remote.label}的 ${CODEX_ENV_FILE}，地址必须是该主机能访问到的`
        : "同时适用于 Codex 官方服务和自定义 Provider"
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
          detection.hint ??
            (remote.isRemote
              ? `未在${remote.label}检测到 HTTP(S) 代理。远程主机通常没有图形化的系统代理设置，可在该主机上导出 HTTPS_PROXY 环境变量后重试，或选择“设置或更新代理”手动填写。`
              : "未检测到当前设备的 HTTP(S) 代理。请确认系统代理已启用，或选择“设置或更新代理”手动填写。")
        );
        return;
      }
      if (!await confirmRemoteCodexProxy(detectedProxy)) return;
      if (!await confirmCodexEnvProxyConflicts(envContent, unmanagedEntries)) return;
      await applyCodexProxy(settings, detectedProxy, proxyMode);
      return;
    }
    if (action.action === "set") {
      const entered = await vscode.window.showInputBox({
        title: "配置 Codex 代理地址",
        prompt: remote.isRemote
          ? `输入 ${remote.label} 能访问到的代理地址；那里的 127.0.0.1 指的是该主机自己，不是你面前这台电脑`
          : "输入代理地址，例如 http://127.0.0.1:7890（Clash）或 http://127.0.0.1:10808（v2rayN）",
        placeHolder: "http://127.0.0.1:<当前设备端口>",
        value: configuredProxy || detectedProxy || "http://127.0.0.1:",
        ignoreFocusOut: true
      });
      if (!entered?.trim()) return;
      const proxyUrl = normalizeCodexProxyUrl(entered);
      if (!await confirmRemoteCodexProxy(proxyUrl)) return;
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
    `检测到 ${CODEX_ENV_FILE} 已有 ${entries.length} 个非本插件管理的代理变量。重复变量的生效顺序可能因 Codex 的 dotenv 解析方式而异，建议先处理冲突。`,
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
    vscode.window.showInformationMessage(`${CODEX_ENV_FILE} 中未发现非本插件管理的代理变量。`);
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
  vscode.window.showInformationMessage(`已移除 ${CODEX_ENV_FILE} 中原有的代理变量，其他内容已保留。`);
}

type CodexProxyDetection = {
  url?: string;
  /** Why detection came up empty, when the system can actually explain itself. */
  hint?: string;
};

async function detectCodexProxyUrl(): Promise<CodexProxyDetection> {
  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
    const value = process.env[name]?.trim();
    if (!value) continue;
    try {
      return { url: normalizeCodexProxyUrl(value) };
    } catch {
      // Continue to the operating-system proxy configuration.
    }
  }
  const vscodeProxy = vscode.workspace.getConfiguration("http").get<string>("proxy", "").trim();
  if (vscodeProxy) {
    try {
      return { url: normalizeCodexProxyUrl(vscodeProxy) };
    } catch {
      // Continue to the operating-system proxy configuration.
    }
  }
  if (process.platform === "win32") return { url: await queryWindowsInternetProxy() };
  if (process.platform === "darwin") return queryMacOsInternetProxy();
  if (process.platform === "linux") return queryLinuxInternetProxy();
  return {};
}

async function queryMacOsInternetProxy(): Promise<CodexProxyDetection> {
  const output = await collectProcessOutput("scutil", ["--proxy"]);
  if (!output) return {};
  let settings: ReturnType<typeof parseMacOsProxyConfiguration>;
  try {
    settings = parseMacOsProxyConfiguration(output);
  } catch {
    return {};
  }
  if (settings.manualUrl) return { url: settings.manualUrl };
  // A PAC or WPAD setup is a real, enabled proxy that yields no fixed address.
  // Reporting it as "no proxy found" sent users to re-check a setting that was
  // already on; naming it tells them what to copy out of the PAC file instead.
  if (settings.autoConfigUrl) {
    return {
      hint: `系统代理使用自动配置脚本（PAC：${settings.autoConfigUrl}），其中没有固定的代理地址可供读取。` +
        `Codex 无法执行 PAC 脚本，请在代理软件中查看实际的 HTTP 端口后，用“设置或更新代理”手动填写。`
    };
  }
  if (settings.autoDiscover) {
    return {
      hint: "系统代理使用自动发现（WPAD），没有固定的代理地址可供读取。" +
        "请在代理软件中查看实际的 HTTP 端口后，用“设置或更新代理”手动填写。"
    };
  }
  return {};
}

async function queryLinuxInternetProxy(): Promise<CodexProxyDetection> {
  const gnome = await queryGnomeInternetProxy();
  if (gnome) return { url: gnome };
  const kde = await readKdeInternetProxy();
  if (kde) return { url: kde };
  return {};
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

/**
 * Linux is not only GNOME. KDE keeps its proxy in kioslaverc, and `gsettings`
 * is absent entirely under WSL — both looked identical to "no proxy configured".
 */
async function readKdeInternetProxy(): Promise<string | undefined> {
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  try {
    const content = await fs.readFile(path.join(configHome, "kioslaverc"), "utf8");
    return parseKdeProxySettings(content);
  } catch {
    return undefined;
  }
}

/** Detection probes are best-effort; none of them may hang the proxy menu. */
const PROXY_PROBE_TIMEOUT_MS = 5000;

function collectProcessOutput(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    // windowsHide defaults to false, so every probe flashed a console window on
    // Windows — once per gsettings/reg call, i.e. several times per menu open.
    const child = spawn(command, args, { windowsHide: true });
    let output = "";
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(undefined);
    }, PROXY_PROBE_TIMEOUT_MS);
    // Never let the probe hold the extension host open at shutdown.
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    // An unread stderr pipe fills at ~64KB and deadlocks the child. reg.exe is
    // chatty about inaccessible keys, so drain it instead of leaving it stopped.
    child.stderr?.resume();
    child.on("error", () => finish(undefined));
    child.on("close", (code) => finish(code === 0 ? output : undefined));
  });
}

async function queryWindowsInternetProxy(): Promise<string | undefined> {
  const output = await collectProcessOutput("reg.exe", [
    "query",
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"
  ]);
  if (!output || !/^\s*ProxyEnable\s+REG_DWORD\s+0x1\s*$/im.test(output)) return undefined;
  const proxyServer = output.match(/^\s*ProxyServer\s+REG_SZ\s+(.+?)\s*$/im)?.[1];
  if (!proxyServer) return undefined;
  try {
    return parseWindowsProxyServer(proxyServer);
  } catch {
    return undefined;
  }
}

function serializeManagedCodexProviders(
  providers: CodexProviderProfile[],
  unified?: CodexProviderProfile | "official"
): string {
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
  if (unified === "official") {
    providerBlocks.push(serializeCodexUnifiedOfficialBlock());
  } else if (unified) {
    const keyFile = getCodexApiKeyFile(unified);
    const auth = createCodexAuthConfig(process.platform, CODEX_AUTH_HELPER_FILE, keyFile);
    providerBlocks.push(
      serializeCodexUnifiedProviderBlock(
        { name: unified.name, baseUrl: getCodexApiBaseUrl(unified.baseUrl) },
        auth
      )
    );
  }
  return [CODEX_MANAGED_BEGIN, ...providerBlocks, CODEX_MANAGED_END].join("\n");
}

const CODEX_AUTH_HELPER_FILE = path.join(
  CODEX_HOME_DIR,
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
    // Emitting the string onto the pipeline makes PowerShell append CRLF, so the
    // Windows helper handed Codex "sk-xxx\r\n" where the POSIX helper hands it the
    // bare key. Write straight to stdout so both platforms emit the same bytes.
    "try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) }",
    "finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }"
  ].join("\r\n");
  await fs.writeFile(CODEX_AUTH_HELPER_FILE, helper, "utf8");
}

async function writeCodexApiKeyFile(provider: CodexProviderProfile, apiKey: string): Promise<void> {
  await ensureCodexAuthHelper();
  const keyFile = getCodexApiKeyFile(provider);
  if (process.platform !== "win32") {
    await fs.mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 });
    // `cat` emits the file verbatim, so a trailing newline here becomes a trailing
    // newline in what Codex receives. Store the bare key to match the Windows helper.
    await fs.writeFile(keyFile, apiKey, { encoding: "utf8", mode: 0o600 });
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
  return path.join(CODEX_HOME_DIR, `ai-provider-switcher-codex-${safeId}.key`);
}

function runPowerShell(command: string, input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      command
    ], { windowsHide: true });
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

/** An absent list means "discover from the gateway"; an empty one is the same. */
function normalizeDesktopModelNames(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const names = raw.map((item) => String(item ?? "").trim()).filter(Boolean);
  return names.length > 0 ? [...new Set(names)] : undefined;
}

/** Reads only well-formed, self-consistent catalogue routes from stored settings. */
function normalizeDesktopRoutes(raw: unknown, providerId: string): ClaudeDesktopRoute[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const routes: ClaudeDesktopRoute[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const model = String(record.model ?? "").trim();
    const routeId = String(record.routeId ?? "").trim();
    // The route ID is derived rather than trusted, preventing a hand-edited
    // settings entry from sending a Desktop request to a different model.
    if (!model || routeId !== toClaudeDesktopRouteId(providerId, model) || seen.has(model)) continue;
    seen.add(model);
    routes.push({ routeId, model, supports1m: record.supports1m === true });
  }
  return routes.length > 0 ? routes : undefined;
}

function getGateways(): GatewayProfile[] {
  const settings = vscode.workspace.getConfiguration("aiProviderSwitcher");
  const raw = settings.get<unknown>("gateways", []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => {
      const baseUrl = normalizeClaudeProviderBaseUrl(String(item.baseUrl ?? ""));
      const id = String(item.id ?? "").trim();
      return {
        id,
        name: String(item.name ?? "").trim(),
        baseUrl,
        modelMapping: normalizeClaudeModelMapping(item.modelMapping) ??
          (isDeepSeekAnthropicApi(baseUrl) ? getDeepSeekClaudeModelMapping() : undefined),
        permissionStrategy: normalizeClaudePermissionStrategy(item.permissionStrategy),
        usage: normalizeUsageConfiguration(item.usage),
        desktopModels: normalizeDesktopModelNames(item.desktopModels),
        desktopModel1m: normalizeDesktopModelNames(item.desktopModel1m),
        desktopRoutes: normalizeDesktopRoutes(item.desktopRoutes, id),
        adapter: normalizeProtocolAdapterBinding(item.adapter)
      };
    })
    .filter((gateway) => gateway.id && gateway.name && gateway.baseUrl);
}

function getCurrentClaudeProvider(): GatewayProfile | undefined {
  const providers = getGateways();
  const envVars = getClaudeEnvVars();
  const activeId = vscode.workspace
    .getConfiguration("aiProviderSwitcher")
    .get<string>(CLAUDE_ACTIVE_PROVIDER_KEY, "");
  const recorded = providers.find((provider) => provider.id === activeId);
  const byEnvironment = findClaudeProviderByEnvironment(envVars, providers);
  if (byEnvironment) {
    // The environment match is by Base URL, which is not unique — one relay used
    // with two accounts is two providers sharing a URL, and the earlier one in the
    // list would always win. The recorded active id is the provider this extension
    // actually applied, so it breaks that tie whenever it names the same endpoint.
    if (recorded && findClaudeProviderByEnvironment(envVars, [recorded])) return recorded;
    return byEnvironment;
  }
  if (findEnvValue(envVars, "ANTHROPIC_BASE_URL")?.trim()) return undefined;
  return recorded;
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
  await refreshClaudeDesktopSnapshot();
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
