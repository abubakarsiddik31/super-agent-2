/**
 * The macOS sandbox, over `sandbox-exec` and a Seatbelt profile.
 *
 * The profile starts open and takes away what the agent must not have: reading the operator's home directory, writing
 * anywhere but the ticket's workspace and the CLI's own state, and reaching the state directory, where the database, the
 * panel token and the other tickets live. Seatbelt takes the last rule that matches, so the exceptions come after the
 * denials they cut into.
 */
import { homedir } from 'node:os'
import type { Sandbox, SandboxPolicy } from './port.ts'

/** Quotes a path for the profile language. */
const quote = (path: string): string => `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
const sub = (paths: readonly string[]): string => paths.map(path => `(subpath ${quote(path)})`).join(' ')

/** The Seatbelt profile that confines one process to `policy`. */
export function seatbeltProfile(policy: SandboxPolicy, home: string = homedir()): string {
  const lines = [
    '(version 1)',
    '(allow default)',
    // The operator's home holds keys, tokens and every other project; none of it is the agent's.
    `(deny file-read* (subpath ${quote(home)}))`,
    policy.readable.length ? `(allow file-read* ${sub(policy.readable)})` : '',
    // Nothing is writable except what is named below.
    '(deny file-write*)',
    '(allow file-write* (literal "/dev/null") (literal "/dev/dtracehelper") (literal "/dev/tty") (subpath "/dev/fd"))',
    // The system's temporary directories are per-run scratch space, not the operator's data.
    '(allow file-write* (subpath "/private/tmp") (subpath "/private/var/folders"))',
    policy.cliState.length ? `(allow file-read* file-write* ${sub(policy.cliState)})` : '',
    policy.writable.length ? `(allow file-read* file-write* ${sub(policy.writable)})` : '',
    // The state directory is the control plane: the database, the panel token, the other tickets.
    `(deny file-read* file-write* (subpath ${quote(policy.stateDir)}))`,
    policy.readOnlyInState.length ? `(allow file-read* ${sub(policy.readOnlyInState)})` : '',
    `(allow file-read* file-write* (subpath ${quote(policy.workspace)}))`,
    // Tools walk up from their directory, looking at each parent, so a parent's existence stays visible. Its contents, and
    // its listing, do not: those are data reads, which stay denied.
    '(allow file-read-metadata)',
  ]
  return lines.filter(Boolean).join('\n') + '\n'
}

/** The sandbox that runs a command under `sandbox-exec`. */
export const seatbelt: Sandbox = {
  name: 'seatbelt',
  wrap: (argv, policy) => ({ argv: ['/usr/bin/sandbox-exec', '-p', seatbeltProfile(policy), ...argv] }),
}
