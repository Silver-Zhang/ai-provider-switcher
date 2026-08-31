# Changelog

All notable changes to AI Provider Switcher are documented in this file.
## 0.6.0 - 2026-08-17

- Added a local model-name rewriting proxy so non-Anthropic models (e.g. `gpt-5.6`) can run in Claude Desktop. Claude Desktop rejects any third-party model name that does not read like an Anthropic route, so a relay that only accepts its own literal IDs was unreachable no matter what the extension wrote. The extension starts a lightweight forwarder on `127.0.0.1:<port>` (default `4180`, change via `aiProviderSwitcher.claudeProxyPort`); the desktop app sends a safe route ID to the forwarder, which rewrites it back to the real model and forwards to the relay, streaming the response through untouched. Only the desktop app routes through it — Claude Code and the terminal CLI already send the real model name straight to the relay, so they are unchanged, as are native Anthropic relays, which keep the direct path. The proxy binds loopback only and lives in the extension host, so it requires Claude Desktop and VS Code on the same machine.
- Added a Claude Desktop full-model catalogue. A provider with both Claude and GPT models can add every cached model (or select a subset) to the Desktop picker. Each model receives a stable opaque `claude-route-<hash>` identifier that passes the app's Anthropic-name validation while its `labelOverride` shows the real model and provider; the local proxy resolves the route exactly back to that model. The catalogue takes precedence over legacy standard aliases, which remain available for compatibility and can be restored by clearing the catalogue.
- Changed the confusing always-visible “standard Claude aliases” form into a collapsed **Advanced: legacy compatibility aliases** section. New users see the full model catalogue as the only recommended setup; it directly displays and forwards each real model. Existing alias configurations automatically stay open and keep working, but are explicitly marked as inactive when a catalogue is selected.
- Stopped presenting version-specific names such as `claude-haiku-5` as a standard default. New advanced setups offer only generation-neutral Desktop tier labels (`sonnet`, `opus`, `haiku`, `fable`) and warn that they work only when the provider explicitly documents them; users who are unsure are directed to the exact full-model catalogue instead of guessing future Claude version numbers.
- Redesigned the Provider Manager around the products users actually operate: **Claude Code (VS Code / terminal)** and **Claude Desktop (independent app)** are now separate cards on the overview, separate sections on every Claude provider, and separate model pages. A Code-model save updates only Code/CLI configuration and can offer a VS Code reload; a Desktop-model save updates only Desktop configuration and gives the complete-quit restart instruction. The old single “模型与参数” action remains a backwards-compatible deep link to the Claude Code page, but it no longer mixes Desktop controls into that page.
- Clarified shared provider connection information (name, URL, token): it is the one part that can intentionally update either currently active client, and the interface says so before editing.
- Added an experimental loopback protocol-conversion foundation for future OpenAI Responses ↔ Anthropic Messages bindings. It is isolated from all direct providers and uses a separate local port; text request/response and streaming conversion, per-binding authentication, strict rejection of unsupported Agent features, and honest text-only Codex catalog capabilities are covered by tests. The UI binding flow remains deliberately gated until real current-client request captures validate it; direct Claude, Desktop, Codex and network-proxy routes are unchanged.
- Left unchanged: Claude Code / terminal CLI / Codex routing, and the direct path for native Anthropic relays.

## 0.5.5 - 2026-08-17

