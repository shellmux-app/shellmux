# Design Language

Reference: **TablePlus** for the visual language (glass material, text
badges, rounded rows, system accent) and **Termius** for the information
architecture (left nav rail, Groups + Hosts as a card grid, search box with
a Connect button).

This is app chrome for a professional tool, not a landing page. Density
stays at pro-tool level, motion is nearly nonexistent: the terminal is
already painting at 60fps, and every extra animation eats into its frame
budget.

## Structure

```
┌──────────────┬─────────────────────────────────────────────┐
│ nav rail     │ tabstrip: [Manage] [session] [session] …    │
│              ├─────────────────────────────────────────────┤
│ Hosts        │                                             │
│ Keychain     │  Manage screen:  Groups (card)              │
│ Snippets     │                  Hosts  (card)              │
│ Known hosts  │                                             │
│              │  or session screen: panes + terminal / SFTP │
│ Import       │                                             │
│ Theme        │                                             │
└──────────────┴─────────────────────────────────────────────┘
```

The nav rail is a **destination**, not a button that opens a dialog.
Keychain, Snippets, and Known hosts are all their own screens. Only Port
forwarding remains a modal, because it's tied to an open session and
doesn't exist independently.

## Tokens

All defined in [`src/styles/tokens.css`](../src/styles/tokens.css). Three
things are locked down so the UI doesn't drift:

- **A single accent.** Teal for primary actions, system blue for
  selection. No section changes the accent on its own.
- **Three radius tiers, with a rule.** `7px` for controls, `12px` for
  panels/cards, `16px` for dialogs.
- **One theme for the whole page.** Light, dark, or follow the OS
  (default). No region flips its colors independently of the rest of the
  page.

## On "liquid glass"

To be clear: **Apple only defines Liquid Glass for Apple platforms — there
is no official CSS package for it.** Shellmux has two layers:

1. **Real vibrancy on macOS** — `NSVisualEffectView` (material `Sidebar`,
   like Finder/TablePlus) plugged in via the `window-vibrancy` crate
   ([src-tauri/src/lib.rs](../src-tauri/src/lib.rs), function
   `apply_window_vibrancy`). This is what **blurs the actual desktop
   behind the window** — something `backdrop-filter` cannot do, since it
   only blurs content that lives inside the webview.
2. **CSS approximation** (gradient wash + `backdrop-filter`) for every
   case where the layer above isn't available: browser preview during
   dev, and temporarily for Windows/Linux (`apply_acrylic`/`apply_mica`
   not yet implemented).

The three pieces have to line up; missing any one breaks the effect:

| Piece | Where | Why it's needed |
| --- | --- | --- |
| `"transparent": true` | `tauri.conf.json` | Without it, the window's border/corners stay opaque even once the inside is transparent |
| `html, body { background: transparent }` | `--canvas` token when `[data-vibrancy='native']` | The WebView paints an opaque white background by default, hiding the `NSVisualEffectView` sitting beneath it even though the window itself is transparent |
| `apply_vibrancy(...)` | `lib.rs` setup | Inserts the actual blur view into the window |

**Detected at runtime, not hard-coded:** `src/lib/env.ts` has
`hasNativeVibrancy()` — true only when running inside a real Tauri app (not
a browser tab) **and** on macOS. `main.tsx` calls it before the first
render to set `data-vibrancy="native"` on `<html>`; the CSS tokens read
that attribute to decide between real transparency and the gradient
approximation. That way `pnpm dev` opened in a regular browser (the fast
way to inspect the UI during development) still shows the same gradient
approximation as before, instead of breaking into an empty background.

**The window theme has to stay in sync with the app's theme.**
`NSVisualEffectView` reads the app's appearance to pick a light/dark tone;
if the app is set to "light" but the window still holds a dark appearance,
the glass layer tints the wrong color — opaque instead of clear.
`useTheme.setMode` calls the `set_window_theme` command on every change to
keep both sides in sync.

**Windows/Linux don't have real vibrancy yet.** `window-vibrancy` also
supports acrylic (Windows), but that hasn't been built/verified on the
current machine, so it isn't wired in yet — Cargo.toml only pulls in this
crate for `target_os = "macos"`. On the Phase 2 roadmap, alongside the
Windows/Linux CI builds.

When a user turns on *Reduce transparency* in Accessibility, the tokens
automatically switch to an opaque background with no blur — this applies
to both layers.

## Conventions that must not be violated

- **No emoji as icons.** Emoji render differently across OSes and their
  strokes can't be controlled. Use text labels instead, or 2-character
  badges the way TablePlus does for connection types (`Re`, `Pg`). Badge
  color is derived from the id, so each host keeps exactly one color.
- **No hand-drawn SVG icons.** If real icons are needed later, install a
  library (Phosphor, Tabler) — don't hand-draw paths.
- **No `window.prompt` / `window.confirm`.** OS dialogs block the whole
  process and can't be styled. Use `useDialog().ask()` / `.confirm()` —
  it still returns a Promise so call sites barely change, and you get
  Esc, Enter, and autofocus for free.
- **No em dash in displayed strings.** Use a regular hyphen, a comma, or
  split the sentence instead.
- **Every state must be handled.** Empty, loading (a skeleton matching the
  shape of the real content, not a spinner), error. Don't design only the
  success state.
- **Focus must be visible.** `:focus-visible` has a ring on every control.

## Previewing the layout with an empty vault

In dev mode, the store is exposed on the console so you can inspect the
card grid without needing any real hosts:

```js
__vault.setState({ ready: true, groups: [...], hosts: [...] })
```

This block sits behind `import.meta.env.DEV`, so it isn't included in the
production build.
