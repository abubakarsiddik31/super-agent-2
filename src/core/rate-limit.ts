/**
 * The intake rate limits: how many listened Triggers the Engine takes in per window, before any model is called.
 *
 * A public repository or a busy chat can produce more messages than the host can assess, and every Trigger that reaches
 * Eval or a worker spends tokens. These limits are a host control, not a prompt: a flood is refused at Intake, the refusal
 * is stored with its reason, and the panel and the `intake` health entry count it. The numbers are deliberately generous
 * for a team and small enough that a scripted burst cannot drain a budget in one window.
 */
import type { Trigger } from './model.ts'

/** The limit that refused a Trigger. */
export type IntakeLimit = 'sender' | 'thread' | 'global'

/** What Intake asks before it takes a listened Trigger in. */
export interface IntakeLimits {
  /** The limit that refuses this Trigger, or undefined to take it in and count it against the window. */
  refuse(trigger: Trigger, threadKeys: readonly string[]): IntakeLimit | undefined
}

/** The window every limit counts over. */
export const INTAKE_WINDOW_MS = 60_000
/** Triggers one sender may enter per window. */
export const INTAKE_PER_SENDER = 20
/** Triggers one Thread may enter per window. */
export const INTAKE_PER_THREAD = 60
/** Triggers the whole host may enter per window: the circuit breaker. */
export const INTAKE_GLOBAL = 200

/** A sliding-window limiter over the last `window` of a clock. */
export function intakeLimits(now: () => number = Date.now, window = INTAKE_WINDOW_MS,
  limits: { sender: number; thread: number; global: number } = { sender: INTAKE_PER_SENDER, thread: INTAKE_PER_THREAD, global: INTAKE_GLOBAL }): IntakeLimits {
  const senders = new Map<string, number[]>()
  const threads = new Map<string, number[]>()
  let all: number[] = []
  const recent = (times: readonly number[], at: number): number[] => times.filter(time => at - time < window)
  /** Drops entries whose window passed, so a flood of distinct senders cannot grow the maps without bound. */
  const sweep = (map: Map<string, number[]>, at: number): void => {
    if (map.size < 10_000) return
    for (const [key, times] of map) if (!recent(times, at).length) map.delete(key)
  }
  return {
    refuse(trigger, threadKeys) {
      const at = now()
      all = recent(all, at)
      if (all.length >= limits.global) return 'global'
      const sender = `${trigger.source}:${trigger.actor.id}`
      const bySender = recent(senders.get(sender) ?? [], at)
      senders.set(sender, bySender)
      if (bySender.length >= limits.sender) return 'sender'
      for (const key of threadKeys) {
        const held = recent(threads.get(key) ?? [], at)
        threads.set(key, held)
        if (held.length >= limits.thread) return 'thread'
      }
      // Counted only when the Trigger is taken in, so a refused one does not extend the window that refused it.
      bySender.push(at)
      all.push(at)
      for (const key of threadKeys) threads.get(key)!.push(at)
      sweep(senders, at)
      sweep(threads, at)
      return undefined
    },
  }
}
