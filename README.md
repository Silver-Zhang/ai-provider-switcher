# AI Provider Switcher

<p align="center">
  <img src="images/icon.png" alt="AI Provider Switcher" width="128">
</p>

<p align="center">
  在一个 VS Code 面板中管理 Claude Code 与 Codex 的官方服务、自定义 Provider、模型和连接代理。<br>
  Manage official services, custom providers, models, and connection proxies for Claude Code and Codex from one VS Code panel.
</p>

<p align="center">
  <a href="#中文">中文</a> · <a href="#english">English</a>
</p>

> [!IMPORTANT]
> AI Provider Switcher 是独立的社区扩展，与 Anthropic、OpenAI、Claude、Codex、GitHub 或任何第三方 Provider 均无隶属或背书关系。
>
> AI Provider Switcher is an independent community extension. It is not affiliated with or endorsed by Anthropic, OpenAI, Claude, Codex, GitHub, or any third-party provider.

---

# 中文

## 为什么使用 AI Provider Switcher？

Claude Code 和 Codex 的 Provider 配置分散在 VS Code 设置、环境变量和用户目录文件中。手工切换容易遗漏旧变量、泄露密钥、使用错误模型，或者在代理环境中反复遇到 Codex `Reconnecting`。

AI Provider Switcher 将这些工作集中到一个可视化入口：

- 在官方服务和多个自定义 Provider 之间快速切换。
- 保存命名 Provider，避免反复修改配置文件。
- 为非 Claude 模型建立完整 Claude 模型族映射。
- 同步 Codex 自定义 Provider 模型到 Codex 原生模型栏。
- 统一 Codex 会话历史：官方订阅以共享的 custom 供应商标识运行，官方与第三方会话出现在同一历史列表（可选迁入现有会话，自动备份、可还原）。
- 检测会覆盖当前设置的 Claude 外部配置。
- 切换中转站时同步终端 Claude CLI（`~/.claude/settings.json` 的 env），与 VS Code 内 Claude Code 保持一致。
- 独立管理 Claude Desktop（自动探测数据目录，也可手动指定），切换后需完全退出并重启桌面应用。
- 管理 Codex WebSocket/HTTPS 代理，处理反复重连问题。
- 切换后保留本地会话历史，不删除已有对话。

## 功能亮点

### 统一管理

- Claude 与 Codex 共用一个可视化管理面板。
- 状态栏实时显示两个客户端当前使用的 Provider。
- 支持命令面板和快速选择器。
- 每个 Provider 独立保存名称、地址、模型缓存及适用策略。

### Claude Code

- 在 Claude 官方订阅与多个 Anthropic API 兼容 Provider 之间切换。
- Token 通过密码输入框录入并缓存到 VS Code Secret Storage。
- 从 `/v1/models` 发现并缓存 Provider 模型。
- 为 DeepSeek、Kimi、GLM 等非 Claude 模型 ID 配置主模型、Fable、Opus、Sonnet、Haiku、后台任务和子代理。
- 支持推理强度及用户明确确认后的 1M 上下文标记。
- DeepSeek 官方根地址自动规范化到 Anthropic 兼容端点，并提供推荐映射。
- 每个 Provider 可分别配置命令策略：
  - **Auto**：保留 Claude Code 的独立命令分类流程。
  - **编辑自动接受**：编辑与常见文件命令自动执行，其他操作询问。
  - **手动确认**：非只读操作均询问。
  - **完全放行**：启用 `bypassPermissions`；仅适合可丢弃、无敏感凭据的隔离环境。
- 切换前扫描进程环境、Claude 用户设置和项目设置中的路由、认证、模型及权限冲突。
- 支持先创建时间戳备份，再只移除冲突字段；权限和无关设置会被保留。

### Codex

- 在 OpenAI 官方 Provider 与多个 OpenAI Responses API 兼容 Provider 之间切换。
- 自动请求 `/v1/models` 并生成 Codex 本地模型目录。
- 模型同步完成后，直接在 Codex 页面原生模型栏选择模型。
- 恢复官方服务时，只移除本扩展管理的 Provider 块，并恢复首次接管前记录的顶层选择。
- API Key 不会以明文写入 `config.toml`。
- 支持 Codex WebSocket/HTTPS 连接代理：
  - 自动检测代理环境变量及 VS Code `http.proxy`。
  - 检测 Windows、macOS 和 GNOME Linux 系统代理。
  - 自动使用当前设备实际端口，不写死端口。
  - 支持手动输入 HTTP(S) 代理。
  - 可选择**仅官方 OpenAI 服务**或**所有 Provider**生效。
  - 写入前检查 `~/.codex/.env` 中已有代理变量。
  - 停用时只删除扩展管理的配置块，不破坏其他环境变量。

### 用量与额度 MVP

- 在管理面板中显示自定义 Provider 的额度摘要。
- 刷新模型时自动缓存 `x-ratelimit-*` 响应头，不额外发送收费推理请求。
- 刷新模型会依次尝试 `<Base URL>/v1/models`、`/models`；当 Base URL 带路径（如 `https://api.deepseek.com/anthropic`）时，还会回退到同域根路径。只有 404 才继续尝试下一个地址，其余错误直接显示网关返回的原文，便于区分「密钥无效」「额度用尽」和「没有该接口」。
- 可配置返回 JSON 的只读 GET 额度 API，并复用该 Provider 已保存的凭据。
- 自动识别常见 `balance`、`five_hour` 和 `weekly` 字段，也可填写 JSON 字段路径。
- 支持余额、5 小时窗口、周窗口、请求额度、Token 额度及重置时间。
- 当前只面向自定义 Provider；官方 Claude/Codex 订阅额度没有稳定的第三方公开接口。

使用方式：运行 **AI Provider Switcher: Configure Provider Usage API** 配置接口，然后运行 **AI Provider Switcher: Refresh Provider Usage** 测试和刷新。优先使用 HTTPS 及只读凭据；如果额度 API 与 Provider 不同域，扩展会在发送已保存凭据前要求明确确认。如果服务商未提供额度 API，扩展只能显示模型接口返回的限流响应头。

