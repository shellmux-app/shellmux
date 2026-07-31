/// Path helpers shared by anything that accepts a user-typed or config-file path.
///
/// Every place that takes a key path has to do this: `~/.ssh/id_ed25519` is what
/// users type and what `~/.ssh/config` contains, but no filesystem call expands
/// it — passing it through raw produces a confusing "file not found".

/// Expands a leading `~/`. `~user/` is deliberately not handled: resolving
/// another user's home needs platform-specific passwd lookups, and no SSH
/// client path in this app has a legitimate reason to read one.
pub fn expand_tilde(path: &str) -> String {
    expand_tilde_with(path, home_dir().as_deref())
}

/// The pure half of [`expand_tilde`], with the home directory passed in.
/// Exists so tests can cover the expansion rules without mutating
/// process-global env vars — `cargo test` runs a binary's tests on parallel
/// threads, so a test that sets or clears `HOME` races every other test that
/// reads it.
fn expand_tilde_with(path: &str, home: Option<&str>) -> String {
    match path.strip_prefix("~/") {
        Some(rest) => match home {
            Some(home) => format!("{}/{rest}", home.trim_end_matches(['/', '\\'])),
            None => path.to_string(),
        },
        None => path.to_string(),
    }
}

/// `HOME` is the Unix convention; Windows shells set `USERPROFILE` instead.
pub fn home_dir() -> Option<String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_a_leading_tilde_slash() {
        assert_eq!(
            expand_tilde_with("~/.ssh/id_ed25519", Some("/Users/test")),
            "/Users/test/.ssh/id_ed25519"
        );
    }

    #[test]
    fn leaves_absolute_and_relative_paths_alone() {
        assert_eq!(expand_tilde_with("/etc/ssh/key", Some("/h")), "/etc/ssh/key");
        assert_eq!(expand_tilde_with("./key", Some("/h")), "./key");
    }

    #[test]
    fn does_not_touch_a_bare_tilde_or_another_users_home() {
        // `~user/` is not expanded on purpose — see the module docs.
        assert_eq!(
            expand_tilde_with("~otheruser/.ssh/key", Some("/h")),
            "~otheruser/.ssh/key"
        );
        assert_eq!(expand_tilde_with("~", Some("/h")), "~");
    }

    #[test]
    fn does_not_double_the_separator_when_home_has_a_trailing_slash() {
        assert_eq!(expand_tilde_with("~/key", Some("/Users/test/")), "/Users/test/key");
    }

    #[test]
    fn leaves_the_tilde_alone_when_no_home_can_be_determined() {
        assert_eq!(expand_tilde_with("~/key", None), "~/key");
    }

    #[test]
    fn trims_a_windows_style_trailing_separator() {
        // Windows shells set USERPROFILE rather than HOME (see `home_dir`),
        // and its value uses backslashes.
        assert_eq!(
            expand_tilde_with("~/.ssh/config", Some("C:\\Users\\test\\")),
            "C:\\Users\\test/.ssh/config"
        );
    }
}
