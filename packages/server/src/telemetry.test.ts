import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { nodesBucket, TelemetryClient, type TelemetryProps } from './telemetry.js'

function makeConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sc-telemetry-'))
  return join(dir, 'config.json')
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function readConfigFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// nodesBucket boundaries
// ---------------------------------------------------------------------------

test.each([
  [0, '0'],
  [1, '1-10'],
  [10, '1-10'],
  [11, '11-50'],
  [50, '11-50'],
  [51, '51-200'],
  [200, '51-200'],
  [201, '200+'],
])('nodesBucket(%i) === %s', (n, expected) => {
  expect(nodesBucket(n as number)).toBe(expected)
})

// ---------------------------------------------------------------------------
// Consent state machine
// ---------------------------------------------------------------------------

test('getConsent(): no config file → unset', () => {
  const client = new TelemetryClient({ configPath: makeConfigPath(), appVersion: '0.1.0', env: {} })
  expect(client.getConsent()).toBe('unset')
})

test('getConsent(): corrupt config file → unset, no throw', () => {
  const configPath = makeConfigPath()
  writeFileSync(configPath, '{ not valid json')
  const client = new TelemetryClient({ configPath, appVersion: '0.1.0', env: {} })
  expect(() => client.getConsent()).not.toThrow()
  expect(client.getConsent()).toBe('unset')
})

test('getConsent(): reads granted/denied straight from config file', () => {
  const configPath = makeConfigPath()
  writeFileSync(configPath, JSON.stringify({ telemetry: { consent: 'granted' } }))
  expect(new TelemetryClient({ configPath, appVersion: '0.1.0', env: {} }).getConsent()).toBe('granted')

  writeFileSync(configPath, JSON.stringify({ telemetry: { consent: 'denied' } }))
  expect(new TelemetryClient({ configPath, appVersion: '0.1.0', env: {} }).getConsent()).toBe('denied')
})

test('getConsent(): DO_NOT_TRACK=1 forces disabled_env even over a granted config', () => {
  const configPath = makeConfigPath()
  writeFileSync(configPath, JSON.stringify({ telemetry: { consent: 'granted', anonId: 'x' } }))
  const client = new TelemetryClient({
    configPath, appVersion: '0.1.0', env: { DO_NOT_TRACK: '1' },
  })
  expect(client.getConsent()).toBe('disabled_env')
})

test('getConsent(): STACKCANVAS_TELEMETRY=0 forces disabled_env', () => {
  const configPath = makeConfigPath()
  writeFileSync(configPath, JSON.stringify({ telemetry: { consent: 'granted', anonId: 'x' } }))
  const client = new TelemetryClient({
    configPath, appVersion: '0.1.0', env: { STACKCANVAS_TELEMETRY: '0' },
  })
  expect(client.getConsent()).toBe('disabled_env')
})

test('getConsent(): STACKCANVAS_TELEMETRY=1 alone does not grant consent', () => {
  const client = new TelemetryClient({
    configPath: makeConfigPath(), appVersion: '0.1.0', env: { STACKCANVAS_TELEMETRY: '1' },
  })
  expect(client.getConsent()).toBe('unset')
})

// ---------------------------------------------------------------------------
// setConsent: anonId lifecycle + install dedupe
// ---------------------------------------------------------------------------

test('setConsent(true): mints a uuid anonId and persists granted', () => {
  const configPath = makeConfigPath()
  const client = new TelemetryClient({ configPath, appVersion: '0.1.0', env: {} })
  client.setConsent(true)
  expect(client.getConsent()).toBe('granted')
  const cfg = readConfigFile(configPath)
  const telemetry = cfg.telemetry as { anonId: string; consent: string }
  expect(telemetry.consent).toBe('granted')
  expect(telemetry.anonId).toMatch(UUID_RE)
})

test('setConsent(false): deletes anonId and persists denied', () => {
  const configPath = makeConfigPath()
  const client = new TelemetryClient({ configPath, appVersion: '0.1.0', env: {} })
  client.setConsent(true)
  client.setConsent(false)
  expect(client.getConsent()).toBe('denied')
  const cfg = readConfigFile(configPath)
  const telemetry = cfg.telemetry as { anonId?: string; consent: string }
  expect(telemetry.consent).toBe('denied')
  expect(telemetry.anonId).toBeUndefined()
})

test('install is emitted exactly once across grant → deny → grant', () => {
  const configPath = makeConfigPath()
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
  const client = new TelemetryClient({ configPath, appVersion: '0.1.0', env: {}, fetchImpl })

  client.setConsent(true)
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  const firstBody = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)) as { payload: TelemetryProps }
  expect(firstBody.payload).toEqual({ event: 'install' })

  client.setConsent(false)
  expect(fetchImpl).toHaveBeenCalledTimes(1)

  client.setConsent(true)
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

// ---------------------------------------------------------------------------
// emit(): consent gating
// ---------------------------------------------------------------------------

