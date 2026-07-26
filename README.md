# AI Provider Switcher

> This is an independent community extension for configuring Claude Code.
> It is not affiliated with Anthropic, Claude, or GitHub.

A VS Code extension for managing AI coding assistant providers. The first
implemented provider is Claude Code, with support for switching between:

- Official subscription mode
- Gateway mode (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN)

It can also maintain multiple named Claude gateways and switch between them.

## Features

- Command: Claude Switcher: Quick Switch Mode
- Command: Claude Switcher: Use Official Subscription
- Command: Claude Switcher: Use Gateway
- Command: Claude Switcher: Manage Gateways
- Command: Claude Switcher: Add Gateway
- Command: Claude Switcher: Remove Gateway
- Command: Claude Switcher: Clear Saved Gateway Token
- Command: Claude Switcher: Open Claude Session History
- Command: Claude Switcher: Refresh Gateway Models
- Command: Claude Switcher: Show Gateway Models
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
- This extension only changes Claude Code settings and does not depend on polyBridge.
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
