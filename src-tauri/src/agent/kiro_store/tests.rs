//! Text fixtures preserve the audited native shapes; identifiers and content are synthetic.
//! Fault mutations test rejection, not compatibility with an unobserved Kiro tool schema.

use super::*;
use serde_json::json;
use rusqlite::Connection;

pub(crate) struct Fixture {
    pub dir: PathBuf,
    pub roots: Roots,
}
impl Fixture {
    pub(crate) fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("velaterm-kiro-test-{}",uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("sessions")).unwrap();
        Self { roots: Roots { sessions: dir.join("sessions"), database: Some(dir.join("native.sqlite3")) }, dir }
    }
    pub(crate) fn pair(&self, id: &str, cwd: &Path, prompt: &str) {
        let (meta, log) = pair_values(id, cwd, prompt);
        self.write_pair(id, &meta, &log);
    }
    fn write_pair(&self, id: &str, meta: &Value, log: &[Value]) {
        std::fs::write(self.roots.sessions.join(format!("{id}.json")),meta.to_string()).unwrap();
        std::fs::write(self.roots.sessions.join(format!("{id}.jsonl")),log.iter().map(Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
    }
    pub(crate) fn db(&self) -> Connection {
        let conn = Connection::open(self.roots.database.as_ref().unwrap()).unwrap();
        conn.execute_batch("CREATE TABLE IF NOT EXISTS conversations_v2(key TEXT NOT NULL, conversation_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(key,conversation_id)); CREATE TABLE IF NOT EXISTS conversations(key TEXT PRIMARY KEY,value TEXT);").unwrap();
        conn
    }
    pub(crate) fn insert(&self, conn: &Connection, id: &str, cwd: &Path, prompt: &str) {
        conn.execute("INSERT OR REPLACE INTO conversations_v2 VALUES (?1,?2,?3,1000,2000)",rusqlite::params![cwd.to_string_lossy(),id,sqlite_value(id,prompt).to_string()]).unwrap();
    }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.dir); } }

pub(crate) fn pair_values(id: &str, cwd: &Path, prompt: &str) -> (Value, Vec<Value>) {
    let user = json!({"version":"v1","kind":"Prompt","data":{"message_id":"user-one","content":[{"kind":"text","data":prompt}],"meta":{"timestamp":1700000000,"additionalContext":"NOT USER TEXT"}}});
    let assistant = json!({"version":"v1","kind":"AssistantMessage","data":{"message_id":"assistant-one","content":[{"kind":"text","data":"Reply"}]}});
    let meta = json!({"session_id":id,"cwd":cwd,"title":null,"created_at":"2023-11-14T22:13:19Z","updated_at":"2023-11-14T22:13:25Z","session_state":{"version":"v1","rts_model_state":{"conversation_id":id,"model_info":{"model_id":"native-model","context_window_tokens":200000},"context_usage_percentage":12.5},"conversation_metadata":{"user_turn_metadatas":[{"message_ids":["user-one","assistant-one"],"end_timestamp":"2023-11-14T22:13:24.123Z","input_token_count":0,"output_token_count":0,"result":{"Ok":{"id":"response-other-namespace","role":"assistant","content":assistant["data"]["content"],"meta":{"timestamp":1700000004}}}}]}}});
    (meta,vec![user,assistant])
}
pub(crate) fn sqlite_value(id: &str, prompt: &str) -> Value {
    json!({"conversation_id":id,"next_message":null,"latest_summary":null,"model_info":{"model_id":"native-model","context_window_tokens":200000},"history":[{"user":{"content":{"Prompt":{"prompt":prompt}},"timestamp":"2023-11-14T22:13:20Z","additional_context":"NOT USER TEXT","images":null},"assistant":{"Response":{"message_id":"sqlite-response","content":"Reply"}},"request_metadata":{"context_usage_percentage":12.5,"request_start_timestamp_ms":1700000000166i64,"stream_end_timestamp_ms":1700000002438i64,"total_tokens":null}}]})
}

