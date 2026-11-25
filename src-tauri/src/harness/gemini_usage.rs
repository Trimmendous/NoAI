//! Gemini API usage and daily limits, read from Google Cloud Monitoring through
//! the Google Cloud CLI's own sign-in (`gcloud`).
//!
//! A Gemini API key can only call the models; usage numbers belong to the key's
//! Google Cloud project and need a Google sign-in to read. Noai never stores
//! that sign-in: it asks `gcloud` for a short-lived access token for each
//! check, keeps it in memory for that one request, and never logs or saves it.

use crate::adapters::find_binary;
use crate::providers::{
    now, unavailable, ProviderUsageSnapshot, ProviderUsageWindow, SetupGuide, SetupStep,
};
use chrono::{Datelike, NaiveDate, TimeZone, Utc, Weekday};
use serde_json::Value;
use std::{collections::BTreeMap, path::Path, process::Stdio, time::Duration};
use tokio::{process::Command, time::timeout};

const ID: &str = "gemini";
const LABEL: &str = "Gemini CLI";
const SERVICE: &str = "generativelanguage.googleapis.com";

const PROJECT_HINT: &str = "Use the project your Gemini API key belongs to. Find its ID in Google AI Studio under Projects (it often starts with gen-lang-client-).";

/// A card that says what's missing, with the full steps behind "Needs attention".
fn needs_setup(
    status: &str,
    title: &str,
    summary: &str,
    steps: Vec<SetupStep>,
) -> ProviderUsageSnapshot {
    let mut snapshot = unavailable(ID, LABEL, status);
    snapshot.setup = Some(SetupGuide {
        title: title.into(),
        summary: summary.into(),
        steps,
    });
    snapshot
}

fn install_guide() -> ProviderUsageSnapshot {
    needs_setup(
        "Install the Google Cloud CLI to see usage",
        "See your Gemini usage",
        "Your Gemini API key can't read its own usage. Google keeps those numbers in Google Cloud, which Noai reads through the Google Cloud CLI's sign-in. Noai never stores that sign-in.",
        vec![
            SetupStep::run("Install the Google Cloud CLI.", "brew install --cask google-cloud-sdk"),
            SetupStep::run("Sign in with the Google account that owns your API key. Your browser opens.", "gcloud auth login"),
            SetupStep::run(PROJECT_HINT, "gcloud config set project PROJECT_ID"),
            SetupStep::say("Come back here and press Check again."),
        ],
    )
}

fn login_guide() -> ProviderUsageSnapshot {
    needs_setup(
        "Sign in to the Google Cloud CLI to see usage",
        "Sign in to Google Cloud",
        "The Google Cloud CLI is installed but not signed in, so Noai can't read your Gemini usage yet.",
        vec![
            SetupStep::run("Sign in with the Google account that owns your API key. Your browser opens.", "gcloud auth login"),
            SetupStep::run(PROJECT_HINT, "gcloud config set project PROJECT_ID"),
            SetupStep::say("Come back here and press Check again."),
        ],
    )
}

fn project_guide() -> ProviderUsageSnapshot {
    needs_setup(
        "Choose your Google Cloud project to see usage",
        "Choose your project",
        "You're signed in to Google Cloud. Noai needs to know which project your Gemini API key belongs to.",
        vec![
            SetupStep::run(PROJECT_HINT, "gcloud config set project PROJECT_ID"),
            SetupStep::say("Come back here and press Check again."),
        ],
    )
}

