/**
 * The Claude Code runner: the `AgentRunner` over the `claude` CLI.
 *
 * One turn is one process: the runner starts `claude -p`, reads the events it prints as JSON lines, and ends the turn when
 * the process ends. A follow-up turn starts the CLI again with `--resume` and the same session id, so the conversation
 * continues where it stopped.
 *
 * The CLI reaches the engine's tools over the MCP server the engine serves; see `src/runner/cli/mcp.ts`. The router, which
 * reads text from strangers, runs with the built-in tools taken away, and the runner refuses it when the CLI reports a tool
 * that is not ours.
 */
import { randomUUID } from 'node:crypto'
import type { AgentHandle, AgentRunner, Binder, Inbox, ModelSelection, Role, RunnerEvent, RunnerMessage, SessionRef,
  SkillScope, SkillSpec, SpecOfAgent, Subprocess, ToolSpec } from '../port.ts'
import { TOOL_PREFIX, routerRefusal, runTurn, toolsAreOurs } from './turn.ts'

export { TOOL_PREFIX, routerRefusal, toolsAreOurs }

/** How one CLI is run. */
export interface CliConfig {
  /** The command that starts the CLI. */
  readonly command: string
  /** The arguments before the CLI's own flags. */
  readonly args?: readonly string[]
  /** The model the CLI runs with. */
  readonly model?: string
}

/** The options of the Claude Code runner. */
export interface ClaudeRunnerOptions {
  /** The CLI's configuration. */
  readonly cli: CliConfig
  /** How the runner starts a process. */
  readonly subprocess: Subprocess
  /** The logger. */
  readonly logger: { warn(format: string, ...args: unknown[]): void; error(format: string, ...args: unknown[]): void }
  /** How long a turn may run before it is stopped. */
  readonly turnTimeoutMs?: number
  /**
   * The MCP server of an agent, which the CLI reaches the engine's tools through.
   *
   * The factory receives the agent, whose tools the server offers; the engine binds them before the turn starts.
   */
  readonly mcp?: (agent: CliAgent) => Promise<{ url: string; token: string }>
  /**
   * Confines the process of an agent's turn. It receives the agent's workspace and the command line, and returns the
   * command line that runs it confined. Without it the CLI runs as the operator's own user.
   */
  readonly confine?: (workspace: string, argv: readonly string[]) => readonly string[]
}

/** The init event of a CLI run, which names the session, the tools and the MCP servers. */
interface InitEvent {
  type: 'system'
  subtype: 'init'
  session_id?: string
  tools?: string[]
  mcp_servers?: { name: string; status: string }[]
}

/** One agent's state: its transcript, its inbox, and the turn it is running. */
export class CliAgent implements AgentHandle {
  status: 'idle' | 'running' = 'idle'
  /** The messages that wait for the next turn. */
  readonly waiting: RunnerMessage[] = []
  /** The messages that wait for the next step of the turn that runs. */
  readonly next: RunnerMessage[] = []
  readonly inbox: Inbox = {
    nextTurn: this.waiting,
    nextStep: this.next,
    remove: (id: string) => {
      const index = this.waiting.findIndex(message => message.id === id)
      if (index < 0) return false
      this.waiting.splice(index, 1)
      return true
    },
  }
  /** Every event of this agent's transcript, in the order they arrived. */
  readonly events: RunnerEvent[] = []
  /** The CLI's session id, which resumes the conversation. */
  sessionId?: string
  /** The tools the engine bound on this agent. */
  readonly tools = new Map<string, ToolSpec>()
  /** The prompt sections the engine bound on this agent. */
  readonly sections: { name: string; order: number; complete?: boolean; text(request: { bound: boolean }): string }[] = []
  /** The skills the engine registered. */
  readonly skills = new Map<string, SkillSpec>()
  /** The model the CLI runs with. */
  model?: ModelSelection
  /** The title the operator gave this agent. */
  title = ''
  private readonly idle: (() => void)[] = []
  /** The process of the turn that runs, when one does. */
  running?: { kill(signal: NodeJS.Signals): void }
  /** Aborts the turn that runs, when one does. */
  aborting?: AbortController

