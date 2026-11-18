use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env,
    process::Stdio,
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    time::timeout,
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

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn identities() -> &'static Mutex<HashMap<String, String>> {
    static IDENTITIES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    IDENTITIES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_identity(harness: &str, value: Option<String>) {
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
    let identity = match harness {
        "codex" => codex_query()
            .await
            .ok()
            .and_then(|(account, limits)| codex_identity(&account, &limits)),
        "claude" => claude_auth()
            .await
            .ok()
            .and_then(|auth| claude_identity(&auth)),
        _ => None,
    };
    cache_identity(harness, identity.clone());
    identity
}

fn unavailable(id: &'static str, label: &'static str, detail: &str) -> ProviderUsageSnapshot {
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
    if harness != "codex" {
        return None;
    }
    let (account, limits) = codex_query().await.ok()?;
    let snapshot = codex_snapshot(&account, &limits);
    snapshot
        .windows
        .iter()
        .filter(|window| window.used_percent.is_some_and(|used| used >= 100.0))
        .filter_map(|window| window.resets_at)
        .filter(|reset| *reset > now_epoch && *reset - now_epoch <= 8 * 24 * 3600)
        .max()
}

#[tauri::command]
pub async fn get_provider_usage() -> Vec<ProviderUsageSnapshot> {
    let (codex, claude, openrouter) =
        tokio::join!(codex_usage(), claude_usage(), openrouter_usage());
    vec![
        codex,
        claude,
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
    ]
}

