# Changelog

All notable changes to AI Provider Switcher are documented in this file.

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