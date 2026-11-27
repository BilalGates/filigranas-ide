use std::{io::Read, process::{Command, Stdio}, time::{Duration, Instant}};

pub const TIMEOUT: &str = "se agotó el plazo de la comprobación";
const LIMIT: usize = 128 * 1024;

pub struct Output {
    pub success: bool,
    pub bytes: Vec<u8>,
    pub truncated: bool,
}

pub fn run(command: Command, seconds: u64) -> Result<Output, &'static str> {
    run_with_stdin(command, Stdio::null(), seconds)
}

pub fn run_with_stdin(command: Command, stdin: Stdio, seconds: u64) -> Result<Output, &'static str> {
    capture(command, stdin, seconds, LIMIT, 0).map(|(output, _)| output)
}

/// Captures stdout and stderr separately for commands that return structured data.
pub fn capture(
    mut command: Command, stdin: Stdio, seconds: u64, stdout_limit: usize, stderr_limit: usize,
) -> Result<(Output, Vec<u8>), &'static str> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let stderr = if stderr_limit == 0 { Stdio::null() } else { Stdio::piped() };
    let mut child = command.stdin(stdin).stderr(stderr).stdout(Stdio::piped())
        .spawn().map_err(|_| "no se pudo arrancar la herramienta")?;
    let stdout = drain(child.stdout.take().expect("stdout is piped"), stdout_limit);
    let stderr = child.stderr.take().map(|pipe| drain(pipe, stderr_limit));
    let deadline = Instant::now() + Duration::from_secs(seconds);
    let complete = (|| {
        loop {
            match child.try_wait().map_err(|_| "no se pudo esperar la herramienta")? {
                Some(exit) => {
                    let (bytes, truncated) = stdout.recv_timeout(deadline.saturating_duration_since(Instant::now()))
                        .map_err(|_| TIMEOUT)?;
                    let diagnostics = match stderr {
                        Some(stderr) => stderr.recv_timeout(deadline.saturating_duration_since(Instant::now()))
                            .map_err(|_| TIMEOUT)?.0,
                        None => Vec::new(),
                    };
                    return Ok((Output { success: exit.success(), bytes, truncated }, diagnostics));
                }
                None if Instant::now() >= deadline => return Err(TIMEOUT),
                None => std::thread::sleep(Duration::from_millis(50)),
            }
        }
    })();
    if complete.is_err() {
        // A descendant can still hold a pipe open after the parent exits.
        #[cfg(unix)]
        let _ = crate::cli::command("/bin/kill").args(["-KILL", "--", &format!("-{}", child.id())]).output();
        #[cfg(windows)]
        let _ = crate::cli::command("taskkill").args(["/F", "/T", "/PID", &child.id().to_string()]).output();
        let _ = child.kill();
        let _ = child.wait();
    }
    complete
}

fn drain(mut pipe: impl Read + Send + 'static, limit: usize) -> std::sync::mpsc::Receiver<(Vec<u8>, bool)> {
    let (sender, output) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut buffer = [0; 8192];
        let mut bytes = Vec::new();
        let mut truncated = false;
        while let Ok(n @ 1..) = pipe.read(&mut buffer) {
            let room = (limit - bytes.len()).min(n);
            bytes.extend_from_slice(&buffer[..room]);
            truncated |= n > room;
        }
        let _ = sender.send((bytes, truncated));
    });
    output
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn capture_keeps_json_separate_from_diagnostics() {
        let mut cmd = crate::cli::command("/bin/sh");
        cmd.args(["-c", "printf '{}'; printf 'diagnóstico' >&2"]);
        let (out, stderr) = capture(cmd, Stdio::null(), 3, 32, 32).unwrap();
        assert!(out.success && !out.truncated);
        assert_eq!(out.bytes, b"{}");
        assert_eq!(stderr, "diagnóstico".as_bytes());
    }

    #[test]
    fn capture_times_out_when_a_descendant_keeps_the_pipe_open() {
        let mut cmd = crate::cli::command("/bin/sh");
        cmd.args(["-c", "/bin/sleep 30 &"]);
        assert!(matches!(capture(cmd, Stdio::null(), 1, 32, 32), Err(TIMEOUT)));
    }
}
