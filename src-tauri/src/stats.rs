//! Server telemetry: one shell command that dumps OS counters (Linux /proc, macOS / FreeBSD sysctl)
//! plus df, with a PowerShell fallback for Windows; the output is parsed here.

use serde::Serialize;
use std::collections::HashMap;

/// Runs under `sh` explicitly so it works whatever the user's login shell is (fish, csh…).
/// Must stay one line without `'`, `!` and backslashes so csh and fish pass it through untouched.
pub const COMMAND: &str = "sh -c 'exec 2>/dev/null; export LC_ALL=C; k=$(uname -s); echo \"@@os-kind $k\"; \
case $k in \
Darwin) echo @@sysctl; for n in hw.memsize hw.ncpu vm.loadavg kern.boottime vm.swapusage; do v=$(sysctl -n $n) && echo \"$n: $v\"; done; \
echo @@now; date +%s; \
echo @@vmstat; vm_stat; \
echo @@pscpu; ps -A -o %cpu; \
echo @@os; echo \"$(sw_vers -productName) $(sw_vers -productVersion)\";; \
FreeBSD|DragonFly) echo @@sysctl; for n in hw.physmem hw.ncpu vm.loadavg kern.boottime kern.cp_time kern.cp_times hw.pagesize \
vm.stats.vm.v_free_count vm.stats.vm.v_inactive_count vm.stats.vm.v_cache_count; do v=$(sysctl -n $n) && echo \"$n: $v\"; done; \
echo @@now; date +%s; \
echo @@swapinfo; swapinfo -k; \
echo @@os; echo \"$k $(freebsd-version || uname -r)\";; \
*) echo @@stat; grep ^cpu /proc/stat; \
echo @@mem; cat /proc/meminfo; \
echo @@load; cat /proc/loadavg; \
echo @@up; cat /proc/uptime; \
echo @@ncpu; nproc || grep -c ^processor /proc/cpuinfo; \
echo @@os; (. /etc/os-release && echo \"$PRETTY_NAME\");; \
esac; \
echo @@df; df -Pk; \
echo @@host; hostname; \
echo @@end'";

/// Windows (OpenSSH with cmd.exe or PowerShell as the default shell). Sent base64-encoded via
/// `-EncodedCommand`, so neither shell needs any quoting. Numbers go through string interpolation,
/// which is culture-invariant (bare output would use the server locale's decimal comma).
const POWERSHELL: &str = r#"$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
'@@os-kind windows'
$o = Get-CimInstance Win32_OperatingSystem
'@@winmem'
"$($o.TotalVisibleMemorySize) $($o.FreePhysicalMemory)"
'@@winswap'
Get-CimInstance Win32_PageFileUsage | ForEach-Object { "$($_.AllocatedBaseSize) $($_.CurrentUsage)" }
'@@up'
"$([int64]((Get-Date) - $o.LastBootUpTime).TotalSeconds)"
'@@os'
"$($o.Caption) $($o.Version)"
$p = @(Get-CimInstance Win32_Processor)
'@@wincpu'
"$(($p | Measure-Object -Property LoadPercentage -Average).Average)"
'@@ncpu'
"$(($p | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum)"
# Names are "3" or "<group>,<index>" on machines with several processor groups.
'@@wincores'
Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor | Where-Object { $_.Name -notlike '*_Total' } |
  Sort-Object { $n = $_.Name -split ','; [int]$n[0] * 10000 + [int]$n[-1] } | ForEach-Object { "$($_.PercentProcessorTime)" }
'@@windisk'
Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { "$($_.DeviceID) $($_.Size) $($_.FreeSpace)" }
'@@host'
[Environment]::MachineName
'@@end'
"#;

pub fn powershell_command() -> String {
    let utf16: Vec<u8> = POWERSHELL.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    format!("powershell -NoProfile -NonInteractive -EncodedCommand {}", base64(&utf16))
}

fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            out.push(if i <= c.len() { T[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

/// Which command worked for a session, so later polls don't re-probe.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Flavour {
    Sh,
    PowerShell,
}

/// Per-session telemetry state.
#[derive(Default)]
pub struct State {
    pub flavour: Option<Flavour>,
    /// Previous CPU counters (idle, total) for usage deltas.
    pub cpu_prev: Option<(u64, u64)>,
    /// Same, per core.
    pub cores_prev: Vec<(u64, u64)>,
}

impl State {
    /// Fills `cpu` from the counter delta against the previous sample (Linux / FreeBSD).
    pub fn apply_cpu(&mut self, s: &mut Stats) {
        if !s.core_samples.is_empty() {
            // A changed core count (hotplug) makes the old counters meaningless.
            if self.cores_prev.len() == s.core_samples.len() {
                s.cores = s.core_samples.iter().zip(&self.cores_prev).map(|(&c, &p)| usage(p, c).unwrap_or(0.0)).collect();
            }
            self.cores_prev = std::mem::take(&mut s.core_samples);
        }
        let Some(sample) = s.cpu_sample else { return };
        if let Some(prev) = self.cpu_prev {
            s.cpu = usage(prev, sample);
        }
        self.cpu_prev = Some(sample);
    }
}

/// Busy percent between two (idle, total) counter samples.
fn usage((pi, pt): (u64, u64), (idle, total): (u64, u64)) -> Option<f32> {
    let (di, dt) = (idle.saturating_sub(pi), total.saturating_sub(pt));
    (dt > 0).then(|| (100.0 * (1.0 - di as f32 / dt as f32)).clamp(0.0, 100.0))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    pub fs: String,
    pub mount: String,
    /// Bytes.
    pub total: u64,
    pub used: u64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    /// Percent. Delta-based systems (Linux, FreeBSD) have None on the first sample.
    pub cpu: Option<f32>,
    pub cpus: Option<u32>,
    /// Percent per logical core; empty when unknown (macOS, first sample on Linux / FreeBSD).
    pub cores: Vec<f32>,
    /// None on Windows.
    pub load: Option<[f32; 3]>,
    /// Bytes.
    pub mem_total: u64,
    pub mem_used: u64,
    pub swap_total: u64,
    pub swap_used: u64,
    /// Seconds.
    pub uptime: Option<u64>,
    pub disks: Vec<Disk>,
    pub os: Option<String>,
    pub hostname: Option<String>,
    #[serde(skip)]
    pub cpu_sample: Option<(u64, u64)>,
    #[serde(skip)]
    pub core_samples: Vec<(u64, u64)>,
}

impl Stats {
    /// Whether the output came from a supported system at all.
    pub fn is_valid(&self) -> bool {
        self.mem_total > 0
    }
}

/// "1024.00M" → bytes.
fn size_with_unit(v: &str) -> Option<u64> {
    let v = v.trim();
    let (num, mul) = match v.chars().last()? {
        'K' | 'k' => (&v[..v.len() - 1], 1u64 << 10),
        'M' | 'm' => (&v[..v.len() - 1], 1 << 20),
        'G' | 'g' => (&v[..v.len() - 1], 1 << 30),
        'T' | 't' => (&v[..v.len() - 1], 1 << 40),
        _ => (v, 1),
    };
    num.parse::<f64>().ok().map(|n| (n * mul as f64) as u64)
}

fn floats(v: &str) -> Vec<f32> {
    v.split(|c: char| c.is_whitespace() || c == '{' || c == '}').filter_map(|x| x.parse().ok()).collect()
}

pub fn parse(text: &str) -> Stats {
    let mut s = Stats::default();
    let mut kind = String::from("linux");
    let mut section = "";
    let mut mem = HashMap::new();
    let mut sysctl: HashMap<String, String> = HashMap::new();
    let mut vmstat: HashMap<String, u64> = HashMap::new();
    let mut page_size = 4096u64;
    let mut now: Option<u64> = None;
    let mut ps_cpu: Option<f32> = None;
    for line in text.trim_start_matches('\u{feff}').lines() {
        if let Some(name) = line.strip_prefix("@@") {
            let name = name.trim();
            if let Some(k) = name.strip_prefix("os-kind") {
                let k = k.trim().to_ascii_lowercase();
                if !k.is_empty() {
                    kind = k;
                }
                section = "";
                continue;
            }
            section = match name {
                "stat" => "stat",
                "mem" => "mem",
                "load" => "load",
                "up" => "up",
                "ncpu" => "ncpu",
                "df" => "df",
                "os" => "os",
                "host" => "host",
                "sysctl" => "sysctl",
                "now" => "now",
                "vmstat" => "vmstat",
                "pscpu" => "pscpu",
                "swapinfo" => "swapinfo",
                "winmem" => "winmem",
                "winswap" => "winswap",
                "wincpu" => "wincpu",
                "wincores" => "wincores",
                "windisk" => "windisk",
                _ => "",
            };
            continue;
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match section {
            // "cpu  user nice system idle iowait irq softirq steal …", then one "cpuN …" per core.
            "stat" if line.starts_with("cpu") => {
                let mut it = line.split_whitespace();
                let name = it.next().unwrap_or("");
                let v: Vec<u64> = it.take(8).filter_map(|x| x.parse().ok()).collect();
                if v.len() >= 4 {
                    let sample = (v[3] + v.get(4).copied().unwrap_or(0), v.iter().sum());
                    if name == "cpu" {
                        s.cpu_sample = Some(sample);
                    } else if name[3..].parse::<u32>().is_ok() {
                        s.core_samples.push(sample);
                    }
                }
            }
            "mem" => {
                let mut it = line.split_whitespace();
                if let (Some(k), Some(v)) = (it.next(), it.next().and_then(|v| v.parse::<u64>().ok())) {
                    mem.insert(k.trim_end_matches(':').to_string(), v * 1024);
                }
            }
            "load" => {
                let v: Vec<f32> = line.split_whitespace().take(3).filter_map(|x| x.parse().ok()).collect();
                if v.len() == 3 {
                    s.load = Some([v[0], v[1], v[2]]);
                }
            }
            "up" => s.uptime = line.split_whitespace().next().and_then(|x| x.replace(',', ".").parse::<f64>().ok()).map(|x| x as u64),
            "ncpu" => s.cpus = line.parse().ok().filter(|&n| n > 0),
            "df" => parse_df_line(&mut s, line, &kind),
            "os" => s.os = Some(line.to_string()),
            "host" => s.hostname = Some(line.to_string()),
            "sysctl" => {
                if let Some((k, v)) = line.split_once(':') {
                    sysctl.insert(k.trim().to_string(), v.trim().to_string());
                }
            }
            "now" => now = line.parse().ok(),
            "vmstat" => {
                // "Mach Virtual Memory Statistics: (page size of 16384 bytes)" / "Pages free:   12345."
                if let Some(rest) = line.split("page size of ").nth(1) {
                    if let Some(n) = rest.split_whitespace().next().and_then(|x| x.parse().ok()) {
                        page_size = n;
                    }
                } else if let Some((k, v)) = line.rsplit_once(':') {
                    if let Ok(n) = v.trim().trim_end_matches('.').parse() {
                        vmstat.insert(k.trim().trim_matches('"').to_string(), n);
                    }
                }
            }
            // "%CPU" header, then one value per process.
            "pscpu" => {
                if let Ok(v) = line.parse::<f32>() {
                    *ps_cpu.get_or_insert(0.0) += v;
                }
            }
            // Device 1K-blocks Used Avail Capacity (plus a "Total" line with several devices)
            "swapinfo" => {
                let c: Vec<&str> = line.split_whitespace().collect();
                if c.len() >= 3 && c[0] != "Total" {
                    if let (Ok(t), Ok(u)) = (c[1].parse::<u64>(), c[2].parse::<u64>()) {
                        s.swap_total += t * 1024;
                        s.swap_used += u * 1024;
                    }
                }
            }
            // TotalVisibleMemorySize FreePhysicalMemory (KiB)
            "winmem" => {
                let v: Vec<u64> = line.split_whitespace().filter_map(|x| x.parse().ok()).collect();
                if v.len() == 2 {
                    s.mem_total = v[0] * 1024;
                    s.mem_used = v[0].saturating_sub(v[1]) * 1024;
                }
            }
            // Page file AllocatedBaseSize CurrentUsage (MiB), one line per file
            "winswap" => {
                let v: Vec<u64> = line.split_whitespace().filter_map(|x| x.parse().ok()).collect();
                if v.len() == 2 {
                    s.swap_total += v[0] << 20;
                    s.swap_used += v[1] << 20;
                }
            }
            "wincpu" => s.cpu = line.replace(',', ".").parse::<f32>().ok(),
            "wincores" => {
                if let Ok(v) = line.replace(',', ".").parse::<f32>() {
                    s.cores.push(v.clamp(0.0, 100.0));
                }
            }
            // DeviceID Size FreeSpace (bytes)
            "windisk" => {
                let c: Vec<&str> = line.split_whitespace().collect();
                if c.len() == 3 {
                    if let (Ok(total), Ok(free)) = (c[1].parse::<u64>(), c[2].parse::<u64>()) {
                        if total > 0 {
                            s.disks.push(Disk { fs: c[0].into(), mount: c[0].into(), total, used: total.saturating_sub(free) });
                        }
                    }
                }
            }
            _ => {}
        }
    }

    match kind.as_str() {
        "darwin" => finish_darwin(&mut s, &sysctl, &vmstat, page_size, ps_cpu),
        "freebsd" | "dragonfly" => finish_freebsd(&mut s, &sysctl),
        "windows" => {}
        _ => {
            let total = mem.get("MemTotal").copied().unwrap_or(0);
            let avail = mem
                .get("MemAvailable")
                .copied()
                .unwrap_or_else(|| ["MemFree", "Buffers", "Cached"].iter().filter_map(|k| mem.get(*k)).sum());
            s.mem_total = total;
            s.mem_used = total.saturating_sub(avail);
            s.swap_total = mem.get("SwapTotal").copied().unwrap_or(0);
            s.swap_used = s.swap_total.saturating_sub(mem.get("SwapFree").copied().unwrap_or(0));
        }
    }
    if s.uptime.is_none() {
        // kern.boottime: "{ sec = 1700000000, usec = 0 } Tue Nov 14 22:13:20 2023"
        let boot = sysctl
            .get("kern.boottime")
            .and_then(|v| v.split("sec =").nth(1))
            .and_then(|v| v.trim_start().split(|c: char| !c.is_ascii_digit()).next())
            .and_then(|x| x.parse::<u64>().ok());
        if let (Some(boot), Some(now)) = (boot, now) {
            s.uptime = Some(now.saturating_sub(boot));
        }
    }
    if s.load.is_none() {
        // vm.loadavg: "{ 0.52 0.41 0.38 }"
        if let Some(v) = sysctl.get("vm.loadavg").map(|v| floats(v)) {
            if v.len() >= 3 {
                s.load = Some([v[0], v[1], v[2]]);
            }
        }
    }
    if s.cpus.is_none() {
        s.cpus = sysctl.get("hw.ncpu").and_then(|v| v.parse().ok());
    }
    // Root first (Windows: drive letters alphabetically), then by mount path.
    s.disks.sort_by(|a, b| (a.mount != "/").cmp(&(b.mount != "/")).then_with(|| a.mount.cmp(&b.mount)));
    s
}

fn parse_df_line(s: &mut Stats, line: &str, kind: &str) {
    // Filesystem 1024-blocks Used Available Capacity Mounted-on (mount may contain spaces)
    let cols: Vec<&str> = line.split_whitespace().collect();
    if cols.len() < 6 || cols[1].parse::<u64>().is_err() {
        return; // header, or a filesystem name with spaces ("map auto_home" on macOS)
    }
    let fs = cols[0];
    let mount = cols[5..].join(" ");
    let real = fs.starts_with("/dev/") || mount == "/" || fs.contains(":/") || fs.starts_with("//");
    if !real || fs.starts_with("/dev/loop") || mount.starts_with("/snap/") || mount.starts_with("/boot/efi") {
        return;
    }
    let darwin = kind == "darwin";
    // macOS: APFS system volumes (VM, Preboot, Data…) live in the root container.
    if darwin && mount.starts_with("/System/Volumes/") {
        return;
    }
    let total = cols[1].parse::<u64>().unwrap_or(0) * 1024;
    let mut used = cols[2].parse::<u64>().unwrap_or(0) * 1024;
    if darwin {
        // APFS volumes share the container's free space, and the sealed "/" alone holds only a few GB:
        // report container usage instead.
        if let Ok(avail) = cols[3].parse::<u64>() {
            used = total.saturating_sub(avail * 1024);
        }
    }
    if total == 0 || s.disks.iter().any(|d| d.fs == fs && d.total == total) {
        return; // bind mounts / btrfs subvolumes show up repeatedly
    }
    s.disks.push(Disk { fs: fs.to_string(), mount, total, used });
}

fn finish_darwin(s: &mut Stats, sysctl: &HashMap<String, String>, vm: &HashMap<String, u64>, page: u64, ps_cpu: Option<f32>) {
    s.mem_total = sysctl.get("hw.memsize").and_then(|v| v.parse().ok()).unwrap_or(0);
    let get = |k: &str| vm.get(k).copied().unwrap_or(0);
    // Like Activity Monitor: app memory (anonymous − purgeable) + wired + compressed.
    let app = match vm.get("Anonymous pages") {
        Some(&anon) => anon.saturating_sub(get("Pages purgeable")),
        None => get("Pages active"),
    };
    let pages = app + get("Pages wired down") + get("Pages occupied by compressor");
    s.mem_used = (pages * page).min(s.mem_total);
    // vm.swapusage: "total = 2048.00M  used = 1024.00M  free = 1024.00M  (encrypted)"
    if let Some(v) = sysctl.get("vm.swapusage") {
        let field = |name: &str| {
            v.split(&format!("{name} =")).nth(1).and_then(|x| x.split_whitespace().next()).and_then(size_with_unit)
        };
        s.swap_total = field("total").unwrap_or(0);
        s.swap_used = field("used").unwrap_or(0);
    }
    // ps %cpu is a short decaying average per process; the sum spans all cores.
    let ncpu = sysctl.get("hw.ncpu").and_then(|v| v.parse::<f32>().ok()).unwrap_or(1.0).max(1.0);
    s.cpu = ps_cpu.map(|c| (c / ncpu).clamp(0.0, 100.0));
}

fn finish_freebsd(s: &mut Stats, sysctl: &HashMap<String, String>) {
    let num = |k: &str| sysctl.get(k).and_then(|v| v.parse::<u64>().ok());
    s.mem_total = num("hw.physmem").unwrap_or(0);
    let page = num("hw.pagesize").unwrap_or(4096);
    // v_cache_count is gone on newer releases: counts as 0.
    let free_pages: u64 = ["vm.stats.vm.v_free_count", "vm.stats.vm.v_inactive_count", "vm.stats.vm.v_cache_count"]
        .iter()
        .filter_map(|k| num(k))
        .sum();
    s.mem_used = s.mem_total.saturating_sub(free_pages * page);
    // kern.cp_time: user nice sys intr idle
    if let Some(v) = sysctl.get("kern.cp_time") {
        let v: Vec<u64> = v.split_whitespace().filter_map(|x| x.parse().ok()).collect();
        if v.len() >= 5 {
            s.cpu_sample = Some((v[4], v.iter().sum()));
        }
    }
    // kern.cp_times: the same five counters for each CPU in turn.
    if let Some(v) = sysctl.get("kern.cp_times") {
        let v: Vec<u64> = v.split_whitespace().filter_map(|x| x.parse().ok()).collect();
        s.core_samples = v.chunks_exact(5).map(|c| (c[4], c.iter().sum())).collect();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_linux_output() {
        let text = "@@stat\ncpu  100 0 50 800 50 0 0 0 0 0\ncpu0 60 0 30 380 30 0 0 0 0 0\ncpu1 40 0 20 420 20 0 0 0 0 0\n@@mem\nMemTotal:       2000 kB\nMemFree:         500 kB\nMemAvailable:   1500 kB\nSwapTotal:      1000 kB\nSwapFree:        750 kB\n@@load\n0.50 0.25 0.10 1/100 1234\n@@up\n3600.12 7000.00\n@@ncpu\n4\n@@df\nFilesystem     1024-blocks    Used Available Capacity Mounted on\nudev               1000       0      1000       0% /dev\n/dev/sda1         10000    4000      6000      40% /\n/dev/sdb1         20000    1000     19000       5% /mnt/my data\n/dev/loop0          100     100         0     100% /snap/core\n@@os\nUbuntu 24.04 LTS\n@@host\nweb-1\n@@end\n";
        for text in [text.to_string(), format!("@@os-kind Linux\n{text}")] {
            let s = parse(&text);
            assert_eq!(s.cpu_sample, Some((850, 1000)));
            assert_eq!(s.core_samples, [(410, 500), (440, 500)]);
            assert!(s.cores.is_empty());
            assert_eq!(s.mem_total, 2000 * 1024);
            assert_eq!(s.mem_used, 500 * 1024);
            assert_eq!(s.swap_used, 250 * 1024);
            assert_eq!(s.cpus, Some(4));
            assert_eq!(s.uptime, Some(3600));
            assert_eq!(s.disks.len(), 2);
            assert_eq!(s.disks[0].mount, "/");
            assert_eq!(s.disks[1].mount, "/mnt/my data");
            assert_eq!(s.os.as_deref(), Some("Ubuntu 24.04 LTS"));
            assert_eq!(s.hostname.as_deref(), Some("web-1"));
        }
    }

    #[test]
    fn linux_per_core_deltas() {
        // Realistic /proc/stat head (4 cores, 10 columns incl. guest).
        let first = "@@stat
cpu  4705 356 584 3699 23 23 0 0 0 0
cpu0 1393 280 141 899 4 9 0 0 0 0
cpu1 1132 33 178 950 8 5 0 0 0 0
cpu2 1103 22 132 928 5 4 0 0 0 0
cpu3 1077 21 133 922 6 5 0 0 0 0
intr 114930548 113199788 3 0 5 263 0 4 [...]
ctxt 1990473
@@mem
MemTotal: 1000 kB
";
        let second = "@@stat
cpu  4905 356 684 3899 23 23 0 0 0 0
cpu0 1493 280 141 899 4 9 0 0 0 0
cpu1 1132 33 178 1050 8 5 0 0 0 0
cpu2 1153 22 182 928 5 4 0 0 0 0
cpu3 1127 21 183 1022 6 5 0 0 0 0
@@mem
MemTotal: 1000 kB
";
        let mut st = State::default();
        let mut s1 = parse(first);
        assert_eq!(s1.core_samples.len(), 4);
        st.apply_cpu(&mut s1);
        assert!(s1.cores.is_empty());
        let mut s2 = parse(second);
        st.apply_cpu(&mut s2);
        assert!((s2.cpu.unwrap() - 60.0).abs() < 1e-3);
        assert_eq!(s2.cores, [100.0, 0.0, 100.0, 50.0]);
        // A core went offline: no per-core values for this sample, fresh baseline for the next.
        let mut s3 = parse(&second.replace("cpu3 1127 21 183 1022 6 5 0 0 0 0\n", ""));
        st.apply_cpu(&mut s3);
        assert!(s3.cores.is_empty());
        assert_eq!(st.cores_prev.len(), 3);
    }

    #[test]
    fn parses_darwin_output() {
        let text = "@@os-kind Darwin
@@sysctl
hw.memsize: 17179869184
hw.ncpu: 8
vm.loadavg: { 1.52 1.71 1.80 }
kern.boottime: { sec = 1700000000, usec = 123456 } Tue Nov 14 22:13:20 2023
vm.swapusage: total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)
@@now
1700090000
@@vmstat
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                9000.
Pages active:                            300000.
Pages inactive:                          290000.
Pages speculative:                         4000.
Pages throttled:                              0.
Pages wired down:                        150000.
Pages purgeable:                          10000.
\"Translation faults\":                1234567890.
Pages copy-on-write:                   12345678.
Pages zero filled:                    987654321.
Pages reactivated:                      1234567.
Pages purged:                            123456.
File-backed pages:                       250000.
Anonymous pages:                         350000.
Pages stored in compressor:              400000.
Pages occupied by compressor:            100000.
Decompressions:                         1000000.
Compressions:                           2000000.
Pageins:                                 300000.
Pageouts:                                  1000.
Swapins:                                      0.
Swapouts:                                     0.
@@pscpu
 %CPU
  25.0
  10.5
   0.0
 120.5
@@os
macOS 14.5
@@df
Filesystem     1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s1s1   482797652  10187412 300000000     4%    /
devfs                  213       213         0   100%    /dev
/dev/disk3s6     482797652   2097172 300000000     1%    /System/Volumes/VM
/dev/disk3s2     482797652   6012236 300000000     2%    /System/Volumes/Preboot
/dev/disk3s4     482797652      3460 300000000     1%    /System/Volumes/Update
/dev/disk1s2        512000      6000    490000     2%    /System/Volumes/xarts
/dev/disk3s5     482797652 160000000 300000000    35%    /System/Volumes/Data
map auto_home            0         0         0   100%    /System/Volumes/Data/home
/dev/disk4s1     976000000 500000000 476000000    52%    /Volumes/Backup Disk
@@host
mbp.local
@@end
";
        let s = parse(text);
        assert!(s.is_valid());
        assert_eq!(s.mem_total, 17179869184);
        assert_eq!(s.mem_used, (340000 + 150000 + 100000) * 16384);
        assert_eq!(s.cpus, Some(8));
        assert_eq!(s.cpu, Some(156.0 / 8.0));
        assert_eq!(s.cpu_sample, None);
        assert!(s.cores.is_empty() && s.core_samples.is_empty());
        assert_eq!(s.load, Some([1.52, 1.71, 1.80]));
        assert_eq!(s.uptime, Some(90000));
        assert_eq!(s.swap_total, 2048 << 20);
        assert_eq!(s.swap_used, (1024.5 * 1048576.0) as u64);
        assert_eq!(s.disks.len(), 2);
        assert_eq!(s.disks[0].mount, "/");
        assert_eq!(s.disks[0].used, (482797652 - 300000000) * 1024);
        assert_eq!(s.disks[1].mount, "/Volumes/Backup Disk");
        assert_eq!(s.os.as_deref(), Some("macOS 14.5"));
        assert_eq!(s.hostname.as_deref(), Some("mbp.local"));
    }

    #[test]
    fn parses_freebsd_output() {
        // v_cache_count is missing (newer FreeBSD).
        let text = "@@os-kind FreeBSD
@@sysctl
hw.physmem: 4294967296
hw.ncpu: 2
vm.loadavg: { 0.10 0.20 0.30 }
kern.boottime: { sec = 1700000000, usec = 5 } Tue Nov 14 22:13:20 2023
kern.cp_time: 1000 10 500 90 8400
kern.cp_times: 600 5 300 50 4045 400 5 200 40 4355
hw.pagesize: 4096
vm.stats.vm.v_free_count: 500000
vm.stats.vm.v_inactive_count: 100000
@@now
1700003600
@@swapinfo
Device          1K-blocks     Used    Avail Capacity
/dev/ada0p3       2097152    65536  2031616     3%
/dev/md99         1048576        0  1048576     0%
Total             3145728    65536  3080192     2%
@@os
FreeBSD 14.1-RELEASE-p3
@@df
Filesystem         1024-blocks    Used    Avail Capacity  Mounted on
zroot/ROOT/default    30000000 3000000 27000000    10%    /
devfs                        1       1        0   100%    /dev
/dev/gpt/efiboot0       266176    1872   264304     1%    /boot/efi
zroot/tmp             27000100     100 27000000     0%    /tmp
/dev/ada1p1           10000000 1000000  8200000    11%    /data
@@host
bsd1
@@end
";
        let s = parse(text);
        assert!(s.is_valid());
        assert_eq!(s.mem_total, 4294967296);
        assert_eq!(s.mem_used, 4294967296 - 600000 * 4096);
        assert_eq!(s.cpu_sample, Some((8400, 10000)));
        assert_eq!(s.core_samples, [(4045, 5000), (4355, 5000)]);
        assert_eq!(s.cpu, None);
        assert_eq!(s.cpus, Some(2));
        assert_eq!(s.load, Some([0.10, 0.20, 0.30]));
        assert_eq!(s.uptime, Some(3600));
        assert_eq!(s.swap_total, 3145728 * 1024);
        assert_eq!(s.swap_used, 65536 * 1024);
        let mounts: Vec<&str> = s.disks.iter().map(|d| d.mount.as_str()).collect();
        assert_eq!(mounts, ["/", "/data"]);
        assert_eq!(s.os.as_deref(), Some("FreeBSD 14.1-RELEASE-p3"));

        let mut st = State::default();
        let mut s1 = parse(text);
        st.apply_cpu(&mut s1);
        assert_eq!(s1.cpu, None);
        assert!(s1.cores.is_empty());
        let mut s2 = parse(
            &text
                .replace("1000 10 500 90 8400", "1100 10 550 90 8650")
                .replace("600 5 300 50 4045 400 5 200 40 4355", "700 5 350 50 4095 400 5 200 40 4555"),
        );
        st.apply_cpu(&mut s2);
        assert_eq!(s2.cpu, Some(37.5));
        assert_eq!(s2.cores, [75.0, 0.0]);
    }

    #[test]
    fn parses_windows_output() {
        let text = "\u{feff}@@os-kind windows\r\n@@winmem\r\n8388608 2097152\r\n@@winswap\r\n1280 300\r\n@@up\r\n86400\r\n@@os\r\nMicrosoft Windows Server 2022 Standard 10.0.20348\r\n@@wincpu\r\n12.5\r\n@@ncpu\r\n4\r\n@@wincores\r\n12\r\n0\r\n37\r\n100\r\n@@windisk\r\nD: 107374182400 53687091200\r\nC: 136365211648 36365211648\r\n@@host\r\nWIN-SRV01\r\n@@end\r\n";
        let s = parse(text);
        assert!(s.is_valid());
        assert_eq!(s.mem_total, 8388608 * 1024);
        assert_eq!(s.mem_used, 6291456 * 1024);
        assert_eq!(s.swap_total, 1280 << 20);
        assert_eq!(s.swap_used, 300 << 20);
        assert_eq!(s.uptime, Some(86400));
        assert_eq!(s.cpu, Some(12.5));
        assert_eq!(s.cpus, Some(4));
        assert_eq!(s.cores, [12.0, 0.0, 37.0, 100.0]);
        assert_eq!(s.load, None);
        assert_eq!(s.disks[0].mount, "C:");
        assert_eq!(s.disks[0].used, 100000000000);
        assert_eq!(s.disks[1].mount, "D:");
        assert_eq!(s.os.as_deref(), Some("Microsoft Windows Server 2022 Standard 10.0.20348"));
        assert_eq!(s.hostname.as_deref(), Some("WIN-SRV01"));
    }

    #[test]
    fn rejects_unknown_output() {
        assert!(!parse("").is_valid());
        assert!(!parse("'sh' is not recognized as an internal or external command").is_valid());
        // Git-for-Windows sh in PATH: only df / hostname come through.
        assert!(!parse("@@os-kind MINGW64_NT-10.0\n@@df\n@@host\nwin\n@@end\n").is_valid());
    }

    #[test]
    fn base64_matches_reference() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        // "$E" in UTF-16LE.
        assert!(powershell_command().starts_with("powershell -NoProfile -NonInteractive -EncodedCommand JABFA"));
    }

    #[test]
    fn sh_command_is_shell_safe() {
        let inner = COMMAND.strip_prefix("sh -c '").and_then(|c| c.strip_suffix('\'')).unwrap();
        assert!(!inner.contains(['\'', '!', '\\', '\n']));
    }
}
