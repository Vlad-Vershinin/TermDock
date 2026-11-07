//! A small reader for OpenSSH's ~/.ssh/config: Host blocks with wildcards / negation,
//! first-match-wins options, Include. Only the options TermDock uses are interpreted.

use std::path::{Path, PathBuf};

use serde::Serialize;

struct Block {
    /// Host patterns; empty = never matches (a `Match` block, which is not supported).
    patterns: Vec<String>,
    /// (lowercase keyword, value)
    options: Vec<(String, String)>,
}

#[derive(Default)]
pub struct SshConfig {
    blocks: Vec<Block>,
}

/// Options resolved for one host alias.
#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostConfig {
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    /// Raw values (tokens and ~ not expanded yet).
    pub identity_files: Vec<String>,
    /// None when not set or set to `none`.
    pub proxy_jump: Option<String>,
}

/// One entry of a ProxyJump list: `[user@]host[:port]`.
#[derive(Debug, Clone, PartialEq)]
pub struct JumpSpec {
    pub user: Option<String>,
    pub host: String,
    pub port: Option<u16>,
}

const MAX_INCLUDE_DEPTH: usize = 8;

impl SshConfig {
    /// Reads ~/.ssh/config; a missing or unreadable file gives an empty config.
    pub fn load() -> Self {
        let Some(dir) = dirs::home_dir().map(|h| h.join(".ssh")) else { return Self::default() };
        let mut cfg = Self::default();
        if let Ok(text) = std::fs::read_to_string(dir.join("config")) {
            cfg.parse_into(&text, &dir, 0);
        }
        cfg
    }

    #[cfg(test)]
    pub fn parse(text: &str) -> Self {
        let mut cfg = Self::default();
        cfg.parse_into(text, Path::new("."), 0);
        cfg
    }

    fn parse_into(&mut self, text: &str, ssh_dir: &Path, depth: usize) {
        // Options before the first Host line apply to every host.
        if self.blocks.is_empty() {
            self.blocks.push(Block { patterns: vec!["*".into()], options: Vec::new() });
        }
        for line in text.lines() {
            let Some((key, value)) = split_line(line) else { continue };
            match key.as_str() {
                "host" => {
                    let patterns = words(&value);
                    self.blocks.push(Block { patterns, options: Vec::new() });
                }
                "match" => {
                    // Conditions are not evaluated: skip the block entirely.
                    self.blocks.push(Block { patterns: Vec::new(), options: Vec::new() });
                }
                "include" if depth < MAX_INCLUDE_DEPTH => {
                    let outer = self.blocks.last().map(|b| b.patterns.clone()).unwrap_or_default();
                    for pattern in words(&value) {
                        for file in include_files(&pattern, ssh_dir) {
                            if let Ok(t) = std::fs::read_to_string(&file) {
                                self.parse_into(&t, ssh_dir, depth + 1);
                            }
                        }
                    }
                    // Lines after the Include belong to the block it was in.
                    self.blocks.push(Block { patterns: outer, options: Vec::new() });
                }
                _ => self.blocks.last_mut().unwrap().options.push((key, value)),
            }
        }
    }

    /// Options for `host`, first obtained value wins (IdentityFile accumulates), like OpenSSH.
    pub fn resolve(&self, host: &str) -> HostConfig {
        let mut out = HostConfig::default();
        let mut jump_set = false;
        for b in self.blocks.iter().filter(|b| host_matches(&b.patterns, host)) {
            for (key, value) in &b.options {
                let first = unquote(value.split_whitespace().next().unwrap_or(""));
                match key.as_str() {
                    "hostname" if out.hostname.is_none() => out.hostname = Some(first.replace("%h", host).replace("%%", "%")),
                    "user" if out.user.is_none() => out.user = Some(first),
                    "port" if out.port.is_none() => out.port = first.parse().ok(),
                    "identityfile" if !first.is_empty() && !first.eq_ignore_ascii_case("none") => out.identity_files.push(first),
                    "proxyjump" if !jump_set => {
                        jump_set = true;
                        let v = unquote(value.trim());
                        out.proxy_jump = (!v.eq_ignore_ascii_case("none") && !v.is_empty()).then_some(v);
                    }
                    _ => {}
                }
            }
        }
        out
    }
}

/// `Keyword value`, `Keyword=value` or `Keyword = value`; None for blanks and comments.
fn split_line(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let end = line.find(|c: char| c.is_whitespace() || c == '=').unwrap_or(line.len());
    let key = line[..end].to_ascii_lowercase();
    let rest = line[end..].trim_start();
    let rest = rest.strip_prefix('=').unwrap_or(rest).trim();
    Some((key, rest.to_string()))
}

