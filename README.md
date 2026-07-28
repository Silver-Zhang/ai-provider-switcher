# AI Provider Switcher

> This is an independent community extension for configuring Claude Code and Codex.
> It is not affiliated with Anthropic, OpenAI, Claude, Codex, or GitHub.

A VS Code extension for managing AI coding assistant providers. It supports
Claude Code switching between:

- Official subscription mode
- Gateway mode (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN)

It can also maintain multiple named Claude gateways and switch between them.

For the official OpenAI Codex IDE extension, it can also:

- Switch between the built-in OpenAI provider and named Responses API-compatible gateways
- Maintain multiple Codex gateway profiles
- Discover model IDs from `/v1/models`
- Select the active Codex model
- Synchronize discovered custom-provider models into Codex's native model picker
- Update the shared user-level `%USERPROFILE%\.codex\config.toml`
- Keep each Codex API key out of VS Code settings by using Secret Storage plus a
	Windows DPAPI-encrypted helper file under `%USERPROFILE%\.codex`

## Features

- Visual Provider Manager for Claude and Codex
- Unified status bar entry for all providers
- Command: AI Provider Switcher: Quick Switch Provider
- Command: AI Provider Switcher: Open Provider Manager
- Command: Claude Switcher: Use Official Subscription
- Command: Claude Switcher: Use Gateway
- Command: Claude Switcher: Manage Gateways
- Command: Claude Switcher: Add Gateway
- Command: Claude Switcher: Remove Gateway
- Command: Claude Switcher: Clear Saved Gateway Token
- Command: Claude Switcher: Open Claude Session History
- Command: Claude Switcher: Refresh Gateway Models
- Command: Claude Switcher: Show Gateway Models
- Command: AI Provider Switcher: Configure Claude Model Mapping
- Command: AI Provider Switcher: Configure Claude Command Strategy
- Command: AI Provider Switcher: Inspect Other Claude Configuration
- Command: AI Provider Switcher: Switch Codex Provider
- Command: AI Provider Switcher: Use Codex Official Provider
- Command: AI Provider Switcher: Manage Codex Providers
- Command: AI Provider Switcher: Refresh Codex Models
- Model selection is performed in Codex's native model control after provider synchronization
- Command: AI Provider Switcher: Show Codex Models
- Status bar indicator: Claude: Official or Claude: Gateway
- Gateway token is cached in VS Code Secret Storage, but Claude Code's required
	`claudeCode.environmentVariables` setting also contains the token so the
	Claude Code extension can read it. Treat the VS Code user settings file as
	sensitive and rotate the token if it has been exposed.

## How It Works

This extension updates the following VS Code user settings:

- claudeCode.environmentVariables
- claudeCode.disableLoginPrompt

When switching to Gateway mode it can set:

- ANTHROPIC_BASE_URL
- ANTHROPIC_AUTH_TOKEN
- CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
- CLAUDE_CODE_ATTRIBUTION_HEADER=0

For the official DeepSeek Anthropic endpoint, enter
`https://api.deepseek.com` or `https://api.deepseek.com/anthropic`; the former
is expanded to the Anthropic endpoint automatically. The extension also applies DeepSeek's
recommended main, Opus, Sonnet, Haiku, subagent, and effort environment
variables. DeepSeek's custom endpoint does not guarantee compatibility with
Claude Code Auto mode's separate safety-classifier request; use Manual or
Accept Edits mode if Auto repeatedly blocks shell commands.

For any Anthropic-compatible Provider that exposes non-Claude IDs (for example
DeepSeek, Kimi, or GLM), use **Configure Claude Model Mapping**. The guided
setup maps the Provider's real models to the main session, Fable, Opus, Sonnet,
Haiku, background work, and subagents. It can discover models from `/v1/models`
or accept manual IDs when that endpoint is unavailable. The recommended mode
uses one main model and one fast/low-cost model; advanced mode configures every
family separately. The extension does not add `[1m]` unless you explicitly
confirm that the Provider supports a one-million-token context window.

This mapping prevents Claude Code from silently falling back to built-in IDs
such as `claude-opus-5[1m]` when a gateway only accepts non-Claude names. Auto
mode still uses a separate safety-classifier request. Current Claude Code
usually classifies with Sonnet 5, falls back to the session model when needed,
and can use an Opus fallback for Fable sessions. Therefore map both Sonnet and
Opus to models the Provider can actually serve. If the Provider does not support
that classifier flow, switch to Manual or Accept Edits; do not add a blanket
`Bash(*)` permission, because Auto mode intentionally suspends broad allow rules.

### Auto mode and completely allowing commands

Auto mode is not a “run everything” mode. Commands outside Claude Code's built-in
read-only set and narrow permission rules are sent to a separate classifier. In
current Claude Code this classifier prefers the literal `claude-sonnet-5` model;
the Provider's `ANTHROPIC_DEFAULT_SONNET_MODEL` mapping does not rewrite the
classifier's initial availability probe. A gateway can therefore run the main
model successfully while Auto still reports that `claude-sonnet-5` is temporarily
unavailable. This is especially common when the gateway omits that exact model,
routes classifier payloads differently, throttles concurrent requests, or returns
an error that Claude Code presents through the same generic availability message.

Use **Configure Claude Command Strategy** per Provider:

