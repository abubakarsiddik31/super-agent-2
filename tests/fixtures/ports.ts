/** Agent-side ports whose binders only record what `Sessions` asks of them, for tests of what a session is allowed to do. */
import { vi, type Mock } from 'vitest'
import { definePorts, type AgentHandle, type AgentPorts, type Binder } from '../../src/runner/port.ts'

/** A binder per agent id, each recording its tool limits and access; `available` is what the profile provides to a worker. */
export type RecordingBinder = { [K in keyof Binder]: Mock }
export function recordingPorts(available: readonly string[] = ['read', 'bash']): { ports: AgentPorts; binderOf: (id: string) => RecordingBinder; create: Mock } {
  const binders = new Map<string, RecordingBinder>()
  const binderOf = (id: string) => {
    let binder = binders.get(id)
    if (!binder) {
      binder = { addPromptSection: vi.fn(() => () => {}), registerTool: vi.fn(() => () => {}), allowTools: vi.fn(() => () => {}),
        availableTools: vi.fn((names: readonly string[]) => names.filter(name => available.includes(name))), guardTools: vi.fn(() => () => {}),
        registerSkill: vi.fn(() => ({ release: () => {}, ready: Promise.resolve() })), grantFullAccess: vi.fn() }
      binders.set(id, binder)
    }
    return binder
  }
  const create = vi.fn(async ({ id }: { id: string }) => ({ id, status: 'idle', session: { id, snapshotEvents: () => [] },
    inbox: { nextTurn: [], nextStep: [], remove: () => false } }) as unknown as AgentHandle)
  const noop = () => () => {}
  const ports = definePorts({
    runner: { get: () => undefined, resolve: async () => undefined, create, rename: async () => {}, binder: (agent: AgentHandle) => binderOf(agent.id) as unknown as Binder,
      hasModel: () => false, seedModel: () => {}, created: noop, disposed: noop, status: noop, error: noop, inboxClaimed: noop, userMessage: noop, event: noop,
      pinRoles: () => {} } as never,
    transcripts: { flush: async () => {}, readUserMessages: async () => [], events: async () => [] },
    models: { resolve: async route => route, catalog: async () => ({}) as never },
    subprocess: { spawn: () => { throw new Error('unused') } },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } satisfies AgentPorts)
  return { ports, binderOf, create }
}