- Fixed automatic role assignment inverting DeepSeek's own model pair. `chat` counted as a strength marker, so `deepseek-chat` outranked `deepseek-reasoner` and the cheap model was assigned the main role while the reasoner was demoted to the background one — the exact opposite of the intent, on the most common pair served by Anthropic-compatible relays.
- Fixed an empty or BOM-prefixed Claude config aborting every write to it. A leading byte-order mark is what Notepad and PowerShell's `Set-Content`/`>` redirection write, and an empty file is what a crashed or interrupted writer leaves behind; both were reported as "不是有效的 JSON，无法安全写入" and blocked the very write that would have repaired the file. This covered `~/.claude/settings.json`, the permission-mode writer, the settings cleanup and Claude Desktop's own config files.
- Fixed the model editor silently adding `CLAUDE_CODE_EFFORT_LEVEL=auto` to a provider that had never set it. `auto` is a value that gets written, so it could not double as "not configured"; the select now starts on an explicit 不设置 option and the preview no longer disagrees with what is actually written.
- Fixed the active Claude provider being mis-identified when two providers share one Base URL (one relay, two accounts). Matching was by URL alone, so the first one in the list always won; the recorded active provider now breaks the tie.
- Fixed the same ambiguity for Claude Desktop, which stores an entry ID derived from the provider ID — an exact identity that was available and unused, while the URL match could name the wrong account.
- Fixed the model list never loading from a gateway served over plain HTTP. Both validators accept `http://` because self-hosted relays (one-api, new-api, LiteLLM) usually run without TLS on localhost, but the request hardcoded HTTPS, so every one of them failed as "无法连接到网关". Affected the Codex model list too.
- Fixed editing a provider's Base URL or Token not reaching Claude Desktop when that provider is the one the app is configured with. The app kept the old endpoint and the old key until the desktop switch was run again by hand.
- Changed the settings cleanup to write atomically like every other settings write, so an interrupted write cannot truncate a `settings.json` the extension was only asked to clean up.
- Fixed a stale in-memory 1M declaration surviving an alias refill, which could make the desktop config written in that same run disagree with the editor.
- Fixed every "fully quit Claude Desktop (including the tray icon)" message describing Windows on all three platforms. Closing the window leaves the app running on Windows and on macOS in different ways, and the config is only re-read on a cold start, so the instruction now names the actual gesture: the tray icon on Windows, ⌘Q or Claude → Quit on macOS, confirming the process exited on Linux.
- Fixed messages naming `~/.claude/settings.json` and `~/.codex/config.toml` literally. Windows has no such path, and `CODEX_HOME` can move the whole directory — the exact failure the 0.5.4 fix was about — so every message now prints the path that was actually written.
- Fixed "remove this inherited environment variable" pointing at the Windows environment-variables dialog regardless of platform. It now names the Windows dialog, the macOS shell profiles plus `launchctl unsetenv`, or the Linux profile files, and says why a window reload is not enough.
- Fixed the Codex API key prompt claiming DPAPI encryption on macOS and Linux, where the file is plaintext protected by `0600` permissions. Both are legitimate; only one of them was being described.
- Changed connection failures from a single "无法连接到网关" to the cause and its fix: an unresolvable host, a refused port, an HTTPS request against a plaintext port, an expired or unverifiable certificate (named as such, since corporate TLS interception is common and unfixable by retrying) and a timeout are now distinguished.
- Changed the "Base URL must start with http:// or https://" message to say which one to use — public relays are HTTPS, self-hosted ones are usually `http://127.0.0.1:port`.
- Changed the Claude Desktop directory picker's hint from two hardcoded example paths to the locations actually probed on the current platform.
- Added a brief retry and a plain-language explanation when replacing a config file fails because another process holds it open. This is a Windows-only failure (`EPERM`/`EBUSY` from a running Claude Desktop, an open editor or an antivirus scan) that POSIX does not have, and it previously surfaced as a bare English error code.
- Changed the build tasks, which hardcoded one machine's Windows path and an old VSIX filename, to portable npm scripts (`npm run package`, `npm run install:vsix[:insiders]`) that work on all three platforms.
- Left unchanged: `CLAUDE_CONFIG_DIR` is not honoured, unlike the `CODEX_HOME` support added in 0.5.4. Claude Code's documentation defines no such variable and pins user settings to `~/.claude/settings.json`; writing elsewhere on the strength of an undocumented variable would produce configs the CLI never reads.

## 0.5.4 - 2026-08-17

