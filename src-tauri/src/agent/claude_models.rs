//! The model catalogue offered to a Claude chat session.
//!
//! The installed Claude CLI is the primary source: `cli_model_catalog` asks it for its models over the
//! stream-json control protocol and caches the answer per binary and version, and a running conversation's
//! own `list_models` answer refreshes that cache. When a CLI list is available it IS the list: a model the
//! user's Claude Code does not offer is not offered here either. Without CLI data the website catalogue
//! serves, and without that the versioned table below. Custom identifiers the user configured under `env`
//! in `settings.json` are appended in every case; that covers a gateway identifier pointing at something
//! other than Anthropic's own models.
//!
//! Two details survive from the curated table. First, a `[1m]` suffix is a model identifier in its own
//! right when a family offers both standard and expanded contexts: passing `claude-opus-4-6[1m]` asks for
//! the 1M-token window, so it stays separate from `claude-opus-4-6`. Asking for that expanded window can
//! cost usage credits the account does not have, and the refusal is easy to miss: the CLI answers the turn
//! with an ordinary assistant message carrying `API Error: Usage credits required for 1M context`.
//! Second, newer models are rejected by older CLIs, so table entries carry the version that introduced
//! them and are filtered accordingly.
//!
//! Everything here reads files and spawns `claude --version` or the probe, so callers must stay off the
//! main thread; dispatch already runs this inside a blocking worker.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use super::cli_model_catalog::{self, CliModel, Probe};
use crate::host::AppCtx;

/// How long `claude --version` may run before the catalogue gives up and lists everything.
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

/// Effort levels a model accepts. The newer families add `xhigh` between `high` and `max`.
const EFFORT_STANDARD: &[&str] = &["low", "medium", "high", "max"];
const EFFORT_XHIGH: &[&str] = &["low", "medium", "high", "xhigh", "max"];

/// Settings keys under `env` that name a model. Claude Code reads each of these, so a model named in
/// any of them is one the user actually reaches.
const SETTINGS_ENV_KEYS: &[&str] = &[
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
];

/// Short names and retired spellings paired with the identifier Claude reports for them. An alias
/// and its canonical spelling are the same model, so resolving one to the other keeps the menu from
/// listing both and lets old saved preferences continue to work.
///
/// This table is the fallback: with CLI data present, `normalize_id` follows the CLI's own
/// `value -> resolvedModel` pairs and consults this table only when its target is a model the CLI
/// offers. The right-hand side tracks what an alias resolved to when the table was last updated.
const ALIASES: &[(&str, &str)] = &[
    ("opus", "claude-opus-5"),
    ("opus[1m]", "claude-opus-5"),
    ("claude-opus-5[1m]", "claude-opus-5"),
    ("claude-fable-5[1m]", "claude-fable-5"),
    ("claude-fable-5-1[1m]", "claude-fable-5-1"),
    ("sonnet", "claude-sonnet-5"),
    ("sonnet[1m]", "claude-sonnet-5[1m]"),
    ("haiku", "claude-haiku-4-5"),
];

/// One curated entry, before the installed CLI version is taken into account.
struct Entry {
    id: &'static str,
    label: &'static str,
    description: &'static str,
    context_window: u64,
    effort: &'static [&'static str],
    /// CLI version that first accepted this identifier, or None when every supported version does.
    min_version: Option<(u32, u32, u32)>,
}

impl Entry {
    /// Whether this entry is an explicit request for the 1M context window.
    ///
    /// The `[1m]` suffix is what distinguishes an expanded-context variant, not the window size. Native
    /// 1M models have no suffixed selectable entry; only a suffix on a standard-context model asks for
    /// a different window that can be refused for want of credits.
    fn wants_large_context(&self) -> bool {
        self.id.ends_with("[1m]")
    }
}

/// One model as the composer's model chip shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeModel {
    /// Passed verbatim as the `--model` value and in `set_model` requests.
    pub id: String,
    /// Chip and menu text.
    pub label: String,
    /// Dimmed line beside the label, saying what the model is for or where it came from.
    pub description: String,
    /// Effort levels the effort chip should offer while this model is selected; empty when unknown.
    pub effort_levels: Vec<String>,
    /// Context window in tokens, or None for a configured model whose size is not known here.
    pub context_window: Option<u64>,
    /// False for an entry read from settings, which the curated descriptions do not cover.
    pub curated: bool,
    /// True for an entry whose id asks for the 1M window with `[1m]`, which some accounts must buy
    /// usage credits to run.
    pub large_context: bool,
    /// True when the running agent said this model honours fast mode. Never set for the curated table,
    /// which does not know.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub supports_fast_mode: bool,
    /// True for the model the CLI's `default` row currently resolves to, so the chip can name the default.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub is_default: bool,
}

