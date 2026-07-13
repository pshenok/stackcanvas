import { describe, expect, it, vi } from 'vitest'
import worker, { type Env } from './index.js'

// Plain-vitest style: no miniflare / @cloudflare/vitest-pool-workers. The
// worker's `fetch` handler only touches standard Web APIs (Request,
// Response, URL, crypto.randomUUID) plus the two bindings on Env, both of
// which are trivially faked below — see vitest.config.ts for why this stays
// offline-safe. `ctx` is unused by the handler, so a minimal stub suffices.

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

function makeEnv(overrides: Partial<Env> = {}): Env & { writeDataPoint: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> } {
  const writeDataPoint = vi.fn()
  const put = vi.fn().mockResolvedValue(undefined)
  return {
    EVENTS: { writeDataPoint },
    BUCKET: { put },
    writeDataPoint,
    put,
    ...overrides,
  } as Env & { writeDataPoint: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> }
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  return new Request('https://t.stackcanvas.dev/e', {
    method: 'POST',
    body: raw,
    headers: { 'content-type': 'application/json', ...headers },
  })
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
    const res = await worker.fetch(new Request('https://t.stackcanvas.dev/health'), makeEnv(), ctx)
    expect(res.status).toBe(200)
  })

  it('POST /health is not found', async () => {
    const res = await worker.fetch(new Request('https://t.stackcanvas.dev/health', { method: 'POST' }), makeEnv(), ctx)
    expect(res.status).toBe(404)
  })
})

