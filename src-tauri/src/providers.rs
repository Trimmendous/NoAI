use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    env,
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsageWindow {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsageSnapshot {
    pub id: &'static str,
    pub label: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    pub source: &'static str,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<u64>,
    pub windows: Vec<ProviderUsageWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

pub(crate) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn identities() -> &'static Mutex<HashMap<String, String>> {
    static IDENTITIES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    IDENTITIES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn cache_identity(harness: &str, value: Option<String>) {
    let mut cache = identities().lock().unwrap();
    if let Some(value) = value {
        cache.insert(harness.into(), value);
    } else {
        cache.remove(harness);
    }
}

#[cfg(test)]
pub fn account_fingerprint(harness: &str) -> Option<String> {
    identities().lock().unwrap().get(harness).cloned()
}

/// Reads the current signed-in identity. Nothing from a credential store is opened by Noai.
pub async fn refresh_account_fingerprint(harness: &str) -> Option<String> {
    let identity = match crate::harness::get(harness) {
        Some(agent) => agent.identity().await,
        None => None,
    };
    cache_identity(harness, identity.clone());
    identity
}

pub(crate) fn unavailable(id: &'static str, label: &'static str, detail: &str) -> ProviderUsageSnapshot {
    ProviderUsageSnapshot {
        id,
        label,
        account_label: None,
        plan: None,
        source: "unavailable",
        status: "unavailable",
        fetched_at: None,
        windows: vec![],
        detail: Some(detail.into()),
    }
}

/// Only fresh, explicitly exhausted provider windows can postpone a due retry.
pub async fn refresh_timed_limit_reset(harness: &str, now_epoch: u64) -> Option<u64> {
    crate::harness::get(harness)?.exhausted_reset(now_epoch).await
}

#[tauri::command]
pub async fn get_provider_usage() -> Vec<ProviderUsageSnapshot> {
    let agents: Vec<_> = crate::harness::all()
        .iter()
        .map(|agent| tokio::spawn(agent.usage()))
        .collect();
    let openrouter = openrouter_usage().await;
    let mut snapshots = Vec::new();
    for (agent, task) in crate::harness::all().iter().zip(agents) {
        snapshots.push(task.await.unwrap_or_else(|_| {
            unavailable(agent.id(), agent.label(), "Usage could not be read.")
        }));
    }
    snapshots.extend([
        unavailable(
            "gemini",
            "Gemini CLI",
            "This CLI does not expose verified account usage to Noai.",
        ),
        unavailable(
            "copilot",
            "GitHub Copilot",
            "Verified account usage is not available.",
        ),
        unavailable(
            "cursor",
            "Cursor",
            "Verified account usage is not available.",
        ),
        openrouter,
    ]);
    snapshots
}




#[derive(Serialize)]
pub struct HarnessModel {
    pub(crate) id: String,
    pub(crate) label: String,
}

#[tauri::command]
pub async fn get_harness_models(harness: String) -> Vec<HarnessModel> {
    match crate::harness::get(&harness) {
        Some(agent) => agent.models().await,
        None => vec![],
    }
}










async fn openrouter_usage() -> ProviderUsageSnapshot {
    let Ok(key) = env::var("OPENROUTER_API_KEY") else {
        return unavailable(
            "openrouter",
            "OpenRouter",
            "Set OPENROUTER_API_KEY to read this key's usage.",
        );
    };
    if key.trim().is_empty() {
        return unavailable(
            "openrouter",
            "OpenRouter",
            "Set OPENROUTER_API_KEY to read this key's usage.",
        );
    }
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            return unavailable(
                "openrouter",
                "OpenRouter",
                "Cannot prepare the usage request.",
            )
        }
    };
    let result = client
        .get("https://openrouter.ai/api/v1/key")
        .bearer_auth(&key)
        .send()
        .await;
    let Ok(response) = result else {
        return unavailable("openrouter", "OpenRouter", "Usage request failed.");
    };
    if !response.status().is_success() {
        return unavailable(
            "openrouter",
            "OpenRouter",
            "OpenRouter did not return key usage.",
        );
    }
    let Ok(payload) = response.json::<Value>().await else {
        return unavailable(
            "openrouter",
            "OpenRouter",
            "Invalid OpenRouter usage response.",
        );
    };
    openrouter_snapshot(&payload)
}

fn openrouter_snapshot(payload: &Value) -> ProviderUsageSnapshot {
    let data = &payload["data"];
    let limit = data["limit"].as_f64();
    let remaining = data["limit_remaining"].as_f64();
    let mut windows = Vec::new();
    if let (Some(limit), Some(remaining)) = (limit, remaining) {
        if limit > 0.0 && remaining >= 0.0 {
            windows.push(ProviderUsageWindow {
                label: match data["limit_reset"].as_str() {
                    Some("daily") => "Daily key spend",
                    Some("weekly") => "Weekly key spend",
                    Some("monthly") => "Monthly key spend",
                    _ => "Key spend limit",
                }
                .into(),
                unit: Some("USD"),
                used_percent: Some(((limit - remaining) / limit * 100.0).clamp(0.0, 100.0)),
                remaining: Some(remaining),
                limit: Some(limit),
                resets_at: None,
            });
        }
    }
    ProviderUsageSnapshot {
        id: "openrouter",
        label: "OpenRouter",
        account_label: data["label"].as_str().map(str::to_owned),
        plan: None,
        source: "provider",
        status: if data.is_object() {
            "available"
        } else {
            "error"
        },
        fetched_at: Some(now()),
        windows,
        detail: Some(
            "Usage and limit are for this API key in USD; no reset timestamp is supplied.".into(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;



    #[test]
    fn openrouter_does_not_invent_reset_time_or_a_limit() {
        let snapshot = openrouter_snapshot(
            &json!({"data":{"limit":100.0,"limit_remaining":75.0,"limit_reset":"monthly"}}),
        );
        assert_eq!(snapshot.windows[0].used_percent, Some(25.0));
        assert_eq!(snapshot.windows[0].resets_at, None);
        assert!(openrouter_snapshot(&json!({"data":{"usage":5.0}}))
            .windows
            .is_empty());
    }
}
