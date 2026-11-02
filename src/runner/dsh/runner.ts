/** `AgentRunner` over the DeepSeek Harness: the agents are DSH `Agent`s, which are the handles, and the events are Cordis events. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection as DshModelSelection } from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId, type ContextFormed } from '@deepseek-ai/dsh-llm'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import { z } from 'zod'
import type { AgentHandle, AgentRunner, Binder, Jobs, ModelSelection, Role, Subagents } from '../port.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-superagent': { kind: 'dsh-superagent' } & ContextFormed
  }
}
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** DSH's agent preset registry selected `agentPreset` for a Session. */
    'agent-preset/selected'(sessionId: string, agentPreset: string): void
  }
}

/** The agent presets Executor Sessions and the main Session are created with, which the bundle's patch defines. */
export const WORKER_PRESET = 'dsh-superagent-worker', ROUTER_PRESET = 'dsh-superagent-router'
const presetOf = (role: Role): string => role === 'worker' ? WORKER_PRESET : ROUTER_PRESET

const handle = (agent: Agent): AgentHandle => agent as unknown as AgentHandle
const dsh = (agent: AgentHandle): Agent => agent as unknown as Agent

/** The DSH implementation of `AgentRunner`, reading the context's services at each call. */
export class DshRunner implements AgentRunner {
  constructor(private readonly ctx: Context) {}
  get(id: string): AgentHandle | undefined {
    const agent = this.ctx.agents.get(id as SessionId)
    return agent && handle(agent)
  }
  async resolve(id: string): Promise<AgentHandle | undefined> {
    const result = await this.ctx.sessionController.resolveAgent(id as SessionId)
    if ('error' in result) {
      if (result.error.code === 'session/not-found') return undefined
      throw result.error
    }
    return handle(result.agent)
  }
  async create({ id, cwd, role }: { id: string; cwd: string; role: Role }): Promise<AgentHandle> {
    const workspace = await this.ctx.workspaceRegistry.create(cwd)
    // A Session keeps the preset it was created with, one of the bundle's own (cordis.patch.yml).
    await this.ctx.sessionController.create({ sessionId: id as SessionId, workspaceId: workspace.id, agentPreset: presetOf(role) })
    const result = await this.ctx.sessionController.resolveAgent(id as SessionId)
    if ('error' in result) throw result.error
    return handle(result.agent)
  }
  async rename(id: string, title: string): Promise<void> { await this.ctx.sessionController.rename({ sessionId: id as SessionId, title }) }
  cancel(agent: AgentHandle, options?: { keepInbox?: boolean }): void { dsh(agent).cancel({ kind: 'user' }, { keepInbox: options?.keepInbox ?? false }) }
  parentId(agent: AgentHandle): string | undefined { return dsh(agent).session.header.parentSession }
  message(init: Parameters<AgentRunner['message']>[0]) {
    const source = init.form === 'notice' ? { kind: 'dsh-superagent' as const, form: 'notice' as const, summary: init.summary ?? '' }
      : { kind: 'dsh-superagent' as const, form: 'relay' as const }
    return freezeMessage({ id: MessageId(init.id), role: 'user' as const, content: [{ type: 'text' as const, text: init.text }], source })
  }
  binder(agent: AgentHandle): Binder { return new DshBinder(this.ctx, dsh(agent)) }
  hasModel(agent: AgentHandle): boolean {
    const { session } = dsh(agent)
    return !!session.requestHeader() || session.snapshotEvents().some(event => event.type === 'model/selection')
  }
  /** Gives the Session `selection` for its first request without selectModel, which would mutate the global DSH default. */
  seedModel(handled: AgentHandle, selection: ModelSelection): void {
    const agent = dsh(handled), ctx = this.ctx
    const selected = selection as DshModelSelection
    agent.session.append('model/selection', selected)
    let initial = true
    let assembled: DshModelSelection | undefined
    agent.ctx.effect(() => {
      const disposers = [
        agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
          const chosen = initial ? selected : undefined
          const result = await next()
          assembled = chosen
          return chosen ? { ...result, variables: { ...result.variables, provider: chosen.provider, model: chosen.model } } : result
        }, { prepend: true }),
        agent.ctx.on('agent/request', async (_payload, next) => {
          const result = await next()
          if (!assembled) return result
          const { reasoningEffort: _inherited, ...rest } = result
          return { ...rest, ...assembled }
        }, { prepend: true }),
        ctx.on('session/event', (session, event) => {
          if (session === agent.session && (event.type === 'request/header' || event.type === 'model/selection')) initial = false
        }),
      ]
      return () => disposers.forEach(dispose => dispose())
    })
  }
  /** Opening a Session in DSH's Web UI before its first turn may select the default preset for it: select ours again. After its first turn DSH refuses any selection, which leaves it as it is. */
  pinRoles(roleOf: (agentId: string) => Role | undefined): void {
    const ctx = this.ctx
    ctx.inject(['agentPresets'], child => {
      child.on('agent-preset/selected', (sessionId, preset) => {
        const role = roleOf(sessionId), agent = ctx.agents.get(sessionId as SessionId)
        const ours = role && presetOf(role)
        if (!ours || preset === ours || !agent) return
        const presets = child.get('agentPresets') as { select(agent: Agent, preset: string): Promise<string> }
        presets.select(agent, ours).catch(() => {})
      })
    })
  }
  jobs(): Jobs | undefined { return this.ctx.get('jobs') as Jobs | undefined }
  subagents(): Subagents | undefined { return this.ctx.get('subagents') as Subagents | undefined }

  created(listener: (agent: AgentHandle) => void | Promise<void>) {
    return this.ctx.on('agent/created', async ({ agent }) => { await listener(handle(agent)); return undefined })
  }
  disposed(listener: (agent: AgentHandle) => void) { return this.ctx.on('agent/disposed', ({ agent }) => { listener(handle(agent)) }) }
  status(listener: (agent: AgentHandle, status: 'idle' | 'running') => void) {
    return this.ctx.on('agent/status', ({ agent, status }) => { listener(handle(agent), status as 'idle' | 'running') })
  }
  error(listener: (agent: AgentHandle, error: unknown) => void) { return this.ctx.on('agent/error', ({ agent, error }) => { listener(handle(agent), error) }) }
  inboxClaimed(listener: Parameters<AgentRunner['inboxClaimed']>[0]) {
    return this.ctx.on('agent/inbox/claimed', ({ agent, message }) => { listener(handle(agent), message) })
  }
  userMessage(listener: Parameters<AgentRunner['userMessage']>[0]) {
    return this.ctx.on('session/event', (session, event) => { if (event.type === 'user/message') listener(session, event.data) })
  }
  event(listener: Parameters<AgentRunner['event']>[0]) {
    return this.ctx.on('session/event', (session, event) => {
      const agent = this.ctx.agents.get(session.id)
      if (agent && agent.session === session) listener(handle(agent), event)
    })
  }
}