/// The catalogue for a running conversation: the process's own `list_models` answer is the list.
///
/// The `default` row is not listed; the model it resolves to is marked instead. Disabled rows are
/// excluded. Without a usable row the fallbacks apply as for any other consumer.
pub fn from_live(models: &[Value]) -> Vec<ClaudeModel> {
    let rows = cli_model_catalog::parse_rows(models);
    assemble(Some(&rows), None)
}

/// The curated table, in the order the menu shows it: newest first, each family's 1M variant beside it.
const MANIFEST: &[Entry] = &[
    Entry {
        id: "claude-opus-5",
        label: "Opus 5",
        description: "Opus 5 · Latest release",
        context_window: 1_000_000,
        effort: EFFORT_XHIGH,
        min_version: Some((2, 1, 219)),
    },
    Entry {
        id: "claude-fable-5-1",
        label: "Fable 5.1",
        description: "Fable 5.1 · Most powerful model",
        context_window: 1_000_000,
        effort: EFFORT_XHIGH,
        min_version: None,
    },
    Entry {
        id: "claude-fable-5",
        label: "Fable 5",
        description: "Fable 5 · Previous release",
        context_window: 1_000_000,
        effort: EFFORT_XHIGH,
        min_version: Some((2, 1, 169)),
    },
    Entry {
        id: "claude-opus-4-8[1m]",
        label: "Opus 4.8 1M",
        description: "Opus 4.8 with 1M context window",
        context_window: 1_000_000,
        effort: EFFORT_XHIGH,
        min_version: None,
    },
    Entry {
        id: "claude-opus-4-8",
        label: "Opus 4.8",
        description: "Opus 4.8 · Previous release",
        context_window: 200_000,
        effort: EFFORT_XHIGH,
        min_version: None,
    },
    Entry {
        id: "claude-sonnet-5",
        label: "Sonnet 5",
        description: "Sonnet 5 · Best for everyday tasks",
        context_window: 200_000,
        effort: EFFORT_XHIGH,
        min_version: None,
    },
    Entry {
        id: "claude-sonnet-5[1m]",
        label: "Sonnet 5 1M",
        description: "Sonnet 5 with 1M context window",
        context_window: 1_000_000,
        effort: EFFORT_XHIGH,
        min_version: None,
    },
    Entry {
        id: "claude-opus-4-7[1m]",
        label: "Opus 4.7 1M",
        description: "Opus 4.7 with 1M context window",
        context_window: 1_000_000,
        effort: EFFORT_XHIGH,
        min_version: None,
    },
    Entry {
        id: "claude-opus-4-7",
        label: "Opus 4.7",
        description: "Opus 4.7 · Previous release",
        context_window: 200_000,
        effort: EFFORT_XHIGH,
        min_version: None,
    },
    Entry {
        id: "claude-opus-4-6[1m]",
        label: "Opus 4.6 1M",
        description: "Opus 4.6 with 1M context window",
        context_window: 1_000_000,
        effort: EFFORT_STANDARD,
        min_version: None,
    },
    Entry {
        id: "claude-opus-4-6",
        label: "Opus 4.6",
        description: "Opus 4.6 · Most capable for complex work",
        context_window: 200_000,
        effort: EFFORT_STANDARD,
        min_version: None,
    },
    Entry {
        id: "claude-sonnet-4-6[1m]",
        label: "Sonnet 4.6 1M",
        description: "Sonnet 4.6 with 1M context window",
        context_window: 1_000_000,
        effort: EFFORT_STANDARD,
        min_version: None,
    },
    Entry {
        id: "claude-sonnet-4-6",
        label: "Sonnet 4.6",
        description: "Sonnet 4.6 · Best for everyday tasks",
        context_window: 200_000,
        effort: EFFORT_STANDARD,
        min_version: None,
    },
    Entry {
        id: "claude-haiku-4-5",
        label: "Haiku 4.5",
        description: "Haiku 4.5 · Fastest for quick answers",
        context_window: 200_000,
        effort: EFFORT_STANDARD,
        min_version: None,
    },
];

