/** Vite config for the standalone panel: serves `desktop/ui`, and in development forwards the management API to a running service. */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const target = process.env.SUPERAGENT_API ?? 'http://127.0.0.1:3082'
const tokenFile = process.env.SUPERAGENT_TOKEN_FILE ?? [join(homedir(), '.superagent', 'panel-token'), join(homedir(), '.dsh', 'state', 'superagent', 'panel-token')]
  .find(file => existsSync(file)) ?? join(homedir(), '.superagent', 'panel-token')
const panelToken = (): string | undefined => { try { return readFileSync(tokenFile, 'utf8').trim() || undefined } catch { return undefined } }

export default defineConfig({
  // Anchored to this file: Vite would otherwise resolve `ui` from the working directory.
  root: fileURLToPath(new URL('./ui', import.meta.url)),
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5273,
    strictPort: true,
    // The panel imports its pages from `src/client`, one level above this folder.
    fs: { allow: ['..', '../..'] },
    proxy: {
      // The API accepts only its own Host and no foreign Origin, and wants the panel token; the dev proxy supplies all three so the browser never holds the token.
      '/orchestrator': { target, changeOrigin: true, configure: proxy => {
        proxy.on('proxyReq', request => {
          request.removeHeader('origin')
          const token = panelToken()
          if (token) request.setHeader('authorization', `Bearer ${token}`)
        })
      } },
    },
  },
})
