/**
 * Claude Desktop third-party (3P) inference configuration.
 *
 * Claude Desktop does not read a top-level `env` block — `claude_desktop_config.json`
 * is the app's own preferences/MCP document, and the desktop app injects its own
 * ANTHROPIC_* variables when it spawns an agent session. Custom gateways are
 * configured through the app's 3P mechanism instead:
 *
 *   <root>/claude_desktop_config.json       { "deploymentMode": "3p" }
 *   <root>-3p/configLibrary/_meta.json      { "appliedId": "...", "entries": [...] }
 *   <root>-3p/configLibrary/<id>.json       { "inferenceProvider": "gateway", ... }
 *
 * `deploymentMode` selects the profile directory and `_meta.appliedId` selects
 * which stored config is live, so the app already models a provider library with
 * an active pointer — that is what this module reads and writes.
 *
 * Everything here is either a pure string transform or a read-only lookup; the
 * actual writes (atomic rename plus backup) stay in the extension host. Install
 * locations differ per machine and per build, so roots are discovered from a
 * candidate list and every path helper is parameterized for its platform rather
 * than reading `process.platform` or `process.env` behind the caller's back.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type ClaudeDesktopPathOptions = {
  homedir?: string;
  /** Pass "" to model an unset variable rather than falling through to the real environment. */
  localAppData?: string;
  appData?: string;
  xdgConfigHome?: string;
};

export type ClaudeDesktopLayout = {
  /** Directory holding the bootstrap claude_desktop_config.json. */
  root: string;
  /** userData directory for a deployment mode: `<root>` for 1P, `<root>-3p` for 3P. */
  profileDir: string;
  bootstrapFile: string;
  profileConfigFile: string;
  configLibraryDir: string;
  metaFile: string;
};

export type ClaudeDesktopEntry = { id: string; name: string };
export type ClaudeDesktopMeta = { appliedId: string; entries: ClaudeDesktopEntry[] };

export type ClaudeDesktopInstall = {
  root: string;
  /** Persisted deployment mode; "" when the app has never left the default. */
  deploymentMode: string;
  /** Profile directories that exist on disk — used only to report what was found. */
  profileDirs: string[];
};

/**
 * One entry of the app's `inferenceModels` list. A bare string is also accepted
 * by the app, but the object form carries the tier mapping, so it is what this
 * module emits.
 */
export type ClaudeDesktopModelEntry = {
  /** Exactly the ID the gateway serves — it is what the app sends upstream. */
  name: string;
  /** Which Claude tier this model stands in for, so `sonnet`-style aliases resolve. */
  anthropicFamilyTier?: ClaudeDesktopTier;
  /** Breaks the tie when several entries claim the same tier. */
  isFamilyDefault?: boolean;
  supports1m?: boolean;
  /** Makes the 1M variant the default picker selection; needs `supports1m`. */
  prefer1m?: boolean;
  /** Display-only name in the app's model picker; the ID sent upstream is `name`. */
  labelOverride?: string;
};

export type ClaudeDesktopGatewaySettings = {
  baseUrl: string;
  apiKey: string;
  /** Optional model list; the first entry becomes the app's default model. */
  models?: ClaudeDesktopModelEntry[];
};

/** The tier aliases Claude Desktop resolves against `anthropicFamilyTier`. */
export const CLAUDE_DESKTOP_TIERS = ["sonnet", "opus", "haiku", "fable", "mythos"] as const;
export type ClaudeDesktopTier = (typeof CLAUDE_DESKTOP_TIERS)[number];

/**
 * Claude Desktop rejects `inferenceModels` entries whose ID does not look like an
 * Anthropic model route, and reports the whole config as invalid when one slips
 * through — so the same check is applied before writing. Mirrors the app's own
 * rules: a bare tier alias always passes; otherwise the name has to mention an
 * Anthropic family and must not name a foreign model.
 */
