/**
 * Stable loopback port selection.
 *
 * 127.0.0.1 belongs to the network namespace, not an individual Unix user. On
 * a shared Linux host two users cannot both bind the familiar 4180/4181 pair.
 * Linux therefore gets a deterministic UID-derived pair unless the user or an
 * administrator explicitly configures a port. Fixed values are essential: the
 * client persists the loopback address and cannot discover a random replacement
 * after VS Code reloads.
 */
export type LocalPortKind = "claudeProxy" | "protocolAdapter";
export type LocalPortSource = "manual" | "default" | "linux-user";
export type LocalPortChoice = { port: number; source: LocalPortSource };

export const DEFAULT_CLAUDE_PROXY_PORT = 4180;
export const DEFAULT_PROTOCOL_ADAPTER_PORT = 4181;
const LINUX_USER_PORT_START = 24000;
const LINUX_USER_PORT_SPAN = 8000;

export function isValidLocalPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535;
}

/** Pure so each platform/UID policy can be tested without changing process state. */
export function resolveLocalPort(options: {
  kind: LocalPortKind;
  configured?: unknown;
  configuredExplicitly?: boolean;
  platform: NodeJS.Platform;
  uid?: number;
}): LocalPortChoice {
  const fallback = options.kind === "claudeProxy" ? DEFAULT_CLAUDE_PROXY_PORT : DEFAULT_PROTOCOL_ADAPTER_PORT;
  if (options.configuredExplicitly && isValidLocalPort(options.configured)) {
    return { port: options.configured, source: "manual" };
  }
  if (options.platform !== "linux" || !Number.isInteger(options.uid) || (options.uid ?? -1) < 0) {
    return { port: fallback, source: "default" };
  }
  // The multiplication makes every ordinary adjacent UID map to adjacent,
  // non-overlapping even/odd pairs. The modulo bounds the result below 32000.
  const base = LINUX_USER_PORT_START + (((options.uid as number) * 2) % LINUX_USER_PORT_SPAN);
  return {
    port: options.kind === "claudeProxy" ? base : base + 1,
    source: "linux-user"
  };
}