#[test]
fn paired_text_keeps_message_identity_time_and_unknown_usage() {
    let f = Fixture::new(); f.pair("one",&f.dir,"Question");
    let s = read_from(&f.roots,"one").unwrap();
    assert_eq!(s.context.percent,Some(12.5));
    let m = s.messages.unwrap(); assert_eq!(m.len(),2);
    assert_eq!(m[0].text,"Question"); assert_eq!(m[0].timestamp.as_deref(),Some("2023-11-14T22:13:20Z"));
    assert_eq!(m[1].timestamp,None); assert_eq!(m[1].native_id.as_deref(),Some("assistant-one"));
    assert_eq!(m[1].text,"Reply");
}

#[test]
fn empty_orphan_damaged_unknown_and_nontext_are_distinct() {
    let f = Fixture::new(); let (mut meta,mut log)=pair_values("one",&f.dir,"Question");
    meta["session_state"]["conversation_metadata"]["user_turn_metadatas"]=json!([]);
    f.write_pair("one",&meta,&[]); assert!(read_from(&f.roots,"one").unwrap().messages.unwrap().is_empty());
    std::fs::remove_file(f.roots.sessions.join("one.jsonl")).unwrap();
    assert!(read_from(&f.roots,"one").unwrap_err().contains("incomplete"));
    f.write_pair("one",&meta,&log);std::fs::write(f.roots.sessions.join("one.jsonl"),"{").unwrap();
    assert!(read_from(&f.roots,"one").unwrap().messages.unwrap_err().contains("damaged"));
    log[0]["version"]=json!("future");f.write_pair("one",&meta,&log);
    assert!(read_from(&f.roots,"one").unwrap().messages.unwrap_err().contains("version"));
    log[0]["version"]=json!("v1");log[0]["kind"]=json!("ToolResults");f.write_pair("one",&meta,&log);
    assert!(read_from(&f.roots,"one").unwrap().messages.unwrap_err().contains("event type"));
    meta["session_state"]["version"]=json!("future");f.write_pair("one",&meta,&[]);
    assert!(read_from(&f.roots,"one").unwrap_err().contains("metadata version"));
}

#[test]
fn rejects_id_aliases_duplicate_messages_and_cross_turn_references() {
    let f=Fixture::new();let (mut m,l)=pair_values("one",&f.dir,"Q");
    m["session_id"]=json!("different");f.write_pair("one",&m,&l);assert!(read_from(&f.roots,"one").is_err());
    m["session_id"]=json!("one");m["session_state"]["rts_model_state"]["conversation_id"]=json!("different");f.write_pair("one",&m,&l);assert!(read_from(&f.roots,"one").is_err());
    let (mut m,mut l)=pair_values("one",&f.dir,"Q");l.push(l[0].clone());f.write_pair("one",&m,&l);assert!(read_from(&f.roots,"one").unwrap().messages.unwrap_err().contains("duplicate"));
    l.pop();m["session_state"]["conversation_metadata"]["user_turn_metadatas"][0]["message_ids"]=json!(["response-other-namespace"]);f.write_pair("one",&m,&l);assert!(read_from(&f.roots,"one").unwrap().messages.unwrap_err().contains("missing message"));
    assert!(read_from(&f.roots,"../one").is_err());
}

#[test]
fn sqlite_text_is_readonly_and_creation_time_is_not_a_message_cutoff() {
    let f=Fixture::new();let db=f.db();f.insert(&db,"one",&f.dir,"Question");drop(db);
    let before=std::fs::read(f.roots.database.as_ref().unwrap()).unwrap();
    let s=read_from(&f.roots,"one").unwrap();assert_eq!(s.messages.unwrap().len(),2);
    assert_eq!(std::fs::read(f.roots.database.as_ref().unwrap()).unwrap(),before);
    assert!(!f.dir.join("native.sqlite3-shm").exists());assert!(!f.dir.join("native.sqlite3-wal").exists());
}

#[test]
fn duplicate_sources_require_matching_content_and_project() {
    let f=Fixture::new();f.pair("one",&f.dir,"Question");let db=f.db();f.insert(&db,"one",&f.dir,"Question");
    let (sessions,warnings)=discover(&f.roots,&f.dir);assert!(warnings.is_empty(),"{warnings:?}");assert_eq!(sessions.len(),1);
    let first=read_from(&f.roots,"one").unwrap().revision;
    f.insert(&db,"one",&f.dir,"Different");assert!(read_from(&f.roots,"one").unwrap_err().contains("conflicting sources"));
    f.insert(&db,"one",&f.dir,"Question");f.insert(&db,"one",&f.dir.join("other"),"Question");
    assert!(read_from(&f.roots,"one").unwrap_err().contains("project identities"));
    assert!(!first.is_empty());
}

