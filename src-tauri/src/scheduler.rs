use crate::adapters::{RunEvent, RunRequest};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

pub const RESET_GRACE_SECONDS: u64 = 60;

pub fn after_reset(reset: u64) -> u64 {
    reset.saturating_add(RESET_GRACE_SECONDS)
}

pub const MAX_ATTEMPTS: u32 = 8;
pub const MAX_AGE_SECONDS: u64 = 7 * 24 * 60 * 60;

pub fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeJob {
    pub id: String,
    pub run_id: String,
    pub conversation_id: String,
    pub harness: String,
    pub model: Option<String>,
    pub project_path: String,
    #[serde(default)]
    pub dangerously_bypass_permissions: bool,
    #[serde(default)]
    pub permissions: Option<crate::adapters::JobPermissions>,
    pub status: String,
    pub reason: String,
    pub retry_at: Option<u64>,
    pub attempts: u32,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub events: Vec<ResumeLogEvent>,
    #[serde(default)]
    pub events_truncated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeLogEvent {
    pub event_id: u64,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<serde_json::Value>,
    pub at: u64,
}

impl ResumeLogEvent {
    fn from_event(event_id: u64, event: &RunEvent) -> Self {
        Self {
            event_id,
            kind: event.kind.into(),
            text: event.text.clone(),
            resume_id: event.resume_id.clone(),
            retry_at: event.retry_at,
            usage: event.usage.clone(),
            at: now_epoch(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredJob {
    #[serde(flatten)]
    public: ResumeJob,
    request: RunRequest,
    account_fingerprint: String,
    activity_seen: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Journal {
    jobs: Vec<StoredJob>,
}

#[derive(Clone)]
pub struct RetryClaim {
    pub job: ResumeJob,
    pub request: RunRequest,
    pub account_fingerprint: String,
}

pub struct WaitingInput<'a> {
    pub request: &'a RunRequest,
    pub resume_id: Option<String>,
    pub activity_seen: bool,
    pub fingerprint: String,
    pub reason: String,
    pub retry_at: u64,
    pub initial_events: &'a [RunEvent],
}

pub struct Scheduler {
    path: PathBuf,
    _lock_file: File,
    journal: Mutex<Journal>,
    background_mode: AtomicBool,
}

impl Scheduler {
    pub fn open_in_dir(dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(dir).map_err(|error| format!("Cannot create app data: {error}"))?;
        crate::platform::restrict_dir(dir)
            .map_err(|error| format!("Cannot protect app data: {error}"))?;
        let lock_file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(dir.join("resume-jobs.lock"))
            .map_err(|error| format!("Cannot open scheduler lock: {error}"))?;
        lock_file.try_lock().map_err(|_| {
            "Noai is already running or the scheduler lock is unavailable".to_string()
        })?;
        let path = dir.join("resume-jobs.json");
        let mut journal = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<Journal>(&bytes)
                .map_err(|error| format!("Cannot parse resume journal: {error}"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Journal::default(),
            Err(error) => return Err(format!("Cannot read resume journal: {error}")),
        };
        let now = now_epoch();
        let mut recovered = false;
        for job in &mut journal.jobs {
            if job.public.status == "running" {
                job.public.status = "needs_attention".into();
                job.public.reason = "Noai closed during this run. Review before retrying.".into();
                job.public.retry_at = None;
                job.public.updated_at = now;
                recovered = true;
            }
        }
        if recovered {
            save_journal(&path, &journal)?;
        }
        Ok(Self {
            path,
            _lock_file: lock_file,
            journal: Mutex::new(journal),
            background_mode: AtomicBool::new(true),
        })
    }

    fn update<T>(
        &self,
        operation: impl FnOnce(&mut Journal) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut current = self.journal.lock().unwrap();
        let mut candidate = current.clone();
        let result = operation(&mut candidate)?;
        save_journal(&self.path, &candidate)?;
        *current = candidate;
        Ok(result)
    }

    pub fn jobs(&self) -> Vec<ResumeJob> {
        self.journal
            .lock()
            .unwrap()
            .jobs
            .iter()
            .map(|job| job.public.clone())
            .collect()
    }

    pub fn job(&self, id: &str) -> Option<ResumeJob> {
        self.journal
            .lock()
            .unwrap()
            .jobs
            .iter()
            .find(|job| job.public.id == id)
            .map(|job| job.public.clone())
    }

    pub fn waiting(&self, input: WaitingInput<'_>) -> Result<ResumeJob, String> {
        let WaitingInput {
            request,
            resume_id,
            activity_seen,
            fingerprint,
            reason,
            retry_at,
            initial_events,
        } = input;
        let now = now_epoch();
        self.update(|journal| {
            let existing = journal
                .jobs
                .iter_mut()
                .find(|job| job.public.id == request.run_id);
            if let Some(job) = existing {
                if job.public.status != "running" {
                    return Err("Resume job is no longer running".into());
                }
                if job.public.attempts >= MAX_ATTEMPTS
                    || retry_at > job.public.created_at.saturating_add(MAX_AGE_SECONDS)
                {
                    return Err("Automatic resume limit reached".into());
                }
                if job.account_fingerprint != fingerprint {
                    return Err("Account changed before retry".into());
                }
                job.public.status = "waiting".into();
                job.public.reason = reason;
                job.public.retry_at = Some(retry_at);
                job.public.updated_at = now;
                job.activity_seen |= activity_seen;
                if let Some(id) = resume_id {
                    job.request.resume_id = Some(id);
                }
                return Ok(job.public.clone());
            }
            if retry_at > now.saturating_add(MAX_AGE_SECONDS) {
                return Err("Reset time is too far away".into());
            }
            let mut saved_request = request.clone();
            if let Some(id) = resume_id {
                saved_request.resume_id = Some(id);
            }
            let public = ResumeJob {
                id: request.run_id.clone(),
                run_id: request.run_id.clone(),
                conversation_id: request.conversation_id.clone(),
                harness: request.harness.clone(),
                model: request.model.clone(),
                project_path: request.project_path.clone(),
                dangerously_bypass_permissions: request.dangerously_bypass_permissions,
                permissions: request.permissions,
                status: "waiting".into(),
                reason,
                retry_at: Some(retry_at),
                attempts: 1,
                created_at: now,
                updated_at: now,
                events: initial_events
                    .iter()
                    .enumerate()
                    .map(|(index, event)| {
                        ResumeLogEvent::from_event(
                            event.event_id.unwrap_or(index as u64 + 1),
                            event,
                        )
                    })
                    .collect(),
                events_truncated: initial_events
                    .first()
                    .and_then(|event| event.event_id)
                    .is_some_and(|id| id > 1),
            };
            journal.jobs.push(StoredJob {
                public: public.clone(),
                request: saved_request,
                account_fingerprint: fingerprint,
                activity_seen,
            });
            prune(journal);
            Ok(public)
        })
    }

    pub fn append_event(&self, id: &str, event: &mut RunEvent) -> Result<(), String> {
        self.update(|journal| {
            let Some(job) = journal.jobs.iter_mut().find(|job| job.public.id == id) else {
                return Err("Resume job not found while recording event".into());
            };
            let next_id = job.public.events.last().map_or(1, |last| last.event_id + 1);
            event.event_id = Some(next_id);
            job.public
                .events
                .push(ResumeLogEvent::from_event(next_id, event));
            job.public.updated_at = now_epoch();
            Ok(())
        })
    }

    pub fn claim_due(&self, now: u64) -> Result<Vec<RetryClaim>, String> {
        if !self.journal.lock().unwrap().jobs.iter().any(|job| {
            job.public.status == "waiting" && job.public.retry_at.is_some_and(|at| at <= now)
        }) {
            return Ok(Vec::new());
        }
        self.update(|journal| {
            let mut claimed = Vec::new();
            for job in &mut journal.jobs {
                if job.public.status != "waiting" || job.public.retry_at.is_none_or(|at| at > now) {
                    continue;
                }
                if job.public.attempts >= MAX_ATTEMPTS
                    || now > job.public.created_at.saturating_add(MAX_AGE_SECONDS)
                {
                    job.public.status = "needs_attention".into();
                    job.public.reason = "Automatic resume limit reached".into();
                    job.public.retry_at = None;
                } else if job.request.resume_id.is_none() && job.activity_seen {
                    job.public.status = "needs_attention".into();
                    job.public.reason =
                        "This run had activity but no native session to resume safely".into();
                    job.public.retry_at = None;
                } else {
                    job.public.status = "running".into();
                    job.public.retry_at = None;
                    job.public.attempts += 1;
                    let mut request = job.request.clone();
                    if request.resume_id.is_some() {
                        request.prompt = "Continue the request interrupted by a usage limit. Reconcile completed actions and do not repeat completed work.".into();
                    }
                    claimed.push(RetryClaim {
                        job: job.public.clone(),
                        request,
                        account_fingerprint: job.account_fingerprint.clone(),
                    });
                }
                job.public.updated_at = now;
            }
            Ok(claimed)
        })
    }

    pub fn finish(&self, id: &str, status: &str, reason: String) -> Result<(), String> {
        let now = now_epoch();
        self.update(|journal| {
            let job = journal
                .jobs
                .iter_mut()
                .find(|job| job.public.id == id)
                .ok_or_else(|| "Resume job not found".to_string())?;
            if job.public.status == "cancelled" {
                return Ok(());
            }
            job.public.status = status.into();
            job.public.reason = reason;
            job.public.retry_at = None;
            job.public.updated_at = now;
            prune(journal);
            Ok(())
        })
    }

    pub fn defer_claim(
        &self,
        id: &str,
        retry_at: u64,
        reason: String,
    ) -> Result<ResumeJob, String> {
        let now = now_epoch();
        self.update(|journal| {
            let job = journal
                .jobs
                .iter_mut()
                .find(|job| job.public.id == id)
                .ok_or_else(|| "Resume job not found".to_string())?;
            if job.public.status != "running" {
                return Err("Resume job is no longer claimed".into());
            }
            if retry_at <= now || retry_at > job.public.created_at.saturating_add(MAX_AGE_SECONDS) {
                return Err("Updated reset time is outside the automatic resume window".into());
            }
            job.public.status = "waiting".into();
            job.public.reason = reason;
            job.public.retry_at = Some(retry_at);
            job.public.attempts = job.public.attempts.saturating_sub(1);
            job.public.updated_at = now;
            Ok(job.public.clone())
        })
    }

    pub fn cancel(&self, id: &str) -> Result<ResumeJob, String> {
        let now = now_epoch();
        self.update(|journal| {
            let job = journal
                .jobs
                .iter_mut()
                .find(|job| job.public.id == id)
                .ok_or_else(|| "Resume job not found".to_string())?;
            if !matches!(
                job.public.status.as_str(),
                "waiting" | "running" | "needs_attention"
            ) {
                return Err("Resume job is not active".into());
            }
            let old = job.public.clone();
            job.public.status = "cancelled".into();
            job.public.reason = "Cancelled".into();
            job.public.retry_at = None;
            job.public.updated_at = now;
            Ok(old)
        })
    }

    pub fn set_background_mode(&self, enabled: bool) {
        self.background_mode.store(enabled, Ordering::Relaxed);
    }

    pub fn background_mode(&self) -> bool {
        self.background_mode.load(Ordering::Relaxed)
    }
}

fn prune(journal: &mut Journal) {
    let mut finished = journal
        .jobs
        .iter()
        .filter(|job| matches!(job.public.status.as_str(), "completed" | "cancelled"))
        .count();
    if finished <= 100 {
        return;
    }
    journal.jobs.retain(|job| {
        if finished > 100 && matches!(job.public.status.as_str(), "completed" | "cancelled") {
            finished -= 1;
            false
        } else {
            true
        }
    });
}

fn save_journal(path: &Path, journal: &Journal) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(journal).map_err(|error| error.to_string())?;
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = path.with_extension(format!("{}.{unique}.tmp", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        crate::platform::restrict_new_file(&mut options);
        let mut file = options.open(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        crate::platform::sync_parent_dir(path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(|error| format!("Cannot save resume journal: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    static TEST_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    fn test_dir() -> PathBuf {
        let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "noai-scheduler-test-{}-{sequence}",
            std::process::id()
        ))
    }

    fn request() -> RunRequest {
        RunRequest {
            run_id: "run-1".into(),
            conversation_id: "conversation-1".into(),
            harness: "codex".into(),
            model: None,
            project_path: "/tmp".into(),
            prompt: "Do a task".into(),
            resume_id: None,
            auto_resume: true,
            dangerously_bypass_permissions: false,
            permissions: None,
        }
    }

    #[test]
    fn waiting_job_survives_restart_with_events_and_running_is_not_replayed() {
        let dir = test_dir();
        let scheduler = Scheduler::open_in_dir(&dir).unwrap();
        assert!(Scheduler::open_in_dir(&dir).is_err());
        let mut original = request();
        original.dangerously_bypass_permissions = true;
        original.permissions = Some(crate::adapters::JobPermissions::WorkspaceWrite);
        let mut text = RunEvent::new(&original, "text", Some("Partial response".into()));
        text.event_id = Some(1);
        let retry_at = now_epoch() + 60;
        let job = scheduler
            .waiting(WaitingInput {
                request: &original,
                resume_id: Some("session".into()),
                activity_seen: true,
                fingerprint: "account-1".into(),
                reason: "Timed quota".into(),
                retry_at,
                initial_events: &[text],
            })
            .unwrap();
        assert_eq!(job.events[0].text.as_deref(), Some("Partial response"));
        assert!(job.dangerously_bypass_permissions);
        assert_eq!(job.permissions, original.permissions);
        assert!(scheduler.claim_due(retry_at - 1).unwrap().is_empty());
        drop(scheduler);

        let scheduler = Scheduler::open_in_dir(&dir).unwrap();
        assert_eq!(scheduler.jobs()[0].status, "waiting");
        let claims = scheduler.claim_due(retry_at).unwrap();
        assert_eq!(claims.len(), 1);
        assert_eq!(claims[0].request.resume_id.as_deref(), Some("session"));
        assert!(claims[0].request.dangerously_bypass_permissions);
        assert_eq!(claims[0].request.permissions, original.permissions);
        assert_ne!(claims[0].request.prompt, "Do a task");
        assert!(claims[0]
            .request
            .prompt
            .contains("do not repeat completed work"));
        assert_eq!(claims[0].job.attempts, 2);
        drop(scheduler);

        let scheduler = Scheduler::open_in_dir(&dir).unwrap();
        assert_eq!(scheduler.jobs()[0].status, "needs_attention");
        assert!(scheduler.claim_due(retry_at + 10).unwrap().is_empty());
        drop(scheduler);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn due_job_without_session_after_activity_needs_attention() {
        let dir = test_dir();
        let scheduler = Scheduler::open_in_dir(&dir).unwrap();
        let retry_at = now_epoch() + 30;
        scheduler
            .waiting(WaitingInput {
                request: &request(),
                resume_id: None,
                activity_seen: true,
                fingerprint: "account-1".into(),
                reason: "Timed quota".into(),
                retry_at,
                initial_events: &[],
            })
            .unwrap();
        assert!(scheduler.claim_due(retry_at).unwrap().is_empty());
        assert_eq!(scheduler.jobs()[0].status, "needs_attention");
        drop(scheduler);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn newer_confirmed_reset_defers_without_spending_an_attempt() {
        let dir = test_dir();
        let scheduler = Scheduler::open_in_dir(&dir).unwrap();
        let retry_at = now_epoch() + 30;
        scheduler
            .waiting(WaitingInput {
                request: &request(),
                resume_id: Some("session".into()),
                activity_seen: true,
                fingerprint: "account-1".into(),
                reason: "Timed quota".into(),
                retry_at,
                initial_events: &[],
            })
            .unwrap();
        assert_eq!(scheduler.claim_due(retry_at).unwrap()[0].job.attempts, 2);
        let updated = scheduler
            .defer_claim("run-1", retry_at + 90, "Later reset".into())
            .unwrap();
        assert_eq!(updated.status, "waiting");
        assert_eq!(updated.attempts, 1);
        assert!(scheduler.claim_due(retry_at + 89).unwrap().is_empty());
        assert_eq!(scheduler.claim_due(retry_at + 90).unwrap().len(), 1);
        drop(scheduler);
        fs::remove_dir_all(dir).unwrap();
    }
}
