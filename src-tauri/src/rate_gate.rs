//! Go / Wait / Stop: one light per agent that decides whether its jobs may start.
//!
//! - **Go:** jobs start as scheduled.
//! - **Wait:** the agent hit a limit with a known reset. Its due jobs are held
//!   until then, and the light turns back to Go on its own.
//! - **Stop:** the agent hit a limit with no stated reset (or a billing or
//!   credits problem), or you stopped it. Its jobs are held until you press Go,
//!   or until a run of that agent succeeds again.
//!
//! The daemon owns the lights and saves them, so they survive restarts. Chats
//! are never blocked (you're there to decide); they get a warning instead.

use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

/// How often a stopped agent's held jobs are looked at again.
pub const STOP_RECHECK_SECONDS: u64 = 15 * 60;
/// Prefixes of the reason saved on a held job, so pressing Go can release it.
pub const WAIT_PREFIX: &str = "Waiting:";
pub const STOP_PREFIX: &str = "Stopped:";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Light {
    Go,
    Wait,
    Stop,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gate {
    pub light: Light,
    /// When a Wait ends.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<u64>,
    pub reason: String,
    /// Set by you, not by a limit: only you can turn it back to Go.
    #[serde(default)]
    pub manual: bool,
    pub since: u64,
}

impl Gate {
    fn go(now: u64) -> Self {
        Gate {
            light: Light::Go,
            until: None,
            reason: String::new(),
            manual: false,
            since: now,
        }
    }
}

/// What a finished run said about its agent's limits.
#[derive(Clone, Debug, PartialEq)]
pub enum Signal {
    /// It worked: limits are fine.
    Ok,
    /// A limit with a known reset time.
    Timed { reset: u64, reason: String },
    /// A limit with no reset time, or a billing or credits problem.
    Untimed { reason: String },
}

pub struct RateGates {
    path: PathBuf,
    gates: Mutex<BTreeMap<String, Gate>>,
}

impl RateGates {
    pub fn open_in_dir(dir: &Path) -> Self {
        let path = dir.join("rate-gates.json");
        // A missing or damaged file means every agent is on Go.
        let gates = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            path,
            gates: Mutex::new(gates),
        }
    }

    /// The current light of one agent. A Wait whose time has passed is Go.
    pub fn get(&self, harness: &str, now: u64) -> Gate {
        let gates = self.gates.lock().unwrap();
        match gates.get(harness) {
            Some(gate) if gate.light == Light::Wait && gate.until.is_none_or(|at| at <= now) => {
                Gate::go(gate.until.unwrap_or(now))
            }
            Some(gate) => gate.clone(),
            None => Gate::go(0),
        }
    }

    pub fn all(&self, harnesses: &[&str], now: u64) -> BTreeMap<String, Gate> {
        harnesses
            .iter()
            .map(|id| ((*id).to_owned(), self.get(id, now)))
            .collect()
    }

    /// Updates a light from a finished run. Returns the new gate when the
    /// light changed, so the caller can tell you about it.
    pub fn observe(&self, harness: &str, signal: Signal, now: u64) -> Option<Gate> {
        let current = self.get(harness, now);
        let next = match signal {
            // Success clears a limit, but never a Stop you set yourself.
            Signal::Ok if current.light != Light::Go && !current.manual => Gate::go(now),
            Signal::Ok => return None,
            Signal::Timed { reset, reason } => {
                if current.manual {
                    return None;
                }
                // Keep the later of two waits; a Stop stays until you or a success clear it.
                if current.light == Light::Stop
                    || (current.light == Light::Wait && current.until >= Some(reset))
                {
                    return None;
                }
                Gate {
                    light: Light::Wait,
                    until: Some(reset),
                    reason,
                    manual: false,
                    since: now,
                }
            }
            Signal::Untimed { reason } => {
                if current.light == Light::Stop {
                    return None;
                }
                Gate {
                    light: Light::Stop,
                    until: None,
                    reason,
                    manual: false,
                    since: now,
                }
            }
        };
        self.set(harness, next.clone());
        Some(next)
    }

    /// You pressed Go or Stop.
    pub fn set_manual(&self, harness: &str, light: Light, now: u64) -> Result<Gate, String> {
        let gate = match light {
            Light::Go => Gate::go(now),
            Light::Stop => Gate {
                light: Light::Stop,
                until: None,
                reason: "You stopped this agent's jobs.".into(),
                manual: true,
                since: now,
            },
            Light::Wait => return Err("Only a limit can make an agent wait".into()),
        };
        self.set(harness, gate.clone());
        Ok(gate)
    }

    fn set(&self, harness: &str, gate: Gate) {
        let mut gates = self.gates.lock().unwrap();
        if gate.light == Light::Go {
            gates.remove(harness);
        } else {
            gates.insert(harness.to_owned(), gate);
        }
        if let Err(error) = save(&self.path, &gates) {
            eprintln!("Noai rate gates: {error}");
        }
    }
}

fn save(path: &Path, gates: &BTreeMap<String, Gate>) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(gates)?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
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
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gates() -> (RateGates, PathBuf) {
        let dir = std::env::temp_dir().join(format!("noai-gates-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        (RateGates::open_in_dir(&dir), dir)
    }

    #[test]
    fn limits_turn_the_light_and_success_clears_it() {
        let (gates, dir) = gates();
        assert_eq!(gates.get("codex", 100).light, Light::Go);
        let timed = Signal::Timed {
            reset: 500,
            reason: "limit".into(),
        };
        assert_eq!(
            gates.observe("codex", timed, 100).unwrap().light,
            Light::Wait
        );
        // An earlier reset doesn't shorten the wait.
        let earlier = Signal::Timed {
            reset: 300,
            reason: "x".into(),
        };
        assert!(gates.observe("codex", earlier, 101).is_none());
        assert_eq!(gates.get("codex", 499).until, Some(500));
        // The wait ends on its own.
        assert_eq!(gates.get("codex", 500).light, Light::Go);

        let untimed = Signal::Untimed {
            reason: "daily".into(),
        };
        assert_eq!(
            gates.observe("gemini", untimed, 100).unwrap().light,
            Light::Stop
        );
        // A timed limit doesn't downgrade a Stop.
        let timed = Signal::Timed {
            reset: 900,
            reason: "x".into(),
        };
        assert!(gates.observe("gemini", timed, 101).is_none());
        // Saved across restarts.
        let reopened = RateGates::open_in_dir(&dir);
        assert_eq!(reopened.get("gemini", 200).light, Light::Stop);
        assert_eq!(
            reopened.observe("gemini", Signal::Ok, 200).unwrap().light,
            Light::Go
        );
        assert!(reopened.observe("gemini", Signal::Ok, 201).is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn only_you_can_clear_a_stop_you_set() {
        let (gates, dir) = gates();
        gates.set_manual("claude", Light::Stop, 10).unwrap();
        assert!(gates.observe("claude", Signal::Ok, 11).is_none());
        let timed = Signal::Timed {
            reset: 99,
            reason: "x".into(),
        };
        assert!(gates.observe("claude", timed, 12).is_none());
        assert!(gates.get("claude", 13).manual);
        assert_eq!(
            gates.set_manual("claude", Light::Go, 14).unwrap().light,
            Light::Go
        );
        assert!(gates.set_manual("claude", Light::Wait, 15).is_err());
        let _ = fs::remove_dir_all(dir);
    }
}
