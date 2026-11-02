/** The MCP server that exposes the engine's tools to a coding-agent CLI. */
import { expect, it } from 'vitest'
import { z } from 'zod'
import { startMcpServer, type McpAgent } from '../src/runner/cli/mcp.ts'
import type { ToolSpec } from '../src/runner/port.ts'

/** The tools the server offers, as the engine's binder holds them. */
function agent(): McpAgent & { tools: Map<string, ToolSpec> } {
  const tools = new Map<string, ToolSpec>()
  return { tools }
}

const probe: ToolSpec = { name: 'orchestrator_probe', description: 'A probe tool',
  schema: z.object({ text: z.string() }), execute: (async (args: { text: string }) => ({ echo: args.text })) as never }

/** The headers a request to the server carries. */
const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }

it('serves the tools over the loopback interface and answers a tool call', async () => {
  const cli = agent()
  const server = await startMcpServer(cli, 'test-token')
  try {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    cli.tools.set(probe.name, probe)
    // The MCP handshake: the server identifies itself and lists its tools.
    const init = await fetch(server.url, { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) })
    expect(init.status).toBe(200)
    const listed = await fetch(server.url, { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    expect(listed.status).toBe(200)
    expect(await listed.text()).toContain('orchestrator_probe')
  } finally { await server.stop() }
})

it('answers the discover probe a Claude Code sends before it initializes', async () => {
  const server = await startMcpServer(agent(), 'test-token')
  try {
    const response = await fetch(server.url, { method: 'POST', headers: { ...headers, 'mcp-method': 'server/discover' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'server-discover-probe-1', method: 'server/discover', params: {} }) })
    // The probe is answered, not refused: a refusal makes the CLI report the server as failed.
    expect(response.status).toBe(200)
    const body = await response.json() as { result: { serverInfo: { name: string } } }
    expect(body.result.serverInfo.name).toBe('superagent')
  } finally { await server.stop() }
})

it('calls the tool the engine registered', async () => {
  const cli = agent()
  const server = await startMcpServer(cli, 'test-token')
  try {
    cli.tools.set(probe.name, probe)
    const response = await fetch(server.url, { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'orchestrator_probe', arguments: { text: 'hello' } } }) })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('hello')
  } finally { await server.stop() }
})

it('reports a tool failure to the caller instead of ending the request', async () => {
  const cli = agent()
  const server = await startMcpServer(cli, 'test-token')
  try {
    cli.tools.set('orchestrator_fails', { name: 'orchestrator_fails', description: 'A tool that fails',
      schema: z.object({}), execute: (async () => { throw new Error('the engine refused') }) as never })
    const response = await fetch(server.url, { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'orchestrator_fails', arguments: {} } }) })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('the engine refused')
  } finally { await server.stop() }
})

it('refuses a tool that was released', async () => {
  const cli = agent()
  const server = await startMcpServer(cli, 'test-token')
  try {
    cli.tools.set(probe.name, probe)
    // The engine released the tool, so the CLI cannot call it any more.
    cli.tools.delete(probe.name)
    const response = await fetch(server.url, { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'orchestrator_probe', arguments: { text: 'hello' } } }) })
    expect(await response.text()).toContain('Unknown tool')
  } finally { await server.stop() }
})

it('serves no tool before the engine bound one', async () => {
  const server = await startMcpServer(agent(), 'test-token')
  try {
    const listed = await fetch(server.url, { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' }) })
    expect(await listed.text()).toContain('"tools":[]')
  } finally { await server.stop() }
})