  constructor(readonly id: string, readonly role: Role, readonly cwd: string, private readonly runner: ClaudeRunner) {
    this.session = { id, snapshotEvents: () => this.events }
  }
  readonly session: SessionRef

  whenIdle(): Promise<void> {
    if (this.status === 'idle') return Promise.resolve()
    return new Promise<void>(resolve => { this.idle.push(resolve) })
  }
  steer(message: RunnerMessage): void { void this.runner.deliver(this, message, 'steer') }
  followup(message: RunnerMessage): void { void this.runner.deliver(this, message, 'queue') }
  inject(message: RunnerMessage): void { this.record(message) }
  /** Records a message in the transcript without waking the agent. */
  record(message: RunnerMessage): void {
    this.events.push({ type: 'user/message', seq: this.events.length, time: Date.now(), data: message })
    this.runner.publish(this, this.events.at(-1)!)
  }
  /** Ends the turn, waking whoever waited for it. */
  finish(): void {
    if (this.status === 'idle') return
    this.status = 'idle'
    for (const wake of this.idle.splice(0)) wake()
  }
}

/** The Claude Code implementation of `AgentRunner`. */
export class ClaudeRunner implements AgentRunner {
  private readonly agents = new Map<string, CliAgent>()
  private readonly onCreated: ((agent: AgentHandle) => void)[] = []
  private readonly onDisposed: ((agent: AgentHandle) => void)[] = []
  private readonly onStatus: ((agent: AgentHandle, status: 'idle' | 'running') => void)[] = []
  private readonly onError: ((agent: AgentHandle, error: unknown) => void)[] = []
  private readonly onClaimed: ((agent: AgentHandle, message: RunnerMessage) => void)[] = []
  private readonly onUserMessage: ((session: SessionRef, message: RunnerMessage) => void)[] = []
  private readonly onEvent: ((agent: AgentHandle, event: RunnerEvent) => void)[] = []
  /** The MCP server of each agent, which the CLI reaches the engine's tools through. */
  private readonly servers = new Map<string, { url: string; token: string; stop(): Promise<void> }>()

  constructor(private readonly options: ClaudeRunnerOptions) {}

  get(id: string): AgentHandle | undefined { return this.agents.get(id) }
  async resolve(id: string): Promise<AgentHandle | undefined> { return this.agents.get(id) }
  async create(spec: SpecOfAgent): Promise<AgentHandle> {
    const agent = new CliAgent(spec.id, spec.role, spec.cwd, this)
    this.agents.set(spec.id, agent)
    for (const listener of this.onCreated) await listener(agent)
    return agent
  }
  async rename(id: string, title: string): Promise<void> {
    const agent = this.agents.get(id)
    if (agent) agent.title = title
  }
  cancel(agent: AgentHandle, options?: { keepInbox?: boolean }): void {
    const cli = this.agents.get(agent.id)
    if (!cli) return
    if (!options?.keepInbox) {
      // The inbox holds the messages that wait for the next turn; a cancel takes them out unless they are kept.
      cli.waiting.length = 0
      cli.next.length = 0
    }
    cli.aborting?.abort()
    cli.running?.kill('SIGTERM')
  }
  parentId(_agent: AgentHandle): string | undefined { return undefined }
  message(init: { id: string; text: string; form: 'relay' | 'notice'; summary?: string }): RunnerMessage {
    return { id: init.id, role: 'user', content: [{ type: 'text', text: init.text }],
      source: { kind: 'dsh-superagent', form: init.form, ...init.summary ? { summary: init.summary } : {} } } as unknown as RunnerMessage
  }
  binder(agent: AgentHandle): Binder { return new CliBinder(this.agents.get(agent.id)!) }
  hasModel(agent: AgentHandle): boolean { return !!this.agents.get(agent.id)?.model }
  seedModel(agent: AgentHandle, selection: ModelSelection): void { this.agents.get(agent.id)!.model = selection }
  pinRoles(_roleOf: (agentId: string) => Role | undefined): void { /* The CLI has no presets to pin. */ }
  jobs() { return undefined }
  subagents() { return undefined }

