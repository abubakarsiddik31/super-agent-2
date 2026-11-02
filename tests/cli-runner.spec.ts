/** The Claude Code runner: the arguments a turn runs with, and the router's tool check. */
import { expect, it } from 'vitest'
import { ROUTER_TOOLS, routerRefusal, toolsAreOurs, turnArgs } from '../src/runner/cli/turn.ts'

/** The specification one turn runs with. */
const spec = (overrides: Partial<Parameters<typeof turnArgs>[0]> = {}) => ({
  command: 'claude', args: [], cwd: '/tmp', prompt: 'do the work', mcpConfig: '{"mcpServers":{}}',
  noBuiltins: false, strictMcp: false, noCommands: false, timeoutMs: 1000, signal: new AbortController().signal,
  ...overrides,
})

it('runs the CLI headless and reads its events as JSON lines', () => {
  const args = turnArgs(spec())
  expect(args[0]).toBe('-p')
  expect(args[1]).toBe('do the work')
  expect(args).toContain('--output-format')
  expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json')
  expect(args).toContain('--verbose')
})

it('takes the built-in tools away from the router', () => {
  const args = turnArgs(spec({ noBuiltins: true }))
  expect(args[args.indexOf('--tools') + 1]).toBe('')
})

it('ignores the operator\'s own MCP servers for the router', () => {
  // Without this flag the CLI loads the operator's own servers, which may read their mail.
  expect(turnArgs(spec({ strictMcp: true }))).toContain('--strict-mcp-config')
  expect(turnArgs(spec({ strictMcp: false }))).not.toContain('--strict-mcp-config')
})

it('disables the CLI\'s slash commands and skills for the router', () => {
  expect(turnArgs(spec({ noCommands: true }))).toContain('--disable-slash-commands')
})

it('loads the engine\'s MCP server', () => {
  const config = '{"mcpServers":{"superagent":{"type":"http","url":"http://127.0.0.1:1/mcp"}}}'
  const args = turnArgs(spec({ mcpConfig: config }))
  expect(args[args.indexOf('--mcp-config') + 1]).toBe(config)
})

it('names the session of a turn that starts a conversation, and resumes one that continues it', () => {
  const first = turnArgs(spec())
  const id = first[first.indexOf('--session-id') + 1]
  // A session id is a UUID, so the CLI accepts it.
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  const second = turnArgs(spec({ sessionId: id }))
  expect(second[second.indexOf('--resume') + 1]).toBe(id)
  expect(second).not.toContain('--session-id')
})

it('runs the model the agent was given', () => {
  const args = turnArgs(spec({ model: 'opus' }))
  expect(args[args.indexOf('--model') + 1]).toBe('opus')
})

it('accepts a CLI whose tools are all the engine\'s', () => {
  expect(toolsAreOurs(['mcp__superagent__orchestrator_route'], ['orchestrator_route'])).toBe(true)
  expect(toolsAreOurs([], [])).toBe(true)
})

it('refuses a CLI that reported a tool of its own', () => {
  // The router reads text from strangers, so a tool of the CLI's own is a refusal.
  expect(toolsAreOurs(['mcp__superagent__orchestrator_route', 'Bash'], ['orchestrator_route'])).toBe(false)
  expect(toolsAreOurs(['Bash'], ['orchestrator_route'])).toBe(false)
})

it('names the tools that made it refuse', () => {
  expect(routerRefusal(['mcp__superagent__orchestrator_route', 'Bash', 'Read'])).toContain('Bash, Read')
  expect(routerRefusal(['Bash'])).toContain(ROUTER_TOOLS)
})
