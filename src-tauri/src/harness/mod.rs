//! Every agent CLI Noai can drive, behind one interface.
//!
//! To add an agent, write a module implementing [`Harness`] and list it in
//! [`ALL`]. Nothing outside this folder names a specific CLI: the engine,
//! scheduler, usage view, history import, digest and UI all read from here.

mod claude;
mod codex;
mod plugin_agent;

use crate::adapters::{JobPermissions, RunEvent, RunRequest};
use crate::local_metrics::FileState;
use crate::providers::{HarnessModel, ProviderUsageSnapshot};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
};

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// A permission mode a job may use with this agent.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct Permission {
    pub id: JobPermissions,
    pub label: &'static str,
    pub description: &'static str,
}

/// A folder of the agent's own session transcripts (`.jsonl`).
pub struct HistoryRoot {
    pub path: PathBuf,
    pub archived: bool,
}

/// Session facts an agent records in its transcript lines.
#[derive(Default)]
pub struct SessionMeta {
    pub session_id: Option<String>,
    pub project_path: Option<String>,
    pub model: Option<String>,
}

/// One readable transcript entry.
pub struct SessionMessage {
    pub role: String,
    pub text: String,
    pub activities: Vec<Value>,
}

/// Token counts of one model call. `input` excludes cache reads and writes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Tokens {
    pub input: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub output: u64,
}

impl Tokens {
    pub fn total(&self) -> u64 {
        self.input + self.cache_read + self.cache_write + self.output
    }
    /// Field-wise maximum: transcripts can repeat one call with growing counts.
    pub fn max(self, other: Tokens) -> Tokens {
        Tokens {
            input: self.input.max(other.input),
            cache_read: self.cache_read.max(other.cache_read),
            cache_write: self.cache_write.max(other.cache_write),
            output: self.output.max(other.output),
        }
    }
    pub fn add(self, other: Tokens) -> Tokens {
        Tokens {
            input: self.input + other.input,
            cache_read: self.cache_read + other.cache_read,
            cache_write: self.cache_write + other.cache_write,
            output: self.output + other.output,
        }
    }
}

/// Token use and context fill read from one transcript file.
#[derive(Default)]
pub struct SessionUsage {
    /// Calls keyed by the agent's own call id, so repeated lines count once.
    pub calls: HashMap<String, Tokens>,
    /// Tokens in the context window after the latest main-thread call.
    pub context_used: Option<u64>,
    pub context_window: Option<u64>,
}

impl SessionUsage {
    pub fn tokens(&self) -> Tokens {
        self.calls
            .values()
            .fold(Tokens::default(), |sum, call| sum.add(*call))
    }
}

pub trait Harness: Send + Sync {
    fn id(&self) -> &'static str;
    fn label(&self) -> &'static str;
    /// Command looked up on PATH, in common install folders and via the login shell.
    fn executable(&self) -> &'static str {
        self.id()
    }

    /// Modes a job may choose, the default first.
    fn permissions(&self) -> &'static [Permission];
    /// The most restrictive headless mode, used by read-only jobs like the digest.
    fn read_only(&self) -> JobPermissions;
    fn bypass_description(&self) -> &'static str;

    /// CLI arguments for a headless run; the prompt is written to stdin.
    fn args(&self, request: &RunRequest) -> Vec<String>;
    /// Normalizes one JSON line of the CLI's output.
    fn parse(&self, request: &RunRequest, value: &Value) -> Vec<RunEvent>;
    /// For CLIs that print plain text: handles a raw output line instead of
    /// JSON parsing. `None` (the default) means "parse it as JSON".
    fn parse_text(&self, _request: &RunRequest, _line: &str) -> Option<Vec<RunEvent>> {
        None
    }
    /// Whether "try again at 3:23 PM" (host local time) reset messages are trusted.
    fn local_clock_resets(&self) -> bool {
        false
    }

    /// Models the CLI itself reports. Never a hardcoded list.
    fn models(&self) -> BoxFuture<Vec<HarnessModel>>;
    /// Model IDs the user configured for this CLI (settings files, env vars),
    /// including custom or proxied ones the CLI doesn't list.
    /// A plain-English warning for a stderr line the user should act on even
    /// when the run succeeds, such as settings the CLI ignored.
    fn stderr_notice(&self, _request: &RunRequest, _line: &str) -> Option<String> {
        None
    }
    fn configured_models(&self, _home: &Path) -> Vec<String> {
        Vec::new()
    }
    fn usage(&self) -> BoxFuture<ProviderUsageSnapshot>;
    /// Stable signed-in account identity, never a credential.
    fn identity(&self) -> BoxFuture<Option<String>>;
    /// Latest reset of an exhausted usage window, when the CLI reports one.
    fn exhausted_reset(&self, _now: u64) -> BoxFuture<Option<u64>> {
        Box::pin(async { None })
    }

    fn history_roots(&self, _home: &Path) -> Vec<HistoryRoot> {
        Vec::new()
    }
    fn session_meta(&self, _line: &Value) -> SessionMeta {
        SessionMeta::default()
    }
    fn session_message(&self, _line: &Value) -> Option<SessionMessage> {
        None
    }
    /// Adds usage, tool and outcome rows from one transcript line to the metrics state.
    fn metrics_line(&self, _line: &Value, _state: &mut FileState) {}
    /// Adds one transcript line's token use and context fill to a session total.
    fn session_usage(&self, _line: &Value, _usage: &mut SessionUsage) {}
    /// The parent session's transcript when `path` is a subagent's transcript.
    fn subagent_parent(&self, _path: &Path) -> Option<PathBuf> {
        None
    }
    /// The subagent's type ("Explore", "web-fetch"…) when `path` is a subagent's
    /// transcript. Agents that mark subagents inside the transcript instead set
    /// `FileState::subagent` from `metrics_line`.
    fn subagent_type(&self, path: &Path) -> Option<String> {
        self.subagent_parent(path).map(|_| "subagent".into())
    }
}

