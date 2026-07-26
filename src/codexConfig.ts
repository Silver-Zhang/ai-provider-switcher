export const CODEX_MANAGED_BEGIN = "# BEGIN AI Provider Switcher managed Codex provider";
export const CODEX_MANAGED_END = "# END AI Provider Switcher managed Codex provider";

export function normalizeCodexBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/$/, "");
  return /\/v1$/i.test(normalized) ? normalized : `${normalized}/v1`;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}