  created(listener: (agent: AgentHandle) => void | Promise<void>) {
    const wrapped = (agent: AgentHandle) => { void listener(agent) }
    this.onCreated.push(wrapped)
    return () => { const index = this.onCreated.indexOf(wrapped); if (index >= 0) this.onCreated.splice(index, 1) }
  }
  disposed(listener: (agent: AgentHandle) => void) {
    this.onDisposed.push(listener)
    return () => { const index = this.onDisposed.indexOf(listener); if (index >= 0) this.onDisposed.splice(index, 1) }
  }
  status(listener: (agent: AgentHandle, status: 'idle' | 'running') => void) {
    this.onStatus.push(listener)
    return () => { const index = this.onStatus.indexOf(listener); if (index >= 0) this.onStatus.splice(index, 1) }
  }
  error(listener: (agent: AgentHandle, error: unknown) => void) {
    this.onError.push(listener)
    return () => { const index = this.onError.indexOf(listener); if (index >= 0) this.onError.splice(index, 1) }
  }
  inboxClaimed(listener: (agent: AgentHandle, message: RunnerMessage) => void) {
    this.onClaimed.push(listener)
    return () => { const index = this.onClaimed.indexOf(listener); if (index >= 0) this.onClaimed.splice(index, 1) }
  }
  userMessage(listener: (session: SessionRef, message: RunnerMessage) => void) {
    this.onUserMessage.push(listener)
    return () => { const index = this.onUserMessage.indexOf(listener); if (index >= 0) this.onUserMessage.splice(index, 1) }
  }
  event(listener: (agent: AgentHandle, event: RunnerEvent) => void) {
    this.onEvent.push(listener)
    return () => { const index = this.onEvent.indexOf(listener); if (index >= 0) this.onEvent.splice(index, 1) }
  }

  /** Publishes one transcript event of an agent. */
  publish(agent: CliAgent, event: RunnerEvent): void {
    for (const listener of this.onEvent) listener(agent, event)
  }
  /** Reports that a turn ended. */
  publishStatus(agent: CliAgent, status: 'idle' | 'running'): void {
    for (const listener of this.onStatus) listener(agent, status)
  }
  /** Reports a failure of a turn. */
  publishError(agent: CliAgent, error: unknown): void {
    for (const listener of this.onError) listener(agent, error)
  }
  /** Reports that a message left the inbox. */
  publishClaimed(agent: CliAgent, message: RunnerMessage): void {
    for (const listener of this.onClaimed) listener(agent, message)
  }
  /** Reports that a message entered the transcript. */
  publishUserMessage(agent: CliAgent, message: RunnerMessage): void {
    for (const listener of this.onUserMessage) listener(agent.session, message)
  }

  /** Delivers a message to an agent: it starts a turn when the agent is idle. */
  async deliver(agent: CliAgent, message: RunnerMessage, mode: 'steer' | 'queue'): Promise<void> {
    if (mode === 'steer' && agent.status === 'running') {
      // The CLI takes no input while it runs, so a steering message waits for the next turn.
      agent.next.push(message)
      return
    }
    agent.waiting.push(message)
    if (agent.status === 'idle') await this.run(agent)
  }