/// Catalogue for one Claude executable, probing it when the cache is missing or stale.
///
/// A failure to probe, read the version or the settings file is not an error: the catalogue degrades to
/// the website catalogue or the curated table, which is still usable, rather than leaving the chip empty.
pub fn list_for_bin(app: &AppCtx, bin: &str) -> Vec<ClaudeModel> {
    list_for_bin_with(app, bin, Probe::Allow)
}

/// What a stored selection may name: the offered catalogue plus the curated table. The CLI's list is a
/// shortlist of what it offers, not everything it accepts, so a job saved with an identifier the menu no
/// longer offers (for example `claude-opus-5` once Opus 5.5 became the default) keeps validating instead of
/// failing its retry. Offering stays narrow; only acceptance widens.
pub fn accepted_for_bin(app: &AppCtx, bin: &str) -> Vec<ClaudeModel> {
    with_curated(list_for_bin(app, bin))
}

fn with_curated(mut offered: Vec<ClaudeModel>) -> Vec<ClaudeModel> {
    for entry in bundled(None) {
        if !offered.iter().any(|m| m.id == entry.id) {
            offered.push(entry);
        }
    }
    offered
}

/// Catalogue for one executable with an explicit probing policy; `CacheOnly` never spawns anything.
pub fn list_for_bin_with(app: &AppCtx, bin: &str, probe: Probe) -> Vec<ClaudeModel> {
    let snapshot = cli_model_catalog::ensure(app, bin, probe);
    // The version filter for the bundled table: what this run read, else what the snapshot recorded.
    let version = cli_model_catalog::cached_version(bin)
        .or_else(|| snapshot.as_ref().and_then(|s| s.version.clone()))
        .and_then(|v| parse_version(&v));
    assemble(snapshot.as_ref().map(|s| s.models.as_slice()), version)
}

/// The one place the sources are ranked: CLI list (live or cached probe) > website catalogue > bundled
/// table, then the identifiers from `settings.json`.
fn assemble(cli: Option<&[CliModel]>, version: Option<(u32, u32, u32)>) -> Vec<ClaudeModel> {
    assemble_with(
        cli,
        version,
        super::remote_model_catalog::models(version),
        &settings_models(),
        &cli_model_catalog::alias_pairs(),
    )
}

fn assemble_with(
    cli: Option<&[CliModel]>,
    version: Option<(u32, u32, u32)>,
    website: Option<Vec<ClaudeModel>>,
    settings: &[(String, String)],
    pairs: &[(String, String)],
) -> Vec<ClaudeModel> {
    let mut out = cli
        .map(cli_models)
        .filter(|models| !models.is_empty())
        .or(website)
        .unwrap_or_else(|| bundled(version));
    for (id, origin) in settings {
        let id = normalize_with(id, pairs);
        if out.iter().any(|m| m.id == id) {
            continue;
        }
        out.push(ClaudeModel {
            label: id.clone(),
            id,
            description: format!("From Claude settings.json {origin}"),
            // A configured identifier may be a gateway model with its own effort rules, so offer the
            // set every Claude model has rather than guessing at the newer levels.
            effort_levels: EFFORT_STANDARD.iter().map(|s| s.to_string()).collect(),
            context_window: None,
            curated: false,
            // A configured identifier may or may not ask for the large window; nothing here can tell.
            large_context: false,
            supports_fast_mode: false,
            is_default: false,
        });
    }
    out
}

/// The bundled table, filtered to what the installed version accepts.
fn bundled(version: Option<(u32, u32, u32)>) -> Vec<ClaudeModel> {
    MANIFEST
        .iter()
        .filter(|e| accepts(e, version))
        .map(|e| ClaudeModel {
            id: e.id.to_string(),
            label: e.label.to_string(),
            description: e.description.to_string(),
            effort_levels: e.effort.iter().map(|s| s.to_string()).collect(),
            context_window: Some(e.context_window),
            curated: true,
            large_context: e.wants_large_context(),
            supports_fast_mode: false,
            is_default: false,
        })
        .collect()
}

