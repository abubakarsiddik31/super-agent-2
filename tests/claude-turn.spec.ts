/**
 * The Claude Code runner against the real `claude` binary: one turn, and the tool the CLI calls.
 *
 * These tests are skipped where the CLI is not installed, and where it is not signed in.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { ClaudeRunner } from '../src/runner/cli/claude.ts'
import { startMcpServer, type McpAgent } from '../src/runner/cli/mcp.ts'
import { nodeSubprocess } from '../src/host/subprocess.ts'
import type { ToolSpec } from '../src/runner/port.ts'

const run = promisify(execFile)
/** The `claude` binary, when this machine has one. */
const CLAUDE = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/usr/bin/claude'].find(path => existsSync(path))

/** Whether the CLI is signed in, which a turn needs. */
async function signedIn(): Promise<boolean> {
  if (!CLAUDE) return false
  const { stdout } = await run(CLAUDE, ['-p', 'Reply with the word ok.', '--output-format', 'stream-json'], {
    cwd: process.env.TMPDIR ?? '/tmp', timeout: 120_000, encoding: 'utf8',
  }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }))
  return !stdout.includes('authentication_failed')
}

/** The tools the server offers. */
function registry(): McpAgent & { tools: Map<string, ToolSpec> } {
  return { tools: new Map<string, ToolSpec>() }
}

/** The runner over the real CLI, with a server that offers the agent's tools. */
function runner(agent: McpAgent & { tools: Map<string, ToolSpec> }): ClaudeRunner {
  return new ClaudeRunner({ cli: { command: CLAUDE! }, subprocess: nodeSubprocess,
    logger: { warn: () => {}, error: () => {} },
    mcp: async cliAgent => {
      const server = await startMcpServer({ tools: cliAgent.tools }, 'test-token')
      return { url: server.url, token: server.token }
    } })
}

it.skipIf(!CLAUDE)('runs one turn of the CLI and ends it when the process ends', async () => {
  if (!await signedIn()) return
  const cli = runner(registry())
  const agent = await cli.create({ id: 'worker-1', cwd: process.env.TMPDIR ?? '/tmp', role: 'worker' })
  const statuses: string[] = []
  cli.status((_agent, status) => { statuses.push(status) })
  const events: string[] = []
  cli.event((_agent, event) => { events.push(event.type) })
  await cli.deliver(agent as never, { id: 'm1', role: 'user', content: [{ type: 'text', text: 'Reply with the word ok.' }],
    source: { kind: 'dsh-superagent' } } as never, 'queue')
  // The turn ran and ended.
  expect(statuses).toEqual(['running', 'idle'])
  expect(agent.status).toBe('idle')
  // The CLI's own events reached the engine.
  expect(events.length).toBeGreaterThan(0)
  // The session id the CLI reported is kept, so a follow-up turn resumes it.
  expect((agent as unknown as { sessionId?: string }).sessionId).toBeTruthy()
}, 180_000)

it.skipIf(!CLAUDE)('refuses a router whose CLI reported a tool of its own', async () => {
  if (!await signedIn()) return
  const cli = runner(registry())
  const agent = await cli.create({ id: 'router-1', cwd: process.env.TMPDIR ?? '/tmp', role: 'orchestrator' })
  const errors: unknown[] = []
  cli.error((_agent, error) => { errors.push(error) })
  // The engine bound a tool on the router.
  cli.binder(agent).registerTool({ name: 'orchestrator_route', description: 'A tool', schema: z.object({}), execute: (async () => ({})) as never })
  await cli.deliver(agent as never, { id: 'm1', role: 'user', content: [{ type: 'text', text: 'Reply with the word ok.' }],
    source: { kind: 'dsh-superagent' } } as never, 'queue')
  // The router runs with no built-in tools, so the CLI reports only ours and the turn is not refused.
  expect(errors).toEqual([])
}, 180_000)
