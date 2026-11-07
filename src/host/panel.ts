/**
 * The panel's own pages, served by the standalone host.
 *
 * The standalone product is one process: the host serves the built panel (`desktop/dist`) next to the management API, so
 * the operator opens one address and needs no second server. The panel talks to the API on the same origin.
 *
 * The page carries the panel token in a `<meta>` tag, so the browser holds it without asking. That is as safe as the token
 * file: only a request for this host's own address gets the page, a web page on another origin cannot read it, and the page
 * is never cached or framed.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where the built panel is: `desktop/dist` of the installation, whether this runs from `src` or from `lib`. */
export const panelDirectory = (): string => fileURLToPath(new URL('../desktop/dist', import.meta.url))

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2', '.map': 'application/json',
}
/** What every page is served with: scripts and styles from this origin only, no framing, no referrer. */
const HEADERS = {
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
}

/** Whether the request names this host's own address, which a page on another origin or a rebound name does not. */
export const ownAddress = (req: Pick<IncomingMessage, 'headers'>, port: number): boolean =>
  req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`

/** Escapes a value for an HTML attribute. */
const attribute = (value: string): string => value.replace(/[&"<>]/g, char => `&#${char.charCodeAt(0)};`)

/** The handler that serves the panel from `directory`, with the token in its first page. */
export function panelHandler(options: { directory: string; port: () => number; token: () => string }) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const fail = (status: number): void => { res.writeHead(status, HEADERS); res.end() }
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405)
    if (!ownAddress(req, options.port())) return fail(403)
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    const file = normalize(join(options.directory, path))
    // A path that climbs out of the panel's directory is refused, not mapped.
    if (file !== options.directory && !file.startsWith(options.directory + sep)) return fail(403)
    if (!existsSync(join(options.directory, 'index.html'))) {
      res.writeHead(503, { ...HEADERS, 'content-type': 'text/plain; charset=utf-8' })
      res.end('The panel is not built. Run `pnpm ui:build` (or `pnpm build`), then reload.')
      return
    }
    let found: string | undefined
    try { if (statSync(file).isFile()) found = file } catch { /* Not a file: a route of the panel or a missing asset. */ }
    // A path with no extension is a page of the panel, which the panel's own router resolves; a missing asset is a 404.
    if (!found && !extname(path)) found = join(options.directory, 'index.html')
    if (!found) return fail(404)
    let body: Buffer | string
    try { body = readFileSync(found) } catch { return fail(404) }
    const type = TYPES[extname(found)] ?? 'application/octet-stream'
    const page = found.endsWith('index.html')
    if (page) body = body.toString('utf8').replace('</head>', `<meta name="superagent-token" content="${attribute(options.token())}" /></head>`)
    // Assets carry a content hash in their name; the page, which carries the token, is never cached.
    res.writeHead(200, { ...HEADERS, 'content-type': type, 'cache-control': page ? 'no-store' : 'public, max-age=31536000, immutable' })
    res.end(req.method === 'HEAD' ? undefined : body)
  }
}