/// Menu rows from the CLI's own list. Rows are keyed by what they resolve to, so `opus[1m]` and
/// `default`, which both resolve to the same identifier, become one row named after that identifier,
/// which is also what the CLI reports back in `system/init`, so the chip finds the row without any
/// further mapping. The `default` row itself is not listed; its target is marked `is_default`, and
/// created from the default row when no other row offers it.
fn cli_models(rows: &[CliModel]) -> Vec<ClaudeModel> {
    let target = |row: &CliModel| row.resolved_model.clone().unwrap_or_else(|| row.value.clone());
    let refused: Vec<String> = rows.iter().filter(|r| r.disabled).map(target).collect();
    let default_row = rows.iter().find(|r| r.value == "default" && !r.disabled);
    let default_id = default_row.map(target).filter(|id| id != "default" && !refused.contains(id));
    let mut out: Vec<ClaudeModel> = Vec::new();
    for row in rows.iter().filter(|r| !r.disabled && r.value != "default") {
        let id = target(row);
        if refused.contains(&id) || out.iter().any(|m| m.id == id) {
            continue;
        }
        out.push(cli_model(&id, row, default_id.as_deref() == Some(id.as_str())));
    }
    if let (Some(id), Some(row)) = (&default_id, default_row) {
        if !out.iter().any(|m| &m.id == id) {
            out.insert(0, cli_model(id, row, true));
        }
    }
    out
}

fn cli_model(id: &str, row: &CliModel, is_default: bool) -> ClaudeModel {
    let known = MANIFEST.iter().find(|e| e.id == id);
    let effort_levels = if !row.supported_effort_levels.is_empty() {
        row.supported_effort_levels.clone()
    } else {
        known.map(|e| e.effort).unwrap_or(EFFORT_STANDARD).iter().map(|s| s.to_string()).collect()
    };
    let description = if row.description.trim().is_empty() {
        known.map(|e| e.description.to_string()).unwrap_or_default()
    } else {
        row.description.clone()
    };
    let large_context = id.ends_with("[1m]");
    ClaudeModel {
        id: id.to_string(),
        label: label_for(id, &row.display_name),
        description,
        effort_levels,
        context_window: known.map(|e| e.context_window).or(large_context.then_some(1_000_000)),
        curated: true,
        large_context,
        supports_fast_mode: row.supports_fast_mode,
        is_default,
    }
}

/// Chip and menu text for a CLI row. The CLI's display names are generic ("Opus (1M context)", "Fable"),
/// so when the identifier tells the generation the label is derived from it; a display name that
/// already names a version is kept.
pub fn label_for(id: &str, display_name: &str) -> String {
    let display_name = display_name.trim();
    let mut depth = 0usize;
    let outside_parens: String = display_name
        .chars()
        .filter(|c| {
            match c {
                '(' => depth += 1,
                ')' => depth = depth.saturating_sub(1),
                _ => {}
            }
            depth == 0 && *c != ')'
        })
        .collect();
    let generic = !outside_parens.chars().any(|c| c.is_ascii_digit());
    match (family_label(id), generic) {
        (Some(label), true) => label,
        (Some(_), false) => {
            if id.ends_with("[1m]") && !display_name.to_ascii_lowercase().contains("1m") {
                format!("{display_name} 1M")
            } else {
                display_name.to_string()
            }
        }
        (None, _) if !display_name.is_empty() => display_name.to_string(),
        (None, _) => id.to_string(),
    }
}

/// "Opus 5.5 1M" for `claude-opus-5-5[1m]`, "Fable 5.1" for `claude-fable-5-1`; None for any other shape.
fn family_label(id: &str) -> Option<String> {
    let (base, large) = match id.strip_suffix("[1m]") {
        Some(base) => (base, true),
        None => (id, false),
    };
    let rest = base.strip_prefix("claude-")?;
    let mut segments = rest.split('-');
    let family = segments.next().filter(|f| !f.is_empty() && f.chars().all(|c| c.is_ascii_alphabetic()))?;
    let version: Vec<&str> = segments.collect();
    if version.is_empty() || version.len() > 2 || version.iter().any(|v| v.is_empty() || !v.chars().all(|c| c.is_ascii_digit())) {
        return None;
    }
    let mut chars = family.chars();
    let family = chars.next().map(|c| c.to_ascii_uppercase().to_string() + chars.as_str()).unwrap_or_default();
    let mut label = format!("{family} {}", version.join("."));
    if large {
        label.push_str(" 1M");
    }
    Some(label)
}

