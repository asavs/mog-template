import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function readGitCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'unknown'
  }
}

// https://vite.dev/config/
export default defineConfig(({ command }) => {
  const commit = `${readGitCommit()}${command === 'serve' ? '-dev' : ''}`

  return {
    plugins: [react()],
    define: {
      __BUILD_COMMIT__: JSON.stringify(commit),
    },
    server: {
      proxy: {
        '/v1': {
          target: 'http://127.0.0.1:3000',
          ws: true,
        },
      },
    },
  }
})