  /**
   * Runs one turn of the agent: the CLI runs until it ends, and the messages that waited are taken along.
   *
   * The router's tools are checked before the turn counts: a CLI that reports a tool of its own may not read strangers'
   * text, so the turn is refused instead of run.
   */
  async run(agent: CliAgent): Promise<void> {
    const prompt = agent.waiting.shift()
    if (!prompt) return
    agent.status = 'running'
    this.publishStatus(agent, 'running')
    // The message enters the transcript with the turn, as it does in the harness.
    agent.record(prompt)
    this.publishClaimed(agent, prompt)
    this.publishUserMessage(agent, prompt)
    const controller = new AbortController()
    agent.aborting = controller
    const server = this.options.mcp ? await this.options.mcp(agent) : undefined
    // The engine's prompt sections become the CLI's system prompt, in the order they were added.
    const sections = [...agent.sections].sort((a, b) => a.order - b.order)
    const systemPrompt = sections.map(section => section.text({ bound: true })).filter(Boolean).join('\n\n')
    const spec = {
      command: this.options.cli.command,
      args: this.options.cli.args ?? [],
      cwd: agent.cwd,
      prompt: prompt.content.map(block => block.text ?? '').join('\n'),
      ...agent.sessionId ? { sessionId: agent.sessionId } : {},
      ...agent.model?.model ? { model: agent.model.model } : this.options.cli.model ? { model: this.options.cli.model } : {},
      mcpConfig: server ? JSON.stringify({ mcpServers: { superagent: { type: 'http', url: server.url,
        headers: { authorization: `Bearer ${server.token}` } } } }) : '',
      ...systemPrompt ? { systemPrompt } : {},
      // The router reads text from strangers, so it runs with the CLI's own tools and servers taken away.
      noBuiltins: agent.role === 'orchestrator',
      strictMcp: agent.role === 'orchestrator',
      noCommands: agent.role === 'orchestrator',
      timeoutMs: this.options.turnTimeoutMs ?? 30 * 60_000,
      signal: controller.signal,
      ...this.options.confine ? { confine: (argv: readonly string[]) => this.options.confine!(agent.cwd, argv) } : {},
    }
    try {
      const result = await runTurn(this.options.subprocess, spec)
      if (result.sessionId) agent.sessionId = result.sessionId
      // The router may only have the engine's own tools; a CLI that reports anything else is refused.
      if (agent.role === 'orchestrator' && !toolsAreOurs(result.tools, [...agent.tools.keys()])) {
        this.publishError(agent, new Error(routerRefusal(result.tools)))
        return
      }
      for (const event of result.events) { agent.events.push(event); this.publish(agent, event) }
      if (result.error) this.publishError(agent, new Error(result.error))
    } catch (error) {
      this.publishError(agent, error)
    } finally {
      agent.aborting = undefined
      agent.running = undefined
      agent.finish()
      this.publishStatus(agent, 'idle')
      // The messages that waited during the turn start the next one.
      if (agent.waiting.length) await this.run(agent)
    }
  }
}

/** What the engine installs on one CLI agent. */
export class CliBinder implements Binder {
  constructor(private readonly agent: CliAgent) {}
  addPromptSection(section: { name: string; order: number; complete?: boolean; text(request: { bound: boolean }): string }): () => void {
    this.agent.sections.push(section)
    return () => { const index = this.agent.sections.indexOf(section); if (index >= 0) this.agent.sections.splice(index, 1) }
  }
  registerTool(tool: ToolSpec): () => void {
    this.agent.tools.set(tool.name, tool)
    return () => { this.agent.tools.delete(tool.name) }
  }
  allowTools(_names: readonly string[]): () => void { return () => {} }
  availableTools(names: readonly string[]): string[] { return names.filter(name => this.agent.tools.has(name)) }
  guardTools(_guard: () => string | undefined): () => void { return () => {} }
  registerSkill(bind: (scope: SkillScope) => void): { release: () => void; ready: Promise<void> } {
    const scope: SkillScope = { register: skill => { this.agent.skills.set(skill.name, skill); return () => { this.agent.skills.delete(skill.name) } } }
    bind(scope)
    return { release: () => { this.agent.skills.clear() }, ready: Promise.resolve() }
  }
  grantFullAccess(): void { /* The CLI's own permissions are its own; the router runs with none of them. */ }
}