/// Resolve a short or retired alias to the identifier the CLI reports, leaving every other name untouched.
///
/// The one chokepoint for the chat engine's launch, `set_model` and `system/init` paths. With CLI data the
/// CLI's own pairs decide; without it the static table does.
pub(crate) fn normalize_id(id: &str) -> String {
    normalize_with(id, &cli_model_catalog::alias_pairs())
}

/// `normalize_id` over explicit `(value, resolvedModel)` pairs.
///
/// With pairs: an identifier the CLI offers is never rewritten; a value the CLI knows becomes what it
/// resolves to; a retired full spelling from the static table (`claude-opus-5[1m]` for the natively 1M
/// Opus 5) keeps the rewrite the table always applied, because its target is a real model id the CLI
/// accepts even when its shortlist no longer names it, while the suffixed spelling may be refused or ask
/// for usage credits; a short name such as `opus` is left to the CLI, which resolves it to its current
/// generation and reports the result in `system/init`. Without pairs the static table applies as it
/// always did.
fn normalize_with(id: &str, pairs: &[(String, String)]) -> String {
    let static_target = ALIASES.iter().find(|(alias, _)| *alias == id).map(|(_, full)| *full);
    if pairs.is_empty() {
        return static_target.unwrap_or(id).to_string();
    }
    if pairs.iter().any(|(_, resolved)| resolved == id) {
        return id.to_string();
    }
    if let Some((_, resolved)) = pairs.iter().find(|(value, _)| value == id) {
        return resolved.clone();
    }
    match static_target {
        Some(target) if pairs.iter().any(|(_, resolved)| resolved == target) => target.to_string(),
        Some(target) if id.starts_with("claude-") => target.to_string(),
        _ => id.to_string(),
    }
}

/// Whether an entry is old enough for the installed CLI. An unknown version lists everything, on the
/// grounds that hiding a model the user has is worse than offering one they do not.
fn accepts(entry: &Entry, version: Option<(u32, u32, u32)>) -> bool {
    match (entry.min_version, version) {
        (Some(min), Some(have)) => have >= min,
        _ => true,
    }
}

/// Run `claude --version` and return the `major.minor.patch` it prints, or None when it does not answer
/// with a version within VERSION_TIMEOUT.
pub(crate) fn read_version_for_bin(bin: &str) -> Option<String> {
    let mut cmd = crate::host::command(bin);
    cmd.arg("--version");
    cmd.env("NO_COLOR", "1");
    let text = capture(cmd)?;
    parse_version(&text).map(|(a, b, c)| format!("{a}.{b}.{c}"))
}

/// Read a short command's stdout, killing it once VERSION_TIMEOUT elapses.
fn capture(mut cmd: Command) -> Option<String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().ok()?;
    let out = child.stdout.take();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(mut o) = out {
            use std::io::Read;
            let _ = o.read_to_string(&mut buf);
        }
        let _ = tx.send(buf);
    });
    let text = rx.recv_timeout(VERSION_TIMEOUT).ok();
    if text.is_none() {
        let _ = child.kill();
    }
    let _ = child.wait();
    text
}

/// Pull `2.1.252` out of `2.1.252 (Claude Code)`, or out of any line that starts with three numbers.
fn parse_version(text: &str) -> Option<(u32, u32, u32)> {
    for token in text.split(|c: char| c.is_whitespace() || c == '(' || c == ')') {
        let mut parts = token.split('.');
        let (a, b, c) = (parts.next()?, parts.next(), parts.next());
        let (Some(b), Some(c)) = (b, c) else { continue };
        if parts.next().is_some() {
            continue;
        }
        if let (Ok(a), Ok(b), Ok(c)) = (a.parse(), b.parse(), c.parse()) {
            return Some((a, b, c));
        }
    }
    None
}

