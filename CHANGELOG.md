# Changelog

All notable changes to AI Provider Switcher are documented in this file.

## 0.4.3 - 2026-08-04

- Added a Claude "Use official" action to the visual manager and the Claude gateway management menu, matching the existing Codex official action.
- Fixed the missing path back to the official Claude subscription from the visual manager, which previously required the Command Palette or Quick Switch.

## 0.4.2 - 2026-07-31

- Added macOS and Linux support for custom Codex providers; the API key bridge is no longer Windows-only.
- Added a POSIX authentication helper with `0700` directory and `0600` key-file permissions alongside the existing Windows DPAPI helper.
- Added Codex WebSocket proxy configuration through a managed block in `~/.codex/.env` that preserves unrelated entries.
- Added system proxy detection from environment variables, VS Code `http.proxy`, Windows Internet Settings, macOS `scutil --proxy`, and GNOME `gsettings`.
- Added a proxy scope option to apply the managed proxy either only to the official OpenAI provider or to every Codex provider.
- Added detection and optional cleanup of pre-existing unmanaged proxy variables in `~/.codex/.env`.
- Added a usage and quota MVP with per-provider read-only JSON usage APIs, automatic field detection, and custom JSON path mapping.
- Added rate-limit parsing from model-endpoint response headers so usage appears without a dedicated quota API.
- Added usage configuration management for viewing, editing, testing, and deleting per-provider quota settings.
- Added confirmation before sending provider credentials to a different origin or over plaintext HTTP.
- Added usage error classification for HTML login pages, reverse-proxy error pages, and rejected credentials.
- Added a provider detail view in the visual manager with per-provider switch, model, strategy, and quota actions.
- Added a new extension logo and Marketplace icon.
- Changed the visual manager to a responsive layout with a redesigned header.

## 0.4.1 - 2026-07-28

- Added a per-Provider Claude command strategy selector for Auto, Edit automatically, Manual, and Completely allow.
- Clarified that Auto is a classifier-backed permission mode, not a complete command bypass.
- Detect whether a Provider model catalog exposes the fixed `claude-sonnet-5` Auto classifier model and warn when it does not.
- Explain that model-family environment mappings do not rewrite Auto's initial Sonnet 5 availability probe.
- Added an explicit high-risk confirmation before enabling `bypassPermissions`, the only mode that truly skips routine classification and confirmation.
- Display the active command strategy alongside each Claude Provider in the visual manager.

## 0.4.0 - 2026-07-28

- Added Provider-level Claude model mappings for any Anthropic-compatible service using non-Claude model IDs.
- Added guided recommended and advanced mapping flows for main, Fable, Opus, Sonnet, Haiku, background, and subagent models.
- Added cached `/v1/models` selection with manual model entry when discovery is unavailable.
- Added an explicit 1M capability choice so `[1m]` is never appended to unknown Providers automatically.
- Added custom-model and pinned-family display metadata so mapped models can appear meaningfully in Claude Code.
- Apply the official DeepSeek mapping through the same generic mapping system.
- Explain Auto classifier behavior and prevent stale Claude-family mappings such as `claude-opus-5[1m]` from leaking across Provider switches.
- Classify external configuration as blocking or informational instead of treating permission rules as Provider conflicts.
- Added guided conflict resolution that backs up Claude settings and removes only routing, credential, and model fields while preserving permissions and unrelated settings.
- Added actionable guidance for inherited Windows/terminal environment variables that the extension cannot safely edit.

## 0.3.3 - 2026-07-28

- Show the active Claude service name instead of the generic `Gateway` label.
- List named Claude services directly in Quick Switch and mark the active service.
- Track the selected Claude service and identify it from `ANTHROPIC_BASE_URL`.
- Removed bundled RealLab and Pateway defaults; new installations start with empty provider lists.
- Added DeepSeek official Anthropic endpoint detection and its recommended Claude Code model mappings.
- Expand the DeepSeek service root to `/anthropic` and clear inherited provider/model variables when switching away.
- Warn when using DeepSeek that Claude Code Auto mode's separate safety classifier may be incompatible; Manual and Accept Edits remain available.
- Detect external Claude routing, cloud-provider, authentication, and model configuration before switching; redact credentials and provide a manual inspection command.
- Include Claude permission modes, ask/deny rules, and Auto-mode trust/classifier settings in diagnostics.

## 0.3.2 - 2026-07-27

- Fixed Windows DPAPI authentication helper failures caused by trailing newlines in encrypted key files.
- Restored the Codex Authorization header for custom providers, resolving `401 Missing API Key` responses.

## 0.3.1 - 2026-07-27

- Changed Codex custom-service setup to synchronize discovered models into Codex's native model picker.
- Removed model selection from the Codex Provider switch flow.
- Added an Open Codex action so models are selected from the Codex page after reloading.

## 0.3.0 - 2026-07-27

- Added a unified visual manager for Claude and Codex services and models.
- Changed the status bar entry to open the unified manager.
- Expanded Quick Switch to include Claude, Codex, and the manager.
- Unified terminology around official and custom services.
- Changed URL input to accept provider roots only and derive `/v1` protocol paths automatically.
- Changed Codex switching to discover models automatically without forcing a model choice first.

## 0.2.0 - 2026-07-27

- Added official OpenAI Codex provider and custom gateway switching.
- Added multiple named Codex provider profiles.
- Added Codex model discovery, cached display, and model selection.
- Added Windows DPAPI-backed Codex API key bridging without plaintext keys in VS Code settings or config.toml.
- Added safe restoration of the previous top-level Codex model and provider configuration.

## 0.1.1 - 2026-07-26

- Added the Marketplace extension icon.

## 0.1.0 - 2026-07-26

- Added switching between Claude official subscription and gateway mode.
- Added management for multiple named Claude gateway profiles.
- Added per-gateway token storage through VS Code Secret Storage.
- Added gateway model discovery, refresh, and cached model display.
- Added access to Claude session history and provider-switch safety prompts.