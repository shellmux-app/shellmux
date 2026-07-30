//! Parser cho `~/.ssh/config`.
//!
//! Theo ngữ nghĩa của OpenSSH: một alias có thể khớp nhiều khối `Host`, và với
//! mỗi option thì **giá trị xuất hiện đầu tiên thắng** (không phải cuối cùng).
//! Vì vậy phải giữ nguyên thứ tự khối trong file rồi mới resolve.

/// Một khối `Host` thô, chưa resolve.
#[derive(Debug, Clone)]
struct Block {
    patterns: Vec<String>,
    options: Vec<(String, String)>,
}

/// Một host cụ thể sau khi đã resolve toàn bộ option áp dụng cho nó.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshConfigHost {
    pub alias: String,
    pub hostname: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
    pub forward_agent: bool,
}

/// Kết quả parse, kèm những thứ bị bỏ qua để báo lại cho người dùng thay vì
/// im lặng nuốt.
#[derive(Debug, Default)]
pub struct ParseResult {
    pub hosts: Vec<SshConfigHost>,
    /// Số chỉ thị `Include` gặp phải — chưa hỗ trợ, xem ROADMAP.
    pub includes_skipped: usize,
    /// Alias chỉ chứa wildcard (`Host *`): dùng làm mặc định, không import.
    pub wildcard_blocks: usize,
}

pub fn parse(text: &str) -> ParseResult {
    let mut result = ParseResult::default();
    let mut blocks: Vec<Block> = Vec::new();
    let mut current: Option<Block> = None;

    for raw in text.lines() {
        let line = strip_comment(raw);
        if line.is_empty() {
            continue;
        }

        let Some((key, value)) = split_option(line) else {
            continue;
        };
        let key_lower = key.to_ascii_lowercase();

        if key_lower == "include" {
            result.includes_skipped += 1;
            continue;
        }

        if key_lower == "host" {
            if let Some(block) = current.take() {
                blocks.push(block);
            }
            current = Some(Block {
                patterns: value.split_whitespace().map(str::to_string).collect(),
                options: Vec::new(),
            });
            continue;
        }

        // `Match` có ngữ nghĩa điều kiện phức tạp (exec, user, ...) — bỏ qua cả
        // khối thay vì import sai.
        if key_lower == "match" {
            if let Some(block) = current.take() {
                blocks.push(block);
            }
            continue;
        }

        if let Some(block) = current.as_mut() {
            block.options.push((key_lower, value.to_string()));
        }
    }

    if let Some(block) = current.take() {
        blocks.push(block);
    }

    let mut aliases: Vec<String> = Vec::new();
    for block in &blocks {
        if block.patterns.iter().all(|p| is_wildcard(p)) {
            result.wildcard_blocks += 1;
        }
        for pattern in &block.patterns {
            // Alias phủ định (`!host`) chỉ dùng để loại trừ, không phải host thật.
            if is_wildcard(pattern) || pattern.starts_with('!') {
                continue;
            }
            if !aliases.contains(pattern) {
                aliases.push(pattern.clone());
            }
        }
    }

    result.hosts = aliases
        .into_iter()
        .map(|alias| resolve(&alias, &blocks))
        .collect();
    result
}

fn resolve(alias: &str, blocks: &[Block]) -> SshConfigHost {
    let lookup = |key: &str| -> Option<String> {
        blocks
            .iter()
            .filter(|block| matches_any(alias, &block.patterns))
            .flat_map(|block| block.options.iter())
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
    };

    SshConfigHost {
        hostname: lookup("hostname").unwrap_or_else(|| alias.to_string()),
        alias: alias.to_string(),
        user: lookup("user"),
        port: lookup("port").and_then(|p| p.parse().ok()),
        identity_file: lookup("identityfile").map(|p| expand_tilde(&p)),
        proxy_jump: lookup("proxyjump").filter(|v| v.to_ascii_lowercase() != "none"),
        forward_agent: lookup("forwardagent")
            .map(|v| v.eq_ignore_ascii_case("yes"))
            .unwrap_or(false),
    }
}

/// Khớp alias với danh sách pattern của một khối, có xử lý phủ định `!`.
fn matches_any(alias: &str, patterns: &[String]) -> bool {
    let mut matched = false;
    for pattern in patterns {
        if let Some(negated) = pattern.strip_prefix('!') {
            if glob_match(negated, alias) {
                return false;
            }
        } else if glob_match(pattern, alias) {
            matched = true;
        }
    }
    matched
}

