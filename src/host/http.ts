/**
 * The management HTTP server over Node's own `http` module, for a host that runs without the DeepSeek Harness.
 *
 * The server binds to the loopback address only. It serves every path under a mounted prefix and hands each request to the
 * mount's handler; the handler decides what a request may do, including the same-origin and token checks of `src/app/http.ts`.
 */
import { createServer, type Server } from 'node:http'
import type { HostPort, HttpHandler } from '../runner/port.ts'

export interface NodeHttp {
  readonly host: string
  readonly port: number
  mount(prefix: string, handler: HttpHandler): () => void
  /** Serves every request no prefix claimed, such as the panel's own pages; returns the release. */
  fallback(handler: HttpHandler): () => void
  /** Closes the server and waits for the open connections to end. */
  close(): Promise<void>
}

/** A mounted prefix and the handler that serves it. */
interface Mount { prefix: string; handler: HttpHandler }

export interface NodeHttpOptions {
  readonly host?: string
  readonly port?: number
}

/**
 * Starts the management server on the loopback interface.
 *
 * The port is `0` by default, which asks the operating system for a free one; the chosen port is readable from `port` once
 * the server listens.
 */
export async function startNodeHttp(options: NodeHttpOptions = {}): Promise<NodeHttp> {
  const host = options.host ?? '127.0.0.1'
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error('The management server serves the loopback interface only')
  }
  const mounts: Mount[] = []
  let rest: HttpHandler | undefined
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    // The longest matching prefix wins, so a mount under another mount's path is reached.
    const mount = [...mounts].sort((a, b) => b.prefix.length - a.prefix.length)
      .find(candidate => url.pathname === candidate.prefix || url.pathname.startsWith(`${candidate.prefix}/`))
    const handler = mount?.handler ?? rest
    if (!handler) { res.writeHead(404); res.end(); return }
    // The handler owns the request; a failure inside it is its own to report.
    void Promise.resolve(handler(req, res)).catch(() => { if (!res.headersSent) res.writeHead(500); res.end() })
  })
  const listening = new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => { server.removeListener('error', reject); resolve() })
  })
  await listening
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    host,
    port,
    mount(prefix, handler) {
      mounts.push({ prefix, handler })
      return () => { const index = mounts.indexOf(mounts.find(mount => mount.handler === handler && mount.prefix === prefix)!)
        if (index >= 0) mounts.splice(index, 1) }
    },
    fallback(handler) {
      rest = handler
      return () => { if (rest === handler) rest = undefined }
    },
    async close() {
      await new Promise<void>(resolve => { server.close(() => { resolve() }); server.closeAllConnections?.() })
    },
  }
}
