/**
 * The seams between the engine and what hosts and runs its agents. The engine, `Sessions`, the Executor and the delivery code
 * depend on these types only; `src/runner/dsh` implements them with the DeepSeek Harness (DSH), and a later runner may do so
 * with agent CLIs. Nothing here imports a runner or a host.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { z } from 'zod'

export type Unsubscribe = () => void
export type Role = 'orchestrator' | 'worker'

/** A model choice as a runner resolves it; `reasoningEffort` is the runner's own id for an effort level. */
export interface ModelSelection { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
/** A configured route to a model, as the policy stores it. */
export interface ModelRoute { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
export interface ModelCatalogModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly reasoning?: { readonly efforts: readonly { readonly id: string; readonly name?: string }[] }
}
export interface ModelCatalog {
  readonly default: ModelSelection
  readonly routableProviders: readonly string[]
  readonly groups: readonly { readonly id: string; readonly name: string; readonly models: readonly ModelCatalogModel[] }[]
  readonly failures: readonly { readonly id: string; readonly name: string; readonly message: string }[]
}

/** One block of a message; only `text` blocks carry text. */
export interface ContentBlock { readonly type: string; readonly text?: string }
/** A message the engine puts into an agent's inbox or reads back from its transcript. */
export interface RunnerMessage {
  readonly id: string
  readonly role: string
  readonly content: readonly ContentBlock[]
  readonly source: { readonly kind: string }
}
/** What the engine says about a message it delivers: the runner builds the (frozen) message. */
export interface MessageInit {
  readonly id: string
  readonly text: string
  /** `relay` is delivered as a request, `notice` as background information that does not wake the agent. */
  readonly form: 'relay' | 'notice'
  readonly summary?: string
}
/** An entry of an agent's transcript. */
export interface RunnerEvent { readonly type: string; readonly seq: number; readonly time: number; readonly data: unknown }

/** The message of an `assistant/message`, `tool/result` or `user/message` event; undefined for every other event. */
export function messageOf(event: RunnerEvent): { role: string; content: readonly ContentBlock[] } | undefined {
  if (event.type === 'user/message') return event.data as RunnerMessage
  if (event.type === 'tool/result' || event.type === 'assistant/message') return (event.data as { message: RunnerMessage }).message
  return undefined
}
/** The text of the agent's last assistant message, or `''`. */
export function lastAssistantText(agent: Pick<AgentHandle, 'session'>): string {
  const last = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').at(-1)
  const message = last && messageOf(last)
  return message ? message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n').trim() : ''
}

/** An agent's session, whose identity changes when the agent is deleted and created again. */
export interface SessionRef {
  readonly id: string
  snapshotEvents(): readonly RunnerEvent[]
}
export interface Inbox {
  /** Messages for the next turn, and for the next step of the running turn. */
  readonly nextTurn: readonly RunnerMessage[]
  readonly nextStep: readonly RunnerMessage[]
  /** Takes a waiting message back out by its id; false when none waits. */
  remove(id: string): boolean
}

/** One running or idle agent: the object `AgentRunner.get`, `resolve` and `create` hand out, stable for the agent's life. */
export interface AgentHandle {
  readonly id: string
  readonly status: 'idle' | 'running'
  readonly session: SessionRef
  readonly inbox: Inbox
  /** Resolves once the current turn ended. */
  whenIdle(): Promise<void>
  /** Delivers into the running turn's next step, or starts a turn when idle. */
  steer(message: RunnerMessage): void
  /** Delivers to the next turn, which starts at once when idle. */
  followup(message: RunnerMessage): void
  /** Records the message in the transcript without waking the agent. */
  inject(message: RunnerMessage): void
}

export interface SpecOfAgent { readonly id: string; readonly cwd: string; readonly role: Role }

/** Events a runner reports; each subscription returns its release. */
export interface RunnerEvents {
  /** An agent was created or loaded. The runner waits for the listener, so the agent is bound before its first turn. */
  created(listener: (agent: AgentHandle) => void | Promise<void>): Unsubscribe
  disposed(listener: (agent: AgentHandle) => void): Unsubscribe
  /** A turn started (`running`) or ended (`idle`). */
  status(listener: (agent: AgentHandle, status: 'idle' | 'running') => void): Unsubscribe
  error(listener: (agent: AgentHandle, error: unknown) => void): Unsubscribe
  /** A step took a waiting message out of the inbox; the message may still be dropped before it reaches the transcript. */
  inboxClaimed(listener: (agent: AgentHandle, message: RunnerMessage) => void): Unsubscribe
  /** A user message entered a session's transcript. `session` is the object of `AgentHandle.session`. */
  userMessage(listener: (session: SessionRef, message: RunnerMessage) => void): Unsubscribe
  /** Any transcript event of a loaded agent's own session. */
  event(listener: (agent: AgentHandle, event: RunnerEvent) => void): Unsubscribe
}

/** The shell jobs an agent owns, as the Executor waits for and stops them. */
export interface Jobs {
  list(caller: string): readonly { id: string; owner?: string; status: string; label?: string }[]
  wait(id: string, timeoutMs: number, caller: string, signal?: AbortSignal): Promise<{ status: string }>
  kill(id: string, caller: string, reason?: string): unknown
  readonly events: { subscribe(filter: { owner: string }, listener: (event: { type: string }) => void): () => void }
}
/** The subagents an agent started. */
export interface Subagents {
  waitForChildren(parent: AgentHandle): Promise<boolean>
  listChildren(parentId: string): Promise<readonly { id: string }[]>
  drainChildren(parent: AgentHandle, childIds: readonly string[]): Promise<void>
}

export interface AgentRunner extends RunnerEvents {
  /** A loaded agent, or undefined. */
  get(id: string): AgentHandle | undefined
  /** The agent, loading it when it exists; undefined when there is none. Any other failure is thrown. */
  resolve(id: string): Promise<AgentHandle | undefined>
  /** Creates the agent in a workspace at `cwd`, for a role's preset, and returns it. */
  create(spec: SpecOfAgent): Promise<AgentHandle>
  rename(id: string, title: string): Promise<void>
  /** Cancels the running turn; the agent keeps what waits in its inbox when `keepInbox`. */
  cancel(agent: AgentHandle, options?: { keepInbox?: boolean }): void
  /** The id of the agent that started `agent` as a subagent. */
  parentId(agent: AgentHandle): string | undefined
  /** Builds a delivery message, frozen, under the runner's own source for messages of the engine. */
  message(init: MessageInit): RunnerMessage
  /** Registers prompts, tools and skills on `agent`, and limits its tools. */
  binder(agent: AgentHandle): Binder
  /** Whether the agent already has a model, from its first request or a selection. */
  hasModel(agent: AgentHandle): boolean
  /** Gives a new agent `selection` for its first request, leaving later manual selections intact. */
  seedModel(agent: AgentHandle, selection: ModelSelection): void
  /** Keeps `roleOf`'s agents on their role's preset when a user's selection would change it. */
  pinRoles(roleOf: (agentId: string) => Role | undefined): void
  /** The shell jobs and subagents the runner has, none when it has no such service. */
  jobs(): Jobs | undefined
  subagents(): Subagents | undefined
}

export interface PromptSection {
  readonly name: string
  readonly order: number
  /** Whether the text is final for the agent: no later section is added after it. */
  readonly complete?: boolean
  /** Renders the section; `bound` when the text goes into a model request (not a preview). */
  text(request: { bound: boolean }): string
}
export interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly schema: z.ZodType
  execute(args: never, signal: AbortSignal): Promise<unknown>
}
export interface SkillSpec {
  readonly name: string
  readonly description: string
  readonly content: string
  /** A directory the skill's relative files live in. */
  readonly directory?: string
}
/** The agent's skill registry, which a runner may recreate; see `Binder.registerSkill`. */
export interface SkillScope { register(skill: SkillSpec): () => void }