#[test]
fn discovery_isolates_projects_and_keeps_other_valid_records() {
    let f=Fixture::new();f.pair("one",&f.dir,"First");f.pair("two",&f.dir,"Second");f.pair("foreign",&f.dir.join("other"),"Private other project");
    std::fs::write(f.roots.sessions.join("broken.json"),"{").unwrap();
    let (sessions,warnings)=discover(&f.roots,&f.dir);assert_eq!(sessions.len(),2);assert!(!warnings.is_empty());
    assert_eq!(sessions.iter().map(|s|s.id.as_str()).collect::<Vec<_>>(),vec!["one","two"]);
}

#[test]
fn content_revision_changes_even_for_same_length_rewrite() {
    let f=Fixture::new();f.pair("one",&f.dir,"First");let before=read_from(&f.roots,"one").unwrap().revision;
    f.pair("one",&f.dir,"Other");assert_ne!(read_from(&f.roots,"one").unwrap().revision,before);
}

#[test]
fn malformed_times_and_context_values_do_not_become_defaults() {
    let f=Fixture::new();let (mut m,l)=pair_values("one",&f.dir,"Q");
    m["created_at"]=json!("2023-02-30T12:00:00Z");f.write_pair("one",&m,&l);assert!(read_from(&f.roots,"one").is_err());
    m["created_at"]=json!("2023-11-14T23:13:19+01:00");f.write_pair("one",&m,&l);assert!(read_from(&f.roots,"one").is_ok());
    m["session_state"]["rts_model_state"]["context_usage_percentage"]=json!(101);f.write_pair("one",&m,&l);assert!(read_from(&f.roots,"one").is_err());
}

#[test]
fn damaged_duplicate_database_identity_is_not_hidden_by_valid_file() {
    let f=Fixture::new();f.pair("one",&f.dir,"Question");let db=f.db();
    f.insert(&db,"one",&f.dir,"Question");f.insert(&db,"two",&f.dir,"Other");
    db.execute("UPDATE conversations_v2 SET value='{' WHERE conversation_id='one'",[]).unwrap();
    let (sessions,warnings)=discover(&f.roots,&f.dir);
    assert_eq!(sessions.iter().map(|s|s.id.as_str()).collect::<Vec<_>>(),vec!["two"]);
    assert!(warnings.iter().any(|w|w.contains("invalid JSON")));
    assert!(read_from(&f.roots,"one").is_err());
    assert!(read_from(&f.roots,"two").unwrap().messages.is_ok());
}

#[test]
fn database_project_and_inner_identity_must_agree() {
    let f=Fixture::new();let db=f.db();let mut value=sqlite_value("one","Q");
    value["history"][0]["user"]["env_context"]=json!({"env_state":{"current_working_directory":f.dir.join("other")}});
    db.execute("INSERT INTO conversations_v2 VALUES(?1,'one',?2,1000,2000)",rusqlite::params![f.dir.to_string_lossy(),value.to_string()]).unwrap();
    assert!(read_from(&f.roots,"one").unwrap_err().contains("project identities"));
    value["history"][0]["user"]["env_context"]["env_state"]["current_working_directory"]=json!(f.dir);
    value["conversation_id"]=json!("different");
    db.execute("UPDATE conversations_v2 SET value=?1",[value.to_string()]).unwrap();
    assert!(read_from(&f.roots,"one").unwrap_err().contains("conversation identities"));
}

