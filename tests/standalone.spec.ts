/** The standalone host: the engine, the management server and the Sources in one plain Node process. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { startStandalone, type Standalone } from '../src/standalone.ts'
import { startNodeHttp } from '../src/host/http.ts'
import { nodeSubprocess, scrubbedEnv } from '../src/host/subprocess.ts'
import { EmptyRunner, NO_AGENT_CLI } from '../src/host/runner.ts'

let running: Standalone | undefined
afterEach(async () => { await running?.stop(); running = undefined })

/** Starts the standalone host in a throwaway state directory. */
async function start(stateDir: string): Promise<Standalone> {
  running = await startStandalone({ stateDir, port: 0 })
  return running
}

it('boots without the DeepSeek Harness and serves the management API on the loopback interface', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-standalone-'))
  const host = await start(directory)
  // The management API answers on the loopback interface the host chose.
  expect(host.host.http.host).toBe('127.0.0.1')
  expect(host.host.http.port).toBeGreaterThan(0)
  const response = await fetch(`http://127.0.0.1:${host.host.http.port}/orchestrator/api/state`, {
    headers: { 'x-orchestrator-request': '1' },
  })
  // The state route stays open for the health check of the service script, which cannot know the panel token.
  expect(response.status).toBe(200)
  const body = await response.json() as { setup: { machine: { stateDir: string } } }
  expect(body.setup.machine.stateDir).toBe(directory)
  rmSync(directory, { recursive: true, force: true })
})

it('refuses a management request without the panel token', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-standalone-'))
  const host = await start(directory)
  const response = await fetch(`http://127.0.0.1:${host.host.http.port}/orchestrator/api/tickets`, {
    headers: { 'x-orchestrator-request': '1' },
  })
  expect(response.status).toBe(401)
  rmSync(directory, { recursive: true, force: true })
})

it('serves a management request that carries the panel token', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-standalone-'))
  const host = await start(directory)
  const response = await fetch(`http://127.0.0.1:${host.host.http.port}/orchestrator/api/tickets`, {
    headers: { 'x-orchestrator-request': '1', authorization: `Bearer ${host.runtime.panelToken}` },
  })
  expect(response.status).toBe(200)
  rmSync(directory, { recursive: true, force: true })
})

it('refuses a management request from a foreign origin', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-standalone-'))
  const host = await start(directory)
  const response = await fetch(`http://127.0.0.1:${host.host.http.port}/orchestrator/api/state`, {
    headers: { 'x-orchestrator-request': '1', origin: 'http://evil.example' },
  })
  expect(response.status).toBe(403)
  rmSync(directory, { recursive: true, force: true })
})

it('serves the management server on the loopback interface only', async () => {
  await expect(startNodeHttp({ host: '0.0.0.0', port: 0 })).rejects.toThrow(/loopback/)
})

it('starts a child without the credential-shaped names of the parent environment', async () => {
  const name = 'SUPERAGENT_TEST_SECRET'
  process.env[name] = 'secret-value'
  try {
    const handle = nodeSubprocess.spawn({ argv: ['env'], cwd: tmpdir(), graceMs: 1000,
      signal: new AbortController().signal, stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 16 }, stderr: { maxBytes: 1 << 16 } } })
    await handle.done
    const output = handle.collected.stdout!.readFrom(0).text
    // A credential-shaped name never reaches the child.
    expect(output).not.toContain(name)
    expect(output).not.toContain('secret-value')
  } finally { delete process.env[name] }
})

it('keeps a deliberate environment entry that the scrub would drop', async () => {
  const name = 'SUPERAGENT_TEST_KEY'
  const handle = nodeSubprocess.spawn({ argv: ['env'], cwd: tmpdir(), graceMs: 1000,
    signal: new AbortController().signal, env: { [name]: 'kept' },
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 16 }, stderr: { maxBytes: 1 << 16 } } })
  await handle.done
  expect(handle.collected.stdout!.readFrom(0).text).toContain(`${name}=kept`)
})

it('drops a credential-shaped name from the scrubbed environment of a child', () => {
  process.env.SUPERAGENT_TEST_TOKEN = 'value'
  try { expect(scrubbedEnv()).not.toHaveProperty('SUPERAGENT_TEST_TOKEN') }
  finally { delete process.env.SUPERAGENT_TEST_TOKEN }
})

it('reports that no agent CLI is configured when a ticket needs an agent', async () => {
  const runner = new EmptyRunner()
  await expect(runner.create()).rejects.toThrow(NO_AGENT_CLI)
  expect(runner.get('worker-1')).toBeUndefined()
})
