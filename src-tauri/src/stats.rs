//! Server telemetry: one shell command that dumps /proc + df, parsed here.

use serde::Serialize;

/// Runs under `sh` explicitly so it works whatever the user's login shell is (fish, csh…).
pub const COMMAND: &str = "sh -c 'export LC_ALL=C; \
echo @@stat; head -n1 /proc/stat; \
echo @@mem; cat /proc/meminfo; \
echo @@load; cat /proc/loadavg; \
echo @@up; cat /proc/uptime; \
echo @@ncpu; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo; \
echo @@df; df -Pk 2>/dev/null; \
echo @@os; (. /etc/os-release 2>/dev/null && echo \"$PRETTY_NAME\"); \
echo @@host; hostname 2>/dev/null; \
echo @@end' 2>/dev/null";

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
    /// Percent, None on the first sample (needs a delta).
    pub cpu: Option<f32>,
    pub cpus: Option<u32>,
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
}

pub fn parse(text: &str) -> Stats {
    let mut s = Stats::default();
    let mut section = "";
    let mut mem = std::collections::HashMap::new();
    for line in text.lines() {
        if let Some(name) = line.strip_prefix("@@") {
            section = match name {
                "stat" => "stat",
                "mem" => "mem",
                "load" => "load",
                "up" => "up",
                "ncpu" => "ncpu",
                "df" => "df",
                "os" => "os",
                "host" => "host",
                _ => "",
            };
            continue;
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match section {
            "stat" if line.starts_with("cpu ") => {
                let v: Vec<u64> = line.split_whitespace().skip(1).take(8).filter_map(|x| x.parse().ok()).collect();
                if v.len() >= 4 {
                    let idle = v[3] + v.get(4).copied().unwrap_or(0);
                    s.cpu_sample = Some((idle, v.iter().sum()));
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
            "up" => s.uptime = line.split_whitespace().next().and_then(|x| x.parse::<f64>().ok()).map(|x| x as u64),
            "ncpu" => s.cpus = line.parse().ok(),
            "df" => {
                // Filesystem 1024-blocks Used Available Capacity Mounted-on (mount may contain spaces)
                let cols: Vec<&str> = line.split_whitespace().collect();
                if cols.len() < 6 || cols[1].parse::<u64>().is_err() {
                    continue;
                }
                let fs = cols[0];
                let mount = cols[5..].join(" ");
                let real = fs.starts_with("/dev/") || mount == "/" || fs.contains(":/") || fs.starts_with("//");
                if !real || fs.starts_with("/dev/loop") || mount.starts_with("/snap/") || mount.starts_with("/boot/efi") {
                    continue;
                }
                let total = cols[1].parse::<u64>().unwrap_or(0) * 1024;
                let used = cols[2].parse::<u64>().unwrap_or(0) * 1024;
                if total == 0 || s.disks.iter().any(|d| d.fs == fs && d.total == total) {
                    continue; // bind mounts / btrfs subvolumes show up repeatedly
                }
                s.disks.push(Disk { fs: fs.to_string(), mount, total, used });
            }
            "os" => s.os = Some(line.to_string()),
            "host" => s.hostname = Some(line.to_string()),
            _ => {}
        }
    }
    let total = mem.get("MemTotal").copied().unwrap_or(0);
    let avail = mem
        .get("MemAvailable")
        .copied()
        .unwrap_or_else(|| ["MemFree", "Buffers", "Cached"].iter().filter_map(|k| mem.get(*k)).sum());
    s.mem_total = total;
    s.mem_used = total.saturating_sub(avail);
    s.swap_total = mem.get("SwapTotal").copied().unwrap_or(0);
    s.swap_used = s.swap_total.saturating_sub(mem.get("SwapFree").copied().unwrap_or(0));
    // Root first, then by mount path.
    s.disks.sort_by(|a, b| (a.mount != "/").cmp(&(b.mount != "/")).then_with(|| a.mount.cmp(&b.mount)));
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_linux_output() {
        let text = "@@stat\ncpu  100 0 50 800 50 0 0 0 0 0\n@@mem\nMemTotal:       2000 kB\nMemFree:         500 kB\nMemAvailable:   1500 kB\nSwapTotal:      1000 kB\nSwapFree:        750 kB\n@@load\n0.50 0.25 0.10 1/100 1234\n@@up\n3600.12 7000.00\n@@ncpu\n4\n@@df\nFilesystem     1024-blocks    Used Available Capacity Mounted on\nudev               1000       0      1000       0% /dev\n/dev/sda1         10000    4000      6000      40% /\n/dev/sdb1         20000    1000     19000       5% /mnt/my data\n/dev/loop0          100     100         0     100% /snap/core\n@@os\nUbuntu 24.04 LTS\n@@host\nweb-1\n@@end\n";
        let s = parse(text);
        assert_eq!(s.cpu_sample, Some((850, 1000)));
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
