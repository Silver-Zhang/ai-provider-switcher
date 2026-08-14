import { normalizeClaudeProviderBaseUrl } from "./claudeConfig";
import { normalizeProviderRootUrl } from "./codexConfig";

export type ProviderEditKind = "claude" | "codex";

export type ProviderEditDraft = {
  name: string;
  baseUrl: string;
  /** Empty or absent means "keep the stored credential"; secrets are never echoed back into the form. */
  secret?: string;
};

export type ProviderEditTarget = { id: string; name: string; baseUrl: string };

export type ProviderEditEffects = {
  nameChanged: boolean;
  baseUrlChanged: boolean;
  secretChanged: boolean;
  /** Models discovered from the old origin say nothing about the new one. */
  clearModelCache: boolean;
  /** The live routing files still carry the old URL or credential. */
  rewriteLiveConfig: boolean;
  /** config.toml holds a managed block per Codex provider, active or not, so any of them can go stale. */
  rewriteManagedBlock: boolean;
  unchanged: boolean;
};

export type ProviderEditPlan =
  | { ok: false; message: string }
  | { ok: true; name: string; baseUrl: string; secret?: string; effects: ProviderEditEffects };

export function normalizeProviderBaseUrl(kind: ProviderEditKind, baseUrl: string): string {
  return kind === "claude" ? normalizeClaudeProviderBaseUrl(baseUrl) : normalizeProviderRootUrl(baseUrl);
}

/**
 * Validates an edit and reports which side effects it forces. The provider ID is deliberately
 * absent from the draft: it keys Secret Storage, the model cache, the Codex API key file, and
 * Codex's own session history, so renaming a provider must never renumber it.
 */
export function planProviderEdit(
  kind: ProviderEditKind,
  current: ProviderEditTarget,
  draft: ProviderEditDraft,
  siblings: ProviderEditTarget[],
  isActive: boolean
): ProviderEditPlan {
  const name = draft.name.trim();
  if (!name) return { ok: false, message: "名称不能为空。" };
  const duplicate = siblings.find(
    (item) => item.id !== current.id && item.name.trim().toLowerCase() === name.toLowerCase()
  );
  if (duplicate) return { ok: false, message: `已存在同名服务“${duplicate.name}”，请换一个名称。` };

  const enteredUrl = draft.baseUrl.trim();
  if (!enteredUrl) return { ok: false, message: "Base URL 不能为空。" };
  if (!/^https?:\/\//i.test(enteredUrl)) {
    return { ok: false, message: "Base URL 必须以 http:// 或 https:// 开头。" };
  }
  const baseUrl = normalizeProviderBaseUrl(kind, enteredUrl);
  if (!baseUrl) return { ok: false, message: "Base URL 无效。" };

  const secret = draft.secret?.trim() || undefined;
  const nameChanged = name !== current.name;
  // Compare normalized forms so a trailing slash or a stray /v1 is not treated as a change.
  const baseUrlChanged = baseUrl !== normalizeProviderBaseUrl(kind, current.baseUrl);
  const secretChanged = secret !== undefined;

  return {
    ok: true,
    name,
    baseUrl,
    secret,
    effects: {
      nameChanged,
      baseUrlChanged,
      secretChanged,
      clearModelCache: baseUrlChanged,
      rewriteLiveConfig: isActive && (baseUrlChanged || secretChanged),
      rewriteManagedBlock: kind === "codex" && (nameChanged || baseUrlChanged),
      unchanged: !nameChanged && !baseUrlChanged && !secretChanged
    }
  };
}

/**
 * Rebuilds a provider list in the order the manager dragged them into.
 *
 * The order arrives from a webview that may have been rendered before the list last changed, so it
 * is treated as a preference rather than a replacement: unknown IDs are ignored and any provider the
 * order does not mention keeps its relative position at the end. Reordering must never be able to
 * drop a provider — that would strand its credential and, for Codex, its session history.
 */
export function applyProviderOrder<T extends { id: string }>(items: T[], order: string[]): T[] {
  const remaining = new Map(items.map((item) => [item.id, item]));
  const ordered: T[] = [];
  for (const id of order) {
    const item = remaining.get(id);
    if (!item) continue;
    remaining.delete(id);
    ordered.push(item);
  }
  return [...ordered, ...items.filter((item) => remaining.has(item.id))];
}

/** Success text that names the follow-up work the edit created, so nothing silently goes stale. */
export function describeProviderEditOutcome(name: string, effects: ProviderEditEffects): string {
  const notes: string[] = [];
  if (effects.clearModelCache) notes.push("Base URL 已变更，模型缓存已清空，请重新刷新模型");
  if (effects.secretChanged) notes.push("密钥已更新");
  if (effects.rewriteLiveConfig) notes.push("已同步到当前生效的配置");
  return notes.length ? `已保存“${name}”：${notes.join("；")}。` : `已保存“${name}”。`;
}
