# Claude model catalogue from the installed CLI

Created: 2026-09-22

The model chip of a Claude session and the model menus of the new-session dialog list the models the installed Claude Code CLI itself reports. A model that Anthropic releases appears in VelaTerm as soon as the user's Claude Code knows it, in every existing session as well as in new ones, without a VelaTerm update and without anyone editing a model table or the website catalogue. The website catalogue and the bundled table remain fallbacks only.

## Where the list comes from

The sources are ranked in one place for every consumer (the session's model chip, the new-session dialog, the agent model list, the knowledge base runner and the code audit model list):

1. **A running conversation's own list.** A Claude conversation that is running reports its models over the stream-json control protocol (`list_models`). That answer is the list for that session and is stored as the cache of its binary, so every later catalogue read for a session that is not running, and every new-session menu, gets the new list as soon as one conversation has started. A Claude chat pane reads the list when the pane is created, when its own conversation reports models, and whenever the catalogue changes (the start-up probe finishes, Refresh is pressed, or another conversation reports a newer list), so an open pane of a resting session offers a new model without being reopened.
2. **The cached CLI probe.** Without a running conversation, VelaTerm asks the configured Claude binary headlessly (`claude -p --input-format stream-json --output-format stream-json --verbose --settings {"disableAllHooks":true} --strict-mcp-config --no-session-persistence`, control requests `initialize` and `list_models` only, stdin closed afterwards). The probe sends no user message and spends no account usage. Hooks and MCP servers are switched off and no transcript is written, like the knowledge base runner's headless launch: the model list depends on the account, not on hooks or MCP. The probe runs in a private directory `model-probe` below the app data directory (restricted to the owner on Unix, re-applied on every probe), never in a shared directory such as `/tmp`, because Claude Code reads the project settings of its working directory. When that directory cannot be created, the probe counts as failed and the fallback below applies. The probe runs off the main thread, is not a VelaTerm session (VelaTerm's session identity and hook settings are removed from its environment), and tolerates the system lines the CLI prints while starting.
3. **The website catalogue**, when it is present, see [Website model catalogue sync](model-catalog-sync_20260909.md).
4. **The bundled table** shipped with VelaTerm, filtered to what the installed version accepts.

When a CLI list is available it is the whole list: a model the user's Claude Code does not offer is not offered by VelaTerm either, and rows the CLI marks as disabled are excluded. Identifiers configured under `env` in `~/.claude/settings.json` (`ANTHROPIC_MODEL` and the other model keys) are appended in every case, as before.

The CLI's `default` row is not shown as a model. Instead, the model it resolves to is marked as the current default: the **Use Claude default** entry of the chip names it in its hint, for example "Uses the model selected by the agent's configuration (currently Opus 5.5 1M)".

## Cache, version check and refresh

The probe result is cached per binary in the app database together with the CLI version string and the check time. The cache is reused until one of these happens:

- `claude --version` reports a different version. The version is read at most once per app run (and again on Refresh). At app start VelaTerm loads the stored cache and checks the default Claude binary once in the background, so an update of Claude Code followed by a VelaTerm restart re-probes at start or on first use and the menus show the new list. When the version output cannot be read at all, a list probed during the current run is kept for the rest of the run and a list stored by an earlier run is probed afresh.
- **Refresh** in the model menu is pressed. Refresh re-reads the version and probes the CLI first; only when the probe fails does it fall back to refreshing the website catalogue.
- A running conversation answers `list_models`. That answer replaces the cache for its binary.

Only one probe per binary runs at a time; a second reader waits for the running probe instead of starting another process. After a failed probe the same binary is not asked again for a backoff period, the same as for the website catalogue; Refresh ignores the backoff.

The cache entry is treated as a protected setting: remote clients cannot read or write it directly. On the public share surface the catalogue is answered from the cache only, so a visitor can never start a process on the host; the backend decides this, not the client.

## Existing sessions after a Claude Code update

- **A session whose conversation is not running** gets the new list from the fresh probe after VelaTerm restarts (the version changed, so the old cache is invalid). No new session is needed.
- **A conversation resumed after the restart** reports the new list itself through `list_models`; the chip re-reads it on the models event.
- **A conversation still running on the old binary** (Claude Code updated in place, VelaTerm not restarted) keeps offering its own live list: that process cannot switch to a model it does not know. Sessions that are not running keep the previous list until Refresh, a restart, or a conversation started on the new binary reports its own list.

