use std::path::PathBuf;
use std::process::Command;

pub(crate) fn command() -> Command {
    #[cfg(windows)]
    let path =
        PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into()))
            .join(r"System32\curl.exe");
    #[cfg(not(windows))]
    let path = PathBuf::from("/usr/bin/curl");

    let mut command = Command::new(path);
    command.env_clear();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
        if let Some(root) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", root);
        }
    }
    command
}