/** What a Session's tools return, rendered as JSON text, with `output.image` attached as an image when present. */
const render = (_args: unknown, value: unknown) => {
  const text = { type: 'text' as const, text: JSON.stringify(value) }
  const image = value && typeof value === 'object' && 'image' in value ? (value as { image: never }).image : undefined
  return image ? [text, { type: 'image' as const, attachment: image }] : [text]
}

/** What `DshRunner` installs on one DSH agent, through the agent's own context. */
class DshBinder implements Binder {
  constructor(private readonly ctx: Context, private readonly agent: Agent) {}
  addPromptSection(section: Parameters<Binder['addPromptSection']>[0]) {
    // Disable variable interpolation so literal ${{ ... }} expressions in team prompts are preserved.
    return this.agent.ctx.systemPrompt.section({ name: section.name, order: section.order, interpolate: false,
      text: context => section.text({ bound: context.signal !== undefined }), ...(section.complete ? { complete: true } : {}) })
  }
  registerTool({ name, description, schema, execute }: Parameters<Binder['registerTool']>[0]) {
    return this.agent.ctx.tools.register({ name, description, parameters: z.toJSONSchema(schema),
      output: { schema: { type: 'object', additionalProperties: true }, render },
      execute: (args, execution) => execute(schema.parse(args) as never, execution.signal) })
  }
  allowTools(names: readonly string[]) { return this.agent.ctx.tools.restrict({ allow: [...names] }) }
  /**
   * Read inherited tools through the parent scope, which includes the preset's tools. The global view misses preset tools; the
   * agent's own view also includes local tools such as subagent, which restrict refuses to name.
   */
  availableTools(names: readonly string[]) {
    const parent = scopeParentOf(this.agent)
    return names.filter(name => this.agent.ctx.tools.get(name, parent))
  }
  guardTools(guard: () => string | undefined) { return this.agent.ctx.tools.guard(guard) }
  registerSkill(bind: Parameters<Binder['registerSkill']>[0]) {
    const scoped = this.agent.ctx.inject(['skills'], scope => {
      bind({ register: skill => scope.skills.register({ name: skill.name, description: skill.description, content: skill.content, source: 'runtime',
        ...(skill.directory ? { resourceBase: { kind: 'directory' as const, path: skill.directory } } : {}) }) })
    })
    return { ready: Promise.resolve(scoped).then(() => {}),
      release: () => { scoped.dispose().catch((error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release a skill scope: %s', String(error)) }) } }
  }
  grantFullAccess(): void { this.ctx.permissionPresets.set(this.agent.session, 'danger-full-access') }
}
