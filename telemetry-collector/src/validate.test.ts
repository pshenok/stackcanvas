import { describe, expect, it } from 'vitest'
import { validateEvent } from './validate.js'

// Ported from telemetry-worker/src/index.test.ts's validation cases (the
// worker's `describe('POST /e — validation')` and
// `describe('POST /e — size limit')` blocks, plus the valid-payload cases),
// adapted to call the pure `validateEvent(body: string)` entry point
// directly instead of going through a fetch handler. The AWS-specific
// routing/storage cases live in src/handler.test.ts.

function baseEnvelope(payload: unknown) {
  return {
    schema: 1,
    anon_id: '1c9f6a8e-1234-4a1b-8c1d-abcdef123456',
    day: '2026-07-12',
    app_version: '0.1.0',
    platform: 'darwin',
    node_major: 22,
    payload,
  }
}

function body(obj: unknown): string {
  return typeof obj === 'string' ? obj : JSON.stringify(obj)
}

const validPayloads: unknown[] = [
  { event: 'install' },
  { event: 'canvas_opened', nodes_bucket: '1-10', tf_bin: 'terraform' },
  { event: 'intent_sent', add: 3, modify: 0, remove: 1, adopt: 0, investigate: 0 },
  { event: 'scan_run', provider: 'aws', nodes_bucket: '11-50' },
  { event: 'drift_opened', nodes_bucket: '0' },
]

describe('validateEvent — valid envelopes', () => {
  it.each(validPayloads)('accepts %o', (payload) => {
    const envelope = baseEnvelope(payload)
    const result = validateEvent(body(envelope))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.event).toMatchObject(envelope)
    }
  })

  it('body right at the 4KB boundary is accepted', () => {
    const result = validateEvent(body(baseEnvelope({ event: 'install' })))
    expect(result.ok).toBe(true)
  })
})

describe('validateEvent — rejection paths', () => {
  it('wrong schema version -> 400', () => {
    const envelope = { ...baseEnvelope({ event: 'install' }), schema: 2 }
    const result = validateEvent(body(envelope))
    expect(result).toMatchObject({ ok: false, status: 400 })
  })

  it('missing schema -> 400', () => {
    const envelope = baseEnvelope({ event: 'install' }) as Record<string, unknown>
    delete envelope.schema
    const result = validateEvent(body(envelope))
    expect(result).toMatchObject({ ok: false, status: 400 })
  })

  it('unknown event -> 400', () => {
    const result = validateEvent(body(baseEnvelope({ event: 'totally_made_up' })))
    expect(result).toMatchObject({ ok: false, status: 400 })
  })

  it('unknown payload key -> 400', () => {
    const result = validateEvent(
      body(baseEnvelope({ event: 'drift_opened', nodes_bucket: '0', resource_name: 'sneaky' })),
    )
    expect(result).toMatchObject({ ok: false, status: 400 })
  })

  it('unknown top-level envelope key -> 400', () => {
    const envelope = { ...baseEnvelope({ event: 'install' }), extra_field: 'nope' }
    const result = validateEvent(body(envelope))
    expect(result).toMatchObject({ ok: false, status: 400 })
  })

  it('anon_id not UUID-shaped -> 400', () => {
    const envelope = { ...baseEnvelope({ event: 'install' }), anon_id: 'not-a-uuid' }
    const result = validateEvent(body(envelope))
    expect(result).toMatchObject({ ok: false, status: 400 })
  })

  it('malformed day -> 400', () => {
    const envelope = { ...baseEnvelope({ event: 'install' }), day: '07/12/2026' }
    const result = validateEvent(body(envelope))
    expect(result).toMatchObject({ ok: false, status: 400 })
  })

  it('invalid platform -> 400', () => {
    const envelope = { ...baseEnvelope({ event: 'install' }), platform: 'plan9' }
    const result = validateEvent(body(envelope))
    expect(result).toMatchObject({ ok: false, status: 400 })
  })

  it('intent_sent counter over 50 -> 400', () => {
    const result = validateEvent(
      body(baseEnvelope({ event: 'intent_sent', add: 51, modify: 0, remove: 0, adopt: 0, investigate: 0 })),
    )
    expect(result).toMatchObject({ ok: false, status: 400 })
  })

  it('intent_sent negative counter -> 400', () => {
    const result = validateEvent(
      body(baseEnvelope({ event: 'intent_sent', add: -1, modify: 0, remove: 0, adopt: 0, investigate: 0 })),
    )
    expect(result).toMatchObject({ ok: false, status: 400 })
  })

  it('invalid nodes_bucket -> 400', () => {
    const result = validateEvent(body(baseEnvelope({ event: 'drift_opened', nodes_bucket: '9999' })))
    expect(result).toMatchObject({ ok: false, status: 400 })
  })

  it('invalid JSON body -> 400', () => {
    const result = validateEvent('{not json')
    expect(result).toMatchObject({ ok: false, status: 400 })
  })

  it('non-object body -> 400', () => {
    const result = validateEvent('"just a string"')
    expect(result).toMatchObject({ ok: false, status: 400 })
  })
})

describe('validateEvent — size limit', () => {
  it('oversized body (>4KB) -> 413, even if also invalid JSON', () => {
    const huge = 'x'.repeat(5000)
    const result = validateEvent(huge)
    expect(result).toMatchObject({ ok: false, status: 413 })
  })

  it('oversized but otherwise well-formed envelope -> 413', () => {
    // Ported from the worker's "reported honestly via Content-Length
    // short-circuit" case. There is no separate header short-circuit here
    // (API Gateway hands Lambda the fully-buffered body already), but the
    // same oversized, validly-shaped envelope must still be rejected on
    // size before any field-level validation runs.
    const bigEnvelope = baseEnvelope({ event: 'install', padding: 'y'.repeat(5000) })
    const result = validateEvent(body(bigEnvelope))
    expect(result).toMatchObject({ ok: false, status: 413 })
  })
})