pub async fn usage() -> ProviderUsageSnapshot {
    let Some(gcloud) = find_binary("gcloud") else {
        return install_guide();
    };
    let account = run(&gcloud, &["config", "get-value", "account"]).await;
    if account.is_none() {
        return login_guide();
    }
    let Some(project) = run(&gcloud, &["config", "get-value", "project"]).await else {
        return project_guide();
    };
    let Some(token) = run(&gcloud, &["auth", "print-access-token"]).await else {
        return needs_setup(
            "Google Cloud sign-in needs renewing",
            "Renew your Google Cloud sign-in",
            "Your Google Cloud CLI sign-in has expired.",
            vec![
                SetupStep::run("Sign in again. Your browser opens.", "gcloud auth login"),
                SetupStep::say("Come back here and press Check again."),
            ],
        );
    };
    let now = now();
    let start = pacific_midnight_before(now);
    let usage = query(&token, &project, &usage_params(start, now)).await;
    let limits = query(&token, &project, &limit_params(now)).await;
    drop(token);
    let (usage, limits) = match (usage, limits) {
        (Ok(usage), Ok(limits)) => (usage, limits),
        (Err(error), _) | (_, Err(error)) => return error.guide(&project),
    };
    let windows = daily_windows(&usage, &limits, next_pacific_midnight(now));
    ProviderUsageSnapshot {
        id: ID,
        label: LABEL,
        account_label: account,
        plan: None,
        source: "provider",
        status: "available",
        fetched_at: Some(now),
        detail: Some(if windows.is_empty() {
            format!("Google Cloud project {project} reports no daily Gemini API limits")
        } else {
            format!("Google Cloud project {project}")
        }),
        windows,
        setup: None,
    }
}

/// One `gcloud` call's trimmed output, or `None` when it fails or prints nothing.
async fn run(gcloud: &Path, args: &[&str]) -> Option<String> {
    let output = timeout(
        Duration::from_secs(20),
        Command::new(gcloud)
            .args(args)
            .arg("--quiet")
            .env("PATH", crate::platform::child_path(gcloud))
            .env("CLOUDSDK_CORE_DISABLE_PROMPTS", "1")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (output.status.success() && !text.is_empty() && text != "(unset)").then_some(text)
}

enum QueryError {
    Disabled,
    Denied,
    Failed(String),
}

impl QueryError {
    fn guide(&self, project: &str) -> ProviderUsageSnapshot {
        match self {
            QueryError::Disabled => needs_setup(
                "Turn on Cloud Monitoring to see usage",
                "Turn on Cloud Monitoring",
                &format!("Google keeps Gemini usage in Cloud Monitoring, which is off for project {project}. Turning it on is free for this."),
                vec![
                    SetupStep::run("Turn it on.", &format!("gcloud services enable monitoring.googleapis.com --project {project}")),
                    SetupStep::say("Wait a minute, then press Check again."),
                ],
            ),
            QueryError::Denied => needs_setup(
                "Can't read usage for this project",
                "Check your project",
                &format!("Your Google account can't read monitoring data for project {project}. It may not be the project your API key belongs to."),
                vec![
                    SetupStep::run(PROJECT_HINT, "gcloud config set project PROJECT_ID"),
                    SetupStep::say("Come back here and press Check again."),
                ],
            ),
            QueryError::Failed(why) => unavailable(
                ID,
                LABEL,
                &format!("Couldn't read Gemini usage from Google Cloud: {why}"),
            ),
        }
    }
}

async fn query(
    token: &str,
    project: &str,
    params: &[(&str, String)],
) -> Result<Vec<Value>, QueryError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| QueryError::Failed(error.to_string()))?;
    let url = format!("https://monitoring.googleapis.com/v3/projects/{project}/timeSeries");
    let mut series = Vec::new();
    let mut page_token: Option<String> = None;
    for _ in 0..10 {
        let mut request = client.get(&url).bearer_auth(token).query(params);
        if let Some(page) = &page_token {
            request = request.query(&[("pageToken", page)]);
        }
        let response = request
            .send()
            .await
            .map_err(|_| QueryError::Failed("the request didn't go through".into()))?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or_default();
        if !status.is_success() {
            let message = body["error"]["message"].as_str().unwrap_or("").to_owned();
            let text = format!("{message} {}", body["error"]["details"]).to_ascii_lowercase();
            return Err(
                if text.contains("service_disabled") || text.contains("has not been used") {
                    QueryError::Disabled
                } else if status.as_u16() == 403 {
                    QueryError::Denied
                } else {
                    QueryError::Failed(if message.is_empty() {
                        format!("HTTP {status}")
                    } else {
                        message
                    })
                },
            );
        }
        series.extend(body["timeSeries"].as_array().cloned().unwrap_or_default());
        page_token = body["nextPageToken"]
            .as_str()
            .filter(|page| !page.is_empty())
            .map(str::to_owned);
        if page_token.is_none() {
            break;
        }
    }
    Ok(series)
}