test('emit(): no-op when consent is unset', () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
  const client = new TelemetryClient({ configPath: makeConfigPath(), appVersion: '0.1.0', env: {}, fetchImpl })
  client.emit({ event: 'canvas_opened', nodes_bucket: '1-10', tf_bin: 'terraform' })
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('emit(): no-op when consent is denied', () => {
  const configPath = makeConfigPath()
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
  const client = new TelemetryClient({ configPath, appVersion: '0.1.0', env: {}, fetchImpl })
  client.setConsent(true)
  fetchImpl.mockClear()
  client.setConsent(false)
  client.emit({ event: 'canvas_opened', nodes_bucket: '1-10', tf_bin: 'terraform' })
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('emit(): no-op when disabled via DO_NOT_TRACK regardless of granted config', () => {
  const configPath = makeConfigPath()
  writeFileSync(configPath, JSON.stringify({ telemetry: { consent: 'granted', anonId: 'x' } }))
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
  const client = new TelemetryClient({
    configPath, appVersion: '0.1.0', env: { DO_NOT_TRACK: '1' }, fetchImpl,
  })
  client.emit({ event: 'canvas_opened', nodes_bucket: '1-10', tf_bin: 'terraform' })
  expect(fetchImpl).not.toHaveBeenCalled()
})

// ---------------------------------------------------------------------------
// Zero network: default transport never touches the real network
// ---------------------------------------------------------------------------

test('default transport never calls the real fetch (DARK: zero network calls)', () => {
  const realFetchSpy = vi.spyOn(globalThis, 'fetch')
  const client = new TelemetryClient({ configPath: makeConfigPath(), appVersion: '0.1.0', env: {} })
  client.setConsent(true) // emits 'install' internally
  client.emit({ event: 'canvas_opened', nodes_bucket: '1-10', tf_bin: 'terraform' })
  expect(realFetchSpy).not.toHaveBeenCalled()
  realFetchSpy.mockRestore()
})

// ---------------------------------------------------------------------------
// emit(): envelope shape via injected fetchImpl
// ---------------------------------------------------------------------------

test('emit(): injected fetchImpl receives correct URL, POST body, and abort signal', () => {
  const configPath = makeConfigPath()
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
  const client = new TelemetryClient({
    configPath, appVersion: '0.9.9', env: {}, fetchImpl, endpoint: 'https://t.stackcanvas.dev/e',
  })
  client.setConsent(true)
  fetchImpl.mockClear()

  client.emit({ event: 'canvas_opened', nodes_bucket: '11-50', tf_bin: 'tofu' })

  expect(fetchImpl).toHaveBeenCalledTimes(1)
  const [url, init] = fetchImpl.mock.calls[0]!
  expect(url).toBe('https://t.stackcanvas.dev/e')
  expect(init!.method).toBe('POST')
  expect(init!.signal).toBeInstanceOf(AbortSignal)

  const envelope = JSON.parse(String(init!.body)) as {
    schema: number; anon_id: string; day: string; app_version: string
    platform: string; node_major: number; payload: TelemetryProps
  }
  expect(envelope.schema).toBe(1)
  expect(envelope.anon_id).toMatch(UUID_RE)
  expect(envelope.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(envelope.app_version).toBe('0.9.9')
  expect(['darwin', 'linux', 'win32', 'other']).toContain(envelope.platform)
  expect(envelope.node_major).toBeGreaterThanOrEqual(18)
  expect(envelope.payload).toEqual({ event: 'canvas_opened', nodes_bucket: '11-50', tf_bin: 'tofu' })
})

// ---------------------------------------------------------------------------
// intent_sent per-kind counts + capping at 50
// ---------------------------------------------------------------------------

test('emit(): intent_sent counts are capped at 50 and floored at 0 per counter', () => {
  const configPath = makeConfigPath()
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
  const client = new TelemetryClient({ configPath, appVersion: '0.1.0', env: {}, fetchImpl })
  client.setConsent(true)
  fetchImpl.mockClear()

  client.emit({ event: 'intent_sent', add: 999, modify: -5, remove: 50, adopt: 51, investigate: 0 })

  const [, init] = fetchImpl.mock.calls[0]!
  const envelope = JSON.parse(String(init!.body)) as { payload: TelemetryProps }
  expect(envelope.payload).toEqual({
    event: 'intent_sent', add: 50, modify: 0, remove: 50, adopt: 50, investigate: 0,
  })
})

// ---------------------------------------------------------------------------
// Envelope allowlist tripwire — the single most important test in this file.
// This list is a hardcoded literal, NOT imported from telemetry.ts, so a
// future field added to the source without a matching TELEMETRY.md update
// fails this test.
// ---------------------------------------------------------------------------

const ALLOWED_ENVELOPE_KEYS = [
  'schema', 'anon_id', 'day', 'app_version', 'platform', 'node_major', 'payload',
].sort()

const ALLOWED_PAYLOAD_KEYS: Record<string, string[]> = {
  install: ['event'],
  canvas_opened: ['event', 'nodes_bucket', 'tf_bin'],
  intent_sent: ['event', 'add', 'modify', 'remove', 'adopt', 'investigate'],
  scan_run: ['event', 'provider', 'nodes_bucket'],
  drift_opened: ['event', 'nodes_bucket'],
}

const ALL_EVENT_PROPS: TelemetryProps[] = [
  { event: 'install' },
  { event: 'canvas_opened', nodes_bucket: '1-10', tf_bin: 'terraform' },
  { event: 'intent_sent', add: 1, modify: 2, remove: 3, adopt: 4, investigate: 5 },
  { event: 'scan_run', provider: 'aws', nodes_bucket: '11-50' },
  { event: 'drift_opened', nodes_bucket: '0' },
]

test.each(ALL_EVENT_PROPS)('envelope allowlist tripwire: $event', props => {
  const configPath = makeConfigPath()
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
  const client = new TelemetryClient({ configPath, appVersion: '0.1.0', env: {}, fetchImpl })
  client.setConsent(true)
  fetchImpl.mockClear()

  client.emit(props)

  expect(fetchImpl).toHaveBeenCalledTimes(1)
  const [, init] = fetchImpl.mock.calls[0]!
  const envelope = JSON.parse(String(init!.body)) as Record<string, unknown>

  expect(Object.keys(envelope).sort()).toEqual(ALLOWED_ENVELOPE_KEYS)

  const payload = envelope.payload as Record<string, unknown>
  const allowedPayloadKeys = ALLOWED_PAYLOAD_KEYS[props.event]!.slice().sort()
  expect(Object.keys(payload).sort()).toEqual(allowedPayloadKeys)
})
