#!/usr/bin/env node
/**
 * The standalone host: the engine, the management API and the Sources in one plain Node process, with no DeepSeek software.
 *
 * Usage: `superagent [--state-dir DIR] [--port N] [--cli COMMAND] [--cli-model MODEL] [--sandbox auto|seatbelt|bubblewrap|off] [--allow-read PATH] [--allow-write PATH] [--no-open]`
 *
 * It serves the panel and the management API on one loopback address, 3082 unless that is taken, and opens the panel in the
 * browser. The state directory holds the database, the locks, the worker shims and the panel token. The management API listens on the
 * loopback interface; the panel token in the state directory authorizes it.
 */
import { spawn } from 'node:child_process'
/** The host is built into `lib`; a checkout that was not built says what to run instead of failing on a missing file. */
const { startStandalone } = await import('../lib/standalone.js').catch(error => {
  if (error?.code === 'ERR_MODULE_NOT_FOUND') { console.error('superagent is not built yet. Run `pnpm build`, then start it again.'); process.exit(1) }
  throw error
})

/** Reads the command's options; each has a default and an environment variable. */
function options(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--state-dir') values.stateDir = argv[++index]
    else if (argument === '--port') values.port = Number(argv[++index])
    else if (argument === '--cli') values.cli = argv[++index]
    else if (argument === '--cli-model') values.cliModel = argv[++index]
    else if (argument === '--no-open') values.noOpen = true
    else if (argument === '--sandbox') values.sandbox = argv[++index]
    else if (argument === '--allow-read') (values.readable ??= []).push(argv[++index])
    else if (argument === '--allow-write') (values.writable ??= []).push(argv[++index])
    else if (argument === '--help' || argument === '-h') {
      console.log('Usage: superagent [--state-dir DIR] [--port N] [--cli COMMAND] [--cli-model MODEL] [--sandbox auto|seatbelt|bubblewrap|off] [--allow-read PATH] [--allow-write PATH] [--no-open]')
      process.exit(0)
    } else throw new Error(`Unknown option: ${argument}`)
  }
  return values
}

const values = options(process.argv.slice(2))
const stateDir = values.stateDir ?? process.env.SUPERAGENT_STATE_DIR
const port = values.port ?? (process.env.SUPERAGENT_PORT ? Number(process.env.SUPERAGENT_PORT) : undefined)
const cli = values.cli ?? process.env.SUPERAGENT_CLI
const cliModel = values.cliModel ?? process.env.SUPERAGENT_CLI_MODEL
/** The default port, which keeps the panel's address the same from one start to the next. */
const DEFAULT_PORT = 3082
const start = port => startStandalone({
  ...stateDir ? { stateDir } : {},
  port,
  ...values.sandbox ?? process.env.SUPERAGENT_SANDBOX ? { sandbox: values.sandbox ?? process.env.SUPERAGENT_SANDBOX } : {},
  ...values.readable || values.writable ? { sandboxExtras: { readable: values.readable ?? [], writable: values.writable ?? [] } } : {},
  ...cli ? { cli: { command: cli, ...cliModel ? { model: cliModel } : {} } } : {},
})
let host
try { host = await start(port ?? DEFAULT_PORT) }
catch (error) {
  // A busy default port falls back to a free one; a port the operator asked for does not.
  if (port !== undefined || error?.code !== 'EADDRINUSE') throw error
  host = await start(0)
}
const url = `http://127.0.0.1:${host.host.http.port}/`
console.log(`superagent is running. Open the panel at ${url}`)
console.log(`the agent CLI is ${cli ?? 'not configured; a ticket that needs an agent will fail'}`)
if (!values.noOpen && !process.env.CI) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
}

let stopping = false
/** Stops the host once, however many signals arrive. */
const stop = async () => {
  if (stopping) return
  stopping = true
  await host.stop()
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { void stop().then(() => { process.exit(0) }) })
}
