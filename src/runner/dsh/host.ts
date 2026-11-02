/** `HostPort` over the DSH plugin context: its logger, effects, Web server and fiber. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { Machine } from '../../deployment.ts'
import type { HostPort } from '../port.ts'
import { dshLogger } from './ports.ts'

/**
 * Asks DSH to generate no settings page: the management panel provides its own settings UI. Call once when the plugin loads.
 */
export function configureDshSettings(ctx: Context): void {
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
}

/**
 * Volatile limits update in place without a restart; account changes restart dsh-superagent. DSH's settings service stops
 * serving this entry while dsh-superagent restarts and rereads it only on a configuration write, so trigger `describe()`
 * after restart to keep open configuration forms editable without a page reload.
 * TODO: drop the read once DSH's settings service rereads an entry whose plugin becomes active again.
 */
export function dshRestart(ctx: Context): () => void {
  return () => {
    ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() }).catch((error: unknown) => { ctx.logger.error('dsh-superagent restart failed: %s', String(error)) })
  }
}

export function dshHost(ctx: Context, machine: Machine, restart: () => void = dshRestart(ctx)): HostPort {
  return {
    logger: dshLogger(ctx),
    stateDir: machine.stateDir,
    limits: machine,
    restart,
    http: {
      get host() { return ctx.webServer.host },
      get port() { return ctx.webServer.port },
      mount: (prefix, handler) => ctx.webServer.register({ kind: 'prefix', path: prefix, handler: handler as never }),
    },
  }
}
