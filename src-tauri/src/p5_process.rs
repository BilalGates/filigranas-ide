use std::{io::Read, process::{Command, Stdio}, time::{Duration, Instant}};

pub const TIMEOUT: &str = "se agotó el plazo de la comprobación";
const LIMIT: usize = 128 * 1024;

pub struct Output {
    pub success: bool,
    pub bytes: Vec<u8>,
    pub truncated: bool,
}

pub fn run(mut command: Command, seconds: u64) -> Result<Output, &'static str> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.stdin(Stdio::null()).stderr(Stdio::null()).stdout(Stdio::piped())
        .spawn().map_err(|_| "no se pudo arrancar la herramienta")?;
    let mut pipe = child.stdout.take().expect("stdout is piped");
    let (sender, output) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut buffer = [0; 8192];
        let mut bytes = Vec::new();
        let mut truncated = false;
        while let Ok(n @ 1..) = pipe.read(&mut buffer) {
            let room = (LIMIT - bytes.len()).min(n);
            bytes.extend_from_slice(&buffer[..room]);
            truncated |= n > room;
        }
        let _ = sender.send((bytes, truncated));
    });
    let deadline = Instant::now() + Duration::from_secs(seconds);
    loop {
        if let Ok(Some(exit)) = child.try_wait() {
            let (bytes, truncated) = output.recv_timeout(deadline.saturating_duration_since(Instant::now())).map_err(|_| TIMEOUT)?;
            return Ok(Output { success: exit.success(), bytes, truncated });
        }
        if Instant::now() >= deadline {
            // Kill the group on Unix so npm and Chrome descendants do not
            // keep running. Windows taskkill addresses the process tree.
            #[cfg(unix)]
            let _ = Command::new("/bin/kill").args(["-KILL", "--", &format!("-{}",child.id())]).output();
            #[cfg(windows)]
            let _ = Command::new("taskkill").args(["/F","/T","/PID",&child.id().to_string()]).output();
            let _ = child.kill();
            let _ = child.wait();
            return Err(TIMEOUT);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}
