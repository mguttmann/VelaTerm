use super::*;

#[cfg(unix)]
#[test]
fn zsh_startup_preserves_profiles_and_restores_zdotdir() {
    if !Path::new("/bin/zsh").exists() {
        return;
    }
    let root = std::env::temp_dir().join(format!("vlx-zsh-startup-{}", uuid::Uuid::new_v4()));
    let original = root.join("user ' 中文");
    std::fs::create_dir_all(&original).unwrap();
    for (name, marker) in [
        (".zshenv", "E"),
        (".zprofile", "P"),
        (".zshrc", "R"),
        (".zlogin", "L"),
    ] {
        std::fs::write(
            original.join(name),
            format!("VLX_TEST_ORDER+=\"{marker}\"\n"),
        )
        .unwrap();
    }
    let (state, _) = install(&root, "/bin/zsh").unwrap().unwrap();
    let mut cmd = portable_pty::CommandBuilder::new("/bin/zsh");
    cmd.env("ZDOTDIR", &original);
    configure_zsh_startup(&state, &mut cmd).unwrap();
    let output = std::process::Command::new("/bin/zsh")
        .env_clear()
        .env("HOME", &original)
        .env("PATH", "/usr/bin:/bin")
        .env("ZDOTDIR", cmd.get_env("ZDOTDIR").unwrap())
        .args([
            "-lic",
            "printf 'RESULT:%s:%s:%s' \"$VLX_TEST_ORDER\" \"$ZDOTDIR\" \"$_vlxc_nonce\"",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        format!("RESULT:EPRL:{}:{}", original.display(), state.nonce)
    );
    drop(state);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn scripts_are_private_and_powershell_paths_are_utf8() {
    let root = std::env::temp_dir().join(format!("vlx-completion-中文-{}", uuid::Uuid::new_v4()));
    let (state, launch) = install(&root, "powershell.exe").unwrap().unwrap();
    assert!(state.snapshot.configured);
    assert!(!state.snapshot.supported);
    let script = state
        .selection_file
        .parent()
        .unwrap()
        .join("integration.ps1");
    let bytes = std::fs::read(&script).unwrap();
    assert!(bytes.starts_with(b"\xef\xbb\xbf"));
    let text = String::from_utf8(bytes).unwrap();
    assert!(!text.contains("@SELECTION@"));
    assert!(!text.contains("@NONCE@"));
    assert!(launch.contains("中文"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(script.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
    drop(state);
    assert!(!script.exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn bash_startup_replays_login_profiles_and_loads_integration() {
    if !Path::new("/bin/bash").exists() {
        return;
    }
    let root = std::env::temp_dir().join(format!("vlx-bash-startup-' 中文-{}", uuid::Uuid::new_v4()));
    let home = root.join("user ' 中文");
    std::fs::create_dir_all(&home).unwrap();
    // Bash reads the first readable file of this list only, so a login shell records just one marker.
    for (name, marker) in [
        (".bash_profile", "P"),
        (".bash_login", "L"),
        (".profile", "R"),
    ] {
        std::fs::write(
            home.join(name),
            format!("VLX_TEST_ORDER+=\"{marker}\"\n"),
        )
        .unwrap();
    }
    let (state, _) = install(&root, "/bin/bash").unwrap().unwrap();
    let rcfile = configure_bash_startup(&state).unwrap();
    let output = std::process::Command::new("/bin/bash")
        .env_clear()
        .env("HOME", &home)
        .env("PATH", "/usr/bin:/bin")
        .args([
            "--rcfile",
            &rcfile.to_string_lossy(),
            "-ic",
            "printf 'RESULT:%s:%s' \"$VLX_TEST_ORDER\" \"$_vlxc_nonce\"",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    // The integration announces its state first; Bash 3 reports itself unsupported right when it loads.
    assert!(String::from_utf8_lossy(&output.stdout)
        .ends_with(&format!("RESULT:P:{}", state.nonce)));
    drop(state);
    std::fs::remove_dir_all(root).unwrap();
}
