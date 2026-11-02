/** Idempotent message delivery to agents across Session restarts. */
import { portsOf, type PortSource } from '../runner/dsh/index.ts'
import type { AgentHandle, AgentRunner, RunnerMessage, SessionRef, TranscriptStore } from '../runner/port.ts'

type Seen = { ids: Set<string>; loaded?: Promise<void> }
/** The id of the message delivered under `requestId`, the same on every retry. */
export const messageId = (requestId: string): string => `dsh-superagent:${requestId}`
/** Extracts the idempotency key from current or legacy plugin message sources. */
function deliveryId(message: RunnerMessage): string | undefined {
  // Persisted sources may predate the current producer-specific source map.
  const source = message.source as { kind: string; plugin?: unknown; rpcId?: unknown }
  if (source.kind === 'dsh-superagent' || (source.kind === 'plugin' && source.plugin === 'dsh-superagent')) return message.id
  // Requests admitted by the former user RPC retain their original attribution.
  if (source.kind === 'user' && 'rpcId' in source && typeof source.rpcId === 'string') return messageId(source.rpcId)
}

/**
 * Delivers messages to agents at most once per request ID across active and restored Sessions.
 * Tracks delivered message IDs from live Session events, persisted history, and pending inboxes so retries from `Sessions` do not duplicate messages,
 * and marks delivered messages with `dsh-superagent`'s own source (`dsh-superagent`) rather than user RPCs so they are never mistaken for messages written by a person.
 */
export class AgentDelivery {
  private readonly seen = new WeakMap<SessionRef, Seen>()
  private readonly runner: AgentRunner
  private readonly transcripts: TranscriptStore
  /** @param source - the agent-side ports; a DSH context is accepted for hosts and tests that hand one over. */
  constructor(source: PortSource) {
    const { runner, transcripts } = portsOf(source)
    this.runner = runner; this.transcripts = transcripts
    runner.userMessage((session, message) => {
      const id = deliveryId(message)
      if (id) this.seen.get(session)?.ids.add(id)
    })
  }
  private async history(agent: AgentHandle): Promise<Seen> {
    let seen = this.seen.get(agent.session)
    if (!seen) { seen = { ids: new Set() }; this.seen.set(agent.session, seen) }
    const state = seen
    state.loaded ??= (async () => {
      await this.transcripts.flush()
      for (const message of await this.transcripts.readUserMessages(agent.id)) {
        const id = deliveryId(message)
        if (id) state.ids.add(id)
      }
    })().catch(error => { state.loaded = undefined; throw error })
    await state.loaded
    return state
  }
  async holds(agent: AgentHandle, requestId: string): Promise<boolean> {
    const id = messageId(requestId)
    return (await this.history(agent)).ids.has(id) || [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => deliveryId(message) === id)
  }
  /** Delivers once to the selected inbox, or injects into history without waking the agent, and flushes Session persistence before acknowledging the producer. */
  async send(agent: AgentHandle, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }, signal: AbortSignal, authorize?: () => void,
    accepted?: () => void): Promise<void> {
    signal.throwIfAborted()
    const seen = await this.history(agent)
    signal.throwIfAborted()
    if (this.runner.get(agent.id) !== agent) throw new Error('Delivery target was disposed')
    authorize?.()
    const id = messageId(requestId)
    const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => deliveryId(message) === id)
    if (!seen.ids.has(id) && !pending) {
      const message = this.runner.message(typeof mode === 'object' ? { id, text, form: 'notice', summary: mode.inject } : { id, text, form: 'relay' })
      if (typeof mode === 'object') { agent.inject(message); seen.ids.add(id) }
      else if (mode === 'steer') agent.steer(message)
      else agent.followup(message)
    }
    accepted?.()
    await this.transcripts.flush()
  }
}
