/**
 * The Claude Code CLI against the MCP server the engine serves.
 *
 * These tests run the real `claude` binary, so they are skipped where it is not installed. They check what the runner
 * depends on: that the CLI connects to the engine's MCP server, and that the init event reports the MCP tools and nothing
 * else.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { startMcpServer, type McpAgent } from '../src/runner/cli/mcp.ts'
import type { ToolSpec } from '../src/runner/port.ts'

/** Runs a command and collects its output, whether it succeeded or not. */
const run = promisify(execFile)
/** The `claude` binary, when this machine has one. */
const CLAUDE = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/usr/bin/claude'].find(path => existsSync(path))
/** The init event of a Claude Code run, which names the session, the tools and the MCP servers. */
interface InitEvent { type: string; subtype?: string; session_id?: string; tools?: string[]; mcp_servers?: { name: string; status: string }[] }

/** Runs `claude` headless with the given MCP configuration and returns the events it printed. */
async function claudeEvents(config: string, prompt = 'Reply with the word ok.'): Promise<InitEvent[]> {
  const { stdout } = await run(CLAUDE!, ['-p', prompt, '--output-format', 'stream-json', '--verbose',
    '--tools', '', '--strict-mcp-config', '--mcp-config', config, '--bare', '--disable-slash-commands'], {
    cwd: process.env.TMPDIR ?? '/tmp', timeout: 120_000, maxBuffer: 8 << 20, encoding: 'utf8',
  }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }))
  return stdout.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as InitEvent] } catch { return [] } })
}

/** The MCP configuration of the engine's server, as the CLI reads it. */
const configOf = (url: string): string => JSON.stringify({ mcpServers: { superagent: { type: 'http', url } } })

const probe = { name: 'orchestrator_probe', description: 'A probe tool',
  schema: z.object({ text: z.string() }), execute: async (args: { text: string }) => ({ echo: args.text }) }

/** The tools the server offers, as the engine's binder holds them. */
function registry(): McpAgent & { tools: Map<string, ToolSpec> } {
  return { tools: new Map<string, ToolSpec>() }
}

it.skipIf(!CLAUDE)('the CLI connects to the engine\'s MCP server and sees only its tools', async () => {
  const agent = registry()
  const server = await startMcpServer(agent, 'test-token')
  try {
    agent.tools.set(probe.name, probe)
    const events = await claudeEvents(configOf(server.url))
    const init = events.find(event => event.type === 'system' && event.subtype === 'init')
    expect(init).toBeDefined()
    // The CLI reports the MCP server as connected.
    expect(init!.mcp_servers).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'superagent', status: 'connected' })]))
    // The only tool the CLI has is ours: the router reads strangers' text and must have no shell or file access.
    expect(init!.tools).toEqual(['mcp__superagent__orchestrator_probe'])
  } finally { await server.stop() }
}, 120_000)

it.skipIf(!CLAUDE)('the CLI keeps its built-in tools when the runner does not take them away', async () => {
  const agent = registry()
  const server = await startMcpServer(agent, 'test-token')
  try {
    agent.tools.set(probe.name, probe)
    // Without `--tools ""` the CLI keeps its own tools, which is what the router's check must catch.
    const { stdout } = await run(CLAUDE!, ['-p', 'Reply with the word ok.', '--output-format', 'stream-json', '--verbose',
      '--strict-mcp-config', '--mcp-config', configOf(server.url), '--disable-slash-commands'], {
      cwd: process.env.TMPDIR ?? '/tmp', timeout: 120_000, maxBuffer: 8 << 20, encoding: 'utf8',
    }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }))
    const init = stdout.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as InitEvent] } catch { return [] } })
      .find(event => event.type === 'system' && event.subtype === 'init')
    expect(init).toBeDefined()
    // The check has something to catch: the CLI has tools of its own next to ours.
    expect(init!.tools!.length).toBeGreaterThan(1)
    expect(init!.tools).toContain('mcp__superagent__orchestrator_probe')
    expect(init!.tools!.some(name => !name.startsWith('mcp__superagent__'))).toBe(true)
  } finally { await server.stop() }
}, 120_000)