/** Everything the engine installs on one agent; each registration returns its release. */
export interface Binder {
  addPromptSection(section: PromptSection): () => void
  registerTool(tool: ToolSpec): () => void
  /** Limits the agent to `names` (those it has). Returns the release. */
  allowTools(names: readonly string[]): () => void
  /** Which of `names` the agent's profile provides, before any limit. */
  availableTools(names: readonly string[]): string[]
  /** A refusal reason in place of running a tool, or undefined to let it run. */
  guardTools(guard: () => string | undefined): () => void
  /**
   * Calls `bind` with the agent's skill scope as soon as it exists, and again whenever the runner recreates it empty. `ready`
   * resolves after the first call; `release` may be called before that.
   */
  registerSkill(bind: (scope: SkillScope) => void): { release: () => void; ready: Promise<void> }
  /** Lets the agent work without asking for permissions. */
  grantFullAccess(): void
}

export interface Logger {
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
  error(format: string, ...args: unknown[]): void
}
/** A limit that a host may change while the engine runs. */
export interface Volatile<T> { get(): T }
export type HttpRequest = IncomingMessage
export type HttpResponse = ServerResponse
export type HttpHandler = (req: HttpRequest, res: HttpResponse) => void | Promise<void>
/** What the engine uses of the process that hosts it. */
export interface HostPort {
  readonly logger: Logger
  /** The directory for the database, locks and worker shims. */
  readonly stateDir: string
  /** Limits that change in place without a restart. */
  readonly limits: { readonly promptMaxChars: Volatile<number>; readonly admissionContextMaxPages: Volatile<number>
    readonly admissionContextTimeoutMs: Volatile<number> }
  /** Rebuilds the engine, as after an account change. */
  restart(): void
  readonly http: {
    /** The loopback address the host serves. */
    readonly host: string
    readonly port: number
    /** Serves every path under `prefix`; returns the release. */
    mount(prefix: string, handler: HttpHandler): () => void
  }
}