/// Whitespace-separated words, honouring double quotes.
fn words(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for c in s.chars() {
        match c {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn unquote(s: &str) -> String {
    s.strip_prefix('"').and_then(|x| x.strip_suffix('"')).unwrap_or(s).to_string()
}

/// A host matches if some positive pattern matches and no negated one does.
fn host_matches(patterns: &[String], host: &str) -> bool {
    let mut matched = false;
    for p in patterns {
        if let Some(neg) = p.strip_prefix('!') {
            if glob(neg, host) {
                return false;
            }
        } else if glob(p, host) {
            matched = true;
        }
    }
    matched
}

/// `*` and `?` wildcards, case-insensitive (host names are).
pub fn glob(pattern: &str, s: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let s: Vec<char> = s.to_lowercase().chars().collect();
    let (mut pi, mut si) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while si < s.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == s[si]) {
            pi += 1;
            si += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some((pi, si));
            pi += 1;
        } else if let Some((sp, ss)) = star {
            pi = sp + 1;
            si = ss + 1;
            star = Some((sp, ss + 1));
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|&c| c == '*')
}

/// Files for an Include argument: relative paths are under ~/.ssh; wildcards in the file name.
fn include_files(pattern: &str, ssh_dir: &Path) -> Vec<PathBuf> {
    let path = expand_home(pattern);
    let path = if path.is_absolute() { path } else { ssh_dir.join(path) };
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !name.contains(['*', '?']) {
        return vec![path];
    }
    let dir = path.parent().unwrap_or(ssh_dir);
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(Result::ok)
                .filter(|e| glob(&name, &e.file_name().to_string_lossy()))
                .map(|e| e.path())
                .filter(|p| p.is_file())
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files
}

fn expand_home(p: &str) -> PathBuf {
    crate::ssh::expand_tilde(p)
}

/// Expands ~ and the %h / %u / %r / %d / %% tokens of an IdentityFile value.
pub fn expand_path(value: &str, host: &str, remote_user: &str) -> PathBuf {
    let home = dirs::home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or_default();
    let mut out = String::new();
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('h') => out.push_str(host),
            Some('r') => out.push_str(remote_user),
            Some('u') => out.push_str(&local_user()),
            Some('d') => out.push_str(&home),
            Some('%') => out.push('%'),
            Some(other) => {
                out.push('%');
                out.push(other);
            }
            None => out.push('%'),
        }
    }
    expand_home(&out)
}

/// The local user name (OpenSSH's default remote user).
pub fn local_user() -> String {
    std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_else(|_| "root".into())
}

