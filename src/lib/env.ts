/**
 * `@tauri-apps/api` calls into `window.__TAURI_INTERNALS__`, which only exists
 * inside a real Tauri webview. Opening the dev server in a regular browser (to
 * quickly preview the UI during development) means the IPC bridge isn't there.
 */
export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * Real vibrancy (NSVisualEffectView) is currently only wired up for macOS — see
 * `src-tauri/src/lib.rs`. Check both conditions: must be running inside Tauri
 * (not a browser preview) and must be macOS, otherwise the transparent HTML
 * background would expose empty space instead of a blurred desktop.
 */
export function hasNativeVibrancy(): boolean {
  return isTauriRuntime() && /Mac/i.test(navigator.platform)
}
