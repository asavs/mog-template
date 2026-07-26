import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

const rootEl = document.getElementById('root')!

createRoot(rootEl).render(
  <StrictMode>
    <p>v2 shell under construction — see /sandbox.html and /drill.html</p>
  </StrictMode>,
)