static BUILT_IN: &[&dyn Harness] = &[&codex::Codex, &claude::Claude];

/// Agents added by enabled plugins. Each reload leaks the few small agent
/// descriptions it replaces, which only happens when plugins are switched.
static PLUGIN_AGENTS: std::sync::RwLock<Vec<&'static dyn Harness>> =
    std::sync::RwLock::new(Vec::new());
static PLUGINS_LOADED: std::sync::Once = std::sync::Once::new();

/// Re-reads plugin agents after plugins are turned on or off.
pub fn reload_plugins() {
    let agents: Vec<&'static dyn Harness> = crate::plugins::agents()
        .into_iter()
        .filter(|spec| !BUILT_IN.iter().any(|harness| harness.id() == spec.id))
        .map(|spec| {
            &*Box::leak(Box::new(plugin_agent::PluginAgent::new(spec))) as &'static dyn Harness
        })
        .collect();
    *PLUGIN_AGENTS.write().unwrap() = agents;
}

pub fn all() -> Vec<&'static dyn Harness> {
    PLUGINS_LOADED.call_once(reload_plugins);
    BUILT_IN
        .iter()
        .copied()
        .chain(PLUGIN_AGENTS.read().unwrap().iter().copied())
        .collect()
}

pub fn get(id: &str) -> Option<&'static dyn Harness> {
    all().into_iter().find(|harness| harness.id() == id)
}

pub fn require(id: &str) -> Result<&'static dyn Harness, String> {
    get(id).ok_or_else(|| format!("Unsupported harness: {id}"))
}

/// Field names of one CLI's token counters.
pub struct TokenKeys {
    pub input: &'static str,
    pub output: &'static str,
    pub cache_read: &'static str,
    pub cache_write: &'static str,
    /// Report input as fresh + cached + cache-written tokens.
    pub input_includes_cache: bool,
}

pub fn token_event(
    request: &RunRequest,
    counts: &Value,
    keys: &TokenKeys,
    cumulative: bool,
    per_model: bool,
) -> Option<RunEvent> {
    let input = counts.get(keys.input)?.as_u64()?;
    let output = counts.get(keys.output)?.as_u64()?;
    let cached = counts
        .get(keys.cache_read)
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let written = counts
        .get(keys.cache_write)
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let input = if keys.input_includes_cache {
        input.saturating_add(cached).saturating_add(written)
    } else {
        input
    };
    let mut event = RunEvent::new(request, "usage", None);
    event.usage = Some(json!({
        "kind": "tokens",
        "inputTokens": input,
        "outputTokens": output,
        "cacheReadTokens": cached,
        "scope": if cumulative { "session" } else { "turn" },
        "perModel": per_model,
        "resumed": request.resume_id.is_some(),
    }));
    Some(event)
}

/// Readable text of a transcript content value (string or content blocks).
pub fn content_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.into();
    }
    value
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| {
                    block["text"].as_str().map(str::to_owned).or_else(|| {
                        match block["type"].as_str() {
                            Some("tool_use") => Some(format!(
                                "{}\n{}",
                                block["name"].as_str().unwrap_or("Tool"),
                                block["input"]
                            )),
                            Some("tool_result") => Some(content_text(&block["content"])),
                            _ => None,
                        }
                    })
                })
                .collect::<Vec<_>>()
                .join("\n\n")
        })
        .unwrap_or_default()
}

/// An agent's config folder: `$<ENV>` when set, else `~/<fallback>`.
pub fn config_dir(home: &Path, env: &str, fallback: &str) -> PathBuf {
    std::env::var_os(env)
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(fallback))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_ids_are_unique_and_every_agent_is_complete() {
        let mut ids: Vec<_> = all().iter().map(|harness| harness.id()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), all().len());
        for harness in all() {
            assert!(!harness.label().is_empty());
            assert!(!harness.permissions().is_empty(), "{}", harness.id());
            assert!(harness
                .permissions()
                .iter()
                .any(|mode| mode.id == harness.read_only()));
            assert_eq!(
                get(harness.id()).map(|found| found.id()),
                Some(harness.id())
            );
        }
        assert!(get("not-an-agent").is_none());
    }
}