/// Parses a ProxyJump value: `[ssh://][user@]host[:port]` entries separated by commas.
pub fn parse_proxy_jump(value: &str) -> Vec<JumpSpec> {
    value
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            let s = s.strip_prefix("ssh://").unwrap_or(s);
            let (user, hostport) = match s.rsplit_once('@') {
                Some((u, h)) => (Some(u.to_string()), h),
                None => (None, s),
            };
            // [IPv6]:port, host:port or a bare host / IPv6 address.
            let (host, port) = if let Some(rest) = hostport.strip_prefix('[') {
                let (h, tail) = rest.split_once(']').unwrap_or((rest, ""));
                (h.to_string(), tail.strip_prefix(':').and_then(|p| p.parse().ok()))
            } else if hostport.matches(':').count() == 1 {
                let (h, p) = hostport.split_once(':').unwrap();
                (h.to_string(), p.parse().ok())
            } else {
                (hostport.to_string(), None)
            };
            JumpSpec { user, host, port }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_wildcards() {
        assert!(glob("*", "anything"));
        assert!(glob("*.example.com", "web.EXAMPLE.com"));
        assert!(!glob("*.example.com", "example.com"));
        assert!(glob("web-?", "web-1"));
        assert!(!glob("web-?", "web-10"));
        assert!(glob("a*b*c", "aXXbYYc"));
        assert!(!glob("a*b*c", "aXXbYY"));
        assert!(glob("10.0.*.*", "10.0.1.2"));
    }

    #[test]
    fn negation() {
        let p = vec!["*.corp".to_string(), "!bastion.corp".to_string()];
        assert!(host_matches(&p, "db.corp"));
        assert!(!host_matches(&p, "bastion.corp"));
        assert!(!host_matches(&["!x".to_string()], "y"), "negation alone never matches");
    }

    #[test]
    fn line_forms() {
        assert_eq!(split_line("  HostName  example.com"), Some(("hostname".into(), "example.com".into())));
        assert_eq!(split_line("Port=2222"), Some(("port".into(), "2222".into())));
        assert_eq!(split_line("USER = bob"), Some(("user".into(), "bob".into())));
        assert_eq!(split_line("# comment"), None);
        assert_eq!(split_line("   "), None);
    }

    const SAMPLE: &str = r#"
# global
User globaluser

Host bastion
    HostName 203.0.113.5
    User jump
    Port 2200
    IdentityFile ~/.ssh/bastion_key

Host db-* !db-public
    ProxyJump bastion
    User dba

Host db-1
    HostName 10.0.0.11
    User ignored-because-db-star-came-first

Host direct
    ProxyJump none

Host *
    ProxyJump fallback
    Port 22
    IdentityFile "~/.ssh/id_%h"
"#;

    #[test]
    fn first_match_wins() {
        let c = SshConfig::parse(SAMPLE);
        let b = c.resolve("bastion");
        assert_eq!(b.hostname.as_deref(), Some("203.0.113.5"));
        assert_eq!(b.user.as_deref(), Some("globaluser"), "options before any Host apply to all");
        assert_eq!(b.port, Some(2200));
        assert_eq!(b.identity_files, vec!["~/.ssh/bastion_key", "~/.ssh/id_%h"]);
        assert_eq!(b.proxy_jump.as_deref(), Some("fallback"));

        let d = c.resolve("db-1");
        assert_eq!(d.hostname.as_deref(), Some("10.0.0.11"));
        assert_eq!(d.proxy_jump.as_deref(), Some("bastion"));
        assert_eq!(d.port, Some(22));

        let p = c.resolve("db-public");
        assert_eq!(p.proxy_jump.as_deref(), Some("fallback"));
        assert_eq!(p.hostname, None);

        assert_eq!(c.resolve("direct").proxy_jump, None, "ProxyJump none disables later values");
    }

    #[test]
    fn case_insensitive_and_hostname_token() {
        let c = SshConfig::parse("HOST Web\n  hostname %h.example.com\n  PROXYJUMP=a,b");
        let w = c.resolve("web");
        assert_eq!(w.hostname.as_deref(), Some("web.example.com"));
        assert_eq!(w.proxy_jump.as_deref(), Some("a,b"));
    }

    #[test]
    fn match_blocks_are_skipped() {
        let c = SshConfig::parse("Match host foo\n  User nope\nHost foo\n  User yes");
        assert_eq!(c.resolve("foo").user.as_deref(), Some("yes"));
    }

    #[test]
    fn include_files_are_read() {
        let dir = std::env::temp_dir().join(format!("td-sshcfg-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("conf.d")).unwrap();
        std::fs::write(dir.join("conf.d/a.conf"), "Host inc\n  HostName included.example\n").unwrap();
        std::fs::write(dir.join("conf.d/skip.txt"), "Host inc\n  HostName wrong\n").unwrap();
        let mut c = SshConfig::default();
        c.parse_into("Host other\n  Include conf.d/*.conf\n  User after-include\nHost inc\n  User incuser", &dir, 0);
        let r = c.resolve("inc");
        assert_eq!(r.hostname.as_deref(), Some("included.example"));
        assert_eq!(r.user.as_deref(), Some("incuser"));
        assert_eq!(c.resolve("other").user.as_deref(), Some("after-include"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn proxy_jump_specs() {
        let j = parse_proxy_jump("bastion, alice@gw.example:2222,ssh://bob@[2001:db8::1]:22,[::1],fe80::1");
        assert_eq!(j[0], JumpSpec { user: None, host: "bastion".into(), port: None });
        assert_eq!(j[1], JumpSpec { user: Some("alice".into()), host: "gw.example".into(), port: Some(2222) });
        assert_eq!(j[2], JumpSpec { user: Some("bob".into()), host: "2001:db8::1".into(), port: Some(22) });
        assert_eq!(j[3], JumpSpec { user: None, host: "::1".into(), port: None });
        assert_eq!(j[4], JumpSpec { user: None, host: "fe80::1".into(), port: None });
    }

    #[test]
    fn identity_tokens() {
        let p = expand_path("/keys/%r@%h%%", "srv", "bob");
        assert_eq!(p, PathBuf::from("/keys/bob@srv%"));
    }
}
