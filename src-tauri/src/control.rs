//! Local daemon control socket. One newline-delimited JSON request per connection.
#[cfg(unix)]
mod unix {
    use crate::{
        adapters::RunRequest,
        engine::{self, Engine, EngineEvent},
        scheduled_tasks::CreateTaskInput,
    };
    use serde::{Deserialize, Serialize};
    use serde_json::{json, Value};
    use std::{
        collections::{HashMap, VecDeque},
        fs,
        io::{BufRead, BufReader, Read, Write},
        os::unix::{fs::PermissionsExt, net::UnixListener},
        path::Path,
        sync::{Arc, Mutex},
        time::Duration,
    };

    const MAX_REQUEST_BYTES: u64 = 1024 * 1024;

    #[derive(Deserialize)]
    #[serde(tag = "command", rename_all = "snake_case")]
    enum Request {
        List,
        Create {
            input: CreateTaskInput,
        },
        Edit {
            id: String,
            input: CreateTaskInput,
            expected_last_run_id: Option<String>,
        },
        Cancel {
            id: String,
        },
        Pause {
            id: String,
        },
        Resume {
            id: String,
        },
        Runs {
            id: String,
        },
        RetryTask {
            id: String,
            start_at: u64,
            expected_last_run_id: Option<String>,
        },
        UpdateAutoResume {
            id: String,
            enabled: bool,
        },
        StartRun {
            request: RunRequest,
        },
        CancelRun {
            run_id: String,
        },
        ResumeJobs,
        CancelResumeJob {
            job_id: String,
        },
        SetBackgroundMode {
            enabled: bool,
        },
        PollEvents {
            since: u64,
        },
        GetDigest,
        SetDigest {
            input: crate::scheduled_tasks::DigestInput,
        },
        RunDigestNow,
        Ping,
        Shutdown,
        ActiveRuns,
        Metrics,
    }