fn rfc3339(epoch: u64) -> String {
    Utc.timestamp_opt(epoch as i64, 0)
        .single()
        .map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_default()
}

/// Requests used since midnight Pacific, one total per quota series.
fn usage_params(start: u64, now: u64) -> Vec<(&'static str, String)> {
    vec![
        ("filter", format!("metric.type=\"serviceruntime.googleapis.com/quota/rate/net_usage\" AND resource.type=\"consumer_quota\" AND resource.labels.service=\"{SERVICE}\"")),
        ("interval.startTime", rfc3339(start)),
        ("interval.endTime", rfc3339(now)),
        ("aggregation.alignmentPeriod", format!("{}s", now.saturating_sub(start).max(60))),
        ("aggregation.perSeriesAligner", "ALIGN_SUM".into()),
    ]
}

/// The quota limits Google applies, latest value per limit.
fn limit_params(now: u64) -> Vec<(&'static str, String)> {
    vec![
        ("filter", format!("metric.type=\"serviceruntime.googleapis.com/quota/limit\" AND resource.type=\"consumer_quota\" AND resource.labels.service=\"{SERVICE}\"")),
        ("interval.startTime", rfc3339(now.saturating_sub(86_400))),
        ("interval.endTime", rfc3339(now)),
    ]
}

fn point_value(series: &Value) -> Option<f64> {
    let value = &series["points"].as_array()?.first()?["value"];
    value["int64Value"]
        .as_str()
        .and_then(|text| text.parse::<f64>().ok())
        .or_else(|| value["int64Value"].as_f64())
        .or_else(|| value["doubleValue"].as_f64())
}

/// A quota series' identity: its quota metric plus any dimension (such as the model).
fn series_key(series: &Value, skip: &[&str]) -> Option<(String, Vec<(String, String)>)> {
    let labels = series["metric"]["labels"].as_object()?;
    let metric = labels.get("quota_metric")?.as_str()?.to_owned();
    let mut dims: Vec<(String, String)> = labels
        .iter()
        .filter(|(key, _)| key.as_str() != "quota_metric" && !skip.contains(&key.as_str()))
        .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_owned())))
        .collect();
    dims.sort();
    Some((metric, dims))
}

/// One window per daily limit Google reports, with what's been used against it.
fn daily_windows(usage: &[Value], limits: &[Value], resets_at: u64) -> Vec<ProviderUsageWindow> {
    let mut used: BTreeMap<(String, Vec<(String, String)>), f64> = BTreeMap::new();
    for series in usage {
        if let (Some(key), Some(value)) = (series_key(series, &["method"]), point_value(series)) {
            *used.entry(key).or_default() += value;
        }
    }
    let mut windows = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for series in limits {
        let name = series["metric"]["labels"]["limit_name"]
            .as_str()
            .unwrap_or("")
            .to_ascii_lowercase();
        if !(name.contains("perday") || name.contains("per_day") || name.contains("per day")) {
            continue;
        }
        let (Some(key), Some(limit)) = (series_key(series, &["limit_name"]), point_value(series))
        else {
            continue;
        };
        // -1 means unlimited; 0 means this tier can't use it at all.
        if limit <= 0.0 || !seen.insert(key.clone()) {
            continue;
        }
        let spent = used.get(&key).copied().unwrap_or(0.0);
        windows.push(ProviderUsageWindow {
            label: window_label(&key),
            unit: Some("requests"),
            used_percent: Some((spent / limit * 100.0).min(100.0)),
            remaining: Some((limit - spent).max(0.0)),
            limit: Some(limit),
            resets_at: Some(resets_at),
            window_seconds: None,
            expired: false,
        });
    }
    windows.sort_by(|a, b| a.label.cmp(&b.label));
    windows
}

/// "Daily: generate content free tier requests · gemini-2.5-flash".
fn window_label((metric, dims): &(String, Vec<(String, String)>)) -> String {
    let name = metric
        .rsplit('/')
        .next()
        .unwrap_or(metric)
        .replace('_', " ");
    let mut label = format!("Daily: {name}");
    for (_, value) in dims {
        label.push_str(" · ");
        label.push_str(value);
    }
    label
}

