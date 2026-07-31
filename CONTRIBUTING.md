# Contributing to Shellmux

Thanks for considering it. A few things worth knowing before you send a PR.

## License

Shellmux is licensed under the [Functional Source License 1.1, Apache 2.0
Future License](LICENSE) (FSL-1.1-ALv2) — source-available, not OSI-approved
open source. Read the LICENSE file; the short version is in
[README.md](README.md#license).

**By submitting a contribution, you agree it's licensed under the same
terms as the rest of the project (FSL-1.1-ALv2), and that you have the
right to make that grant.** There's no separate CLA to sign — the act of
opening a PR against this license is the agreement, the same way it is for
any other license. If your employer owns your code, get their sign-off
before you send the PR, not after.

If that trade-off doesn't work for you, it's a valid reason not to
contribute, and we'd rather you know that up front than find out later.

## What this project holds itself to

- **All source stays public, always.** No feature is ever developed in a
  private fork or a paid-only repo — see the *Business model* section of
  [STATUS.md](STATUS.md) for why. If a PR would only make sense as a
  closed add-on, it's probably out of scope here.
- **No feature gating.** The free-to-self-build and paid-signed-binary
  builds are the exact same program. A PR that makes behavior differ by
  license key or build flag will be asked to change.
- **No telemetry, no mandatory account.** See `docs/ROADMAP.md`'s "Not
  doing" section.

## Before you open a PR

- Run the checks the CI will run:
  ```bash
  pnpm typecheck && pnpm test
  cargo build --manifest-path src-tauri/Cargo.toml
  cargo test --manifest-path src-tauri/Cargo.toml
  ```
- Security-sensitive code (auth, the vault, anything touching secrets or
  host-key verification) gets read more carefully and may take longer to
  review — that's not a reflection on the PR, it's the nature of an SSH
  client.
- Keep PRs scoped to one change. Large drive-by refactors alongside a
  feature make both harder to review.

## Reporting a security issue

Don't open a public issue for it. See [docs/SECURITY.md](docs/SECURITY.md)
for how to report privately.
