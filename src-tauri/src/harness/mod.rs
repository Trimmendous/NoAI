//! Every agent CLI Noai can drive, behind one interface.
//!
//! To add an agent, write a module implementing [`Harness`] and list it in
//! [`ALL`]. Nothing outside this folder names a specific CLI: the engine,
//! scheduler, usage view, history import, digest and UI all read from here.

mod claude;
mod codex;

use crate::adapters::{JobPermissions, RunEvent, RunRequest};
use crate::local_metrics::FileState;
use crate::providers::{HarnessModel, ProviderUsageSnapshot};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
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
    /// Whether "try again at 3:23 PM" (host local time) reset messages are trusted.
    fn local_clock_resets(&self) -> bool {
        false
    }

    fn models(&self) -> BoxFuture<Vec<HarnessModel>>;
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
    /// Adds usage and tool rows from one transcript line to the metrics state.
    fn metrics_line(&self, _line: &Value, _state: &mut FileState) {}
}

static ALL: &[&dyn Harness] = &[&codex::Codex, &claude::Claude];

pub fn all() -> &'static [&'static dyn Harness] {
    ALL
}

pub fn get(id: &str) -> Option<&'static dyn Harness> {
    ALL.iter().copied().find(|harness| harness.id() == id)
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
    let cached = counts.get(keys.cache_read).and_then(Value::as_u64).unwrap_or(0);
    let written = counts.get(keys.cache_write).and_then(Value::as_u64).unwrap_or(0);
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
            assert_eq!(get(harness.id()).map(|found| found.id()), Some(harness.id()));
        }
        assert!(get("not-an-agent").is_none());
    }
}