- Fixed the Codex integration writing to `~/.codex` even when `CODEX_HOME` points elsewhere. Provider blocks, API key files, the auth helper, the model catalog and the proxy `.env` all went to a directory Codex never reads, so the switch reported success and changed nothing, with no error anywhere to explain it. Every Codex path now resolves through `CODEX_HOME` (including a `~/…` value), falling back to `~/.codex` as before.
- Fixed the check for an existing `custom` provider section missing every form but the bare one. `[model_providers."custom"]` — the quoted style this extension itself writes elsewhere, and therefore the style users copy — along with the single-quoted and spaced variants all read as "not present", so unified history appended a *second* `custom` table. A duplicate table is a TOML parse error: the result was a Codex that would not start. Table headers are now compared by parsed key path, and a `[model_providers.custom.auth]` subtable counts as defining the parent.
- Fixed `model_provider = 'custom'` being read as "not routed to the shared bucket". Only the double-quoted form was recognised, though TOML accepts both, so a config that was already correct was rewritten on every switch.
- Fixed a CRLF `config.toml` being rewritten to LF in its entirety whenever a single key changed, and the managed `.env` block being written with LF into an otherwise-CRLF file. Both files now keep the line ending they already had.
- Fixed the Windows auth helper handing Codex a key with a trailing CRLF where the POSIX helper hands it the bare key: emitting the decrypted string onto the PowerShell pipeline appends a newline. It now writes to stdout directly, and the POSIX key file no longer stores a trailing newline either, so both platforms produce identical bytes.
- Fixed a console window flashing on Windows on every proxy-menu open and every API key save. None of the child processes the Codex feature spawns set `windowsHide`, which defaults to false.
- Fixed a proxy address entered without a scheme (`127.0.0.1:7890` — the form Clash and v2rayN display, and therefore the form that gets pasted) failing with a raw English `Invalid URL`. A missing scheme is now read as `http://`, and the remaining parse failures are reported in Chinese. The Windows registry path already did this; manual entry did not.
- Added SOCKS proxies. `socks5://` and friends were rejected outright although Codex's HTTP client supports them, which left anyone on a SOCKS-only proxy with no way to use the feature.
- Fixed a PAC- or WPAD-configured macOS being reported as having no proxy at all, alongside advice to "确认系统代理已启用" for a proxy that was already on. `scutil --proxy` reports these separately from the manual settings; the detection now names the PAC URL and explains that Codex cannot evaluate the script, so the port has to be read out of the proxy app.
- Added KDE proxy detection on Linux. Only GNOME's `gsettings` was consulted, so a Plasma desktop — where the setting lives in `~/.config/kioslaverc`, with the port separated by a space rather than a colon — looked identical to a machine with no proxy configured.
- Fixed the proxy detection probes being able to hang the menu or deadlock: `reg.exe` is chatty about inaccessible keys and its stderr pipe was never drained, which stalls a child process once the pipe fills. Every probe now drains stderr and gives up after five seconds.
- Fixed the WAL wait freezing the whole VS Code window for up to eight seconds during a session-history migration. The extension host is single-threaded, so the synchronous wait blocked even the progress notification that was supposed to show the work was underway.
- Fixed `sqlite_home` in `config.toml` not accepting a `~/…` path (it is not shell-expanded there) and resolving a relative path against whatever directory VS Code happened to be launched from rather than against the Codex home.
- Changed the Windows failure when a session file or the state database is held open by a running Codex from a bare `EPERM`/`EBUSY` — which reads as a permissions problem the user cannot act on — to an explanation naming the file and what to close.
- Changed clearing the API key of the *active* Codex provider to say so. Its `[…auth]` block correctly stays in `config.toml` so its session history remains resolvable, but that left the next Codex request failing at the auth helper with no hint about why.
- Left unchanged: a provider named only in non-Latin characters still derives the ID `codex-provider`. Provider IDs are the partition key for Codex session history and must stay stable across a remove/re-add, so changing the derivation would strand existing sessions. Codex's own picker shows the provider `name`, not the ID.

## 0.5.3 - 2026-08-16

