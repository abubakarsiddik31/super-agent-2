/**
 * The bearer token of the management API, kept in the state directory and readable only by the operator's OS user.
 * Workers run as that same user until they are isolated, so this stops other users, web pages and an agent that merely knows
 * the API; it is not a boundary against a worker that can read the state directory.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const PANEL_TOKEN_FILE = 'panel-token'
/** Returns the state directory's token, creating it on first start. */
export function panelToken(stateDir: string): string {
  const file = join(stateDir, PANEL_TOKEN_FILE)
  try { writeFileSync(file, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  return readFileSync(file, 'utf8').trim()
}
const digest = (text: string): Buffer => createHash('sha256').update(text).digest()
/** Compares an `authorization` header with the token in constant time. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  return !!token && timingSafeEqual(digest(header ?? ''), digest(`Bearer ${token}`))
}
