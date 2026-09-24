//! Read native files without letting SQLite create or change a native sidecar.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use rusqlite::{Connection, OpenFlags};

const MAX_SOURCE_BYTES: u64 = 128 * 1024 * 1024;

/// A private directory is dropped after the copied SQLite connection closes.
pub(super) struct TempDir(pub PathBuf);
impl TempDir {
    pub(super) fn new() -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!("velaterm-kiro-{}", uuid::Uuid::new_v4()));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)] {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&path).map_err(|_| "Cannot create a private Kiro history snapshot".to_string())?;
        Ok(Self(path))
    }
}
impl Drop for TempDir {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}

pub(super) struct Database {
    pub conn: Connection,
    // Fields drop in declaration order: close SQLite before removing its directory.
    _directory: TempDir,
}

/// Missing and unreadable sources are distinct; symlinks cannot substitute another source mid-read.
pub(super) fn bytes(path: &Path, limit: u64) -> Result<Option<Vec<u8>>, String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot inspect a Kiro history source".into()),
    };
    if !meta.is_file() { return Err("Kiro history source must be a regular file".into()); }
    if meta.len() > limit { return Err("Kiro history source exceeds the supported size limit".into()); }
    let file = File::open(path).map_err(|_| "Cannot read a Kiro history source".to_string())?;
    let opened = file.metadata().map_err(|_| "Cannot inspect an open Kiro history source".to_string())?;
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        if meta.dev() != opened.dev() || meta.ino() != opened.ino() {
            return Err("Kiro history source changed while opening it".into());
        }
    }
    let mut data = Vec::new();
    file.take(limit + 1).read_to_end(&mut data).map_err(|_| "Cannot read a Kiro history source".to_string())?;
    if data.len() as u64 > limit { return Err("Kiro history source exceeds the supported size limit".into()); }
    Ok(Some(data))
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

fn collect(path: &Path) -> Result<(Vec<u8>, Option<Vec<u8>>), String> {
    // Even an apparently cold rollback journal is not safe to guess about. Never recover it in place.
    if bytes(&sidecar(path, "-journal"), MAX_SOURCE_BYTES)?.is_some_and(|b| !b.is_empty()) {
        return Err("Kiro history has a rollback journal; retry after the native writer closes it".into());
    }
    let db = bytes(path, MAX_SOURCE_BYTES)?.ok_or("Kiro history database disappeared")?;
    let wal = bytes(&sidecar(path, "-wal"), MAX_SOURCE_BYTES)?;
    Ok((db, wal))
}

/// Compare complete DB/WAL generations around the copy. Bounded retries never checkpoint the native DB.
pub(super) fn database(path: &Path) -> Result<Database, String> {
    database_with_probe(path, |_| {})
}

fn database_with_probe(path: &Path, mut after_copy: impl FnMut(&Path)) -> Result<Database, String> {
    for _ in 0..3 {
        let first = collect(path)?;
        let directory = TempDir::new()?;
        let copy = directory.0.join("history.sqlite3");
        fs::write(&copy, &first.0).map_err(|_| "Cannot write a private Kiro history snapshot".to_string())?;
        if let Some(wal) = &first.1 {
            fs::write(sidecar(&copy, "-wal"), wal).map_err(|_| "Cannot copy the Kiro history WAL".to_string())?;
        }
        after_copy(&directory.0);
        if first != collect(path)? { continue; }
        // Only this private copy may create SHM or recover/checkpoint WAL pages.
        let conn = Connection::open_with_flags(&copy, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX)
            .map_err(|_| "Kiro history database is damaged or unreadable".to_string())?;
        conn.execute_batch("PRAGMA query_only=ON;").map_err(|_| "Cannot protect the Kiro snapshot from writes".to_string())?;
        let result: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))
            .map_err(|_| "Kiro history database integrity check failed".to_string())?;
        if result != "ok" { return Err("Kiro history database integrity check failed".into()); }
        return Ok(Database { conn, _directory: directory });
    }
    Err("Kiro history keeps changing; retry after the native writer becomes idle".into())
}

/// Metadata and events are one source. A half-written pair is never accepted as a completed empty session.
pub(super) fn pair(meta: &Path, log: &Path) -> Result<(Vec<u8>, Vec<u8>), String> {
    for _ in 0..3 {
        let first = (bytes(meta, MAX_SOURCE_BYTES)?, bytes(log, MAX_SOURCE_BYTES)?);
        let second = (bytes(meta, MAX_SOURCE_BYTES)?, bytes(log, MAX_SOURCE_BYTES)?);
        if first != second { continue; }
        return match first {
            (Some(meta), Some(log)) => Ok((meta, log)),
            _ => Err("Kiro history is incomplete: its metadata or event file is missing".into()),
        };
    }
    Err("Kiro history keeps changing; retry after the native writer becomes idle".into())
}

#[cfg(test)]
mod tests;