- Fixed saving the model editor not applying anything. The older mapping wizard wrote the new models into the VS Code environment and `~/.claude/settings.json` immediately, while the visual editor added in 0.5.1 only printed "please re-apply this service" — so a saved change looked successful while all three targets kept running the previous models. Saving now applies to whatever the provider is already live on, and offers the reload.
- Fixed a model change never reaching Claude Desktop. The desktop config was only ever rewritten by the desktop switch command, so editing models left the app on its old list no matter which path was used. When the edited provider is the one the desktop app is currently configured with, its config is now rewritten as part of the save. The app still has to be fully restarted (tray icon included) to pick it up.
- Fixed the first Claude Desktop alias's 1M switch being impossible to turn off. Clearing every alias switch stored "no declaration", which the editor read back as "inherit the main model's declaration" and re-ticked on the next render. An edited alias list is now stored as the decision it is, and the main model only seeds the default alias while the list has never been edited.
- Added one-click role assignment to the model editor. The six mapping roles are filled from the model names alone — the strongest-looking model takes the reasoning roles, the fastest-looking one the background roles — so the common case no longer requires knowing what `fable` or `subagent` select. The assignment is a starting point and every row stays editable.
- Added a "fetch models from the service" button to the model editor, so a provider whose model list was never cached can be filled in without leaving the form to run the refresh command and coming back. Rows already on screen keep their role and 1M switch; only genuinely new names are appended.
- Added a live preview of what the configuration will write (`ANTHROPIC_MODEL`, the four family variables, the subagent model and the effort level), updated as the form is edited. Unassigned roles fall back to the main model and 1M-ticked models carry the `[1m]` suffix, which is what makes both rules visible instead of implicit.
- Added a "fill in the standard Claude aliases" button for the Claude Desktop model names, and an inline explanation shown when a gateway's own model IDs are ones the desktop app refuses — the case where aliases are the only way to reach it. That explanation used to appear only after a desktop switch had already failed.
- Added the model editor to the test suite, which had no coverage of it, along with the role suggestion and the alias 1M rule.

## 0.5.2 - 2026-08-16

- Fixed the per-model 1M switches being discarded on save. The declaration was stored per *role*, but a model routinely fills several roles and the editor only lets a row name one, so a switch survived only on the single role its row happened to select. It is now keyed by the model ID: a model marked 1M is sent as `model[1m]` in every role it fills — including the roles it only fills by falling back to the main model, which previously sent the same model without the suffix.
- Fixed a model with no role assigned losing its 1M switch on every save. The switch was collected only from rows naming a role, and read back only for rows naming a role, so ticking 1M on an unmapped model could never persist. Unmapped models now keep their declaration.
- Fixed the model editor silently wiping a provider's entire model mapping — every role, every 1M switch, and the effort level — when no row was assigned the "main" role. The mapping cannot be built without a main model, and the empty result was written over the stored one while the UI reported a successful save. The form is now kept open with an explanation instead, which is what its documentation already claimed happened.
- Fixed Claude Desktop never offering the 1M-context option for a gateway reached through its own model names. That path still read the pre-0.5.1 gateway-wide flag, which the per-model editor only sets when the main model's row is ticked, and even then it stamped the capability onto the single default model — every other model in the list was unreachable. It now carries the same per-model declaration the editor stores, so each model the user marked 1M is offered with the option. Requires re-applying the desktop switch (and a full app restart, tray icon included).
- Changed the stored shape of a provider's 1M declaration to `modelMapping.longContextModels`. Existing data migrates on read with no change in behavior: a stored per-role `longContextRoles` resolves to the models those roles point at, and the older gateway-wide `supports1m` resolves to the main model as before. Both legacy fields are still written, re-derived from the models, so downgrading to an earlier build reads the same declaration.
- Added the `desktopModel1m`, `longContextRoles`, and `longContextModels` keys to the settings schema in `package.json`, where the first two were in use since 0.5.1 but undeclared.

## 0.5.1 - 2026-08-16