/// Glob của ssh_config chỉ có `*` và `?` — không cần regex.
fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut backtrack) = (usize::MAX, 0usize);

    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = pi;
            backtrack = ti;
            pi += 1;
        } else if star != usize::MAX {
            pi = star + 1;
            backtrack += 1;
            ti = backtrack;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

fn is_wildcard(pattern: &str) -> bool {
    pattern.contains('*') || pattern.contains('?')
}

fn strip_comment(line: &str) -> &str {
    let without = line.split('#').next().unwrap_or("");
    without.trim()
}

/// ssh_config chấp nhận cả `Key value` lẫn `Key=value`.
fn split_option(line: &str) -> Option<(&str, &str)> {
    if let Some((key, value)) = line.split_once('=') {
        let key = key.trim();
        let value = value.trim();
        if !key.is_empty() && !key.contains(char::is_whitespace) {
            return Some((key, unquote(value)));
        }
    }
    let mut parts = line.splitn(2, char::is_whitespace);
    let key = parts.next()?.trim();
    let value = parts.next()?.trim();
    if key.is_empty() || value.is_empty() {
        return None;
    }
    Some((key, unquote(value)))
}

fn unquote(value: &str) -> &str {
    value
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .unwrap_or(value)
}

fn expand_tilde(path: &str) -> String {
    match path.strip_prefix("~/") {
        Some(rest) => match std::env::var("HOME") {
            Ok(home) => format!("{home}/{rest}"),
            Err(_) => path.to_string(),
        },
        None => path.to_string(),
    }
}

/// `ProxyJump` có dạng `[user@]host[:port]`, và có thể là một chuỗi nhiều tầng
/// ngăn bởi dấu phẩy — tầng đầu tiên là nơi kết nối tới trước.
pub fn first_jump_target(spec: &str) -> &str {
    let first = spec.split(',').next().unwrap_or(spec).trim();
    let without_user = first.rsplit('@').next().unwrap_or(first);
    without_user.split(':').next().unwrap_or(without_user)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_basic_host_block() {
        let cfg = "Host web\n  HostName 10.0.0.5\n  User deploy\n  Port 2222\n";

        let hosts = parse(cfg).hosts;

        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "web");
        assert_eq!(hosts[0].hostname, "10.0.0.5");
        assert_eq!(hosts[0].user.as_deref(), Some("deploy"));
        assert_eq!(hosts[0].port, Some(2222));
    }

    #[test]
    fn falls_back_to_the_alias_when_hostname_is_absent() {
        let hosts = parse("Host example.com\n  User root\n").hosts;

        assert_eq!(hosts[0].hostname, "example.com");
    }

    #[test]
    fn first_value_wins_like_openssh_not_last() {
        // OpenSSH lấy giá trị *đầu tiên* khớp, khác với trực giác "ghi đè".
        let cfg = "Host web\n  User first\nHost *\n  User fallback\n";

        let hosts = parse(cfg).hosts;

        assert_eq!(hosts[0].user.as_deref(), Some("first"));
    }

    #[test]
    fn wildcard_block_supplies_defaults_but_is_not_imported_itself() {
        let cfg = "Host *\n  User ubuntu\n  Port 2222\nHost web\n  HostName 10.0.0.5\n";

        let result = parse(cfg);

        assert_eq!(result.hosts.len(), 1, "chỉ `web` được import");
        assert_eq!(result.hosts[0].user.as_deref(), Some("ubuntu"));
        assert_eq!(result.hosts[0].port, Some(2222));
        assert_eq!(result.wildcard_blocks, 1);
    }

    #[test]
    fn one_host_line_can_declare_several_aliases() {
        let cfg = "Host web1 web2\n  User deploy\n";

        let hosts = parse(cfg).hosts;

        assert_eq!(hosts.len(), 2);
        assert!(hosts.iter().all(|h| h.user.as_deref() == Some("deploy")));
    }

    #[test]
    fn negated_pattern_excludes_the_block() {
        let cfg = "Host web\n  HostName 10.0.0.5\nHost * !web\n  User nobody\n";

        let hosts = parse(cfg).hosts;

        assert_eq!(hosts[0].user, None, "`!web` phải loại khối đó khỏi web");
    }

    #[test]
    fn accepts_equals_syntax_comments_and_quotes() {
        let cfg = "Host web # máy chủ chính\n  HostName=10.0.0.5\n  User=\"deploy\"\n";

        let hosts = parse(cfg).hosts;

        assert_eq!(hosts[0].hostname, "10.0.0.5");
        assert_eq!(hosts[0].user.as_deref(), Some("deploy"));
    }

    #[test]
    fn reports_includes_instead_of_silently_dropping_them() {
        let result = parse("Include ~/.ssh/conf.d/*\nHost web\n  HostName 10.0.0.5\n");

        assert_eq!(result.includes_skipped, 1);
        assert_eq!(result.hosts.len(), 1);
    }

    #[test]
    fn match_blocks_are_skipped_entirely() {
        let cfg = "Host web\n  HostName 10.0.0.5\nMatch user root\n  Port 2222\n";

        let hosts = parse(cfg).hosts;

        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].port, None, "option trong Match không được áp");
    }

    #[test]
    fn reads_proxy_jump_and_forward_agent() {
        let cfg = "Host db\n  HostName 10.0.0.9\n  ProxyJump bastion\n  ForwardAgent yes\n";

        let hosts = parse(cfg).hosts;

        assert_eq!(hosts[0].proxy_jump.as_deref(), Some("bastion"));
        assert!(hosts[0].forward_agent);
    }

    #[test]
    fn proxy_jump_target_strips_user_and_port() {
        assert_eq!(first_jump_target("bastion"), "bastion");
        assert_eq!(first_jump_target("admin@bastion:2222"), "bastion");
        assert_eq!(first_jump_target("a@first,b@second"), "first");
    }

    #[test]
    fn glob_matches_the_way_ssh_config_expects() {
        assert!(glob_match("*.example.com", "web.example.com"));
        assert!(glob_match("web?", "web1"));
        assert!(!glob_match("web?", "web12"));
        assert!(glob_match("*", "anything"));
        assert!(!glob_match("*.example.com", "example.com"));
    }
}