const CLAUDE_DESKTOP_TIER_ALIAS = new RegExp(`^(${CLAUDE_DESKTOP_TIERS.join("|")})(-[\\d.]+)?$`);
const CLAUDE_DESKTOP_FOREIGN_MODEL =
  /ark-code|astron|command-r|deepseek|doubao|gemini|gemma|glm|gpt|grok|hermes|hy3|kimi|lfm|\bling\b|llama|longcat|mimo|minimax|mistral|mixtral|moonshot|nemotron|openai|phi-|qianfan|qwen|tc-code|\bunic\b|yi-|stepfun|step-3|seed-|bytedance|hunyuan|granite|amazon\.nova|nova-|devstral|ministral|ernie|codex|arcee|trinity|abab|phi\d|\bk2\.|\bm2\.|jamba|arctic|solar|mercury|zamba|kat-coder|\bds-|dpsk/;
const CLAUDE_DESKTOP_ANTHROPIC_HINTS = ["claude", ...CLAUDE_DESKTOP_TIERS, "anthropic"];

export function isClaudeDesktopCompatibleModel(name: string): boolean {
  const model = name.trim().toLowerCase();
  if (!model) return false;
  if (CLAUDE_DESKTOP_TIER_ALIAS.test(model)) return true;
  if (CLAUDE_DESKTOP_FOREIGN_MODEL.test(model)) return false;
  return CLAUDE_DESKTOP_ANTHROPIC_HINTS.some((hint) => model.includes(hint));
}

/** The tier each mapped model stands in for, in the app's own vocabulary. */
export type ClaudeDesktopTierHints = Partial<Record<ClaudeDesktopTier, string>> & {
  /** Becomes the first entry, which the app uses as the default model. */
  defaultModel?: string;
  supports1m?: boolean;
  /** Start the picker on the 1M variant; only meaningful with `supports1m`. */
  prefer1m?: boolean;
};

/**
 * Turns a gateway's model list into `inferenceModels`. Incompatible IDs are
 * dropped rather than written, because a single rejected entry invalidates the
 * whole config; the caller reports what was left out.
 */
export function buildClaudeDesktopModelEntries(
  models: string[],
  hints: ClaudeDesktopTierHints = {}
): { entries: ClaudeDesktopModelEntry[]; rejected: string[] } {
  const seen = new Set<string>();
  const usable: string[] = [];
  const rejected: string[] = [];
  const ordered = [hints.defaultModel ?? "", ...models];
  for (const raw of ordered) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    (isClaudeDesktopCompatibleModel(name) ? usable : rejected).push(name);
  }
  const claimed = new Set<ClaudeDesktopTier>();
  const entries = usable.map((name) => {
    const entry: ClaudeDesktopModelEntry = { name };
    const tier = CLAUDE_DESKTOP_TIERS.find((candidate) => hints[candidate]?.trim() === name);
    if (tier) {
      entry.anthropicFamilyTier = tier;
      // Only the first entry claiming a tier wins; the app warns about the rest.
      if (!claimed.has(tier)) {
        entry.isFamilyDefault = true;
        claimed.add(tier);
      }
    }
    if (hints.supports1m && name === hints.defaultModel?.trim()) {
      entry.supports1m = true;
      if (hints.prefer1m) entry.prefer1m = true;
    }
    return entry;
  });
  return { entries, rejected };
}

/**
 * Anthropic-named IDs offered to a gateway whose own model names Claude Desktop
 * refuses. The app sends these upstream verbatim, so they only work when the
 * gateway maps Claude names onto its own models — which the common
 * Anthropic-compatible endpoints do (DeepSeek's `/anthropic` routes
 * `claude-opus-*` to its pro model and every other `claude-*` name to its fast
 * one). Sonnet leads because the app treats the first entry as the default, and
 * the names track the current Claude generations so the picker does not look
 * dated.
 */
export const CLAUDE_DESKTOP_ALIAS_MODELS = [
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-haiku-5"
] as const;

/** The tier an Anthropic-style ID names, e.g. `claude-opus-5` → `opus`. */
export function inferClaudeDesktopTier(name: string): ClaudeDesktopTier | undefined {
  const model = name.trim().toLowerCase();
  return CLAUDE_DESKTOP_TIERS.find((tier) => new RegExp(`(^|[^a-z])${tier}([^a-z]|$)`).test(model));
}

/** `Opus · deepseek`, so the picker shows which gateway is really answering. */
function formatClaudeDesktopLabel(
  name: string,
  tier: ClaudeDesktopTier | undefined,
  source: string
): string | undefined {
  const gateway = source.trim();
  if (!gateway) return undefined;
  const head = tier ? `${tier.charAt(0).toUpperCase()}${tier.slice(1)}` : name.trim();
  return `${head} · ${gateway}`;
}

