# Lessons from Tabby

[Tabby](https://github.com/Eugeny/tabby) (MIT, Electron + Angular) is the
most mature open-source terminal/SSH client in this category. A clone of
it lives at `docs/tabby` (already added to `.gitignore`) and is indexed
with GitNexus so it can be looked up via the call graph instead of grep.

**On the license:** Tabby is MIT. This document records *design ideas*,
not copied code — Shellmux is written in Rust, so no line is carried over
verbatim. If actual code is ever ported from Tabby, their copyright notice
must be preserved.

## Already applied

| Tabby idea | Source in the Tabby repo | Shellmux version |
| --- | --- | --- |
| Import `~/.ssh/config`, host id derived from the alias so re-importing is an update | `tabby-electron/src/sshImporters.ts` | `src-tauri/src/sshconfig/` |
| Dynamic forward runs SOCKS5 then opens a channel to whatever destination the client requests | `tabby-ssh/src/session/forwards.ts` | `src-tauri/src/socks.rs` + `tunnel.rs` |
| In-place reconnect, "press any key to reconnect" | `tabby-terminal/src/api/connectableTerminalTab.component.ts` | `session_reconnect` + `TerminalView` |

Three points worth recording because they aren't obvious:

1. **Order in `ssh_config` is "first value wins,"** not last. A `Host *`
   placed at the top of the file overrides every block below it — that's
   why `ssh_config(5)` says to put it at the end. Shellmux's parser
   follows this exact semantics and has a dedicated test for it.
2. **Only reply SOCKS "success" once the SSH channel has actually
   opened.** Replying early makes the client think it's connected while
   the other end might still refuse.
3. **Reconnect must keep the same session id.** Tabby swaps out the
   underlying session without rebuilding the frontend, so scrollback
   stays intact. Shellmux does the same and adds a `generation` counter
   so a late `closed` event from the previous connection doesn't
   mistakenly mark the just-revived session as dead.

## Not yet applied — ranked by value

### 1. Multiplexing connections across multiple tabs (high value)

`tabby-ssh/src/services/sshMultiplexer.service.ts` groups sessions by the
key `host:port:user:proxy` **plus the key of the entire jump chain**.
Opening 5 tabs to the same VPS then costs only one TCP connection and one
handshake.

Shellmux currently opens one connection per session. The architecture is
already ready for this (one connection carries multiple channels); what's
left is:

- a `DashMap<MultiplexKey, Weak<SshLink>>` pool in `SessionManager`
- reference counting: only call `disconnect()` once the last pane using
  that link closes
- the key must include the jump chain, otherwise two hosts behind
  different bastions would end up wrongly sharing a link

Risk to handle: if one session drops, every session sharing that link
needs to find out.

### 2. Login script / auto-sudo

Tabby's `tabby-auto-sudo-password` and input scripts: wait for a pattern
in the output, then send a reply string. Extremely useful for `sudo` and
login banners. For Shellmux this would be a set of `(regex, response)`
rules running in the pump in `session/shell.rs`.

### 3. Restoring tabs after a restart

`tabby-core/src/services/tabRecovery.service.ts` saves a "recovery token"
for each tab and rebuilds the whole layout when the app opens. Shellmux
currently loses all tabs when the app closes.

### 4. Dedicated keyboard-interactive UI

`tabby-ssh/src/components/keyboardInteractiveAuthPanel.component.ts`
shows the server's actual prompt (including OTP/2FA). Shellmux currently
auto-answers every prompt with the stored password — which is wrong for a
server with 2FA enabled.

### 5. Nested split

Tabby allows splitting panes with arbitrary nesting; Shellmux currently
supports only one level.

### 6. Hotkey system

`tabby-core/src/services/hotkeys.service.ts` — configurable shortcuts for
every action. Shellmux currently only has ⌘F.

### 7. Transports beyond SSH

`tabby-serial` and `tabby-telnet` show how to abstract the transport layer
to add serial/telnet without touching the terminal layer. Worth reviewing
before adding Docker/Kubernetes exec in Phase 3.

## How to look things up again

```bash
npx gitnexus analyze   # if the index reports as stale
```

Then use MCP: `query({query: "...", repo: "tabby"})` to find execution
flows, `context({name: "SymbolName", repo: "tabby"})` to see who calls
what.
