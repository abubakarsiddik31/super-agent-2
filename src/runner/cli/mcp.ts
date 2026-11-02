/**
 * The MCP server that exposes the engine's tools to a coding-agent CLI.
 *
 * The tools live in the engine's process, so the server runs there too, on the loopback interface. The CLI reaches it over
 * HTTP; nothing is reachable from the network, and the token that separates one agent's tools from another's is generated
 * per agent.
 *
 * Claude Code probes a server with `server/discover` before it initializes, which the MCP SDK does not implement. The probe
 * is answered here with the server's identity, and everything else goes to the SDK's transport.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { z } from 'zod'
import type { ToolSpec } from '../port.ts'

/** The name the MCP server registers under; the CLI prefixes its tools with it. */
export const SERVER_NAME = 'superagent'

/** The prefix the CLI gives a tool of an MCP server named `superagent`. */
export const TOOL_PREFIX = `mcp__${SERVER_NAME}__`

/** What the server needs from the agent it serves. */
export interface McpAgent {
  /** The tools the engine bound on the agent. The server offers what is in here at the moment of a request. */
  readonly tools: ReadonlyMap<string, ToolSpec>
}

/** The identity the discover probe is answered with. */
const discover = (id: unknown): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id: id ?? 'server-discover-probe-1',
  result: {
    protocolVersion: '2025-11-25',
    serverInfo: { name: SERVER_NAME, title: 'Super-agent', version: '1.0.0' },
    capabilities: { tools: {} },
  },
})

/** Builds the MCP server for one agent. The agent's tools are read at each request, so a released tool stops answering. */
function build(agent: McpAgent): Server {
  const server = new Server({ name: SERVER_NAME, version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...agent.tools.values()].map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.schema, { io: 'output' }) as { type: 'object' },
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const tool = agent.tools.get(request.params.name)
    // A tool the engine released is unknown to the server, as it is to the CLI.
    if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }] }
    try {
      const args = tool.schema.parse(request.params.arguments ?? {}) as never
      const value = await tool.execute(args, new AbortController().signal)
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      return { content: [{ type: 'text', text: text ?? '' }] }
    } catch (error) {
      // The failure is reported to the model as the tool's result, not as a crash of the server.
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
    }
  })
  return server
}

/** A running MCP server on the loopback interface. */
export interface McpServer {
  /** The address the CLI reaches it at. */
  readonly url: string
  /** The token the CLI sends with every request. */
  readonly token: string
  /** Stops the server and closes its connections. */
  stop(): Promise<void>
}

/**
 * Starts the MCP server for one agent on the loopback interface.
 *
 * The server runs without sessions: every request carries its own handshake, so a CLI that reconnects mid-turn still works.
 * The token is the only thing that separates one agent's tools from another's, so it is generated here and given to the CLI
 * in its configuration.
 */
export async function startMcpServer(agent: McpAgent, token: string, port = 0): Promise<McpServer> {
  const http = createServer((req, res) => { void handle(req, res, agent) })
  await new Promise<void>(resolve => { http.listen(port, '127.0.0.1', resolve) })
  const address = http.address()
  const chosen = typeof address === 'object' && address ? address.port : port
  return {
    url: `http://127.0.0.1:${chosen}/mcp`,
    token,
    stop: async () => { await new Promise<void>(resolve => { http.close(() => { resolve() }); http.closeAllConnections?.() }) },
  }
}

/** Answers one request: the discover probe here, everything else on the MCP transport. */
async function handle(req: IncomingMessage, res: ServerResponse, agent: McpAgent): Promise<void> {
  let body = ''
  for await (const chunk of req) body += chunk
  let parsed: unknown
  try { parsed = body ? JSON.parse(body) : undefined } catch { parsed = undefined }
  const method = (parsed as { method?: unknown } | undefined)?.method
  if (method === 'server/discover') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(discover((parsed as { id?: unknown } | undefined)?.id)))
    return
  }
  // The transport runs without sessions, so every request needs a fresh one; the tools are shared between them.
  // The option must be absent rather than a function returning nothing: the SDK reads its absence to know there are no
  // sessions, and a function would make it demand a session id it never gave out.
  const transport = new StreamableHTTPServerTransport({})
  const server = build(agent)
  await server.connect(transport)
  // The transport reads the parsed body from the request; Node's own request has no such field.
  Object.assign(req, { body: parsed })
  try { await transport.handleRequest(req, res, parsed) }
  catch (error) {
    if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(error) })) }
    else res.end()
  }
  finally { await server.close().catch(() => {}) }
}
