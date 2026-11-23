//! "Send a report" from the app itself (the cover over a server that won't start, Preferences › Activity): the one
//! place a report goes without the server, which may be down or out of reach. The page builds the report, shows it in
//! full, and this posts exactly that JSON.

use serde::Serialize;
use std::time::Duration;

/// The problem report contract's limit.
pub const MAX_BYTES: usize = 256 * 1024;
const DEFAULT_URL: &str = "https://telemetry.agentes.chat/v1/problem-report";
const TIMEOUT: Duration = Duration::from_secs(15);

/// Where reports go: the app process's `PROBLEM_REPORT_URL` when set (`off` turns sending off), else agentes.chat's.
fn target() -> Option<String> {
    match std::env::var("PROBLEM_REPORT_URL") {
        Ok(url) if url.trim() == "off" => None,
        Ok(url) if url.trim().is_empty() => Some(DEFAULT_URL.into()),
        Ok(url) => Some(url),
        Err(_) => Some(DEFAULT_URL.into()),
    }
}

/// A body this sends: a JSON object within the contract's size.
pub fn check(json: &str) -> Result<(), &'static str> {
    if json.len() > MAX_BYTES {
        return Err("too_large");
    }
    match serde_json::from_str::<serde_json::Value>(json) {
        Ok(v) if v.is_object() => Ok(()),
        _ => Err("bad_request"),
    }
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Sent {
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    /// `off`, `too_large`, `bad_request`, `rate_limited`, `refused` or `unreachable`.
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after_s: Option<u64>,
}

fn failed(error: &'static str) -> Sent {
    Sent { error: Some(error), ..Sent::default() }
}

/// Whether sending is on (the cover shows Copy only when it isn't).
#[tauri::command]
pub fn problem_report_on(webview: tauri::Webview) -> Result<bool, String> {
    crate::local_server::app_window(&webview, &["main-cover", "prefs"])?;
    Ok(target().is_some())
}

#[tauri::command]
pub async fn problem_report_send(webview: tauri::Webview, json: String) -> Result<Sent, String> {
    crate::local_server::app_window(&webview, &["main-cover", "prefs"])?;
    if let Err(e) = check(&json) {
        return Ok(failed(e));
    }
    let Some(url) = target() else { return Ok(failed("off")) };
    tauri::async_runtime::spawn_blocking(move || {
        let agent = ureq::AgentBuilder::new().timeout(TIMEOUT).redirects(0).build();
        match agent.post(&url).set("Content-Type", "application/json").send_string(&json) {
            Ok(res) => {
                let id = res
                    .into_string()
                    .ok()
                    .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                    .and_then(|v| v["id"].as_str().map(str::to_string));
                match id {
                    Some(id) => Sent { id: Some(id), ..Sent::default() },
                    None => failed("refused"),
                }
            }
            Err(ureq::Error::Status(429, res)) => Sent {
                error: Some("rate_limited"),
                retry_after_s: res.header("retry-after").and_then(|s| s.parse().ok()).or(Some(60)),
                ..Sent::default()
            },
            Err(ureq::Error::Status(code, _)) if code < 500 => failed("refused"),
            Err(_) => failed("unreachable"),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_more_than_the_contract_and_what_isnt_an_object() {
        let big = format!("{{\"note\":\"{}\"}}", "x".repeat(MAX_BYTES));
        assert_eq!(check(&big), Err("too_large"));
        assert_eq!(check("[1]"), Err("bad_request"));
        assert_eq!(check("not json"), Err("bad_request"));
        assert_eq!(check("{\"format\":1,\"source\":\"desktop\",\"place\":\"desktop_server\"}"), Ok(()));
    }
}
