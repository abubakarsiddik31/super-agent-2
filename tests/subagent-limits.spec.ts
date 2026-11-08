/**
 * What a subagent is allowed when the host cannot tell which ticket it belongs to: nothing. A subagent inherits its worker's
 * work tools only when its ancestry resolves to a live ticket within the depth cap; a chain deeper than that, or a parent that
 * is not loaded, fails closed instead of keeping the preset's full tools (SEC-10).
 */
import { expect, it } from 'vitest'
import { Sessions } from '../src/app/sessions.ts'
import { recordingPorts } from './fixtures/ports.ts'

/** A `Sessions` over recording ports, with one ticket `t1` and the given subagent parent links. */
function sessions(parents: Record<string, string>) {
  const { ports, binderOf } = recordingPorts(['read', 'bash'], parents)
  const settings = { eval: { model: null }, executor: { model: null } }
  const session = new Sessions({ ports, masterId: 'master', lifetime: new AbortController().signal, closing: () => false, environment: () => [],
    tools: () => [], store: { tickets: { get: (id: string) => id === 't1' ? { id } : undefined }, settings: () => settings, get: () => undefined, set: () => {},
      keys: () => [] }, prompts: { current: () => ({ revision: 1, config: { skills: {} } }), version: () => ({}), compose: () => '', skills: () => [] },
    effects: { enqueue: () => {}, handle: () => {}, idle: async () => {}, pending: () => false }, health: { set: () => {} } } as never)
  return { session, binderOf }
}

it('gives a subagent of a live worker the work tools its profile has', async () => {
  const { session, binderOf } = sessions({ sub1: 'worker-t1' })
  await session.ensure('worker-t1', '/work', 'ticket', 'worker')
  await session.ensure('sub1', '/work', 'subagent', 'worker')
  expect(binderOf('sub1').allowTools.mock.calls).toEqual([[['read', 'bash']]])
})

it('gives a subagent nine levels below a worker no tools, because the depth cap fails closed', async () => {
  // worker-t1 ← sub1 ← sub2 ← ... ← sub9: the worker is nine hops above sub9, past the cap of eight.
  const parents: Record<string, string> = { sub1: 'worker-t1' }
  for (let level = 2; level <= 9; level++) parents[`sub${level}`] = `sub${level - 1}`
  const { session, binderOf } = sessions(parents)
  await session.ensure('worker-t1', '/work', 'ticket', 'worker')
  for (let level = 1; level <= 9; level++) await session.ensure(`sub${level}`, '/work', 'subagent', 'worker')
  expect(binderOf('sub9').allowTools.mock.calls).toEqual([[[]]])
  expect(binderOf('sub9').guardTools).toHaveBeenCalledOnce()
})

it('gives a subagent whose parent is not loaded no tools', async () => {
  const { session, binderOf } = sessions({ sub1: 'gone' })
  await session.ensure('sub1', '/work', 'subagent', 'worker')
  expect(binderOf('sub1').allowTools.mock.calls).toEqual([[[]]])
  expect(binderOf('sub1').guardTools).toHaveBeenCalledOnce()
})

it('leaves an agent with no parent alone, since a person may open a Session of their own', async () => {
  const { session, binderOf } = sessions({})
  await session.ensure('person-1', '/home', 'my session', 'worker')
  expect(binderOf('person-1').allowTools).not.toHaveBeenCalled()
})
