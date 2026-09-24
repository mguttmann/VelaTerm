//! Durable submission receipts prevent a lost acknowledgement from sending a prompt twice.

use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

pub const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS chat_submissions (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    id TEXT NOT NULL, fingerprint TEXT NOT NULL, outcome TEXT,
    PRIMARY KEY(session_id, id)
);";

pub enum Claim {
    New,
    Complete(Result<String, String>),
}

pub fn claim(conn: &Connection, session: &str, id: &str, payload: &[u8]) -> Result<Claim, String> {
    if !id.starts_with("msg-") || uuid::Uuid::parse_str(&id[4..]).is_err() {
        return Err("Invalid message identifier".into());
    }
    let fingerprint = format!("{:x}", Sha256::digest(payload));
    let inserted = conn.execute(
        "INSERT OR IGNORE INTO chat_submissions(session_id,id,fingerprint) VALUES (?1,?2,?3)",
        params![session, id, fingerprint],
    ).map_err(|e| e.to_string())?;
    if inserted == 1 { return Ok(Claim::New); }
    let (saved, outcome): (String, Option<String>) = conn.query_row(
        "SELECT fingerprint,outcome FROM chat_submissions WHERE session_id=?1 AND id=?2",
        params![session, id], |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(|e| e.to_string())?;
    if saved != fingerprint { return Err("Message identifier already belongs to another submission".into()); }
    match outcome {
        Some(value) => {
            let parsed: serde_json::Value = serde_json::from_str(&value).map_err(|e| e.to_string())?;
            if parsed.get("dispatching").is_some() { return Err("chat_submission_pending".into()); }
            if let Some(error) = parsed.get("rejected").and_then(serde_json::Value::as_str) {
                Ok(Claim::Complete(Err(error.to_string())))
            } else { serde_json::from_value(parsed).map(Claim::Complete).map_err(|e| e.to_string()) }
        },
        // The process may have stopped after writing to the agent but before saving the receipt.
        // Keep this unresolved instead of guessing that another write would be safe.
        None => Err("chat_submission_pending".into()),
    }
}

pub fn finish(conn: &Connection, session: &str, id: &str, outcome: &Result<String, String>) -> Result<(), String> {
    let value = serde_json::to_string(outcome).map_err(|e| e.to_string())?;
    conn.execute("UPDATE chat_submissions SET outcome=?3 WHERE session_id=?1 AND id=?2 AND outcome IS NULL",
        params![session, id, value]).map_err(|e| e.to_string())?;
    Ok(())
}

/// The dispatch marker cannot be overwritten by a delayed queued acknowledgement. Unidentified
/// internal messages have no receipt and remain compatible with the ordinary engine paths.
pub fn begin_dispatch(conn: &Connection, session: &str, id: &str) -> Result<(), String> {
    let saved: Option<Option<String>> = conn.query_row(
        "SELECT outcome FROM chat_submissions WHERE session_id=?1 AND id=?2", params![session,id],
        |row| row.get(0)).optional().map_err(|e| e.to_string())?;
    let Some(saved) = saved else { return Ok(()); };
    let queued = serde_json::to_string(&Ok::<_, String>("queued")).unwrap();
    if saved.as_ref().is_some_and(|value| value != &queued) { return Err("chat_submission_pending".into()); }
    let changed = conn.execute("UPDATE chat_submissions SET outcome='{\"dispatching\":true}' WHERE session_id=?1 AND id=?2 AND outcome IS ?3",
        params![session,id,saved]).map_err(|e| e.to_string())?;
    if changed != 1 { return Err("chat_submission_pending".into()); }
    Ok(())
}

pub fn finish_dispatch(conn: &Connection, session: &str, id: &str, receipt: &str) -> Result<(), String> {
    let value = serde_json::to_string(&Ok::<_, String>(receipt)).map_err(|e| e.to_string())?;
    conn.execute("UPDATE chat_submissions SET outcome=?3 WHERE session_id=?1 AND id=?2 AND outcome='{\"dispatching\":true}'",
        params![session,id,value]).map_err(|e| e.to_string())?;
    Ok(())
}

/// The caller first confirms that the process is gone. A queue receipt proves dispatch never began;
/// an unknown write, older error or different payload is never converted into a retryable rejection.
pub fn recover_queued(conn: &Connection, session: &str, id: &str, payload: &[u8]) -> Result<bool, String> {
    let fingerprint = format!("{:x}", Sha256::digest(payload));
    let queued = serde_json::to_string(&Ok::<_, String>("queued")).unwrap();
    let rejected = serde_json::json!({"rejected":"The queued task was not dispatched before the agent stopped"}).to_string();
    let changed = conn.execute("UPDATE chat_submissions SET outcome=?5 WHERE session_id=?1 AND id=?2 AND fingerprint=?3 AND outcome=?4",
        params![session,id,fingerprint,queued,rejected]).map_err(|e| e.to_string())?;
    Ok(changed == 1)
}

/// A rejected receipt records direct evidence that dispatch never began. Legacy errors remain opaque.
pub fn finish_rejected(conn: &Connection, session: &str, id: &str, error: &str) -> Result<(), String> {
    let value = serde_json::json!({"rejected":error}).to_string();
    let changed = conn.execute("UPDATE chat_submissions SET outcome=?3 WHERE session_id=?1 AND id=?2 AND outcome IS NULL",
        params![session, id, value]).map_err(|e| e.to_string())?;
    if changed != 1 { return Err("chat_submission_pending".into()); }
    Ok(())
}

/// Only an explicit resubmission may reclaim a known rejection. The compare-and-swap admits one writer;
/// a concurrent retry observes pending. Fingerprint mismatches, unknown writes and legacy Err stay closed.
pub fn claim_retry(conn: &Connection, session: &str, id: &str, payload: &[u8]) -> Result<Claim, String> {
    let existing = claim(conn, session, id, payload)?;
    if !matches!(existing, Claim::Complete(Err(_))) { return Ok(existing); }
    let fingerprint = format!("{:x}", Sha256::digest(payload));
    let saved: String = conn.query_row("SELECT outcome FROM chat_submissions WHERE session_id=?1 AND id=?2 AND fingerprint=?3",
        params![session, id, fingerprint], |row| row.get(0)).map_err(|_| "chat_submission_pending".to_string())?;
    let tagged: serde_json::Value = serde_json::from_str(&saved).map_err(|e| e.to_string())?;
    if tagged.get("rejected").and_then(serde_json::Value::as_str).is_none() { return Ok(existing); }
    let changed = conn.execute("UPDATE chat_submissions SET outcome=NULL WHERE session_id=?1 AND id=?2 AND fingerprint=?3 AND outcome=?4",
        params![session, id, fingerprint, saved]).map_err(|e| e.to_string())?;
    if changed != 1 { return Err("chat_submission_pending".into()); }
    crate::diagnostics::record("INFO", "agent_submission_retry", serde_json::json!({"sessionId":session,"messageId":id,"status":"reclaimed"}));
    Ok(Claim::New)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY); INSERT INTO sessions VALUES ('s');").unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn
    }

    #[test]
    fn queued_recovery_never_crosses_the_dispatch_marker_or_overwrites_sent() {
        let conn = database();
        let id = format!("msg-{}", uuid::Uuid::new_v4());
        claim(&conn, "s", &id, b"prompt").unwrap();
        finish(&conn, "s", &id, &Ok("queued".into())).unwrap();
        assert!(!recover_queued(&conn, "s", &id, b"other").unwrap());
        assert!(recover_queued(&conn, "s", &id, b"prompt").unwrap());
        assert!(matches!(claim_retry(&conn, "s", &id, b"prompt").unwrap(), Claim::New));
        begin_dispatch(&conn, "s", &id).unwrap();
        finish(&conn, "s", &id, &Ok("queued".into())).unwrap();
        assert!(claim(&conn, "s", &id, b"prompt").is_err());
        assert!(!recover_queued(&conn, "s", &id, b"prompt").unwrap());
        assert!(begin_dispatch(&conn, "s", &id).is_err());
        finish_dispatch(&conn, "s", &id, "sent").unwrap();
        finish(&conn, "s", &id, &Ok("queued".into())).unwrap();
        assert!(matches!(claim(&conn, "s", &id, b"prompt").unwrap(), Claim::Complete(Ok(value)) if value == "sent"));
        assert!(!recover_queued(&conn, "s", &id, b"prompt").unwrap());
    }

    #[test]
    fn explicit_retry_reclaims_only_proven_rejections() {
        let conn = database();
        let id = format!("msg-{}", uuid::Uuid::new_v4());
        assert!(matches!(claim(&conn, "s", &id, b"prompt").unwrap(), Claim::New));
        finish_rejected(&conn, "s", &id, "not started").unwrap();
        assert!(claim_retry(&conn, "s", &id, b"different").is_err());
        assert!(matches!(claim(&conn, "s", &id, b"prompt").unwrap(), Claim::Complete(Err(_))));
        assert!(matches!(claim_retry(&conn, "s", &id, b"prompt").unwrap(), Claim::New));
        assert!(claim_retry(&conn, "s", &id, b"prompt").is_err(), "a concurrent caller cannot reclaim pending");
        finish(&conn, "s", &id, &Err("legacy unknown failure".into())).unwrap();
        assert!(matches!(claim_retry(&conn, "s", &id, b"prompt").unwrap(), Claim::Complete(Err(_))));
        assert!(finish_rejected(&conn, "s", &id, "cannot relabel old evidence").is_err());
    }

    #[test]
    fn duplicate_claims_never_dispatch_and_receipts_survive_reopening() {
        let path = std::env::temp_dir().join(format!("vlx-submission-{}.db", uuid::Uuid::new_v4()));
        let id = format!("msg-{}", uuid::Uuid::new_v4());
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY); INSERT INTO sessions VALUES ('s');").unwrap();
            conn.execute_batch(SCHEMA).unwrap();
            assert!(matches!(claim(&conn, "s", &id, b"prompt").unwrap(), Claim::New));
            assert!(matches!(claim(&conn, "s", &id, b"prompt"), Err(error) if error == "chat_submission_pending"));
            finish(&conn, "s", &id, &Ok("queued".into())).unwrap();
        }
        let conn = Connection::open(&path).unwrap();
        assert!(matches!(claim(&conn, "s", &id, b"prompt").unwrap(), Claim::Complete(Ok(value)) if value == "queued"));
        assert!(claim(&conn, "s", &id, b"different prompt").is_err());
        drop(conn);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn rejections_are_repeatable_and_invalid_identifiers_are_not_claimed() {
        let conn = database();
        assert!(claim(&conn, "s", "arbitrary", b"prompt").is_err());
        let id = format!("msg-{}", uuid::Uuid::new_v4());
        assert!(matches!(claim(&conn, "s", &id, b"prompt").unwrap(), Claim::New));
        finish(&conn, "s", &id, &Err("No running turn".into())).unwrap();
        assert!(matches!(claim(&conn, "s", &id, b"prompt").unwrap(), Claim::Complete(Err(value)) if value == "No running turn"));
    }
}