/// Models named under `env` in `settings.json`, each paired with the key it came from.
///
/// The top-level `model` key is deliberately skipped. It records which model is currently selected,
/// not a model the user defined, and Claude Code rewrites it on every `/model` switch, so reading it
/// would append a duplicate of a curated entry under whatever alias happened to be stored.
///
/// Only the user-level file is read. A project-level `.claude/settings.json` is scoped to one
/// directory, and a session's model chip is not, so listing those would offer models that do not
/// apply where the session actually runs.
fn settings_models() -> Vec<(String, String)> {
    let Some(root) = config_dir() else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(root.join("settings.json")) else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    let mut out: Vec<(String, String)> = Vec::new();
    let mut push = |value: Option<&Value>, origin: &str| {
        if let Some(id) = value.and_then(Value::as_str) {
            let id = id.trim();
            if !id.is_empty() && !out.iter().any(|(seen, _)| seen == id) {
                out.push((id.to_string(), origin.to_string()));
            }
        }
    };
    for key in SETTINGS_ENV_KEYS {
        push(json.get("env").and_then(|e| e.get(key)), &format!("env.{key}"));
    }
    out
}

/// Claude's configuration directory: `CLAUDE_CONFIG_DIR` when set, otherwise `~/.claude`.
fn config_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        return Some(PathBuf::from(dir));
    }
    crate::host::home_dir().map(|h| h.join(".claude"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cli_model_catalog::testing::fixture_models;

    fn fixture_rows() -> Vec<CliModel> {
        cli_model_catalog::parse_rows(&fixture_models())
    }

    fn website(id: &str) -> Vec<ClaudeModel> {
        vec![ClaudeModel {
            id: id.into(),
            label: "Website".into(),
            description: String::new(),
            effort_levels: vec![],
            context_window: None,
            curated: true,
            large_context: false,
            supports_fast_mode: false,
            is_default: false,
        }]
    }

    /// AC3, table-driven: the same ranking for every consumer, settings identifiers appended in every case.
    #[test]
    fn precedence_table() {
        let rows = fixture_rows();
        let empty: Vec<CliModel> = vec![];
        let disabled_only = vec![CliModel { value: "claude-opus-5".into(), disabled: true, ..Default::default() }];
        let settings = vec![("my-gateway/opus".to_string(), "env.ANTHROPIC_MODEL".to_string())];
        let cases: Vec<(Option<&[CliModel]>, Option<Vec<ClaudeModel>>, &str, &str)> = vec![
            (Some(&rows), Some(website("test-website-model")), "claude-opus-5-5[1m]", "cli beats website"),
            (Some(&rows), None, "claude-opus-5-5[1m]", "cli beats bundled"),
            (Some(&empty), Some(website("test-website-model")), "test-website-model", "empty cli falls to website"),
            (Some(&disabled_only), None, MANIFEST[0].id, "disabled-only cli falls to bundled"),
            (None, Some(website("test-website-model")), "test-website-model", "website beats bundled"),
            (None, None, MANIFEST[0].id, "bundled last"),
        ];
        for (cli, site, first, why) in cases {
            let models = assemble_with(cli, None, site, &settings, &[]);
            assert_eq!(models[0].id, first, "{why}");
            assert_eq!(models.iter().filter(|m| m.id == "my-gateway/opus").count(), 1, "{why}: settings appended once");
            assert!(!models.iter().any(|m| m.id == "default"), "{why}");
        }
        // The CLI list is the list: nothing from the table is merged underneath it.
        let models = assemble_with(Some(&rows), None, None, &[], &[]);
        assert_eq!(models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["claude-opus-5-5[1m]", "claude-fable-5-1"]);
        assert!(!models.iter().any(|m| m.id == "claude-opus-4-6"));
        let opus = &models[0];
        assert!(opus.is_default, "the default row marks its target");
        assert!(opus.large_context);
        assert_eq!(opus.context_window, Some(1_000_000));
        assert!(opus.supports_fast_mode);
        assert_eq!(opus.effort_levels, ["low", "medium", "high", "xhigh", "max"]);
        assert_eq!(opus.description, "Opus 5.5 with 1M context · Best for everyday, complex tasks");
        assert!(!models[1].is_default);
        assert!(!models[1].supports_fast_mode);
        // A settings identifier already offered by the CLI is not duplicated.
        let settings = vec![("claude-fable-5-1".to_string(), "env.ANTHROPIC_MODEL".to_string())];
        assert_eq!(assemble_with(Some(&rows), None, None, &settings, &[]).len(), 2);
        // A disabled row removes its model even when another row resolves to it.
        let mut rows = fixture_rows();
        rows.push(CliModel { value: "fable".into(), resolved_model: Some("claude-fable-5-1".into()), disabled: true, ..Default::default() });
        assert!(!assemble_with(Some(&rows), None, None, &[], &[]).iter().any(|m| m.id == "claude-fable-5-1"));
        // A default resolving to a model no other row offers is listed once, as the default.
        let rows = vec![CliModel { value: "default".into(), resolved_model: Some("claude-sonnet-4-6".into()), display_name: "Default (recommended)".into(), description: "Sonnet".into(), ..Default::default() }];
        let models = assemble_with(Some(&rows), None, None, &[], &[]);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "claude-sonnet-4-6");
        assert_eq!(models[0].label, "Sonnet 4.6");
        assert!(models[0].is_default);
        // The live path is the same assembly.
        let live = from_live(&fixture_models());
        assert_eq!(live.iter().filter(|m| m.curated).map(|m| m.id.as_str()).collect::<Vec<_>>(), ["claude-opus-5-5[1m]", "claude-fable-5-1"]);
    }

    /// The wiring behind `assemble_with`: the website module is consulted when no CLI list exists.
    #[test]
    fn website_catalogue_is_the_fallback_without_cli_data() {
        let _serial = cli_model_catalog::TEST_LOCK.lock().unwrap();
        let catalog = serde_json::json!({"schemaVersion": 1, "revision": 7, "models": [{
            "id": "test-website-model", "label": "Website model", "description": "From the website",
            "contextWindow": 200000, "effortLevels": ["low", "high"]
        }]});
        super::super::remote_model_catalog::set_for_tests(Some(&serde_json::to_vec(&catalog).unwrap()));
        let models = assemble(None, None);
        assert_eq!(models[0].id, "test-website-model");
        let with_cli = assemble(Some(&fixture_rows()), None);
        assert_eq!(with_cli[0].id, "claude-opus-5-5[1m]");
        assert!(!with_cli.iter().any(|m| m.id == "test-website-model"));
        super::super::remote_model_catalog::set_for_tests(None);
        assert_eq!(assemble(None, None)[0].id, MANIFEST[0].id);
    }

    /// AC4: the CLI's own pairs decide before the static table.
    #[test]
    fn normalize_id_prefers_cli_pairs() {
        let pairs: Vec<(String, String)> = fixture_rows()
            .iter()
            .filter(|r| r.value != "default")
            .map(|r| (r.value.clone(), r.resolved_model.clone().unwrap()))
            .collect();
        assert_eq!(normalize_with("opus[1m]", &pairs), "claude-opus-5-5[1m]");
        assert_eq!(normalize_with("claude-opus-5-5[1m]", &pairs), "claude-opus-5-5[1m]");
        assert_eq!(normalize_with("claude-fable-5-1", &pairs), "claude-fable-5-1");
        // The static table would pin the previous generation; the CLI resolves its own short names.
        assert_eq!(normalize_with("opus", &pairs), "opus");
        // A retired full spelling keeps the table's rewrite even when the CLI's shortlist no longer names
        // the target: claude-opus-5 is a model id the CLI accepts, the suffixed spelling may be refused.
        assert_eq!(normalize_with("claude-opus-5[1m]", &pairs), "claude-opus-5");
        // A row without resolvedModel still counts as CLI data and is never rewritten by the table.
        assert_eq!(normalize_with("opus", &[("opus".to_string(), "opus".to_string())]), "opus");
        let mut with_opus_5 = pairs.clone();
        with_opus_5.push(("claude-opus-5".into(), "claude-opus-5".into()));
        assert_eq!(normalize_with("claude-opus-5[1m]", &with_opus_5), "claude-opus-5");
        assert_eq!(normalize_with("my-gateway/opus", &pairs), "my-gateway/opus");
        // Without CLI data the static table applies as before.
        assert_eq!(normalize_with("opus", &[]), "claude-opus-5");
        assert_eq!(normalize_with("claude-opus-5[1m]", &[]), "claude-opus-5");
        assert_eq!(normalize_with("my-gateway/opus", &[]), "my-gateway/opus");
    }

    /// Acceptance is wider than the offer: a selection saved before the CLI's shortlist changed still
    /// validates, and nothing the CLI offers is duplicated.
    #[test]
    fn accepted_selection_includes_the_curated_table() {
        let offered = cli_models(&fixture_rows());
        let accepted = with_curated(offered.clone());
        assert!(!offered.iter().any(|m| m.id == "claude-opus-5"));
        assert!(accepted.iter().any(|m| m.id == "claude-opus-5"));
        assert!(accepted.iter().any(|m| m.id == "claude-opus-5-5[1m]"));
        let mut ids: Vec<&str> = accepted.iter().map(|m| m.id.as_str()).collect();
        let before = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), before, "no identifier appears twice");
    }

    /// AC5
    #[test]
    fn label_formatter() {
        assert_eq!(label_for("claude-opus-5-5[1m]", "Opus (1M context)"), "Opus 5.5 1M");
        assert_eq!(label_for("claude-fable-5-1", "Fable"), "Fable 5.1");
        assert_eq!(label_for("claude-sonnet-4-6", "Sonnet"), "Sonnet 4.6");
        assert_eq!(label_for("claude-haiku-4-5", "Haiku"), "Haiku 4.5");
        assert_eq!(label_for("claude-opus-5-5[1m]", "Default (recommended)"), "Opus 5.5 1M");
        assert_eq!(label_for("claude-opus-5", ""), "Opus 5");
        // A display name that names the generation is kept, with the window added when the id asks for it.
        assert_eq!(label_for("claude-opus-4-6", "Opus 4.6"), "Opus 4.6");
        assert_eq!(label_for("claude-opus-4-6[1m]", "Opus 4.6"), "Opus 4.6 1M");
        assert_eq!(label_for("claude-opus-4-6[1m]", "Opus 4.6 (1M)"), "Opus 4.6 (1M)");
        // Unknown shapes fall back to the display name, then the id.
        assert_eq!(label_for("claude-opus-4-8-20260101", "Opus"), "Opus");
        assert_eq!(label_for("my-gateway/opus", "Gateway Opus"), "Gateway Opus");
        assert_eq!(label_for("my-gateway/opus", ""), "my-gateway/opus");
        assert_eq!(label_for("claude-opus-4-6", "Opus (1M context)"), "Opus 4.6");
    }

    #[test]
    fn parses_the_version_line_claude_prints() {
        assert_eq!(parse_version("2.1.252 (Claude Code)"), Some((2, 1, 252)));
        assert_eq!(parse_version("nothing here"), None);
    }

    #[test]
    fn hides_entries_the_installed_cli_predates() {
        let opus5 = &MANIFEST[0];
        assert!(!accepts(opus5, Some((2, 1, 200))));
        assert!(accepts(opus5, Some((2, 1, 219))));
        // An unknown version must not hide anything.
        assert!(accepts(opus5, None));
        assert!(!bundled(Some((2, 1, 200))).iter().any(|m| m.id == "claude-opus-5"));
    }

    #[test]
    fn keeps_large_context_variants_beside_their_standard_model() {
        let models = assemble_with(None, None, None, &[], &[]);
        let expanded = models
            .iter()
            .position(|m| m.id == "claude-opus-4-8[1m]")
            .unwrap();
        let standard = models
            .iter()
            .position(|m| m.id == "claude-opus-4-8")
            .unwrap();
        assert_eq!(expanded + 1, standard);
    }

    #[test]
    fn resolves_short_and_retired_aliases_to_curated_identifiers() {
        let ids: Vec<&str> = MANIFEST.iter().map(|e| e.id).collect();
        for (alias, full) in ALIASES {
            assert_eq!(normalize_with(alias, &[]), *full);
            assert!(
                ids.contains(full),
                "{full} is aliased but missing from the manifest"
            );
        }
    }

    #[test]
    fn offers_one_native_one_million_opus_5_entry() {
        let opus5: Vec<&str> = MANIFEST
            .iter()
            .filter(|entry| normalize_with(entry.id, &[]) == "claude-opus-5")
            .map(|entry| entry.id)
            .collect();
        assert_eq!(opus5, vec!["claude-opus-5"]);
    }

    #[test]
    fn keeps_the_one_million_variants_as_separate_ids() {
        let ids: Vec<&str> = MANIFEST.iter().map(|e| e.id).collect();
        assert!(ids.contains(&"claude-opus-4-6"));
        assert!(ids.contains(&"claude-opus-4-6[1m]"));
    }
}