- Added a per-provider "Models & parameters" editor in the visual manager: the selected service's model list is editable row by row (add, rename, remove), each model can be assigned a mapping role (main / opus / sonnet / haiku / fable / subagent), and the gateway-wide effort level and the Claude Desktop model aliases are set from the same form. Replaces the long multi-step mapping wizard for day-to-day edits; the wizard remains available in the overflow menu.
- Changed the 1M-context declaration from a gateway-wide lock to per-model switches: every mapping role (main / opus / sonnet / haiku / fable / subagent) can declare 1M on its own, driving the CLI's `[1m]` suffix per role, and every Claude Desktop alias carries its own switch, so a gateway whose models have different context windows no longer forces one answer on all of them. The default alias inherits the main model's declaration, and stored legacy `supports1m` mappings keep their old behavior.
- Fixed the Claude Desktop model picker never offering the 1M-context option for a gateway reached through Anthropic-style aliases (such as DeepSeek). The `supports1m` capability declared in a provider's model mapping is now carried onto the alias entries, where the desktop app reads it — every alias gets the 1M variant (the opus alias resolves to the gateway's pro model, which deserves it as much as the default), and `prefer1m` starts the picker on the default entry's 1M variant. Requires re-applying the desktop switch (and a full app restart, tray icon included) after updating.
- Changed the standard Claude Desktop alias set to the current Claude generations (`claude-sonnet-5`, `claude-opus-5`, `claude-haiku-5`) instead of the dated 4-5 names. Anthropic-compatible gateways route by prefix (`claude-opus-*` to the pro model, other `claude-*` names to the fast one), so existing deployments keep working; re-apply the desktop switch to pick the names up.
- Fixed the first-ever desktop switch writing an empty model list: when the switch found no usable model and the confirmation attached the standard Claude aliases, the config entry was still written with the empty list computed before the prompt, leaving the desktop picker empty. The entry is now rebuilt after the confirmation, so a brand-new machine reaches a working desktop config in one switch.

## 0.5.0 - 2026-08-15

