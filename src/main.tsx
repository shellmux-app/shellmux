import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import { useVault } from './state/useVault'
import './styles.css'

// Chỉ ở dev: cho phép nạp dữ liệu mẫu từ console để soi layout mà không cần
// vault thật. Bản build production không có dòng nào của khối này.
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__vault = useVault
}

const container = document.getElementById('root')
if (!container) throw new Error('không tìm thấy #root')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
