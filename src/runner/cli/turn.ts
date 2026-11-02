/**
 * One turn of the Claude Code CLI: the process, its arguments, and the events it prints.
 */
import { randomUUID } from 'node:crypto'
import type { RunnerEvent, Subprocess } from '../port.ts'

/** The prefix the CLI gives a tool of the engine's MCP server. */
export const TOOL_PREFIX = 'mcp__superagent__'

/** The init event of a CLI run, which names the session, the tools and the MCP servers. */
export interface InitEvent {
  type: 'system'
  subtype: 'init'
  session_id?: string
  tools?: string[]
  mcp_servers?: { name: string; status: string }[]
  model?: string
}

/** What one turn needs to run. */
export interface TurnSpec {
  /** The CLI's command. */
  readonly command: string
  /** The arguments before the CLI's own flags. */
  readonly args: readonly string[]
  /** The working directory of the turn. */
  readonly cwd: string
  /** The prompt of the turn, which the CLI takes on the command line. */
  readonly prompt: string
  /** The session to continue, when the conversation goes on. */
  readonly sessionId?: string
  /** The model the CLI runs with. */
  readonly model?: string
  /** The MCP configuration the CLI loads, as a JSON string. */
  readonly mcpConfig: string
  /** Whether the built-in tools are taken away. The router needs that; a worker may keep them. */
  readonly noBuiltins: boolean
  /** Whether the operator's own MCP servers are ignored. The router needs that. */
  readonly strictMcp: boolean
  /** Whether the CLI's slash commands and skills are disabled. The router needs that. */
  readonly noCommands: boolean
  /** How long the turn may run. */
  readonly timeoutMs: number
  /** The signal that stops the turn. */
  readonly signal: AbortSignal
}

/** The refusal a router gets when the CLI reports a tool that is not ours. */
export const ROUTER_TOOLS = 'The CLI reported a tool that is not the engine\'s, so it may not run as the router'

/** The arguments one turn runs the CLI with. */
export function turnArgs(spec: TurnSpec): string[] {
  const args = ['-p', spec.prompt, '--output-format', 'stream-json', '--verbose']
  if (spec.noBuiltins) args.push('--tools', '')
  if (spec.strictMcp) args.push('--strict-mcp-config')
  if (spec.noCommands) args.push('--disable-slash-commands')
  if (spec.mcpConfig) args.push('--mcp-config', spec.mcpConfig)
  if (spec.model) args.push('--model', spec.model)
  // A turn that continues a conversation resumes it; a turn that starts one names the id it will use.
  if (spec.sessionId) args.push('--resume', spec.sessionId)
  else args.push('--session-id', randomUUID())
  return args
}

/** What one turn reported. */
export interface TurnResult {
  /** The CLI's session id, which resumes the conversation. */
  readonly sessionId?: string
  /** The tools the CLI reported it had. */
  readonly tools: readonly string[]
  /** The MCP servers the CLI reported, and their status. */
  readonly servers: readonly { name: string; status: string }[]
  /** The transcript events of the turn. */
  readonly events: readonly RunnerEvent[]
  /** The failure that ended the turn, when one did. */
  readonly error?: string
}

/**
 * The tools the CLI reported, checked against the engine's own.
 *
 * The router reads text from strangers, so it may only have the engine's tools. A CLI that reports anything else is
 * refused rather than trusted: the check is on what the CLI says it has, not on the flags it was given.
 */
export function toolsAreOurs(reported: readonly string[], ours: readonly string[]): boolean {
  const allowed = new Set(ours.map(name => `${TOOL_PREFIX}${name}`))
  return reported.every(name => allowed.has(name))
}

/** The refusal a router gets when the CLI reported a tool that is not ours. */
export function routerRefusal(reported: readonly string[]): string {
  return `${ROUTER_TOOLS}: ${reported.filter(name => !name.startsWith(TOOL_PREFIX)).join(', ')}`
}

/** Runs one turn of the CLI and reads the events it prints. */
export async function runTurn(subprocess: Subprocess, spec: TurnSpec): Promise<TurnResult> {
  const argv = [spec.command, ...spec.args, ...turnArgs(spec)]
  const handle = subprocess.spawn({ argv, cwd: spec.cwd, graceMs: 2000, signal: spec.signal,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 8 << 20 }, stderr: { maxBytes: 1 << 20 } } })
  const timeout = setTimeout(() => { spec.signal.dispatchEvent(new Event('abort')) }, spec.timeoutMs)
  timeout.unref?.()
  let events: RunnerEvent[] = []
  let sessionId: string | undefined
  let tools: string[] = []
  let servers: { name: string; status: string }[] = []
  let failure: string | undefined
  try {
    const { exitCode } = await handle.done
    const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    let seq = 0
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue
      let parsed: unknown
      try { parsed = JSON.parse(line) } catch { continue }
      const event = parsed as { type?: string; subtype?: string; session_id?: string; tools?: string[]; mcp_servers?: { name: string; status: string }[] }
      if (event.type === 'system' && event.subtype === 'init') {
        const init = parsed as InitEvent
        sessionId = init.session_id
        tools = init.tools ?? []
        servers = init.mcp_servers ?? []
        continue
      }
      events.push({ type: event.type ?? 'unknown', seq: seq++, time: Date.now(), data: parsed })
    }
    if (exitCode !== 0) failure = stderr.trim() || `the CLI ended with ${exitCode}`
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  } finally {
    clearTimeout(timeout)
  }
  return { sessionId, tools, servers, events, ...failure ? { error: failure } : {} }
}
