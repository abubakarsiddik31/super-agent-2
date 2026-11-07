/**
 * `HostPort` over plain Node, for a host that runs without the DeepSeek Harness.
 *
 * The harness's own host provides a logger, a Web server and a way to restart the plugin. This host provides the same through
 * the process and an HTTP server: the logger writes to the console, and `restart` asks the entry point to build a new runtime.
 */
import type { HttpHandler, Logger } from '../runner/port.ts'
import { startNodeHttp, type NodeHttp } from './http.ts'

/** The console logger the harness logger's format is compatible with. */
export const consoleLogger: Logger = {
  info: (format, ...args) => { console.log(format, ...args) },
  warn: (format, ...args) => { console.warn(format, ...args) },
  error: (format, ...args) => { console.error(format, ...args) },
}

export interface NodeHostOptions {
  readonly stateDir: string
  readonly limits: { readonly promptMaxChars: { get(): number }
    readonly admissionContextMaxPages: { get(): number }
    readonly admissionContextTimeoutMs: { get(): number } }
  /** The port the management server listens on; `0` asks for a free one. */
  readonly port?: number
  /** Called when the host is asked to rebuild the engine, as after an account change. */
  readonly restart?: () => void
}

/** A host that runs the engine in this process, with a management server on the loopback interface. */
export interface NodeHost {
  readonly logger: Logger
  readonly stateDir: string
  readonly limits: NodeHostOptions['limits']
  readonly http: { readonly host: string; readonly port: number; mount(prefix: string, handler: (req: never, res: never) => void): () => void
    fallback(handler: HttpHandler): () => void }
  restart(): void
  /** Closes the management server. */
  stop(): Promise<void>
}

/** Builds the host and starts its management server. */
export async function startNodeHost(options: NodeHostOptions): Promise<NodeHost> {
  const server: NodeHttp = await startNodeHttp({ port: options.port })
  let stopping: Promise<void> | undefined
  return {
    logger: consoleLogger,
    stateDir: options.stateDir,
    limits: options.limits,
    http: {
      get host() { return server.host },
      get port() { return server.port },
      mount: (prefix, handler) => server.mount(prefix, handler as never),
      fallback: handler => server.fallback(handler),
    },
    restart() { options.restart?.() },
    stop() { return stopping ??= server.close() },
  }
}
