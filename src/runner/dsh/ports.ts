/** The agent-side ports over a DSH Cordis context. Services are read at each call: a context may provide them later or replace them. */
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subprocess'
import { definePorts, type AgentPorts, type Logger, type ModelInfo, type RunnerMessage, type Subprocess, type TranscriptStore } from '../port.ts'
import { DshRunner } from './runner.ts'

export const dshLogger = (ctx: Context): Logger => ({
  info: (format, ...args) => { ctx.logger.info(format, ...args) },
  warn: (format, ...args) => { ctx.logger.warn(format, ...args) },
  error: (format, ...args) => { ctx.logger.error(format, ...args) },
})

const subprocess = (ctx: Context): Subprocess => ({ spawn: spec => ctx.subprocess.spawn(spec as never) as ReturnType<Subprocess['spawn']> })

const transcripts = (ctx: Context): TranscriptStore => ({
  flush: () => ctx.sessionPersistence.flush(),
  async readUserMessages(sessionId) {
    const messages: RunnerMessage[] = []
    await using handle = await ctx.sessionPersistence.open(sessionId as SessionId, 'read')
    for (let offset = 0; ; ) {
      const { events } = await handle.read(offset, 512)
      if (!events.length) break
      for (const event of events) if (event.type === 'user/message') messages.push(event.data)
      offset += events.length
    }
    return messages
  },
  async events(sessionId) { return (await ctx.sessionController.inspect(sessionId as SessionId)).events },
})

/** Resolves a configured route through the live provider; catalog membership is not a restriction. */
const models = (ctx: Context): ModelInfo => ({
  async resolve(route) {
    const value = await ctx.llm.resolveCallConfig({ provider: route.provider, model: route.model,
      ...(route.reasoningEffort ? { reasoningEffort: ReasoningEffortId(route.reasoningEffort) } : {}) })
    return { provider: value.provider, model: value.model, ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) }
  },
  catalog: () => ctx.sessionController.modelCatalog() as ReturnType<ModelInfo['catalog']>,
})

const cache = new WeakMap<object, AgentPorts>()
/** The agent-side ports over `ctx`, the same ones on every call. */
export function dshPorts(ctx: Context): AgentPorts {
  let ports = cache.get(ctx)
  if (!ports) {
    ports = definePorts({ runner: new DshRunner(ctx), transcripts: transcripts(ctx), models: models(ctx), subprocess: subprocess(ctx), logger: dshLogger(ctx) })
    cache.set(ctx, ports)
  }
  return ports
}