/**
 * Turns hand-picked Anthropic-style aliases into `inferenceModels`. Unlike the
 * discovery path the tier is read from the alias itself, since the alias exists
 * precisely because the gateway's real model names could not be used. `source`
 * labels the entries with the gateway they resolve to, so the picker does not
 * look like it is offering genuine Claude models. The 1M declaration is
 * per-entry: `options.supports1m` is a capability assertion applied to every
 * alias when a plain `true`, or a predicate consulted per name when different
 * aliases resolve to models with different context windows. `options.prefer1m`
 * additionally makes the default (first) entry's 1M variant the picker's
 * default selection, when that entry advertises one.
 */
export function buildClaudeDesktopAliasEntries(
  names: readonly string[],
  source = "",
  options: { supports1m?: boolean | ((name: string) => boolean); prefer1m?: boolean } = {}
): { entries: ClaudeDesktopModelEntry[]; rejected: string[] } {
  const seen = new Set<string>();
  const usable: string[] = [];
  const rejected: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    (isClaudeDesktopCompatibleModel(name) ? usable : rejected).push(name);
  }
  const claimed = new Set<ClaudeDesktopTier>();
  const entries = usable.map((name) => {
    const entry: ClaudeDesktopModelEntry = { name };
    const tier = inferClaudeDesktopTier(name);
    if (tier) {
      entry.anthropicFamilyTier = tier;
      if (!claimed.has(tier)) {
        entry.isFamilyDefault = true;
        claimed.add(tier);
      }
    }
    const label = formatClaudeDesktopLabel(name, tier, source);
    if (label) entry.labelOverride = label;
    const oneM = typeof options.supports1m === "function"
      ? options.supports1m(name) === true
      : options.supports1m === true;
    if (oneM) entry.supports1m = true;
    return entry;
  });
  if (options.prefer1m && entries[0]?.supports1m === true) entries[0].prefer1m = true;
  return { entries, rejected };
}

export type ClaudeDesktopJsonUpdate = { content: string; changed: boolean };

export const CLAUDE_DESKTOP_3P_MODE = "3p";
export const CLAUDE_DESKTOP_1P_MODE = "1p";

const CONFIG_FILE = "claude_desktop_config.json";
const CONFIG_LIBRARY = "configLibrary";
const META_FILE = "_meta.json";

function joinFor(platform: NodeJS.Platform): (...parts: string[]) => string {
  return platform === "win32" ? path.win32.join : path.posix.join;
}

function dedupe(values: string[]): string[] {
  return values.filter((value, index) => value && values.indexOf(value) === index);
}

/** The first value that is actually set — a blank string means "not set", not "empty path". */
function firstSet(...values: (string | undefined)[]): string {
  for (const value of values) {
    if (value !== undefined && value.trim() !== "") return value;
  }
  return "";
}

/**
 * Resolves one directory variable. An explicit option wins — including a blank
 * one, which means "this variable is unset on this machine" and must not quietly
 * fall through to the real environment, so callers (and tests) stay hermetic.
 */
function resolveDir(option: string | undefined, env: string | undefined, fallback: string): string {
  return option === undefined ? firstSet(env, fallback) : firstSet(option, fallback);
}

/**
 * Every directory that could hold a Claude Desktop installation, most likely
 * first. The app moved from Roaming to Local on Windows, so both are probed.
 */
export function getClaudeDesktopRootCandidates(
  platform: NodeJS.Platform,
  options: ClaudeDesktopPathOptions = {}
): string[] {
  const join = joinFor(platform);
  const home = firstSet(options.homedir, os.homedir());
  if (platform === "win32") {
    const local = resolveDir(options.localAppData, process.env.LOCALAPPDATA, join(home, "AppData", "Local"));
    const roaming = resolveDir(options.appData, process.env.APPDATA, join(home, "AppData", "Roaming"));
    return dedupe([join(local, "Claude"), join(roaming, "Claude")]);
  }
  if (platform === "darwin") {
    return [join(home, "Library", "Application Support", "Claude")];
  }
  const xdg = resolveDir(options.xdgConfigHome, process.env.XDG_CONFIG_HOME, "");
  return dedupe([...(xdg ? [join(xdg, "Claude")] : []), join(home, ".config", "Claude")]);
}

