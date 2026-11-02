/** The runtime under the DeepSeek Harness: the host, the agent-side ports and the engine built from them. */
import type { Context } from '@deepseek-ai/cordis'
import { Runtime } from '../../app/runtime.ts'
import type { Machine } from '../../deployment.ts'
import { dshHost } from './host.ts'
import { dshPorts } from './ports.ts'

/**
 * Builds the engine for a harness context. The restart callback is the harness's own, so an account change rebuilds the
 * plugin; the caller registers the runtime on the context as the `orchestrator` service.
 */
export function dshRuntime(ctx: Context, machine: Machine, restart?: () => void): Runtime {
  const host = dshHost(ctx, machine, restart)
  return new Runtime(host, dshPorts(ctx), machine, host.restart)
}