> [!WARNING]
> Codex 自定义 Provider 现在支持 Windows、macOS 和 Linux。Windows 使用 PowerShell + 当前用户 DPAPI；macOS/Linux 使用权限为 `0600` 的本地 Key 文件，并通过权限为 `0700` 的 shell helper 读取。WSL/Remote 扩展宿主应在实际运行 Codex 的同一环境中安装和运行扩展，详见[远程开发（Remote-SSH / WSL / 容器）](#远程开发remote-ssh--wsl--容器)。

## 系统要求与兼容性

| 能力 | Windows | macOS | Linux |
|---|---:|---:|---:|
| Claude 官方/自定义 Provider 管理 | ✅ | ✅ | ✅ |
| Claude 模型映射和配置检查 | ✅ | ✅ | ✅ |
| Claude CLI（终端）同步 | ✅ | ✅ | ✅ |
| Claude Desktop 独立管理 | ✅ | ⚠️ | ⚠️ |
| Codex 官方服务 | ✅ | ✅ | ✅ |
| Codex WebSocket 代理 | ✅ | ✅ | ⚠️ |
| Codex 自定义 Provider | ✅ | ✅ | ✅ |
| 统一 Codex 会话历史 | ✅ | ✅ | ✅ |

> ⚠️ Claude Desktop 三个平台都有官方版本（Linux 版见 <https://code.claude.com/docs/en/desktop-linux>），但目录布局在各平台的构建之间存在差异，目前只在 Windows 上实测通过。自动探测的路径为：Windows `%LOCALAPPDATA%\Claude` 与 `%APPDATA%\Claude`，macOS `~/Library/Application Support/Claude`，Linux `$XDG_CONFIG_HOME/Claude` 与 `~/.config/Claude`。若自动探测失败，可用 `aiProviderSwitcher.claudeDesktopConfigRoot` 手动指定目录。
>
> ⚠️ Codex 代理的**自动探测**在 Linux 上支持 GNOME（`gsettings org.gnome.system.proxy`）与 KDE（`~/.config/kioslaverc`）；Xfce 或无桌面环境下探测返回空，不会报错。macOS 上如果系统代理是 PAC/WPAD 自动配置脚本，探测会明确告诉你脚本地址——Codex 无法执行 PAC，需要你从代理软件里读出实际端口再手动填写。任何平台下都可以先导出 `HTTPS_PROXY` 环境变量，或直接手动填写代理地址——手动填写在所有平台上效果完全相同。

### 远程开发（Remote-SSH / WSL / 容器）

扩展声明为 `"extensionKind": ["workspace", "ui"]`，即在远程窗口中**默认运行在远程侧**。这是终端 CLI 场景下正确的选择：Claude Code 与 Codex 跑在远程主机上，`~/.claude`、`~/.codex` 也在远程主机上，配置必须写到那里。

由此带来三点需要注意，扩展会在界面上主动提示：

- **管理面板顶部会显示当前写入的是哪台机器**，例如“配置写入 WSL 子系统的 `~/.claude` 与 `~/.codex`”。
- **Claude Desktop 无法从远程侧管理**。它是本地桌面应用，配置目录在你面前这台电脑上，远程主机没有该路径。在远程窗口中尝试切换 Desktop 时，扩展会说明原因并提供直达 `remote.extensionKind` 设置的入口。
- **代理地址中的 `127.0.0.1` 在两侧指的是不同机器**。远程窗口下若探测到或填入回环地址，扩展会先弹窗确认再写入远程的 `~/.codex/.env`。WSL 场景还会额外提示：除非 `.wslconfig` 开启了 `networkingMode=mirrored`，子系统里的 `127.0.0.1` 并不是 Windows 主机，应改用 `/etc/resolv.conf` 中 `nameserver` 的地址或 `$(hostname).local`。

如果你主要用这个扩展管理**本地** Claude Desktop，而不是远程的 CLI，可以在设置中把扩展固定到本地侧：

```jsonc
// settings.json
"remote.extensionKind": {
  "silver-zhang.ai-provider-switcher": ["ui"]
}
```

改完需要重新加载窗口。固定为 `ui` 后，扩展写入的 `~/.claude`、`~/.codex` 也会变成本地路径。

其他要求：

- VS Code `1.90.0` 或更高版本。
- 使用 Claude 功能时，应安装并启用 Claude Code VS Code 扩展。
- 使用 Codex 功能时，应安装并启用官方 OpenAI Codex IDE 扩展。
- 自定义 Claude Provider 必须提供兼容的 Anthropic API。
- 自定义 Codex Provider 必须支持 OpenAI Responses API；只有 Chat Completions API 的服务无法使用。

## 安装

### 从 VSIX 安装

1. 下载发布页面中的 `.vsix` 文件。
2. 在 VS Code 中打开“扩展”视图。
3. 点击右上角 `…`，选择“从 VSIX 安装…”。
4. 安装后运行 **Developer: Reload Window**。

### 从源码运行

1. 安装 Node.js LTS。
2. 克隆仓库并在项目目录执行 `npm install`。
3. 执行 `npm test`，确认编译和测试通过。
4. 按 `F5` 启动 Extension Development Host。

Windows PowerShell 如果阻止 `npm.ps1`，可改用 `npm.cmd install` 和 `npm.cmd test`。

## 快速开始

安装并重载后，可使用任一入口打开管理器：

- 点击状态栏中的 `Claude: ... · Codex: ...`。
- 按 `Ctrl+Shift+P`，运行 **AI Provider Switcher: Open Provider Manager**。
- 运行 **AI Provider Switcher: Quick Switch Provider** 进行快速切换。

## Claude 使用指南

### 配置 Claude Code（VS Code / 终端）

这条流程只影响 VS Code 内的 Claude Code 和终端 `claude`，**不会改变 Claude Desktop**：

1. 打开管理器；在总览中选择 **Claude Code（VS Code / 终端）→ 切换 Claude Code 服务**。
2. 没有服务时，点左侧 Claude 区的 **＋** 添加中转站；填写名称、服务根地址与 Token。通常不要在 URL 末尾填写 `/v1`。
3. 在该服务详情的 **Claude Code（VS Code / 终端）** 区，点 **配置 Claude Code 模型**。
4. 点 **从服务获取模型列表**；若服务提供非 Claude 模型 ID，可点 **自动分配角色**，再按需要调整主模型、快速模型和 1M。
5. 点 **保存 Claude Code 配置**。若该服务正在使用，扩展会写入 VS Code 与终端 CLI，并提示重新加载 VS Code；随后新建 Claude 会话。
6. 命令策略也只属于 Claude Code / CLI，在该服务详情的 **命令策略** 中配置。

### 配置 Claude Desktop（独立应用）

这条流程只影响 Claude Desktop，**不会改变 VS Code 内 Claude Code 或终端 CLI**：

1. 在总览选择 **Claude Desktop（独立应用）→ 切换 Claude Desktop 服务**，选择要使用的中转站。
2. 在该服务详情的 **Claude Desktop（独立应用）** 区，点 **配置 Desktop 模型**。
3. 在 **全模型目录** 点 **添加已缓存的全部模型**，或只勾选需要的真实模型。对于 GPT、Claude 混合中转站，这是推荐方式。
4. 点 **保存 Claude Desktop 模型**。只有 Desktop 正在使用此服务时会立即改写 Desktop 配置；否则会在下一次切换到该服务时带入。
5. 按平台提示**完全退出** Claude Desktop 再重新打开（关闭窗口通常不等于退出）。

> 「高级：旧版兼容别名」只给已存在的旧配置或服务商明确要求某个别名的情况使用；新用户不需要配置它。

### 恢复 Claude 官方订阅

1. 运行 **AI Provider Switcher: Use Claude Official Subscription**。
2. 检查并处理可能干扰官方登录的外部配置。
3. 重新加载 VS Code。
4. 如有需要，在 Claude Code 中重新完成官方登录。

切换到官方模式会清除扩展管理的 Claude Provider 环境变量，并将命令策略恢复为手动确认。

### 终端 Claude CLI 与 Claude Desktop

- **终端 CLI**：切换中转站/官方时，扩展会同步把 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` 等写入 `~/.claude/settings.json` 的 `env` 块（保留你的其他 env 与全部其余设置；改前自动备份）。CLI 与 VS Code 内的 Claude Code 共享同一份会话历史，`claude --resume` 两边一致。
- **Claude Desktop（独立）**：运行 **AI Provider Switcher: Switch Claude Desktop Service** 单独切换桌面应用，绝不改动 VS Code / CLI 配置。桌面应用不读取 `env`，它通过自己的「第三方推理」配置库路由：扩展会在数据目录下写入 `configLibrary/<id>.json`（网关地址与密钥）和 `configLibrary/_meta.json`（`appliedId` 指向当前生效的那一条），并把 `claude_desktop_config.json` 的 `deploymentMode` 切到 `3p`（切回官方则改为 `1p`）。原有的偏好设置、MCP 配置和未知字段都会保留，改动前自动备份。
  - 数据目录会自动探测（Windows `%LOCALAPPDATA%\Claude` 与 `%APPDATA%\Claude`、macOS `~/Library/Application Support/Claude`、Linux `$XDG_CONFIG_HOME/Claude` 或 `~/.config/Claude`）。装在别处时，用切换面板里的**更改 Claude Desktop 数据目录…**选择，或直接设置 `aiProviderSwitcher.claudeDesktopConfigRoot`；未检测到时会列出已尝试的路径。
  - 面板上显示的桌面状态直接读自磁盘，因此你在应用内或用其他工具改过的配置也会如实反映。
  - 切换时会把该中转站已缓存的模型写进配置条目的 `inferenceModels`，桌面应用便不再自行探测模型列表。多数中转站不提供该探测接口（返回 404），这正是模型选择器为空、发消息报 `Your organization's model list hasn't loaded yet` 的原因；先**刷新模型列表**再切换即可。你为该中转站配置的模型映射会一并带过去（写成每个条目的 `anthropicFamilyTier`），桌面选择器里的 `opus`／`sonnet`／`haiku` 因此能落到真实模型上。
  - ⚠️ **桌面应用只接受「读起来像 Anthropic 模型」的模型名**（含 `claude`/`opus`/`sonnet`/`haiku` 等），这是应用自身的限制：条目里只要有一个不合规的名字，整条配置都会被判为无效。因此 `deepseek-*`、`gpt-*`、`qwen-*` 这类**原名**无法直接写进桌面配置。
  - **高级兼容别名（仅旧配置或服务商明确要求时使用）**：这不是正常配置入口。全模型目录启用时，兼容别名完全不参与 Desktop 路由；新用户应直接使用全模型目录。只有服务商文档明确要求你把某个名称原样发送给它时，才在高级区填写。例如 `opus` / `sonnet` / `haiku` / `fable` 是没有世代编号的 Desktop 档位标识，分别代表最高能力、通用、快速/低成本、增强推理；它们**不是**任何具体 Claude 官方版本，也不保证每个中转站支持。不要猜测 `claude-*-数字` 名称；若不确定，留空即可。
    - 旧用户保存的别名不会被自动修改，防止升级破坏已经可用的中转站；需要迁移时清空别名、改用全模型目录即可。
  - **本地模型名改写代理（让 gpt-* 等非 Anthropic 模型也能上桌面应用）**：若中转站只认自己的字面模型名（如 `gpt-5.6`）而不认识 Claude 名，扩展会在本机 `127.0.0.1:<端口>` 起一个轻量转发器，把桌面应用发来的安全别名改写回真实模型名再转发给中转站——中转站收到的始终是字面模型名，无需它自己做映射。桌面配置的网关地址指向这个本地转发器，密钥仍写真实中转站 key 并原样透传。端口默认 `4180`，可用 `aiProviderSwitcher.claudeProxyPort` 修改。该代理运行在 VS Code 扩展宿主内、只监听本机回环，因此要求 Claude Desktop 与 VS Code 在同一台机器（Remote-SSH/WSL 下不可达）；VS Code 重载会重启代理，固定端口使地址保持稳定。
  - **全模型目录（本地代理）**：在 Provider 的「Claude Desktop（独立应用）→ 配置 Desktop 模型」中先获取模型列表，再在「Desktop 全模型目录」点**添加已缓存的全部模型**，或只勾选需要的模型。每个 GPT、Claude 或其他模型都得到自己的 Desktop 路由；选择器的显示名保留真实模型名（如 `gpt-5.6 · REAL-Hajimi-GPT`），但内部使用安全 route ID，因此不触发 Desktop 的非 Anthropic 名字校验。全模型目录优先于高级兼容别名；点“清空全模型目录”即可恢复兼容别名或原生直连模式。
  - 切换后必须**完全退出并重启桌面应用**（含托盘图标）才生效。
  - 删除某个 Claude 中转站时，它在桌面配置库中的条目会一并清除；如果它正是桌面应用当前使用的，会同时恢复官方订阅。
  - ⚠️ 网关密钥会以明文写入该配置文件（这是桌面应用要求的格式），文件权限即为当前用户的数据目录权限。
- 注意：会话历史不跨后端解密——在 A 中转站创建的对话，用 B 中转站继续可能失败（推理内容加密块只能由原后端解密）。

### 配置非 Claude 模型

运行 **AI Provider Switcher: Configure Claude Model Mapping**：

- 推荐模式：一个主模型加一个快速/低成本模型。
- 高级模式：分别填写每个模型族。
- 只有在 Provider 明确支持时才启用 1M 上下文。

模型映射能解决 Provider 只接受自定义模型 ID、而 Claude Code 尝试使用内置 Claude ID 的问题。Claude Code 是否在原生模型栏展示这些模型，仍取决于客户端版本和 Provider 兼容性。

### Claude 配置冲突检查

运行 **AI Provider Switcher: Inspect Other Claude Configuration**。扩展会检查：

- VS Code 进程继承的系统环境变量。
- `~/.claude/settings.json`。
- 工作区 `.claude/settings.json`。
- 工作区 `.claude/settings.local.json`。

认证值会隐藏显示。对可安全修改的文件，扩展会先创建 `.bak` 备份，再只删除 Provider 相关字段。

## Codex 使用指南

### 切换到 Codex 自定义 Provider（Windows/macOS/Linux）

1. 打开管理器，在 Codex 卡片中点击“管理服务”。
2. 添加 Provider，输入名称和服务根地址。
3. 运行“切换 Codex 中转站”并输入 API Key。
4. 扩展请求 `/v1/models`，生成本地模型目录，并更新 `~/.codex/config.toml`。
5. 重新加载 VS Code。
6. 打开 Codex，在 Codex 原生模型栏中选择模型。
7. 建议切换后新建会话，不要在同一对话中跨 Provider 继续。

根地址示例：`https://api.example.com`。扩展会自动派生 `/v1`，不要重复填写。

### 统一 Codex 会话历史（官方与第三方合并为一个历史列表）

Codex 按会话记录中的 `model_provider` 标签把历史分成互不可见的“抽屉”：官方订阅落在内置 `openai` 桶，每个中转站各用独立 ID，因此频繁切换时旧会话看起来像“消失”了。运行 **AI Provider Switcher: Unified Codex Session History**（或 Codex 卡片中的“统一会话历史”）可消除这种割裂：

- **开启后**，官方订阅以共享的 `custom` 供应商标识运行（认证仍走 `auth.json` 的 ChatGPT 登录，`base_url` 缺省回落官方后端，仅分类标签改变），官方与第三方会话出现在同一历史列表中。
- 开启弹窗提供两种选择：**“开启并迁入现有官方会话”**（推荐，迁移前自动备份）或 **“仅开启（不迁入）”**（只影响开启后新建的会话）。
- **关闭时**，若存在迁移备份，可选择 **“关闭并按备份还原已迁入会话”**：按备份账本精确翻回，只还原“账本里有且当前仍是 custom”的会话；统一期间新建的会话无法归属供应商，会留在共享列表（重新开启后可见）。

安全设计：

- 迁移/还原**只改写** `session_meta.model_provider`（`~/.codex/sessions`、`archived_sessions` 下的 `.jsonl`）和索引库 `threads.model_provider`（`state_5.sqlite` / `state.db`），不改动任何对话内容。
- 每次改写前整文件备份到 `~/.codex/ai-provider-switcher-backups/codex-official-history-unify-v1/<时间戳>/`（含 `jsonl/`、`state/` 和记录所属 Codex 目录的 `meta.json`）；还原前再备份到独立的 `codex-official-history-unify-restore-v1/`。
- 原子写入（临时文件 + 整体替换），改写前后校验文件未被其他进程修改；状态库处于 WAL 模式时安全跳过并提示。
- 若 `config.toml` 已有手动定义的 `[model_providers.custom]` 段，为避免把流量路由到未知后端，插件拒绝注入并给出提示。

> [!WARNING]
> 跨供应商继续旧会话时，对方后端可能无法解密会话中的 `encrypted_content` 推理内容，导致继续失败——这是 Codex 上游的设计限制。统一历史解决的是“列表可见性”，不是“同对话跨供应商续聊”；旧会话请尽量在原供应商上继续。

### 恢复 Codex 官方服务

运行 **AI Provider Switcher: Use Codex Official Provider**，然后重新加载 VS Code。扩展会删除其管理的自定义 Provider 块，并恢复首次接管前记录的 `model_provider`、`model` 和 `model_catalog_json`；这不是整个 `config.toml` 的完整文件回滚。

## 解决 Codex 反复 Reconnecting

### 为什么会有“代理”这个功能

Codex 扩展并不是只发普通的 HTTPS 请求，它还要建立一条长连接（WebSocket）来流式接收回复。这两类连接读取代理配置的路径不一样：

- 你在系统里设置的代理，往往只被 VS Code 的 HTTPS 请求层读到；
- Codex 的后台进程是独立启动的 Node 进程，它只认自己进程环境里的 `HTTPS_PROXY` / `HTTP_PROXY`。

结果就是一个很典型的现象：模型列表能刷出来、账号能登录（HTTPS 走通了），但一开始对话就反复 `Reconnecting`（WebSocket 直连被墙或被公司网络拦截）。

这个功能做的事情很简单——把一个明确的代理地址写进 `~/.codex/.env`，让 Codex 后台进程启动时一定能读到，而不是指望它去继承某个不确定的系统设置。所谓“自动检测”只是替你把地址填好，**手动填写的效果完全一样**；探测不到并不代表功能不可用。

部分代理环境能处理 HTTPS，但 Codex 的 WebSocket 连接没有正确使用代理，于是会多次 `Reconnecting` 后才回退。运行：

**AI Provider Switcher: Configure Codex WebSocket Proxy**

### 推荐流程

1. 先启动本机代理软件并确认 HTTP 或混合代理端口可用。
2. 运行上述命令。
3. 选择“检查 `.env` 代理冲突”。
4. 如果存在旧的 `HTTP_PROXY`、`HTTPS_PROXY` 或 `NO_PROXY`，查看并决定保留或交由扩展管理。
5. 选择“自动检测并应用当前设备代理”。
6. 将作用范围保留为“仅官方 OpenAI 服务（推荐）”。
7. 立即重新加载 VS Code。
8. 在 Codex 中新建会话，确认不再出现连续重连。

### 自动检测来源

扩展按以下顺序寻找当前设备代理：

1. `HTTPS_PROXY` / `https_proxy`。
2. `HTTP_PROXY` / `http_proxy`。
3. VS Code `http.proxy`。
4. Windows 当前用户系统代理。
5. macOS `scutil --proxy`。
6. GNOME Linux `gsettings`。

第 1、2、3 步在所有系统上都有效；只有第 4、5、6 步依赖具体的操作系统机制。Linux 上第 6 步只覆盖 GNOME，KDE/Xfce 或纯命令行环境探测不到——这只影响“自动填好地址”这一步，不影响功能本身。

如果自动检测失败，选择“设置或更新代理”，填写完整地址，例如 `http://127.0.0.1:7890`。必须使用 HTTP(S) 地址；当前不接受 `socks5://`。

> [!NOTE]
> 在 Remote-SSH / WSL / 容器窗口中，`127.0.0.1` 指的是**远程主机自己**，不是你面前这台电脑。扩展会在写入前弹窗确认，详见[远程开发](#远程开发remote-ssh--wsl--容器)。

### 官方服务还是所有 Provider？

- **仅官方 OpenAI 服务（默认、推荐）**：使用官方服务时写入代理；切换到中转站时暂停扩展管理的代理。适合只在官方 WebSocket 上出现重连的情况。
- **官方服务及所有中转站**：只有当中转站自身也必须通过本机代理访问时选择。否则可能增加延迟、改变出口 IP，甚至导致中转站不可访问。

### `.env` 安全写入

扩展在 `~/.codex/.env` 中维护独立标记块：

```text
# BEGIN AI Provider Switcher managed Codex proxy
HTTP_PROXY="http://127.0.0.1:<当前设备端口>"
HTTPS_PROXY="http://127.0.0.1:<当前设备端口>"
NO_PROXY="localhost,127.0.0.1,::1"
# END AI Provider Switcher managed Codex proxy
```

- 端口来自当前设备检测结果或用户输入，不是固定值。
- 代理设置使用 machine scope，不应同步到其他设备。
- 写入前会检查非本扩展管理的重复代理变量。
- “停用插件管理的代理”只删除标记块，保留其他 `.env` 内容。

## 数据、安全和配置文件

| 内容 | 保存位置与行为 |
|---|---|
| Claude Provider 元数据、模型缓存 | VS Code 全局设置 |
| Claude Token | VS Code Secret Storage；启用 Provider 时也会写入 `claudeCode.environmentVariables`，以供 Claude Code 扩展读取 |
| Claude 权限模式 | VS Code 全局设置及 `~/.claude/settings.json` |
| Codex Provider 元数据、模型缓存 | VS Code 全局设置 |
| Codex API Key | VS Code Secret Storage；Windows 另存当前用户 DPAPI 加密文件，macOS/Linux 使用权限为 `0600` 的本地 Key 文件；不写入 `config.toml` |
| Codex Provider 配置 | Codex 主目录下 `config.toml` 中的顶层选择和扩展标记块 |
| Codex 模型目录 | Codex 主目录下的 `ai-provider-switcher-models.json` |
| Codex 代理 | Codex 主目录下 `.env` 中的扩展标记块 |
| 统一会话历史备份 | Codex 主目录下 `ai-provider-switcher-backups/codex-official-history-unify-v1/`（迁移）与 `codex-official-history-unify-restore-v1/`（还原） |

> Codex 主目录默认是 `~/.codex`（Windows 为 `%USERPROFILE%\.codex`）。若设置了 `CODEX_HOME` 环境变量，扩展会跟随它写入——因为 Codex 自己也读那里，写到默认目录会是一次没有任何报错的空操作。界面上的提示会直接显示实际使用的完整路径。
| Provider 额度快照 | VS Code 全局设置；仅缓存余额、百分比、限流值和更新时间，不缓存 API 响应正文 |

安全建议：

- 优先使用 HTTPS Provider。HTTP Provider 会使模型发现请求中的凭据面临明文传输风险。
- Claude Code 要读取自定义 Token，因此活动 Token 会出现在 VS Code 用户设置中。请保护用户设置并限制不受信任扩展和本机进程。
- 清除正在使用的 Claude Token 前，先切换回官方模式；单独执行“清除 Token”只删除 Secret Storage 副本。
- Windows DPAPI 文件绑定当前用户；macOS/Linux 依赖用户目录和 `0600` 文件权限。两者都不代表硬件级保护，也不能防御同一用户上下文中的恶意进程。
- “完全放行”会允许危险命令绕过常规确认，禁止在包含真实凭据或重要数据的普通工作环境使用。

## 常见问题

### 切换后为什么仍然使用旧 Provider？

重新加载 VS Code，并创建新会话。再运行 Claude 配置检查，确认系统环境变量或项目设置没有覆盖扩展配置。

### 为什么 Claude 主模型可用，但 Auto 命令仍被阻止？

针对当前已测试的 Claude Code 版本，Auto 可能使用独立安全分类请求。自定义 Provider 能运行主模型，不代表能处理分类请求。可改用“编辑自动接受”或“手动确认”；不要通过宽泛的命令白名单来模拟完全放行。

### 为什么 Codex 自定义 Provider 没有出现在模型栏？

确认 Provider 支持 Responses API 和 `/v1/models`，执行“刷新 Codex 模型”，重新加载，然后在 Codex 原生模型栏查看。

### 配置代理后仍然 Reconnecting？

确认代理软件正在运行、端口正在监听、代理类型为 HTTP 或混合代理，并已重新加载 VS Code。企业 PAC、认证代理或特殊网络策略可能仍需手动配置。

### 切换 Provider 会删除历史会话吗？

不会。扩展不会删除 Claude 或 Codex 本地会话历史，但不会迁移正在进行的对话上下文。切换后应新建会话。

### 自建中转站（one-api / new-api / LiteLLM）拉不到模型列表？

Base URL 要按服务实际监听的协议填。这类服务在本机多数只开明文 HTTP，地址应写成 `http://127.0.0.1:3000` 这种形式，写成 `https://` 会连不上。填错时扩展会直接告诉你是域名解析失败、端口拒绝连接还是证书问题，按提示改即可。

### 提示「不是有效的 JSON，无法安全写入」怎么办？

先用编辑器打开提示里给出的那个文件确认内容。如果内容看起来完全正常，多半是文件开头有一个看不见的 BOM 字节（记事本保存、PowerShell 的 `Set-Content` 或 `>` 重定向都会写入）——0.5.5 起扩展会自动忽略 BOM 与空文件，升级即可。若确实是手改坏了（缺引号、多逗号），同目录下有扩展改动前留下的 `.ai-provider-switcher-<时间戳>.bak` 备份可以还原。

### 切换了 Claude Desktop，应用里却没变化？

桌面应用只在**冷启动**时读配置，关掉窗口不等于退出：Windows 要在右下角托盘图标上右键选「Quit / 退出」，macOS 要按 ⌘Q 或菜单栏 Claude → Quit，Linux 要确认进程已结束。全部退出后再重新打开。扩展的提示语会按你当前的系统给出对应说法。

### Windows 上提示文件被占用（EPERM / EBUSY）？

配置文件正被别的程序打开：先关闭 Claude Desktop、关闭正在编辑该文件的编辑器，或暂停杀毒软件的实时扫描，然后重试。扩展会自动重试几次，仍失败时会把文件路径写在提示里。

### 统一会话历史里，跨供应商继续旧会话为什么失败？

会话文件完好无损，失败原因是上游设计：会话中的 `encrypted_content` 推理密文只能由生成它的后端解密，换供应商继续时对方无法解密。回到创建该会话的供应商继续，或直接新建会话即可。

## 命令参考

在命令面板中搜索 `AI Provider Switcher` 可查看全部命令。常用命令：

- `AI Provider Switcher: Quick Switch Provider`
- `AI Provider Switcher: Open Provider Manager`
- `AI Provider Switcher: Use Claude Official Subscription`
- `AI Provider Switcher: Switch Claude Desktop Service`
- `AI Provider Switcher: Manage Claude Gateways`
- `AI Provider Switcher: Edit Claude Gateway`
- `AI Provider Switcher: Configure Claude Model Mapping`
- `AI Provider Switcher: Configure Claude Command Strategy`
- `AI Provider Switcher: Configure Claude Desktop Models`
- `AI Provider Switcher: Inspect Other Claude Configuration`
- `AI Provider Switcher: Switch Codex Provider`
- `AI Provider Switcher: Use Codex Official Provider`
- `AI Provider Switcher: Manage Codex Providers`
- `AI Provider Switcher: Edit Codex Provider`
- `AI Provider Switcher: Unified Codex Session History`
- `AI Provider Switcher: Refresh Codex Models`
- `AI Provider Switcher: Configure Codex WebSocket Proxy`

## 开发与贡献

- 编译：`npm run compile`
- 测试：`npm test`
- 调试：在 VS Code 中按 `F5`
- 打包：`npx vsce package`

欢迎通过 [GitHub Issues](https://github.com/Silver-Zhang/ai-provider-switcher/issues) 提交错误、兼容性反馈和功能建议。

---

# English

## Why AI Provider Switcher?

Claude Code and Codex store provider configuration across VS Code settings, environment variables, and user-level files. Manual switching can leave stale variables behind, expose credentials, select unsupported models, or make Codex repeatedly report `Reconnecting` in proxied networks.

AI Provider Switcher brings those tasks into one visual workflow:

- Switch between official services and multiple custom providers.
- Save named providers instead of repeatedly editing configuration files.
- Map non-Claude model IDs to every Claude model family and agent role.
- Synchronize custom Codex models into Codex's native model control.
- Keep the standalone terminal Claude CLI in step with the VS Code integration.
- Manage Claude Desktop independently through its third-party inference config library.
- Unify Codex session history so official and third-party conversations share one list.
- Detect external Claude settings that override the selected provider.
- Configure a safe, reversible Codex WebSocket/HTTPS proxy.
- Preserve local session history when switching providers.

## Highlights

### Unified management

- One visual manager for both Claude and Codex.
- A status bar entry showing each active provider.
- Command Palette and Quick Pick workflows.
- Per-provider names, URLs, cached models, model mappings, and command strategies.

### Claude Code

- Switch between an official Claude subscription and multiple Anthropic-compatible providers.
- Enter tokens through a password field and cache them in VS Code Secret Storage.
- Discover and cache provider models from `/v1/models`.
- Map custom IDs such as DeepSeek, Kimi, or GLM to the main model, Fable, Opus, Sonnet, Haiku, background work, and subagents.
- Configure reasoning effort and opt into a 1M marker only when the provider explicitly supports it.
- Normalize the official DeepSeek root URL to its Anthropic-compatible endpoint and apply a recommended mapping.
- Store a command strategy per provider: Auto, Accept Edits, Manual, or `bypassPermissions` with a high-risk confirmation.
- Inspect inherited environment variables and Claude user/project settings for routing, authentication, model, and permission conflicts.
- Back up supported files before removing only conflicting provider fields.
- Sync the same managed environment into `~/.claude/settings.json` so the terminal `claude` CLI follows the VS Code integration.
- Manage Claude Desktop independently: named entries in the app's third-party inference config library, cached model lists and Anthropic-style model aliases, install-directory discovery, desktop state read back from disk, and cleanup when a gateway is deleted.

### Codex

- Switch between the built-in OpenAI provider and named OpenAI Responses API-compatible providers.
- Fetch `/v1/models`, generate a local Codex model catalog, and use Codex's native model control for selection.
- Remove only extension-managed provider blocks and restore the recorded top-level selection when returning to the official provider.
- Keep API keys out of plaintext `config.toml`.
- Configure a Codex WebSocket/HTTPS proxy with environment, VS Code, Windows, macOS, and GNOME Linux detection; per-device ports; manual HTTP(S) input; provider scope; conflict inspection; and reversible writes.
- Unify Codex session history: run the official subscription under the shared `custom` provider id and optionally migrate existing sessions into the shared list, with automatic backups and a ledger-based restore.

### Usage and quota MVP

- Show a usage summary for custom providers in the visual manager.
- Cache `x-ratelimit-*` headers while refreshing models without sending an extra paid inference request.
- Configure a read-only JSON GET endpoint and reuse the provider's saved credential.
- Auto-detect common `balance`, `five_hour`, and `weekly` fields, or map custom JSON paths.
- Display balance, five-hour and weekly windows, request/token limits, and reset values.
- Official Claude/Codex subscription quotas are not included because no stable third-party public API is available.

Run **AI Provider Switcher: Configure Provider Usage API**, then **AI Provider Switcher: Refresh Provider Usage**. Prefer HTTPS and read-only credentials. If the usage API has a different origin, the extension requires explicit confirmation before sending the saved provider credential. Without a provider usage endpoint, only compatible rate-limit response headers can be displayed.

> [!WARNING]
> Custom Codex providers support Windows, macOS, and Linux. Windows uses PowerShell plus DPAPI for the current user; macOS/Linux use a `0600` local key file read by a `0700` shell helper. For WSL/Remote extension hosts, install and run the extension in the same environment where Codex runs.

## Compatibility

| Capability | Windows | macOS | Linux |
|---|---:|---:|---:|
| Claude official/custom provider management | ✅ | ✅ | ✅ |
| Claude model mapping and conflict inspection | ✅ | ✅ | ✅ |
| Terminal Claude CLI sync | ✅ | ✅ | ✅ |
| Claude Desktop management | ✅ | ⚠️ | ⚠️ |
| Official Codex provider | ✅ | ✅ | ✅ |
| Codex WebSocket proxy | ✅ | ✅ | ⚠️ |
| Custom Codex providers | ✅ | ✅ | ✅ |
| Unified Codex session history | ✅ | ✅ | ✅ |

> ⚠️ Claude Desktop has official builds on all three platforms (Linux: <https://code.claude.com/docs/en/desktop-linux>), but the data-directory layout differs between platform builds and has so far only been verified on Windows. Auto-detection probes: Windows `%LOCALAPPDATA%\Claude` and `%APPDATA%\Claude`, macOS `~/Library/Application Support/Claude`, Linux `$XDG_CONFIG_HOME/Claude` and `~/.config/Claude`. If detection fails, set `aiProviderSwitcher.claudeDesktopConfigRoot` manually.
>
> ⚠️ Codex proxy **auto-detection** on Linux understands GNOME (`gsettings org.gnome.system.proxy`) and KDE (`~/.config/kioslaverc`); Xfce and headless setups simply detect nothing and do not error. On macOS a PAC/WPAD auto-configuration script is reported by name — Codex cannot evaluate PAC, so read the real port out of your proxy app and enter it manually. On any platform you can export `HTTPS_PROXY` first, or enter the address manually — manual entry behaves identically everywhere.

Requirements:

- VS Code `1.90.0` or newer.
- Install and enable Claude Code to use Claude features.
- Install and enable the official OpenAI Codex IDE extension to use Codex features.
- A custom Claude provider must expose a compatible Anthropic API.
- A custom Codex provider must implement the OpenAI Responses API. Chat Completions-only gateways are not supported.

### Remote development (Remote-SSH / WSL / containers)

The extension declares `"extensionKind": ["workspace", "ui"]`, so in a remote window it runs **on the remote side by default**. That is the right place for terminal CLIs: Claude Code and Codex run on the remote host, and so do `~/.claude` and `~/.codex`. Three consequences follow, each surfaced in the UI:

- **The manager states which machine is being written to**, e.g. “config is written to the WSL subsystem's `~/.claude` and `~/.codex`”.
- **Claude Desktop cannot be managed from the remote side.** It is a local GUI application whose data directory lives on the machine you are looking at, which the remote host has no path to. Attempting a Desktop switch in a remote window explains this and links straight to the `remote.extensionKind` setting.
- **`127.0.0.1` in a proxy address means different machines on the two sides.** A loopback address — detected or typed — is confirmed before being written into the remote `~/.codex/.env`. Under WSL the message names the fix: the subsystem's `127.0.0.1` is not the Windows host unless `.wslconfig` enables `networkingMode=mirrored`, so use the `nameserver` address from `/etc/resolv.conf` or `$(hostname).local` for a Windows-side proxy.

To manage **local** Claude Desktop instead of a remote CLI, pin the extension to the local side:

```jsonc
// settings.json
"remote.extensionKind": {
  "silver-zhang.ai-provider-switcher": ["ui"]
}
```

Reload after changing it. With `"ui"`, the `~/.claude` and `~/.codex` directories the extension writes become the local ones too.

## Installation

### Install a VSIX

1. Download the `.vsix` file from Releases.
2. Open the Extensions view in VS Code.
3. Select `…` → **Install from VSIX…**.
4. Run **Developer: Reload Window**.

### Run from source

1. Install Node.js LTS.
2. Clone the repository and run `npm install`.
3. Run `npm test`.
4. Press `F5` to open an Extension Development Host.

If PowerShell blocks `npm.ps1`, use `npm.cmd install` and `npm.cmd test`.

## Quick start

Open the manager by either:

- clicking the `Claude: ... · Codex: ...` status bar entry;
- running **AI Provider Switcher: Open Provider Manager**; or
- running **AI Provider Switcher: Quick Switch Provider**.

## Claude guide

### Configure Claude Code (VS Code / terminal)

This flow affects Claude Code inside VS Code and terminal `claude` only; it **does not change Claude Desktop**:

1. Open the manager; from the overview choose **Claude Code (VS Code / terminal) → Switch Claude Code provider**.
2. If there is no provider yet, add one with the **＋** in the Claude list; enter its name, service root URL, and token. Usually omit a trailing `/v1`.
3. In that provider's **Claude Code (VS Code / terminal)** section, choose **Configure Claude Code models**.
4. Use **Fetch models from service**. For non-Claude model IDs, use **Auto-assign roles** as a starting point, then adjust main, fast, and 1M choices as needed.
5. Choose **Save Claude Code configuration**. When the provider is active, the extension writes VS Code and terminal CLI configuration and offers a VS Code reload; start a new Claude conversation afterward.
6. Command strategy also belongs only to Claude Code / CLI and is configured from that provider's **Command strategy** action.

### Configure Claude Desktop (independent app)

This flow affects Claude Desktop only; it **does not change Claude Code in VS Code or terminal CLI**:

1. From the overview choose **Claude Desktop (independent app) → Switch Claude Desktop service**, then select the relay.
2. In that provider's **Claude Desktop (independent app)** section, choose **Configure Desktop models**.
3. In the **Full model catalogue**, choose **Add all cached models** or tick only the real models you need. This is the recommended path for a mixed GPT / Claude relay.
4. Choose **Save Claude Desktop models**. It immediately rewrites the Desktop config only when Desktop is currently using that provider; otherwise it is applied the next time you switch Desktop to it.
5. Fully quit and restart Claude Desktop according to the platform-specific instruction — closing a window is usually not enough.

> **Advanced: legacy compatibility aliases** is only for an existing old configuration or a name the relay explicitly documents. New users do not need to configure it.

### Return to the official Claude subscription

Run **AI Provider Switcher: Use Claude Official Subscription**, review external conflicts, and reload VS Code. Managed provider environment entries are removed and the command strategy is returned to Manual.

### Terminal Claude CLI and Claude Desktop

- **Terminal CLI**: switching a gateway (or back to official) writes the same managed `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` block into `~/.claude/settings.json`'s `env` — your other env entries and every other setting are preserved, with a timestamped backup before each change. The CLI shares the same session history as the VS Code integration, so `claude --resume` agrees on both sides.
- **Claude Desktop (independent)**: run **AI Provider Switcher: Switch Claude Desktop Service** to switch the desktop app alone; VS Code and CLI configuration are never touched. The desktop app does not read `env` — it routes through its own third-party inference mechanism, so the extension writes `configLibrary/<id>.json` (gateway URL and key) and `configLibrary/_meta.json` (`appliedId` selects the live entry) under the app data directory, and switches `claude_desktop_config.json`'s `deploymentMode` to `3p` (back to `1p` for official). Existing preferences, MCP configuration, and unknown fields are preserved; changes are backed up first.
  - The data directory is auto-detected (Windows `%LOCALAPPDATA%\Claude` and `%APPDATA%\Claude`, macOS `~/Library/Application Support/Claude`, Linux `$XDG_CONFIG_HOME/Claude` or `~/.config/Claude`). For installs elsewhere use the **Change Claude Desktop data directory…** picker or set `aiProviderSwitcher.claudeDesktopConfigRoot`; a failed detection lists the paths that were tried.
  - The manager chip and switch dialog read the desktop state back from disk, so changes made inside the app or by another tool show up truthfully.
  - Switching writes the gateway's cached models into the entry's `inferenceModels`, so the desktop app stops running its own model discovery — the request most relays answer with 404, which is what leaves the model picker empty and every message failing with `Your organization's model list hasn't loaded yet`. **Refresh the model list first**, then switch. A configured model mapping is carried across as each entry's `anthropicFamilyTier`, which is what makes the `opus` / `sonnet` / `haiku` names in the desktop picker resolve to real models.
  - ⚠️ **The desktop app only accepts model names that read like Anthropic models** (containing `claude` / `opus` / `sonnet` / `haiku`, etc.). This is the app's own restriction: one non-compliant name invalidates the whole entry, so `deepseek-*`, `gpt-*`, `qwen-*` **original names** cannot be written directly.
  - **Advanced compatibility aliases (only for old configuration or an explicit provider requirement)**: this is not the normal setup path. Once a full model catalogue is active, compatibility aliases do not participate in Desktop routing at all; new users should use the catalogue. Enter an alias only when the provider's documentation explicitly tells you to send that name verbatim. `opus` / `sonnet` / `haiku` / `fable` are generation-neutral Desktop tier labels — strongest, general-purpose, fast/low-cost, and enhanced reasoning — **not** specific official Claude versions, and no gateway is guaranteed to support them. Do not guess a `claude-*-number` model name; leave this empty when unsure.
    - Existing saved aliases are never automatically changed, so an upgrade cannot break a working relay. To migrate, clear the aliases and use the full model catalogue.
  - **Local model-name rewriting proxy (how gpt-* and other non-Anthropic models reach the desktop app)**: when the gateway only accepts its own literal model IDs (e.g. `gpt-5.6`) and does not recognise Claude names, the extension starts a lightweight forwarder on `127.0.0.1:<port>` that rewrites the desktop app's safe alias back to the real model before forwarding — so the gateway always receives its literal name and never has to map anything itself. The desktop config's gateway URL points at this local forwarder, while the key is still the real gateway key, forwarded untouched. The port defaults to `4180` (change it with `aiProviderSwitcher.claudeProxyPort`). The proxy lives inside the VS Code extension host and binds to loopback only, so Claude Desktop must be on the same machine (unreachable under Remote-SSH/WSL); a VS Code reload restarts the proxy, and the fixed port keeps the address stable.
  - **Full model catalogue (local proxy)**: in a provider's **Claude Desktop (independent app) → Configure Desktop models** area, fetch the model list, then use **Add all cached models** in **Desktop full model catalogue** — or tick just the models you need. Each GPT, Claude, or other model gets a distinct Desktop route. The picker label retains the real model name (for example `gpt-5.6 · REAL-Hajimi-GPT`), while its internal ID is a safe opaque route so Desktop's non-Anthropic-name validation does not reject it. The full catalogue takes precedence over advanced compatibility aliases; **Clear full model catalogue** returns to aliases or native direct routing.
  - Fully quit and restart the desktop app (including the tray icon) after switching.
  - Deleting a Claude gateway also unlinks its desktop config entry and, when it was the live one, restores the official subscription.
  - ⚠️ The gateway key is written in plain text into that configuration file (the format the desktop app requires); file protection is whatever the user data directory provides.
- Note: session history does not decrypt across backends — continuing a conversation created on gateway A with gateway B may fail (the encrypted reasoning block can only be decrypted by the backend that produced it).

### Map non-Claude models

Run **AI Provider Switcher: Configure Claude Model Mapping**. Recommended mode uses one main model and one fast/low-cost model; advanced mode configures each family separately. Enable the 1M marker only when the provider explicitly supports it.

### Inspect Claude conflicts

Run **AI Provider Switcher: Inspect Other Claude Configuration**. The extension checks inherited process variables, `~/.claude/settings.json`, and workspace `.claude/settings.json` / `.claude/settings.local.json`. Credential values are masked. Supported file edits are preceded by a timestamped backup and preserve permissions and unrelated settings.

## Codex guide

### Use a custom Codex provider (Windows/macOS/Linux)

1. Open the manager and select **Manage Providers** on the Codex card.
2. Add a named provider with its service root URL.
3. Switch to it and enter the API key.
4. The extension fetches `/v1/models`, writes a local catalog, and updates `~/.codex/config.toml`.
5. Reload VS Code.
6. Open Codex and select a model from Codex's native model control.
7. Start a new conversation after switching.

Enter a root such as `https://api.example.com`; `/v1` is derived automatically.

### Unified Codex session history (official and third-party in one list)

Codex buckets its history by the `model_provider` tag each session records: the official subscription lands in the built-in `openai` bucket while each managed gateway has its own id, so after frequent switches old sessions can look “gone”. **AI Provider Switcher: Unified Codex Session History** (or the Codex card's *Unified history* button) removes that split:

- **When enabled**, the official subscription runs under the shared `custom` provider id (authentication still goes through the ChatGPT login in `auth.json`; `base_url` falls back to the official backend — only the classification tag changes), so official and third-party sessions appear in one history list.
- The enable dialog offers **“Enable and migrate existing official sessions”** (recommended; backed up first) or **“Enable only (no migration)”** (affects only sessions created afterwards).
- **When disabled**, migration backups make **“Disable and restore migrated sessions”** available: a ledger-based restore flips back only sessions that are both in the ledger and still tagged `custom`. Sessions created while unified was on cannot be attributed, so they stay in the shared list (visible again when re-enabled).

Safety:

- Migration/restore rewrites **only** `session_meta.model_provider` (`~/.codex/sessions`, `archived_sessions` `.jsonl` files) and `threads.model_provider` (`state_5.sqlite` / `state.db`) — never conversation content.
- Full-file backups under `~/.codex/ai-provider-switcher-backups/codex-official-history-unify-v1/<timestamp>/` (`jsonl/`, `state/`, `meta.json`) before every rewrite; restores back up first to `codex-official-history-unify-restore-v1/`.
- Atomic writes, file-unchanged verification, per-item fault isolation, and a bounded startup retry. A database in WAL mode is snapshotted safely.
- Refusal gates: unified routing is not injected when `config.toml` already carries an explicit `model_provider` or a manually defined `[model_providers.custom]` section.

> [!WARNING]
> Resuming an old session on a different provider may fail because the other backend cannot decrypt the session's `encrypted_content` reasoning — an upstream Codex design. Unification solves list visibility, not cross-provider continuation; resume old sessions on their original provider.

### Return to official Codex

Run **AI Provider Switcher: Use Codex Official Provider** and reload. This removes extension-managed provider blocks and restores the three recorded top-level keys; it is not a complete rollback of the entire `config.toml` file.

## Fix repeated Codex Reconnecting

Some proxy setups handle HTTPS while Codex's WebSocket connection does not use the proxy correctly, causing repeated reconnect attempts before fallback. Run:

**AI Provider Switcher: Configure Codex WebSocket Proxy**

Recommended workflow:

1. Start your local proxy and ensure its HTTP or mixed port is available.
2. Inspect existing `.env` proxy conflicts.
3. Select **Auto-detect and apply this device's proxy**.
4. Keep the default **Official OpenAI provider only** scope.
5. Reload VS Code.
6. Start a new Codex conversation and verify that repeated reconnect attempts are gone.

Detection order:

1. `HTTPS_PROXY` / `https_proxy`.
2. `HTTP_PROXY` / `http_proxy`.
3. VS Code `http.proxy`.
4. Windows user proxy settings.
5. macOS `scutil --proxy`.
6. GNOME Linux `gsettings`.

If detection fails, enter a full HTTP(S) proxy URL such as `http://127.0.0.1:7890`. The port is never hard-coded. `socks5://` URLs are not currently accepted.

### Proxy scope

- **Official OpenAI provider only (default, recommended):** the managed proxy block is active for official Codex and paused while a custom provider is active.
- **Official and all custom providers:** use only when a custom gateway must also pass through the local proxy. Otherwise this may add latency, change the outbound IP, or make the gateway unreachable.

### Safe `.env` management

The extension owns only a marked block in `~/.codex/.env`. It checks existing unmanaged `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` entries before writing. Disabling the feature removes only its marked block and preserves unrelated content. Proxy settings use VS Code machine scope and should not be synchronized between devices.

## Data and security

| Data | Storage and behavior |
|---|---|
| Claude provider metadata and model cache | Global VS Code settings |
| Claude token | VS Code Secret Storage and, while active, `claudeCode.environmentVariables` for the Claude Code extension |
| Claude permission mode | Global VS Code settings and `~/.claude/settings.json` |
| Terminal CLI environment | A managed `env` block in `~/.claude/settings.json` |
| Claude Desktop configuration | Entries under the app data directory's `configLibrary/` with `appliedId` in `_meta.json`; `deploymentMode` in `claude_desktop_config.json` |
| Codex provider metadata and model cache | Global VS Code settings |
| Codex API key | VS Code Secret Storage; additionally a current-user DPAPI file on Windows or a mode-`0600` local key file on macOS/Linux; never written to `config.toml` |
| Codex provider configuration | Top-level selection and marked blocks in `config.toml` under the Codex home |
| Codex model catalog | `ai-provider-switcher-models.json` under the Codex home |
| Codex proxy | A marked block in `.env` under the Codex home |
| Unified history backups | `ai-provider-switcher-backups/codex-official-history-unify-v1/` (migration) and `codex-official-history-unify-restore-v1/` (restore), under the Codex home |

> The Codex home defaults to `~/.codex` (`%USERPROFILE%\.codex` on Windows). When `CODEX_HOME` is set, the extension follows it — Codex reads there, so writing to the default would be a silent no-op. Every message in the UI prints the full path actually used.
| Provider usage snapshots | Global VS Code settings; only balance, percentages, rate-limit values, and timestamps are cached, not raw API bodies |

Security guidance:

- Prefer HTTPS providers. HTTP transports credentials in model-discovery requests without TLS protection.
- Claude Code needs the active custom token, so it is also present in VS Code user settings while that provider is active. Protect your settings and limit untrusted local processes and extensions.
- Switch Claude back to official mode before clearing a saved token. The clear-token command alone removes only the Secret Storage copy.
- Windows DPAPI binds the file to the current user; macOS/Linux rely on the user directory and `0600` file permissions. Neither is hardware-backed protection or protection from malicious processes running as the same user.
- Never use `bypassPermissions` in a normal workspace containing important data or real credentials.

## Troubleshooting

### The old provider is still active

Reload VS Code and start a new conversation. For Claude, run the external configuration inspector to find inherited or project-level overrides.

### Claude chat works, but Auto blocks commands

In currently tested Claude Code versions, Auto may use a separate safety-classifier request. A provider serving the main model may still reject that request. Use Accept Edits or Manual instead of broad allow rules.

### Custom Codex models do not appear

Verify Responses API and `/v1/models` support, refresh Codex models, reload, and use Codex's native model control.

### Codex still reconnects after proxy configuration

Verify that the proxy process is running, its port is listening, it supports HTTP or mixed proxying, and VS Code was reloaded. PAC files, authenticated enterprise proxies, and special network policies may require manual setup.

### Are sessions deleted when switching?

No. Local session history is preserved, but an active conversation is not migrated across providers. Start a new conversation after switching.

### A self-hosted relay (one-api / new-api / LiteLLM) returns no models

Enter the Base URL with the scheme the service actually listens on. Locally these usually serve plain HTTP, so the address is `http://127.0.0.1:3000`, not `https://…`. When it is wrong, the extension now names the actual cause — DNS failure, refused port, or a rejected certificate — instead of a generic connection error.

### "Not valid JSON, cannot write safely"

Open the file named in the message. If its contents look fine, it most likely starts with an invisible BOM (written by Notepad, or by PowerShell `Set-Content` / `>` redirection) — since 0.5.5 the extension ignores a BOM and treats an empty file as empty, so upgrading is the fix. If the file really was hand-edited into invalid JSON, a `.ai-provider-switcher-<timestamp>.bak` copy from before the last change sits next to it.

### Claude Desktop was switched but nothing changed

The desktop app reads its config only on a cold start, and closing the window is not quitting: on Windows right-click the tray icon and choose Quit, on macOS press ⌘Q or use Claude → Quit, on Linux confirm the process has exited. The extension's own message states this for the platform you are on.

### Windows reports the file is in use (EPERM / EBUSY)

Another program holds the config open. Close Claude Desktop, close any editor with the file open, or pause real-time antivirus scanning, then retry. The extension retries briefly on its own and names the file if it still fails.

### Why does resuming an old session fail under unified Codex history?

The session file is intact. The cause is upstream design: the `encrypted_content` reasoning ciphertext can only be decrypted by the backend that produced it, so another provider cannot continue it. Resume on the original provider, or start a new session.

## Commands

Search `AI Provider Switcher` in the Command Palette. Common commands include:

- `AI Provider Switcher: Quick Switch Provider`
- `AI Provider Switcher: Open Provider Manager`
- `AI Provider Switcher: Use Claude Official Subscription`
- `AI Provider Switcher: Switch Claude Desktop Service`
- `AI Provider Switcher: Manage Claude Gateways`
- `AI Provider Switcher: Edit Claude Gateway`
- `AI Provider Switcher: Configure Claude Model Mapping`
- `AI Provider Switcher: Configure Claude Command Strategy`
- `AI Provider Switcher: Configure Claude Desktop Models`
- `AI Provider Switcher: Inspect Other Claude Configuration`
- `AI Provider Switcher: Switch Codex Provider`
- `AI Provider Switcher: Use Codex Official Provider`
- `AI Provider Switcher: Manage Codex Providers`
- `AI Provider Switcher: Edit Codex Provider`
- `AI Provider Switcher: Unified Codex Session History`
- `AI Provider Switcher: Refresh Codex Models`
- `AI Provider Switcher: Configure Codex WebSocket Proxy`

## Development and contributing

- Build: `npm run compile`
- Test: `npm test`
- Debug: press `F5` in VS Code
- Package: `npx vsce package`

Bug reports, compatibility feedback, and feature requests are welcome through [GitHub Issues](https://github.com/Silver-Zhang/ai-provider-switcher/issues).

## License

See [LICENSE](LICENSE).
