/** The standalone product serves its own panel: one process, one address, no second server and no sign-in prompt. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { startStandalone, type Standalone } from '../src/standalone.ts'

let running: Standalone | undefined
const directories: string[] = []
afterEach(async () => {
  await running?.stop()
  running = undefined
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** Starts the host with a small panel build, so the test does not depend on the real one. */
async function start(): Promise<{ host: Standalone; base: string; port: number }> {
  const root = mkdtempSync(join(tmpdir(), 'superagent-panel-'))
  directories.push(root)
  const panel = join(root, 'panel')
  mkdirSync(join(panel, 'assets'), { recursive: true })
  writeFileSync(join(panel, 'index.html'), '<!doctype html><html><head><title>Superagent</title></head><body><div id="root"></div></body></html>')
  writeFileSync(join(panel, 'assets', 'app.js'), 'console.log(1)')
  writeFileSync(join(root, 'secret.txt'), 'OUTSIDE')
  const host = running = await startStandalone({ stateDir: join(root, 'state'), port: 0, panelDirectory: panel })
  const port = host.host.http.port
  return { host, base: `http://127.0.0.1:${port}`, port }
}

/** A GET with a path sent as it is, which `fetch` would normalize, and a Host header of the caller's choosing. */
function raw(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
      let body = ''
      res.on('data', chunk => { body += String(chunk) })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body, headers: res.headers }) })
    })
    req.on('error', reject)
    req.end()
  })
}

it('serves the panel at the root, with the panel token in the page', async () => {
  const { host, base } = await start()
  const response = await fetch(`${base}/`)
  expect(response.status).toBe(200)
  const page = await response.text()
  expect(page).toContain('<div id="root">')
  expect(page).toContain(`<meta name="superagent-token" content="${host.runtime.panelToken}" />`)
  expect(response.headers.get('cache-control')).toBe('no-store')
})

it('lets the panel call the API with the token from its own page', async () => {
  const { base } = await start()
  const page = await (await fetch(`${base}/`)).text()
  const token = /name="superagent-token" content="([^"]+)"/.exec(page)![1]!
  const response = await fetch(`${base}/orchestrator/api/tickets`, { headers: { 'x-orchestrator-request': '1', authorization: `Bearer ${token}` } })
  expect(response.status).toBe(200)
})

it('serves a route of the panel as the page, and a missing asset as a 404', async () => {
  const { base } = await start()
  expect((await fetch(`${base}/settings`)).status).toBe(200)
  expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404)
})

it('caches an asset by its content hash and never the page', async () => {
  const { base } = await start()
  const asset = await fetch(`${base}/assets/app.js`)
  expect(asset.headers.get('content-type')).toContain('javascript')
  expect(asset.headers.get('cache-control')).toContain('immutable')
  expect(await asset.text()).not.toContain('superagent-token')
})

it('sends a policy that lets only this origin run scripts, and refuses framing', async () => {
  const { base } = await start()
  const response = await fetch(`${base}/`)
  expect(response.headers.get('content-security-policy')).toContain("default-src 'self'")
  expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  expect(response.headers.get('x-frame-options')).toBe('DENY')
})

it('does not give the token to a request for another host name, as with DNS rebinding', async () => {
  const { port } = await start()
  const rebound = await raw(port, '/', { host: `evil.example:${port}` })
  expect(rebound.status).toBe(403)
  expect(rebound.body).not.toContain('superagent-token')
})

it('does not serve a file outside the panel\'s directory', async () => {
  const { port } = await start()
  for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/../../secret.txt']) {
    const response = await raw(port, path)
    expect(response.body).not.toContain('OUTSIDE')
  }
})

it('accepts only reads', async () => {
  const { base } = await start()
  expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405)
})

it('keeps the panel at the same address when the engine restarts', async () => {
  const { host, base, port } = await start()
  await host.restart()
  expect(host.host.http.port).toBe(port)
  expect((await fetch(`${base}/`)).status).toBe(200)
  expect((await fetch(`${base}/orchestrator/api/state`, { headers: { 'x-orchestrator-request': '1' } })).status).toBe(200)
})
