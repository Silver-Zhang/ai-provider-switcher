/**
 * Remote / WSL awareness.
 *
 * VS Code can run an extension host on a machine that is not the one drawing the
 * window: Remote-SSH, WSL, dev containers and Codespaces all put the filesystem
 * this extension writes to (`~/.claude`, `~/.codex`) — and the environment it
 * reads proxies from — on the remote side, while the GUI apps (Claude Desktop)
 * stay local. That split is right for the CLIs and wrong for the desktop app, so
 * these helpers name it explicitly and let the UI say it out loud instead of
 * failing with a confusing "not found" or writing an address that resolves to the
 * wrong machine.
 *
 * Everything here is pure so it can be tested without a VS Code host.
 */

export type RemoteKind = "local" | "wsl" | "ssh" | "container" | "codespaces" | "tunnel" | "other";

export interface RemoteEnvironment {
  kind: RemoteKind;
  /** Raw `vscode.env.remoteName`, kept verbatim for diagnostics. */
  remoteName: string;
  /** Human name for the machine the extension host runs on. */
  label: string;
  /** False only for `local`; the shorthand every caller ends up wanting. */
  isRemote: boolean;
}

const REMOTE_LABELS: Record<RemoteKind, string> = {
  local: "本机",
  wsl: "WSL 子系统",
  ssh: "远程 SSH 主机",
  container: "开发容器",
  codespaces: "GitHub Codespaces",
  tunnel: "远程隧道主机",
  other: "远程环境"
};

/** The extension id, needed verbatim in the `remote.extensionKind` advice. */
export const EXTENSION_ID = "silver-zhang.ai-provider-switcher";

/**
 * Maps `vscode.env.remoteName` onto a kind. The value is an authority prefix
 * (`ssh-remote`, `wsl`, `dev-container`, `attached-container`, `codespaces`,
 * `tunnel`), and new ones keep appearing, so anything unrecognised is still
 * treated as remote rather than as local.
 */
export function classifyRemoteName(remoteName: string | undefined): RemoteKind {
  const name = (remoteName ?? "").trim().toLowerCase();
  if (!name) return "local";
  if (name.startsWith("wsl")) return "wsl";
  if (name.startsWith("ssh")) return "ssh";
  if (name.includes("codespaces")) return "codespaces";
  if (name.includes("container")) return "container";
  if (name.includes("tunnel")) return "tunnel";
  return "other";
}

export function describeRemoteEnvironment(remoteName: string | undefined): RemoteEnvironment {
  const kind = classifyRemoteName(remoteName);
  return {
    kind,
    remoteName: (remoteName ?? "").trim(),
    label: REMOTE_LABELS[kind],
    isRemote: kind !== "local"
  };
}

const LOOPBACK_HOSTS = new Set(["localhost", "0.0.0.0", "::", "::1", "[::]", "[::1]"]);

/**
 * Whether a proxy address only resolves on the machine it was read from.
 * `127.0.0.1` means "whoever is asking", so the same string means two different
 * machines on the two sides of a remote connection.
 */
export function isLoopbackProxyUrl(url: string): boolean {
  const text = url.trim();
  if (!text) return false;
  let hostname: string;
  try {
    hostname = new URL(text.includes("://") ? text : `http://${text}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (LOOPBACK_HOSTS.has(hostname)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * The warning for writing a loopback proxy into a remote `~/.codex/.env`.
 * `http.proxy` travels with Settings Sync and the detected value may have come
 * from the local machine, so the address can be right locally and dead remotely.
 * Returns `undefined` when there is nothing to warn about.
 */
export function describeRemoteProxyRisk(kind: RemoteKind, proxyUrl: string): string | undefined {
  if (kind === "local" || !isLoopbackProxyUrl(proxyUrl)) return undefined;
  const label = REMOTE_LABELS[kind];
  if (kind === "wsl") {
    return `${proxyUrl} 是回环地址，而 Codex 运行在 ${label} 内。除非 WSL 开启了镜像网络（.wslconfig 里 networkingMode=mirrored），子系统里的 127.0.0.1 并不是 Windows 主机。若代理开在 Windows 上，请改填 Windows 主机地址：镜像网络下可用 127.0.0.1，否则用 /etc/resolv.conf 中 nameserver 的那个 IP，或 $(hostname).local。`;
  }
  return `${proxyUrl} 是回环地址，而插件运行在${label}上，配置会写进${label}的 ~/.codex/.env。那里的 127.0.0.1 指的是${label}自己，不是你面前这台电脑。请确认代理确实开在${label}上，否则请填该主机能访问到的地址。`;
}

/**
 * Why Claude Desktop cannot be managed from a remote extension host. Desktop is
 * a local GUI application: its data directory lives on the machine you look at,
 * which a remote host has no path to.
 */
export function describeRemoteDesktopLimit(kind: RemoteKind): string | undefined {
  if (kind === "local") return undefined;
  const label = REMOTE_LABELS[kind];
  return `插件当前运行在${label}上，只能读写该主机的文件；Claude Desktop 是本地桌面应用，配置目录在你面前这台电脑上。请在本地窗口（非远程窗口）中管理 Desktop，或把设置 remote.extensionKind 中的 ${EXTENSION_ID} 指定为 "ui" 让插件改在本地运行（终端 CLI 配置会随之写到本地）。`;
}

/** One line for the panel: which machine the CLI configuration is being written to. */
export function describeRemoteConfigScope(kind: RemoteKind): string | undefined {
  if (kind === "local") return undefined;
  return `配置写入${REMOTE_LABELS[kind]}的 ~/.claude 与 ~/.codex；Claude Desktop 需在本地窗口管理。`;
}

/**
 * The `remote.extensionKind` value that pins this extension to one side, ready to
 * be written into settings.
 */
export function buildExtensionKindOverride(kind: "ui" | "workspace"): Record<string, string[]> {
  return { [EXTENSION_ID]: [kind] };
}