    #[derive(Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct EventRecord {
        sequence: u64,
        #[serde(default)]
        at: u64,
        channel: String,
        payload: Value,
    }

    #[derive(Default)]
    struct EventBuffer {
        next_sequence: u64,
        records: VecDeque<EventRecord>,
        run_ids: HashMap<String, u64>,
        log: Option<fs::File>,
    }

    #[derive(Default)]
    pub struct Events(Mutex<EventBuffer>);

    impl Events {
        pub fn restore(&self, dir: &Path) -> Result<(), String> {
            *self.0.lock().unwrap() = Self::open(dir)?.0.into_inner().unwrap();
            Ok(())
        }

        pub fn open(dir: &Path) -> Result<Self, String> {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            let path = dir.join("daemon-events.jsonl");
            let mut options = fs::OpenOptions::new();
            use std::os::unix::fs::OpenOptionsExt;
            options.create(true).append(true).read(true).mode(0o600);
            let mut file = options.open(&path).map_err(|e| e.to_string())?;
            let mut buffer = EventBuffer::default();
            let mut reader = BufReader::new(&mut file);
            let mut offset = 0u64;
            loop {
                let mut line = Vec::new();
                let bytes = reader
                    .read_until(b'\n', &mut line)
                    .map_err(|e| e.to_string())?;
                if bytes == 0 {
                    break;
                }
                if !line.ends_with(b"\n") {
                    reader
                        .get_mut()
                        .set_len(offset)
                        .map_err(|e| e.to_string())?;
                    break;
                }
                let record: EventRecord = serde_json::from_slice(&line)
                    .map_err(|e| format!("Cannot read daemon event journal: {e}"))?;
                offset += bytes as u64;
                buffer.next_sequence = buffer.next_sequence.max(record.sequence);
                if let (Some(id), Some(event_id)) = (
                    record.payload["runId"].as_str(),
                    record.payload["eventId"].as_u64(),
                ) {
                    buffer.run_ids.insert(id.to_owned(), event_id);
                }
                buffer.records.push_back(record);
            }
            buffer.log = Some(file);
            Ok(Self(Mutex::new(buffer)))
        }

        pub fn sink(self: &Arc<Self>) -> Arc<dyn Fn(EngineEvent) + Send + Sync> {
            let events = self.clone();
            Arc::new(move |event| {
                let (channel, payload) = match event {
                    EngineEvent::Run(run) => ("noai:run", serde_json::to_value(run)),
                    EngineEvent::ScheduledTask(task) => {
                        ("noai:scheduled-task", serde_json::to_value(task))
                    }
                };
                let Ok(mut payload) = payload else {
                    return;
                };
                let mut buffer = events.0.lock().unwrap();
                if channel == "noai:run" {
                    if let Some(id) = payload["runId"].as_str().map(str::to_owned) {
                        let previous = buffer.run_ids.get(&id).copied().unwrap_or(0);
                        let next = payload["eventId"].as_u64().unwrap_or(previous + 1);
                        payload["eventId"] = json!(next);
                        buffer.run_ids.insert(id, previous.max(next));
                    }
                }
                buffer.next_sequence += 1;
                let sequence = buffer.next_sequence;
                let record = EventRecord {
                    sequence,
                    at: crate::scheduler::now_epoch(),
                    channel: channel.into(),
                    payload,
                };
                if let Some(log) = &mut buffer.log {
                    let written = serde_json::to_vec(&record)
                        .map_err(std::io::Error::other)
                        .and_then(|mut bytes| {
                            bytes.push(b'\n');
                            log.write_all(&bytes)?;
                            log.sync_data()
                        });
                    if let Err(error) = written {
                        eprintln!("Noai cannot persist daemon event: {error}");
                    }
                }
                buffer.records.push_back(record);
            })
        }

        fn metrics(&self) -> Value {
            let buffer = self.0.lock().unwrap();
            let rows: Vec<_> = buffer.records.iter().filter(|event| event.channel == "noai:run").filter_map(|event| {
                let kind = event.payload["type"].as_str()?;
                if !matches!(kind, "session" | "usage" | "activity" | "done" | "error" | "waiting") { return None; }
                let p = &event.payload;
                Some(json!({"id":event.sequence,"at":event.at,"runId":p["runId"],"eventId":p["eventId"],"harness":p["harness"],"model":p["model"],"type":kind,"sessionId":p["resumeId"],"usage":p["usage"],"cancelled":p["text"] == "Cancelled","tool":if kind == "activity" {p["text"].clone()} else {Value::Null}}))
            }).collect();
            drop(buffer);
            crate::local_metrics::merge(rows)
        }

        fn since(&self, since: u64) -> Value {
            let buffer = self.0.lock().unwrap();
            let first = buffer
                .records
                .front()
                .map_or(buffer.next_sequence + 1, |r| r.sequence);
            let records: Vec<_> = buffer
                .records
                .iter()
                .filter(|r| r.sequence > since)
                .take(200)
                .cloned()
                .collect();
            let cursor = records
                .last()
                .map_or(since.max(buffer.next_sequence), |r| r.sequence);
            json!({"events": records, "cursor": cursor, "instance":std::process::id(), "gap": since != 0 && since.saturating_add(1) < first})
        }
    }

    pub fn start(
        engine: Arc<Engine>,
        events: Arc<Events>,
        dir: &Path,
        handle: tokio::runtime::Handle,
    ) -> Result<(), String> {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
        let path = dir.join("control.sock");
        if path.exists() {
            if std::os::unix::net::UnixStream::connect(&path).is_ok() {
                return Err("Noai daemon control socket is already in use".into());
            }
            let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            use std::os::unix::fs::FileTypeExt;
            if !meta.file_type().is_socket() {
                return Err(format!(
                    "Control socket path is occupied: {}",
                    path.display()
                ));
            }
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        let listener = UnixListener::bind(&path).map_err(|e| e.to_string())?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
        std::thread::Builder::new()
            .name("noai-control".into())
            .spawn(move || {
                for stream in listener.incoming() {
                    match stream {
                        Ok(stream) => {
                            let engine = engine.clone();
                            let events = events.clone();
                            let handle = handle.clone();
                            if let Err(error) = std::thread::Builder::new()
                                .name("noai-control-client".into())
                                .spawn(move || handle_client(stream, engine, events, handle))
                            {
                                eprintln!("Noai control client: {error}");
                            }
                        }
                        Err(error) => eprintln!("Noai control socket: {error}"),
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn handle_client(
        mut stream: std::os::unix::net::UnixStream,
        engine: Arc<Engine>,
        events: Arc<Events>,
        handle: tokio::runtime::Handle,
    ) {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
        let mut bytes = Vec::new();
        let response = match Read::by_ref(&mut stream)
            .take(MAX_REQUEST_BYTES + 1)
            .read_to_end(&mut bytes)
        {
            Ok(_) if bytes.len() as u64 > MAX_REQUEST_BYTES => error("Request is too large"),
            Ok(_) if !bytes.ends_with(b"\n") => error("Request must end with a newline"),
            Ok(_) => match serde_json::from_slice::<Request>(&bytes) {
                Ok(request) => dispatch(request, engine, events, handle),
                Err(e) => error(&format!("Invalid request: {e}")),
            },
            Err(e) => error(&format!("Cannot read request: {e}")),
        };
        if let Ok(mut line) = serde_json::to_vec(&response) {
            line.push(b'\n');
            let _ = stream.write_all(&line);
        }
    }

    fn dispatch(
        request: Request,
        engine: Arc<Engine>,
        events: Arc<Events>,
        handle: tokio::runtime::Handle,
    ) -> Value {
        let _runtime_context = handle.enter();
        match request {
            Request::Metrics => json!({"ok":true,"data":events.metrics()}),
            Request::ActiveRuns => json!({"ok":true,"data":engine.active_runs.snapshot()}),
            Request::List => json!({"ok": true, "data": engine::list_scheduled_tasks(engine)}),
            Request::Create { input } => result(engine::create_scheduled_task(engine, input)),
            Request::Edit {
                id,
                input,
                expected_last_run_id,
            } => result(engine::edit_scheduled_task(
                engine,
                id,
                input,
                expected_last_run_id,
            )),
            Request::Cancel { id } => result(engine::cancel_scheduled_task(engine, id)),
            Request::Pause { id } => result(engine::pause_scheduled_task(engine, id)),
            Request::Resume { id } => result(engine::resume_scheduled_task(engine, id)),
            Request::Runs { id } => result(engine::get_scheduled_task_runs(engine, id)),
            Request::GetDigest => json!({"ok": true, "data": engine::get_digest(engine)}),
            Request::SetDigest { input } => result(engine::set_digest(engine, input)),
            Request::RunDigestNow => result(engine::run_digest_now(engine)),
            Request::RetryTask {
                id,
                start_at,
                expected_last_run_id,
            } => result(engine::retry_scheduled_task(
                engine,
                id,
                start_at,
                expected_last_run_id,
            )),
            Request::UpdateAutoResume { id, enabled } => {
                result(engine::set_scheduled_task_auto_resume(engine, id, enabled))
            }
            Request::StartRun { request } => {
                result(handle.block_on(engine::start_run(engine, request)))
            }
            Request::CancelRun { run_id } => result(engine::cancel_run(engine, run_id)),
            Request::ResumeJobs => json!({"ok": true, "data": engine::get_resume_jobs(engine)}),
            Request::CancelResumeJob { job_id } => {
                result(engine::cancel_resume_job(engine, job_id))
            }
            Request::SetBackgroundMode { enabled } => {
                json!({"ok": true, "data": engine::set_background_mode(engine, enabled)})
            }
            Request::PollEvents { since } => json!({"ok": true, "data": events.since(since)}),
            Request::Ping => {
                json!({"ok": true, "data": {"daemon": true,"pid":std::process::id(),"managedBySystemd":std::env::var_os("INVOCATION_ID").is_some(),"managedByService":crate::platform::managed_by_service()}})
            }
            Request::Shutdown => {
                if !engine.active_runs.snapshot().is_empty() {
                    return error("Daemon has active work; stop its runs before transferring service ownership");
                }
                std::thread::spawn(|| {
                    std::thread::sleep(Duration::from_millis(100));
                    // SAFETY: signal only this daemon, whose handler cancels owned children.
                    unsafe {
                        libc::kill(std::process::id() as i32, libc::SIGTERM);
                    }
                });
                json!({"ok":true,"data":null})
            }
        }
    }

    fn result<T: Serialize>(value: Result<T, String>) -> Value {
        match value {
            Ok(data) => json!({"ok": true, "data": data}),
            Err(message) => error(&message),
        }
    }
    fn error(message: &str) -> Value {
        json!({"ok": false, "error": message})
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::adapters::RunEvent;
        #[test]
        fn replay_survives_restart_and_assigns_terminal_ids() {
            let dir = std::env::temp_dir().join(format!("noai-events-{}", uuid::Uuid::new_v4()));
            let events = Arc::new(Events::open(&dir).unwrap());
            let sink = events.sink();
            let event = |kind, text| {
                EngineEvent::Run(RunEvent {
                    run_id: "run".into(),
                    conversation_id: "chat".into(),
                    kind,
                    text,
                    resume_id: None,
                    retry_at: None,
                    event_id: None,
                    usage: None,
                    harness: None,
                    model: None,
                })
            };
            sink(event("text", Some("Saved output".into())));
            sink(event("done", None));
            assert_eq!(events.since(0)["events"][1]["payload"]["eventId"], 2);
            drop(sink);
            drop(events);
            // An interrupted final append is discarded, not the complete records.
            fs::OpenOptions::new()
                .append(true)
                .open(dir.join("daemon-events.jsonl"))
                .unwrap()
                .write_all(b"{partial")
                .unwrap();
            let restored = Events::open(&dir).unwrap();
            assert_eq!(restored.since(1)["events"].as_array().unwrap().len(), 1);
            assert_eq!(
                restored.since(0)["events"][0]["payload"]["text"],
                "Saved output"
            );
            drop(restored);
            fs::remove_dir_all(dir).unwrap();
        }
    }
}

#[cfg(unix)]
pub use unix::{start, Events};
