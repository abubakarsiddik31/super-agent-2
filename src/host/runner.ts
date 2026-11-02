/**
 * A runner for a host that has no agent CLI behind it yet.
 *
 * The plain Node host boots the engine, serves the management panel and runs the Sources without any coding-agent CLI. It
 * has no agent to create, so every call that would need one fails with a message that says so. The panel shows the failure
 * as the health of the agent side, and the ticket that needed it fails visibly rather than waiting forever.
 *
 * A CLI runner replaces this one; see `docs/spikes/001-cli-runners.md`.
 */
import type { AgentHandle, AgentRunner, Binder, Jobs, ModelSelection, RunnerMessage, Subagents } from '../runner/port.ts'

/** The message every operation that needs an agent fails with, so the reason is in the panel and in the health. */
export const NO_AGENT_CLI = 'No agent CLI is configured for this installation yet; see docs/spikes/001-cli-runners.md'

/** The runner of a host with no agent CLI behind it. */
export class EmptyRunner implements AgentRunner {
  get(_id: string): AgentHandle | undefined { return undefined }
  async resolve(_id: string): Promise<AgentHandle | undefined> { return undefined }
  async create(): Promise<AgentHandle> { throw new Error(NO_AGENT_CLI) }
  async rename(_id: string, _title: string): Promise<void> { /* No agent to rename. */ }
  cancel(_agent: AgentHandle): void { /* No agent to cancel. */ }
  parentId(_agent: AgentHandle): string | undefined { return undefined }
  message(init: { id: string; text: string; form: 'relay' | 'notice'; summary?: string }): RunnerMessage {
    return { id: init.id, role: 'user', content: [{ type: 'text', text: init.text }],
      source: init.form === 'notice' ? { kind: 'dsh-superagent', form: 'notice' } : { kind: 'dsh-superagent', form: 'relay' } } as RunnerMessage
  }
  binder(_agent: AgentHandle): Binder { throw new Error(NO_AGENT_CLI) }
  hasModel(_agent: AgentHandle): boolean { return false }
  seedModel(_agent: AgentHandle, _selection: ModelSelection): void { /* No agent to seed. */ }
  pinRoles(_roleOf: (agentId: string) => 'orchestrator' | 'worker' | undefined): void { /* No agent to pin. */ }
  jobs(): Jobs | undefined { return undefined }
  subagents(): Subagents | undefined { return undefined }
  created(_listener: (agent: AgentHandle) => void | Promise<void>): () => void { return () => {} }
  disposed(_listener: (agent: AgentHandle) => void): () => void { return () => {} }
  status(_listener: (agent: AgentHandle, status: 'idle' | 'running') => void): () => void { return () => {} }
  error(_listener: (agent: AgentHandle, error: unknown) => void): () => void { return () => {} }
  inboxClaimed(_listener: (agent: AgentHandle, message: RunnerMessage) => void): () => void { return () => {} }
  userMessage(_listener: (session: never, message: RunnerMessage) => void): () => void { return () => {} }
  event(_listener: (agent: AgentHandle, event: never) => void): () => void { return () => {} }
}