async fn rpc(
    stdin: &mut tokio::process::ChildStdin,
    lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value, ()> {
    let request = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
    stdin
        .write_all(request.to_string().as_bytes())
        .await
        .map_err(|_| ())?;
    stdin.write_all(b"\n").await.map_err(|_| ())?;
    stdin.flush().await.map_err(|_| ())?;
    for _ in 0..100 {
        let line = lines.next_line().await.map_err(|_| ())?.ok_or(())?;
        if line.len() > 1_000_000 {
            return Err(());
        }
        let value: Value = serde_json::from_str(&line).map_err(|_| ())?;
        if value.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        return value.get("result").cloned().ok_or(());
    }
    Err(())
}

async fn codex_query() -> Result<(Value, Value), ()> {
    let values = codex_requests(vec![
        ("account/read", json!({"refreshToken":false})),
        ("account/rateLimits/read", json!({})),
    ])
    .await?;
    Ok((values[0].clone(), values[1].clone()))
}

async fn codex_requests(requests: Vec<(&str, Value)>) -> Result<Vec<Value>, ()> {
    let binary = crate::adapters::find_binary("codex").ok_or(())?;
    timeout(Duration::from_secs(12), async {
        let mut child = Command::new(binary)
            .args(["app-server", "--listen", "stdio://"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| ())?;
        let mut stdin = child.stdin.take().ok_or(())?;
        let stdout = child.stdout.take().ok_or(())?;
        let mut lines = BufReader::new(stdout).lines();
        rpc(
            &mut stdin,
            &mut lines,
            1,
            "initialize",
            json!({
                "clientInfo":{"name":"noai","title":"Noai","version":"0.1.0"},
                "capabilities":{}
            }),
        )
        .await?;
        stdin
            .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"initialized\",\"params\":{}}\n")
            .await
            .map_err(|_| ())?;
        let mut results = Vec::new();
        for (index, (method, params)) in requests.into_iter().enumerate() {
            results.push(rpc(&mut stdin, &mut lines, index as u64 + 2, method, params).await?);
        }
        let _ = child.kill().await;
        Ok(results)
    })
    .await
    .map_err(|_| ())?
}

#[derive(Serialize)]
pub struct HarnessModel {
    id: String,
    label: String,
}

#[tauri::command]
pub async fn get_harness_models(harness: String) -> Vec<HarnessModel> {
    match harness.as_str() {
        "codex" => {
            let Ok(results) = codex_requests(vec![(
                "model/list",
                json!({"limit":100,"includeHidden":false}),
            )])
            .await
            else {
                return vec![];
            };
            results[0]["data"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|model| {
                    let id = model.get("model").or_else(|| model.get("id"))?.as_str()?;
                    Some(HarnessModel {
                        id: id.into(),
                        label: model["displayName"].as_str().unwrap_or(id).into(),
                    })
                })
                .collect()
        }
        "claude" => ["fable", "opus", "sonnet"]
            .into_iter()
            .map(|id| HarnessModel {
                id: id.into(),
                label: format!("{id} (CLI alias)"),
            })
            .collect(),
        _ => vec![],
    }
}

fn codex_identity(account: &Value, limits: &Value) -> Option<String> {
    if let Some(id) = limits
        .get("accountId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    {
        return Some(format!("codex:{id}"));
    }
    let account = account.get("account")?;
    let email = account
        .get("email")
        .and_then(Value::as_str)
        .filter(|email| !email.is_empty())?;
    Some(format!("codex:{email}"))
}

fn codex_window(label: String, value: &Value) -> Option<ProviderUsageWindow> {
    let percent = value.get("usedPercent").and_then(Value::as_f64)?;
    if !(0.0..=100.0).contains(&percent) {
        return None;
    }
    Some(ProviderUsageWindow {
        label,
        unit: None,
        used_percent: Some(percent),
        remaining: None,
        limit: None,
        resets_at: value.get("resetsAt").and_then(Value::as_u64),
    })
}

fn codex_snapshot(account: &Value, limits: &Value) -> ProviderUsageSnapshot {
    let identity = codex_identity(account, limits);
    cache_identity("codex", identity);
    let account_value = account.get("account").unwrap_or(&Value::Null);
    let account_label = account_value
        .get("email")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let mut plan = account_value
        .get("planType")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let mut windows = Vec::new();
    let buckets = limits.get("rateLimitsByLimitId").and_then(Value::as_object);
    if let Some(buckets) = buckets.filter(|buckets| !buckets.is_empty()) {
        for (name, bucket) in buckets {
            if plan.is_none() {
                plan = bucket
                    .get("planType")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
            if let Some(window) = codex_window(format!("{name} · primary"), &bucket["primary"]) {
                windows.push(window);
            }
            if let Some(window) = codex_window(format!("{name} · secondary"), &bucket["secondary"])
            {
                windows.push(window);
            }
        }
    } else {
        let bucket = &limits["rateLimits"];
        if plan.is_none() {
            plan = bucket
                .get("planType")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        if let Some(window) = codex_window("Primary".into(), &bucket["primary"]) {
            windows.push(window);
        }
        if let Some(window) = codex_window("Secondary".into(), &bucket["secondary"]) {
            windows.push(window);
        }
    }
    ProviderUsageSnapshot {
        id: "codex",
        label: "Codex",
        account_label,
        plan,
        source: "provider",
        status: if windows.is_empty() {
            "unavailable"
        } else {
            "available"
        },
        fetched_at: Some(now()),
        windows,
        detail: if limits["ordinaryUsageAllowed"] == false {
            Some("Included usage is currently unavailable for this account.".into())
        } else {
            None
        },
    }
}

async fn codex_usage() -> ProviderUsageSnapshot {
    match codex_query().await {
        Ok((account, limits)) => codex_snapshot(&account, &limits),
        Err(_) => {
            cache_identity("codex", None);
            unavailable(
                "codex",
                "Codex",
                "Sign in to Codex or update its CLI to read account limits.",
            )
        }
    }
}

async fn claude_auth() -> Result<Value, ()> {
    let binary = crate::adapters::find_binary("claude").ok_or(())?;
    let output = timeout(
        Duration::from_secs(6),
        Command::new(binary)
            .args(["auth", "status", "--json"])
            .kill_on_drop(true)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| ())?
    .map_err(|_| ())?;
    if !output.status.success() || output.stdout.len() > 100_000 {
        return Err(());
    }
    serde_json::from_slice(&output.stdout).map_err(|_| ())
}

fn claude_identity(auth: &Value) -> Option<String> {
    for key in ["accountUuid", "accountId", "userId", "email"] {
        if let Some(value) = auth
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            return Some(format!("claude:{value}"));
        }
    }
    None
}

async fn claude_usage() -> ProviderUsageSnapshot {
    match claude_auth().await {
        Ok(auth) => {
            cache_identity("claude", claude_identity(&auth));
            ProviderUsageSnapshot { id: "claude", label: "Claude Code",
                account_label: auth.get("email").and_then(Value::as_str).map(str::to_owned),
                plan: auth.get("subscriptionType").or_else(|| auth.get("plan"))
                    .and_then(Value::as_str).map(str::to_owned),
                source: "cli", status: "unavailable", fetched_at: Some(now()), windows: vec![],
                detail: Some("Claude CLI reports sign-in status but does not expose current subscription usage here.".into()) }
        }
        Err(_) => {
            cache_identity("claude", None);
            unavailable(
                "claude",
                "Claude Code",
                "Claude CLI authentication status is unavailable.",
            )
        }
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

    #[test]
    fn codex_maps_both_limit_windows_and_identity() {
        let account =
            json!({"account":{"type":"chatgpt","email":"person@example.com","planType":"plus"}});
        let limits = json!({"accountId":"account-1","ordinaryUsageAllowed":true,"rateLimits":{
            "primary":{"usedPercent":55,"resetsAt":2000},"secondary":{"usedPercent":12,"resetsAt":3000}}});
        let snapshot = codex_snapshot(&account, &limits);
        assert_eq!(snapshot.status, "available");
        assert_eq!(snapshot.plan.as_deref(), Some("plus"));
        assert_eq!(snapshot.windows.len(), 2);
        assert_eq!(snapshot.windows[0].resets_at, Some(2000));
        assert_eq!(
            account_fingerprint("codex").as_deref(),
            Some("codex:account-1")
        );
    }

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
