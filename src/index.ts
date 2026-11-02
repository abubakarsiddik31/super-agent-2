/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
import type { Context } from '@deepseek-ai/cordis'
import { Runtime } from './app/runtime.ts'
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'
import { configureDshSettings, dshHost } from './runner/dsh/index.ts'

export const name = 'dsh-superagent'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const machine = machineOf(config)
  // The management panel provides its own settings UI, so DSH generates none. Volatile limits update in place without a
  // restart; account changes restart dsh-superagent through the host.
  configureDshSettings(ctx)
  const host = dshHost(ctx, machine)
  const runtime = new Runtime(ctx, machine, host.restart)
  host.onStop(async () => { await runtime.stop() })
  await runtime.ready
  host.logger.info(runtime.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel' : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'
