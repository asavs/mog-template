import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { buildInfo } from './buildInfo'
import { initHeightmap } from './heightmap'
import { initCastleCollision } from './castleCollision'

window.__buildInfo = buildInfo

const rootEl = document.getElementById('root')!

async function boot() {
  try {
    await Promise.all([initHeightmap(), initCastleCollision()])
  } catch (error) {
    console.error('Failed to load terrain collision data', error)
    rootEl.textContent = 'Failed to load terrain collision data. Refresh or check that collision assets are deployed.'
    return
  }
  try {
    const { initRapierCastleController } = await import('./rapierCastleController')
    await initRapierCastleController()
  } catch (error) {
    console.warn('Rapier castle controller unavailable; using current castle collision path.', error)
  }

  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void boot()
