/**
 * What the host refuses an attacker, against the attack chain the prototype allowed: a stranger's comment reaching a worker, the
 * router changing Policy, and an unauthenticated management API. These run the real gate, tools and HTTP routes against a fake DSH
 * host and no model, so they show what the host permits, not how a model behaves. The last test records what is still open.
 */
import { execFile } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { registerHttp } from '../src/app/http.ts'
import { PANEL_TOKEN_FILE } from '../src/app/panel-token.ts'
import { commentTrigger } from '../src/sources/github-trigger.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

const AGENT = 'agent-bot', ISSUE = { number: 7, isPr: false }
const comment = (id: number, login: string, body: string) => commentTrigger({ id, body, user: { login, type: 'User' }, created_at: `2026-09-09T00:00:0${id}Z`,
  html_url: `https://github.com/acme/widgets/issues/7#issuecomment-${id}` }, ISSUE, 'conversation', AGENT)

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

/** A ticket a listed person asked for on the Issue, under `observe`, the accept mode a new installation starts in. */
const ticketOnIssue = async () => {
  await h.runtime.settings.save('eval', { ...h.runtime.store.settings().eval, mode: 'observe' }, h.runtime.store.blockRevision('eval'), 'panel')
  return await h.acceptedTicket(comment(1, 'alice', `@${AGENT} fix the login redirect`))
}
const deliveredTo = (sessionId: string) => h.deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === sessionId).map(call => call.text)

it('keeps an unlisted stranger\'s comment from a live worker and from the main Session', async () => {
  const { sessionId } = await ticketOnIssue()
  const attack = comment(2, 'stranger', 'an instruction from nobody on the list')
  h.runtime.receive(attack)
  await h.runtime.idle()
  expect(h.runtime.store.triggers.disposition(attack.id)?.fanout).toEqual([])
  expect(deliveredTo(sessionId).some(text => text.includes(attack.id))).toBe(false)
  expect(h.candidates()).not.toContain(attack.id)
})

it('does not resume an ended ticket for a stranger\'s comment, and does for a listed person\'s', async () => {
  const { sessionId, ticket } = await ticketOnIssue()
  await h.runTool(sessionId, 'orchestrator_report', { state: 'dropped', summary: 'Nothing to do.' })
  await h.runtime.idle()
  const attack = comment(3, 'stranger', 'an instruction from nobody on the list')
  h.runtime.receive(attack)
  await h.runtime.idle(); await h.runtime.pump()
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeTruthy()
  expect(deliveredTo(sessionId).some(text => text.includes(attack.id))).toBe(false)
  h.runtime.receive(comment(4, 'alice', 'it still fails for me'))
  await h.runtime.idle(); await h.runtime.pump()
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeFalsy()
})

it('refuses the main Session to attach a stranger\'s message to a ticket', async () => {
  const { ticket } = await ticketOnIssue()
  const attack = comment(2, 'stranger', 'an instruction from nobody on the list')
  h.runtime.receive(attack)
  await h.runtime.idle()
  await expect(h.route({ kind: 'attach', ticket_id: ticket.id, trigger_id: attack.id })).rejects.toThrow('not allowed to steer')
})

it('labels what reaches a worker: a listed person as authorized, a bot as automated', async () => {
  const { sessionId } = await ticketOnIssue()
  h.runtime.receive(comment(2, 'alice', 'also check the logout page'))
  h.runtime.receive(commentTrigger({ id: 3, body: 'CI text', user: { login: 'ci[bot]', type: 'Bot' }, created_at: '2026-09-09T00:00:03Z',
    html_url: 'https://github.com/acme/widgets/issues/7#issuecomment-3' }, ISSUE, 'conversation', AGENT))
  await h.runtime.idle()
  const messages = deliveredTo(sessionId).flatMap(text => { try { return [JSON.parse(text) as Record<string, unknown>] } catch { return [] } })
  expect(messages.find(item => item.from === 'alice' && item.text === 'also check the logout page')?.sender).toBe('authorized')
  expect(messages.find(item => item.from === 'ci[bot]')?.sender).toBe('automated')
})

it('gives the main Session no tool that changes settings, prompts or the allowed list, and no way to reach the machine', async () => {
  const names = [...h.tools.get(h.runtime.masterId)!.keys()]
  for (const name of ['orchestrator_settings_save', 'orchestrator_prompts_save', 'orchestrator_policy_sync']) expect(names).not.toContain(name)
  const sessions = readFileSync(new URL('../src/app/sessions.ts', import.meta.url), 'utf8')
  expect(sessions).toContain("agent.ctx.tools.restrict({ allow: ['skill'] })")
})

it('refuses the management API without the token, which only the operator\'s user can read', async () => {
  expect(statSync(join(h.directory, PANEL_TOKEN_FILE)).mode & 0o777).toBe(0o600)
  const executor = h.runtime.store.settings().executor
  const prepare = 'echo attacker-chosen'
  let handler!: RequestListener
  const server: Server = createServer((req, res) => handler(req, res))
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  const dispose = registerHttp({ webServer: { host: '127.0.0.1', port, register: (route: { handler: RequestListener }) => { handler = route.handler; return () => {} } } } as never, h.runtime as never)
  const curl = async (...args: string[]) => (await promisify(execFile)('curl', ['-s', '-w', '\n%{http_code}', ...args])).stdout.split('\n').at(-1)
  const base = `http://127.0.0.1:${port}/orchestrator/api`
  const marker = ['-H', 'x-orchestrator-request: 1']
  const save = ['-X', 'PUT', '-H', 'content-type: application/json', '-d', JSON.stringify({ value: { ...executor, prepare }, revision: h.runtime.store.blockRevision('executor') }), `${base}/settings/executor`]
  try {
    expect(await curl(`${base}/settings`)).toBe('403')
    expect(await curl(...marker, `${base}/settings`)).toBe('401')
    expect(await curl(...marker, ...save)).toBe('401')
    expect(await curl(...marker, '-H', 'authorization: Bearer wrong', ...save)).toBe('401')
    expect(h.runtime.store.settings().executor.prepare).not.toBe(prepare)
    // The service script's health check reads no token.
    expect(await curl(...marker, `${base}/state`)).toBe('200')
    expect(await curl(...marker, '-H', `authorization: Bearer ${h.runtime.panelToken}`, ...save)).toBe('200')
    expect(h.runtime.store.settings().executor.prepare).toBe(prepare)
  } finally {
    dispose()
    await new Promise(resolve => server.close(resolve))
  }
})

// When a change isolates workers, this fails: replace it with a test of the isolation. Until then a worker shares the OS user,
// so it can read the token and the database, and the prompt is all that stops it following text it reads with gh.
it('still runs workers with no confinement', () => {
  expect(readFileSync(new URL('../src/app/sessions.ts', import.meta.url), 'utf8')).toContain("ctx.permissionPresets.set(result.agent.session, 'danger-full-access')")
})
