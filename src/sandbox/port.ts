/**
 * The sandbox port: how the host confines the process an agent CLI runs in.
 *
 * A worker reads text from strangers and runs code it did not write, so the host does not trust it with the operator's
 * machine. The sandbox wraps the CLI's command line so the operating system, not a prompt, limits what the process and
 * everything it starts can read and write. It is a port because the mechanism differs by platform: Seatbelt on macOS,
 * bubblewrap on Linux. A host that finds neither refuses to run agents unless the operator turns the sandbox off by name.
 */

/** What one confined process may touch. Every path is absolute. */
export interface SandboxPolicy {
  /** The ticket's own directory: the one place the process may write, and read. */
  readonly workspace: string
  /** The state directory, which holds the database, the panel token and every other ticket's directory. Nothing in it is reachable except what is allowed below. */
  readonly stateDir: string
  /** Paths inside the state directory the process may read but not change, such as the worker shims and the git configuration. */
  readonly readOnlyInState: readonly string[]
  /** Paths outside the workspace the process may also write: the repository's own git directory, so a worktree can commit. */
  readonly writable: readonly string[]
  /** Paths the process may read although they lie in the operator's home directory: the CLI's own install and its settings. */
  readonly readable: readonly string[]
  /** Paths the CLI itself writes, such as its session files. They are part of the CLI, not of the operator's data. */
  readonly cliState: readonly string[]
}

/** A command line, before and after the sandbox wraps it. */
export interface Wrapped {
  readonly argv: readonly string[]
}

/** One way of confining a process. */
export interface Sandbox {
  /** The name the operator chooses it by and the panel shows. */
  readonly name: string
  /** Wraps `argv` so it runs under `policy`. */
  wrap(argv: readonly string[], policy: SandboxPolicy): Wrapped
}

/** The sandbox settings the operator can give. `off` runs workers unconfined, and the host says so at startup. */
export type SandboxMode = 'auto' | 'seatbelt' | 'bubblewrap' | 'off'
