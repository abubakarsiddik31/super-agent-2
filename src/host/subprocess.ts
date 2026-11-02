/**
 * `Subprocess` over Node's own `child_process`, for a host that runs without the DeepSeek Harness.
 *
 * The credential scrub matches the harness's: a child starts from the parent environment minus every credential-shaped name
 * and minus every `DSH_*` name, and the spec's explicit `env` merges over that base. A deliberate entry therefore survives
 * the scrub, and an `undefined` entry removes an ambient one.
 */
import { spawn } from 'node:child_process'
import type { Subprocess, SubprocessReader, SubprocessSpec } from '../runner/port.ts'

/** Credential-shaped environment names are not forwarded to children, so the host's own secrets never leak into them. */
const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i
/** The harness's own namespace never reaches a child implicitly; a deliberate entry goes through the spec's `env`. */
const HARNESS_PREFIX = 'DSH_'

/** The ambient parent environment minus credential-shaped names and minus all `DSH_*` names. */
export function scrubbedEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (SENSITIVE_ENV_PATTERN.test(name) || name.toUpperCase().startsWith(HARNESS_PREFIX)) continue
    env[name] = value
  }
  return env
}

/** Collects a stream's text, keeping only its tail so a chatty child cannot exhaust memory. */
class Collected {
  private chunks: Buffer[] = []
  private size = 0
  constructor(private readonly maxBytes: number) {}
  push(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.size += chunk.length
    // Drop the oldest bytes once the tail exceeds its bound; the reader reports the loss.
    let excess = this.size - this.maxBytes
    while (excess > 0 && this.chunks.length > 1) {
      const first = this.chunks[0]!
      if (first.length <= excess) { this.chunks.shift(); this.size -= first.length; excess -= first.length }
      else { this.chunks[0] = first.subarray(excess); this.size -= excess; excess = 0 }
    }
  }
  /** The whole retained tail, as text. */
  text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

/** An offset-based reader over a collected stream; the offset is a whole-stream byte coordinate. */
function reader(collected: Collected): SubprocessReader {
  return { readFrom: (offset: number) => ({ text: collected.text().slice(offset) }) }
}

export const nodeSubprocess: Subprocess = {
  spawn(spec: SubprocessSpec) {
    const [program, ...args] = spec.argv
    if (!program) throw new Error('A subprocess needs a program to run')
    const stdout = new Collected(spec.stdio.stdout.maxBytes)
    const stderr = new Collected(spec.stdio.stderr.maxBytes)
    const child = spawn(program, args, {
      cwd: spec.cwd,
      env: { ...scrubbedEnv(), ...spec.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      // A detached child would outlive the host, so it stays in the host's group and dies with it.
      detached: false,
    })
    child.stdout?.on('data', (chunk: Buffer) => { stdout.push(chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { stderr.push(chunk) })
    let ended = false
    const done = new Promise<{ exitCode: number | null }>((resolve, reject) => {
      child.once('error', (error: Error) => { ended = true; reject(error) })
      child.once('close', (code: number | null) => { ended = true; resolve({ exitCode: code }) })
    })
    /** Ends the child: a signal first, then `SIGKILL` once the grace period passes. */
    const terminate = (): void => {
      if (ended) return
      child.kill('SIGTERM')
      const timer = setTimeout(() => { if (!ended) child.kill('SIGKILL') }, spec.graceMs)
      // The timer must not hold the process open once the child is gone.
      timer.unref?.()
    }
    spec.signal?.addEventListener('abort', terminate, { once: true })
    return { done, collected: { stdout: reader(stdout), stderr: reader(stderr) } }
  },
}
