//! Lectura ligera de CPU y RAM del sistema sin dependencias externas.

use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

use crate::{AppState, CmdResult};

#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SystemMetrics {
    pub cpu_percent: f32,
    pub ram_used_bytes: u64,
    pub ram_total_bytes: u64,
    pub ram_percent: f32,
}

#[derive(Clone, Copy, Default)]
struct CpuTicks {
    active: u64,
    total: u64,
}

pub struct Monitor {
    prev: Mutex<Option<CpuTicks>>,
}

impl Default for Monitor {
    fn default() -> Self {
        Self { prev: Mutex::new(read_cpu_ticks()) }
    }
}

impl Monitor {
    pub fn sample(&self) -> SystemMetrics {
        let now = read_cpu_ticks();
        let cpu_percent = {
            let mut slot = self.prev.lock().unwrap_or_else(|p| p.into_inner());
            let pct = match (*slot, now) {
                (Some(prev), Some(curr)) => cpu_percent_from_deltas(prev, curr),
                _ => 0.0,
            };
            if now.is_some() {
                *slot = now;
            }
            pct
        };
        let (ram_used_bytes, ram_total_bytes) = read_ram_bytes().unwrap_or((0, 0));
        let ram_percent = calc_percent(ram_used_bytes, ram_total_bytes);
        SystemMetrics {
            cpu_percent,
            ram_used_bytes,
            ram_total_bytes,
            ram_percent,
        }
    }
}

fn cpu_percent_from_deltas(prev: CpuTicks, curr: CpuTicks) -> f32 {
    let d_active = curr.active.saturating_sub(prev.active);
    let d_total = curr.total.saturating_sub(prev.total);
    calc_percent(d_active, d_total)
}

fn calc_percent(part: u64, total: u64) -> f32 {
    if total == 0 {
        return 0.0;
    }
    ((part as f64 / total as f64) * 100.0).clamp(0.0, 100.0) as f32
}

#[tauri::command]
pub fn system_metrics(state: State<AppState>) -> CmdResult<SystemMetrics> {
    Ok(state.sysmon.sample())
}

// ── macOS (Mach host_statistics / host_statistics64 + sysctl) ───────────

#[cfg(target_os = "macos")]
fn read_cpu_ticks() -> Option<CpuTicks> {
    use libc::{c_int, c_uint, mach_port_t};

    const HOST_CPU_LOAD_INFO: c_int = 3;
    const HOST_CPU_LOAD_INFO_COUNT: c_uint = 4;

    extern "C" {
        fn mach_host_self() -> mach_port_t;
        fn host_statistics(
            host_priv: mach_port_t,
            flavor: c_int,
            host_info_out: *mut c_int,
            host_info_out_cnt: *mut c_uint,
        ) -> c_int;
    }

    let mut ticks = [0u32; 4]; // [user, system, idle, nice]
    let mut count = HOST_CPU_LOAD_INFO_COUNT;
    let kr = unsafe {
        host_statistics(
            mach_host_self(),
            HOST_CPU_LOAD_INFO,
            ticks.as_mut_ptr() as *mut c_int,
            &mut count,
        )
    };
    if kr != 0 {
        return None;
    }
    let user = u64::from(ticks[0]);
    let system = u64::from(ticks[1]);
    let idle = u64::from(ticks[2]);
    let nice = u64::from(ticks[3]);
    let active = user + system + nice;
    let total = active + idle;
    Some(CpuTicks { active, total })
}

