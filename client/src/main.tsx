import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { buildInfo } from './buildInfo'
import { initHeightmap } from './heightmap'

window.__buildInfo = buildInfo

const rootEl = document.getElementById('root')!

async function boot() {
  try {
    await initHeightmap()
  } catch (error) {
    console.error('Failed to load terrain heightmap', error)
    rootEl.textContent = 'Failed to load terrain data. Refresh or check that heightmap.bin is deployed.'
    return
  }

  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void boot()
