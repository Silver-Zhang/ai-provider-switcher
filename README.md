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
- Command: AI Provider Switcher: Switch Codex Provider
- Command: AI Provider Switcher: Use Codex Official Provider
- Command: AI Provider Switcher: Manage Codex Providers
- Command: AI Provider Switcher: Refresh Codex Models
- Command: AI Provider Switcher: Select Codex Model
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

When switching to Official mode it removes the managed gateway keys above and restores:

- claudeCode.disableLoginPrompt=false

## Configure

Open settings and configure:

- aiProviderSwitcher.gatewayBaseUrl
- aiProviderSwitcher.enableGatewayDiscovery
- aiProviderSwitcher.disableLoginPromptInGateway
- aiProviderSwitcher.setAttributionHeaderZero
- aiProviderSwitcher.gateways

The `aiProviderSwitcher.gateways` setting is an array of named profiles. Each
profile has an `id`, `name`, and `baseUrl`. Use the Manage Gateways command to
add or remove profiles without editing JSON manually. Each profile gets its
own token in VS Code Secret Storage.

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
	Otherwise run the refresh command and reload VS Code. The extension cannot
	force an arbitrary model into Claude Code's `/model` picker; Claude Code
	decides which returned IDs it accepts and displays.
- Switching providers does not delete Claude Code's local session history. The
	extension cannot merge or migrate a running conversation between providers:
	provider-specific context, billing, model state, and tool state may differ.
	After switching, use a new Claude Code session and refer to the old session
	from Session History when needed.
- The extension changes one global VS Code setting, so all VS Code windows using
	the same user profile see the selected provider. Do not switch while a Claude
	Code request is still running.
