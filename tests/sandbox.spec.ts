/**
 * The worker sandbox (SEC-01): a confined process cannot read the operator's home or reach the control plane, however it
 * is started. The Seatbelt tests run real commands under `sandbox-exec`, so they run on macOS only.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bubblewrapArgs, chooseSandbox, policyFor, SandboxUnavailable, seatbeltProfile } from '../src/sandbox/index.ts'
import { seatbelt } from '../src/sandbox/seatbelt.ts'
import { nodeSubprocess } from '../src/host/subprocess.ts'
import { runTurn } from '../src/runner/cli/turn.ts'

const policy = (overrides = {}) => ({ workspace: '/s/work/t1', stateDir: '/s', readOnlyInState: ['/s/worker-bin'], writable: [], readable: [], cliState: [], ...overrides })

describe('choosing a sandbox', () => {
  it('uses Seatbelt on macOS and bubblewrap on Linux', () => {
    expect(chooseSandbox('auto', 'darwin', () => false)?.name).toBe('seatbelt')
    expect(chooseSandbox('auto', 'linux', program => program === 'bwrap')?.name).toBe('bubblewrap')
  })
  it('refuses to run agents when this machine has no sandbox and the operator did not turn it off', () => {
    expect(() => chooseSandbox('auto', 'linux', () => false)).toThrow(SandboxUnavailable)
    expect(() => chooseSandbox('bubblewrap', 'darwin', () => true)).toThrow(SandboxUnavailable)
  })
  it('runs agents unconfined only when the operator says so by name', () => {
    expect(chooseSandbox('off', 'linux', () => false)).toBeUndefined()
  })
})

describe('the policy of one agent', () => {
  it('names the workspace, the shims and the CLI\'s own state, and nothing else of the state directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'policy-'))
    try {
      const result = policyFor({ workspace: dir, stateDir: dir, command: 'sh', home: '/Users/x' })
      expect(result.workspace).toContain('policy-')
      expect(result.readOnlyInState.map(path => path.split('/').pop())).toEqual(['worker-bin', 'worker-gitconfig'])
      expect(result.cliState.map(path => path.split('/').pop())).toEqual(expect.arrayContaining(['.claude', '.claude.json']))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('the profiles', () => {
  it('lists the control plane before the exceptions, because the last matching rule wins', () => {
    const profile = seatbeltProfile(policy(), '/Users/x')
    expect(profile.indexOf('(deny file-read* file-write* (subpath "/s"))')).toBeLessThan(profile.indexOf('(subpath "/s/work/t1")'))
    expect(profile).toContain('(deny file-read* (subpath "/Users/x"))')
    expect(profile).toContain('(deny file-write*)')
  })
  it('hides the home directory and the state directory under bubblewrap', () => {
    const args = bubblewrapArgs(['claude', '-p', 'x'], policy(), '/home/x')
    expect(args.slice(args.indexOf('--tmpfs'), args.indexOf('--tmpfs') + 2)).toEqual(['--tmpfs', '/tmp'])
    expect(args).toContain('/home/x')
    expect(args.indexOf('/s')).toBeLessThan(args.indexOf('/s/work/t1'))
    expect(args.slice(-3)).toEqual(['claude', '-p', 'x'])
  })
})

describe.skipIf(platform() !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))('under Seatbelt', () => {
  // The canary lies in the real home directory, where the operator's own secrets would.
  let root: string
  let state: string
  let workspace: string
  let outside: string
  beforeAll(() => {
    root = mkdtempSync(join(homedir(), '.superagent-sandbox-test-'))
    state = join(root, 'state')
    workspace = join(state, 'work', 't1')
    outside = join(root, 'other-project')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(join(state, 'work', 't2'), { recursive: true })
    mkdirSync(join(state, 'worker-bin'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(root, 'canary'), 'HOME-CANARY')
    writeFileSync(join(state, 'panel-token'), 'TOKEN-CANARY')
    writeFileSync(join(state, 'orchestrator.sqlite'), 'DB-CANARY')
    writeFileSync(join(state, 'work', 't2', 'notes'), 'OTHER-TICKET')
    writeFileSync(join(state, 'worker-bin', 'gh'), '#!/bin/sh\necho shim\n', { mode: 0o755 })
    writeFileSync(join(outside, 'file'), 'x')
  })
  afterAll(() => { rmSync(root, { recursive: true, force: true }) })

  /** Runs a shell command in the workspace, confined, and reports whether it succeeded and what it printed. */
  const confined = (script: string) => {
    const policy = policyFor({ workspace, stateDir: state, command: 'sh' })
    const { argv } = seatbelt.wrap(['/bin/sh', '-c', script], policy)
    const result = spawnSync(argv[0]!, argv.slice(1), { cwd: workspace, encoding: 'utf8' })
    return { ok: result.status === 0, out: result.stdout.trim(), err: result.stderr }
  }

  it('lets the agent work in its own workspace', () => {
    expect(confined('echo done > out.txt && cat out.txt').out).toBe('done')
    expect(readFileSync(join(workspace, 'out.txt'), 'utf8').trim()).toBe('done')
  })
  it('cannot read a canary in the operator\'s home', () => {
    const result = confined(`cat ${join(root, 'canary')}`)
    expect(result.ok).toBe(false)
    expect(result.out).not.toContain('HOME-CANARY')
  })
  it('cannot read the panel token or the database in the state directory', () => {
    expect(confined(`cat ${join(state, 'panel-token')}`).out).not.toContain('TOKEN-CANARY')
    expect(confined(`cat ${join(state, 'orchestrator.sqlite')}`).ok).toBe(false)
  })
  it('cannot write to the state directory, or replace the database', () => {
    expect(confined(`echo owned > ${join(state, 'orchestrator.sqlite')}`).ok).toBe(false)
    expect(confined(`echo owned > ${join(state, 'panel-token')}`).ok).toBe(false)
    expect(readFileSync(join(state, 'panel-token'), 'utf8')).toBe('TOKEN-CANARY')
  })
  it('cannot read or write another ticket\'s directory', () => {
    expect(confined(`cat ${join(state, 'work', 't2', 'notes')}`).ok).toBe(false)
    expect(confined(`echo x > ${join(state, 'work', 't2', 'mine')}`).ok).toBe(false)
  })
  it('cannot write to another project in the home directory', () => {
    expect(confined(`echo x > ${join(outside, 'new')}`).ok).toBe(false)
    expect(existsSync(join(outside, 'new'))).toBe(false)
  })
  it('can read and run the worker shims, which the agent needs for gh and git', () => {
    expect(confined(`${join(state, 'worker-bin', 'gh')}`).out).toBe('shim')
    expect(confined(`echo x > ${join(state, 'worker-bin', 'gh')}`).ok).toBe(false)
  })
  it('confines what the agent starts, so an absolute path or a nested shell gets nothing more', () => {
    expect(confined(`sh -c 'sh -c "cat ${join(root, 'canary')}"'`).out).not.toContain('HOME-CANARY')
  })
  it('keeps the agent\'s own temporary files working', () => {
    expect(confined('f=$(mktemp) && echo ok > "$f" && cat "$f"').out).toBe('ok')
  })
  it('lets the operator allow one more path to read', () => {
    const policyAllowed = policyFor({ workspace, stateDir: state, command: 'sh', extras: { readable: [outside] } })
    const { argv } = seatbelt.wrap(['/bin/sh', '-c', `cat ${join(outside, 'file')}`], policyAllowed)
    expect(spawnSync(argv[0]!, argv.slice(1), { cwd: workspace, encoding: 'utf8' }).stdout).toBe('x')
  })
  it('lets a worktree commit into the repository it was made from', () => {
    const repo = join(root, 'repo')
    mkdirSync(repo)
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    git('commit', '-q', '--allow-empty', '-m', 'start')
    const tree = join(state, 'work', 't3')
    git('worktree', 'add', '-q', '-b', 't3', tree)
    const policyTree = policyFor({ workspace: tree, stateDir: state, command: 'sh' })
    const { argv } = seatbelt.wrap(['/bin/sh', '-c', 'echo a > a && git add a && git -c user.name=t -c user.email=t@t commit -q -m work && git log --oneline | wc -l'], policyTree)
    // A real worker's git reads the worker's own configuration, never the operator's.
    writeFileSync(join(state, 'worker-gitconfig'), '[user]\n\tuseConfigOnly = true\n')
    const env = { ...process.env, GIT_CONFIG_GLOBAL: join(state, 'worker-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
    const result = spawnSync(argv[0]!, argv.slice(1), { cwd: tree, encoding: 'utf8', env })
    expect(result.stdout.trim()).toBe('2')
  })

  // The real CLI, signed in as the operator, asked to read the canary. Skipped where it is not installed or not signed in.
  const CLAUDE = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/usr/bin/claude'].find(path => existsSync(path))
  it.skipIf(!CLAUDE)('runs the real Claude Code CLI confined: it works, and cannot read the canary', async () => {
    const policyCli = policyFor({ workspace, stateDir: state, command: CLAUDE! })
    const spec = { command: CLAUDE!, args: ['--dangerously-skip-permissions'], cwd: workspace, mcpConfig: '', noBuiltins: false, strictMcp: false, noCommands: false,
      timeoutMs: 150_000, signal: new AbortController().signal, confine: (argv: readonly string[]) => seatbelt.wrap(argv, policyCli).argv,
      prompt: `Run the shell command: cat ${join(root, 'canary')}. Then write the word done into a file named out2.txt in the current directory. Reply with what the cat printed.` }
    const result = await runTurn(nodeSubprocess, spec)
    // Not signed in: the CLI says so and does no work, so there is nothing to check.
    if (JSON.stringify(result.events).includes('Not logged in')) return
    expect(JSON.stringify(result.events)).not.toContain('HOME-CANARY')
    expect(readFileSync(join(workspace, 'out2.txt'), 'utf8')).toContain('done')
  }, 170_000)
})
