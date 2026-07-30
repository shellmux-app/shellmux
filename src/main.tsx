import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import { hasNativeVibrancy } from './lib/env'
import { useVault } from './state/useVault'
import './styles.css'

// Set before the first CSS recalculation: the background token switches to transparent
// so the real NSVisualEffectView layer (macOS) shows through the WebView. Setting it
// later would flash one opaque background frame before the real glass appears.
if (hasNativeVibrancy()) {
  document.documentElement.dataset.vibrancy = 'native'
}

// Dev only: allows loading sample data from the console to inspect the layout without
// a real vault. The production build does not include any line of this block.
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__vault = useVault
}

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