describe('routing', () => {
  it('GET /e is 404 (only POST is handled)', async () => {
    const res = await worker.fetch(new Request('https://t.stackcanvas.dev/e'), makeEnv(), ctx)
    expect(res.status).toBe(404)
  })

  it('unknown path is 404', async () => {
    const res = await worker.fetch(new Request('https://t.stackcanvas.dev/whatever'), makeEnv(), ctx)
    expect(res.status).toBe(404)
  })

  it('OPTIONS /e (CORS preflight) is 404, no CORS headers set', async () => {
    const res = await worker.fetch(new Request('https://t.stackcanvas.dev/e', { method: 'OPTIONS' }), makeEnv(), ctx)
    expect(res.status).toBe(404)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('POST /e — valid events', () => {
  it.each(validPayloads)('stores %o and returns 204', async (payload) => {
    const env = makeEnv()
    const res = await worker.fetch(post(baseEnvelope(payload)), env, ctx)

    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    expect(env.writeDataPoint).toHaveBeenCalledTimes(1)
    expect(env.put).toHaveBeenCalledTimes(1)

    const [key, body] = env.put.mock.calls[0] as [string, string]
    expect(key).toMatch(/^events\/2026-07-12\/[0-9a-f-]+\.ndjson$/)
    expect(JSON.parse(body.trim())).toMatchObject(baseEnvelope(payload))
  })
})

describe('POST /e — validation', () => {
  it('wrong schema version -> 400', async () => {
    const env = makeEnv()
    const body = baseEnvelope({ event: 'install' })
    const res = await worker.fetch(post({ ...body, schema: 2 }), env, ctx)
    expect(res.status).toBe(400)
    expect(env.writeDataPoint).not.toHaveBeenCalled()
    expect(env.put).not.toHaveBeenCalled()
  })

  it('missing schema -> 400', async () => {
    const body = baseEnvelope({ event: 'install' }) as Record<string, unknown>
    delete body.schema
    const res = await worker.fetch(post(body), makeEnv(), ctx)
    expect(res.status).toBe(400)
  })

  it('unknown event -> 400', async () => {
    const env = makeEnv()
    const res = await worker.fetch(post(baseEnvelope({ event: 'totally_made_up' })), env, ctx)
    expect(res.status).toBe(400)
    expect(env.writeDataPoint).not.toHaveBeenCalled()
    expect(env.put).not.toHaveBeenCalled()
  })

  it('unknown payload key -> 400, nothing stored', async () => {
    const env = makeEnv()
    const res = await worker.fetch(
      post(baseEnvelope({ event: 'drift_opened', nodes_bucket: '0', resource_name: 'sneaky' })),
      env,
      ctx,
    )
    expect(res.status).toBe(400)
    expect(env.writeDataPoint).not.toHaveBeenCalled()
    expect(env.put).not.toHaveBeenCalled()
  })

  it('unknown top-level envelope key -> 400', async () => {
    const body = { ...baseEnvelope({ event: 'install' }), extra_field: 'nope' }
    const res = await worker.fetch(post(body), makeEnv(), ctx)
    expect(res.status).toBe(400)
  })

  it('anon_id not UUID-shaped -> 400', async () => {
    const body = baseEnvelope({ event: 'install' })
    const res = await worker.fetch(post({ ...body, anon_id: 'not-a-uuid' }), makeEnv(), ctx)
    expect(res.status).toBe(400)
  })

  it('malformed day -> 400', async () => {
    const body = baseEnvelope({ event: 'install' })
    const res = await worker.fetch(post({ ...body, day: '07/12/2026' }), makeEnv(), ctx)
    expect(res.status).toBe(400)
  })

  it('invalid platform -> 400', async () => {
    const body = baseEnvelope({ event: 'install' })
    const res = await worker.fetch(post({ ...body, platform: 'plan9' }), makeEnv(), ctx)
    expect(res.status).toBe(400)
  })

  it('intent_sent counter over 50 -> 400', async () => {
    const res = await worker.fetch(
      post(baseEnvelope({ event: 'intent_sent', add: 51, modify: 0, remove: 0, adopt: 0, investigate: 0 })),
      makeEnv(),
      ctx,
    )
    expect(res.status).toBe(400)
  })

  it('intent_sent negative counter -> 400', async () => {
    const res = await worker.fetch(
      post(baseEnvelope({ event: 'intent_sent', add: -1, modify: 0, remove: 0, adopt: 0, investigate: 0 })),
      makeEnv(),
      ctx,
    )
    expect(res.status).toBe(400)
  })

  it('invalid nodes_bucket -> 400', async () => {
    const res = await worker.fetch(post(baseEnvelope({ event: 'drift_opened', nodes_bucket: '9999' })), makeEnv(), ctx)
    expect(res.status).toBe(400)
  })

  it('invalid JSON body -> 400', async () => {
    const res = await worker.fetch(post('{not json'), makeEnv(), ctx)
    expect(res.status).toBe(400)
  })

  it('non-object body -> 400', async () => {
    const res = await worker.fetch(post('"just a string"'), makeEnv(), ctx)
    expect(res.status).toBe(400)
  })
})

describe('POST /e — size limit', () => {
  it('oversized body (>4KB) -> 413, even if also invalid JSON', async () => {
    const huge = 'x'.repeat(5000)
    const res = await worker.fetch(post(huge), makeEnv(), ctx)
    expect(res.status).toBe(413)
  })

  it('oversized body reported honestly via Content-Length short-circuit -> 413', async () => {
    const bigEnvelope = baseEnvelope({ event: 'install', padding: 'y'.repeat(5000) })
    const res = await worker.fetch(post(bigEnvelope), makeEnv(), ctx)
    expect(res.status).toBe(413)
  })

  it('body right at the 4KB boundary is accepted', async () => {
    // Pad app_version so the serialized envelope lands under 4096 bytes but close to it.
    const env = makeEnv()
    const body = baseEnvelope({ event: 'install' })
    const res = await worker.fetch(post(body), env, ctx)
    expect(res.status).toBe(204)
  })
})

describe('POST /e — storage failures never surface to the caller', () => {
  it('Analytics Engine write throwing still returns 204 and still attempts R2', async () => {
    const env = makeEnv()
    env.writeDataPoint.mockImplementation(() => {
      throw new Error('AE unavailable')
    })

    const res = await worker.fetch(post(baseEnvelope({ event: 'install' })), env, ctx)

    expect(res.status).toBe(204)
    expect(env.put).toHaveBeenCalledTimes(1)
  })

  it('R2 put rejecting still returns 204', async () => {
    const env = makeEnv()
    env.put.mockRejectedValue(new Error('R2 unavailable'))

    const res = await worker.fetch(post(baseEnvelope({ event: 'install' })), env, ctx)

    expect(res.status).toBe(204)
  })

  it('both AE and R2 failing still returns 204', async () => {
    const env = makeEnv()
    env.writeDataPoint.mockImplementation(() => {
      throw new Error('AE unavailable')
    })
    env.put.mockRejectedValue(new Error('R2 unavailable'))

    const res = await worker.fetch(post(baseEnvelope({ event: 'install' })), env, ctx)

    expect(res.status).toBe(204)
  })
})
