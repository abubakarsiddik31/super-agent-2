/** Chooses the sandbox a host runs agents in, and builds the policy of one agent. */
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { workerBin, workerGitConfig } from '../infra/environment.ts'
import { bubblewrap } from './bubblewrap.ts'
import type { Sandbox, SandboxMode, SandboxPolicy } from './port.ts'
import { seatbelt } from './seatbelt.ts'

export type { Sandbox, SandboxMode, SandboxPolicy } from './port.ts'
export { seatbeltProfile } from './seatbelt.ts'
export { bubblewrapArgs } from './bubblewrap.ts'

/** The error a host raises when it cannot confine agents and the operator did not ask to run them unconfined. */
export class SandboxUnavailable extends Error {}

/** The real path of `path`, or `path` itself when it does not exist; a profile names the real path, not a link to it. */
export const real = (path: string): string => { try { return realpathSync(path) } catch { return resolve(path) } }

/** Whether a program is on the path. */
function onPath(program: string): boolean {
  return (process.env.PATH ?? '').split(delimiter).some(dir => dir && existsSync(join(dir, program)))
}

/** The sandbox of this machine, by the operator's setting; `undefined` when the operator turned it off. */
export function chooseSandbox(mode: SandboxMode = 'auto', os: string = platform(), has: (program: string) => boolean = onPath): Sandbox | undefined {
  if (mode === 'off') return undefined
  const available: Record<string, boolean> = {
    seatbelt: os === 'darwin' && existsSync('/usr/bin/sandbox-exec'),
    bubblewrap: os === 'linux' && has('bwrap'),
  }
  const name = mode === 'auto' ? (['seatbelt', 'bubblewrap'] as const).find(candidate => available[candidate]) : mode
  if (!name || !available[name]) {
    throw new SandboxUnavailable(mode === 'auto'
      ? 'No sandbox is available on this machine (macOS needs sandbox-exec, Linux needs bubblewrap). Install one, or pass --sandbox off to run agents unconfined.'
      : `The ${mode} sandbox is not available on this machine. Pick another with --sandbox, or pass --sandbox off to run agents unconfined.`)
  }
  return name === 'seatbelt' ? seatbelt : bubblewrap
}

/** The git directory a worktree commits into, which lies outside the worktree. */
function gitDirectories(workspace: string): string[] {
  try {
    const out = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return [real(out.trim())]
  } catch { return [] }
}

/** The directory a command lives in, resolved, so the CLI's own install stays readable when it sits in the home directory. */
function installOf(command: string): string[] {
  const file = isAbsolute(command) ? command : (process.env.PATH ?? '').split(delimiter).map(dir => join(dir, command)).find(path => existsSync(path))
  if (!file) return []
  const target = real(file)
  return [...new Set([dirname(file), dirname(target)].map(real))]
}

/** What the operator adds to the policy. */
export interface SandboxExtras {
  /** Paths in the home directory that agents may read, such as a language toolchain. */
  readonly readable?: readonly string[]
  /** Paths outside a workspace that agents may also write. */
  readonly writable?: readonly string[]
}

/** The policy one agent runs under: its workspace, and nothing of the control plane. */
export function policyFor(init: { workspace: string; stateDir: string; command: string; extras?: SandboxExtras; home?: string }): SandboxPolicy {
  const home = init.home ?? homedir()
  const stateDir = real(init.stateDir)
  return {
    workspace: real(init.workspace),
    stateDir,
    readOnlyInState: [real(workerBin(stateDir)), real(workerGitConfig(stateDir))],
    writable: [...gitDirectories(init.workspace), ...(init.extras?.writable ?? []).map(real)],
    readable: [...installOf(init.command), ...(init.extras?.readable ?? []).map(real)],
    // The CLI keeps its sessions, and the sign-in it was given, in these (on macOS the sign-in is in the keychain); the agent
    // runs as the CLI's user.
    cliState: [join(home, '.claude'), join(home, '.claude.json'), ...platform() === 'darwin' ? [join(home, 'Library', 'Keychains')] : []].map(real),
  }
}