/// Explicit local audit only: never print identifiers, paths, bodies, parameters, or database bytes.
#[test]
#[ignore = "requires the previously audited local native stores; reads structure only"]
fn native_kiro_readonly_structure_audit() {
    fn fingerprint(roots: &Roots) -> Vec<(PathBuf,String)> {
        let mut paths=Vec::new();
        if let Ok(entries)=std::fs::read_dir(&roots.sessions) {
            for e in entries {let p=e.unwrap().path();if matches!(p.extension().and_then(|s|s.to_str()),Some("json"|"jsonl")){paths.push(p);}}
        }
        if let Some(db)=&roots.database {
            for suffix in ["","-wal","-shm","-journal"] {let mut p=db.as_os_str().to_os_string();p.push(suffix);let p=PathBuf::from(p);if p.exists(){paths.push(p);}}
        }
        paths.sort();paths.into_iter().map(|p| {let bytes=std::fs::read(&p).unwrap();(p,revision(&[&bytes]))}).collect()
    }
    let roots=Roots::native().unwrap();let before=fingerprint(&roots);let mut count=0;let mut empty=0;let mut messages=0;
    let mut ids=HashSet::new();
    for (p,_) in &before {if p.extension().and_then(|s|s.to_str())==Some("json"){ids.insert(p.file_stem().unwrap().to_str().unwrap().to_string());}}
    for (_,row) in sqlite(&roots,None).unwrap() {ids.insert(row.expect("Native database structure must match audited shape").id);}
    let fixture=Fixture::new();
    let app_db=crate::db::Db::open(&fixture.dir.join("app.db")).unwrap();
    let ctx=crate::host::AppCtx::Headless(std::sync::Arc::new(crate::host::HeadlessHost::new(fixture.dir.clone(),app_db)));
    for id in ids {
        let session=read_from(&roots,&id).expect("Native identity must resolve without conflict");
        let m=session.messages.expect("Native events must match the audited text shape");count+=1;messages+=m.len();if m.is_empty(){empty+=1;}
        let local_id={
            let conn=ctx.db().conn.lock().unwrap();
            let project=crate::db::repo::create_virtual_project(&conn,"Native format audit").unwrap();
            let record=crate::db::repo::create_session(&conn,&project.id,None,"Audit",crate::models::SessionKind::Kiro,None,None,None,None,None).unwrap();
            crate::db::repo::set_agent_session_id(&conn,&record.id,&id,crate::models::SessionKind::Kiro).unwrap();record.id
        };
        let transcript=crate::command_core::read_agent_transcript(&ctx,&local_id).expect("Native transcript API must resolve");
        let chat=crate::command_core::read_agent_chat(&ctx,&local_id).expect("Native read-only conversation API must resolve");
        assert!(transcript.len()==m.len() && chat.len()==m.len(),"Native message boundaries changed across APIs");
        assert!(transcript.iter().zip(&m).all(|(a,b)| a.text==b.text && a.timestamp==b.timestamp));
        assert!(chat.iter().enumerate().all(|(index,event)| event.index==index && event.text.as_deref()==Some(m[index].text.as_str())));
        let stats=crate::command_core::agent_turn_stats(&ctx,&local_id).expect("Native Info API must resolve");
        assert!(stats.model==session.context.model && stats.context_limit==session.context.limit && stats.context_percent==session.context.percent);
        assert!(stats.context_tokens.is_none() && stats.total_tokens.is_none() && stats.tools_used.is_none() && stats.generation_tokens_per_second.is_none());
    }
    assert!(count>0,"Native audit requires existing samples");
    assert!(before==fingerprint(&roots),"Native files or sidecar set changed during the audit");
    println!("native_structure sessions={count} empty={empty} text_messages={messages} source_files={} unchanged=true",before.len());
}

#[test]
fn sqlite_tool_activity_is_reported_instead_of_returning_partial_text() {
    let f=Fixture::new();let db=f.db();let mut value=sqlite_value("one","Q");
    // A nonempty unverified field is only a rejection case, never a tool compatibility fixture.
    value["history"][0]["request_metadata"]["tool_use_ids_and_names"]=json!([null]);
    db.execute("INSERT INTO conversations_v2 VALUES(?1,'one',?2,1000,2000)",rusqlite::params![f.dir.to_string_lossy(),value.to_string()]).unwrap();
    let session=read_from(&f.roots,"one").unwrap();
    assert_eq!(session.context.percent,Some(12.5));
    assert!(session.messages.unwrap_err().contains("tool activity"));
    value["history"][0]["request_metadata"]["tool_use_ids_and_names"]=json!([]);
    let row=value["history"][0].clone();value["history"].as_array_mut().unwrap().push(row);
    db.execute("UPDATE conversations_v2 SET value=?1",[value.to_string()]).unwrap();
    assert!(read_from(&f.roots,"one").unwrap().messages.unwrap_err().contains("duplicate assistant message ID"));
}
