#!/usr/bin/env node
/**
 * The standalone host: the engine, the management API and the Sources in one plain Node process, with no DeepSeek software.
 *
 * Usage: `superagent [--state-dir DIR] [--port N]`
 *
 * The state directory holds the database, the locks, the worker shims and the panel token. The management API listens on the
 * loopback interface; the panel token in the state directory authorizes it.
 */
import { startStandalone } from '../lib/standalone.js'

/** Reads the command's options; each has a default and an environment variable. */
function options(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--state-dir') values.stateDir = argv[++index]
    else if (argument === '--port') values.port = Number(argv[++index])
    else if (argument === '--help' || argument === '-h') {
      console.log('Usage: superagent [--state-dir DIR] [--port N]')
      process.exit(0)
    } else throw new Error(`Unknown option: ${argument}`)
  }
  return values
}

const values = options(process.argv.slice(2))
const stateDir = values.stateDir ?? process.env.SUPERAGENT_STATE_DIR
const port = values.port ?? (process.env.SUPERAGENT_PORT ? Number(process.env.SUPERAGENT_PORT) : undefined)
const host = await startStandalone({ ...stateDir ? { stateDir } : {}, ...port === undefined ? {} : { port } })
console.log(`superagent is listening on http://${host.host.http.host}:${host.host.http.port}`)
console.log('the panel token is in the state directory, in panel-token')

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