/// Pacific offset from UTC in seconds at `epoch` (US daylight-saving rules).
fn pacific_offset(epoch: u64) -> i64 {
    let at = Utc
        .timestamp_opt(epoch as i64, 0)
        .single()
        .unwrap_or_default();
    let year = at.year();
    let sunday = |month, nth| {
        NaiveDate::from_weekday_of_month_opt(year, month, Weekday::Sun, nth)
            .and_then(|day| day.and_hms_opt(0, 0, 0))
            .map(|day| day.and_utc().timestamp())
            .unwrap_or(0)
    };
    // 2:00 local: 10:00 UTC in March (PST), 9:00 UTC in November (PDT).
    let starts = sunday(3, 2) + 10 * 3600;
    let ends = sunday(11, 1) + 9 * 3600;
    let now = epoch as i64;
    if now >= starts && now < ends {
        -7 * 3600
    } else {
        -8 * 3600
    }
}

/// The last midnight Pacific at or before `epoch`.
pub(super) fn pacific_midnight_before(epoch: u64) -> u64 {
    let offset = pacific_offset(epoch);
    let local = epoch as i64 + offset;
    (local - local.rem_euclid(86_400) - offset).max(0) as u64
}

/// The next midnight Pacific after `epoch`: when Gemini's daily quotas reset.
pub(super) fn next_pacific_midnight(epoch: u64) -> u64 {
    let offset = pacific_offset(epoch);
    let local = epoch as i64 + offset;
    let candidate = local - local.rem_euclid(86_400) + 86_400 - offset;
    // A daylight-saving change before midnight moves it by an hour.
    let later = pacific_offset(candidate as u64);
    (candidate + offset - later) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn midnight_pacific_follows_daylight_saving() {
        // 2026-11-24 04:00 UTC = 2026-11-23 20:00 PST → reset at 2026-11-24 08:00 UTC.
        let now = 1_795_492_800;
        assert_eq!(next_pacific_midnight(now), 1_795_507_200);
        assert_eq!(pacific_midnight_before(now), 1_795_507_200 - 86_400);
        // 2026-07-01 12:00 UTC = 05:00 PDT → reset at 2026-07-02 07:00 UTC.
        assert_eq!(next_pacific_midnight(1_782_907_200), 1_782_975_600);
        // 2026-03-08 06:00 UTC = 2026-03-07 22:00 PST; that night is still PST.
        assert_eq!(next_pacific_midnight(1_772_949_600), 1_772_956_800);
    }

    #[test]
    fn daily_limits_pair_with_their_usage() {
        let usage = [
            json!({"metric":{"labels":{"quota_metric":"generativelanguage.googleapis.com/generate_content_free_tier_requests","method":"a","model":"gemini-x"}},"points":[{"value":{"int64Value":"40"}}]}),
            json!({"metric":{"labels":{"quota_metric":"generativelanguage.googleapis.com/generate_content_free_tier_requests","method":"b","model":"gemini-x"}},"points":[{"value":{"int64Value":"10"}}]}),
        ];
        let limits = [
            json!({"metric":{"labels":{"quota_metric":"generativelanguage.googleapis.com/generate_content_free_tier_requests","limit_name":"GenerateRequestsPerDayPerProjectPerModel-FreeTier","model":"gemini-x"}},"points":[{"value":{"int64Value":"250"}}]}),
            json!({"metric":{"labels":{"quota_metric":"generativelanguage.googleapis.com/generate_content_free_tier_requests","limit_name":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier","model":"gemini-x"}},"points":[{"value":{"int64Value":"10"}}]}),
            json!({"metric":{"labels":{"quota_metric":"generativelanguage.googleapis.com/other","limit_name":"PerDay"}},"points":[{"value":{"int64Value":"-1"}}]}),
        ];
        let windows = daily_windows(&usage, &limits, 999);
        assert_eq!(windows.len(), 1);
        let window = &windows[0];
        assert_eq!(
            window.label,
            "Daily: generate content free tier requests · gemini-x"
        );
        assert_eq!(window.used_percent, Some(20.0));
        assert_eq!(window.remaining, Some(200.0));
        assert_eq!(window.resets_at, Some(999));
    }
}
