// stackcanvas telemetry collector — AWS Lambda handler — issue #35.
//
// Replaces telemetry-worker/ (Cloudflare Worker). See TELEMETRY.md at the
// repo root for the user-facing contract and README.md in this directory
// for the deploy path. The endpoint URL is unchanged:
// https://t.stackcanvas.dev/e (now API Gateway HTTP API -> this Lambda,
// instead of a Cloudflare route).
//
// Routes:
//   POST /e       validate + ship to Firehose, 200 {ok:true} on success
//   GET  /health  liveness check, always 200, touches no AWS service
//   *    *        404 (this includes GET /e, and any CORS preflight OPTIONS
//                  request — there is no browser client for this endpoint,
//                  only server-side `fetch` calls from stackcanvas itself,
//                  so no CORS headers are ever set and preflights are simply
//                  unmatched routes)
//
// Storage: events are handed to Kinesis Data Firehose as one NDJSON line
// each (`putRecord`); Firehose buffers and batches delivery to S3 as the
// long-term system of record — see schema.md for the object layout and the
// week-2 reopen query. Unlike the old worker (which treated storage
// failures as best-effort and always returned 204/204-equivalent), a
// Firehose failure here surfaces as a 500: the client
// (`packages/server/src/telemetry.ts`'s `TelemetryClient.emit()`) never
// inspects the response status or body — it's a fire-and-forget
// `fetch(...).catch(() => {})` — so this is safe and gives the collector's
// own logs/metrics an honest signal instead of silently swallowing errors
// twice over.
//
// The validation logic itself (envelope shape, event + payload allowlists,
// size limit, schema version) lives in src/validate.ts, which has zero AWS
// imports and is independently unit-tested — this file is only the
// AWS-specific plumbing (API Gateway payload v2 routing + Firehose).

import { FirehoseClient, PutRecordCommand } from '@aws-sdk/client-firehose'
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { validateEvent, type ValidatedEvent } from './validate.js'

/** Minimal seam around Firehose so tests can inject a spy with zero AWS SDK
 *  involvement (no credentials, no network) — see src/handler.test.ts. */
export interface FirehoseLike {
  putRecord(streamName: string, data: string): Promise<void>
}

class RealFirehose implements FirehoseLike {
  private client = new FirehoseClient({})

  async putRecord(streamName: string, data: string): Promise<void> {
    await this.client.send(
      new PutRecordCommand({
        DeliveryStreamName: streamName,
        Record: { Data: Buffer.from(data, 'utf8') },
      }),
    )
  }
}

function json(body: unknown, statusCode: number): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function decodeBody(event: APIGatewayProxyEventV2): string {
  if (event.body == null) return ''
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body
}

/** One NDJSON line: the validated event plus a server-stamped receipt
 *  timestamp — see schema.md, "Record shape". */
function toNdjsonLine(event: ValidatedEvent): string {
  return `${JSON.stringify({ ...event, received_at: new Date().toISOString() })}\n`
}

/** Builds the Lambda handler, closing over an injectable Firehose client so
 *  tests never touch the real AWS SDK. `createHandler()` with no argument
 *  (the default export below) is what API Gateway actually invokes. */
export function createHandler(firehose: FirehoseLike = new RealFirehose()) {
  return async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
    const method = event.requestContext.http.method
    const path = event.rawPath

    if (method === 'GET' && path === '/health') {
      return json({ status: 'ok' }, 200)
    }

    if (method === 'POST' && path === '/e') {
      const result = validateEvent(decodeBody(event))
      if (!result.ok) return json({ error: result.error }, result.status)

      const streamName = process.env.FIREHOSE_STREAM
      if (!streamName) return json({ error: 'server misconfigured' }, 500)

      try {
        await firehose.putRecord(streamName, toNdjsonLine(result.event))
      } catch {
        return json({ error: 'storage failed' }, 500)
      }

      return json({ ok: true }, 200)
    }

    // Everything else — including GET /e, any method on /health, unknown
    // paths, and CORS preflight OPTIONS requests (no CORS headers are ever
    // set anywhere in this handler; there is no browser client for /e, only
    // server-side `fetch` calls from stackcanvas's own TelemetryClient).
    return json({ error: 'not found' }, 404)
  }
}

export const handler = createHandler()
