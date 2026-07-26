export const CODEX_MANAGED_BEGIN = "# BEGIN AI Provider Switcher managed Codex provider";
export const CODEX_MANAGED_END = "# END AI Provider Switcher managed Codex provider";

/** Store and display the provider origin, not a protocol-specific API path. */
export function normalizeProviderRootUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/v1\/?$/i, "").replace(/\/$/, "");
}

/** Codex custom providers use the OpenAI Responses API under /v1. */
export function getCodexApiBaseUrl(baseUrl: string): string {
  return `${normalizeProviderRootUrl(baseUrl)}/v1`;
}

export function parseTopLevelTomlString(content: string, key: string): string | undefined {
  const firstTable = content.search(/^\s*\[/m);
  const topLevel = firstTable >= 0 ? content.slice(0, firstTable) : content;
  const match = topLevel.match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*("(?:\\\\.|[^"])*")\\s*$`, "m"));
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]) as string;
  } catch {
    return undefined;
  }
}

export function updateTopLevelTomlKey(
  content: string,
  key: string,
  value: string | undefined
): string {
  const lines = content.split(/\r?\n/);
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const end = firstTable >= 0 ? firstTable : lines.length;
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const index = lines.slice(0, end).findIndex((line) => pattern.test(line));

  if (index >= 0) {
    if (value === undefined) {
      lines.splice(index, 1);
    } else {
      lines[index] = `${key} = ${JSON.stringify(value)}`;
    }
  } else if (value !== undefined) {
    lines.splice(end, 0, `${key} = ${JSON.stringify(value)}`);
  }
  return lines.join("\n");
}

export function removeManagedCodexProviders(content: string): string {
  const block = new RegExp(
    `\\r?\\n?${escapeRegExp(CODEX_MANAGED_BEGIN)}[\\s\\S]*?${escapeRegExp(CODEX_MANAGED_END)}\\r?\\n?`,
    "g"
  );
  return content.replace(block, "").trimEnd();
}

/** Build a Codex model catalog so custom-provider models appear in Codex's own picker. */
export function createCodexModelCatalog(modelIds: string[]): { models: Array<Record<string, unknown>> } {
  return {
    models: [...new Set(modelIds.map((model) => model.trim()).filter(Boolean))].map((model, index) => ({
      slug: model,
      display_name: model,
      description: `Available from the active custom provider`,
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "low", description: "Low" },
        { effort: "medium", description: "Medium" },
        { effort: "high", description: "High" },
        { effort: "xhigh", description: "Extra high" }
      ],
      shell_type: "shell_command",
      visibility: "list",
      supported_in_api: true,
      priority: modelPriority(model, index),
      additional_speed_tiers: [],
      service_tiers: [],
      default_service_tier: null,
      availability_nux: null,
      upgrade: null,
      base_instructions: "You are Codex, a coding agent. Collaborate with the user in their workspace.",
      model_messages: null,
      include_skills_usage_instructions: false,
      supports_reasoning_summary_parameter: true,
      default_reasoning_summary: "auto",
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: null,
      web_search_tool_type: "text",
      truncation_policy: { mode: "bytes", limit: 10000 },
      supports_parallel_tool_calls: true,
      supports_image_detail_original: false,
      context_window: null,
      max_context_window: null,
      auto_compact_token_limit: null,
      comp_hash: null,
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      input_modalities: ["text", "image"],
      supports_search_tool: false,
      use_responses_lite: false,
      auto_review_model_override: null,
      tool_mode: null,
      multi_agent_version: null
    }))
  };
}

function modelPriority(model: string, index: number): number {
  const preferredOrder = ["sol", "luna", "terra"];
  const preferredIndex = preferredOrder.findIndex((name) => model.toLowerCase().includes(name));
  return preferredIndex >= 0 ? 1000 - preferredIndex : 500 - index;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}