/**
 * The standalone entry point: the engine, the management server and the Sources in one plain Node process.
 *
 * This is the host that replaces the DeepSeek Harness. It needs no DeepSeek software: the management API is served by the
 * process itself, the Sources poll on their own, and the state lives in the state directory.
 *
 * The agent side is a separate piece: a coding-agent CLI behind a runner of its own, which this host has not yet; see
 * `docs/spikes/001-cli-runners.md`. Until then the host runs the panel and the Sources, and a ticket that needs an agent
 * fails with a message that says so.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Runtime } from './app/runtime.ts'
import { machineOf, type DeploymentConfig, type Machine } from './deployment.ts'
import { nodeModels } from './host/models.ts'
import { startNodeHost, type NodeHost } from './host/node.ts'
import { EmptyRunner } from './host/runner.ts'
import { nodeSubprocess } from './host/subprocess.ts'
import { definePorts, type AgentPorts, type TranscriptStore } from './runner/port.ts'
import { startFeishu } from './sources/feishu.ts'
import { startGithub } from './sources/github.ts'
import type { SourceHost } from './sources/host.ts'

export interface StandaloneOptions {
  /** The directory for the database, the locks, the worker shims and the panel token. */
  readonly stateDir?: string
  /** The port the management API listens on; `0` asks the operating system for a free one. */
  readonly port?: number
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

/** The agent-side ports of the standalone host: no agent CLI behind them yet. */
export function standalonePorts(): AgentPorts {
  const transcripts: TranscriptStore = {
    flush: async () => { /* No transcripts are kept while no agent runs. */ },
    readUserMessages: async () => [],
    events: async () => [],
  }
  return definePorts({ runner: new EmptyRunner(), transcripts, models: nodeModels(), subprocess: nodeSubprocess,
    logger: { info: (format, ...args) => { console.log(format, ...args) }, warn: (format, ...args) => { console.warn(format, ...args) },
      error: (format, ...args) => { console.error(format, ...args) } } })
}

/** A running standalone host. */
export interface Standalone {
  readonly runtime: Runtime
  readonly host: NodeHost
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
  // The restart rebuilds the engine in place, so an account change re-runs setup without the process restarting.
  const restart = (): void => { void restartEngine() }
  let runtime: Runtime | undefined
  let sources: (() => Promise<void>)[] = []
  const build = async (): Promise<void> => {
    await runtime?.stop()
    for (const stop of sources) await stop()
    sources = []
    host = await startNodeHost({ stateDir, limits: machine, ...options.port === undefined ? {} : { port: options.port }, restart })
    runtime = new Runtime(host, standalonePorts(), machine, restart)
    // The Sources reach the engine through the `SourceHost` interface, which the runtime implements.
    const sourceHost = runtime as unknown as SourceHost
    await runtime.ready
    sources = [startGithub(sourceHost), startFeishu(sourceHost)]
  }
  const restartEngine = async (): Promise<void> => { await build() }
  await build()
  const running = runtime!
  const runningHost = host!
  return {
    runtime: running,
    host: runningHost,
    stop: async () => {
      for (const stop of sources.reverse()) await stop()
      await running.stop()
      await runningHost.stop()
    },
  }
}

export type { DeploymentConfig }
export { machineOf }