/** Resolves the file layout for one deployment mode. Pass the target mode when writing. */
export function resolveClaudeDesktopLayout(
  root: string,
  deploymentMode: string,
  platform: NodeJS.Platform
): ClaudeDesktopLayout {
  const join = joinFor(platform);
  const mode = deploymentMode.trim();
  const profileDir = mode && mode !== CLAUDE_DESKTOP_1P_MODE ? `${root}-${mode}` : root;
  return {
    root,
    profileDir,
    bootstrapFile: join(root, CONFIG_FILE),
    profileConfigFile: join(profileDir, CONFIG_FILE),
    configLibraryDir: join(profileDir, CONFIG_LIBRARY),
    metaFile: join(profileDir, CONFIG_LIBRARY, META_FILE)
  };
}

export function getClaudeDesktopEntryFile(
  layout: ClaudeDesktopLayout,
  entryId: string,
  platform: NodeJS.Platform
): string {
  return joinFor(platform)(layout.configLibraryDir, `${entryId}.json`);
}

/**
 * Which profile directories a config write has to reach. Builds disagree on
 * whether the library is read from the plain or the `-3p` directory, and the
 * files are a few hundred bytes, so both are kept in sync.
 */
export function getClaudeDesktopWriteLayouts(
  root: string,
  platform: NodeJS.Platform
): ClaudeDesktopLayout[] {
  return [
    resolveClaudeDesktopLayout(root, CLAUDE_DESKTOP_1P_MODE, platform),
    resolveClaudeDesktopLayout(root, CLAUDE_DESKTOP_3P_MODE, platform)
  ];
}

/** A stable, filename-safe entry id derived from the extension's provider id. */
export function toClaudeDesktopEntryId(providerId: string): string {
  const hex = createHash("sha1").update(`ai-provider-switcher:${providerId}`).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32)
  ].join("-");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A missing file is an empty document, but a malformed one is an error: silently
 * replacing it would drop configuration the user set up in the app itself.
 */
