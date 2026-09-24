//! Short-lived Cursor hook transport. Never initialize application or GUI state here.

use std::io::{Read, Write};
use std::time::Duration;

const MAX_PAYLOAD: u64 = 1024 * 1024;
const STDIN_TIMEOUT: Duration = Duration::from_secs(1);
const HTTP_TIMEOUT: Duration = Duration::from_secs(3);

fn callback_url(base: &str, sid: &str, token: &str, event: &str) -> Option<url::Url> {
    if !matches!(event, "boot" | "working" | "waiting") || sid.is_empty() || token.is_empty() {
        return None;
    }
    let mut url = url::Url::parse(base).ok()?;
    // The injected hook server uses IPv4 loopback. Avoid DNS, redirects, and inherited proxies.
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port().is_none()
        || !url.username().is_empty() || url.password().is_some() || url.path() != "/"
        || url.query().is_some() || url.fragment().is_some()
    {
        return None;
    }
    url.path_segments_mut().ok()?.extend(["hook", sid]);
    url.query_pairs_mut().append_pair("t", token).append_pair("e", event);
    Some(url)
}

fn read_payload(input: impl Read) -> Option<Vec<u8>> {
    let mut body = Vec::new();
    input.take(MAX_PAYLOAD + 1).read_to_end(&mut body).ok()?;
    if body.len() as u64 > MAX_PAYLOAD { return None; }
    // Forward the original bytes, but do not send truncated or malformed hook data.
    let value: serde_json::Value = serde_json::from_slice(&body).ok()?;
    value.is_object().then_some(body)
}

fn bounded_payload(input: impl Read + Send + 'static) -> Option<Vec<u8>> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new().name("cursor-hook-stdin".into()).spawn(move || {
        let _ = tx.send(read_payload(input));
    }).ok()?;
    rx.recv_timeout(STDIN_TIMEOUT).ok().flatten()
}

fn forward(url: &url::Url, body: &[u8]) {
    let agent = ureq::AgentBuilder::new()
        .try_proxy_from_env(false)
        .redirects(0)
        .timeout(HTTP_TIMEOUT)
        .build();
    // The response body is irrelevant. Status, connection, and timeout failures are all fail-open.
    let _ = agent.post(url.as_str()).set("Content-Type", "application/json").send_bytes(body);
}

/// Always exit successfully, including with missing environment or a pipe whose writer never closes.
/// Explicit process exit also ends a blocked stdin worker without waiting for its inherited handle.
pub fn run(args: &[String]) -> ! {
    let url = args.get(2).and_then(|event| callback_url(
        &std::env::var("VLX_SPAWN_URL").unwrap_or_default(),
        &std::env::var("VLX_SESSION_ID").unwrap_or_default(),
        &std::env::var("VLX_TOKEN").unwrap_or_default(), event,
    ));
    if let Some(url) = url {
        if let Some(body) = bounded_payload(std::io::stdin()) { forward(&url, &body); }
    }
    let _ = std::io::stdout().write_all(b"{}\n");
    let _ = std::io::stdout().flush();
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callback_requires_the_injected_local_server_and_known_event() {
        for base in ["", "https://127.0.0.1:32109", "http://example.com:32109",
            "http://127.0.0.1", "http://127.0.0.1:32109/other", "http://user@127.0.0.1:32109",
            "http://127.0.0.1:32109/?token=other"]
        {
            assert!(callback_url(base, "s", "t", "working").is_none(), "{base}");
        }
        assert!(callback_url("http://127.0.0.1:32109", "s", "t", "asking").is_none());
        assert!(callback_url("http://127.0.0.1:32109", "", "t", "boot").is_none());
        let url = callback_url("http://127.0.0.1:32109/", "s/a", "t&x=1", "working").unwrap();
        assert_eq!(url.path(), "/hook/s%2Fa");
        assert_eq!(url.query_pairs().collect::<Vec<_>>(), vec![("t".into(), "t&x=1".into()), ("e".into(), "working".into())]);
    }

    #[test]
    fn payload_preserves_json_bytes_and_rejects_invalid_or_oversized_input() {
        let body = b"{\n \"prompt\": \"hello\", \"conversation_id\": \"123\" }\n";
        assert_eq!(read_payload(&body[..]).unwrap(), body);
        for body in [b"".as_slice(), b"{", b"[]", b"null", b"{}{}", b"{\"x\":\"\xff\"}"] {
            assert!(read_payload(body).is_none());
        }
        let mut large = vec![b' '; MAX_PAYLOAD as usize + 1];
        large[..2].copy_from_slice(b"{}");
        assert!(read_payload(&large[..]).is_none());
        assert!(read_payload(&large[..MAX_PAYLOAD as usize]).is_some());
    }
}