export interface SubprocessReader { readFrom(offset: number): { readonly text: string } }
export interface SubprocessSpec {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly graceMs: number
  readonly signal: AbortSignal
  readonly env?: Record<string, string>
  readonly stdio: { readonly stdin: 'ignore'; readonly stdout: { readonly maxBytes: number }; readonly stderr: { readonly maxBytes: number } }
}
/** Runs a command with credential-shaped environment variables removed. */
export interface Subprocess {
  spawn(spec: SubprocessSpec): {
    readonly done: Promise<{ readonly exitCode: number | null }>
    readonly collected: { readonly stdout?: SubprocessReader; readonly stderr?: SubprocessReader }
  }
}

/** Persisted transcripts of agents, which outlive the agents' loaded state. */
export interface TranscriptStore {
  /** Waits until what the agents recorded so far is on disk. */
  flush(): Promise<void>
  /** Every user message recorded for a session, from disk. */
  readUserMessages(sessionId: string): Promise<RunnerMessage[]>
  /** The transcript of a session, loaded or not. */
  events(sessionId: string): Promise<readonly RunnerEvent[]>
}

export interface ModelInfo {
  /** Resolves a configured route through the live provider; throws for one that does not exist. */
  resolve(route: ModelRoute): Promise<ModelSelection>
  catalog(): Promise<ModelCatalog>
}

/** What `Sessions`, the Executor, the delivery code and the tools use of the agent side. */
export interface AgentPorts {
  readonly runner: AgentRunner
  readonly transcripts: TranscriptStore
  readonly models: ModelInfo
  readonly subprocess: Subprocess
  readonly logger: Logger
}

const known = new WeakSet<object>()
/** Marks `ports` as ports, which `isPorts` tells from a host's own context object. */
export function definePorts<T extends AgentPorts>(ports: T): T { known.add(ports); return ports }
export const isPorts = (value: unknown): value is AgentPorts => typeof value === 'object' && value !== null && known.has(value)
