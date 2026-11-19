use std::{io::{Read, Write}, path::PathBuf, process::{Command, Stdio}};

use serde_json::Value;

const ORIGIN: &str = "https://api.typesafe.ai";
const MAX_BODY_BYTES: u64 = 65_536;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    Credential,
    RateLimit,
    Timeout,
    Unavailable,
    InvalidResponse,
}

impl Failure {
    pub fn code(self) -> &'static str {
        match self {
            Self::Credential => "credential",
            Self::RateLimit => "rate_limit",
            Self::Timeout => "timeout",
            Self::Unavailable => "unavailable",
            Self::InvalidResponse => "invalid_response",
        }
    }
}

fn curl() -> PathBuf {
    #[cfg(windows)]
    return PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into())).join(r"System32\curl.exe");
    #[cfg(not(windows))]
    PathBuf::from("/usr/bin/curl")
}

pub fn models(key: &str, timeout: u32) -> Result<Value, Failure> {
    request(&format!("{ORIGIN}/v1/models"), "=https", key, timeout, None)
}

pub fn evaluate(key: &str, timeout: u32, body: &Value) -> Result<Value, Failure> {
    request(&format!("{ORIGIN}/v1/systemone"), "=https", key, timeout, Some(body))
}

// The token travels via stdin. Disable curlrc, proxies and inherited overrides
// (including TLS and debugging settings). Curl verifies the system TLS trust.
fn request(url: &str, protocols: &str, key: &str, timeout: u32, body: Option<&Value>) -> Result<Value, Failure> {
    if key.is_empty() || key.len() > 2048 || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._~+/=".contains(&b)) {
        return Err(Failure::Credential);
    }
    let mut command = Command::new(curl());
    command.env_clear();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
        if let Some(root) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", root);
        }
    }
    command.args(["--disable", "--proto", protocols, "--noproxy", "*", "--silent",
        "--max-time", &timeout.to_string(), "--max-filesize", &MAX_BODY_BYTES.to_string(),
        "--write-out", "\n%{http_code}", "--config", "-", "--url", url]);
    let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn().map_err(|_| Failure::Unavailable)?;
    let written = {
        let mut stdin = child.stdin.take().ok_or(Failure::Unavailable)?;
        writeln!(stdin, "header = \"Authorization: Bearer {key}\"").and_then(|()| {
            if let Some(body) = body {
                // Quotes and backslashes in the JSON must survive curl's
                // config quoting. All payload strings are controlled ASCII.
                writeln!(stdin, "header = \"Content-Type: application/json\"")?;
                writeln!(stdin, "data-binary = {}", Value::String(body.to_string()))?;
            }
            Ok(())
        })
    };
    let mut stdout = Vec::new();
    let read = child.stdout.take().ok_or(Failure::Unavailable)?
        .take(MAX_BODY_BYTES + 5).read_to_end(&mut stdout);
    if read.is_err() || stdout.len() as u64 > MAX_BODY_BYTES + 4 {
        let _ = child.kill();
        let _ = child.wait();
        return Err(Failure::InvalidResponse);
    }
    let exit = child.wait().map_err(|_| Failure::Unavailable)?;
    if exit.code() == Some(28) {
        return Err(Failure::Timeout);
    }
    if written.is_err() || !exit.success() {
        return Err(Failure::Unavailable);
    }
    let (data, status) = stdout.split_at(stdout.len().checked_sub(4).ok_or(Failure::InvalidResponse)?);
    match status {
        b"\n200" => serde_json::from_slice(data).map_err(|_| Failure::InvalidResponse),
        b"\n401" | b"\n403" => Err(Failure::Credential),
        b"\n429" => Err(Failure::RateLimit),
        _ => Err(Failure::Unavailable),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::{BufRead, BufReader}, net::TcpListener, thread, time::Duration};
    use super::super::{configure, decide, Change, Mode, Policy, Signals};

    #[test]
    #[ignore = "requires local TCP and system curl"]
    fn configures_and_applies_choice_over_the_wire() {
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", server.local_addr().unwrap());
        let worker = thread::spawn(move || {
            for post in [false, true] {
                let (mut stream, _) = server.accept().unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut reader = BufReader::new(&mut stream);
                let mut headers = String::new();
                loop {
                    let mut line = String::new();
                    assert_ne!(reader.read_line(&mut line).unwrap(), 0);
                    if line == "\r\n" { break; }
                    headers.push_str(&line);
                }
                assert!(headers.contains("Authorization: Bearer fixture-token\r\n"));
                let body = if post {
                    assert!(headers.starts_with("POST /v1/systemone HTTP/"));
                    let size: usize = headers.lines().find_map(|line| line.strip_prefix("Content-Length: ")).unwrap().parse().unwrap();
                    let mut data = vec![0; size];
                    reader.read_exact(&mut data).unwrap();
                    let payload: Value = serde_json::from_slice(&data).unwrap();
                    assert_eq!(payload["model"], "jev-latest");
                    assert_eq!(payload["questions"]["route"]["type"], "choice");
                    assert_eq!(payload["state"], serde_json::json!({
                        "risk":"low","priority":"normal","scope":"small","policy":"balanced","available_efforts":["low","medium","high"],
                        "history":"fresh","ambiguous_failure":false,"lightweight_available":false
                    }));
                    r#"{"model":"jev-1.14.0","answers":{"route":{"type":"choice","choice":"low","confidence":0.93}},"usage":{"input_tokens":220,"output_tokens":9}}"#
                } else {
                    assert!(headers.starts_with("GET /v1/models HTTP/"));
                    r#"{"models":[{"name":"jev-latest","description":"stable","release_date":"2026-09-15"}]}"#
                };
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        let settings = configure(Change { mode: Mode::Active, policy: Policy::Balanced, timeout_secs: 2, consent: true, light_model: None }, |timeout| {
            request(&format!("{url}/v1/models"), "=http", "fixture-token", timeout, None)
        }).unwrap();
        let signals = Signals { risk: "low", priority: "normal", scope: "small", history: "fresh", ambiguous_failure: false };
        let trace = decide(&settings, &signals, &["low".into(), "medium".into(), "high".into()], false, |body| {
            request(&format!("{url}/v1/systemone"), "=http", "fixture-token", 2, Some(body)).map_err(Failure::code)
        });
        assert_eq!((trace.source.as_str(), trace.effort.as_deref(), trace.input_tokens), ("jev", Some("low"), Some(220)));
        worker.join().unwrap();
        assert_eq!(request(&url, "=http", "injected\nheader", 1, None), Err(Failure::Credential));
    }
}