## Aliases and saved preferences

Short names and old spellings are resolved through one chokepoint that the chat engine uses at launch, when the model is changed, and when the CLI reports its model at start. With CLI data present, the CLI's own `value` to `resolvedModel` pairs decide: `opus[1m]` becomes whatever the installed CLI resolves it to (for Claude Code 2.1.280 `claude-opus-5-5[1m]`), an identifier the CLI offers is never rewritten, a short name such as `opus` is left to the CLI, and a retired full spelling such as `claude-opus-5[1m]` keeps its old rewrite to `claude-opus-5`. Without CLI data the static alias table applies as before. Saved preferences with old spellings keep working through the same path.

Offering and accepting differ on purpose. The menus offer only what the installed CLI lists, but the CLI's list is a shortlist of what it offers, not everything it accepts. A knowledge-base or security job saved with an identifier the list no longer names (for example `claude-opus-5` after Opus 5.5 became the default) therefore still validates against the list plus the bundled table and keeps running on retry.

## Labels

Chip and menu labels name the model generation. When the CLI's display name is generic ("Opus (1M context)", "Fable", "Sonnet", "Haiku"), the label is derived from the identifier: `claude-opus-5-5[1m]` is shown as **Opus 5.5 1M**, `claude-fable-5-1` as **Fable 5.1**, `claude-sonnet-4-6` as **Sonnet 4.6**, `claude-haiku-4-5` as **Haiku 4.5**. An identifier of another shape falls back to the CLI's display name, then to the identifier. The CLI's description is the row's hint; effort levels and fast-mode support come from the CLI row; identifiers ending in `[1m]` are marked as large context.

## Status line

The status line at the bottom of the model menu shows where the list comes from:

- **Installed Claude CLI** with the CLI version and the check time, when the list comes from a probe or a running conversation.
- **Website model catalog**, **Cached model catalog** or **Bundled model catalog** with the catalogue revision, as before, when no CLI list is available.
- **Update failed. The previous catalog is still available.** when the last probe or website check failed; the previous list stays in place.

## Failure modes

A missing binary, a timeout (the CLI process is killed when it expires), a non-zero exit, malformed output, a signed-out CLI or an empty list never block the UI: the chip falls back to the next source in the ranking above, the failure is shown in the status line, and the binary is left alone for the backoff period. Codex and the other agents keep their own catalogue mechanisms; this page concerns Claude only.

## Diagnostics

The client RPC `model_catalog_status` returns `source` (`cli`, `website`, `cache` or `bundled`), `cliVersion` (with `source: "cli"`), `revision`, `checkedAt`, `error` and `refreshing`; `model_catalog_refresh` triggers the refresh described above. The probe cache is the `model-catalog.claude.cli.v1` entry of `app_settings` in the app database, a map from binary hash to snapshot (`version`, `checkedAt`, `origin` `probe` or `live`, `models`).

## What the tests cover

The Rust tests in `src-tauri/src/agent/cli_model_catalog.rs`, `claude_models.rs`, `web/dispatch.rs` and `web/share_policy.rs` and the frontend tests `ModelCatalogStatus.test.tsx` and `ChatPane.settings.test.tsx` cover: parsing the recorded answer of Claude Code 2.1.280 including hook lines; the probe's command line through a logging fake binary (hooks, MCP servers and session persistence off, the private working directory and its owner-only permissions, no session identity in the environment); malformed output, a missing binary, a timeout with a fake binary and the other failure fallbacks; the backoff and Refresh ignoring it; single flight per binary; cache reuse for the same version and replacement after a version change; the unreadable version case; a running conversation's `list_models` answer replacing the cache and the `chat_models` result; the source ranking over the source combinations in the one function every consumer calls; alias resolution with and without CLI data, including rows without `resolvedModel` and retired full spellings; the wider accepted set for saved selections; an open pane re-reading the list on a catalogue change; the label formatter; the protected settings key; the cache-only answer on the public share surface; the status line texts and the named default hint.

Not covered by an automated test: the background check at app start, the failure path when the private working directory cannot be created, the live refresh of an open chat pane when another conversation updates the cache, and a probe against a real installed Claude Code (an ignored test, run by hand only). The probe duration of a few seconds is a measured observation, not a guarantee.
