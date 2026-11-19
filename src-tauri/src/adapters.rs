use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    env, fs,
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant},
};
use tokio::process::{Child, Command};

/// Explicit per-job permissions. None preserves legacy/chat provider configuration.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum JobPermissions {
    ProviderDefault,
    ReadOnly,
    WorkspaceWrite,
    WorkspaceNetwork,
    AutoReview,
}

impl JobPermissions {
    /// The agent's default job mode (the first it lists).
    pub fn for_harness(harness: &str) -> Self {
        crate::harness::get(harness)
            .and_then(|harness| harness.permissions().first())
            .map(|mode| mode.id)
            .unwrap_or(Self::ProviderDefault)
    }

    pub fn validate(self, harness: &str) -> Result<(), String> {
        let supported = crate::harness::get(harness)
            .is_some_and(|harness| harness.permissions().iter().any(|mode| mode.id == self));
        if supported {
            Ok(())
        } else {
            Err(format!("Permission mode is not supported by {harness}"))
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    pub run_id: String,
    pub conversation_id: String,
    pub harness: String,
    pub model: Option<String>,
    pub project_path: String,
    pub prompt: String,
    pub resume_id: Option<String>,
    #[serde(default = "default_auto_resume")]
    pub auto_resume: bool,
    #[serde(default)]
    pub dangerously_bypass_permissions: bool,
    #[serde(default)]
    pub permissions: Option<crate::adapters::JobPermissions>,
}

fn default_auto_resume() -> bool {
    true
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessStatus {
    pub id: &'static str,
    pub label: &'static str,
    pub installed: bool,
    /// Job permission modes, the default first.
    pub permissions: &'static [crate::harness::Permission],
    pub bypass_description: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub harnesses: Vec<HarnessStatus>,
    pub platform: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEvent {
    pub run_id: String,
    pub conversation_id: String,
    #[serde(rename = "type")]
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub harness: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

impl RunEvent {
    pub fn new(request: &RunRequest, kind: &'static str, text: Option<String>) -> Self {
        Self {
            run_id: request.run_id.clone(),
            conversation_id: request.conversation_id.clone(),
            kind,
            text,
            resume_id: None,
            retry_at: None,
            event_id: None,
            usage: None,
            harness: Some(request.harness.clone()),
            model: Some(request.model.clone().unwrap_or_default()),
        }
    }
}

pub fn find_binary(name: &str) -> Option<PathBuf> {
    crate::platform::find_executable(name)
}

pub fn status() -> RuntimeStatus {
    let harnesses = crate::harness::all()
        .iter()
        .map(|harness| {
            let path = find_binary(harness.executable());
            let version = path.as_ref().and_then(|binary| bounded_version(binary));
            HarnessStatus {
                id: harness.id(),
                label: harness.label(),
                installed: path.is_some(),
                permissions: harness.permissions(),
                bypass_description: harness.bypass_description(),
                version,
                path: path.map(|path| path.to_string_lossy().into_owned()),
                detail: None,
            }
        })
        .collect();
    RuntimeStatus {
        harnesses,
        platform: std::env::consts::OS,
    }
}

static VERSION_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn bounded_version(binary: &Path) -> Option<String> {
    let sequence = VERSION_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let output_path = env::temp_dir().join(format!(
        "noai-version-{}-{sequence}.txt",
        std::process::id()
    ));
    let output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output_path)
        .ok()?;
    let mut command = std::process::Command::new(binary);
    command.env("PATH", crate::platform::child_path(binary));
    crate::platform::isolate_process_group(&mut command);
    let mut child = match command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::from(output))
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => {
            let _ = fs::remove_file(&output_path);
            return None;
        }
    };
    let deadline = Instant::now() + Duration::from_secs(3);
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            _ => {
                crate::platform::kill_process_tree(child.id());
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let version = if success {
        fs::File::open(&output_path).ok().and_then(|file| {
            let mut bytes = Vec::new();
            file.take(1024).read_to_end(&mut bytes).ok()?;
            let value = String::from_utf8_lossy(&bytes).trim().to_owned();
            (!value.is_empty()).then_some(value)
        })
    } else {
        None
    };
    let _ = fs::remove_file(output_path);
    version
}

fn safe_option(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.starts_with('-') || value.contains('\0') {
        return Err(format!("Invalid {label}"));
    }
    Ok(())
}

pub fn spawn(request: &RunRequest) -> Result<Child, String> {
    if request.run_id.trim().is_empty() || request.conversation_id.trim().is_empty() {
        return Err("Run and conversation IDs are required".into());
    }
    if request.prompt.trim().is_empty() {
        return Err("Prompt is empty".into());
    }
    let project = PathBuf::from(&request.project_path)
        .canonicalize()
        .map_err(|error| format!("Cannot resolve project directory: {error}"))?;
    if !project.is_dir() {
        return Err("Project path is not a directory".into());
    }
    if let Some(model) = &request.model {
        safe_option(model, "model")?;
    }
    if let Some(resume_id) = &request.resume_id {
        safe_option(resume_id, "resume ID")?;
    }
    let harness = crate::harness::require(&request.harness)?;
    if let Some(permissions) = request.permissions {
        permissions.validate(&request.harness)?;
    }
    let binary = find_binary(harness.executable()).ok_or_else(|| {
        format!(
            "{} CLI was not found on PATH or in common install locations",
            harness.label()
        )
    })?;
    let mut command = Command::new(&binary);
    command.current_dir(project);
    command.env("PATH", crate::platform::child_path(&binary));
    // Give the CLI and any tools it launches a process group owned by this run.
    crate::platform::isolate_process_group(command.as_std_mut());
    command.args(harness.args(request));
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.kill_on_drop(true);
    command
        .spawn()
        .map_err(|error| format!("Cannot start {}: {error}", request.harness))
}


pub fn parse_line(request: &RunRequest, line: &str) -> Vec<RunEvent> {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return Vec::new();
    };
    crate::harness::get(&request.harness)
        .map(|harness| harness.parse(request, &value))
        .unwrap_or_default()
}

/// Only schedules retries for explicit temporary provider limits with a stated delay.
pub fn classify_timed_quota(harness: &str, message: &str, now_epoch: u64) -> Option<(u64, String)> {
    let agent = crate::harness::get(harness)?;
    let lower = message.to_ascii_lowercase();
    if [
        "billing",
        "payment required",
        "insufficient credits",
        "out of credits",
        "credits depleted",
        "spend limit",
        "permission",
        "unauthorized",
        "authentication",
        "invalid api key",
    ]
    .iter()
    .any(|word| lower.contains(word))
    {
        return None;
    }
    if ![
        "rate limit",
        "rate_limit",
        "usage limit",
        "usage_limit",
        "too many requests",
        "quota",
    ]
    .iter()
    .any(|word| lower.contains(word))
    {
        return None;
    }
    let relative = ["retry after ", "try again in ", "resets in ", "reset in "]
        .iter()
        .find_map(|needle| lower.find(needle).map(|index| index + needle.len()));
    let reset = if let Some(marker) = relative {
        let seconds = parse_duration_seconds(&lower[marker..])?;
        if seconds == 0 || seconds > 8 * 24 * 3600 {
            return None;
        }
        now_epoch.checked_add(seconds)?
    } else if agent.local_clock_resets() {
        let marker = lower.find("try again at ")? + "try again at ".len();
        clock_reset(&lower[marker..], now_epoch, &chrono::Local)?
    } else {
        return None;
    };
    Some((reset, format!("{harness} timed usage limit")))
}

// Some CLIs format time-only resets in the host's local timezone. Reject
// unknown suffixes/zones and ambiguous/nonexistent DST times instead of guessing.
fn clock_reset<T: chrono::TimeZone>(input: &str, now_epoch: u64, timezone: &T) -> Option<u64> {
    use chrono::TimeZone;
    let input = input.trim().trim_end_matches('.');
    let time = chrono::NaiveTime::parse_from_str(&input.to_ascii_uppercase(), "%I:%M %p").ok()?;
    let now = chrono::Utc
        .timestamp_opt(i64::try_from(now_epoch).ok()?, 0)
        .single()?
        .with_timezone(timezone);
    let today = now.date_naive();
    let today_reset = timezone
        .from_local_datetime(&today.and_time(time))
        .single()?
        .timestamp();
    let today_reset = u64::try_from(today_reset).ok()?;
    // The provider displays minute precision. During that minute, preserve
    // today's reset and let the grace period cover the remaining seconds.
    let reset = if crate::scheduler::after_reset(today_reset) > now_epoch {
        today_reset
    } else {
        u64::try_from(
            timezone
                .from_local_datetime(&today.succ_opt()?.and_time(time))
                .single()?
                .timestamp(),
        )
        .ok()?
    };
    (crate::scheduler::after_reset(reset) > now_epoch
        && reset.saturating_sub(now_epoch) <= 25 * 3600)
        .then_some(reset)
}

/// Accept only an explicit rejected usage window, never a warning or billing failure.
pub fn classify_structured_quota(
    harness: &str,
    value: &Value,
    now_epoch: u64,
) -> Option<(u64, String)> {
    crate::harness::get(harness)?;
    let code = value.get("code").and_then(Value::as_str).unwrap_or("");
    let rejected = value.get("status").and_then(Value::as_str) == Some("rejected")
        || matches!(code, "rate_limit_exceeded" | "usage_limit_reached");
    if !rejected {
        return None;
    }
    let reset = value
        .get("resetsAt")
        .or_else(|| value.get("resets_at"))
        .or_else(|| value.get("retryAt"))
        .and_then(Value::as_u64)?;
    if reset <= now_epoch || reset - now_epoch > 8 * 24 * 3600 {
        return None;
    }
    Some((reset, format!("{harness} timed usage limit")))
}

fn parse_duration_seconds(input: &str) -> Option<u64> {
    let mut rest = input.trim_start();
    let mut total = 0u64;
    let mut found = false;
    for _ in 0..3 {
        let count = rest.bytes().take_while(u8::is_ascii_digit).count();
        if count == 0 {
            break;
        }
        let amount: u64 = rest[..count].parse().ok()?;
        rest = rest[count..].trim_start();
        let (unit, size) = if rest.starts_with("hours") {
            (3600, 5)
        } else if rest.starts_with("hour") {
            (3600, 4)
        } else if rest.starts_with('h') {
            (3600, 1)
        } else if rest.starts_with("minutes") {
            (60, 7)
        } else if rest.starts_with("minute") {
            (60, 6)
        } else if rest.starts_with("mins") {
            (60, 4)
        } else if rest.starts_with("min") {
            (60, 3)
        } else if rest.starts_with('m') {
            (60, 1)
        } else if rest.starts_with("seconds") {
            (1, 7)
        } else if rest.starts_with("second") {
            (1, 6)
        } else if rest.starts_with("secs") {
            (1, 4)
        } else if rest.starts_with("sec") {
            (1, 3)
        } else if rest.starts_with('s') {
            (1, 1)
        } else {
            return None;
        };
        total = total.checked_add(amount.checked_mul(unit)?)?;
        rest = rest[size..].trim_start();
        found = true;
    }
    found.then_some(total)
}




#[cfg(test)]
mod tests {
    fn harness_args(request: &RunRequest) -> Vec<String> {
        crate::harness::require(&request.harness).unwrap().args(request)
    }

    use super::*;

    fn request(harness: &str) -> RunRequest {
        RunRequest {
            run_id: "run-1".into(),
            conversation_id: "conversation-1".into(),
            harness: harness.into(),
            model: None,
            project_path: "/tmp".into(),
            prompt: "hi".into(),
            resume_id: None,
            auto_resume: true,
            dangerously_bypass_permissions: false,
            permissions: None,
        }
    }

    #[test]
    fn explicit_job_permissions_apply_to_start_and_resume_without_bypass() {
        for resume in [None, Some("saved-session".into())] {
            for (mode, sandbox, network) in [
                (JobPermissions::WorkspaceNetwork, "workspace-write", true),
                (JobPermissions::WorkspaceWrite, "workspace-write", false),
                (JobPermissions::ReadOnly, "read-only", false),
            ] {
                let mut input = request("codex");
                input.resume_id = resume.clone();
                input.permissions = Some(mode);
                let args = harness_args(&input);
                assert!(args.contains(&format!("sandbox_mode=\"{sandbox}\"")));
                assert!(args.contains(&format!("sandbox_workspace_write.network_access={network}")));
                assert!(args.contains(&"approval_policy=\"never\"".into()));
                assert!(!args
                    .iter()
                    .any(|arg| arg.contains("dangerously") || arg.contains("danger-full-access")));
            }
            let mut claude = request("claude");
            claude.resume_id = resume;
            claude.permissions = Some(JobPermissions::AutoReview);
            assert!(harness_args(&claude)
                .windows(2)
                .any(|args| args == ["--permission-mode", "auto"]));
        }
        let mut old = request("codex");
        assert!(!harness_args(&old)
            .iter()
            .any(|arg| arg.contains("sandbox_mode")));
        old.permissions = Some(JobPermissions::ProviderDefault);
        assert!(!harness_args(&old)
            .iter()
            .any(|arg| arg.contains("sandbox_mode")));
        old.permissions = Some(JobPermissions::WorkspaceNetwork);
        old.dangerously_bypass_permissions = true;
        assert!(!harness_args(&old)
            .iter()
            .any(|arg| arg.contains("sandbox_mode")));
        assert!(JobPermissions::WorkspaceNetwork.validate("claude").is_err());
        assert!(JobPermissions::AutoReview.validate("codex").is_err());
        assert!(serde_json::from_str::<JobPermissions>("\"danger-full-access\"").is_err());
    }

    #[test]
    fn token_reports_normalize_cache_and_preserve_actual_model() {
        let codex = parse_line(
            &request("codex"),
            r#"{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":20}}"#,
        );
        let counts = codex[0].usage.as_ref().unwrap();
        assert_eq!(counts["inputTokens"], 100);
        assert_eq!(counts["cacheReadTokens"], 40);
        let claude = parse_line(
            &request("claude"),
            r#"{"type":"result","session_id":"s","modelUsage":{"actual-model":{"inputTokens":10,"outputTokens":20,"cacheReadInputTokens":30,"cacheCreationInputTokens":40}}}"#,
        );
        let usage = claude.iter().find(|event| event.kind == "usage").unwrap();
        assert_eq!(usage.model.as_deref(), Some("actual-model"));
        assert_eq!(usage.usage.as_ref().unwrap()["inputTokens"], 80);
        assert_eq!(usage.usage.as_ref().unwrap()["scope"], "session");
    }

    #[test]
    fn bypass_arguments_are_explicit_and_preserved_on_resume() {
        for harness in ["codex", "claude"] {
            let mut request = request(harness);
            let normal = harness_args(&request);
            assert!(!normal.iter().any(|arg| arg.contains("dangerously")));
            if harness == "claude" {
                assert!(normal
                    .windows(2)
                    .any(|pair| pair == ["--permission-mode", "dontAsk"]));
            }
            request.dangerously_bypass_permissions = true;
            let flag = if harness == "codex" {
                "--dangerously-bypass-approvals-and-sandbox"
            } else {
                "--dangerously-skip-permissions"
            };
            assert!(harness_args(&request).iter().any(|arg| arg == flag));
            request.resume_id = Some("session-1".into());
            let resumed = harness_args(&request);
            assert!(resumed.iter().any(|arg| arg == flag));
            assert!(resumed.iter().any(|arg| arg == "session-1"));
        }
    }

    #[test]
    fn old_run_request_defaults_to_normal_permissions() {
        let mut value = serde_json::to_value(request("codex")).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .remove("dangerouslyBypassPermissions");
        let decoded: RunRequest = serde_json::from_value(value).unwrap();
        assert!(!decoded.dangerously_bypass_permissions);
    }

    #[test]
    fn codex_session_and_final_text() {
        let req = request("codex");
        let session = parse_line(&req, r#"{"type":"thread.started","thread_id":"abc"}"#);
        assert_eq!(session[0].resume_id.as_deref(), Some("abc"));
        let text = parse_line(
            &req,
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"Hello"}}"#,
        );
        assert_eq!(text[0].text.as_deref(), Some("Hello"));
    }

    #[test]
    fn claude_error_is_terminal_event() {
        let events = parse_line(
            &request("claude"),
            r#"{"type":"result","is_error":true,"result":"limit reached","session_id":"s"}"#,
        );
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].kind, "error");
    }

    #[test]
    fn codex_ignores_partial_text_and_reports_tool_activity() {
        let req = request("codex");
        let partial = parse_line(
            &req,
            r#"{"type":"item.updated","item":{"type":"agent_message","text":"Hel"}}"#,
        );
        assert!(partial.is_empty());
        let activity = parse_line(
            &req,
            r#"{"type":"item.completed","item":{"type":"command_execution","command":"pwd"}}"#,
        );
        assert_eq!(activity[0].kind, "activity");
        let error = parse_line(
            &req,
            r#"{"type":"turn.failed","error":{"message":"approval denied"}}"#,
        );
        assert_eq!(error[0].text.as_deref(), Some("approval denied"));
    }

    #[test]
    fn claude_forwards_assistant_blocks_once_and_ignores_result_copy() {
        let req = request("claude");
        let assistant = parse_line(
            &req,
            r#"{"type":"assistant","session_id":"s","message":{"content":[{"type":"text","text":"Hello"},{"type":"tool_use","name":"Read"}]}}"#,
        );
        assert_eq!(assistant.len(), 3);
        assert_eq!(assistant[1].text.as_deref(), Some("Hello"));
        assert_eq!(assistant[2].kind, "activity");
        let result = parse_line(
            &req,
            r#"{"type":"result","is_error":false,"result":"Hello"}"#,
        );
        assert!(result.is_empty());
        assert!(parse_line(&req, "not JSON").is_empty());
    }

    #[test]
    fn structured_quota_requires_rejection_and_future_bounded_reset() {
        let rejected = serde_json::json!({"status":"rejected","resetsAt":200});
        assert_eq!(
            classify_structured_quota("claude", &rejected, 100)
                .unwrap()
                .0,
            200
        );
        assert!(classify_structured_quota("claude", &rejected, 200).is_none());
        assert!(classify_structured_quota(
            "claude",
            &serde_json::json!({"status":"allowed_warning","resetsAt":200}),
            100
        )
        .is_none());
        assert!(classify_structured_quota(
            "codex",
            &serde_json::json!({"code":"insufficient_quota","resetsAt":200}),
            100
        )
        .is_none());
        assert!(classify_structured_quota(
            "claude",
            &serde_json::json!({"status":"rejected","resetsAt":999999999999u64}),
            100
        )
        .is_none());
    }

    #[test]
    fn codex_clock_limits_use_local_calendar_and_reject_ambiguous_text() {
        use chrono::TimeZone;
        let eastern = chrono::FixedOffset::west_opt(4 * 3600).unwrap();
        let now = eastern
            .with_ymd_and_hms(2026, 10, 12, 11, 22, 33)
            .unwrap()
            .timestamp() as u64;
        let expected = eastern
            .with_ymd_and_hms(2026, 10, 12, 15, 23, 0)
            .unwrap()
            .timestamp() as u64;
        assert_eq!(clock_reset("3:23 pm.", now, &eastern), Some(expected));
        assert_eq!(crate::scheduler::after_reset(expected), expected + 60);
        assert_eq!(
            clock_reset("3:23 PM.", expected + 30, &eastern),
            Some(expected)
        );
        let midnight = eastern
            .with_ymd_and_hms(2026, 10, 13, 0, 5, 0)
            .unwrap()
            .timestamp() as u64;
        let late = eastern
            .with_ymd_and_hms(2026, 10, 12, 23, 59, 0)
            .unwrap()
            .timestamp() as u64;
        assert_eq!(clock_reset("12:05 AM.", late, &eastern), Some(midnight));
        assert_eq!(
            clock_reset("12:05 PM.", now, &eastern),
            Some(
                eastern
                    .with_ymd_and_hms(2026, 10, 12, 12, 5, 0)
                    .unwrap()
                    .timestamp() as u64
            )
        );
        for text in [
            "3:23",
            "25:23 PM",
            "3:75 PM",
            "3:23 PM UTC",
            "3:23 PM tomorrow",
            "3:23 PM on October 14",
        ] {
            assert!(clock_reset(text, now, &eastern).is_none(), "{text}");
        }
        let message = "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:23 PM.";
        assert!(classify_timed_quota("codex", message, now).is_some());
        assert!(classify_timed_quota("claude", message, now).is_none());
        assert!(classify_timed_quota(
            "codex",
            "Billing problem: usage limit. Try again at 3:23 PM.",
            now
        )
        .is_none());
    }

    #[test]
    fn only_explicit_temporary_limits_have_retry_times() {
        assert_eq!(
            classify_timed_quota("codex", "Usage limit reached. Try again in 2h 30m", 100),
            Some((9100, "codex timed usage limit".into()))
        );
        assert_eq!(
            classify_timed_quota("claude", "rate_limit_error retry after 45 seconds", 100),
            Some((145, "claude timed usage limit".into()))
        );
        assert!(
            classify_timed_quota("codex", "Billing quota reached. Retry after 1h", 100).is_none()
        );
        assert!(classify_timed_quota("claude", "Too many requests", 100).is_none());
        assert!(classify_timed_quota(
            "codex",
            "Authentication failed. Usage limit resets in 1h",
            100
        )
        .is_none());
    }

    #[test]
    fn claude_rate_limit_event_exposes_only_usage_metadata() {
        let events = parse_line(
            &request("claude"),
            r#"{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1000,"token":"secret"}}"#,
        );
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "usage");
        assert_eq!(events[0].usage.as_ref().unwrap()["resetsAt"], 1000);
        assert!(events[0].usage.as_ref().unwrap().get("token").is_none());
    }
}
