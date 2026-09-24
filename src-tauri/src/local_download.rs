//! Remote-window downloads performed by the local desktop host.
//!
//! A remote window shows files that live on another machine. Left to itself the webview can save a download (see
//! `with_download_handler` in commands.rs), but wry reports only its start and its end, so the user gets no
//! progress, no choice of destination and no way to stop it. Here the local host asks where to save, streams the
//! file from the window's own tunnel, and reports progress to the page.
//!
//! The page is served by the remote server, so nothing it sends is trusted as a local path or an arbitrary URL:
//! the destination comes from a save dialog the user answers, and the source must be the `/api/download` endpoint
//! of the loopback origin the window is showing.
//!
//! The commands live in a plugin rather than the app's command list because a remote origin may only call what a
//! capability grants it, and only plugin commands can be granted that way (see `fonts::plugin`).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

/// DOM event dispatched on the page with a download's progress and, finally, its outcome.
const EVENT: &str = "vlx:local-download";
/// Minimum gap between progress reports, so a fast tunnel does not flood the page with evals.
const REPORT_EVERY: Duration = Duration::from_millis(250);
/// Read buffer size; large enough that per-read overhead is negligible on a loopback tunnel.
const BUF_SIZE: usize = 256 * 1024;
/// Suffix of the file being written, renamed onto the destination only once every byte has arrived.
const PART_SUFFIX: &str = ".vlxpart";

/// A download is addressed by the window that started it plus the id that window chose, so one page cannot
/// cancel another window's download.
type Key = (String, String);

/// Downloads in flight and their cancel flags.
fn active() -> &'static Mutex<HashMap<Key, Arc<AtomicBool>>> {
    static MAP: OnceLock<Mutex<HashMap<Key, Arc<AtomicBool>>>> = OnceLock::new();
    MAP.get_or_init(Default::default)
}

/// Why a download stopped before its file was saved.
enum Stop {
    /// The user cancelled, or the window that started it was closed.
    Cancelled,
    Failed(String),
}

/// Bytes received so far and the size the server announced, if it did.
#[derive(Default)]
struct Progress {
    received: u64,
    total: Option<u64>,
}

/// Accept only the `/api/download` endpoint of the loopback origin the window itself is showing.
fn check_source(page: &url::Url, source: &url::Url) -> Result<(), String> {
    let loopback = matches!(source.host_str(), Some("127.0.0.1") | Some("localhost"));
    if source.scheme() != "http"
        || !loopback
        || source.origin() != page.origin()
        || source.path() != "/api/download"
    {
        return Err("This download link does not belong to the connected server".into());
    }
    Ok(())
}

/// The part file sits beside the destination, so the final rename never crosses a filesystem.
fn part_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_owned();
    s.push(PART_SUFFIX);
    PathBuf::from(s)
}

/// Ask where to save a file from the window's server, then download it there in the background.
///
/// Resolves to false when the user dismisses the save dialog. The page chooses the id so that it can recognise
/// progress reports arriving before this call returns.
#[tauri::command]
async fn start<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    id: String,
    url: String,
    name: String,
) -> Result<bool, String> {
    if id.is_empty() || id.len() > 64 {
        return Err("Invalid download id".into());
    }
    let source: url::Url = url.parse().map_err(|e| format!("Invalid download link: {e}"))?;
    let page = window.url().map_err(|e| format!("Failed to read the window address: {e}"))?;
    check_source(&page, &source)?;
    // Only a bare file name seeds the dialog; the remote side has no say over the folder.
    let name = Path::new(&name)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".into());

    // The dialog waits on the main thread's run loop, so it must be awaited from the blocking pool.
    let parent = window.clone();
    let dialog_app = app.clone();
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = dialog_app.dialog().file().set_file_name(name).set_parent(&parent);
        if let Some(dir) = dirs::download_dir() {
            dialog = dialog.set_directory(dir);
        }
        dialog.blocking_save_file()
    })
    .await
    .map_err(|e| format!("Save dialog failed: {e}"))?;
    let Some(chosen) = chosen else {
        return Ok(false);
    };
    let dest = chosen.into_path().map_err(|e| format!("Invalid save location: {e}"))?;

    let key: Key = (window.label().to_string(), id);
    let cancel = Arc::new(AtomicBool::new(false));
    active()
        .lock()
        .map_err(|_| "Download registry is unavailable".to_string())?
        .insert(key.clone(), cancel.clone());
    std::thread::spawn(move || run(app, key, source, dest, cancel));
    Ok(true)
}

