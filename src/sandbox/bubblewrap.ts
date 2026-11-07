/**
 * The Linux sandbox, over bubblewrap.
 *
 * The process sees the system read-only and an empty home directory. The workspace and the CLI's own state are bound back
 * in, and the state directory is an empty tree with only the allowed read-only paths put back inside it.
 */
import { homedir } from 'node:os'
import type { Sandbox, SandboxPolicy } from './port.ts'

/** The `bwrap` command line that confines `argv` to `policy`. */
export function bubblewrapArgs(argv: readonly string[], policy: SandboxPolicy, home: string = homedir()): string[] {
  const args = ['bwrap', '--die-with-parent', '--unshare-pid', '--unshare-ipc', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
    '--tmpfs', '/tmp', '--tmpfs', home, '--tmpfs', policy.stateDir]
  for (const path of policy.readable) args.push('--ro-bind-try', path, path)
  for (const path of [...policy.cliState, ...policy.writable]) args.push('--bind-try', path, path)
  for (const path of policy.readOnlyInState) args.push('--ro-bind-try', path, path)
  args.push('--bind', policy.workspace, policy.workspace, '--chdir', policy.workspace, '--', ...argv)
  return args
}

/** The sandbox that runs a command under bubblewrap. */
export const bubblewrap: Sandbox = {
  name: 'bubblewrap',
  wrap: (argv, policy) => ({ argv: bubblewrapArgs(argv, policy) }),
}