#[cfg(target_os = "macos")]
fn read_ram_bytes() -> Option<(u64, u64)> {
    use std::mem::size_of;
    use libc::{c_int, c_uint, mach_port_t};

    const HOST_VM_INFO64: c_int = 4;

    #[repr(C)]
    #[derive(Default)]
    struct VmStats64 {
        free_count: u32,
        active_count: u32,
        inactive_count: u32,
        wire_count: u32,
        zero_fill_count: u64,
        reactivations: u64,
        pageins: u64,
        pageouts: u64,
        faults: u64,
        cow_faults: u64,
        lookups: u64,
        hits: u64,
        purges: u64,
        purgeable_count: u32,
        speculative_count: u32,
        decompressions: u64,
        compressions: u64,
        swapins: u64,
        swapouts: u64,
        compressor_page_count: u32,
        throttled_count: u32,
        external_page_count: u32,
        internal_page_count: u32,
        total_uncompressed_pages_in_compressor: u64,
    }

    extern "C" {
        fn mach_host_self() -> mach_port_t;
        fn host_statistics64(
            host_priv: mach_port_t,
            flavor: c_int,
            host_info_out: *mut c_int,
            host_info_out_cnt: *mut c_uint,
        ) -> c_int;
    }

    let mut total: u64 = 0;
    let mut len = size_of::<u64>();
    let ok = unsafe {
        libc::sysctlbyname(
            c"hw.memsize".as_ptr(),
            (&mut total as *mut u64).cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    if ok != 0 || total == 0 {
        return None;
    }

    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if page_size <= 0 {
        return None;
    }
    let page_size = page_size as u64;

    let mut stats = VmStats64::default();
    let mut count = (size_of::<VmStats64>() / size_of::<u32>()) as c_uint;
    let kr = unsafe {
        host_statistics64(
            mach_host_self(),
            HOST_VM_INFO64,
            (&mut stats as *mut VmStats64).cast::<c_int>(),
            &mut count,
        )
    };
    if kr != 0 {
        return None;
    }

    // Misma fórmula que Monitor de Actividad de macOS: App (internal - purgeable) + Wired + Compressed.
    let app_pages = u64::from(stats.internal_page_count.saturating_sub(stats.purgeable_count));
    let used_pages = app_pages + u64::from(stats.wire_count) + u64::from(stats.compressor_page_count);
    let used = used_pages.saturating_mul(page_size).min(total);
    Some((used, total))
}

// ── Linux (/proc/stat y /proc/meminfo) ──────────────────────────────────

#[cfg(target_os = "linux")]
fn read_cpu_ticks() -> Option<CpuTicks> {
    let text = std::fs::read_to_string("/proc/stat").ok()?;
    let line = text.lines().next()?;
    let nums: Vec<u64> = line.split_whitespace().skip(1).filter_map(|s| s.parse().ok()).collect();
    if nums.len() < 4 {
        return None;
    }
    let idle = nums[3] + nums.get(4).copied().unwrap_or(0);
    let total: u64 = nums.iter().sum();
    Some(CpuTicks { active: total.saturating_sub(idle), total })
}

#[cfg(target_os = "linux")]
fn read_ram_bytes() -> Option<(u64, u64)> {
    let text = std::fs::read_to_string("/proc/meminfo").ok()?;
    let mut total_kb = 0u64;
    let mut avail_kb = 0u64;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            total_kb = rest.split_whitespace().next()?.parse().ok()?;
        } else if let Some(rest) = line.strip_prefix("MemAvailable:") {
            avail_kb = rest.split_whitespace().next()?.parse().ok()?;
        }
    }
    if total_kb == 0 {
        return None;
    }
    let total = total_kb.saturating_mul(1024);
    let used = total_kb.saturating_sub(avail_kb).saturating_mul(1024).min(total);
    Some((used, total))
}

// ── Windows (GetSystemTimes y GlobalMemoryStatusEx) ─────────────────────

#[cfg(target_os = "windows")]
fn read_cpu_ticks() -> Option<CpuTicks> {
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    impl FileTime {
        fn u64(self) -> u64 {
            (u64::from(self.high) << 32) | u64::from(self.low)
        }
    }
    extern "system" {
        fn GetSystemTimes(idle: *mut FileTime, kernel: *mut FileTime, user: *mut FileTime) -> i32;
    }
    let (mut idle, mut kernel, mut user) = (FileTime::default(), FileTime::default(), FileTime::default());
    if unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) } == 0 {
        return None;
    }
    let idle = idle.u64();
    let total = kernel.u64().saturating_add(user.u64());
    Some(CpuTicks { active: total.saturating_sub(idle), total })
}

#[cfg(target_os = "windows")]
fn read_ram_bytes() -> Option<(u64, u64)> {
    #[repr(C)]
    struct MemoryStatusEx {
        length: u32,
        memory_load: u32,
        total_phys: u64,
        avail_phys: u64,
        total_page_file: u64,
        avail_page_file: u64,
        total_virtual: u64,
        avail_virtual: u64,
        avail_extended_virtual: u64,
    }
    extern "system" {
        fn GlobalMemoryStatusEx(buf: *mut MemoryStatusEx) -> i32;
    }
    let mut status = MemoryStatusEx {
        length: std::mem::size_of::<MemoryStatusEx>() as u32,
        memory_load: 0,
        total_phys: 0,
        avail_phys: 0,
        total_page_file: 0,
        avail_page_file: 0,
        total_virtual: 0,
        avail_virtual: 0,
        avail_extended_virtual: 0,
    };
    if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 || status.total_phys == 0 {
        return None;
    }
    let used = status.total_phys.saturating_sub(status.avail_phys);
    Some((used, status.total_phys))
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn read_cpu_ticks() -> Option<CpuTicks> {
    None
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn read_ram_bytes() -> Option<(u64, u64)> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_deltas_and_percents_are_bounded() {
        let prev = CpuTicks { active: 100, total: 200 };
        let curr = CpuTicks { active: 150, total: 300 };
        assert!((cpu_percent_from_deltas(prev, curr) - 50.0).abs() < 0.01);
        assert_eq!(cpu_percent_from_deltas(curr, curr), 0.0);
        assert_eq!(calc_percent(50, 0), 0.0);
        assert_eq!(calc_percent(200, 100), 100.0);
    }

    #[test]
    fn host_sample_reports_valid_ram_and_cpu() {
        let mon = Monitor::default();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let m = mon.sample();
        assert!(m.ram_total_bytes > 0);
        assert!(m.ram_used_bytes <= m.ram_total_bytes);
        assert!((0.0..=100.0).contains(&m.cpu_percent));
        assert!((0.0..=100.0).contains(&m.ram_percent));
    }
}
