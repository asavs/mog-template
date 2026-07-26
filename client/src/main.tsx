import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './game/App'
import './index.css'

const rootEl = document.getElementById('root')!

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
