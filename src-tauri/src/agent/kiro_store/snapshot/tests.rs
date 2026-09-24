use super::*;

#[test]
fn wal_snapshot_reads_committed_frames_without_changing_native_files() {
    let f=crate::agent::kiro_store::tests::Fixture::new();
    let db=f.db();db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;").unwrap();
    f.insert(&db,"one",&f.dir,"Uncheckpointed text");
    let path=f.roots.database.as_ref().unwrap();
    let before=[path.clone(),sidecar(path,"-wal"),sidecar(path,"-shm")].map(|p| fs::read(p).unwrap());
    let temporary;
    {
        let copy=database(path).unwrap();temporary=copy._directory.0.clone();
        let text:String=copy.conn.query_row("SELECT value FROM conversations_v2 WHERE conversation_id='one'",[],|r|r.get(0)).unwrap();
        assert!(text.contains("Uncheckpointed text"));
        assert!(temporary.exists());
    }
    assert!(!temporary.exists());
    let after=[path.clone(),sidecar(path,"-wal"),sidecar(path,"-shm")].map(|p| fs::read(p).unwrap());
    assert_eq!(before,after);
}

#[test]
fn concurrent_changes_are_bounded_and_do_not_produce_a_mixed_snapshot() {
    let f=crate::agent::kiro_store::tests::Fixture::new();let db=f.db();
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;").unwrap();
    let mut attempts=0;let mut snapshots=Vec::new();
    let result=database_with_probe(f.roots.database.as_ref().unwrap(),|path| {snapshots.push(path.to_path_buf());attempts+=1;f.insert(&db,"one",&f.dir,&format!("generation {attempts}"));});
    assert!(result.err().unwrap().contains("keeps changing"));assert_eq!(attempts,3);
    assert!(snapshots.iter().all(|path| !path.exists()));
}

#[test]
fn rollback_journal_and_corrupt_database_fail_without_recovery() {
    let f=crate::agent::kiro_store::tests::Fixture::new();drop(f.db());let path=f.roots.database.as_ref().unwrap();
    fs::write(sidecar(path,"-journal"),b"pending").unwrap();let before=fs::read(path).unwrap();
    assert!(database(path).err().unwrap().contains("rollback journal"));assert_eq!(fs::read(path).unwrap(),before);
    fs::remove_file(sidecar(path,"-journal")).unwrap();fs::write(path,b"not sqlite").unwrap();
    assert!(database(path).is_err());assert_eq!(fs::read(path).unwrap(),b"not sqlite");
}