- **Auto**: keep background classification; transient capacity failures can block commands.
- **Edit automatically**: edits and common file commands proceed; other commands prompt without using the classifier.
- **Manual**: all non-read-only actions prompt.
- **Completely allow**: enables Claude Code's `bypassPermissions` mode and skips the classifier and routine prompts. This is the only true “allow every command” option and should be used only in disposable, credential-free, preferably offline containers or VMs.

Narrow rules such as `Bash(npm list --depth=0)` can bypass the classifier for one
specific command in Auto mode. Blanket `Bash(*)`, wildcard interpreter rules,
package-manager run wildcards, and Agent rules are deliberately suspended when
entering Auto, so they cannot make Auto equivalent to complete bypass.

When switching to Official mode it removes the managed gateway keys above and restores:

- claudeCode.disableLoginPrompt=false

Before switching a Claude service, the extension scans for provider, credential,
and model settings outside its own VS Code configuration. It checks inherited
process/OS variables and Claude user/project settings. Detected secret values and
credential-helper commands are never displayed. Blocking routing, credential,
and model conflicts have a guided safe-resolution action. The extension creates
a timestamped `.bak` copy and removes only Provider-related fields from the
selected Claude settings file; permissions and unrelated settings are preserved.
Inherited Windows/terminal environment variables cannot be edited safely, so the
extension identifies the exact variable and explains that VS Code must be fully
restarted after removing it. Managed policy, a custom launcher, or shell
initialization performed after VS Code starts may still take precedence and
should be verified with Claude Code `/status`.
The scan also reports permission settings that commonly explain blocked commands:
`permissions.defaultMode`, `permissions.ask`, `permissions.deny`, Auto-mode
switches, trusted infrastructure, and `autoMode.classifyAllShell`. It also flags
broad `permissions.allow` rules that Claude Code deliberately suspends in Auto
mode, such as blanket Bash/PowerShell or wildcard interpreter access.

## Configure

Open settings and configure:

- aiProviderSwitcher.enableGatewayDiscovery
- aiProviderSwitcher.disableLoginPromptInGateway
- aiProviderSwitcher.setAttributionHeaderZero
- aiProviderSwitcher.gateways

The `aiProviderSwitcher.gateways` setting is an array of named profiles. Each
profile has an `id`, `name`, and `baseUrl`, plus an optional `modelMapping`. Use the Manage Gateways command to
add or remove profiles without editing JSON manually. Each profile gets its
own token in VS Code Secret Storage. New installations start with empty Claude
and Codex provider lists; the extension does not endorse or preconfigure any
third-party service.

Use `Claude Switcher: Refresh Gateway Models` to call the selected gateway's
`/v1/models` endpoint. The extension stores the returned IDs per gateway and
can display them with `Claude Switcher: Show Gateway Models`.

Configure Codex providers with `aiProviderSwitcher.codexProviders`, or use the
Codex management commands. A provider must expose OpenAI's Responses API because
Codex custom providers only support `wire_api = "responses"`. Enter and store
only the provider root, such as `https://api.example.com`; the extension derives
the protocol path `/v1` internally. The extension writes only provider metadata and the
selected model to `%USERPROFILE%\.codex\config.toml`; API keys are not written
in plaintext there.

Switching a Codex provider does not ask you to choose a model. The extension
discovers `/v1/models`, writes a Codex-compatible local model catalog, and then
you select the model from the Codex page's own model control after reloading.

When switching Codex to a custom service, the extension calls `/v1/models`
automatically. It reuses the current model when available, otherwise uses the
configured default when available, otherwise selects the first returned model.
You can change the model later from the visual manager.

## Run

1. Install Node.js LTS.
2. Run `npm install`.
3. Run `npm run compile`.
4. Press F5 to launch Extension Development Host.
5. Open Command Palette and run Claude Switcher commands.

On Windows PowerShell, if `npm` is blocked by execution policy, run
`npm.cmd install` and `npm.cmd run compile` instead.

## Notes

- After each switch, the extension asks whether to run Developer: Reload Window
	so Claude Code fully reloads with the selected provider.
- This extension does not depend on polyBridge.
- Codex and its IDE extension share `%USERPROFILE%\.codex\config.toml`. Switching
	Codex providers changes the global user-level Codex provider for new local
	Codex sessions. Existing sessions are retained but should not be continued
	across providers.
- The Codex gateway must implement the OpenAI Responses API. A gateway that only
	supports Chat Completions cannot be used by current Codex custom providers.
- The extension only controls the VS Code Claude Code configuration. Existing
	`ANTHROPIC_*` variables in Windows environment variables, shell profiles, or
	`%USERPROFILE%\\.claude\\settings.json` may still affect standalone Claude Code.
- New models may appear automatically in Claude Code when gateway model
	discovery is enabled and the gateway exposes them through `/v1/models`.
	Otherwise run the refresh command or configure a manual mapping and reload
	VS Code. The extension adds the mapped main model as a custom model option and
	labels mapped family entries; Claude Code still controls its final picker UI.
- Switching providers does not delete Claude Code's local session history. The
	extension cannot merge or migrate a running conversation between providers:
	provider-specific context, billing, model state, and tool state may differ.
	After switching, use a new Claude Code session and refer to the old session
	from Session History when needed.
- The extension changes one global VS Code setting, so all VS Code windows using
	the same user profile see the selected provider. Do not switch while a Claude
	Code request is still running.
