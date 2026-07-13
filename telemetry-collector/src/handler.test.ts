import { describe, expect, it, vi } from 'vitest'
import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { createHandler, type FirehoseLike } from './handler.js'

// Ported from telemetry-worker/src/index.test.ts's routing, storage, and
// end-to-end validation cases — the parts that need an AWS-shaped request
// and a storage client, as opposed to the pure validation cases now in
// src/validate.test.ts. `FirehoseLike` is faked with a plain vi.fn(), no
// real @aws-sdk/client-firehose involvement — see handler.ts's
// `createHandler(firehose)` injection seam.

function makeFirehose(overrides: Partial<FirehoseLike> = {}): FirehoseLike & { putRecord: ReturnType<typeof vi.fn> } {
  const putRecord = vi.fn().mockResolvedValue(undefined)
  return { putRecord, ...overrides } as FirehoseLike & { putRecord: ReturnType<typeof vi.fn> }
}

function makeEvent(opts: {
  method: string
  path: string
  body?: unknown
  isBase64Encoded?: boolean
}): APIGatewayProxyEventV2 {
  const rawBody = opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: opts.path,
    rawQueryString: '',
    headers: { 'content-type': 'application/json' },
    requestContext: {
      accountId: '123456789012',
      apiId: 'testapi',
      domainName: 't.stackcanvas.dev',
      domainPrefix: 't',
      http: {
        method: opts.method,
        path: opts.path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: 'test-request-id',
      routeKey: '$default',
      stage: '$default',
      time: '12/Jul/2026:00:00:00 +0000',
      timeEpoch: 1_784_073_600_000,
    },
    body: rawBody,
    isBase64Encoded: opts.isBase64Encoded ?? false,
  } as unknown as APIGatewayProxyEventV2
}

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

const validPayloads: unknown[] = [
  { event: 'install' },
  { event: 'canvas_opened', nodes_bucket: '1-10', tf_bin: 'terraform' },
  { event: 'intent_sent', add: 3, modify: 0, remove: 1, adopt: 0, investigate: 0 },
  { event: 'scan_run', provider: 'aws', nodes_bucket: '11-50' },
  { event: 'drift_opened', nodes_bucket: '0' },
]

describe('GET /health', () => {
  it('returns 200', async () => {
    const handler = createHandler(makeFirehose())
    const res = await handler(makeEvent({ method: 'GET', path: '/health' }))
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body as string)).toEqual({ status: 'ok' })
  })

  it('POST /health is not found', async () => {
    const handler = createHandler(makeFirehose())
    const res = await handler(makeEvent({ method: 'POST', path: '/health' }))
    expect(res.statusCode).toBe(404)
  })
})

describe('routing', () => {
  it('GET /e is 404 (only POST is handled)', async () => {
    const handler = createHandler(makeFirehose())
    const res = await handler(makeEvent({ method: 'GET', path: '/e' }))
    expect(res.statusCode).toBe(404)
  })

  it('unknown path is 404', async () => {
    const handler = createHandler(makeFirehose())
    const res = await handler(makeEvent({ method: 'GET', path: '/whatever' }))
    expect(res.statusCode).toBe(404)
  })

  it('OPTIONS /e (CORS preflight) is 404, no CORS headers set', async () => {
    const handler = createHandler(makeFirehose())
    const res = await handler(makeEvent({ method: 'OPTIONS', path: '/e' }))
    expect(res.statusCode).toBe(404)
    expect(res.headers?.['access-control-allow-origin']).toBeUndefined()
  })
})

describe('POST /e — valid events', () => {
  it.each(validPayloads)('stores %o and returns 200 {ok:true}', async (payload) => {
    process.env.FIREHOSE_STREAM = 'stackcanvas-telemetry-stream'
    const firehose = makeFirehose()
    const handler = createHandler(firehose)
    const envelope = baseEnvelope(payload)

    const res = await handler(makeEvent({ method: 'POST', path: '/e', body: envelope }))

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body as string)).toEqual({ ok: true })
    expect(firehose.putRecord).toHaveBeenCalledTimes(1)

    const [streamName, line] = firehose.putRecord.mock.calls[0] as [string, string]
    expect(streamName).toBe('stackcanvas-telemetry-stream')
    expect(line.endsWith('\n')).toBe(true)
    const record = JSON.parse(line.trim())
    expect(record).toMatchObject(envelope)
    expect(typeof record.received_at).toBe('string')
    expect(Number.isNaN(Date.parse(record.received_at))).toBe(false)
  })
})

describe('POST /e — validation failures never reach Firehose', () => {
  it('invalid envelope -> 400, nothing stored', async () => {
    const firehose = makeFirehose()
    const handler = createHandler(firehose)
    const res = await handler(
      makeEvent({ method: 'POST', path: '/e', body: baseEnvelope({ event: 'totally_made_up' }) }),
    )
    expect(res.statusCode).toBe(400)
    expect(firehose.putRecord).not.toHaveBeenCalled()
  })

  it('oversized body -> 413, nothing stored', async () => {
    const firehose = makeFirehose()
    const handler = createHandler(firehose)
    const res = await handler(makeEvent({ method: 'POST', path: '/e', body: 'x'.repeat(5000) }))
    expect(res.statusCode).toBe(413)
    expect(firehose.putRecord).not.toHaveBeenCalled()
  })

  it('invalid JSON body -> 400, nothing stored', async () => {
    const firehose = makeFirehose()
    const handler = createHandler(firehose)
    const res = await handler(makeEvent({ method: 'POST', path: '/e', body: '{not json' }))
    expect(res.statusCode).toBe(400)
    expect(firehose.putRecord).not.toHaveBeenCalled()
  })
})

describe('POST /e — Firehose failure', () => {
  it('putRecord rejecting -> 500 (unlike the old worker, storage failures are not swallowed here — see handler.ts header comment; the client never inspects the response either way)', async () => {
    process.env.FIREHOSE_STREAM = 'stackcanvas-telemetry-stream'
    const firehose = makeFirehose()
    firehose.putRecord.mockRejectedValue(new Error('Firehose unavailable'))
    const handler = createHandler(firehose)

    const res = await handler(makeEvent({ method: 'POST', path: '/e', body: baseEnvelope({ event: 'install' }) }))

    expect(res.statusCode).toBe(500)
  })

  it('missing FIREHOSE_STREAM env -> 500, nothing stored', async () => {
    const prev = process.env.FIREHOSE_STREAM
    delete process.env.FIREHOSE_STREAM
    const firehose = makeFirehose()
    const handler = createHandler(firehose)

    const res = await handler(makeEvent({ method: 'POST', path: '/e', body: baseEnvelope({ event: 'install' }) }))

    expect(res.statusCode).toBe(500)
    expect(firehose.putRecord).not.toHaveBeenCalled()
    if (prev !== undefined) process.env.FIREHOSE_STREAM = prev
  })
})
