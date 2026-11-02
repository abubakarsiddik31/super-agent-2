/** Seeds per-role default models on newly created sessions without mutating the global host default. */
import { portsOf, type PortSource } from '../runner/dsh/index.ts'
import type { AgentHandle } from '../runner/port.ts'
import type { RoleModel } from '../policy.ts'

/** Seed a role's configured model onto a brand-new session before its first request, leaving later manual or durable selections intact. */
export async function initializeRoleModel(source: PortSource, agent: AgentHandle, model: RoleModel | null): Promise<void> {
  if (!model) return
  const { runner, models, transcripts } = portsOf(source)
  if (runner.hasModel(agent)) return
  // Resolve a configured route through the live provider; catalog membership is not a restriction.
  runner.seedModel(agent, await models.resolve(model))
  await transcripts.flush()
}