function parseDocument(content: string | undefined, label: string): Record<string, unknown> {
  if (content === undefined || content.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`${label} 不是有效的 JSON，无法安全写入。`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${label} 的根节点不是对象，无法安全写入。`);
  }
  return parsed;
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function readClaudeDesktopDeploymentMode(content: string | undefined): string {
  const mode = parseDocument(content, CONFIG_FILE).deploymentMode;
  return typeof mode === "string" ? mode.trim() : "";
}

/** Sets `deploymentMode`, preserving preferences, MCP servers and every other key. */
export function setClaudeDesktopDeploymentMode(
  content: string | undefined,
  mode: string
): ClaudeDesktopJsonUpdate {
  const document = parseDocument(content, CONFIG_FILE);
  if (document.deploymentMode === mode) return { content: serialize(document), changed: false };
  document.deploymentMode = mode;
  return { content: serialize(document), changed: true };
}

export function parseClaudeDesktopMeta(content: string | undefined): ClaudeDesktopMeta {
  const document = parseDocument(content, META_FILE);
  const rawEntries = Array.isArray(document.entries) ? document.entries : [];
  return {
    appliedId: typeof document.appliedId === "string" ? document.appliedId.trim() : "",
    entries: rawEntries
      .filter(isRecord)
      .map((entry) => ({ id: String(entry.id ?? "").trim(), name: String(entry.name ?? "").trim() }))
      .filter((entry) => entry.id.length > 0)
  };
}

/** Upserts an entry and makes it the applied one. */
export function applyClaudeDesktopEntry(
  meta: ClaudeDesktopMeta,
  entry: ClaudeDesktopEntry
): ClaudeDesktopMeta {
  return {
    appliedId: entry.id,
    entries: [...meta.entries.filter((item) => item.id !== entry.id), entry]
  };
}

/** Drops an entry, clearing the applied pointer when it was the live one. */
export function removeClaudeDesktopEntry(meta: ClaudeDesktopMeta, entryId: string): ClaudeDesktopMeta {
  return {
    appliedId: meta.appliedId === entryId ? "" : meta.appliedId,
    entries: meta.entries.filter((item) => item.id !== entryId)
  };
}

export function serializeClaudeDesktopMeta(meta: ClaudeDesktopMeta): string {
  return serialize({ appliedId: meta.appliedId, entries: meta.entries });
}

/**
 * Builds a gateway config entry. Unknown keys in `existing` are preserved so a
 * config the user tuned in the app survives a switch; when creating a fresh
 * entry, `inherited` donates the egress allowlist rather than inventing a
 * network policy of our own.
 */
export function buildClaudeDesktopGatewayConfig(
  existing: string | undefined,
  gateway: ClaudeDesktopGatewaySettings,
  inherited?: string
): string {
  const document = parseDocument(existing, "Claude Desktop 3P 配置");
  if (existing === undefined && inherited !== undefined) {
    const donor = parseDocument(inherited, "Claude Desktop 3P 配置");
    if (donor.coworkEgressAllowedHosts !== undefined) {
      document.coworkEgressAllowedHosts = donor.coworkEgressAllowedHosts;
    }
  }
  document.inferenceProvider = "gateway";
  document.inferenceGatewayBaseUrl = gateway.baseUrl;
  document.inferenceGatewayApiKey = gateway.apiKey;
  document.inferenceGatewayAuthScheme = "bearer";
  document.disableDeploymentModeChooser = true;
  // Most relays do not serve /v1/models, and the app's discovery then leaves the
  // picker empty ("model list hasn't loaded"). An explicit list skips discovery.
  if (gateway.models && gateway.models.length > 0) {
    document.inferenceModels = gateway.models;
  } else {
    delete document.inferenceModels;
  }
  return serialize(document);
}

/** The gateway URL a stored 3P entry points at, or "" when it is not a gateway config. */
export function readClaudeDesktopGatewayBaseUrl(content: string | undefined): string {
  const document = parseDocument(content, "Claude Desktop 3P 配置");
  if (document.inferenceProvider !== "gateway") return "";
  const baseUrl = document.inferenceGatewayBaseUrl;
  return typeof baseUrl === "string" ? baseUrl.trim() : "";
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export async function readOptionalFile(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * The first candidate root that actually exists, together with the deployment
 * mode the app persisted. A root counts as installed when either the plain or
 * the `-3p` directory is present.
 */
export async function findClaudeDesktopInstall(
  candidates: string[],
  platform: NodeJS.Platform
): Promise<ClaudeDesktopInstall | undefined> {
  const join = joinFor(platform);
  for (const root of candidates) {
    const profileDirs: string[] = [];
    for (const dir of [root, `${root}-${CLAUDE_DESKTOP_3P_MODE}`]) {
      if (await isDirectory(dir)) profileDirs.push(dir);
    }
    if (profileDirs.length === 0) continue;
    // The mode is mirrored into both documents; the bootstrap one wins.
    const deploymentMode =
      readClaudeDesktopDeploymentMode(await readOptionalFile(join(root, CONFIG_FILE))) ||
      readClaudeDesktopDeploymentMode(
        await readOptionalFile(join(`${root}-${CLAUDE_DESKTOP_3P_MODE}`, CONFIG_FILE))
      );
    return { root, deploymentMode, profileDirs };
  }
  return undefined;
}

/**
 * Reads which gateway Claude Desktop is actually pointed at, rather than trusting
 * a value this extension recorded — the app and other tools write these files too.
 */
export async function readClaudeDesktopGateway(
  install: ClaudeDesktopInstall,
  platform: NodeJS.Platform
): Promise<{ baseUrl: string; entryId: string; entryName: string } | undefined> {
  if (install.deploymentMode !== CLAUDE_DESKTOP_3P_MODE) return undefined;
  for (const layout of getClaudeDesktopWriteLayouts(install.root, platform).reverse()) {
    const meta = parseClaudeDesktopMeta(await readOptionalFile(layout.metaFile));
    if (!meta.appliedId) continue;
    const entryFile = getClaudeDesktopEntryFile(layout, meta.appliedId, platform);
    const baseUrl = readClaudeDesktopGatewayBaseUrl(await readOptionalFile(entryFile));
    if (!baseUrl) continue;
    return {
      baseUrl,
      entryId: meta.appliedId,
      entryName: meta.entries.find((entry) => entry.id === meta.appliedId)?.name ?? ""
    };
  }
  return undefined;
}
