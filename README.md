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
- 可配置返回 JSON 的只读 GET 额度 API，并复用该 Provider 已保存的凭据。
- 自动识别常见 `balance`、`five_hour` 和 `weekly` 字段，也可填写 JSON 字段路径。
- 支持余额、5 小时窗口、周窗口、请求额度、Token 额度及重置时间。
- 当前只面向自定义 Provider；官方 Claude/Codex 订阅额度没有稳定的第三方公开接口。

使用方式：运行 **AI Provider Switcher: Configure Provider Usage API** 配置接口，然后运行 **AI Provider Switcher: Refresh Provider Usage** 测试和刷新。优先使用 HTTPS 及只读凭据；如果额度 API 与 Provider 不同域，扩展会在发送已保存凭据前要求明确确认。如果服务商未提供额度 API，扩展只能显示模型接口返回的限流响应头。

> [!WARNING]
> Codex 自定义 Provider 现在支持 Windows、macOS 和 Linux。Windows 使用 PowerShell + 当前用户 DPAPI；macOS/Linux 使用权限为 `0600` 的本地 Key 文件，并通过权限为 `0700` 的 shell helper 读取。WSL/Remote 扩展宿主应在实际运行 Codex 的同一环境中安装和运行扩展。

## 系统要求与兼容性

| 能力 | Windows | macOS | Linux |
|---|---:|---:|---:|
| Claude 官方/自定义 Provider 管理 | ✅ | ✅ | ✅ |
| Claude 模型映射和配置检查 | ✅ | ✅ | ✅ |
| Codex 官方服务 | ✅ | ✅ | ✅ |
| Codex WebSocket 代理 | ✅ | ✅ | ✅ |
| Codex 自定义 Provider | ✅ | ✅ | ✅ |
| 统一 Codex 会话历史 | ✅ | ✅ | ✅ |

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

### 切换到 Claude 自定义 Provider

1. 打开管理器，在 Claude 卡片中点击“管理服务”。
2. 选择“添加中转站”。
3. 输入名称和服务根地址。通常不要在结尾填写 `/v1`。
4. 选择“快速切换”，选中新 Provider。
5. 首次使用时输入 Token。输入内容不会显示。
6. 根据提示处理可能覆盖路由、认证或模型的外部配置。
7. 如果 Provider 使用非 Claude 模型 ID，按引导配置模型映射。
8. 选择命令执行策略。
9. 重新加载 VS Code，并创建一个新 Claude 会话。

### 恢复 Claude 官方订阅

1. 运行 **AI Provider Switcher: Use Claude Official Subscription**。
2. 检查并处理可能干扰官方登录的外部配置。
3. 重新加载 VS Code。
4. 如有需要，在 Claude Code 中重新完成官方登录。

切换到官方模式会清除扩展管理的 Claude Provider 环境变量，并将命令策略恢复为手动确认。

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

如果自动检测失败，选择“设置或更新代理”，填写完整地址，例如 `http://127.0.0.1:7890`。必须使用 HTTP(S) 地址；当前不接受 `socks5://`。

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
| Codex Provider 配置 | `~/.codex/config.toml` 中的顶层选择和扩展标记块 |
| Codex 模型目录 | `~/.codex/ai-provider-switcher-models.json` |
| Codex 代理 | `~/.codex/.env` 中的扩展标记块 |
| 统一会话历史备份 | `~/.codex/ai-provider-switcher-backups/codex-official-history-unify-v1/`（迁移）与 `codex-official-history-unify-restore-v1/`（还原） |
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

### 统一会话历史里，跨供应商继续旧会话为什么失败？

会话文件完好无损，失败原因是上游设计：会话中的 `encrypted_content` 推理密文只能由生成它的后端解密，换供应商继续时对方无法解密。回到创建该会话的供应商继续，或直接新建会话即可。

## 命令参考

在命令面板中搜索 `AI Provider Switcher` 可查看全部命令。常用命令：

- `AI Provider Switcher: Quick Switch Provider`
- `AI Provider Switcher: Open Provider Manager`
- `AI Provider Switcher: Use Claude Official Subscription`
- `AI Provider Switcher: Manage Claude Gateways`
- `AI Provider Switcher: Configure Claude Model Mapping`
- `AI Provider Switcher: Configure Claude Command Strategy`
- `AI Provider Switcher: Inspect Other Claude Configuration`
- `AI Provider Switcher: Switch Codex Provider`
- `AI Provider Switcher: Use Codex Official Provider`
- `AI Provider Switcher: Manage Codex Providers`
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

### Codex

- Switch between the built-in OpenAI provider and named OpenAI Responses API-compatible providers.
- Fetch `/v1/models`, generate a local Codex model catalog, and use Codex's native model control for selection.
- Remove only extension-managed provider blocks and restore the recorded top-level selection when returning to the official provider.
- Keep API keys out of plaintext `config.toml`.
- Configure a Codex WebSocket/HTTPS proxy with environment, VS Code, Windows, macOS, and GNOME Linux detection; per-device ports; manual HTTP(S) input; provider scope; conflict inspection; and reversible writes.

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
| Official Codex provider | ✅ | ✅ | ✅ |
| Codex WebSocket proxy | ✅ | ✅ | ✅ |
| Custom Codex providers | ✅ | ✅ | ✅ |

Requirements:

- VS Code `1.90.0` or newer.
- Install and enable Claude Code to use Claude features.
- Install and enable the official OpenAI Codex IDE extension to use Codex features.
- A custom Claude provider must expose a compatible Anthropic API.
- A custom Codex provider must implement the OpenAI Responses API. Chat Completions-only gateways are not supported.

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

### Use a custom Claude provider

1. Open the manager and select **Manage Providers** on the Claude card.
2. Add a named provider and enter its service root URL. Usually omit a trailing `/v1`.
3. Quick-switch to the new provider.
4. Enter the token when prompted.
5. Review any external configuration conflicts.
6. Configure model mapping if the provider exposes non-Claude model IDs.
7. Select a command strategy.
8. Reload VS Code and start a new Claude conversation.

### Return to the official Claude subscription

Run **AI Provider Switcher: Use Claude Official Subscription**, review external conflicts, and reload VS Code. Managed provider environment entries are removed and the command strategy is returned to Manual.

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
| Codex provider metadata and model cache | Global VS Code settings |
| Codex API key | VS Code Secret Storage; additionally a current-user DPAPI file on Windows or a mode-`0600` local key file on macOS/Linux; never written to `config.toml` |
| Codex provider configuration | Top-level selection and marked blocks in `~/.codex/config.toml` |
| Codex model catalog | `~/.codex/ai-provider-switcher-models.json` |
| Codex proxy | A marked block in `~/.codex/.env` |
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

## Commands

Search `AI Provider Switcher` in the Command Palette. Common commands include:

- `AI Provider Switcher: Quick Switch Provider`
- `AI Provider Switcher: Open Provider Manager`
- `AI Provider Switcher: Use Claude Official Subscription`
- `AI Provider Switcher: Manage Claude Gateways`
- `AI Provider Switcher: Configure Claude Model Mapping`
- `AI Provider Switcher: Configure Claude Command Strategy`
- `AI Provider Switcher: Inspect Other Claude Configuration`
- `AI Provider Switcher: Switch Codex Provider`
- `AI Provider Switcher: Use Codex Official Provider`
- `AI Provider Switcher: Manage Codex Providers`
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
