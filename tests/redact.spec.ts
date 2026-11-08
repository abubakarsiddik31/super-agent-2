/** `redactSecrets`: credential-shaped text that a command printed is replaced before it reaches a report, a relay or the panel. */
import { expect, it } from 'vitest'
import { redactSecrets, REDACTED_MAX_CHARS } from '../src/infra/redact.ts'

it('replaces a token while the cause around it stays readable', () => {
  const out = redactSecrets('fatal: authentication failed for ghp_FAKECANARYTOKEN1234567890abcd (HTTP 401)')
  expect(out).toBe('fatal: authentication failed for [redacted github token] (HTTP 401)')
})

it('replaces a provider key, a Slack token, an access key id and a JWT', () => {
  const out = redactSecrets(['sk-FAKECANARYKEY1234567890', 'xoxb-FAKE-CANARY-1234567890', 'AKIAFAKECANARY123456', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.c2lnbmF0dXJlLWNhbmFyeQ']
    .join(' '))
  for (const canary of ['sk-FAKE', 'xoxb-FAKE', 'AKIAFAKE', 'eyJhbGci']) expect(out).not.toContain(canary)
})

it('keeps a private key block\'s markers and drops its body', () => {
  const out = redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nFAKECANARYBODY\n-----END RSA PRIVATE KEY-----')
  expect(out).toContain('-----BEGIN RSA PRIVATE KEY-----')
  expect(out).toContain('-----END RSA PRIVATE KEY-----')
  expect(out).not.toContain('FAKECANARYBODY')
})

it('replaces an authorization header and a name=value secret', () => {
  const out = redactSecrets('curl -H "Authorization: Bearer FAKECANARYBEARER123" --data "token=FAKECANARYVALUE"')
  expect(out).not.toContain('FAKECANARYBEARER123')
  expect(out).not.toContain('FAKECANARYVALUE')
  expect(out).toContain('Authorization: Bearer [redacted]')
  expect(out).toContain('token=[redacted]')
})

it('caps output, so one runaway command cannot fill the router\'s context', () => {
  const out = redactSecrets('x'.repeat(REDACTED_MAX_CHARS + 500))
  expect(out).toHaveLength(REDACTED_MAX_CHARS + 1)
  expect(out.endsWith('…')).toBe(true)
})