/// Stop a download this window started. It only flips an in-memory flag, so it stays synchronous; the transfer
/// thread notices before its next read and removes the part file.
#[tauri::command]
fn cancel<R: Runtime>(window: WebviewWindow<R>, id: String) {
    if let Ok(map) = active().lock() {
        if let Some(flag) = map.get(&(window.label().to_string(), id)) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

/// Download into the part file, move it onto the destination, and report the outcome to the page.
fn run<R: Runtime>(app: AppHandle<R>, key: Key, source: url::Url, dest: PathBuf, cancel: Arc<AtomicBool>) {
    let part = part_path(&dest);
    let mut progress = Progress::default();
    let outcome = fetch(&app, &key, &source, &part, &cancel, &mut progress)
        .and_then(|()| replace(&part, &dest).map_err(Stop::Failed));
    if outcome.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    if let Ok(mut map) = active().lock() {
        map.remove(&key);
    }
    let _ = match &outcome {
        Ok(()) => report(&app, &key, "done", &progress, None, Some(&dest)),
        Err(Stop::Cancelled) => report(&app, &key, "cancelled", &progress, None, None),
        Err(Stop::Failed(e)) => report(&app, &key, "failed", &progress, Some(e), None),
    };
}

/// Stream the response body into `part`, reporting progress at most every `REPORT_EVERY`.
fn fetch<R: Runtime>(
    app: &AppHandle<R>,
    key: &Key,
    source: &url::Url,
    part: &Path,
    cancel: &AtomicBool,
    progress: &mut Progress,
) -> Result<(), Stop> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        // A stalled stream fails rather than hanging; it also bounds how long a cancel waits on a blocked read.
        .timeout_read(Duration::from_secs(30))
        .redirects(0)
        .build();
    let response = match agent.get(source.as_str()).call() {
        Ok(r) => r,
        Err(ureq::Error::Status(code, r)) => {
            let body = r.into_string().unwrap_or_default();
            let body = body.trim();
            return Err(Stop::Failed(if body.is_empty() {
                format!("The server returned HTTP {code}")
            } else {
                body.to_string()
            }));
        }
        Err(e) => return Err(Stop::Failed(format!("Failed to connect to the server: {e}"))),
    };
    progress.total = response.header("Content-Length").and_then(|v| v.parse().ok());
    // Report once before the first byte so the page can show the size straight away.
    report(app, key, "active", progress, None, None)?;

    let mut reader = response.into_reader();
    let mut file = std::fs::File::create(part).map_err(|e| Stop::Failed(format!("Failed to create the file: {e}")))?;
    let mut buf = vec![0u8; BUF_SIZE];
    let mut last = Instant::now();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(Stop::Cancelled);
        }
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(Stop::Failed(format!("The download was interrupted: {e}"))),
        };
        file.write_all(&buf[..n]).map_err(|e| Stop::Failed(format!("Failed to write the file: {e}")))?;
        progress.received += n as u64;
        if last.elapsed() >= REPORT_EVERY {
            last = Instant::now();
            report(app, key, "active", progress, None, None)?;
        }
    }
    if progress.total.is_some_and(|total| total != progress.received) {
        return Err(Stop::Failed("The download ended before the whole file arrived".into()));
    }
    Ok(())
}

/// Move the finished part file onto the destination. The user already agreed to replace an existing file in the
/// save dialog, and Windows refuses to rename onto one, so it is removed first there.
fn replace(part: &Path, dest: &Path) -> Result<(), String> {
    #[cfg(windows)]
    if dest.exists() {
        std::fs::remove_file(dest).map_err(|e| format!("Failed to replace the existing file: {e}"))?;
    }
    std::fs::rename(part, dest).map_err(|e| format!("Failed to save the file: {e}"))
}

/// Dispatch a progress event on the window's page. A closed window stops the download, since nothing is left to
/// show it and a remote window's tunnel may already be gone.
fn report<R: Runtime>(
    app: &AppHandle<R>,
    key: &Key,
    state: &str,
    progress: &Progress,
    error: Option<&str>,
    path: Option<&Path>,
) -> Result<(), Stop> {
    let Some(window) = app.get_webview_window(&key.0) else {
        return Err(Stop::Cancelled);
    };
    let detail = serde_json::json!({
        "id": key.1,
        "state": state,
        "received": progress.received,
        "total": progress.total,
        "error": error,
        "path": path.map(|p| p.to_string_lossy()),
    });
    let _ = window.eval(&format!("window.dispatchEvent(new CustomEvent('{EVENT}',{{detail:{detail}}}))"));
    Ok(())
}

pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("local-download")
        .invoke_handler(tauri::generate_handler![start, cancel])
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> url::Url {
        s.parse().unwrap()
    }

    #[test]
    fn accepts_only_the_download_endpoint_of_the_window_origin() {
        let page = url("http://127.0.0.1:41234/#pair=abc");
        assert!(check_source(&page, &url("http://127.0.0.1:41234/api/download?token=t")).is_ok());
        // Another port is another server; another path is not the ticketed endpoint.
        assert!(check_source(&page, &url("http://127.0.0.1:41235/api/download?token=t")).is_err());
        assert!(check_source(&page, &url("http://127.0.0.1:41234/api/other?token=t")).is_err());
        // A non-loopback page never qualifies, even when the link matches it.
        let external = url("https://relay.example.com/");
        assert!(check_source(&external, &url("https://relay.example.com/api/download?token=t")).is_err());
    }

    #[test]
    fn part_file_sits_beside_the_destination() {
        assert_eq!(part_path(Path::new("/d/movie.mp4")), PathBuf::from("/d/movie.mp4.vlxpart"));
    }

    /// Serve one canned HTTP response on loopback and return a download link to it.
    #[cfg(feature = "native-menu-tests")]
    fn serve_once(response: &'static [u8]) -> url::Url {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut request = [0u8; 4096];
                let _ = stream.read(&mut request);
                let _ = stream.write_all(response);
            }
        });
        url(&format!("http://127.0.0.1:{port}/api/download?token=t"))
    }

    /// A mock app with one window, since progress reports stop a download whose window is gone.
    #[cfg(feature = "native-menu-tests")]
    fn app_with_window(label: &str) -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::External(url("http://127.0.0.1:1")))
            .build()
            .unwrap();
        app
    }

    #[cfg(feature = "native-menu-tests")]
    #[test]
    fn streams_into_a_part_file_and_renames_it_onto_the_destination() {
        let app = app_with_window("dl-ok");
        let dir = std::env::temp_dir().join(format!("vlx-local-download-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("hello.txt");
        let source = serve_once(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\nhello world");
        let key: Key = ("dl-ok".into(), "a".into());
        run(app.handle().clone(), key, source, dest.clone(), Arc::new(AtomicBool::new(false)));
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "hello world");
        assert!(!part_path(&dest).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(feature = "native-menu-tests")]
    #[test]
    fn a_short_body_or_an_error_status_fails_and_leaves_no_file() {
        let app = app_with_window("dl-bad");
        let dir = std::env::temp_dir().join(format!("vlx-local-download-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let key: Key = ("dl-bad".into(), "b".into());
        let cancel = AtomicBool::new(false);

        // The connection closes after 5 of the 100 announced bytes.
        let dest = dir.join("short.bin");
        let source = serve_once(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nhello");
        let short = fetch(app.handle(), &key, &source, &part_path(&dest), &cancel, &mut Progress::default());
        assert!(matches!(short, Err(Stop::Failed(_))));
        run(
            app.handle().clone(),
            key.clone(),
            serve_once(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nhello"),
            dest.clone(),
            Arc::new(AtomicBool::new(false)),
        );
        assert!(!dest.exists() && !part_path(&dest).exists());

        // The server's own message is what the user sees.
        let source = serve_once(b"HTTP/1.1 404 Not Found\r\nContent-Length: 12\r\nConnection: close\r\n\r\nLink expired");
        match fetch(app.handle(), &key, &source, &part_path(&dir.join("x")), &cancel, &mut Progress::default()) {
            Err(Stop::Failed(msg)) => assert_eq!(msg, "Link expired"),
            _ => panic!("an error status must fail the download"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(feature = "native-menu-tests")]
    #[test]
    fn remote_window_needs_the_granted_permission() {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        let mut native_context = crate::tauri_context();
        std::mem::swap(context.runtime_authority_mut(), native_context.runtime_authority_mut());
        let app = tauri::test::mock_builder().plugin(plugin()).build(context).unwrap();
        let page = url("http://127.0.0.1:32719");
        let remote = tauri::WebviewWindowBuilder::new(&app, "download-remote-test", tauri::WebviewUrl::External(page.clone()))
            .build()
            .unwrap();
        let invoke = || {
            tauri::test::get_ipc_response(
                &remote,
                tauri::webview::InvokeRequest {
                    cmd: "plugin:local-download|cancel".into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: page.clone(),
                    body: serde_json::json!({ "id": "x" }).into(),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.into(),
                },
            )
        };
        assert!(invoke().is_err());
        app.add_capability(
            tauri::ipc::CapabilityBuilder::new("download-remote-test")
                .window("download-remote-test")
                .remote("http://127.0.0.1:*".to_string())
                .permission("local-download:allow-start")
                .permission("local-download:allow-cancel"),
        )
        .unwrap();
        assert!(invoke().is_ok());
    }
}