- Added Claude CLI support: switching a gateway (or back to the official subscription) now also writes the managed env block into `~/.claude/settings.json`, so the standalone terminal `claude` CLI shares the same provider as the VS Code integration. Unrelated `env` entries and every other settings key are preserved, with a timestamped backup and atomic write before every change.
- Added independent Claude Desktop management: a new "Switch Claude Desktop Service" command (plus a visual manager button and a management-menu entry) routes the desktop app through its own third-party inference config library, never touching the VS Code / CLI configuration. The desktop app must be fully restarted (including the tray icon) to pick the change up.
- Added Claude Desktop install discovery: every documented data directory is probed (`%LOCALAPPDATA%\Claude` and `%APPDATA%\Claude` on Windows, `~/Library/Application Support/Claude` on macOS, `$XDG_CONFIG_HOME`/`~/.config/Claude` on Linux), and a new `aiProviderSwitcher.claudeDesktopConfigRoot` setting plus a "change data directory" picker covers installs that live anywhere else. A failed detection now lists the paths that were tried instead of naming a single hardcoded one.
- Added desktop state read-back: the manager chip and the switch dialog report the gateway the desktop app is actually configured with, read from `configLibrary/_meta.json` on disk, so a change made by the app itself or another tool is reflected instead of a value this extension remembered.
- Added desktop cleanup on delete: removing a Claude gateway also unlinks its stored desktop config and, when it was the live one, restores the official subscription — its base URL and key no longer linger in the desktop config library.
- Added refusal safety: an unparsable desktop config is reported rather than replaced, unknown keys in a config entry are preserved, and empty env values are not written to JSON config files, where an empty `ANTHROPIC_BASE_URL` would be read as a broken endpoint.
- Changed the gateway/official switch flow to strip the extension's own managed env from `~/.claude/settings.json` in memory before scanning for conflicts, so a previous switch is never reported as an external conflict and an abandoned switch no longer leaves the terminal CLI unconfigured.
- Changed the terminal CLI sync to also run when a provider is edited and when a model mapping is applied or cleared, so `~/.claude/settings.json` cannot drift from the VS Code configuration; a failed sync warns instead of failing the switch.
- Fixed the terminal CLI sync writing every Claude env variable it found into `~/.claude/settings.json`; only the keys this extension manages are written now.
- Added the desktop model list: a switched gateway now writes its cached models into the config entry's `inferenceModels`, so the desktop app stops running its own model discovery — the discovery request that most relays answer with a 404, leaving the model picker empty and every message failing with "Your organization's model list hasn't loaded yet". The model mapping configured for a gateway is carried across as each entry's `anthropicFamilyTier` / `isFamilyDefault`, which is what makes the `opus` / `sonnet` / `haiku` names in the desktop picker resolve to real models.
- Added Claude Desktop model aliases, which is what makes a provider like DeepSeek reachable from the desktop app at all. The app refuses to send a model ID that does not read as an Anthropic route, but the Anthropic-compatible endpoints these providers expose map Claude names onto their own models server-side (DeepSeek's `/anthropic` routes `claude-opus-*` to its pro model and every other `claude-*` name to its fast one). A gateway can now be given Anthropic-style IDs to send instead of its own model names — offered as a one-click standard set when a switch finds no usable model, editable by hand, and available any time from the new "Configure Claude Desktop Models" command and the Claude management menu. Each alias carries its tier and is labelled with the gateway it resolves to, so the desktop picker does not look like it is offering genuine Claude models.
- Added a desktop model-compatibility check: Claude Desktop rejects an entire config entry when any configured model name does not read as an Anthropic route, so incompatible IDs are dropped with a warning that names them, and a gateway with no usable ID at all asks before switching instead of producing a config the app silently refuses. This is a restriction of the desktop app itself; the same gateway keeps working normally for the VS Code integration and the terminal CLI.
- Fixed refreshing the model list failing for a gateway whose Base URL carries a path (such as `https://api.deepseek.com/anthropic`), where no model endpoint exists below the path: the origin is now tried as well, and a 404 moves on to the next candidate instead of ending the search.
- Fixed a failed model refresh reporting only `HTTP <code>`, which hid what the server actually said. The gateway's own message is now shown, so an exhausted quota, a rejected key, and a missing endpoint are told apart. Applies to the Codex model refresh too.
- Added Remote-SSH / WSL / dev-container awareness. The extension declares `"extensionKind": ["workspace", "ui"]`, so a remote window keeps running it on the remote host where the Claude and Codex CLIs and their `~/.claude` / `~/.codex` directories actually live; the visual manager now states which machine is being written to instead of leaving it ambiguous.
- Added a remote guard for the Codex proxy, where `127.0.0.1` silently means two different machines on the two sides of a connection. A loopback address — whether detected (VS Code's `http.proxy` travels with Settings Sync) or typed — is now confirmed before it is written into the remote host's `~/.codex/.env`. Under WSL the message names the actual fix: the subsystem's `127.0.0.1` is not the Windows host unless `.wslconfig` enables `networkingMode=mirrored`, so the `/etc/resolv.conf` nameserver address or `$(hostname).local` is what a Windows-side proxy needs.
- Changed the Claude Desktop "not found" message in a remote window to explain the cause instead of blaming the install: the desktop app is a local GUI application, so its data directory was never going to exist on the remote host that was searched. The dialog offers a direct route to the `remote.extensionKind` setting that pins this extension to the local side.
- Added a Claude Desktop status chip to the visual manager header and a desktop-mode line to the Claude card.
- Changed the credential prompt to state that the token is written in plain text to the CLI and desktop config files when those syncs are in use, instead of claiming it never leaves Secret Storage.
## 0.4.4 - 2026-08-15

- Added manual reordering: Providers can be dragged by the `⠿` handle in the visual manager, and the order is written back to settings so Quick Switch, the management menus, and the status bar follow it. A reorder never drops a Provider, even if the list was rendered before it changed.
- Changed the visual manager to a two-pane layout with a permanent Provider list on the left and the selected Provider's detail on the right, replacing the flow where opening a Provider replaced the whole page and required a "back" trip to reach any other one.
- Added per-row switch and edit buttons that appear on hover, so switching a Provider no longer requires opening it first or answering a Quick Pick.
- Added `＋` buttons above each list that add a Claude or Codex Provider directly, and a "delete this service" action in each Provider's overflow menu that acts on the Provider already selected instead of asking again.
- Changed the manager to update only the panes that changed instead of rewriting the whole document on every action, so scrolling, focus, and open menus survive a switch or refresh.
- Fixed the edit form discarding what was typed when a save was rejected: the name and Base URL are now restored into the fields, and the reason is shown inline above them instead of in a notification detached from the form. A typed credential is deliberately not retained, and the message says it has to be re-entered.
- Fixed the Provider rows in the visual manager not responding to Enter or Space; they were focusable but only ever activated by a mouse click.
- Changed the manager header to report the Claude and Codex Providers that are actually active, replacing a decorative status light that always read "本地配置已就绪" regardless of state.
- Changed each action row to carry exactly one filled button, with the remaining actions as outline buttons and the rarely used ones collapsed into a `⋯` menu, instead of seven or eight identically weighted buttons per card.
- Changed the three permanently visible explanation blocks into one collapsed "帮助与说明" section, and reduced the header from a full-width hero to a single compact bar, so the Provider list and its actions start near the top of the panel.
- Added the active marker to Codex Providers in the manager, which previously only Claude Providers carried; the Codex detail view reported "可用 Provider" even for the Provider in use.
- Added provider editing: a Provider's name, Base URL, and credential can now be changed in place from a form in the visual manager, instead of deleting and re-adding it. Available from the Provider detail page, the Claude and Codex management menus, and the new `Edit Claude Gateway` / `Edit Codex Provider` commands.
- Added edit-time consistency handling: the Provider ID stays fixed (it keys the saved credential, the model cache, and the Codex sessions bound to it), a changed Base URL clears that Provider's stale model cache, a changed credential is rewritten to Secret Storage and the Codex key file, and an active Provider's live configuration is rewritten with a reload prompt.
- Added a name and URL check on save, rejecting an empty name, a name already used by another Provider, and a URL without an `http://` or `https://` scheme.
- Changed a Codex Provider edit to refresh the managed `[model_providers.*]` blocks in `~/.codex/config.toml`, which name every Provider rather than only the active one, while leaving the top-level `model_provider`, `model`, and `model_catalog_json` keys untouched.
- Added unified Codex session history: the official subscription can run under the shared `custom` provider id (authentication unchanged) so official and third-party sessions appear in one history list, with an optional one-time migration of existing sessions (automatic backups first) and a ledger-based restore when the feature is turned off.
- Added the migration/restore safety layer: only `session_meta.model_provider` in `~/.codex/sessions` / `archived_sessions` jsonl files and `threads.model_provider` in `state_5.sqlite` / `state.db` are rewritten, via atomic writes with per-file backups under `~/.codex/ai-provider-switcher-backups/`, file-unchanged verification, and a WAL-mode safety guard.
- Added consistent state-database backups: a database in WAL mode is snapshotted with `VACUUM INTO` (falling back to a truncating checkpoint) so rows still pending in the `-wal` sidecar are captured, instead of copying a main file that may not yet contain them.
- Added restore coverage for providers that were deleted from settings after migration: the restore ledger is rebuilt from the backups alone and is no longer intersected with the current provider list, so removing a provider can no longer strand its sessions in the shared bucket.
- Added per-item fault isolation: one unreadable session file or locked state database is recorded and reported instead of aborting the whole migration or restore, and the remaining items still complete.
- Added visible reporting of partial failures, with the failing file and reason surfaced in the completion notification.
- Added refusal gates: unified routing is not injected when `config.toml` already carries an explicit `model_provider` or a manually defined `[model_providers.custom]` section.
- Added startup retry for a deferred or partially failed migration (e.g. when the live config was not yet routed to the shared bucket), bounded to three attempts before a one-time warning.
- Changed backup databases to open read-only when the restore ledger is read, so the only recovery copy is never modified by inspecting it.
- Added the "Unified Codex session history" command, manager menu entry, and visual manager button, plus the `aiProviderSwitcher.unifyCodexSessionHistory` and `aiProviderSwitcher.unifyCodexMigrateExisting` settings.
- Added a Codex default model command that picks from the discovered model list or accepts a hand-entered model ID, and writes it to the top-level `model` key in `~/.codex/config.toml`.
- Added the same action to the visual manager overview card, the Codex provider detail view, and the Codex management menu.
- Added manual model entry when a Codex provider's `/v1/models` endpoint returns nothing, replacing the hard failure that blocked the switch.
- Fixed Codex session history disappearing after switching to the official provider: managed provider blocks now stay in `config.toml` so threads recorded under those provider IDs remain resolvable, and only the top-level `model_provider` key is swapped.
- Fixed newly added Codex providers receiving a timestamped ID, which stranded every earlier thread when a provider was removed and re-added. New providers now get a stable `codex-<name>` ID; existing provider IDs are left untouched.
- Fixed a model refresh returning an empty list wiping a hand-entered model catalog.
- Changed the Codex switch, delete, and manager copy to explain that a session is permanently bound to the provider it was created under, so switching never deletes history but also cannot carry the current conversation over.

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