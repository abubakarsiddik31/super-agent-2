/**
 * The standalone entry point: the engine, the management server and the Sources in one plain Node process.
 *
 * This is the host that replaces the DeepSeek Harness. It needs no DeepSeek software: the management API is served by the
 * process itself, the Sources poll on their own, and the state lives in the state directory.
 *
 * The agent side is a coding-agent CLI behind a runner of its own. When no CLI is configured, the host runs the panel and
 * the Sources, and a ticket that needs an agent fails with a message that says so.
 */
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Runtime } from './app/runtime.ts'
import { machineOf, type DeploymentConfig, type Machine } from './deployment.ts'
import { nodeModels } from './host/models.ts'
import { startNodeHost, type NodeHost } from './host/node.ts'
import { EmptyRunner } from './host/runner.ts'
import { nodeSubprocess } from './host/subprocess.ts'
import { ClaudeRunner, type CliConfig } from './runner/cli/claude.ts'
import { startMcpServer } from './runner/cli/mcp.ts'
import { definePorts, type AgentPorts, type TranscriptStore } from './runner/port.ts'
import { startFeishu } from './sources/feishu.ts'
import { startGithub } from './sources/github.ts'
import type { SourceHost } from './sources/host.ts'

export interface StandaloneOptions {
  /** The directory for the database, the locks, the worker shims and the panel token. */
  readonly stateDir?: string
  /** The port the management API listens on; `0` asks the operating system for a free one. */
  readonly port?: number
  /** The coding-agent CLI the agent side runs; without one, no agent can run. */
  readonly cli?: CliConfig
}

/** The default state directory: the same one the harness plugin used. */
export const defaultStateDir = (): string => join(homedir(), '.dsh', 'state', 'superagent')

/** The machine settings of the standalone host; the limits change in place without a restart. */
export const standaloneMachine = (stateDir: string): Machine => ({
  stateDir,
  promptMaxChars: { get: () => 100_000 },
  admissionContextMaxPages: { get: () => 10 },
  admissionContextTimeoutMs: { get: () => 15_000 },
})

/**
 * The agent-side ports of the standalone host.
 *
 * With a CLI configured, the runner is the one over that CLI, and every agent reaches the engine's tools through an MCP
 * server the engine serves. Without one, the runner has no agent to create and every ticket that needs one fails visibly.
 */
export function standalonePorts(cli?: CliConfig): AgentPorts {
  const transcripts: TranscriptStore = {
    flush: async () => { /* The CLI's own session files hold the transcript. */ },
    readUserMessages: async () => [],
    events: async () => [],
  }
  const logger = { info: (format: string, ...args: unknown[]) => { console.log(format, ...args) },
    warn: (format: string, ...args: unknown[]) => { console.warn(format, ...args) },
    error: (format: string, ...args: unknown[]) => { console.error(format, ...args) } }
  if (!cli) return definePorts({ runner: new EmptyRunner(), transcripts, models: nodeModels(), subprocess: nodeSubprocess, logger })
  const runner = new ClaudeRunner({ cli, subprocess: nodeSubprocess, logger,
    // The CLI reaches the engine's tools through an MCP server the engine serves, one per agent. The server offers the
    // tools the engine bound on that agent, and a tool the engine released stops answering.
    mcp: async agent => {
      const server = await startMcpServer(agent, randomUUID())
      return { url: server.url, token: server.token }
    } })
  return definePorts({ runner, transcripts, models: nodeModels(), subprocess: nodeSubprocess, logger })
}

/** A running standalone host. */
export interface Standalone {
  readonly runtime: Runtime
  readonly host: NodeHost
  /** Rebuilds the engine, as after an account change; the Sources are stopped and started again. */
  restart(): Promise<void>
  /** Stops the Sources, the engine and the management server. */
  stop(): Promise<void>
}

/**
 * Starts the standalone host: the engine, the management server and the Sources.
 *
 * The Sources start only after the engine is ready, so they do not poll before setup resolved the accounts.
 */
export async function startStandalone(options: StandaloneOptions = {}): Promise<Standalone> {
  const stateDir = options.stateDir ?? defaultStateDir()
  const machine = standaloneMachine(stateDir)
  let host: NodeHost | undefined
  let runtime: Runtime | undefined
  let sources: (() => Promise<void>)[] = []
  // The restart rebuilds the engine in place, so an account change re-runs setup without the process restarting.
  const restart = (): void => { void build() }
  const build = async (): Promise<void> => {
    await runtime?.stop()
    for (const stop of sources) await stop()
    sources = []
    host = await startNodeHost({ stateDir, limits: machine, ...options.port === undefined ? {} : { port: options.port }, restart })
    runtime = new Runtime(host, standalonePorts(options.cli), machine, restart)
    // The Sources reach the engine through the `SourceHost` interface, which the runtime implements.
    const sourceHost = runtime as unknown as SourceHost
    await runtime.ready
    sources = [startGithub(sourceHost), startFeishu(sourceHost)]
  }
  await build()
  return {
    // The runtime is rebuilt on a restart, so the caller reads the one that is running now.
    get runtime() { return runtime! },
    get host() { return host! },
    restart: build,
    stop: async () => {
      for (const stop of sources.reverse()) await stop()
      await runtime?.stop()
      await host?.stop()
    },
  }
}

export type { DeploymentConfig }
export { machineOf }
